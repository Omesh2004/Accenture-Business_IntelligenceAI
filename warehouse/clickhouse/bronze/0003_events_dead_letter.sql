-- ═══════════════════════════════════════════════════════════════════════════
-- bronze.events_dead_letter — one row per event that failed the pipeline, from
-- any stage. Carried over from the prototype; the only change is a new `stage`
-- value, `silver_taxonomy_reject`, for a name the Silver transform could not
-- resolve to the canonical vocabulary (plan §3.2). The row stays replayable
-- from bronze.events.
--
--   stage:
--     ingest_validation      — failed FeatureEvent shape/bounds check, never reached Kafka
--     worker_poison          — reached Kafka, failed to insert into bronze.events
--     silver_taxonomy_reject — unresolvable event_name; not propagated to silver.events
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bronze.events_dead_letter (
    event_id   String   DEFAULT '',
    tenant_id  String   DEFAULT '',
    event_name String   DEFAULT '',
    payload    String,                              -- the original message / rejected body, verbatim JSON
    error      String,                              -- the exception or validation errors this row failed with
    stage      LowCardinality(String) DEFAULT 'worker_poison',
    failed_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(failed_at)
ORDER BY (tenant_id, failed_at);
