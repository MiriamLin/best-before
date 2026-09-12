import { createPaidFetch } from "./payment-client.js";

const BASE = process.env.BEST_BEFORE_URL ?? "http://localhost:3000";
const [sourceId, mode] = process.argv.slice(2);

function usage() {
  return [
    "Usage:",
    "  node src/client.js <source-id> <tier-name>",
    "  node src/client.js <source-id> --agent",
    "  node src/client.js <source-id> --demo",
  ].join("\n");
}

function requireSourceId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(usage());
  }
}

function buildPriceUrl(source, tier) {
  const url = new URL("/price", BASE);
  url.searchParams.set("source", source);
  url.searchParams.set("tier", tier);
  return url;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`[client] expected a JSON response: ${error.message}`);
  }
}

function formatHbar(tinybar) {
  if (!Number.isSafeInteger(tinybar) || tinybar < 0) {
    throw new Error(`[client] expected a non-negative tinybar integer, got ${JSON.stringify(tinybar)}`);
  }

  const whole = Math.floor(tinybar / 100_000_000);
  const fraction = String(tinybar % 100_000_000)
    .padStart(8, "0")
    .replace(/0+$/, "");

  return `${whole}${fraction === "" ? "" : `.${fraction}`} HBAR`;
}

function getDisclosureTier(disclosure, name) {
  const tier = disclosure.tiers?.find((candidate) => candidate.name === name);
  if (tier == null) {
    throw new Error(`[client] freshness disclosure is missing tier "${name}"`);
  }
  return tier;
}

function printDisclosure(disclosure) {
  if (disclosure.status !== "AVAILABLE") {
    console.log("[check]  freshness disclosure unavailable");
    return;
  }

  const tiers = disclosure.tiers.map((tier) => (
    `${tier.name} ${tier.available ? "✓" : "✗"}`
  ));
  console.log(
    `[check]  age ${disclosure.age_seconds}s | ${tiers.join(" | ")}`,
  );
}

async function fetchDisclosure(source) {
  const response = await fetch(buildPriceUrl(source, "realtime"));
  const body = await readJson(response);

  if (response.status !== 402) {
    throw new Error(`[client] expected HTTP 402 for unpaid disclosure, got ${response.status}`);
  }
  if (body.freshness_disclosure == null) {
    throw new Error("[client] HTTP 402 response is missing freshness_disclosure");
  }

  return body.freshness_disclosure;
}

async function buyPrice(source, tier) {
  const fetchWithPayment = createPaidFetch();
  const response = await fetchWithPayment(buildPriceUrl(source, tier));
  return { response, body: await readJson(response) };
}

function printPaidResult(body) {
  const receipt = body.receipt;
  if (receipt == null) {
    console.log("[result] no receipt returned");
    return;
  }

  console.log(`[buy]    paid ${formatHbar(receipt.paid_tinybar)}`);

  if (receipt.delivery_status === "DELIVERED") {
    console.log(
      `[result] DELIVERED ${body.data.pair} ${body.data.price} `
      + `age ${receipt.age_seconds}s → BUY`,
    );
  } else if (receipt.delivery_status === "REFUSED") {
    console.log(
      `[result] REFUSED age ${receipt.age_seconds}s `
      + `for ${receipt.tier} SLA ${receipt.tier_sla_seconds}s → NO ACTION`,
    );
    console.log(
      `[refund] ${formatHbar(receipt.refund_tinybar)} `
      + `${receipt.refund_status.toLowerCase()}`,
    );
  } else {
    console.log("[result] UNDELIVERED → NO ACTION");
  }

  console.log(`          receipt ${receipt.request_id}`);
}

async function runSingleRequest(source, tier) {
  const { response, body } = await buyPrice(source, tier);

  console.log(JSON.stringify({
    status: response.status,
    body,
  }, null, 2));

  if (!response.ok) {
    process.exitCode = 1;
  }
}

async function runAgent(source) {
  const disclosure = await fetchDisclosure(source);
  printDisclosure(disclosure);

  if (disclosure.status !== "AVAILABLE") {
    console.log("[decide] freshness is unavailable → abstain");
    return;
  }

  const realtime = getDisclosureTier(disclosure, "realtime");
  const delayed = getDisclosureTier(disclosure, "delayed");
  const selected = realtime.available ? realtime : delayed.available ? delayed : null;

  if (selected == null) {
    console.log("[decide] no tier is available → abstain");
    return;
  }

  console.log(`[decide] ${selected.name} is available → buying ${selected.name}`);
  const { response, body } = await buyPrice(source, selected.name);
  printPaidResult(body);

  if (!response.ok) {
    process.exitCode = 1;
  }
}

async function runDemo(source) {
  const disclosure = await fetchDisclosure(source);
  printDisclosure(disclosure);

  console.log("[demo]   buying strict to demonstrate refusal and refund");
  const strictPurchase = await buyPrice(source, "strict");
  printPaidResult(strictPurchase.body);

  if (!strictPurchase.response.ok) {
    process.exitCode = 1;
    return;
  }

  console.log("[demo]   buying realtime");
  const realtimePurchase = await buyPrice(source, "realtime");
  printPaidResult(realtimePurchase.body);

  if (!realtimePurchase.response.ok) {
    process.exitCode = 1;
  }
}

requireSourceId(sourceId);

if (mode === "--agent") {
  await runAgent(sourceId);
} else if (mode === "--demo") {
  await runDemo(sourceId);
} else if (typeof mode === "string" && !mode.startsWith("--")) {
  await runSingleRequest(sourceId, mode);
} else {
  throw new Error(usage());
}
