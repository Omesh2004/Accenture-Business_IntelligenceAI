# Track B rebuild — handoff to Tracks A, C, D

**Date:** 2026-09-01. **Status:** Phases 0–8 of [`TRACK_B_PHASED_PLAN.md`](TRACK_B_PHASED_PLAN.md)
are done and verified. Nothing is committed yet — it is all in the working tree on `develop`.

This is the one page the other tracks need. Per-phase detail and every deviation is in
`docs/execution/PHASE_*_REPORT.md` (gitignored — ask the Track B owner, or read the tree).

---

## 1. What the warehouse looks like now

Three ClickHouse databases, one per layer. **`feature_intelligence` is gone.** So are
`events_raw`, `daily_feature_usage`, `schema.sql`, and the 19 migrations.

| DB | tables | who may read |
|---|---|---|
| `bronze` | `events` (+ `_raw`), `core_banking` (+ `_raw`), `events_dead_letter` | the pipeline only |
| `silver` | `events`, `sessions`, `fact_transactions`, `fact_loan_applications`, `fact_account_openings`, `dim_customer`, `dim_branch`, `dim_campaign`, `dim_calendar`, `dim_fee_schedule` | the Metric API only |
| `gold` | `kpi_daily`, `kpi_daily_by_dim`, `funnel_daily`, `source_freshness`, `ingest_watermarks`, **the Signal Store** (`investigations`, `trust_findings`, `anomalies`, `root_causes`, `forecasts`, `causal_effects`, `recommendations`, `insights`, `model_runs`, `outcomes`), `schema_migrations` | the Metric API, the tools (via the Metric API), the dashboard |

**Not built** (dropped from the spec — not in the 5-KPI chain): `fact_cards`,
`fact_campaign_interactions`, `dim_macro_environment`, `fact_loans`, `fact_account_daily`.

Authoritative DDL: `warehouse/clickhouse/{bronze,silver,gold}/*.sql`. Applied in layer order by
`warehouse/migrate.py` (a one-shot `migrate` compose service that runs before anything else). A
post-baseline schema change is a numbered file in `warehouse/clickhouse/migrations/` (starts
`0002`) mirrored back into the layer file.

**Fresh volume is the normal case:** `docker compose down -v && docker compose up -d`.

### The 5 KPIs (every value comes from the daily snapshot, never the clickstream)

| `kpi_id` | shape | fundamentals in `gold.kpi_daily` | localizable dims |
|---|---|---|---|
| `signups` | count | `accounts_opened` | account_type, branch_code, region, country |
| `kyc_completion_rate` | rate | `kyc_started`, `kyc_completed` (kyc_step ≥ 1 / ≥ 3) | loan_type, risk_segment, region, branch_code |
| `loan_approval_volume` | count | `loans_approved`, `principal_approved` (by **`decided_at`**) | loan_type, risk_segment, region |
| `revenue` | money | `fee_revenue`, `interest_accrued`, `pro_revenue` | channel, txn_type, mcc, region, branch_code |
| `transaction_failure_rate` | rate | `txn_total`, `txn_failed` (status `FAILED`) | channel, txn_type, mcc, region, branch_code |

Rates store their two counts, never the ratio — the Metric API derives it. Full definitions +
the `revenue` model (D1): [`docs/INTERFACES/kpi_rollups.md`](../INTERFACES/kpi_rollups.md).

---

## 2. The three interfaces you build against

Published in [`docs/INTERFACES/`](../INTERFACES/):

- **`event_envelope.md`** — the JSON body NexaBank POSTs to `POST /events`. Frozen. Ingestion
  validates *shape only* now; canonicalisation + reject happen in Silver.
- **`kpi_rollups.md`** — the `gold.kpi_daily` / `kpi_daily_by_dim` schema, the 5 KPIs → fundamentals
  → source fact table, and D1 (revenue) / D2 (signups).
- **`metric_api.md`** — the 12 named reads. This is the ONLY way to read the warehouse.

---

## 3. Track C — the intelligence layer

**You can now build against real data.** The Metric API is live and `gold.*` has real rows.

### What changed under you

| was | now |
|---|---|
| `api/intelligence/metrics.py::ClickHouseMetricLayer` (SQL vs `events_raw`) | **alias for `MetricAPIClient`**. The dead SQL is removed. `Window` / `Series` / `MetricSource` / `StubMetricLayer` / `ratio_series` are unchanged. |
| `api/intelligence/facts.py` (`FactReader`) | **deleted** — the KPI SQL is `api/metric_api/reads.py` |
| `api/intelligence/loaders.py` (the batch extract) | **moved** to `pipeline/extract/core_banking.py` + `reference.py` + `freshness.py`. `run_batch_loaders` removed from `api/intelligence/service.py` — the pipeline service owns the extract loop now. |
| `api/intelligence/contracts.py` | still there and imported; **also re-exported from `api/contracts_loader.py`** (repoint one import when convenient — `load_all` signature unchanged) |
| `api/intelligence/reader.py`, `signal_store.py` | `DB` repointed `feature_intelligence` → **`gold`**. The Signal Store schema is unchanged. |

### What you need to do

1. **Rewrite `contracts/*.yaml`** to the Round-2 5-KPI set. They are currently the Round-1 set
   (`digital_adoption_rate`, `cost_per_acquisition`, `net_deposit_growth`, …) referencing tables
   that no longer exist. The Round-2 `kpi_id` → fundamentals mapping is `KPI_REGISTRY` in
   `api/contracts_loader.py` and `docs/INTERFACES/kpi_rollups.md`.
2. **Adopt the new spec shape.** Post-D1/D2, a fundamental spec is `{"kpi_id": <one of the 5>,
   "fundamental": <name>}` (+ optional `dims`). `MetricAPIClient` expects that. The old
   `{"event": …}` / `{"table": …}` forms are not supported — those KPIs are gone.
3. **Swap `ClickHouseMetricLayer()` → `MetricAPIClient()`** in `orchestrator.py`, `service.py`,
   `tools.py`, `series.py`. It is currently the alias, so imports work, but `MetricAPIClient`
   needs the metric API reachable at `METRIC_API_URL` (default `http://analytics-api:8001`).
4. **The `intelligence` container currently error-logs** every sweep (its stages still assume the
   old schema). Its guarded loops keep it alive; it does nothing useful until (1)–(3) land.
5. `personas.py` — Round 2 needs CFO / Ops / Risk (`rbac.json` is trimmed to
   `cfo` / `ops_manager` / `risk_officer` / `analyst`, `ops_hides: [revenue]`). The `filter_revenue`
   entitlement is applied at the dashboard boundary (`api/middleware.py`); depth-of-detail is still
   your `personas.py`.
6. `scripts/run_intelligence_gates.py` — Round-1, needs a repoint (banner added).

### Reading the Signal Store

Write via `api/intelligence/signal_store.py` (→ `gold`) as before. The dashboard reads it via
`api/intelligence/reader.py` (→ `gold`) — `latest_insight`, `list_insights`, `source_health`,
`runtime_telemetry`, `recommendations` all work once you write rows.

### Fabricated dimensions

`silver.events.fabricated_dims Array(String)` = `metadata._simulated`, unioned per session onto
`silver.sessions`. Snapshot KPIs use **measured** fact columns only (region, branch_code, channel,
mcc, loan_type, risk_segment) — no fabricated-dim risk there. The clickstream funnel is the only
place fabricated dims appear, and it never produces a KPI number.

---

## 4. Track D — the dashboard

**`api/main.py` (4176 lines, ~45 endpoints) is deleted.** The `analytics-api` service now runs
`api/dashboard_api/main.py` on `:8001`. Build against these:

| endpoint | notes |
|---|---|
| `/metric/*` (all 12) | the Metric API router, mounted on the same app — see `metric_api.md` |
| `/metrics/kpi?tenants=&days=&persona=` | the 5 KPIs; **hidden KPIs are dropped for the persona** |
| `/metrics/traffic?tenants=&days=` | daily txn total / failed series |
| `/funnels?tenants=&days=&funnel_id=kyc_funnel\|txn_funnel` | stage counts |
| `/tenants`, `/tenants/available`, `/deployment/info` | single tenant `nexabank` |
| `/intelligence/{personas,insight,insights,sources,telemetry,recommendations,series,rail,outcome}` | Signal Store reads (return graceful nulls until Track C writes rows) |
| `/intelligence/ask`, `/ask/stream` | **503** — the agent is Track C's rebuild |

- **Persona** comes from `X-User-Persona` header or `?persona=`, validated server-side against
  `rbac.json`'s `selectable` list — a request can never widen access.
- **Ops-hides-revenue**: `/metrics/kpi` as `ops_manager` returns 4 KPIs; `/intelligence/series?kpi_id=revenue`
  as ops → **403**. `api/middleware.py::filter_revenue` recursively scrubs `revenue` from any body.
- The dead Round-1 endpoints (`/locations`, `/metrics/devices`, `/features/*`, `/journey/*`,
  `/license/*`, `/tracking/toggles`, `/ai_report`, `/admin/*`, …) are gone.
- `dashboard/src/lib/feature-map.ts` etc. still carry Round-1 multi-app plumbing — a `safexbank`
  scrub was done, but the multi-app/RBAC model needs a Round-2 rethink on your side.
- The real-time WS pulse (`api/websocket_manager.py`) is repointed to the Metric API reads but is
  not wired into `dashboard_api` — wire it when you need it.

---

## 5. Track A — NexaBank

Full detail: [`TRACK_A_B_SYNC.md`](TRACK_A_B_SYNC.md). Still open:

| # | what | blocking? |
|---|---|---|
| A1 | `enforceTaxonomy` → passthrough / shape-check (send the raw instrumented name) | no — Silver canonicalises known names regardless; only "unknown fails loudly" is delayed |
| A4 | `since_id` keyset tiebreaker + `cursor_id` on `GET /api/extract/accounts` (signups reads it) | no — a same-timestamp page boundary drops the remainder until fixed |
| A6 | Simulate console writes `fixtures/planted_truth.json` like `scripts/seed_data.py` | no — only the console's own scenarios are un-checkable without it |
| A8 | remove `/events/toggles/*` bridge + `enforceTaxonomy` toggle enforcement | **yes, coordinated** — Track B already dropped `/tracking/toggles`; the ingestion side no longer enforces toggles |
| A9 | decide `/events/location` / `/events/admin/locations` / `userLocation` | no |
| A10 | re-point `eventRoutes.ts` `mode:"fast"` from `${ingestion}/events/seed/fast` to `${pipeline}/dev/seed` | **yes, coordinated** — the ingestion endpoint is a thin proxy until you re-point, then Track B deletes it |

**Done directly by Track B (user-authorised):** the whole `bank_b` / `safexbank` removal —
`seedTenants.ts` (1 tenant), the alias maps in `eventTracker.ts` / `eventRoutes.ts` /
`extractShared.ts`, the `bank_b` seed phases in `generateDemoData.ts` / `plantMovement.ts` /
`seedReferenceData.ts`, and the frontend SafeX options. `docker compose exec nexabank-backend
npx tsc --noEmit` passes. **Leftover:** the remote Postgres still holds inert `bank_b` demo rows —
a `resetDemoData.ts` + re-seed clears them; the pipeline extract filter drops them regardless.

**Frozen — do not change without Track B sign-off:** the event envelope top-level fields, the
extract API response envelope + keyset contract, that `metadata._simulated` exists, the
`x-extract-token` scheme, and emitting both a banking fact and its matching clickstream event.

---

## 6. How to run it

```bash
docker compose down -v && docker compose up -d      # fresh; `migrate` builds the 3 DBs first

# volume seed (fast, deterministic — how Track C/D get data to iterate on):
curl -s -X POST localhost:8003/dev/seed -H 'content-type: application/json' \
  -d '{"users":100,"days":45,"seed":42,"create_accounts":true}'
# with a planted movement:
curl -s -X POST localhost:8003/dev/seed -H 'content-type: application/json' -d '{
  "users":45,"days":12,"seed":43,"create_accounts":true,
  "behavior":{"window_days":12,"segment":{"country":"India"},
    "rates":{"kyc_completion":0.2,"txn_failure":0.4,"loan_approval":0.2}}}'

# real extract (slow — NexaBank Postgres): the pipeline service does it on a loop; or:
docker compose exec pipeline python pipeline/service.py     # one-shot full extract + transforms

# read a KPI:
curl "localhost:8001/metric/kpi/total?tenant=nexabank&kpi_id=revenue&start=2026-07-01&end=2026-09-03"
```

Ports: ingestion `:8000`, dashboard/metric API `:8001`, pipeline `:8003`, NexaBank `:5000`,
ClickHouse `:8123`.

---

## 7. Key deviations from the plan / spec (so you're not surprised)

| what | why |
|---|---|
| No literal `0001_baseline.sql` — `migrate.py` applies the layer dirs directly | avoids a duplicated concatenated blob; keeps per-file checksum-drift detection |
| `gold.kpi_daily/*` are `ReplacingMergeTree` with **plain numeric columns**, recomputed per window | an `AggregatingMergeTree` of `-State` columns doubles on a re-insert and fails the determinism gate |
| `silver.fact_*` rebuild **wholesale** (`TRUNCATE` + re-derive) each transform run | silver is fully derived from bronze; a purged/replaced bronze record must not leave a stale silver row |
| Money fundamentals accumulate as `Float64`, rounded 2dp at the read boundary | if exact `Decimal` end-to-end is needed, flag it |
| `revenue` = `fee_revenue` + `interest_accrued` (flat daily accrual, not amortised) + `pro_revenue` (`PRO_LICENSE_FEE` txns) | **provisional** — confirm against your `revenue.yaml` |
| Fee-schedule `(txn_type, channel)` join resolved via a subquery | CH 24.3 rejects a non-equi join condition even in `WHERE` |
| `dim_fee_schedule` + `dim_calendar` synthesised by `pipeline/extract/reference.py` | D8 default — NexaBank did not expose extract endpoints for them |

---

## 8. Verified

- Fresh-volume build: 11 layer files apply clean; `migrate --status` idempotent.
- `POST /events` → `bronze.events` with `_raw`; bad payload → `bronze.events_dead_letter`.
- extract → `bronze.core_banking` → `silver.fact_*` → `gold.kpi_daily` for all 5 KPIs.
- Taxonomy reject → `bronze.events_dead_letter` (`silver_taxonomy_reject`), **not** `silver.events`,
  not any KPI.
- All 12 Metric API reads return correct numbers; 404 on unknown `kpi_id`, 400 on unknown tenant.
- The four §10 scenarios' **source data** lands correctly (multi-factor movement visible in
  `kpi_daily_by_dim`; abstain context via `/metric/{calendar,campaigns}`; sparse-history KPI < 14
  days; Ops entitlement is a real subtraction).
- Freshness SLA logic flips a source to `stale`.
- **Determinism**: full `down -v` → seed → snapshot → repeat → `gold.*` byte-identical.
