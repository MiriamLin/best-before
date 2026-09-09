import { postJson } from "./http.js";

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

export async function fetchSubgraphMeta(source) {
  const json = await postJson(
    source.gateway_url,
    { query: META_QUERY },
    { label: `subgraph ${source.id}` },
  );

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const messages = json.errors.map((error) => error.message).join("; ");
    throw new Error(`[subgraph] ${source.id}: GraphQL returned errors: ${messages}`);
  }

  const meta = json.data?._meta;
  if (!meta?.block) {
    throw new Error(`[subgraph] ${source.id}: response is missing data._meta`);
  }

  return {
    block: {
      number: meta.block.number,
      timestamp: meta.block.timestamp,
      hash: meta.block.hash,
    },
    deployment: meta.deployment,
    hasIndexingErrors: meta.hasIndexingErrors,
  };
}
