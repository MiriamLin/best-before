# Best Before Agent Skill

Best Before sells WETH/USDC price snapshots with a freshness SLA. It is designed for agents that need to decide whether current on-chain price data is fresh enough to use.

## When to use it

Use Best Before before a latency-sensitive action that depends on a WETH/USDC price from the configured Base source.

- Use `check_freshness` first when you can abstain or select a cheaper tier.
- Use `buy_price` only when a paid, freshness-guaranteed snapshot is worth the HBAR cost.
- Do not use it as a trading strategy, an execution engine, or insurance against trading losses.

## Inputs

The currently configured price source is:

- `aerodrome-base-full` — WETH/USDC on Base.

Tiers use strict age bounds: the received age must be **less than** the SLA.

| Tier | SLA | Price |
| --- | --- | --- |
| `strict` | `< 0 seconds` | 0.02 HBAR; intentionally always refused for refund demonstrations. |
| `realtime` | `< 5 seconds` | 0.01 HBAR. |
| `delayed` | `< 60 seconds` | 0.001 HBAR. |

## MCP tools

### `check_freshness`

Input:

```json
{ "source": "aerodrome-base-full" }
```

This is free. It returns the current pre-payment `age_seconds`, `lag_blocks`, tier prices, availability, and a disclaimer. Treat it as advisory only: the service measures freshness again after payment.

### `buy_price`

Input:

```json
{ "source": "aerodrome-base-full", "tier": "realtime" }
```

This makes a real x402 payment in HBAR. The buyer private key is loaded from the server process environment, never from tool input.

Possible normal business outcomes:

- `DELIVERED`: use `data.price` with the returned receipt.
- `REFUSED`: do not act on a price. Read `failure_reasons`, `actual_age_seconds`, `tier_sla_seconds`, `refund_tinybar`, and `refund_tx_id`. This is not a tool error and should not be retried automatically.
- `UNDELIVERED`: do not act. The service could not measure the snapshot and makes no data claim. Check the receipt's refund status before any manual follow-up.

## Decision policy

Keep the decision rule simple:

1. Check freshness.
2. Buy `realtime` if it is available.
3. Otherwise buy `delayed` if it is available.
4. Otherwise abstain and do not pay.
5. After a purchase, act only on `DELIVERED` data.

The provided CLI implements this policy:

```bash
node src/client.js aerodrome-base-full --agent
```

## Reading a receipt

Use these fields together:

- `snapshot_status`: `AVAILABLE` means a snapshot was measured; `UNAVAILABLE` means all snapshot fields are intentionally `null`.
- `delivered_block`, `chain_head`, and `lag_blocks`: the inputs for block-lag arithmetic.
- `age_seconds` and `tier_sla_seconds`: the actual age and purchased bound.
- `verdict`: `PASS`, `FAIL`, or `UNAVAILABLE`.
- `delivery_status`: `DELIVERED`, `REFUSED`, or `UNDELIVERED`.
- `paid_tinybar`, `refund_tinybar`, `refund_status`, and `refund_tx_id`: the settlement and refund evidence.

HCS-confirmed receipts are public in topic `0.0.10434434`:

`https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10434434/messages?limit=100&order=desc`

## Safety rules

- Never put a private key in a tool parameter, prompt, log, or receipt.
- Do not retry a `REFUSED` purchase automatically; it has already paid and triggered the refund path.
- Do not treat a pre-payment disclosure as a guarantee.
- Do not invent a value for missing fields in an `UNDELIVERED` receipt. The correct conclusion is no claim made and no action.
