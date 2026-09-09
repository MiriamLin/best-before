import { postJson } from "./http.js";

function parseBlockNumber(result, label) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
    throw new Error(
      `[rpc] ${label}: expected a hexadecimal block number in result, got ${JSON.stringify(result)}`,
    );
  }

  const blockNumber = Number.parseInt(result, 16);
  if (!Number.isSafeInteger(blockNumber)) {
    throw new Error(
      `[rpc] ${label}: block number is outside JavaScript's safe integer range: ${result}`,
    );
  }

  return blockNumber;
}

export async function fetchChainHead(source) {
  const json = await postJson(
    source.rpc_url,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    },
    { label: source.rpc_url },
  );

  if (json.error != null) {
    throw new Error(
      `[rpc] ${source.rpc_url}: JSON-RPC error: ${JSON.stringify(json.error)}`,
    );
  }

  return parseBlockNumber(json.result, source.rpc_url);
}
