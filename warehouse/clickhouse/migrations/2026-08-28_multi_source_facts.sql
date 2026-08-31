-- Round 2: a second and third data source, at grains and cadences the clickstream does not have.
--
-- Money is Decimal64(2), never Float: binary floats cannot represent 0.10 exactly, so a sum of
-- amounts drifts and `revenue == sum(price * qty)` fails for reasons that have nothing to do
-- with the business. This is the invariant docs/PHASE_1.md calls vacuously true today.
--
-- Core-banking facts MUTATE (an application moves PENDING -> APPROVED), unlike append-only
-- telemetry. ReplacingMergeTree(_version) keeps the latest state per key; `_version` is the
-- source system's own updated_at, so a replayed batch converges instead of duplicating.

-- ── Source 2: nexabank_core (batch) ─────────────────────────────────────────

-- Transaction grain. The only place real money exists.
CREATE TABLE IF NOT EXISTS feature_intelligence.fact_transactions (
    txn_id           String,
    tenant_id        String,
    customer_id      String,
    account_no       String,
    counterparty_acc String DEFAULT '',
    txn_type         LowCardinality(String),
    category         LowCardinality(String),
    channel          LowCardinality(String),
    status           LowCardinality(String),
    amount           Decimal64(2),
    occurred_at      DateTime,
    loaded_at        DateTime DEFAULT now(),
    _version         DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, occurred_at, txn_id);

-- Application grain, carrying the OUTCOME the clickstream cannot see.
CREATE TABLE IF NOT EXISTS feature_intelligence.fact_loan_applications (
    application_id   String,
    tenant_id        String,
    customer_id      String,
    loan_type        LowCardinality(String),
    status           LowCardinality(String),
    principal_amount Decimal64(2),
    interest_rate    Decimal32(4),
    term_months      UInt16,
    kyc_step         UInt8,
    created_at       DateTime,
    decided_at       DateTime DEFAULT toDateTime(0),
    loaded_at        DateTime DEFAULT now(),
    _version         DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, application_id);

-- Disbursed loans: principal, rate and term -- the factors net interest income decomposes into.
CREATE TABLE IF NOT EXISTS feature_intelligence.fact_loans (
    loan_id          String,
    tenant_id        String,
    account_no       String,
    loan_type        LowCardinality(String),
    principal_amount Decimal64(2),
    interest_amount  Decimal64(2),
    interest_rate    Decimal32(4),
    term_months      UInt16,
    due_amount       Decimal64(2),
    is_active        UInt8 DEFAULT 1,
    started_at       DateTime,
    loaded_at        DateTime DEFAULT now(),
    _version         DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(started_at)
ORDER BY (tenant_id, loan_id);

-- Account-DAY snapshot: a third grain and a third cadence. A snapshot must never be summed
-- across dates -- that is the classic error the semantic-layer benchmarks call out.
CREATE TABLE IF NOT EXISTS feature_intelligence.fact_account_daily (
    snapshot_date Date,
    tenant_id     String,
    account_no    String,
    customer_id   String,
    account_type  LowCardinality(String),
    balance       Decimal64(2),
    is_active     UInt8,
    loaded_at     DateTime DEFAULT now(),
    _version      DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(snapshot_date)
ORDER BY (tenant_id, snapshot_date, account_no);

-- ── Source 3: reference_data (slow-changing) ────────────────────────────────

-- Fee schedule: the PRICE side of fee revenue. Without it fee revenue has no price factor and
-- cannot be decomposed into price x volume x mix.
CREATE TABLE IF NOT EXISTS feature_intelligence.dim_fee_schedule (
    tenant_id  String,
    txn_type   LowCardinality(String),
    channel    LowCardinality(String),
    fee_flat   Decimal64(2),
    fee_pct    Decimal32(4),
    valid_from Date,
    valid_to   Date DEFAULT toDate('2099-12-31'),
    _version   DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, txn_type, channel, valid_from);

-- Calendar: known events must not be alarmed on. Detect suppresses expected peaks from here.
CREATE TABLE IF NOT EXISTS feature_intelligence.dim_calendar (
    calendar_date Date,
    tenant_id     String,
    is_holiday    UInt8 DEFAULT 0,
    is_weekend    UInt8 DEFAULT 0,
    is_month_end  UInt8 DEFAULT 0,
    season        LowCardinality(String) DEFAULT '',
    label         String DEFAULT '',
    _version      DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, calendar_date);

-- Campaigns: the only declared INTERVENTIONS. Causal may not claim an effect without one.
CREATE TABLE IF NOT EXISTS feature_intelligence.dim_campaign (
    campaign_id String,
    tenant_id   String,
    name        String,
    channel     LowCardinality(String),
    segment     String DEFAULT '',
    start_date  Date,
    end_date    Date,
    spend       Decimal64(2) DEFAULT 0,
    _version    DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
ORDER BY (tenant_id, campaign_id);

-- ── Per-source freshness ────────────────────────────────────────────────────
-- Sources refresh at different cadences, so one global freshness number is meaningless.
-- Trust Gate reads the row for the source a contract declares.
CREATE TABLE IF NOT EXISTS feature_intelligence.source_freshness (
    source_id      String,
    tenant_id      String,
    grain          LowCardinality(String),
    cadence        LowCardinality(String),
    sla_minutes    UInt32,
    last_loaded_at DateTime,
    max_source_ts  DateTime,
    rows_loaded    UInt64 DEFAULT 0,
    load_status    LowCardinality(String) DEFAULT 'ok',
    note           String DEFAULT '',
    _version       DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(_version)
ORDER BY (source_id, tenant_id);

-- Batch watermarks, so a loader resumes instead of re-reading history every run.
CREATE TABLE IF NOT EXISTS feature_intelligence.ingest_watermarks (
    source_id  String,
    entity     String,
    tenant_id  String,
    watermark  DateTime,
    rows_seen  UInt64 DEFAULT 0,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (source_id, entity, tenant_id);
