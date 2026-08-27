-- Phase C, step 5 of N (docs/audits/clickhouse_pipeline_implementation_prompt.md Phase C).
-- The rename-swap itself, following the exact precedent in
-- storage/migrations/2026-08-25_event_identity_rollup.sql. Row-count and content-checksum
-- parity between events_raw and events_raw_v2 were verified equal before this statement was
-- approved -- see docs/audits/clickhouse_pipeline_implementation_phase_c_report.md.
--
-- Rollback (written before this ran, not after):
--   RENAME TABLE feature_intelligence.events_raw TO feature_intelligence.events_raw_v2_rollback,
--                feature_intelligence.events_raw_old TO feature_intelligence.events_raw;
RENAME TABLE feature_intelligence.events_raw    TO feature_intelligence.events_raw_old,
             feature_intelligence.events_raw_v2 TO feature_intelligence.events_raw;
