import dotenv from "dotenv";
import { postJson } from "../src/http.js";
import { fetchChainHead } from "../src/rpc.js";

dotenv.config({ quiet: true });

const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
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
    deployment
    hasIndexingErrors
  }
  protocols(first: 1) {
    name
    slug
    schemaVersion
    network
    totalValueLockedUSD
  }
}`;

function requireGraphApiKey() {
  if (typeof GRAPH_API_KEY !== "string" || GRAPH_API_KEY.trim() === "") {
    throw new Error("[leaderboard] GRAPH_API_KEY must be set");
  }
}

function requireValidMetaBlock(meta, source) {
  if (!Number.isSafeInteger(meta?.block?.number)) {
    throw new Error(`[leaderboard] ${source.id}: response is missing a valid _meta block`);
  }
}

function requireProtocol(protocol, source) {
  if (protocol == null) {
    throw new Error(`[leaderboard] ${source.id}: response contains no protocol`);
  }
}

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

function renderTable(columns, rows) {
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...rows.map((row) => String(row[index]).length),
  ));
  const separator = `+-${widths.map((width) => "-".repeat(width)).join("-+-")}-+`;
  const renderRow = (row) => `| ${row.map(
    (value, index) => String(value).padEnd(widths[index]),
  ).join(" | ")} |`;

  console.log(separator);
  console.log(renderRow(columns));
  console.log(separator);
  for (const row of rows) {
    console.log(renderRow(row));
  }
  console.log(separator);
}

async function fetchStandardSnapshot(source) {
  const gatewayUrl = `${GATEWAY_BASE}/${GRAPH_API_KEY}/subgraphs/id/${source.subgraph_id}`;
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
  requireValidMetaBlock(meta, source);
  requireProtocol(protocol, source);

  return { meta, protocol };
}

async function fetchChainHeads() {
  const entries = await Promise.all(
    Object.entries(CHAINS).map(async ([chain, config]) => [
      chain,
      await fetchChainHead({
        id: `${chain}-head`,
        rpc_url: config.rpc_url,
      }),
    ]),
  );
  return new Map(entries);
}

async function buildLeaderboardRow(source, chainHeads) {
  const { meta, protocol } = await fetchStandardSnapshot(source);
  const chain = CHAINS[source.chain];

  if (protocol.network !== chain.protocol_network) {
    throw new Error(
      `[leaderboard] ${source.id}: expected ${chain.protocol_network}, got ${protocol.network}`,
    );
  }

  const lagBlocks = chainHeads.get(source.chain) - meta.block.number;
  if (lagBlocks < 0) {
    throw new Error(`[leaderboard] ${source.id}: negative lag`);
  }

  const freshness = meta.hasIndexingErrors
    ? `lag ${lagBlocks} / indexing errors`
    : `lag ${lagBlocks} OK`;

  return [
    protocol.name,
    chain.display_name,
    protocol.schemaVersion,
    formatUsd(protocol.totalValueLockedUSD),
    freshness,
  ];
}

async function buildDiagnosticRow(source) {
  try {
    const { protocol } = await fetchStandardSnapshot(source);
    const expectedNetwork = CHAINS[source.chain].protocol_network;

    if (protocol.network !== expectedNetwork) {
      return [
        `${source.protocol} (${CHAINS[source.chain].display_name})`,
        "SUSPECT",
        `manifest says ${expectedNetwork}, Protocol.network says ${protocol.network}`,
      ];
    }

    return [
      `${source.protocol} (${CHAINS[source.chain].display_name})`,
      "RESPONDING",
      "not included in the selected leaderboard",
    ];
  } catch (error) {
    return [
      `${source.protocol} (${CHAINS[source.chain].display_name})`,
      "UNAVAILABLE",
      summarizeError(error),
    ];
  }
}

requireGraphApiKey();

const chainHeads = await fetchChainHeads();
const leaderboardRows = [];

for (const source of LEADERBOARD_SOURCES) {
  leaderboardRows.push(await buildLeaderboardRow(source, chainHeads));
}

console.log("\nMESSARI STANDARDIZED LENDING FRESHNESS LEADERBOARD\n");
renderTable(
  ["Protocol", "Chain", "Schema", "TVL", "Freshness"],
  leaderboardRows,
);

const diagnosticRows = [];
for (const source of BASE_DIAGNOSTICS) {
  diagnosticRows.push(await buildDiagnosticRow(source));
}

console.log("\nBASE DEPLOYMENT DIAGNOSTICS\n");
renderTable(["Protocol", "Status", "Reason"], diagnosticRows);

console.log(`
Conclusion
- Standardization lets one Protocol query retrieve comparable TVL from five protocols without five adapters.
- Freshness, schema version, and deployment correctness remain independent checks.
- Standardization solves how to ask, not whether the answer can be trusted.
`);
