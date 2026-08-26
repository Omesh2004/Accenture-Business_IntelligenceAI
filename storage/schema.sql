CREATE DATABASE IF NOT EXISTS feature_intelligence;

-- Raw Events Table
-- Using MergeTree and ordering by tenant_id first guarantees data locality per tenant, optimizing multi-tenant queries.
CREATE TABLE IF NOT EXISTS feature_intelligence.events_raw (
    event_id String DEFAULT '',
    session_id String DEFAULT '',
    tenant_id String,
    event_name String,
    user_id String,
    channel String,
    timestamp DateTime,
    metadata String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, event_name, timestamp)
SETTINGS index_granularity = 8192;

-- Pre-aggregated Daily Feature Usage Table
-- This is useful for fast dashboard loading where we only need counts.
CREATE TABLE IF NOT EXISTS feature_intelligence.daily_feature_usage (
    tenant_id String,
    event_name String,
    date Date,
    event_count AggregateFunction(uniqExact, String),
    unique_users AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, event_name, date);

-- Materialized View to automatically populate daily_feature_usage from events_raw
CREATE MATERIALIZED VIEW IF NOT EXISTS feature_intelligence.mv_daily_feature_usage
TO feature_intelligence.daily_feature_usage AS
SELECT
    tenant_id,
    event_name,
    toDate(timestamp) AS date,
    uniqExactState(if(length(event_id) > 0, event_id, concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
    uniqState(user_id) AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

-- ═══════════════════════════════════════════════════════════
-- Dead-letter queue for the processor worker.
-- processing/worker.py inserts in batches and commits Kafka offsets only after a successful
-- insert. A single un-insertable row therefore failed its ENTIRE batch, forever: offsets
-- never advanced, the batch was retried every poll, and the pipeline stalled silently with
-- no signal anywhere. Rows that fail on their own are parked here instead, so one bad event
-- cannot block every good one behind it -- and is still recoverable rather than dropped.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feature_intelligence.events_dead_letter (
    event_id    String DEFAULT '',
    tenant_id   String DEFAULT '',
    event_name  String DEFAULT '',
    payload     String,             -- the original Kafka message, verbatim JSON
    error       String,             -- the exception this row failed with
    failed_at   DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(failed_at)
ORDER BY (tenant_id, failed_at);

-- ═══════════════════════════════════════════════════════════
-- Tenant Feature Licenses
-- Tracks which features each tenant has paid for.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feature_intelligence.tenant_licenses (
    tenant_id String,
    feature_name String,
    is_licensed UInt8 DEFAULT 1,
    plan_tier String DEFAULT 'pro',
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, feature_name);

-- ═══════════════════════════════════════════════════════════
-- Admin Tracking Toggles
-- Allows admins to enable/disable tracking per feature.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feature_intelligence.tracking_toggles (
    tenant_id String,
    feature_name String,
    is_enabled UInt8 DEFAULT 1,
    changed_by String DEFAULT '',
    changed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(changed_at)
ORDER BY (tenant_id, feature_name);

-- ═══════════════════════════════════════════════════════════
-- Configuration Audit Log
-- Records who changed which system setting and when.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feature_intelligence.config_audit_log (
    tenant_id String,
    actor_email String,
    action String,
    target String,
    old_value String DEFAULT '',
    new_value String DEFAULT '',
    timestamp DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp);

-- ═══════════════════════════════════════════════════════════
-- AI Reports Storage
-- Stores generated AI reports per tenant.
-- ReplacingMergeTree ensures only the latest report is kept
-- per tenant after background merges.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS feature_intelligence.ai_reports (
    tenant_id String,
    generated_by String DEFAULT '',
    report String,
    insights String DEFAULT '[]',
    generated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (tenant_id);

-- ═══════════════════════════════════════════════════════════
-- Signal Store (Phase 1 intelligence pipeline)
-- Small demo tables -- ORDER BY is enough, no partitioning needed. All findings are written
-- here; the narrator may state only what these tables contain.
--
-- The investigation spine: every table is joined by investigation_id, minted once when a run
-- starts and threaded through every write. Do NOT hang the audit trail off anomaly_id -- Trust
-- Gate can fail before any anomaly exists (scenario 1's incident note has none), and model_runs
-- is written by stages that run before an insight exists. `forecasts` is the one exception: it
-- is produced by a scheduled batch, not an investigation, and carries its own forecast_id,
-- referenced by anomalies.forecast_id. See docs/DATABASE.md.
-- ═══════════════════════════════════════════════════════════

-- Stage 00. The run itself. One row per investigation, created before any stage executes.
CREATE TABLE IF NOT EXISTS feature_intelligence.investigations (
    investigation_id String,
    tenant_id        String,
    kpi_id           String,
    window_start     DateTime,
    window_end       DateTime,
    trigger          String,            -- 'scheduled' | 'manual' | 'ping'
    status           String,            -- 'running'|'completed'|'terminated'|'error'
    terminal_stage   String DEFAULT '', -- where it stopped: 'trust_gate'|'detect'|'narrate'
    termination_reason String DEFAULT '',-- 'not_instrumented'|'defect'|'ambiguous'|'immaterial'
    dataset          String,            -- 'seeded' | 'live'  -- no gate passes on seeded data
    started_at       DateTime,
    ended_at         DateTime DEFAULT toDateTime(0)
) ENGINE = ReplacingMergeTree(started_at)
ORDER BY (tenant_id, kpi_id, investigation_id);

-- Stage 01. Trust Gate verdicts. Written on EVERY run, including passes -- stage 08 audits the
-- suppression rate, and a defect that blocks narration must leave a row behind.
CREATE TABLE IF NOT EXISTS feature_intelligence.trust_findings (
    finding_id       String,
    investigation_id String,           -- the spine; see note above
    tenant_id        String,
    kpi_id           String,
    window_start     DateTime,
    window_end       DateTime,
    verdict          String,            -- 'pass' | 'fail' | 'ambiguous'
    check_id         String,            -- contract hard_invariants / soft_invariants id
    fingerprint      String DEFAULT '', -- contract defect_fingerprints id
    observed         String,            -- JSON: what the check actually saw
    expected         String,            -- JSON: what the contract required
    cheapest_check   String DEFAULT '', -- required when verdict = 'ambiguous'
    blocks_narrative UInt8 DEFAULT 0,
    engine_type      String DEFAULT 'rule',
    ts               DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ts)
ORDER BY (tenant_id, kpi_id, window_start, check_id);

-- Stage 02. The detected move. One row per (tenant, kpi, window, method).
CREATE TABLE IF NOT EXISTS feature_intelligence.anomalies (
    anomaly_id   String,
    investigation_id String,            -- hash(tenant_id, kpi_id, window_start, method)
    tenant_id    String,
    kpi_id       String,            -- matches a contract id in contracts/*.yaml
    detected_at  DateTime,
    window_start DateTime,
    window_end   DateTime,
    method       String,            -- 'mad' | 'seasonal_residual' | 'rule'
    direction    Int8,              -- -1 drop, +1 spike, 0 categorical
    magnitude    Float64,           -- signed effect size
    baseline     Float64,           -- from the stored forecast band where one exists
    observed     Float64,
    forecast_id  String DEFAULT '', -- the band this was scored against (stage 04)
    materiality  Float64,           -- significance x impact x persistence
    severity     String,            -- 'info' | 'warn' | 'urgent'
    status       String DEFAULT 'open',   -- open|investigating|explained|dismissed
    engine_type  String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree(detected_at)
ORDER BY (tenant_id, kpi_id, window_start);

-- Stage 03. Ranked localization. Contributions sum to ~1 across ranks -- which is only
-- meaningful because the fundamental is additive at the contract's grain.entity.
CREATE TABLE IF NOT EXISTS feature_intelligence.root_causes (
    cause_id      String,
    investigation_id String,
    anomaly_id    String,
    tenant_id     String,
    rank          UInt8,
    dimensions    String,           -- JSON: {"device_type":"mobile","location":"India"}
    fundamental   String,           -- which additive fundamental was decomposed
    contribution  Float64,
    method        String,           -- 'greedy_cube' | 'groupby'
    explained_pct Float64,
    engine_type   String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, rank);

-- Stage 04. Runs as a SCHEDULED BATCH, ahead of Detect. Stage 02 scores residuals against the
-- band stored here; this is not a sparse-history-only table.
CREATE TABLE IF NOT EXISTS feature_intelligence.forecasts (
    forecast_id   String,
    tenant_id     String,
    kpi_id        String,
    as_of         DateTime,
    horizon_days  UInt16,
    point         Float64,
    lower         Float64,
    upper         Float64,
    method        String,            -- 'seasonal_naive' | 'rolling_median' | 'category_prior'
    confidence    Float64,
    backtest_mase Float64 DEFAULT 0, -- vs seasonal-naive; 0 = not backtested
    caveat        String DEFAULT '', -- 'insufficient_history'
    engine_type   String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree(as_of)
ORDER BY (tenant_id, kpi_id, as_of);

-- Stage 05. Causal impact. `rung` is mandatory; a point estimate without an interval is not a
-- Phase 1 causal result.
CREATE TABLE IF NOT EXISTS feature_intelligence.causal_effects (
    effect_id       String,
    investigation_id String,
    anomaly_id      String,
    tenant_id       String,
    kpi_id          String,
    intervention    String,           -- contract causal.interventions id
    rung            String,           -- association|attribution|corroborated_cause|estimated_effect
    effect_point    Float64,
    effect_lower    Float64,
    effect_upper    Float64,
    method          String,           -- 'pre_post' | 'control_segment' | 'rule'
    assumptions_met UInt8 DEFAULT 1,
    degraded_reason String DEFAULT '',
    engine_type     String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, effect_id);

-- Stage 06. Rules-based recommendation. Impact is an interval, never a point.
CREATE TABLE IF NOT EXISTS feature_intelligence.recommendations (
    rec_id          String,
    investigation_id String,
    anomaly_id      String,
    tenant_id       String,
    action          String,
    lever           String,          -- must be in the contract's decision.allowed_levers
    owner_role      String,
    expected_impact String,          -- JSON: {"low":..,"high":..}
    status          String DEFAULT 'proposed',
    engine_type     String DEFAULT 'rule'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, rec_id);

-- Stage 07. The narrated output. One row per (tenant, persona, anomaly).
CREATE TABLE IF NOT EXISTS feature_intelligence.insights (
    insight_id    String,
    investigation_id String,
    tenant_id     String,
    kpi_id        String,
    anomaly_id    String DEFAULT '', -- empty when Trust Gate failed: an incident note has no anomaly
    persona       String,           -- 'cfo' | 'ops_manager' | 'default'
    generated_at  DateTime,
    trust_verdict String,           -- copied from trust_findings; 'fail' => incident note
    headline      String,
    narrative     String,
    evidence      String,           -- JSON array: {metric_id, source, as_of, method,
                                    --             contribution, confidence, lineage_ref}
    llm_breakdown String,           -- JSON: which numbers came from which engine
    confidence    Float64,
    simulated     UInt8 DEFAULT 0,  -- any figure sourced from a contract `simulated:` block
    abstained     UInt8 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1
) ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (tenant_id, persona, anomaly_id);

-- Stage 08. Per-run telemetry. The LLM-vs-non-LLM breakdown reads from here.
CREATE TABLE IF NOT EXISTS feature_intelligence.model_runs (
    run_id        String,
    investigation_id String,           -- ALWAYS set; stages run before an insight exists
    insight_id    String DEFAULT '', -- set only once Narrate has produced one
    tenant_id     String,
    stage         String,           -- trust_gate|detect|localize|forecast|causal|decide|narrate
    engine_type   String,           -- 'llm'|'sql'|'stats'|'ml'|'rule'
    model         String DEFAULT '',-- 'qwen2.5-3b-awq' or ''
    inputs_hash   String DEFAULT '',
    tokens_in     UInt32 DEFAULT 0,
    tokens_out    UInt32 DEFAULT 0,
    latency_ms    UInt32,
    cost_est_usd  Float64 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1,
    ts            DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, ts);

-- Stage 08. Human feedback loop. Never train a policy on un-audited output.
CREATE TABLE IF NOT EXISTS feature_intelligence.outcomes (
    outcome_id String,
    investigation_id String,
    insight_id String,
    tenant_id  String,
    signal     String,               -- 'root_cause_correct'|'useful'|'action_taken'
    value      String,               -- 'yes'|'no'|'partial'|rating
    actor      String,
    ts         DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, insight_id, ts);
