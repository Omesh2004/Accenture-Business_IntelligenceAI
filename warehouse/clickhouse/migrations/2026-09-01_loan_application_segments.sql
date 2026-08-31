-- Segment columns on the loan-application fact, so KYC completion and approval volume can be
-- localized on measured dimensions. They live on dim_customer and dim_branch, and the fact query
-- builder has no join, so a contract could only slice loan_type and status.
ALTER TABLE feature_intelligence.fact_loan_applications
    ADD COLUMN IF NOT EXISTS branch_code   LowCardinality(String) DEFAULT '' AFTER customer_id,
    ADD COLUMN IF NOT EXISTS region        LowCardinality(String) DEFAULT '' AFTER branch_code,
    ADD COLUMN IF NOT EXISTS country       LowCardinality(String) DEFAULT '' AFTER region,
    ADD COLUMN IF NOT EXISTS risk_segment  LowCardinality(String) DEFAULT '' AFTER country;
