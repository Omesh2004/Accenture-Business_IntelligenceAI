-- ═══════════════════════════════════════════════════════════════════════════
-- silver.events — one row per deduplicated, canonicalised event.
-- BEHAVIOURAL CONTEXT ONLY. Since DATA_MODEL.md's KPI-source revision, no KPI
-- number is derived from this table — it feeds funnel stage detail and journey
-- reconstruction. All five KPI values come from silver.fact_*.
--
-- What the Silver transform (pipeline/transforms/silver_events.py, Phase 3)
-- guarantees for every row here:
--   1. `event_name` is canonical (pipeline/taxonomy/). An unresolvable name is
--      dead-lettered (bronze.events_dead_letter, stage='silver_taxonomy_reject')
--      and never reaches this table. `event_name_raw` keeps the original.
--   2. Deduplicated by event_id — counting rows == counting distinct ids.
--   3. Masking verified; no raw identifier that bronze does not already hold.
--   4. Day pinned to one UTC definition (`event_date`).
--   5. `fabricated_dims` = metadata._simulated parsed once. The contract loader
--      refuses to localize any dimension listed here (unless dataset='seeded').
-- ═══════════════════════════════════════════════════════════════════════════
CREATE DATABASE IF NOT EXISTS silver;

CREATE TABLE IF NOT EXISTS silver.events (
    event_id        String,
    session_id      String DEFAULT '',
    tenant_id       String,
    event_name      String,                          -- canonical
    event_name_raw  String DEFAULT '',               -- the instrumented name before canonicalisation
    user_id         String,
    channel         LowCardinality(String),
    timestamp       DateTime,
    event_date      Date,                             -- toDate(timestamp) in UTC, pinned here and nowhere else
    metadata        String,                           -- masked metadata object as JSON
    fabricated_dims Array(String) DEFAULT [],         -- from metadata._simulated
    -- resolved session-invariant attributes, projected for the funnel / journey views
    device_type     LowCardinality(String) DEFAULT '',
    country         LowCardinality(String) DEFAULT '',   -- metadata.location (a country value; legacy name)
    continent       LowCardinality(String) DEFAULT '',
    city            LowCardinality(String) DEFAULT '',
    campaign        String DEFAULT '',
    _version        DateTime DEFAULT now()             -- transform run time; ReplacingMergeTree "latest wins"
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, event_name, timestamp, event_id)
SETTINGS index_granularity = 8192;
