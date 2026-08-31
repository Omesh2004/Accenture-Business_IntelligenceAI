-- D1 + P0-6. Two changes to daily_feature_usage, applied together because both rebuild the MV.
--
-- 1. raw_rows: sumState(1) counts rows as INSERTED. A materialized view never sees post-merge
--    state, so this survives the ReplacingMergeTree merges that erase a worker replay from
--    events_raw -- which is what makes dedup_integrity detectable again (docs/PROPOSAL.md D1).
-- 2. unique_users becomes uniqExact: `uniq` is HyperLogLog and cannot be read by a deterministic
--    stage (CLAUDE.md rule 12).
--
-- ORDER MATTERS: rename BEFORE creating the MV. An MV binds to its target by name at creation,
-- so creating it first and renaming after leaves it pointing at a table that no longer exists --
-- every insert then fails with UNKNOWN_TABLE and the worker dead-letters the batch.

CREATE TABLE IF NOT EXISTS feature_intelligence.daily_feature_usage_v3 (
    tenant_id    String,
    event_name   String,
    date         Date,
    event_count  AggregateFunction(uniqExact, String),
    unique_users AggregateFunction(uniqExact, String),
    raw_rows     AggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, event_name, date);

-- Backfill history from events_raw. On a live volume this under-counts raw_rows for any replay
-- already merged away -- unavoidable, and only affects windows predating this migration.
INSERT INTO feature_intelligence.daily_feature_usage_v3
SELECT tenant_id, event_name, toDate(timestamp) AS date,
       uniqExactState(if(length(event_id) > 0, event_id,
           concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))),
       uniqExactState(user_id),
       sumState(toUInt64(1))
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

RENAME TABLE feature_intelligence.daily_feature_usage    TO feature_intelligence.daily_feature_usage_old,
             feature_intelligence.daily_feature_usage_v3 TO feature_intelligence.daily_feature_usage;

DROP TABLE IF EXISTS feature_intelligence.mv_daily_feature_usage;

CREATE MATERIALIZED VIEW feature_intelligence.mv_daily_feature_usage
TO feature_intelligence.daily_feature_usage AS
SELECT
    tenant_id,
    event_name,
    toDate(timestamp) AS date,
    uniqExactState(if(length(event_id) > 0, event_id,
        concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
    uniqExactState(user_id) AS unique_users,
    sumState(toUInt64(1))   AS raw_rows
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;
