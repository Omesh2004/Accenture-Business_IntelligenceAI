-- ═══════════════════════════════════════════════════════════════════════════
-- silver.fact_* — the KPI carriers. Every one of the five KPI values is rolled
-- up from these tables (DATA_MODEL.md § "The five KPIs"). Derived from
-- bronze.core_banking by pipeline/transforms/silver_facts.py (Phase 3),
-- collapsed at write on `_source_updated_at` so a full replay converges.
--
--   fact_account_openings   → signups (#1)                     — accounts_opened by opened_at
--   fact_loan_applications  → kyc_completion_rate (#2)         — kyc_started / kyc_completed by kyc_step
--                             loan_approval_volume (#3)        — status='APPROVED', by DECIDED_AT
--                             interest_accrued (#4)            — principal_amount * interest_rate / 365 on approved
--   fact_transactions       → transaction_failure_rate (#5)    — txn_total / txn_failed by status
--                             fee_revenue (#4)                 — ⨝ silver.dim_fee_schedule on (txn_type, channel)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS silver.fact_transactions
(
    `txn_id`           String,
    `tenant_id`        String,
    `customer_id`      String,
    `account_no`       String,
    `counterparty_acc` String DEFAULT '',
    `direction`        LowCardinality(String) DEFAULT '',
    `branch_code`      LowCardinality(String) DEFAULT '',
    `region`           LowCardinality(String) DEFAULT '',
    `country`          LowCardinality(String) DEFAULT '',
    `txn_type`         LowCardinality(String),
    `category`         LowCardinality(String),
    `mcc`              LowCardinality(String) DEFAULT '',
    `merchant_name`    LowCardinality(String) DEFAULT '',
    `reference_number` String DEFAULT '',
    `channel`          LowCardinality(String),
    `status`           LowCardinality(String),
    `amount`           Decimal(18, 2),
    `occurred_at`      DateTime,
    `loaded_at`        DateTime DEFAULT now(),
    `_source_updated_at` DateTime DEFAULT now()             -- the version clock (source updatedOn)
)
ENGINE = ReplacingMergeTree(_source_updated_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, occurred_at, txn_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS silver.fact_loan_applications
(
    `application_id`   String,
    `tenant_id`        String,
    `customer_id`      String,
    `loan_type`        LowCardinality(String),
    `status`           LowCardinality(String),
    `principal_amount` Decimal(18, 2),
    `interest_rate`    Decimal(9, 4),
    `term_months`      UInt16,
    `kyc_step`         UInt8,
    `created_at`       DateTime,
    `decided_at`       DateTime DEFAULT toDateTime(0),      -- set only for APPROVED / REJECTED; approval volume keys on THIS
    `loaded_at`        DateTime DEFAULT now(),
    `_source_updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_source_updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, application_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS silver.fact_account_openings
(
    `account_no`       String,
    `tenant_id`        String,
    `customer_id`      String,
    `account_type`     LowCardinality(String),
    `lifecycle_status` LowCardinality(String),
    `interest_rate`    Decimal(9, 4) DEFAULT 0,
    `branch_code`      LowCardinality(String) DEFAULT '',
    `region`           LowCardinality(String) DEFAULT '',
    `country`          LowCardinality(String) DEFAULT '',
    `opened_at`        DateTime,
    `loaded_at`        DateTime DEFAULT now(),
    `_source_updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_source_updated_at)
PARTITION BY toYYYYMM(opened_at)
ORDER BY (tenant_id, opened_at, account_no)
SETTINGS index_granularity = 8192;
