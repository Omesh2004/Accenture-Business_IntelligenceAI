-- Phase C, step 3 of N (docs/audits/clickhouse_pipeline_implementation_prompt.md Phase C).
-- Backfills events_raw_v2 (created in 2026-08-27_events_raw_v2_shadow_table.sql) from the live
-- events_raw. `_inserted_at` is stamped with this query's own execution time for every
-- historical row -- there is no real original-insert-time signal in the current schema to
-- preserve instead. See docs/audits/clickhouse_pipeline_implementation_phase_c_report.md for
-- the caveat this implies for tie-breaking among any pre-existing exact-duplicate rows.
INSERT INTO feature_intelligence.events_raw_v2
SELECT
    event_id, session_id, tenant_id, event_name, user_id, channel, timestamp, metadata,
    now() AS _inserted_at
FROM feature_intelligence.events_raw;
