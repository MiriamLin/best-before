import { createPaidFetch } from "./payment-client.js";

const PRICE_API_URL = "http://localhost:3000/price";

const [sourceId, tierName] = process.argv.slice(2);
if (typeof sourceId !== "string" || typeof tierName !== "string") {
  throw new Error("Usage: node src/client.js <source-id> <tier-name>");
}

const fetchWithPayment = createPaidFetch();
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
