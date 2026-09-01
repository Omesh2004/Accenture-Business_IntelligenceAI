-- ═══════════════════════════════════════════════════════════════════════════
-- The Signal Store — where every tool writes what it concluded, and the only
-- thing the narrator is allowed to read. Lifted VERBATIM from the prototype
-- (schema.sql); the only change is the database name (feature_intelligence →
-- gold). Schema owned by Track C; Track B only re-homes it.
--
-- The investigation spine: every table is joined by investigation_id, minted
-- once when a run starts. Do NOT hang the audit trail off anomaly_id — Trust
-- Gate can fail before any anomaly exists, and model_runs is written by stages
-- that run before an insight exists. `forecasts` is the one exception: a
-- scheduled batch with its own forecast_id.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gold.investigations (
    investigation_id String,
    tenant_id        String,
    kpi_id           String,
    window_start     DateTime,
    window_end       DateTime,
    trigger          String,
    status           String,
    terminal_stage   String DEFAULT '',
    termination_reason String DEFAULT '',
    dataset          String,
    started_at       DateTime,
    ended_at         DateTime DEFAULT toDateTime(0),
    watermark_ingested_at DateTime DEFAULT toDateTime(0)
) ENGINE = ReplacingMergeTree(started_at)
ORDER BY (tenant_id, kpi_id, investigation_id);

CREATE TABLE IF NOT EXISTS gold.trust_findings (
    finding_id       String,
    investigation_id String,
    tenant_id        String,
    kpi_id           String,
    window_start     DateTime,
    window_end       DateTime,
    verdict          String,
    check_id         String,
    fingerprint      String DEFAULT '',
    observed         String,
    expected         String,
    cheapest_check   String DEFAULT '',
    blocks_narrative UInt8 DEFAULT 0,
    engine_type      String DEFAULT 'rule',
    ts               DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ts)
ORDER BY (tenant_id, kpi_id, window_start, check_id);

CREATE TABLE IF NOT EXISTS gold.anomalies (
    anomaly_id   String,
    investigation_id String,
    tenant_id    String,
    kpi_id       String,
    detected_at  DateTime,
    window_start DateTime,
    window_end   DateTime,
    method       String,
    direction    Int8,
    magnitude    Float64,
    baseline     Float64,
    observed     Float64,
    forecast_id  String DEFAULT '',
    materiality  Float64,
    severity     String,
    status       String DEFAULT 'open',
    engine_type  String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree(detected_at)
ORDER BY (tenant_id, kpi_id, window_start);

CREATE TABLE IF NOT EXISTS gold.root_causes (
    cause_id      String,
    investigation_id String,
    anomaly_id    String,
    tenant_id     String,
    rank          UInt8,
    dimensions    String,
    fundamental   String,
    contribution  Float64,
    method        String,
    explained_pct Float64,
    engine_type   String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, fundamental, rank);

CREATE TABLE IF NOT EXISTS gold.forecasts (
    forecast_id   String,
    tenant_id     String,
    kpi_id        String,
    as_of         DateTime,
    horizon_days  UInt16,
    point         Float64,
    lower         Float64,
    upper         Float64,
    method        String,
    confidence    Float64,
    backtest_mase Float64 DEFAULT 0,
    caveat        String DEFAULT '',
    engine_type   String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree(as_of)
ORDER BY (tenant_id, kpi_id, as_of);

CREATE TABLE IF NOT EXISTS gold.causal_effects (
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
    engine_type     String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, effect_id);

CREATE TABLE IF NOT EXISTS gold.recommendations (
    rec_id          String,
    investigation_id String,
    anomaly_id      String,
    tenant_id       String,
    action          String,
    lever           String,
    owner_role      String,
    expected_impact String,
    status          String DEFAULT 'proposed',
    engine_type     String DEFAULT 'rule'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, rec_id);

CREATE TABLE IF NOT EXISTS gold.insights (
    insight_id    String,
    investigation_id String,
    tenant_id     String,
    kpi_id        String,
    anomaly_id    String DEFAULT '',
    persona       String,
    generated_at  DateTime,
    trust_verdict String,
    headline      String,
    narrative     String,
    evidence      String,
    llm_breakdown String,
    confidence    Float64,
    simulated     UInt8 DEFAULT 0,
    abstained     UInt8 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1
) ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (tenant_id, persona, kpi_id, anomaly_id);

CREATE TABLE IF NOT EXISTS gold.model_runs (
    run_id        String,
    investigation_id String,
    insight_id    String DEFAULT '',
    tenant_id     String,
    stage         String,
    engine_type   String,
    model         String DEFAULT '',
    inputs_hash   String DEFAULT '',
    tokens_in     UInt32 DEFAULT 0,
    tokens_out    UInt32 DEFAULT 0,
    latency_ms    UInt32,
    cost_est_usd  Float64 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1,
    ts            DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, ts);

CREATE TABLE IF NOT EXISTS gold.outcomes (
    outcome_id String,
    investigation_id String,
    insight_id String,
    tenant_id  String,
    signal     String,
    value      String,
    actor      String,
    ts         DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, insight_id, ts);
