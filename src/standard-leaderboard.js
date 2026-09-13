import { postJson } from "./http.js";
import { fetchChainHead } from "./rpc.js";

const GATEWAY_BASE = "https://gateway.thegraph.com/api";

const CHAINS = {
  base: {
    display_name: "Base",
    protocol_network: "BASE",
    rpc_url: "https://mainnet.base.org",
  },
  ethereum: {
    display_name: "Ethereum",
    protocol_network: "MAINNET",
    rpc_url: "https://ethereum-rpc.publicnode.com",
  },
};

const LEADERBOARD_SOURCES = [
  {
    id: "moonwell-base",
    protocol: "Moonwell",
    chain: "base",
    subgraph_id: "33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg",
  },
  {
    id: "aave-v3-ethereum",
    protocol: "Aave V3",
    chain: "ethereum",
    subgraph_id: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
  },
  {
    id: "compound-v3-ethereum",
    protocol: "Compound V3",
    chain: "ethereum",
    subgraph_id: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9",
  },
  {
    id: "spark-lend-ethereum",
    protocol: "Spark Lend",
    chain: "ethereum",
    subgraph_id: "GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si",
  },
  {
    id: "morpho-aave-v3-ethereum",
    protocol: "Morpho Aave V3",
    chain: "ethereum",
    subgraph_id: "FKe6ANnWmGPE6hajGLoTgPrVF2jYPHiRu2Jwcg9ZmG9A",
  },
];

const BASE_DIAGNOSTICS = [
  {
    id: "aave-v3-base",
    protocol: "Aave V3",
    chain: "base",
    subgraph_id: "D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9",
  },
  {
    id: "seamless-protocol-base",
    protocol: "Seamless",
    chain: "base",
    subgraph_id: "2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP",
  },
  {
    id: "compound-v3-base",
    protocol: "Compound V3",
    chain: "base",
    subgraph_id: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9",
  },
];

const STANDARD_SNAPSHOT_QUERY = `{
  _meta {
    block {
      number
    }
    hasIndexingErrors
  }
  protocols(first: 1) {
    name
    schemaVersion
    network
    totalValueLockedUSD
  }
}`;

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "n/a";
  }
  if (amount >= 1_000_000_000) {
    return `$${(amount / 1_000_000_000).toFixed(2)}B`;
  }
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(2)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(2)}K`;
  }
  return `$${amount.toFixed(2)}`;
}

function summarizeError(error) {
  if (error.message.includes("no allocations")) {
    return "no allocations";
  }
  if (error.message.includes("bad indexers")) {
    return "all indexers returned HTTP 400";
  }
  return "query failed";
}

async function fetchStandardSnapshot(source, graphApiKey) {
  const gatewayUrl = `${GATEWAY_BASE}/${graphApiKey}/subgraphs/id/${source.subgraph_id}`;
  const json = await postJson(
    gatewayUrl,
    { query: STANDARD_SNAPSHOT_QUERY },
    { label: `subgraph ${source.id}` },
  );

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const messages = json.errors.map((error) => error.message).join("; ");
    throw new Error(`[leaderboard] ${source.id}: GraphQL returned errors: ${messages}`);
  }

  const meta = json.data?._meta;
  const protocol = json.data?.protocols?.[0];
  if (!Number.isSafeInteger(meta?.block?.number) || protocol == null) {
    throw new Error(`[leaderboard] ${source.id}: response is incomplete`);
  }

  return { meta, protocol };
}

async function fetchChainHeads(chainConfigs) {
  const entries = await Promise.all(Object.entries(chainConfigs).map(
    async ([chain, config]) => {
      try {
        return [chain, {
          status: "AVAILABLE",
          block_number: await fetchChainHead({
            id: `${chain}-head`,
            rpc_url: config.rpc_url,
          }),
        }];
      } catch {
        return [chain, { status: "UNAVAILABLE", block_number: null }];
      }
    },
  ));

  return new Map(entries);
}

async function buildLeaderboardRow(source, graphApiKey, chainHeads, chainConfigs) {
  const chain = chainConfigs[source.chain];
  let snapshot;

  try {
    snapshot = await fetchStandardSnapshot(source, graphApiKey);
  } catch (error) {
    return {
      protocol: source.protocol,
      chain: chain.display_name,
      schema: "—",
      tvl: "—",
      freshness: "UNAVAILABLE",
      status: "UNAVAILABLE",
      reason: summarizeError(error),
    };
  }

  const { meta, protocol } = snapshot;
  if (protocol.network !== chain.protocol_network) {
    return {
      protocol: protocol.name,
      chain: chain.display_name,
      schema: protocol.schemaVersion,
      tvl: formatUsd(protocol.totalValueLockedUSD),
      freshness: "SUSPECT",
      status: "SUSPECT",
      reason: `expected ${chain.protocol_network}, got ${protocol.network}`,
    };
  }

  const chainHead = chainHeads.get(source.chain);
  if (chainHead?.status !== "AVAILABLE") {
    return {
      protocol: protocol.name,
      chain: chain.display_name,
      schema: protocol.schemaVersion,
      tvl: formatUsd(protocol.totalValueLockedUSD),
      freshness: "UNAVAILABLE",
      status: "UNAVAILABLE",
      reason: "chain head unavailable",
    };
  }

  const lagBlocks = chainHead.block_number - meta.block.number;
  if (lagBlocks < 0) {
    return {
      protocol: protocol.name,
      chain: chain.display_name,
      schema: protocol.schemaVersion,
      tvl: formatUsd(protocol.totalValueLockedUSD),
      freshness: "SUSPECT",
      status: "SUSPECT",
      reason: "negative lag; deployment or chain mapping may be incorrect",
    };
  }

  return {
    protocol: protocol.name,
    chain: chain.display_name,
    schema: protocol.schemaVersion,
    tvl: formatUsd(protocol.totalValueLockedUSD),
    freshness: meta.hasIndexingErrors
      ? `lag ${lagBlocks} / indexing errors`
      : `lag ${lagBlocks} OK`,
    status: meta.hasIndexingErrors ? "INDEXING_ERRORS" : "AVAILABLE",
    reason: null,
  };
}

async function buildDiagnosticRow(source, graphApiKey, chainConfigs) {
  const chain = chainConfigs[source.chain];

  try {
    const { protocol } = await fetchStandardSnapshot(source, graphApiKey);
    if (protocol.network !== chain.protocol_network) {
      return {
        protocol: `${source.protocol} (${chain.display_name})`,
        status: "SUSPECT",
        reason: `manifest says ${chain.protocol_network}, Protocol.network says ${protocol.network}`,
      };
    }

    return {
      protocol: `${source.protocol} (${chain.display_name})`,
      status: "RESPONDING",
      reason: "not included in the selected leaderboard",
    };
  } catch (error) {
    return {
      protocol: `${source.protocol} (${chain.display_name})`,
      status: "UNAVAILABLE",
      reason: summarizeError(error),
    };
  }
}

export async function buildStandardLeaderboard({ graphApiKey, chainConfigs = CHAINS }) {
  if (typeof graphApiKey !== "string" || graphApiKey.trim() === "") {
    throw new Error("[leaderboard] GRAPH_API_KEY must be set");
  }

  const chainHeads = await fetchChainHeads(chainConfigs);
  const [rows, diagnostics] = await Promise.all([
    Promise.all(LEADERBOARD_SOURCES.map(
      (source) => buildLeaderboardRow(source, graphApiKey, chainHeads, chainConfigs),
    )),
    Promise.all(BASE_DIAGNOSTICS.map(
      (source) => buildDiagnosticRow(source, graphApiKey, chainConfigs),
    )),
  ]);

  return {
    query: "Messari Protocol",
    data_sources: ["The Graph", "RPC"],
    rows,
    diagnostics,
  };
}
