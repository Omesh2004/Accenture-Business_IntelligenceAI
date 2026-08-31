-- Retail banking model: source A (core banking) gains branch/region and merchant classification,
-- source B (CRM + marketing) and source C (branch ops + macro) arrive as first-class tables.
--
-- Every table is ReplacingMergeTree(_version) keyed on the source's own updated_at, so a full
-- replay of any extract is idempotent rather than additive.

-- ── Source A: openings are a change feed, distinct from the balance snapshot ────────────────
CREATE TABLE IF NOT EXISTS feature_intelligence.fact_account_openings
(
    account_no       String,
    tenant_id        String,
    customer_id      String,
    account_type     LowCardinality(String),
    lifecycle_status LowCardinality(String),
    interest_rate    Decimal(9, 4) DEFAULT 0,
    branch_code      LowCardinality(String) DEFAULT '',
    region           LowCardinality(String) DEFAULT '',
    opened_at        DateTime,
    loaded_at        DateTime DEFAULT now(),
    _version         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(opened_at)
ORDER BY (tenant_id, opened_at, account_no);

CREATE TABLE IF NOT EXISTS feature_intelligence.fact_cards
(
    card_id      String,
    tenant_id    String,
    customer_id  String,
    account_no   String,
    product_name LowCardinality(String),
    card_type    LowCardinality(String),
    network      LowCardinality(String),
    status       LowCardinality(String),
    credit_limit Decimal(18, 2) DEFAULT 0,
    region       LowCardinality(String) DEFAULT '',
    issued_at    DateTime,
    loaded_at    DateTime DEFAULT now(),
    _version     DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(issued_at)
ORDER BY (tenant_id, product_name, card_id);

-- ── Source B: CRM and marketing ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_intelligence.dim_customer
(
    customer_id       String,
    tenant_id         String,
    age_bracket       LowCardinality(String) DEFAULT '',
    income_bracket    LowCardinality(String) DEFAULT '',
    employment_status LowCardinality(String) DEFAULT '',
    risk_segment      LowCardinality(String) DEFAULT '',
    lifetime_value    Decimal(18, 2) DEFAULT 0,
    kyc_status        LowCardinality(String) DEFAULT '',
    branch_code       LowCardinality(String) DEFAULT '',
    region            LowCardinality(String) DEFAULT '',
    loaded_at         DateTime DEFAULT now(),
    _version          DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, customer_id);

-- Stored as the funnel, never as a rate: a conversion rate cannot be re-aggregated across
-- segments, so CPA must be computed from counts at read time.
CREATE TABLE IF NOT EXISTS feature_intelligence.fact_campaign_interactions
(
    interaction_id   String,
    tenant_id        String,
    campaign_id      String,
    campaign_name    LowCardinality(String),
    channel          LowCardinality(String),
    customer_id      String,
    interaction_type LowCardinality(String),
    risk_segment     LowCardinality(String) DEFAULT '',
    region           LowCardinality(String) DEFAULT '',
    occurred_at      DateTime,
    loaded_at        DateTime DEFAULT now(),
    _version         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, campaign_id, interaction_type, interaction_id);

-- ── Source C: branch operations and macro environment ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_intelligence.dim_branch
(
    branch_code        String,
    tenant_id          String,
    name               String,
    region             LowCardinality(String),
    city               LowCardinality(String),
    manager_name       String,
    staffing_headcount UInt16 DEFAULT 0,
    opened_at          DateTime,
    loaded_at          DateTime DEFAULT now(),
    _version           DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, branch_code);

-- Monthly grain, regional. The external factor a deposit movement is paired against; nothing
-- here records that it IS a driver.
CREATE TABLE IF NOT EXISTS feature_intelligence.dim_macro_environment
(
    region                     LowCardinality(String),
    month_year                 LowCardinality(String),
    competitor_deposit_rate    Decimal(9, 4),
    central_bank_base_rate     Decimal(9, 4),
    regional_unemployment_rate Decimal(9, 4),
    recorded_at                DateTime,
    loaded_at                  DateTime DEFAULT now(),
    _version                   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (region, month_year);

-- ── Existing facts gain the retail dimensions ───────────────────────────────────────────────
ALTER TABLE feature_intelligence.fact_transactions
    ADD COLUMN IF NOT EXISTS branch_code LowCardinality(String) DEFAULT '' AFTER direction,
    ADD COLUMN IF NOT EXISTS region LowCardinality(String) DEFAULT '' AFTER branch_code,
    ADD COLUMN IF NOT EXISTS mcc LowCardinality(String) DEFAULT '' AFTER category,
    ADD COLUMN IF NOT EXISTS merchant_name LowCardinality(String) DEFAULT '' AFTER mcc,
    ADD COLUMN IF NOT EXISTS reference_number String DEFAULT '' AFTER merchant_name;

ALTER TABLE feature_intelligence.fact_account_daily
    ADD COLUMN IF NOT EXISTS lifecycle_status LowCardinality(String) DEFAULT '' AFTER is_active,
    ADD COLUMN IF NOT EXISTS interest_rate Decimal(9, 4) DEFAULT 0 AFTER lifecycle_status,
    ADD COLUMN IF NOT EXISTS branch_code LowCardinality(String) DEFAULT '' AFTER interest_rate,
    ADD COLUMN IF NOT EXISTS region LowCardinality(String) DEFAULT '' AFTER branch_code;
