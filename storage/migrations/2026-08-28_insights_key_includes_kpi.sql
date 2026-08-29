-- insights: the ReplacingMergeTree key must include kpi_id.
--
-- The key was (tenant_id, persona, anomaly_id). `anomaly_id` is empty whenever a KPI did not move,
-- which is the common case -- so every no-anomaly narrative for a persona collapsed onto one row.
-- A sweep over 50 KPIs left 1 insight per persona and silently discarded the other 49. Nothing
-- errored; the rows were simply replaced, and the dashboard could never show more than one
-- "no material movement" card per persona no matter how many KPIs were investigated.
--
-- ORDER BY cannot be altered in place, so the table is rebuilt. Its contents are derived state:
-- a sweep regenerates them, and every id is deterministic, so nothing unique is lost.

CREATE TABLE IF NOT EXISTS feature_intelligence.insights_v2
(
    insight_id       String,
    investigation_id String,
    tenant_id        String,
    kpi_id           String,
    anomaly_id       String DEFAULT '',
    persona          String,
    generated_at     DateTime,
    trust_verdict    String,
    headline         String,
    narrative        String,
    evidence         String,
    llm_breakdown    String,
    confidence       Float64,
    simulated        UInt8 DEFAULT 0,
    abstained        UInt8 DEFAULT 0,
    verifier_pass    UInt8 DEFAULT 1
)
ENGINE = ReplacingMergeTree(generated_at)
-- kpi_id before anomaly_id: one row per (tenant, persona, KPI), and a KPI that moves more than
-- once in a window still separates on anomaly_id.
ORDER BY (tenant_id, persona, kpi_id, anomaly_id);

INSERT INTO feature_intelligence.insights_v2 SELECT * FROM feature_intelligence.insights;

RENAME TABLE feature_intelligence.insights TO feature_intelligence.insights_old,
             feature_intelligence.insights_v2 TO feature_intelligence.insights;

DROP TABLE IF EXISTS feature_intelligence.insights_old;
