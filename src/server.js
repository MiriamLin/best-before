import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";

import { loadConfig } from "./config.js";
import { measureFreshness } from "./freshness.js";
import { submitReceipt, waitForPendingReceiptWrites } from "./hcs.js";
import { buildReceipt, REFUND_FAILURE_REASON_PROCESSING_FAILED } from "./receipt.js";
import { refundBuyer } from "./refund.js";
import { evaluateTier } from "./tiers.js";

const PORT = 3000;
const HEDERA_TESTNET = "hedera:testnet";
const BLOCKY402_URL = "https://api.testnet.blocky402.com";
const SETTLED_PAYMENT_TTL_MS = 5 * 60 * 1000;
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

  let freshness;
  try {
    freshness = await measureFreshness(source);
  } catch (error) {
    console.error(`[price] ${source.id}: ${error.message}`);
    return c.json(
      {
        error: "Upstream freshness check failed",
        source: source.id,
      },
      502,
    );
  }

  const tierEvaluation = evaluateTier(tierName, tier, freshness);
  const settledPayment = takeSettledPayment(c);
  if (settledPayment == null) {
    console.error(`[payment] ${source.id}: settled payment data is unavailable`);
    return c.json(
      {
        error: "Settled payment data is unavailable",
        source: source.id,
      },
      502,
    );
  }

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
        freshness,
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
    requestId: `req-${randomUUID()}`,
    ts: new Date().toISOString(),
    source,
    freshness,
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
      ? { price: null, status: "PLACEHOLDER" }
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
