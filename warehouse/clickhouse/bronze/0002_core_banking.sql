-- ═══════════════════════════════════════════════════════════════════════════
-- bronze.core_banking — one row per extracted record, per entity, from the
-- daily banking snapshot (`GET /api/extract/{entity}`). The landing copy so
-- silver facts re-derive without re-hitting NexaBank (plan §3.4).
--
-- Plain MergeTree. Multiple extracted versions of the same record_id coexist
-- as separate rows — silver_facts.py collapses them by `_source_updated_at`.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bronze.core_banking (
    record_id          String,                             -- txn_id | application_id | account_no | customer_id | branch_code | campaign_id | calendar_date | (txn_type|channel)
    entity             LowCardinality(String),             -- transactions | loan_applications | accounts | customers | campaigns | branches | calendar | fee_schedule
    tenant_id          String,
    _source_id         LowCardinality(String),             -- nexabank_core | nexabank_crm | market_ops | reference_data
    _extracted_at      DateTime,                            -- when this batch ran
    _source_updated_at DateTime,                            -- the record's own updatedOn / occurredAt — the version clock
    _page_watermark    DateTime DEFAULT toDateTime(0),      -- the (watermark, cursor_id) the row was fetched under,
    _page_cursor_id    String   DEFAULT '',                 --   for page-boundary reconciliation
    _raw               String,                              -- the JSON record verbatim from the extract API
    _ingested_at       DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(_extracted_at)
ORDER BY (tenant_id, entity, record_id, _source_updated_at)
SETTINGS index_granularity = 8192;
