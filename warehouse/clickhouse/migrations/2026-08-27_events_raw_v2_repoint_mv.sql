-- Phase C, step 6 of N (docs/audits/clickhouse_pipeline_implementation_prompt.md Phase C).
-- Defensive repoint of mv_daily_feature_usage after the events_raw rename-swap. Empirically
-- verified working WITHOUT this step first (see
-- docs/audits/clickhouse_pipeline_implementation_phase_c_report.md) -- done anyway per explicit
-- user choice, for self-documentation and to not depend on version-specific implicit behavior.
-- DROP+CREATE presented as one statement deliberately: no meaningful independent checkpoint
-- exists between them, so splitting would only widen the window with no MV at all.
DROP TABLE IF EXISTS feature_intelligence.mv_daily_feature_usage;

CREATE MATERIALIZED VIEW feature_intelligence.mv_daily_feature_usage
TO feature_intelligence.daily_feature_usage AS
SELECT
    tenant_id,
    event_name,
    toDate(timestamp) AS date,
    uniqExactState(if(length(event_id) > 0, event_id, concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
    uniqState(user_id) AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

-- Rebuild the rollup from scratch to close any gap the drop/create window could have opened.
TRUNCATE TABLE feature_intelligence.daily_feature_usage;
INSERT INTO feature_intelligence.daily_feature_usage
SELECT
    tenant_id,
    event_name,
    toDate(timestamp) AS date,
    uniqExactState(if(length(event_id) > 0, event_id, concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
    uniqState(user_id) AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;
