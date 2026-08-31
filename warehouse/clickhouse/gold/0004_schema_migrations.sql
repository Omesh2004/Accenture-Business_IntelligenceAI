-- ═══════════════════════════════════════════════════════════════════════════
-- gold.schema_migrations — the migration ledger. warehouse/migrate.py also
-- creates this itself (LEDGER_DDL) before it can record anything; kept here so
-- a `DESCRIBE` of the gold layer is complete and the layer DDL is the single
-- authoritative description.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gold.schema_migrations
(
    `name`       String,
    `checksum`   String,
    `applied_at` DateTime DEFAULT now(),
    `ok`         UInt8 DEFAULT 1,
    `error`      String DEFAULT ''
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY name
SETTINGS index_granularity = 8192;
