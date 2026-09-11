import { postJson } from "./http.js";

const SNAPSHOT_QUERY = `query Snapshot($poolId: ID!) {
  _meta {
    block {
      number
      timestamp
      hash
    }
    deployment
    hasIndexingErrors
  }
  pool(id: $poolId) {
    id
    token0 {
      symbol
    }
    token1 {
      symbol
    }
    token1Price
  }
}`;

function requireConfiguredPriceFeed(source) {
  if (source.price_feed == null) {
    throw new Error(`[subgraph] ${source.id}: price_feed is not configured`);
  }
  return source.price_feed;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[subgraph] ${label} must be a non-empty string`);
  }
}

export async function fetchSubgraphSnapshot(source, { timeoutMs } = {}) {
  const priceFeed = requireConfiguredPriceFeed(source);
  const json = await postJson(
    source.gateway_url,
    {
      query: SNAPSHOT_QUERY,
      variables: { poolId: priceFeed.pool_id },
    },
    { label: `subgraph ${source.id}`, timeoutMs },
  );

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const messages = json.errors.map((error) => error.message).join("; ");
    throw new Error(`[subgraph] ${source.id}: GraphQL returned errors: ${messages}`);
  }

  const meta = json.data?._meta;
  if (!meta?.block) {
    throw new Error(`[subgraph] ${source.id}: response is missing data._meta`);
  }

  const pool = json.data?.pool;
  if (pool == null) {
    throw new Error(
      `[subgraph] ${source.id}: pool ${priceFeed.pool_id} was not found`,
    );
  }

  if (pool.id.toLowerCase() !== priceFeed.pool_id.toLowerCase()) {
    throw new Error(
      `[subgraph] ${source.id}: returned pool ID does not match configured pool ID`,
    );
  }

  if (
    pool.token0?.symbol !== priceFeed.base_symbol
    || pool.token1?.symbol !== priceFeed.quote_symbol
  ) {
    throw new Error(
      `[subgraph] ${source.id}: pool symbols `
      + `${JSON.stringify(pool.token0?.symbol)}/${JSON.stringify(pool.token1?.symbol)} `
      + `do not match configured ${priceFeed.base_symbol}/${priceFeed.quote_symbol}`,
    );
  }

  requireNonEmptyString(pool.token1Price, `${source.id}.pool.token1Price`);

  return {
    meta: {
      block: {
        number: meta.block.number,
        timestamp: meta.block.timestamp,
        hash: meta.block.hash,
      },
      deployment: meta.deployment,
      hasIndexingErrors: meta.hasIndexingErrors,
    },
    price: {
      pool_id: pool.id,
      pair: `${priceFeed.base_symbol}/${priceFeed.quote_symbol}`,
      price: pool.token1Price,
      price_direction: `${priceFeed.base_symbol}_IN_${priceFeed.quote_symbol}`,
    },
  };
}
