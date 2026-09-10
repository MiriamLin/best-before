export function buildReceipt({
  requestId,
  ts,
  source,
  freshness,
  tierEvaluation,
}) {
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
    delivery_status: tierEvaluation.verdict === "PASS" ? "DELIVERED" : "REFUSED",
    ts,
  };
}
