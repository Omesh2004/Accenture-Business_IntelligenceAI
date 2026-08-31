-- ═══════════════════════════════════════════════════════════════════════════
-- silver.sessions — one row per session, with its resolved attributes.
-- BEHAVIOURAL CONTEXT ONLY (no KPI number). Phase-3 supporting work.
--
-- Session key = the producer's `session_id`. No 30-minute-gap inference — the
-- kyc_completion_rate contract explicitly forbids it and eventTracker.ts already
-- mints a stable per-session id. Rows with session_id = '' never reach here.
--
-- Recomputed wholesale per session by pipeline/transforms/silver_sessions.py
-- (Phase 3) and replaced by `_version`, so plain columns are idempotent under a
-- replay — no aggregate-state decay concern (that applies to AggregatingMergeTree).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS silver.sessions (
    tenant_id        String,
    session_id       String,
    user_id          String DEFAULT '',              -- first non-anon user_id in the session, else the anon key
    started_at       DateTime,
    ended_at         DateTime,
    event_count      UInt32 DEFAULT 0,
    distinct_events  UInt32 DEFAULT 0,
    entry_event      String DEFAULT '',
    exit_event       String DEFAULT '',
    channel          LowCardinality(String) DEFAULT '',
    device_type      LowCardinality(String) DEFAULT '',
    country          LowCardinality(String) DEFAULT '',   -- metadata.location
    continent        LowCardinality(String) DEFAULT '',
    city             LowCardinality(String) DEFAULT '',
    campaign         String DEFAULT '',
    fabricated_dims  Array(String) DEFAULT [],            -- session-level union of silver.events.fabricated_dims
    is_suspected_bot UInt8 DEFAULT 0,
    _version         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, session_id)
SETTINGS index_granularity = 8192;
