-- P1-4. Event-time windows are not reproducible on their own: the simulate console backdates
-- events into past partitions. Pin max(ingested_at) so a re-run sees what the first run saw.
ALTER TABLE feature_intelligence.investigations
    ADD COLUMN IF NOT EXISTS watermark_ingested_at DateTime DEFAULT toDateTime(0);
