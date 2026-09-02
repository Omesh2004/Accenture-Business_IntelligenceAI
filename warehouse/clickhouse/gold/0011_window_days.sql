-- The window a finding was scored over becomes part of its identity.
-- Everything was swept at 7 days, so a reader asking about 30 or 90 got the 7-day answer with no
-- sign that the question had been ignored. Findings for different windows also collapsed onto one
-- another in the sort key, so which one survived was arbitrary.
ALTER TABLE gold.anomalies ADD COLUMN IF NOT EXISTS window_days UInt16 DEFAULT 7;

CREATE TABLE IF NOT EXISTS gold.insights_v2 (
    insight_id    String,
    investigation_id String,
    tenant_id     String,
    kpi_id        String,
    anomaly_id    String DEFAULT '',
    persona       String,
    window_days   UInt16 DEFAULT 7,
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
ORDER BY (tenant_id, persona, kpi_id, window_days, anomaly_id);

INSERT INTO gold.insights_v2 (insight_id, investigation_id, tenant_id, kpi_id, anomaly_id,
    persona, window_days, generated_at, trust_verdict, headline, narrative, evidence,
    llm_breakdown, confidence, simulated, abstained, verifier_pass)
SELECT insight_id, investigation_id, tenant_id, kpi_id, anomaly_id, persona, 7, generated_at,
       trust_verdict, headline, narrative, evidence, llm_breakdown, confidence, simulated,
       abstained, verifier_pass
FROM gold.insights FINAL;

DROP TABLE gold.insights;
RENAME TABLE gold.insights_v2 TO gold.insights;
