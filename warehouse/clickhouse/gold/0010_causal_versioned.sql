-- causal_effects had no version column, so when a re-run corrected a verdict ClickHouse chose
-- between the old row and the new one arbitrarily. A correction has to win. Recreated with a
-- version column rather than altered, because the engine itself is what was wrong.
CREATE TABLE IF NOT EXISTS gold.causal_effects_v2 (
    effect_id       String,
    investigation_id String,
    anomaly_id      String,
    tenant_id       String,
    kpi_id          String,
    intervention    String,
    rung            String,
    effect_point    Float64,
    effect_lower    Float64,
    effect_upper    Float64,
    method          String,
    assumptions_met UInt8 DEFAULT 1,
    degraded_reason String DEFAULT '',
    counterfactual  Float64 DEFAULT 0,
    observed        Float64 DEFAULT 0,
    placebo_effect  Float64 DEFAULT 0,
    control_cells   UInt32 DEFAULT 0,
    engine_type     String DEFAULT 'stats',
    _version        DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, anomaly_id, effect_id);

-- The old rows predate both the counterfactual and the significance gate, so they are not
-- carried over: a verdict nothing can reproduce is not evidence.
DROP TABLE IF EXISTS gold.causal_effects;
RENAME TABLE gold.causal_effects_v2 TO gold.causal_effects;
