# Interface — the Metric API (named-read catalogue)

**Status:** FROZEN for Round 2 (Phase 0). Owner: Track B. Consumers: the dashboard API and the
Track C tools (via `MetricAPIClient`).

**What this is:** the one doorway into the warehouse. CLAUDE.md §11: *"The only doorway into the
warehouse. Named, tenant-scoped reads. No tool and no agent writes raw SQL against raw tables; they
call the Metric API."* Today it exists only as an in-process Python `Protocol`
(`api/intelligence/metrics.py::MetricSource`); Phase 4 promotes it to a FastAPI service.

**Service:** `api/metric_api/` — FastAPI on `:8001` (starts as a router inside `analytics-api`,
split into its own service later if load warrants). Reads **`silver` + `gold` only. Never
`bronze`.**

Per `docs/DATA_MODEL.md`: KPI reads resolve `kpi_id` to a **`silver.fact_*` table + measure**, not
clickstream events. `/metric/funnel` is the one clickstream-fed read and produces stage detail,
never a KPI rate.

---

## Named reads

| read | params | returns | used by |
|---|---|---|---|
| `GET /metric/kpi/series` | `tenant`, `kpi_id`, `start`, `end` | daily points from `silver.fact_*`; for a rate KPI, the derived rate + both fundamental count series, gap-filled with zeros | dashboard chart, Forecast, Detect |
| `GET /metric/kpi/total` | `tenant`, `kpi_id`, `start`, `end` | single value per fundamental + derived rate | Detect, Materiality |
| `GET /metric/kpi/by_dim` | `tenant`, `kpi_id`, `fundamental`, `dims` (csv), `start`, `end`, `min_volume` | `{cell: value}` over the segment cube built from the measured fact columns; `unexplained_pct` | Localize |
| `GET /metric/kpi/cell_deltas` | + `baseline_start`, `baseline_end` | `{cell: (current, baseline)}` in one query | Localize |
| `GET /metric/funnel` | `tenant`, `funnel_id`, `start`, `end` | per-stage counts from `gold.funnel_daily` (clickstream) — abandonment / stage detail only | dashboard funnel, journey view |
| `GET /metric/dedup_counts` | `tenant`, `kpi_id`, `start`, `end` | `(rows_as_inserted, distinct_ids)` from the rollup — the write-time collapse check | Trust Gate |
| `GET /metric/freshness` | `tenant` | per-source rows: grain, cadence, SLA, minutes-behind, status | Trust Gate |
| `GET /metric/dimensions` | `tenant`, `kpi_id`, `window` | per allowed dim: measured / cardinality; the clickstream fabricated-dim list is separate and advisory | Localize, contract loader |
| `GET /metric/calendar` | `tenant`, `start`, `end` | holiday / weekend / season / label per day | Detect, abstain scenario |
| `GET /metric/campaigns` | `tenant`, `start`, `end` | campaigns overlapping the window | causal check, abstain scenario |
| `GET /metric/discover` | `tenant`, `start`, `end` | fact entities + measured columns present (Tier 0) | orchestrator |
| `GET /metric/watermark` | `tenant` | newest ingest time per source (clickstream + core-banking) | orchestrator (pins the run) |

## Rules baked into every endpoint

- **Tenant-scoped:** `tenant` is required, single value, validated against a known set.
- **`kpi_id` resolves through the contract loader** (`api/contracts_loader.py`) to the
  `silver.fact_*` table, measure and filter it names. An unknown `kpi_id` is a **404**, not an
  empty 200.
- **Exact aggregates only** — `sum`, `count`, `uniqExact`, `min`, `max`. The endpoint rejects a
  contract that names an approximate aggregate (`uniq`, `quantile`, `topK`, `any`).
- **Half-open `[start, end)` windows**, both bounds required.
- **Never touches `bronze`.**

## Client

`api/metric_api/client.py::MetricAPIClient` implements the existing `MetricSource` Protocol by
calling these endpoints, so Track C's stages swap `ClickHouseMetricLayer()` → `MetricAPIClient()`
with no other change (Phase 4, decision D5). `StubMetricLayer` is unchanged and stays for tests.

`MetricSource` Protocol methods the HTTP reads back:
`resolve_event_names`, `fundamental_total`, `fundamental_series`, `fundamental_by_cell`,
`cell_deltas`, `dedup_counts`, `freshness_minutes`, `dimension_invariance`,
`dimension_cardinality`, `tenant_volume`, `simulated_keys`, `watermark`.

## Not in this interface

- No write endpoints. The tools write the Signal Store (`gold.*`) directly via
  `api/intelligence/signal_store.py` — unchanged by this plan.
- No `bronze` access, by anyone, ever.
