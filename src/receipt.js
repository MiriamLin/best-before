export const REFUND_FAILURE_REASON_PROCESSING_FAILED =
  "Refund processing failed; manual review is required.";

const REFUND_STATUSES = new Set([
  "NOT_APPLICABLE",
  "COMPLETED",
  "FAILED",
]);

const SNAPSHOT_STATUSES = new Set([
  "AVAILABLE",
  "UNAVAILABLE",
]);

const VERDICTS = new Set([
  "PASS",
  "FAIL",
  "UNAVAILABLE",
]);

const UPSTREAM_UNAVAILABLE = "UPSTREAM_UNAVAILABLE";

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

function validateSnapshot(snapshotStatus, freshness) {
  if (!SNAPSHOT_STATUSES.has(snapshotStatus)) {
    throw new Error("[receipt] snapshotStatus must be a supported status");
  }

  if (snapshotStatus === "AVAILABLE") {
    if (freshness == null || typeof freshness !== "object") {
      throw new Error("[receipt] AVAILABLE snapshots require freshness data");
    }
    validatePriceSnapshot(freshness);
    return;
  }

  if (freshness !== null) {
    throw new Error("[receipt] UNAVAILABLE snapshots must have null freshness data");
  }
}

function validateTierEvaluation(snapshotStatus, tierEvaluation) {
  if (!VERDICTS.has(tierEvaluation.verdict)) {
    throw new Error("[receipt] tierEvaluation.verdict must be a supported verdict");
  }

  if (snapshotStatus === "AVAILABLE" && tierEvaluation.verdict === "UNAVAILABLE") {
    throw new Error("[receipt] AVAILABLE snapshots cannot have an UNAVAILABLE verdict");
  }

  if (snapshotStatus === "UNAVAILABLE") {
    if (
      tierEvaluation.verdict !== "UNAVAILABLE"
      || tierEvaluation.failure_reasons.length !== 1
      || tierEvaluation.failure_reasons[0] !== UPSTREAM_UNAVAILABLE
    ) {
      throw new Error(
        "[receipt] UNAVAILABLE snapshots require the UPSTREAM_UNAVAILABLE verdict reason",
      );
    }
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
    if (paidTinybar > 0 && verdict !== "PASS") {
      throw new Error(
        "[receipt] paid non-deliveries require a completed or failed refund",
      );
    }

    if (refundTinybar !== 0 || refundTxId !== null || refundFailureReason !== null) {
      throw new Error("[receipt] NOT_APPLICABLE refunds must have zero amount and null details");
    }
    return;
  }

  if (verdict === "PASS" || refundTinybar === 0) {
    throw new Error("[receipt] refund attempts require a non-PASS verdict and positive amount");
  }

  if (paidTinybar > 0 && refundTinybar !== paidTinybar) {
    throw new Error("[receipt] paid non-deliveries must refund the full paid amount");
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
  snapshotStatus,
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
  validateSnapshot(snapshotStatus, freshness);
  validateTierEvaluation(snapshotStatus, tierEvaluation);

  validateRefund({
    verdict: tierEvaluation.verdict,
    paidTinybar,
    refundTinybar,
    refundStatus,
    refundTxId,
    refundFailureReason,
  });

  const snapshot = freshness ?? {
    delivered_block: null,
    chain_head: null,
    lag_blocks: null,
    age_seconds: null,
    age_is_estimated: null,
    deployment: null,
    has_indexing_errors: null,
    pool_id: null,
    pair: null,
    price: null,
    price_direction: null,
  };

  return {
    v: 1,
    request_id: requestId,
    source: source.id,
    chain: source.chain,
    snapshot_status: snapshotStatus,
    delivered_block: snapshot.delivered_block,
    chain_head: snapshot.chain_head,
    lag_blocks: snapshot.lag_blocks,
    age_seconds: snapshot.age_seconds,
    age_is_estimated: snapshot.age_is_estimated,
    deployment: snapshot.deployment,
    has_indexing_errors: snapshot.has_indexing_errors,
    pool_id: snapshot.pool_id,
    pair: snapshot.pair,
    price: snapshot.price,
    price_direction: snapshot.price_direction,
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
    delivery_status: tierEvaluation.verdict === "PASS"
      ? "DELIVERED"
      : tierEvaluation.verdict === "FAIL"
        ? "REFUSED"
        : "UNDELIVERED",
    ts,
  };
}
