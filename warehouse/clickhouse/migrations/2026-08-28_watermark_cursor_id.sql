-- ingest_watermarks.cursor_id: the second half of the extract cursor.
--
-- The cursor was timestamp-only, so a page boundary falling among rows that share a timestamp
-- dropped the remainder permanently. Resuming needs (timestamp, id); this stores the id.
ALTER TABLE feature_intelligence.ingest_watermarks
    ADD COLUMN IF NOT EXISTS cursor_id String DEFAULT '' AFTER watermark;
