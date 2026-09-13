# Best Before

**Freshness-guaranteed on-chain price data for AI agents.** Stale data is refused and a full refund is attempted. Every HCS-confirmed outcome is recorded in a ledger the operator cannot edit.

[Live API](https://best-before-production.up.railway.app/price?source=aerodrome-base-full&tier=realtime) · [Proof Console](https://best-before-production.up.railway.app/dashboard) · [On-chain receipts](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10434434/messages?limit=100&order=desc)

A quantitative trading agent can receive a plausible WETH/USDC price from an indexer that is minutes, hours, or months behind the chain. It cannot tell whether a bad execution came from its strategy or its data provider unless the provider records what it actually delivered.

The staleness is not hypothetical. Over a few hours we measured the same subgraph deployment at **1 block behind**, then **20,495,998 blocks behind**, then **3 blocks behind**. Every response reported `hasIndexingErrors: false`.

Freshness here is not a claim. It is derived from `_meta` and the chain head, and the receipt records the inputs — so you can recompute the verdict without trusting us.

## Why this is different

Buyer-side freshness checks are a warning light. Best Before is a warranty.

Buyer-side freshness checks demonstrate useful data-health checks, while existing x402 and MCP services demonstrate pay-per-use API access. Best Before uses both ideas differently: the provider measures freshness *after payment*, refuses stale data, and returns the payment when it cannot meet the sold SLA.

When a buyer alone detects stale data, the seller has already been paid. With a supply-side refund, a provider that serves stale data loses revenue. The mechanism changes the incentive to maintain a faster upstream, not merely the ability to notice a slow one.

## Three layers of protection

1. **Disclose.** An unpaid `GET /price` returns HTTP `402` with a free, advisory freshness snapshot and the tiers currently available.
2. **Gate.** After x402 settlement, Best Before measures a new snapshot from The Graph `_meta`, the same GraphQL request's pool price, and the Base chain head. It sells only a tier whose SLA is met.
3. **Refund.** If the fresh measurement misses the SLA, Best Before refuses delivery, attempts a full refund, and records the result in HCS.

The pre-payment response is intentionally not an SLA. The actual contract is the post-payment measurement in the receipt.

```json
{
  "freshness_disclosure": {
    "status": "AVAILABLE",
    "age_seconds": 3,
    "lag_blocks": 1,
    "disclaimer": "This is a pre-payment snapshot, not an SLA guarantee. Freshness is measured again after payment; only that measurement is covered by the SLA."
  }
}
```

## Three outcomes, not one generic error

| Outcome | Meaning | Data delivered | Payment result |
| --- | --- | --- | --- |
| `DELIVERED` | The snapshot was measured and met the purchased SLA. | Yes | Kept by the provider. |
| `REFUSED` | The snapshot was measured, but did not meet the purchased SLA. | No | Full refund attempted. |
| `UNDELIVERED` | The provider could not obtain a snapshot at all. It makes no freshness or price claim. | No | Full refund attempted. |

`REFUSED` and `UNDELIVERED` are deliberately different. The first says, “we measured the data and rejected it.” The second says, “we could not measure it, so we claim nothing.” In an `UNDELIVERED` receipt every snapshot-derived field is `null`, not zero.

## Evidence measured during development

The same deployment ID, `QmasYjypV6nTLp4iNH4Vjf7fksRNxAkAskqDdKf2DCsQkV`, was observed at lag `1`, then lag `20,495,998`, then lag `3`; each response said `hasIndexingErrors: false`.

The result is operational rather than theoretical: a subgraph's health is not a property that can be cached. It must be measured at the time a paid request is fulfilled.

## Standardized schema leaderboard

Best Before also demonstrates the leverage and the limit of a shared schema. One Messari Standardized Subgraph `Protocol` query reads comparable TVL and freshness inputs across Moonwell, Aave V3, Compound III, Spark Lend, and Morpho Aave V3. No per-protocol adapter is needed.

Run it locally:

```bash
node scripts/standard-leaderboard.js
```

Or open the **Standardized Leaderboard** tab in the [Proof Console](https://best-before-production.up.railway.app/dashboard). It also reports three Base diagnostics: two unavailable deployments and one whose manifest says `BASE` while `Protocol.network` says `MAINNET`.

The conclusion is intentional: **standardization solves how to ask, not whether the answer can be trusted.** The leaderboard uses live data from [The Graph's Messari Standardized Subgraphs](https://thegraph.com/docs/en/subgraphs/existing-subgraphs/standard-subgraphs/) and a chain-specific RPC head for each row. It does not compare block lags across chains.

The price API proves the mechanism can enforce an individual seller promise. The leaderboard shows why the same freshness problem is broader than one protocol.

## Architecture and payment flow

```text
Agent / CLI / MCP
        │
        │  HTTP 402 + x402 payment proof
        ▼
Blocky402 facilitator ──► Best Before /price
                                  │
                   ┌──────────────┴──────────────┐
                   ▼                             ▼
       The Graph subgraph + _meta             Base RPC head
                   │                             │
                   └──────────────┬──────────────┘
                                  ▼
                         SLA evaluation
                         │             │
                    DELIVERED       REFUSED / UNDELIVERED
                         │             │
                         └──────► Hedera HCS ◄───── refund transfer
```

1. A client requests `GET /price?source=…&tier=…` without credentials.
2. The x402 middleware returns `402` and a tier-specific HBAR price.
3. The client signs the exact payment; [Blocky402](https://api.testnet.blocky402.com/supported) settles it on Hedera testnet before the handler runs.
4. Best Before takes the settled payer and amount, then requests `_meta` and the WETH/USDC pool in one GraphQL request. It obtains the Base head separately with `eth_blockNumber`.
5. It calculates `lag_blocks = chain_head - delivered_block` and `age_seconds` from the indexed block timestamp. Tier SLAs use strict inequality: `age_seconds < max_age_seconds`.
6. It builds exactly one receipt object. The HTTP response and HCS message use that same object. Refusal and upstream-failure receipts wait for HCS consensus; ordinary delivery HCS submission is asynchronous.

The paid exact scheme price is recorded as `paid_amount_source: "PAYMENT_REQUIREMENTS"`: the exact scheme requires that amount, but the value is inferred from payment requirements rather than directly read from a settlement amount field.

## Verify a real receipt yourself

The public HCS topic is `0.0.10434434`. Its [Mirror Node metadata](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10434434) currently returns `"admin_key": null`; the operator cannot administratively edit or delete submitted messages.

For a delivered example, receipt `req-09a5319d-4f57-4fcf-8e1e-adeb6260ce46` is HCS sequence `19`. Its message is in the [public topic feed](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10434434/messages?limit=100&order=desc). It records:

- `delivered_block: 51222417`
- `chain_head: 51222417`
- `lag_blocks: 0`
- `age_seconds: 2`
- `tier: "realtime"` and `tier_sla_seconds: 5`
- `verdict: "PASS"`

To inspect that message locally on macOS:

```bash
curl -s 'https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10434434/messages?limit=100&order=desc' \
  | jq -r '.messages[] | select(.sequence_number == 19) | .message' \
  | base64 -D | jq
```

You can verify a receipt in three independent places:

1. Decode the HCS message and check the tier, measured age, paid amount, refund fields, and verdict.
2. Query the recorded deployment and pool at the recorded block through The Graph. The receipt contains `deployment`, `pool_id`, `pair`, `price`, and `price_direction`.
3. Query Base block headers for `delivered_block` and `chain_head`. The recorded block timestamps and receipt `ts` let you independently check the age calculation; subtracting the two block numbers checks lag. For a completed refund, paste `refund_tx_id` into HashScan's transaction search to inspect its transfer and memo.

The receipt gives the inputs and the conclusion. It does not require trusting the service's in-memory state.

## Run locally

### Requirements

- Node.js 20 or later
- A The Graph API key
- Two Hedera testnet accounts: one service account and one buyer account
- DER-encoded ECDSA private keys for both accounts
- An HCS topic with **no admin key**

Copy the template; never commit the resulting `.env` file.

```bash
cp .env.example .env
npm install
```

Fill `.env` with your account IDs, private keys, The Graph key, and topic ID.

### Create an HCS topic with no admin key

With the service-account values filled in, create a topic using this command. It deliberately does **not** call `setAdminKey`.

```bash
node --input-type=module -e '
import "dotenv/config";
import { Client, PrivateKey, TopicCreateTransaction } from "@hashgraph/sdk";
const client = Client.forTestnet();
client.setOperator(process.env.HEDERA_ACCOUNT_ID, PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY));
const response = await new TopicCreateTransaction().setTopicMemo("BestBefore delivery receipts v1").execute(client);
console.log(`HCS_TOPIC_ID=${(await response.getReceipt(client)).topicId.toString()}`);
client.close();
'
```

Copy the printed value into `HCS_TOPIC_ID` in `.env`. Confirm the topic's metadata exposes `admin_key: null` before using it for receipts.

### Start the service

```bash
node src/server.js
curl http://localhost:3000/health
```

Use the paid CLI client. This performs a real Hedera testnet payment.

```bash
node src/client.js aerodrome-base-full realtime
```

The deliberately impossible `strict` tier has `max_age_seconds: 0`; because the SLA is strict `<`, it always refuses and exercises the refund path.

```bash
node src/client.js aerodrome-base-full strict
```

The agent mode first reads the free disclosure, buys `realtime` when available, otherwise buys `delayed`, and abstains when neither is available:

```bash
node src/client.js aerodrome-base-full --agent
```

For a recording-only sequence that makes two paid calls, use `--demo`. It runs disclosure → strict refusal/refund → realtime purchase.

```bash
node src/client.js aerodrome-base-full --demo
```

### MCP server

The stdio MCP server exposes `check_freshness` and `buy_price`.

```bash
node src/mcp.js
```

For an MCP host configuration, point the command at this repository and preserve the working directory so `dotenv` loads `.env`:

```json
{
  "mcpServers": {
    "best-before": {
      "command": "node",
      "args": ["/absolute/path/to/best-before/src/mcp.js"],
      "cwd": "/absolute/path/to/best-before"
    }
  }
}
```

`buy_price` spends HBAR on every call. Private keys are read only from `.env`; they are never tool parameters.

## Sponsor integrations

| ETHOnline 2026 track | What Best Before implements | Evidence |
| --- | --- | --- |
| [AI & Agentic Payments on Hedera](https://ethglobal.com/events/ethonline2026/prizes) | A live x402-gated, HBAR-priced API settled by Blocky402; a CLI agent and an MCP client consume it with real testnet payments. Per-tier pricing meters data by freshness. | `src/server.js`, `src/client.js`, `src/mcp.js`, [HCS topic](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10434434) |
| [Best AI Tooling or AI Use Case with The Graph (From Scratch)](https://ethglobal.com/events/ethonline2026/prizes) | The Graph is load-bearing: a buyer agent changes its decision from buy to abstain based on live subgraph freshness. The MCP server makes the paid service reusable from agent hosts. | `src/subgraph.js`, `src/freshness.js`, `src/client.js`, `src/mcp.js` |
| [Best Use of Composable or Standardized Graph Products](https://ethglobal.com/events/ethonline2026/prizes) | One Messari `Protocol` query runs across five live lending protocols, demonstrating shared-schema leverage while explicitly diagnosing unavailable or suspect deployments. | `src/standard-leaderboard.js`, `scripts/standard-leaderboard.js`, dashboard leaderboard |

## Known limits, stated plainly

- `paid_amount_source` is `PAYMENT_REQUIREMENTS`. In the exact scheme, settlement success means the configured exact amount was required, but the value is inferred from that requirement rather than directly observed in a settlement proof field.
- The unpaid freshness disclosure is a snapshot only. It is not an SLA and may differ from the post-payment measurement.
- `age_seconds` uses `Math.floor`, so it has one-second precision. SLAs use strict `<`, which makes that rounding error favorable to the buyer.
- Settled payer information is stored in memory. If the service restarts after Blocky402 settlement but before the handler reads the payer, it cannot identify a refund destination. Persistent settlement storage is a deployment-level next step.
- Ordinary delivery receipt submission is asynchronous. Refusal and upstream-failure receipt writes wait for HCS consensus because those paths involve a refund attempt.
- A refund is a provider incentive and a return of the data fee, not insurance against a buyer's trading loss. Best Before does not diagnose *why* an indexer lags; it measures whether the data meets the sold promise.

## License

MIT
