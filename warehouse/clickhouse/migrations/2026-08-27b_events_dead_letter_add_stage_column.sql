-- Correction discovered during the NexaBank telemetry audit (2026-08-27), applied AFTER
-- 2026-08-27_events_dead_letter_table.sql in filename order (the 'b' suffix keeps it sorted
-- immediately after that file rather than needing a new date).
--
-- 2026-08-27_events_dead_letter_table.sql is `CREATE TABLE IF NOT EXISTS ... stage String
-- DEFAULT 'worker_poison' ...`. On any volume where events_dead_letter already existed in its
-- PRE-Phase-D3 shape (no `stage` column -- the shape storage/schema.sql declared before this
-- audit), `IF NOT EXISTS` makes that CREATE TABLE statement a complete no-op: the table is not
-- altered, `stage` is never added, and every write from ingestion/main.py's
-- _dead_letter_validation_failure() or processing/worker.py's _dead_letter() (both of which
-- pass a `stage` value unconditionally) fails with "Unrecognized column 'stage'".
--
-- Reproduced live: a probe event that failed to insert into events_raw (the Phase C schema gap
-- this same audit found and fixed) ALSO failed to reach the dead-letter table for this exact
-- reason -- the event was lost with zero trace anywhere, not even a replayable DLQ row. This
-- ALTER is what the original migration file should have been for an already-existing table.
ALTER TABLE feature_intelligence.events_dead_letter
    ADD COLUMN IF NOT EXISTS stage String DEFAULT 'worker_poison';
