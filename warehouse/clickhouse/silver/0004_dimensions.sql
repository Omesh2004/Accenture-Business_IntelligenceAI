-- ═══════════════════════════════════════════════════════════════════════════
-- silver.dim_* — the measured segment dimensions Localize is allowed to slice,
-- plus the revenue price side and the calendar. Derived from bronze.core_banking
-- (dim_customer / dim_branch / dim_campaign) or from reference data
-- (dim_fee_schedule / dim_calendar — synthesised by Track B today, see D8).
--
-- Dropped from the prototype and NOT recreated here: dim_macro_environment
-- (net-deposit / external-rate driver, not in the 5-KPI chain).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS silver.dim_customer
(
    `customer_id`       String,
    `tenant_id`         String,
    `age_bracket`       LowCardinality(String) DEFAULT '',
    `income_bracket`    LowCardinality(String) DEFAULT '',
    `employment_status` LowCardinality(String) DEFAULT '',
    `risk_segment`      LowCardinality(String) DEFAULT '',
    `lifetime_value`    Decimal(18, 2) DEFAULT 0,
    `kyc_status`        LowCardinality(String) DEFAULT '',
    `branch_code`       LowCardinality(String) DEFAULT '',
    `region`            LowCardinality(String) DEFAULT '',
    `country`           LowCardinality(String) DEFAULT '',
    `loaded_at`         DateTime DEFAULT now(),
    `_source_updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_source_updated_at)
ORDER BY (tenant_id, customer_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS silver.dim_branch
(
    `branch_code`        String,
    `tenant_id`          String,
    `name`               String,
    `region`             LowCardinality(String),
    `country`            LowCardinality(String) DEFAULT '',
    `city`               LowCardinality(String),
    `manager_name`       String,
    `staffing_headcount` UInt16 DEFAULT 0,
    `opened_at`          DateTime,
    `loaded_at`          DateTime DEFAULT now(),
    `_source_updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_source_updated_at)
ORDER BY (tenant_id, branch_code)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS silver.dim_campaign
(
    `campaign_id` String,
    `tenant_id`   String,
    `name`        String,
    `channel`     LowCardinality(String),
    `segment`     String DEFAULT '',
    `start_date`  Date,
    `end_date`    Date,
    `spend`       Decimal(18, 2) DEFAULT 0,
    `_source_updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_source_updated_at)
ORDER BY (tenant_id, campaign_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS silver.dim_calendar
(
    `calendar_date` Date,
    `tenant_id`     String,
    `is_holiday`    UInt8 DEFAULT 0,
    `is_weekend`    UInt8 DEFAULT 0,
    `is_month_end`  UInt8 DEFAULT 0,
    `season`        LowCardinality(String) DEFAULT '',
    `label`         String DEFAULT '',
    `_version`      DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, calendar_date)
SETTINGS index_granularity = 8192;

-- Price side of fee_revenue. One row per (txn_type, channel) the bank transacts
-- on; a channel with no row earns no fee and silently vanishes from revenue.
-- NOTE (Phase 3): `txn_type` / `channel` casing must be reconciled against
-- silver.fact_transactions or the join drops rows — flagged in
-- docs/INTERFACES/kpi_rollups.md and the Phase 0 report.
CREATE TABLE IF NOT EXISTS silver.dim_fee_schedule
(
    `tenant_id`  String,
    `txn_type`   LowCardinality(String),
    `channel`    LowCardinality(String),
    `fee_flat`   Decimal(18, 2),
    `fee_pct`    Decimal(9, 4),
    `valid_from` Date,
    `valid_to`   Date DEFAULT toDate('2099-12-31'),
    `_version`   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, txn_type, channel, valid_from)
SETTINGS index_granularity = 8192;
