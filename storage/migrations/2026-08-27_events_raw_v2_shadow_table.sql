-- Phase C, step 1 of N (docs/audits/clickhouse_pipeline_implementation_prompt.md Phase C;
-- design: docs/audits/clickhouse_pipeline_audit_phase3_proposals.md, Proposal 1 Option A).
--
-- Creates the ReplacingMergeTree shadow table for events_raw. Inert on creation: nothing reads
-- from or writes to it until later, separately-confirmed steps (backfill, then a RENAME TABLE
-- swap) connect it to the live serving path. Matches the proposal doc's SQL sketch exactly --
-- 8 original columns + _inserted_at, deliberately NOT including Phase 3 proposal 2/3's five
-- columns (kafka_partition/kafka_offset/kafka_topic/ingested_at/ingest_path), since that DDL
-- (Phase B) was never approved/executed and the live events_raw does not have them either.
CREATE TABLE IF NOT EXISTS feature_intelligence.events_raw_v2 (
    event_id     String DEFAULT '',
    session_id   String DEFAULT '',
    tenant_id    String,
    event_name   String,
    user_id      String,
    channel      String,
    timestamp    DateTime,
    metadata     String,
    _inserted_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, event_name, timestamp, event_id);
