-- P0-6. Canonicalise once at ingest instead of in every reader.
-- ORDER MATTERS: the MV binds its target by name at creation, so rename before creating it.

ALTER TABLE feature_intelligence.events_raw
    ADD COLUMN IF NOT EXISTS event_name_canonical String DEFAULT '';

CREATE TABLE IF NOT EXISTS feature_intelligence.daily_feature_usage_v4 (
    tenant_id    String,
    event_name   String,
    date         Date,
    event_count  AggregateFunction(uniqExact, String),
    unique_users AggregateFunction(uniqExact, String),
    raw_rows     AggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, event_name, date);

INSERT INTO feature_intelligence.daily_feature_usage_v4
SELECT tenant_id,
       if(length(event_name_canonical) > 0, event_name_canonical, event_name) AS event_name,
       toDate(timestamp) AS date,
       uniqExactState(if(length(event_id) > 0, event_id,
           concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))),
       uniqExactState(user_id),
       sumState(toUInt64(1))
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

RENAME TABLE feature_intelligence.daily_feature_usage    TO feature_intelligence.daily_feature_usage_pre_canonical,
             feature_intelligence.daily_feature_usage_v4 TO feature_intelligence.daily_feature_usage;

DROP TABLE IF EXISTS feature_intelligence.mv_daily_feature_usage;

CREATE MATERIALIZED VIEW feature_intelligence.mv_daily_feature_usage
TO feature_intelligence.daily_feature_usage AS
SELECT
    tenant_id,
    if(length(event_name_canonical) > 0, event_name_canonical, event_name) AS event_name,
    toDate(timestamp) AS date,
    uniqExactState(if(length(event_id) > 0, event_id,
        concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
    uniqExactState(user_id) AS unique_users,
    sumState(toUInt64(1))   AS raw_rows
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;
