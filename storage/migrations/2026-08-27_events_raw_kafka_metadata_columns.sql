-- Phase D2 (docs/audits/clickhouse_pipeline_implementation_phases_defg_prompt.md).
-- Closes Phase B's pending DDL. Confirmed via SHOW CREATE TABLE (Phase D Step 0) that this
-- lands on the POST-Phase-C table -- ReplacingMergeTree(_inserted_at),
-- ORDER BY (tenant_id, event_name, timestamp, event_id) -- not the original plain MergeTree
-- (now events_raw_old). Plain ADD COLUMN is additive/metadata-only and does not touch ORDER BY
-- or the version column; none of these five columns are part of the sorting key or version
-- column. `ingested_at` (plain audit column, added here) and `_inserted_at` (the actual
-- ReplacingMergeTree version column, already live since Phase C) are two distinct columns.
--
-- ingest_path DEFAULT '' (not 'kafka') -- see
-- docs/audits/clickhouse_pipeline_implementation_phase_b_report.md for why: api/seed_safexbank.py
-- is a third insert site that never touches Kafka, and this repo has a documented historical
-- period where ingestion ran entirely on the fallback path with no signal.
ALTER TABLE feature_intelligence.events_raw ADD COLUMN IF NOT EXISTS kafka_partition Int32  DEFAULT -1;
ALTER TABLE feature_intelligence.events_raw ADD COLUMN IF NOT EXISTS kafka_offset    Int64  DEFAULT -1;
ALTER TABLE feature_intelligence.events_raw ADD COLUMN IF NOT EXISTS kafka_topic     String DEFAULT '';
ALTER TABLE feature_intelligence.events_raw ADD COLUMN IF NOT EXISTS ingested_at     DateTime DEFAULT now();
ALTER TABLE feature_intelligence.events_raw ADD COLUMN IF NOT EXISTS ingest_path     String DEFAULT '';
