import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { loadConfig } from "./config.js";
import { measureFreshness } from "./freshness.js";
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

  return c.json({
    data: receipt.delivery_status === "DELIVERED"
      ? { price: null, status: "PLACEHOLDER" }
      : null,
    receipt,
  });
});

serve(
  { fetch: app.fetch, port: PORT },
  (info) => console.log(`Best Before listening on http://localhost:${info.port}`),
);
