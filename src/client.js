import { x402Client } from "@x402/core/client";
import { PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const HEDERA_TESTNET = "hedera:testnet";
const PRICE_API_URL = "http://localhost:3000/price";

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[client] ${name} must be set in .env`);
  }
  return value;
}

const [sourceId, tierName] = process.argv.slice(2);
if (typeof sourceId !== "string" || typeof tierName !== "string") {
  throw new Error("Usage: node src/client.js <source-id> <tier-name>");
}

const buyerAccountId = requireEnvironmentVariable("BUYER_ACCOUNT_ID");
const buyerPrivateKey = requireEnvironmentVariable("BUYER_PRIVATE_KEY");

const signer = createClientHederaSigner(
  buyerAccountId,
  PrivateKey.fromStringECDSA(buyerPrivateKey),
  { network: HEDERA_TESTNET },
);

const client = x402Client.fromConfig({
  schemes: [
    {
      network: HEDERA_TESTNET,
      client: new ExactHederaScheme(signer),
    },
  ],
  spendControls: false,
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const url = new URL(PRICE_API_URL);
url.searchParams.set("source", sourceId);
url.searchParams.set("tier", tierName);

const response = await fetchWithPayment(url);
const body = await response.json();

console.log(JSON.stringify({
  status: response.status,
  body,
}, null, 2));

if (!response.ok) {
  process.exitCode = 1;
}
