export function evaluateTier(tierName, tier, freshness) {
  const failureReasons = [];

  if (freshness.has_indexing_errors) {
    failureReasons.push("INDEXING_ERRORS");
  }
  if (freshness.age_seconds >= tier.max_age_seconds) {
    failureReasons.push("AGE_EXCEEDS_SLA");
  }

  return {
    tier: tierName,
    verdict: failureReasons.length === 0 ? "PASS" : "FAIL",
    failure_reasons: failureReasons,
    actual_age_seconds: freshness.age_seconds,
    tier_sla_seconds: tier.max_age_seconds,
    has_indexing_errors: freshness.has_indexing_errors,
  };
}

export function evaluateTiers(tiers, freshness) {
  const evaluations = Object.entries(tiers).map(([name, tier]) => (
    evaluateTier(name, tier, freshness)
  ));

  return {
    passing_tiers: evaluations.filter(({ verdict }) => verdict === "PASS"),
    failing_tiers: evaluations.filter(({ verdict }) => verdict === "FAIL"),
  };
}
