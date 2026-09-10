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

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `[receipt] ${label} must be a non-negative safe integer, got ${JSON.stringify(value)}`,
    );
  }
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
  refundTinybar,
  refundStatus,
  refundTxId,
  refundFailureReason,
}) {
  requireNonNegativeSafeInteger(paidTinybar, "paidTinybar");
  requireNonNegativeSafeInteger(refundTinybar, "refundTinybar");

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
    tier: tierEvaluation.tier,
    verdict: tierEvaluation.verdict,
    failure_reasons: [...tierEvaluation.failure_reasons],
    tier_sla_seconds: tierEvaluation.tier_sla_seconds,
    paid_tinybar: paidTinybar,
    refund_tinybar: refundTinybar,
    refund_status: refundStatus,
    refund_tx_id: refundTxId,
    refund_failure_reason: refundFailureReason,
    delivery_status: tierEvaluation.verdict === "PASS" ? "DELIVERED" : "REFUSED",
    ts,
  };
}
