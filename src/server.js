import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { loadConfig } from "./config.js";
import { measureFreshness } from "./freshness.js";
import { submitReceipt, waitForPendingReceiptWrites } from "./hcs.js";
import { buildReceipt } from "./receipt.js";
import { evaluateTier } from "./tiers.js";

const PORT = 3000;
const { sources } = loadConfig();

export const app = new Hono();

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
  const receipt = buildReceipt({
    requestId: `req-${randomUUID()}`,
    ts: new Date().toISOString(),
    source,
    freshness,
    tierEvaluation,
  });

  let receiptQueued = false;
  try {
    submitReceipt(receipt).catch((error) => {
      console.error(`[hcs] ${receipt.request_id}: ${error.message}`);
    });
    receiptQueued = true;
  } catch (error) {
    console.error(`[hcs] ${receipt.request_id}: ${error.message}`);
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
