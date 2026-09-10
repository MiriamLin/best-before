import { fetchChainHead } from "./rpc.js";
import { fetchSubgraphMeta } from "./subgraph.js";

const AVERAGE_BLOCK_TIME_SECONDS = {
  base: 2,
  ethereum: 12,
};

function calculateAge(source, timestamp, lagBlocks) {
  if (timestamp === null) {
    const secondsPerBlock = AVERAGE_BLOCK_TIME_SECONDS[source.chain];
    if (secondsPerBlock == null) {
      throw new Error(
        `[freshness] ${source.id}: no average block time configured for chain "${source.chain}"`,
      );
    }

    return {
      ageSeconds: lagBlocks * secondsPerBlock,
      ageIsEstimated: true,
    };
  }

  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error(
      `[freshness] ${source.id}: block timestamp must be a number or null, got ${JSON.stringify(timestamp)}`,
    );
  }

  return {
    ageSeconds: Math.floor(Date.now() / 1_000) - timestamp,
    ageIsEstimated: false,
  };
}

export async function measureFreshness(source) {
  const [meta, chainHead] = await Promise.all([
    fetchSubgraphMeta(source),
    fetchChainHead(source),
  ]);

  const deliveredBlock = meta.block.number;
  const lagBlocks = chainHead - deliveredBlock;
  if (lagBlocks < 0) {
    throw new Error(
      `[freshness] ${source.id}: negative lag (${lagBlocks}); RPC and subgraph may target different chains`,
    );
  }

  if (typeof meta.hasIndexingErrors !== "boolean") {
    throw new Error(
      `[freshness] ${source.id}: hasIndexingErrors must be a boolean, got ${JSON.stringify(meta.hasIndexingErrors)}`,
    );
  }

  const { ageSeconds, ageIsEstimated } = calculateAge(
    source,
    meta.block.timestamp,
    lagBlocks,
  );

  return {
    delivered_block: deliveredBlock,
    chain_head: chainHead,
    lag_blocks: lagBlocks,
    age_seconds: ageSeconds,
    age_is_estimated: ageIsEstimated,
    deployment: meta.deployment,
    has_indexing_errors: meta.hasIndexingErrors,
  };
}
