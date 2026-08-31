-- Phase C, step 1 of N (docs/audits/clickhouse_pipeline_implementation_prompt.md Phase C;
-- design: docs/audits/clickhouse_pipeline_audit_phase3_proposals.md, Proposal 1 Option A).
--
-- CORRECTED 2026-08-27 during the NexaBank telemetry audit: this file originally declared only
-- 8 original columns + _inserted_at, on the stated assumption that "Phase B [the kafka metadata
-- columns] was never approved/executed and the live events_raw does not have them either". That
-- assumption did not hold for the actual running dev volume -- reproduced live: applying this
-- file as originally written, immediately after the Phase B ALTER (which DOES apply cleanly and
-- independently), would have silently DROPPED the 5 kafka_partition/kafka_offset/kafka_topic/
-- ingested_at/ingest_path columns on swap, breaking every insert again with "Unrecognized
-- column" -- undoing Phase B in the same migration sequence that is supposed to build on it.
-- Now includes all 13 base+kafka columns + _inserted_at, matching what storage/client.py's
-- insert_events() and ingestion/main.py's direct-fallback path actually write on every insert.
--
-- Creates the ReplacingMergeTree shadow table for events_raw. Inert on creation: nothing reads
-- from or writes to it until later, separately-confirmed steps (backfill, then a RENAME TABLE
-- swap) connect it to the live serving path.
CREATE TABLE IF NOT EXISTS feature_intelligence.events_raw_v2 (
    event_id        String DEFAULT '',
    session_id      String DEFAULT '',
    tenant_id       String,
    event_name      String,
    user_id         String,
    channel         String,
    timestamp       DateTime,
    metadata        String,
    kafka_partition Int32  DEFAULT -1,
    kafka_offset    Int64  DEFAULT -1,
    kafka_topic     String DEFAULT '',
    ingested_at     DateTime DEFAULT now(),
    ingest_path     String DEFAULT '',
    _inserted_at    DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, event_name, timestamp, event_id);
