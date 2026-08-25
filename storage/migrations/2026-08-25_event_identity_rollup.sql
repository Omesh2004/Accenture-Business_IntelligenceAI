ALTER TABLE feature_intelligence.events_raw
    ADD COLUMN IF NOT EXISTS event_id String DEFAULT ''
    FIRST;

ALTER TABLE feature_intelligence.events_raw
    ADD COLUMN IF NOT EXISTS session_id String DEFAULT ''
    AFTER event_id;

CREATE TABLE IF NOT EXISTS feature_intelligence.daily_feature_usage_v2 (
    tenant_id String,
    event_name String,
    date Date,
    event_count AggregateFunction(uniqExact, String),
    unique_users AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, event_name, date);

DROP TABLE IF EXISTS feature_intelligence.mv_daily_feature_usage;

CREATE MATERIALIZED VIEW feature_intelligence.mv_daily_feature_usage
TO feature_intelligence.daily_feature_usage_v2 AS
SELECT
    tenant_id,
    event_name,
    toDate(timestamp) AS date,
    uniqExactState(if(length(event_id) > 0, event_id, concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
    uniqState(user_id) AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

INSERT INTO feature_intelligence.daily_feature_usage_v2
SELECT
    tenant_id,
    event_name,
    toDate(timestamp) AS date,
    uniqExactState(if(length(event_id) > 0, event_id, concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
    uniqState(user_id) AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

RENAME TABLE feature_intelligence.daily_feature_usage TO feature_intelligence.daily_feature_usage_old,
             feature_intelligence.daily_feature_usage_v2 TO feature_intelligence.daily_feature_usage;
