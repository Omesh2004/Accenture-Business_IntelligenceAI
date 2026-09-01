-- ═══════════════════════════════════════════════════════════════════════════
-- bronze.events — raw clickstream, exactly as received. Never edited, never
-- collapsed. The audit trail and the replay source (DATA_MODEL.md § Bronze).
--
-- Engine is a PLAIN MergeTree, never Replacing: a duplicate arriving twice is
-- itself the evidence the Trust Gate reads. Silver deduplicates by event_id;
-- Bronze keeps every copy.
--
-- `_raw` is the untouched request body the ingestion API received — before
-- masking, before any envelope coercion — as compact JSON. It is the escape
-- hatch for a taxonomy-fix replay when the transform itself was wrong. Bounded:
-- ingestion caps the body at 64 KB.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE DATABASE IF NOT EXISTS bronze;

CREATE TABLE IF NOT EXISTS bronze.events (
    event_id          String,
    session_id        String DEFAULT '',
    tenant_id         String,
    event_name        String,                              -- RAW instrumented name; NOT canonicalised here
    user_id           String,
    channel           LowCardinality(String),
    timestamp         DateTime,                            -- event time (client/producer supplied, bounds-checked at ingest)
    metadata          String,                              -- metadata object as JSON
    _raw              String DEFAULT '',                   -- exact POST body, verbatim compact JSON
    _source_id        LowCardinality(String) DEFAULT 'clickstream',
    _kafka_partition  Int32 DEFAULT -1,
    _kafka_offset     Int64 DEFAULT -1,
    _kafka_topic      LowCardinality(String) DEFAULT '',
    _ingest_path      LowCardinality(String) DEFAULT '',   -- kafka | clickhouse_fallback | '' (not reported)
    _ingested_at      DateTime DEFAULT now()               -- when we received it; distinct from `timestamp`
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, event_name, timestamp, event_id)
-- Intent: cold-move partitions older than the audit window rather than delete
-- (DATA_MODEL.md). A cold-move TTL needs a storage policy that this prototype
-- volume does not configure, so a plain 6-month delete states the retention
-- intent without breaking a fresh-volume build. A prototype never reaches it.
TTL toStartOfMonth(_ingested_at) + INTERVAL 6 MONTH
SETTINGS index_granularity = 8192;
