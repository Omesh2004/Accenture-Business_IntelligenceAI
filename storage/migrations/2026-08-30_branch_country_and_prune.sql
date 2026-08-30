-- Global geography, part 2: country alongside region, and two dead tables removed.
--
-- `region` is a continent (2026-08-30). The dashboard's Geographic Distribution renders BOTH a
-- country and a continent view, so a retail KPI could match only half of it. `country` closes that:
-- it is denormalised from dim_branch at extract time, same as region, and drawn from the same
-- worldwide vocabulary the clickstream emits.
--
-- fact_loans and fact_account_daily are dropped. Both were loaded on every core-banking run and
-- read by nothing: no contract declares a fundamental against either, and neither appears in any
-- endpoint. fact_account_daily was also the fastest-growing table in the schema (one row per
-- account per day) purely to be ignored.
ALTER TABLE feature_intelligence.fact_transactions          ADD COLUMN IF NOT EXISTS `country` LowCardinality(String) DEFAULT '' AFTER `region`;
ALTER TABLE feature_intelligence.fact_account_openings      ADD COLUMN IF NOT EXISTS `country` LowCardinality(String) DEFAULT '' AFTER `region`;
ALTER TABLE feature_intelligence.fact_cards                 ADD COLUMN IF NOT EXISTS `country` LowCardinality(String) DEFAULT '' AFTER `region`;
ALTER TABLE feature_intelligence.fact_campaign_interactions ADD COLUMN IF NOT EXISTS `country` LowCardinality(String) DEFAULT '' AFTER `region`;
ALTER TABLE feature_intelligence.dim_customer               ADD COLUMN IF NOT EXISTS `country` LowCardinality(String) DEFAULT '' AFTER `region`;
ALTER TABLE feature_intelligence.dim_branch                 ADD COLUMN IF NOT EXISTS `country` LowCardinality(String) DEFAULT '' AFTER `region`;

DROP TABLE IF EXISTS feature_intelligence.fact_loans;
DROP TABLE IF EXISTS feature_intelligence.fact_account_daily;
