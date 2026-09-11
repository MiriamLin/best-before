export const REFUND_FAILURE_REASON_PROCESSING_FAILED =
  "Refund processing failed; manual review is required.";

const REFUND_STATUSES = new Set([
  "NOT_APPLICABLE",
  "COMPLETED",
  "FAILED",
]);

const PUBLIC_REFUND_FAILURE_REASONS = new Set([
  REFUND_FAILURE_REASON_PROCESSING_FAILED,
]);

const PAID_AMOUNT_SOURCES = new Set([
  "PAYMENT_REQUIREMENTS",
  "SETTLEMENT_PROOF",
]);

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `[receipt] ${label} must be a non-negative safe integer, got ${JSON.stringify(value)}`,
    );
  }
}

function requirePaidAmountSource(value) {
  if (!PAID_AMOUNT_SOURCES.has(value)) {
    throw new Error("[receipt] paidAmountSource must be a supported source");
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `[receipt] ${label} must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
}

function validatePriceSnapshot(freshness) {
  requireNonEmptyString(freshness.pool_id, "freshness.pool_id");
  if (!/^0x[0-9a-fA-F]{40}$/.test(freshness.pool_id)) {
    throw new Error("[receipt] freshness.pool_id must be a 20-byte EVM address");
  }

  requireNonEmptyString(freshness.pair, "freshness.pair");
  requireNonEmptyString(freshness.price, "freshness.price");
  requireNonEmptyString(freshness.price_direction, "freshness.price_direction");
}

function validateRefund({
  verdict,
  paidTinybar,
  refundTinybar,
  refundStatus,
  refundTxId,
  refundFailureReason,
}) {
  if (!REFUND_STATUSES.has(refundStatus)) {
    throw new Error("[receipt] refundStatus must be a supported status");
  }

  if (refundTinybar > paidTinybar) {
    throw new Error("[receipt] refundTinybar must not exceed paidTinybar");
  }

  if (refundStatus === "NOT_APPLICABLE") {
    if (paidTinybar > 0 && verdict === "FAIL") {
      throw new Error(
        "[receipt] paid failed deliveries require a completed or failed refund",
      );
    }

    if (refundTinybar !== 0 || refundTxId !== null || refundFailureReason !== null) {
      throw new Error("[receipt] NOT_APPLICABLE refunds must have zero amount and null details");
    }
    return;
  }

  if (verdict !== "FAIL" || refundTinybar === 0) {
    throw new Error("[receipt] refund attempts require a failed verdict and positive amount");
  }

  if (refundStatus === "COMPLETED") {
    if (typeof refundTxId !== "string" || refundTxId === "" || refundFailureReason !== null) {
      throw new Error("[receipt] COMPLETED refunds require a transaction ID and null failure reason");
    }
    return;
  }

  if (
    refundTxId !== null
    || !PUBLIC_REFUND_FAILURE_REASONS.has(refundFailureReason)
  ) {
    throw new Error("[receipt] FAILED refunds require a public failure reason and null transaction ID");
  }
}

export function buildReceipt({
  requestId,
  ts,
  source,
  freshness,
  tierEvaluation,
  paidTinybar,
  paidAmountSource,
  refundTinybar,
  refundStatus,
  refundTxId,
  refundFailureReason,
}) {
  requireNonNegativeSafeInteger(paidTinybar, "paidTinybar");
  requireNonNegativeSafeInteger(refundTinybar, "refundTinybar");
  requirePaidAmountSource(paidAmountSource);
  validatePriceSnapshot(freshness);

  validateRefund({
    verdict: tierEvaluation.verdict,
    paidTinybar,
    refundTinybar,
    refundStatus,
    refundTxId,
    refundFailureReason,
  });

  return {
    v: 1,
    request_id: requestId,
    source: source.id,
    chain: source.chain,
    delivered_block: freshness.delivered_block,
    chain_head: freshness.chain_head,
    lag_blocks: freshness.lag_blocks,
    age_seconds: freshness.age_seconds,
    age_is_estimated: freshness.age_is_estimated,
    deployment: freshness.deployment,
    has_indexing_errors: freshness.has_indexing_errors,
    pool_id: freshness.pool_id,
    pair: freshness.pair,
    price: freshness.price,
    price_direction: freshness.price_direction,
    tier: tierEvaluation.tier,
    verdict: tierEvaluation.verdict,
    failure_reasons: [...tierEvaluation.failure_reasons],
    tier_sla_seconds: tierEvaluation.tier_sla_seconds,
    paid_tinybar: paidTinybar,
    paid_amount_source: paidAmountSource,
    refund_tinybar: refundTinybar,
    refund_status: refundStatus,
    refund_tx_id: refundTxId,
    refund_failure_reason: refundFailureReason,
    delivery_status: tierEvaluation.verdict === "PASS" ? "DELIVERED" : "REFUSED",
    ts,
  };
}
