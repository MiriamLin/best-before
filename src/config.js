import { readFileSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const SOURCES_PATH = new URL("../sources.json", import.meta.url);
const GATEWAY_BASE = "https://gateway.thegraph.com/api";
const SUPPORTED_CHAINS = ["base", "ethereum"];

function fail(message) {
  throw new Error(`[config] ${message}`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
}

function requirePositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive number, got ${JSON.stringify(value)}`);
  }
}

function requireHttpsUrl(value, label) {
  requireNonEmptyString(value, label);

  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    fail(`${label} must use https, got ${url.protocol}`);
  }
}

function requireSupportedChain(value, label) {
  requireNonEmptyString(value, label);
  if (!SUPPORTED_CHAINS.includes(value)) {
    fail(`${label} must be one of [${SUPPORTED_CHAINS.join(", ")}], got "${value}"`);
  }
}

function requireEvmAddress(value, label) {
  requireNonEmptyString(value, label);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail(`${label} must be a 20-byte EVM address, got ${JSON.stringify(value)}`);
  }
}

function validatePriceFeed(priceFeed, label) {
  if (priceFeed == null) {
    return;
  }
  if (typeof priceFeed !== "object" || Array.isArray(priceFeed)) {
    fail(`${label} must be an object`);
  }

  requireEvmAddress(priceFeed.pool_id, `${label}.pool_id`);
  requireNonEmptyString(priceFeed.base_symbol, `${label}.base_symbol`);
  requireNonEmptyString(priceFeed.quote_symbol, `${label}.quote_symbol`);

  if (priceFeed.base_symbol === priceFeed.quote_symbol) {
    fail(`${label} base_symbol and quote_symbol must differ`);
  }
}

function validateTiers(tiers, label) {
  if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) {
    fail(`${label} must be an object of tier definitions`);
  }

  const names = Object.keys(tiers);
  if (names.length === 0) {
    fail(`${label} must define at least one tier`);
  }

  for (const name of names) {
    const tier = tiers[name];
    if (typeof tier !== "object" || tier === null) {
      fail(`${label}.${name} must be an object`);
    }
    requirePositiveNumber(tier.max_age_seconds, `${label}.${name}.max_age_seconds`);
    requirePositiveNumber(tier.price_tinybar, `${label}.${name}.price_tinybar`);
  }
}

export function loadConfig() {
  const graphApiKey = process.env.GRAPH_API_KEY;
  if (typeof graphApiKey !== "string" || graphApiKey.trim() === "") {
    fail("GRAPH_API_KEY is not set in .env — refusing to build a gateway URL without it");
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SOURCES_PATH, "utf8"));
  } catch (error) {
    fail(`cannot read sources.json: ${error.message}`);
  }

  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    fail('sources.json must contain a non-empty "sources" array');
  }

  const seenIds = new Set();
  const sources = parsed.sources.map((source, index) => {
    requireNonEmptyString(source.id, `sources[${index}].id`);
    if (seenIds.has(source.id)) {
      fail(`duplicate source id "${source.id}" at sources[${index}]`);
    }
    seenIds.add(source.id);

    const label = `source "${source.id}"`;
    requireNonEmptyString(source.subgraph_id, `${label}.subgraph_id`);
    requireSupportedChain(source.chain, `${label}.chain`);
    requireHttpsUrl(source.rpc_url, `${label}.rpc_url`);
    validatePriceFeed(source.price_feed, `${label}.price_feed`);
    validateTiers(source.tiers, `${label}.tiers`);

    return {
      ...source,
      gateway_url: `${GATEWAY_BASE}/${graphApiKey}/subgraphs/id/${source.subgraph_id}`,
    };
  });

  return { graphApiKey, sources };
}

function maskSecret(secret) {
  if (secret.length <= 8) {
    return "*".repeat(secret.length);
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function printConfig(config) {
  const maskedKey = maskSecret(config.graphApiKey);

  console.log(`GRAPH_API_KEY : ${maskedKey}`);
  console.log(`sources       : ${config.sources.length}`);

  for (const source of config.sources) {
    console.log(`\n- ${source.id} (chain: ${source.chain})`);
    console.log(`  gateway_url : ${source.gateway_url.replaceAll(config.graphApiKey, maskedKey)}`);
    console.log(`  rpc_url     : ${source.rpc_url}`);
    for (const [name, tier] of Object.entries(source.tiers)) {
      console.log(`  tier ${name.padEnd(8)}: max_age ${tier.max_age_seconds}s, price ${tier.price_tinybar} tinybar`);
    }
  }
}
