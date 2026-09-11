import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from "dotenv";

import { createPaidFetch } from "./payment-client.js";

dotenv.config({ quiet: true });

const DEFAULT_PRICE_API_URL = "http://localhost:3000";
const PRICE_API_URL = new URL(
  process.env.BEST_BEFORE_URL ?? DEFAULT_PRICE_API_URL,
);

function priceUrl(source, tier) {
  const url = new URL("/price", PRICE_API_URL);
  url.searchParams.set("source", source);
  url.searchParams.set("tier", tier);
  return url;
}

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, got HTTP ${response.status}`);
  }
}

const server = new McpServer({
  name: "best-before",
  version: "1.0.0",
});

server.registerTool(
  "check_freshness",
  {
    title: "Check Price Freshness",
    description: "Checks the current pre-payment freshness snapshot and tier availability without spending HBAR. This snapshot is advisory; the SLA is measured again after payment.",
    inputSchema: {
      source: z.string().min(1).describe("Configured price source ID."),
    },
  },
  async ({ source }) => {
    try {
      const response = await fetch(priceUrl(source, "realtime"));
      const body = await readJson(response);
      const disclosure = body.freshness_disclosure;

      if (response.status !== 402 || disclosure == null) {
        return textResult(
          {
            error: "Freshness disclosure is unavailable",
            status: response.status,
          },
          true,
        );
      }

      return textResult({
        source,
        age_seconds: disclosure.age_seconds,
        lag_blocks: disclosure.lag_blocks,
        tiers: disclosure.tiers,
        disclaimer: disclosure.disclaimer,
      });
    } catch (error) {
      return textResult(
        { error: `Freshness check failed: ${error.message}` },
        true,
      );
    }
  },
);

server.registerTool(
  "buy_price",
  {
    title: "Buy Freshness-Guaranteed Price",
    description: "Purchases one freshness-guaranteed price response. Every invocation sends a real x402 payment and spends HBAR: strict costs 2,000,000 tinybar (0.02 HBAR), realtime costs 1,000,000 tinybar (0.01 HBAR), and delayed costs 100,000 tinybar (0.001 HBAR). A refused delivery is a normal result and triggers the service refund path.",
    inputSchema: {
      source: z.string().min(1).describe("Configured price source ID."),
      tier: z.string().min(1).describe("Tier to purchase: strict, realtime, or delayed."),
    },
  },
  async ({ source, tier }) => {
    try {
      const fetchWithPayment = createPaidFetch();
      const response = await fetchWithPayment(priceUrl(source, tier));
      const body = await readJson(response);

      if (!response.ok) {
        return textResult(
          {
            error: "Price purchase failed",
            status: response.status,
            response: body,
          },
          true,
        );
      }

      const receipt = body.receipt;
      if (receipt?.delivery_status === "REFUSED") {
        return textResult({
          delivery_status: "REFUSED",
          data: null,
          refusal: {
            failure_reasons: receipt.failure_reasons,
            actual_age_seconds: receipt.age_seconds,
            tier_sla_seconds: receipt.tier_sla_seconds,
            refund_tinybar: receipt.refund_tinybar,
            refund_tx_id: receipt.refund_tx_id,
            refund_status: receipt.refund_status,
          },
          receipt,
        });
      }

      return textResult({
        delivery_status: "DELIVERED",
        data: body.data,
        receipt,
      });
    } catch (error) {
      return textResult(
        { error: `Price purchase failed: ${error.message}` },
        true,
      );
    }
  },
);

await server.connect(new StdioServerTransport());
