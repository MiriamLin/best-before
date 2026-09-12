import dotenv from "dotenv";
import { postJson } from "../src/http.js";
import { fetchChainHead } from "../src/rpc.js";

dotenv.config({ quiet: true });

const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
const GATEWAY_BASE = "https://gateway.thegraph.com/api";
const BASE_RPC_URL = "https://mainnet.base.org";

const SOURCES = [
  {
    id: "aave-v3-base",
    protocol: "Aave V3",
    schema: "lending",
    chain: "base",
    subgraph_id: "D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9",
  },
  {
    id: "seamless-protocol-base",
    protocol: "Seamless",
    schema: "lending",
    chain: "base",
    subgraph_id: "2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP",
  },
  {
    id: "moonwell-base",
    protocol: "Moonwell",
    schema: "lending",
    chain: "base",
    subgraph_id: "33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg",
  },
  {
    id: "compound-v3-base",
    protocol: "Compound V3",
    schema: "lending",
    chain: "base",
    subgraph_id: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9",
  },
];

const STANDARD_QUERY_SOURCES = [
  {
    id: "moonwell-base",
    protocol: "Moonwell",
    subgraph_id: "33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg",
  },
  {
    id: "aave-v3-ethereum",
    protocol: "Aave V3",
    subgraph_id: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
  },
  {
    id: "compound-v3-ethereum",
    protocol: "Compound V3",
    subgraph_id: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9",
  },
  {
    id: "spark-lend-ethereum",
    protocol: "Spark Lend",
    subgraph_id: "GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si",
  },
  {
    id: "morpho-aave-v3-ethereum",
    protocol: "Morpho Aave V3",
    subgraph_id: "FKe6ANnWmGPE6hajGLoTgPrVF2jYPHiRu2Jwcg9ZmG9A",
  },
];

const META_QUERY = `{
  _meta {
    block {
      number
      timestamp
      hash
    }
    deployment
    hasIndexingErrors
  }
}`;

const STANDARD_PROTOCOL_QUERY = `{
  _meta {
    block {
      number
    }
  }
  protocols(first: 1) {
    id
    name
    slug
    schemaVersion
    network
    totalValueLockedUSD
  }
}`;

function requireGraphApiKey() {
  if (typeof GRAPH_API_KEY !== "string" || GRAPH_API_KEY.trim() === "") {
    throw new Error("[probe] GRAPH_API_KEY must be set");
  }
}

async function fetchSubgraphMeta(source) {
  const gatewayUrl = `${GATEWAY_BASE}/${GRAPH_API_KEY}/subgraphs/id/${source.subgraph_id}`;
  const json = await postJson(
    gatewayUrl,
    { query: META_QUERY },
    { label: `subgraph ${source.id}` },
  );

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const messages = json.errors.map((error) => error.message).join("; ");
    throw new Error(`[probe] ${source.id}: GraphQL returned errors: ${messages}`);
  }

  const meta = json.data?._meta;
  if (!meta?.block || !Number.isSafeInteger(meta.block.number)) {
    throw new Error(`[probe] ${source.id}: response is missing a valid _meta block`);
  }

  return meta;
}

async function probeSource(source, chainHead) {
  try {
    const meta = await fetchSubgraphMeta(source);
    const lagBlocks = chainHead - meta.block.number;

    return {
      protocol: source.protocol,
      schema: source.schema,
      chain: source.chain,
      subgraph_id: source.subgraph_id,
      status: lagBlocks < 0 ? "CHAIN_MISMATCH" : "RESPONDING",
      delivered_block: meta.block.number,
      chain_head: chainHead,
      lag_blocks: lagBlocks,
      has_indexing_errors: meta.hasIndexingErrors,
      deployment: meta.deployment,
    };
  } catch (error) {
    return {
      protocol: source.protocol,
      schema: source.schema,
      chain: source.chain,
      subgraph_id: source.subgraph_id,
      status: "UNAVAILABLE",
      error: error.message,
    };
  }
}

async function probeStandardProtocol(source) {
  const gatewayUrl = `${GATEWAY_BASE}/${GRAPH_API_KEY}/subgraphs/id/${source.subgraph_id}`;

  try {
    const json = await postJson(
      gatewayUrl,
      { query: STANDARD_PROTOCOL_QUERY },
      { label: `subgraph ${source.id}` },
    );

    if (Array.isArray(json.errors) && json.errors.length > 0) {
      const messages = json.errors.map((error) => error.message).join("; ");
      throw new Error(`[probe] ${source.id}: GraphQL returned errors: ${messages}`);
    }

    const protocol = json.data?.protocols?.[0];
    if (protocol == null) {
      throw new Error(`[probe] ${source.id}: response contains no protocol`);
    }

    return {
      requested_protocol: source.protocol,
      returned_protocol: protocol.name,
      chain: protocol.network,
      schema_version: protocol.schemaVersion,
      total_value_locked_usd: protocol.totalValueLockedUSD,
      status: "RESPONDING",
    };
  } catch (error) {
    return {
      requested_protocol: source.protocol,
      status: "UNAVAILABLE",
      error: error.message,
    };
  }
}

requireGraphApiKey();

const chainHead = await fetchChainHead({
  id: "base-head",
  rpc_url: BASE_RPC_URL,
});

const results = [];
for (const source of SOURCES) {
  results.push(await probeSource(source, chainHead));
}

results.sort((left, right) => {
  if (left.status !== "RESPONDING") return 1;
  if (right.status !== "RESPONDING") return -1;
  return left.lag_blocks - right.lag_blocks;
});

console.table(results);

const standardResults = [];
for (const source of STANDARD_QUERY_SOURCES) {
  standardResults.push(await probeStandardProtocol(source));
}

console.table(standardResults);
