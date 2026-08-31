-- fact_transactions.direction: which side of the transaction is the bank's own customer.
-- Needed because EXTERNAL-BANK is a single shared clearing account; without a direction the
-- inbound and outbound legs of the same account are indistinguishable once attributed correctly.
ALTER TABLE feature_intelligence.fact_transactions
    ADD COLUMN IF NOT EXISTS direction LowCardinality(String) DEFAULT '' AFTER counterparty_acc;
