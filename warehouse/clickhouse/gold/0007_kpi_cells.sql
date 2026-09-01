-- gold.kpi_cells — the true multi-dimensional cube.
--
-- kpi_daily_by_dim is one dimension per row, so it holds 1-D marginals and PSqueeze has no
-- cuboids to combine. This stores the LEAF cell: the full dimension tuple, which is what the
-- generalized ripple effect is defined over.
--
-- Additive: kpi_daily_by_dim is unchanged and every existing read still works.
-- Measured ~648 leaf combos for transactions and 191 for loan applications, so the cube is small.
CREATE TABLE IF NOT EXISTS gold.kpi_cells
(
    tenant_id   String,
    kpi_id      LowCardinality(String),
    date        Date,
    fundamental LowCardinality(String),
    cell_key    String,                              -- 'channel=POS|region=Europe', dims sorted
    dims        Array(LowCardinality(String)),
    vals        Array(LowCardinality(String)),
    value       Float64,
    _version    DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, kpi_id, date, fundamental, cell_key)
SETTINGS index_granularity = 8192;
