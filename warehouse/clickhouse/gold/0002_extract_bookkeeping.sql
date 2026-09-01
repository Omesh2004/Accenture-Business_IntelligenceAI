-- ═══════════════════════════════════════════════════════════════════════════
-- gold.source_freshness / gold.ingest_watermarks — extract bookkeeping, lifted
-- verbatim from the prototype (DB name changed feature_intelligence → gold).
-- Written by pipeline/extract/*.py (Phase 3); read by the Trust Gate via the
-- Metric API's /metric/freshness. `mark_source_failed` preserves `max_source_ts`
-- so a broken source cannot look fresh.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gold.source_freshness
(
    `source_id`      String,
    `tenant_id`      String,
    `grain`          LowCardinality(String),
    `cadence`        LowCardinality(String),
    `sla_minutes`    UInt32,
    `last_loaded_at` DateTime,
    `max_source_ts`  DateTime,
    `rows_loaded`    UInt64 DEFAULT 0,
    `load_status`    LowCardinality(String) DEFAULT 'ok',
    `note`           String DEFAULT '',
    `_version`       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (source_id, tenant_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS gold.ingest_watermarks
(
    `source_id`  String,
    `entity`     String,
    `tenant_id`  String,
    `watermark`  DateTime,
    `cursor_id`  String DEFAULT '',
    `rows_seen`  UInt64 DEFAULT 0,
    `updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (source_id, entity, tenant_id)
SETTINGS index_granularity = 8192;
