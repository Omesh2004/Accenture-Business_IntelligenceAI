-- root_causes: the ReplacingMergeTree key must separate Localize's cells from Decompose's factors.
--
-- The key was (tenant_id, anomaly_id, rank). BOTH stages write here and both number their rows
-- from rank 1, so a factor row and a cell row at the same rank shared a key and one silently
-- replaced the other. Measured: factor_rows = 0 for every anomaly that had localized cells --
-- the entire factor decomposition was discarded after being computed, and the gate did not catch
-- it because it exercises decompose() directly rather than reading the store back.
--
-- `fundamental` is what distinguishes them ('factor:price' vs the metric name), so it belongs in
-- the key. ORDER BY cannot be altered in place; the table is derived state and a sweep rebuilds it.

CREATE TABLE IF NOT EXISTS feature_intelligence.root_causes_v2
(
    `cause_id` String,
    `investigation_id` String,
    `anomaly_id` String,
    `tenant_id` String,
    `rank` UInt8,
    `dimensions` String,
    `fundamental` String,
    `contribution` Float64,
    `method` String,
    `explained_pct` Float64,
    `engine_type` String DEFAULT 'stats'
)
ENGINE = ReplacingMergeTree
ORDER BY (tenant_id, anomaly_id, fundamental, rank);

INSERT INTO feature_intelligence.root_causes_v2 SELECT * FROM feature_intelligence.root_causes;

RENAME TABLE feature_intelligence.root_causes TO feature_intelligence.root_causes_old,
             feature_intelligence.root_causes_v2 TO feature_intelligence.root_causes;

DROP TABLE IF EXISTS feature_intelligence.root_causes_old;
