-- ═══════════════════════════════════════════════════════════════════════════
-- gold.kpi_daily / gold.kpi_daily_by_dim / gold.funnel_daily
--
-- Narrow-long rollups: a new KPI adds ROWS, never a migration. Fed from
-- silver.fact_* by pipeline/transforms/gold_kpi.py. funnel_daily is fed from
-- silver.events and carries stage detail only — never a KPI rate.
--
-- Rules (DATA_MODEL.md § "KPI rollups"):
--   1. Store additive FUNDAMENTALS, never a rate. A rate KPI stores its two
--      counts (kyc_started/kyc_completed, txn_total/txn_failed); the Metric API
--      derives the ratio at read time.
--   2. `raw_rows` (source rows as inserted) is kept alongside `value`, so the
--      duplicate storm the Trust Gate needs stays visible after Silver merges
--      duplicates away.
--
-- ENGINE = ReplacingMergeTree(_version), plain numeric columns: the transform
-- recomputes every (tenant, kpi, date, fundamental[, dimension, value_key]) row
-- wholesale each run and stamps a new `_version`, then OPTIMIZE ... FINAL
-- collapses to the latest. This is idempotent under a re-run — an
-- AggregatingMergeTree of -State columns would DOUBLE on a re-insert, which the
-- Phase 7 determinism gate (run twice, diff empty) would fail.
--
-- Money fundamentals (fee_revenue, interest_accrued, pro_revenue,
-- principal_approved) are rounded to 2dp at the write boundary by the transform.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE DATABASE IF NOT EXISTS gold;

CREATE TABLE IF NOT EXISTS gold.kpi_daily
(
    tenant_id      String,
    kpi_id         LowCardinality(String),
    date           Date,
    fundamental    LowCardinality(String),   -- accounts_opened | kyc_started | kyc_completed | loans_approved | principal_approved | txn_total | txn_failed | fee_revenue | interest_accrued | pro_revenue
    value          Float64,                  -- the additive value of this fundamental for the day (count or money)
    distinct_count UInt64 DEFAULT 0,         -- distinct source ids behind `value`; 0 where N/A (money)
    raw_rows       UInt64 DEFAULT 0,         -- source rows as inserted (replay-storm detection)
    _version       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, kpi_id, date, fundamental)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS gold.kpi_daily_by_dim
(
    tenant_id      String,
    kpi_id         LowCardinality(String),
    date           Date,
    fundamental    LowCardinality(String),
    dimension      LowCardinality(String),   -- MEASURED fact columns only: region | branch_code | country | channel | txn_type | mcc | loan_type | risk_segment | account_type
    value_key      String,                   -- the segment value within `dimension`
    value          Float64,
    distinct_count UInt64 DEFAULT 0,
    raw_rows       UInt64 DEFAULT 0,
    _version       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, kpi_id, date, fundamental, dimension, value_key)
SETTINGS index_granularity = 8192;
-- `unexplained_pct` is NOT stored — the Metric API's /metric/kpi/by_dim computes
-- it per (kpi, date, fundamental, dimension) as 1 - sum(cells)/total.

CREATE TABLE IF NOT EXISTS gold.funnel_daily
(
    tenant_id   String,
    funnel_id   LowCardinality(String),      -- kyc_funnel | txn_funnel
    date        Date,
    stage       LowCardinality(String),
    stage_order UInt8 DEFAULT 0,
    entered     UInt64 DEFAULT 0,            -- distinct sessions reaching the stage
    events      UInt64 DEFAULT 0,            -- raw events at the stage
    _version    DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, funnel_id, date, stage)
SETTINGS index_granularity = 8192;
