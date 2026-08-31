-- Phase D1 (docs/audits/clickhouse_pipeline_implementation_phases_defg_prompt.md).
-- Closes Phase A's pending DDL: events_dead_letter did not exist on this live volume at all
-- (discovered during Phase A verification -- see
-- docs/audits/clickhouse_pipeline_implementation_phase_a_report.md). Both writers
-- (processing/worker.py's _dead_letter, ingestion/main.py's _dead_letter_validation_failure)
-- have already been coded against this exact shape since Phase A/B.
CREATE TABLE IF NOT EXISTS feature_intelligence.events_dead_letter (
    event_id    String DEFAULT '',
    tenant_id   String DEFAULT '',
    event_name  String DEFAULT '',
    payload     String,
    error       String,
    stage       String DEFAULT 'worker_poison',
    failed_at   DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(failed_at)
ORDER BY (tenant_id, failed_at);
