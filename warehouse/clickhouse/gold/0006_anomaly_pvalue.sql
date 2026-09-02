-- Detect emits a p-value so Benjamini-Hochberg can run across the KPIs tested together.
ALTER TABLE gold.anomalies
    ADD COLUMN IF NOT EXISTS p_value Float64 DEFAULT 1 AFTER materiality;
