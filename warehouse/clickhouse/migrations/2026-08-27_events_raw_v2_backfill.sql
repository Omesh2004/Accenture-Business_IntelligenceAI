-- Phase C, step 3 of N (docs/audits/clickhouse_pipeline_implementation_prompt.md Phase C).
--
-- CORRECTED 2026-08-27 during the NexaBank telemetry audit, alongside the shadow-table
-- correction (see 2026-08-27_events_raw_v2_shadow_table.sql for why): the shadow table now
-- carries 13 base+kafka columns + _inserted_at, so this backfill must select all 13 source
-- columns, not the original 8 -- a bare `INSERT INTO ... SELECT` with no explicit column list
-- must match the target table's columns exactly, in order, or ClickHouse rejects it outright
-- with a column-count mismatch. events_raw already carries the 5 kafka_* columns by the time
-- this step runs (the Phase B ALTER applies first, independently), so they are real source
-- data here, not placeholders.
--
-- Backfills events_raw_v2 (created in 2026-08-27_events_raw_v2_shadow_table.sql) from the live
-- events_raw. `_inserted_at` is stamped with this query's own execution time for every
-- historical row -- there is no real original-insert-time signal in the current schema to
-- preserve instead. See docs/audits/clickhouse_pipeline_implementation_phase_c_report.md for
-- the caveat this implies for tie-breaking among any pre-existing exact-duplicate rows.
INSERT INTO feature_intelligence.events_raw_v2
SELECT
    event_id, session_id, tenant_id, event_name, user_id, channel, timestamp, metadata,
    kafka_partition, kafka_offset, kafka_topic, ingested_at, ingest_path,
    now() AS _inserted_at
FROM feature_intelligence.events_raw;
