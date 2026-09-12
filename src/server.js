import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";

import { loadConfig } from "./config.js";
import { measureSnapshot } from "./freshness.js";
import { submitReceipt, waitForPendingReceiptWrites } from "./hcs.js";
import { buildReceipt, REFUND_FAILURE_REASON_PROCESSING_FAILED } from "./receipt.js";
import { refundBuyer } from "./refund.js";
import { evaluateTier, evaluateTiers } from "./tiers.js";

const PORT = 3000;
const HEDERA_TESTNET = "hedera:testnet";
const BLOCKY402_URL = "https://api.testnet.blocky402.com";
const SETTLED_PAYMENT_TTL_MS = 5 * 60 * 1000;
const DISCLOSURE_CACHE_TTL_MS = 5_000;
const DISCLOSURE_TIMEOUT_MS = 2_000;
const { sources } = loadConfig();

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[server] ${name} must be set in .env`);
  }
  return value;
}

function priceForPayment(context) {
  const sourceId = context.adapter.getQueryParam("source");
  const tierName = context.adapter.getQueryParam("tier");

  if (typeof sourceId !== "string" || typeof tierName !== "string") {
    throw new Error("[payment] source and tier query parameters must be strings");
  }

  const source = sources.find((candidate) => candidate.id === sourceId);
  const tier = source?.tiers[tierName];
  if (tier == null) {
    throw new Error("[payment] source and tier must identify a configured price");
  }

  return {
    asset: "0.0.0",
    amount: String(tier.price_tinybar),
  };
}

const paymentRecipient = requireEnvironmentVariable("HEDERA_ACCOUNT_ID");
const settledPaymentRequirements = new Map();
const disclosureSnapshots = new Map();

function buildUnavailableDisclosure() {
  return {
    contentType: "application/json",
    body: {
      freshness_disclosure: {
        status: "UNAVAILABLE",
        disclaimer: "Pre-payment freshness is unavailable. Freshness is measured again after payment; only that measurement is covered by the SLA.",
      },
    },
  };
}

function getDisclosureSnapshot(source) {
  const now = Date.now();
  const cached = disclosureSnapshots.get(source.id);
  if (cached != null && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = measureSnapshot(source, {
    timeoutMs: DISCLOSURE_TIMEOUT_MS,
  });
  disclosureSnapshots.set(source.id, {
    promise,
    expiresAt: now + DISCLOSURE_CACHE_TTL_MS,
  });

  promise.catch(() => {
    if (disclosureSnapshots.get(source.id)?.promise === promise) {
      disclosureSnapshots.delete(source.id);
    }
  });

  return promise;
}

function buildTierDisclosure(source, snapshot) {
  const evaluations = evaluateTiers(source.tiers, snapshot);
  const evaluationsByTier = new Map(
    [...evaluations.passing_tiers, ...evaluations.failing_tiers]
      .map((evaluation) => [evaluation.tier, evaluation]),
  );

  return Object.entries(source.tiers).map(([name, tier]) => {
    const evaluation = evaluationsByTier.get(name);
    return {
      name,
      max_age_seconds: tier.max_age_seconds,
      price_tinybar: tier.price_tinybar,
      available: evaluation.verdict === "PASS",
      failure_reasons: [...evaluation.failure_reasons],
    };
  });
}

async function buildUnpaidResponseBody(context) {
  const sourceId = context.adapter.getQueryParam("source");
  if (typeof sourceId !== "string") {
    return buildUnavailableDisclosure();
  }

  const source = sources.find((candidate) => candidate.id === sourceId);
  if (source == null) {
    return buildUnavailableDisclosure();
  }

  try {
    const snapshot = await getDisclosureSnapshot(source);
    return {
      contentType: "application/json",
      body: {
        freshness_disclosure: {
          status: "AVAILABLE",
          age_seconds: snapshot.age_seconds,
          lag_blocks: snapshot.lag_blocks,
          tiers: buildTierDisclosure(source, snapshot),
          disclaimer: "This is a pre-payment snapshot, not an SLA guarantee. Freshness is measured again after payment; only that measurement is covered by the SLA.",
        },
      },
    };
  } catch (error) {
    console.error(`[disclosure] ${source.id}: ${error.message}`);
    return buildUnavailableDisclosure();
  }
}

function rememberSettledPayment(paymentHeader, payment) {
  const previous = settledPaymentRequirements.get(paymentHeader);
  if (previous != null) {
    clearTimeout(previous.expiresAt);
  }

  const expiresAt = setTimeout(() => {
    const current = settledPaymentRequirements.get(paymentHeader);
    if (current?.expiresAt === expiresAt) {
      settledPaymentRequirements.delete(paymentHeader);
    }
  }, SETTLED_PAYMENT_TTL_MS);
  expiresAt.unref();

  settledPaymentRequirements.set(paymentHeader, {
    ...payment,
    expiresAt,
  });
}

const facilitatorClient = new HTTPFacilitatorClient({
  url: BLOCKY402_URL,
  timeoutMs: 30_000,
});

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(HEDERA_TESTNET, new ExactHederaScheme())
  .onAfterSettle((context) => {
    const paymentHeader = context.transportContext?.request?.paymentHeader;

    if (typeof paymentHeader !== "string") {
      console.error("[payment] settled payment has no request payment header");
      return;
    }

    rememberSettledPayment(paymentHeader, {
      amount: context.requirements.amount,
      payer: context.result.payer,
    });
  });

function takeSettledPayment(c) {
  const paymentHeader = c.req.header("payment-signature")
    ?? c.req.header("x-payment");

  if (paymentHeader == null) {
    console.error("[payment] handler received no payment header");
    return null;
  }

  const payment = settledPaymentRequirements.get(paymentHeader);
  settledPaymentRequirements.delete(paymentHeader);

  if (payment != null) {
    clearTimeout(payment.expiresAt);
  }

  if (payment == null || !/^\d+$/.test(payment.amount)) {
    console.error("[payment] settled payment requirements are unavailable");
    return null;
  }

  const paidTinybar = Number(payment.amount);
  if (!Number.isSafeInteger(paidTinybar) || paidTinybar <= 0) {
    console.error("[payment] settled payment amount is not a positive safe integer");
    return null;
  }

  return {
    paidTinybar,
    payer: payment.payer,
  };
}

export const app = new Hono();

app.use("/price", async (c, next) => {
  const sourceId = c.req.query("source");
  const source = sources.find((candidate) => candidate.id === sourceId);

  if (source == null) {
    return c.json(
      {
        error: "Unknown source",
        available_sources: sources.map(({ id }) => id),
      },
      400,
    );
  }

  const tierName = c.req.query("tier");
  if (source.tiers[tierName] == null) {
    return c.json(
      {
        error: "Unknown tier",
        source: source.id,
        available_tiers: Object.keys(source.tiers),
      },
      400,
    );
  }

  return next();
});

app.use(paymentMiddleware(
  {
    "GET /price": {
      accepts: {
        scheme: "exact",
        network: HEDERA_TESTNET,
        payTo: paymentRecipient,
        price: priceForPayment,
        maxTimeoutSeconds: 60,
        extra: {
          paymentFlow: "upfront",
        },
      },
      description: "Freshness-guaranteed on-chain price data",
      mimeType: "application/json",
      unpaidResponseBody: buildUnpaidResponseBody,
    },
  },
  resourceServer,
));

app.get("/price", async (c) => {
  const sourceId = c.req.query("source");
  const source = sources.find((candidate) => candidate.id === sourceId);

  if (source == null) {
    return c.json(
      {
        error: "Unknown source",
        available_sources: sources.map(({ id }) => id),
      },
      400,
    );
  }

  const tierName = c.req.query("tier");
  const tier = source.tiers[tierName];

  if (tier == null) {
    return c.json(
      {
        error: "Unknown tier",
        source: source.id,
        available_tiers: Object.keys(source.tiers),
      },
      400,
    );
  }

  const requestId = `req-${randomUUID()}`;
  const settledPayment = takeSettledPayment(c);
  if (settledPayment == null) {
    console.error(
      `[payment] request_id=${requestId} source=${source.id} tier=${tierName}: `
      + "settled payment data is unavailable; refund cannot be initiated",
    );
    return c.json(
      {
        error: "Settled payment data is unavailable",
        source: source.id,
      },
      502,
    );
  }

  let snapshot;
  try {
    snapshot = await measureSnapshot(source);
  } catch (error) {
    console.error(`[price] ${source.id}: ${error.message}`);

    const tierEvaluation = {
      tier: tierName,
      verdict: "UNAVAILABLE",
      failure_reasons: ["UPSTREAM_UNAVAILABLE"],
      tier_sla_seconds: tier.max_age_seconds,
    };
    const paidTinybar = settledPayment.paidTinybar;
    let refundTinybar = paidTinybar;
    let refundStatus = "FAILED";
    let refundTxId = null;
    let refundFailureReason = REFUND_FAILURE_REASON_PROCESSING_FAILED;

    try {
      if (typeof settledPayment.payer !== "string" || settledPayment.payer === "") {
        throw new Error("[payment] settled payer is unavailable for refund");
      }

      const refund = await refundBuyer({
        buyerAccountId: settledPayment.payer,
        tierName,
        tier,
        freshness: null,
        refundTinybar: paidTinybar,
      });

      refundTinybar = refund.refund_tinybar;
      refundStatus = "COMPLETED";
      refundTxId = refund.refund_tx_id;
      refundFailureReason = null;
    } catch (refundError) {
      console.error(`[refund] ${source.id}: ${refundError.message}`);
    }

    const receipt = buildReceipt({
      requestId,
      ts: new Date().toISOString(),
      source,
      snapshotStatus: "UNAVAILABLE",
      freshness: null,
      tierEvaluation,
      paidTinybar,
      paidAmountSource: "PAYMENT_REQUIREMENTS",
      refundTinybar,
      refundStatus,
      refundTxId,
      refundFailureReason,
    });

    let receiptQueued = false;
    try {
      await submitReceipt(receipt);
      receiptQueued = true;
    } catch (hcsError) {
      console.error(
        `[hcs] upstream failure receipt write failed: request_id=${receipt.request_id} `
        + `source=${source.id} refund_status=${refundStatus} `
        + `refund_tx_id=${refundTxId ?? "none"} `
        + `paid_tinybar=${paidTinybar} refund_tinybar=${refundTinybar}: `
        + `${hcsError.message}`,
      );
    }

    return c.json(
      {
        error: "Upstream freshness check failed",
        source: source.id,
        data: null,
        receipt,
        receipt_queued: receiptQueued,
      },
      502,
    );
  }

  const tierEvaluation = evaluateTier(tierName, tier, snapshot);
  const paidTinybar = settledPayment.paidTinybar;
  let refundTinybar = 0;
  let refundStatus = "NOT_APPLICABLE";
  let refundTxId = null;
  let refundFailureReason = null;

  if (tierEvaluation.verdict === "FAIL") {
    try {
      if (typeof settledPayment.payer !== "string" || settledPayment.payer === "") {
        throw new Error("[payment] settled payer is unavailable for refund");
      }

      const refund = await refundBuyer({
        buyerAccountId: settledPayment.payer,
        tierName,
        tier,
        freshness: snapshot,
        refundTinybar: paidTinybar,
      });

      refundTinybar = refund.refund_tinybar;
      refundStatus = "COMPLETED";
      refundTxId = refund.refund_tx_id;
    } catch (error) {
      console.error(`[refund] ${source.id}: ${error.message}`);

      refundTinybar = paidTinybar;
      refundStatus = "FAILED";
      refundFailureReason = REFUND_FAILURE_REASON_PROCESSING_FAILED;
    }
  }

  const receipt = buildReceipt({
    requestId,
    ts: new Date().toISOString(),
    source,
    snapshotStatus: "AVAILABLE",
    freshness: snapshot,
    tierEvaluation,
    paidTinybar,
    paidAmountSource: "PAYMENT_REQUIREMENTS",
    refundTinybar,
    refundStatus,
    refundTxId,
    refundFailureReason,
  });

  let receiptQueued = false;
  if (tierEvaluation.verdict === "FAIL") {
    try {
      await submitReceipt(receipt);
      receiptQueued = true;
    } catch (error) {
      console.error(
        `[hcs] refund receipt write failed: request_id=${receipt.request_id} `
        + `source=${source.id} refund_status=${refundStatus} `
        + `refund_tx_id=${refundTxId ?? "none"} `
        + `paid_tinybar=${paidTinybar} refund_tinybar=${refundTinybar}: `
        + `${error.message}`,
      );
    }
  } else {
    try {
      submitReceipt(receipt).catch((error) => {
        console.error(`[hcs] ${receipt.request_id}: ${error.message}`);
      });
      receiptQueued = true;
    } catch (error) {
      console.error(`[hcs] ${receipt.request_id}: ${error.message}`);
    }
  }

  return c.json({
    data: receipt.delivery_status === "DELIVERED"
      ? {
        pool_id: receipt.pool_id,
        pair: receipt.pair,
        price: receipt.price,
        price_direction: receipt.price_direction,
      }
      : null,
    receipt,
    receipt_queued: receiptQueued,
  });
});

const server = serve(
  { fetch: app.fetch, port: PORT },
  (info) => console.log(`Best Before listening on http://localhost:${info.port}`),
);

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}; waiting for pending HCS receipt writes`);
  server.close(async (error) => {
    if (error != null) {
      console.error(`[server] shutdown error: ${error.message}`);
    }
    await waitForPendingReceiptWrites();
    process.exit(error == null ? 0 : 1);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
