# Track B — phased execution plan

Companion to [`TRACK_B_CURRENT_VS_PROPOSED.md`](TRACK_B_CURRENT_VS_PROPOSED.md). That file is the
audit; this is the build order. Cross-track coordination lives in
[`TRACK_A_B_SYNC.md`](TRACK_A_B_SYNC.md).

**Status:** plan only. Nothing here is executed yet.

**Scope:** `ingestion/`, `pipeline/`, `warehouse/`, `api/` (the Metric API + the dashboard-read
endpoints), plus the contract *loader* (CLAUDE.md §13 assigns it to Track B; the YAML content is
Track C's). Track A (`nexabank/`) is built in parallel; Track C (`api/intelligence/` internals,
`contracts/` YAML) comes after A and B land.

**The KPI set.** CLAUDE.md §5 fixes the five. `docs/DATA_MODEL.md` ("The five KPIs, and where each
number comes from", added after this plan's first draft) then makes the sourcing decision: **every
KPI value comes from the daily banking snapshot (`silver.fact_*`), not the clickstream.** The
clickstream is behavioural context only — funnel stage detail and journey reconstruction — and
never produces a figure a reader sees as a KPI. Localize, Detect, Forecast and Decide all run on
the snapshot.

> This **supersedes** the clickstream reading of CLAUDE.md §6 ("Real-time clickstream … drives
> signups, KYC completion, transaction failures"). §6 needs a wording fix — flag for whoever owns
> CLAUDE.md. The plan below follows `DATA_MODEL.md`.

| KPI | Shape | Source of truth (`DATA_MODEL.md`) | Fundamentals Track B rolls up | Localizable dimensions |
|---|---|---|---|---|
| new account signups | count | `silver.fact_account_openings` | `accounts_opened` by day of `opened_at` | account_type, branch_code, region, country |
| kyc completion rate | rate | `silver.fact_loan_applications.kyc_step` | `kyc_started`, `kyc_completed` (counts, never the ratio) | loan_type, risk_segment, region, branch_code |
| loan approval volume | count | `silver.fact_loan_applications` where `status='APPROVED'`, by `decided_at` | `loans_approved`, `principal_approved` | loan_type, risk_segment, region, term bucket |
| revenue | money | modelled from measured inputs — see D1 | `fee_revenue`, `interest_accrued`, `pro_revenue` | channel, txn_type, mcc, region, branch_code |
| transaction failure rate | rate | `silver.fact_transactions.status` | `txn_total`, `txn_failed` (counts, never the ratio) | channel, txn_type, mcc, region, branch_code |

Fallback cut (CLAUDE.md §5): kyc completion rate, loan approval volume, revenue.

Notes carried from `DATA_MODEL.md` (get these wrong and the numbers are wrong):
- **Loan approval volume counts on `decided_at`, not `created_at`.**
- **Both rates store their two counts, never the ratio** — a rate is derived at read time; a stored
  rate is non-additive and cannot be localized.
- A `silver.fact_transactions` channel with **no `dim_fee_schedule` row earns no fee** and silently
  vanishes from revenue.

**Decision D1 — revenue composition** (aligned to `DATA_MODEL.md`). Modelled, but grounded in
measured inputs; no new table, no new extract endpoint:
- `fee_revenue` — `silver.fact_transactions` ⨝ `silver.dim_fee_schedule` (valid-dated,
  `(txn_type, channel)`): `sum(fee_flat + amount * fee_pct)` per day. Card-present / interchange is
  a fee-schedule row class folded into this line, **not** a separate fundamental.
- `interest_accrued` — `silver.fact_loan_applications` where `status='APPROVED'`:
  `sum(principal_amount * interest_rate / 365)` per day. A flat daily accrual, **not** an
  amortisation schedule. If Track C's `revenue.yaml` later needs true amortisation, that is an
  additive follow-on (`silver.fact_loans` + an extract endpoint) — `fact_loans` / `fact_account_daily`
  stay dropped until then.
- `pro_revenue` — the one line with **no measured money behind it**; per `DATA_MODEL.md` it carries
  a `simulated:` block in the contract. Track B rolls up whatever pro-subscription / pro-unlock
  fundamental Track C's contract names (likely a `fact_transactions` subset by `txn_type`); the
  source is confirmed with Track C when `revenue.yaml` lands.

**Decision D2 — signups source** (reversed to match `DATA_MODEL.md`). Signups = `silver.fact_account_openings`,
`accounts_opened` by `opened_at` day — the **daily snapshot**, not clickstream `register.auth.success`.
Consequences: `fact_account_openings` is **kept**, `/api/extract/accounts` **is** consumed, and
sync-doc item A4 (keyset on that endpoint) is **back in scope**.

---

## 1. Guiding principles

1. **Scrap freely — code and schema, not tooling.** This is a hackathon: no production, no
   customer data, no history to preserve, and we are not shipping. So drop the ClickHouse volume,
   the 19 migrations, and every endpoint/table that does not serve the five KPIs, the four
   scenarios, or the evidence/telemetry cards — no backward-compat burden. **But the mock-data
   machinery stays and matters:** slow-mode seeding (real Kafka→pipeline path) is how the demo
   proves the architecture, and fast-mode seeding (direct warehouse writes) is how the
   intelligence layer gets enough volume to iterate on. Both are first-class; see §3.7.
2. **One database per layer.** `bronze` / `silver` / `gold`, enforced by the read paths not by
   convention.
3. **One doorway.** Every read of the warehouse — dashboard and tools alike — goes through the
   Metric API. No inline SQL against raw tables anywhere else.
4. **One vocabulary.** Event-name canonicalisation happens exactly once, in Silver, and *rejects*
   what it cannot resolve.
5. **Bronze is replayable.** Every bronze row keeps its untouched payload, so Silver and Gold can
   be rebuilt from scratch without re-running the bank.
6. **Determinism holds.** Keep the discipline that already works: `uniqExact` only, id
   tiebreakers, `TZ=UTC`, windows pinned once and bounded both ends, rounding at the write
   boundary.
7. **Don't block Track A or C.** Freeze the two interfaces Track B owns in Phase 0 so both can
   build against a fixed target.

---

## 2. Target end state

### 2.1 Folder layout

```
ingestion/
  main.py            mask, validate-shape, event_id policy, write bronze.events, Kafka + fallback
  envelope.py        FeatureEvent (trimmed)
  masking.py         PII redaction
pipeline/
  worker.py          Kafka consumer -> bronze.events  (verbatim, + _raw)
  taxonomy/
    __init__.py      canonicalize(name) -> str | None   (None = reject)
    aliases.yaml     the one alias map (migrated from api/page_map.py + eventTracker.ts)
  transforms/
    silver_events.py     bronze.events   -> silver.events   (+ fabricated_dims)
    silver_sessions.py   silver.events   -> silver.sessions
    silver_facts.py      bronze.core_banking -> silver.fact_* / silver.dim_*
    gold_kpi.py          silver.*        -> gold.kpi_daily / gold.kpi_daily_by_dim
    gold_funnel.py       silver.events   -> gold.funnel_daily
  extract/
    core_banking.py      HTTP extract -> bronze.core_banking   (moved from api/intelligence/loaders.py)
    reference.py         fee schedule + calendar -> silver.dim_*  (or from NexaBank; see sync doc)
    freshness.py         source_freshness + ingest_watermarks bookkeeping
  service.py          the batch scheduler for extract + transforms
warehouse/
  config.py          Kafka + ClickHouse settings only
  client.py          ClickHouse client (no api.* imports)
  migrate.py         idempotent ledger (kept)
  clickhouse/
    bronze/*.sql  silver/*.sql  gold/*.sql          layered DDL
    migrations/*.sql                                new line, starts 0001
api/
  metric_api/
    main.py          FastAPI :8001  the named-read doorway (silver + gold only)
    reads.py         one function per named read
    client.py        MetricAPIClient  (in-process HTTP client, implements MetricSource)
  dashboard_api/
    main.py          the KPI/funnel/persona/evidence endpoints the dashboard calls
  contracts_loader.py  loads contracts/*.yaml, validates against live silver+gold schema
  intelligence/      Track C  (unchanged by this plan except: metrics.py -> MetricAPIClient)
```

`api/main.py` (4176 lines) is deleted and its ~6 surviving endpoints re-homed under
`api/dashboard_api/` and `api/metric_api/`.

### 2.2 Database layout

| DB | Tables | Engine notes | Read by |
|---|---|---|---|
| `bronze` | `events`, `core_banking`, `events_dead_letter` | `MergeTree` — **never** Replacing. `+ _raw`. | pipeline only |
| `silver` | `fact_account_openings`, `fact_loan_applications`, `fact_transactions` (the KPI carriers), `dim_customer`, `dim_branch`, `dim_calendar`, `dim_fee_schedule`, `dim_campaign`, plus `events` + `sessions` (behavioural context only) | `ReplacingMergeTree`, dedup key = natural identity, collapsed at write. `events` carries `fabricated_dims Array(String)`. | Metric API only |
| `gold` | `kpi_daily`, `kpi_daily_by_dim` (both fed from `silver.fact_*`), `funnel_daily` (fed from `silver.events`, stage detail only), `source_freshness`, `ingest_watermarks`, + Signal Store (`investigations`, `trust_findings`, `anomalies`, `root_causes`, `forecasts`, `causal_effects`, `recommendations`, `insights`, `model_runs`, `outcomes`) | rollups `AggregatingMergeTree` / narrow-long; Signal Store `ReplacingMergeTree` | Metric API, tools (via Metric API), dashboard (via Metric API) |

`silver.fact_account_openings` is **kept** — decision D2 makes it the signups KPI carrier.

Dropped entirely: `tenant_licenses`, `tracking_toggles`, `config_audit_log`, `ai_reports`,
`fact_loans`, `fact_account_daily`, `fact_cards`, `fact_campaign_interactions`,
`dim_macro_environment`, `daily_feature_usage`.

### 2.3 Data flow

Per `DATA_MODEL.md`, the **snapshot path produces every KPI number**; the clickstream path only
feeds funnel stage detail and journey reconstruction.

```
nexabank ──event envelope──▶ ingestion  ──▶ bronze.events (+_raw) ──┐
   │                              │  (Kafka; fallback = direct write) │
   │                              └── validation fail ──▶ bronze.events_dead_letter
   │                                                                  │
   └──/api/extract/*──▶ pipeline/extract ──▶ bronze.core_banking (+_raw)
                                                                      │
                              pipeline/transforms (scheduled) ◀───────┘
                                    │
   ── KPI path (produces every number) ───────────────────────────────────────────
        bronze.core_banking ─▶ silver.fact_* / silver.dim_*
        silver.fact_*        ─▶ gold.kpi_daily, gold.kpi_daily_by_dim   ← Localize / Detect / Forecast / Decide
   ── context path (never a KPI number) ──────────────────────────────────────────
        bronze.events ─▶ silver.events (canonical|REJECT, masked-verify, day-pin, fabricated_dims)
        silver.events ─▶ silver.sessions
        silver.events ─▶ gold.funnel_daily   (which step did they abandon — stage detail only)
                                    │
                          Metric API :8001  (named, tenant-scoped reads over silver + gold)
                            │                        │
                     dashboard_api            tools (MetricAPIClient)  ──▶ Signal Store (gold)
```

---

## 3. Missing-piece designs

These are the six items the proposal needs that are designed nowhere. All are Track B.

### 3.1 `_raw` payload retention

**Problem:** `DATA_MODEL.md` Bronze requires an untouched payload column so a taxonomy-fix replay
is possible. No current table keeps it for successful rows.

**Design:**
- `bronze.events._raw String` — the exact request body the ingestion API received, before masking,
  before any envelope coercion, serialized as compact JSON. `''` only for rows reconstructed from
  a source that genuinely had no body (none today).
- Ingestion writes `_raw` = the raw POST body. The Kafka path carries the raw body as the message
  value; `pipeline/worker.py` writes `_raw` = `msg.value()` verbatim (it already decodes it to
  parse the envelope — keep both).
- `bronze.core_banking._raw String` — the JSON record as returned by `/api/extract/{entity}`,
  one row per record.
- Size is already bounded: ingestion caps the body at 64 KB.
- Retention: `bronze.*` gets a `TTL toStartOfMonth(_ingested_at) + INTERVAL 6 MONTH` (cold-move,
  not delete) — a prototype never hits it, but the DDL states intent.
- **Replay procedure** (documented, not automated): `TRUNCATE silver.events; INSERT INTO
  silver.events SELECT <transform> FROM bronze.events`. The transform reads `event_name` from the
  envelope columns, not `_raw`; `_raw` is the escape hatch for when the *transform itself* was
  wrong.

### 3.2 One canonicalisation vocabulary, in Silver, that rejects

**Problem:** three dialects (`ingestion/event_names.py` coerces, `api/page_map.py`
`canonicalize_event_name`, NexaBank `enforceTaxonomy` coerces). `ARCHITECTURE.md` coupling-point-2
names the drift. Plan wants one, resolved once, rejecting unknowns.

**Design:**
- **New module `pipeline/taxonomy/`** — the single implementation. No third-party imports (so the
  data-quality checker can exercise it, per the existing `event_names.py` rationale).
  - `TAXONOMY_REGEX` — strict `page.feature.status`.
  - `aliases.yaml` — the merged alias map: `api/page_map.py`'s `CANONICAL_EVENT_ALIASES` +
    `FEATURE_PAGE_MAP` legacy keys + `eventTracker.ts`'s `LEGACY_MAP`. One file, version-controlled.
  - `canonicalize(name: str) -> str | None` — regex match → normalise → return; alias hit →
    return mapped; **no match → return `None`**.
- **Ingestion** keeps *shape* validation only (`FeatureEvent.validate_event_name` → check it is a
  non-empty string matching `[a-z0-9_.]+`; do **not** canonicalise). The raw instrumented name
  lands in `bronze.events.event_name`.
- **Silver transform** (`silver_events.py`) calls `taxonomy.canonicalize()`:
  - match → `silver.events.event_name` = canonical, `silver.events.event_name_raw` = original.
  - `None` → row is written to `bronze.events_dead_letter` with `stage='silver_taxonomy_reject'`
    and **not** propagated to `silver.events`. It stays replayable from `bronze.events`.
- **`api/page_map.py`** keeps `URL_MAP` / `FEATURE_DISPLAY_NAMES` (dashboard cosmetics) and loses
  `canonicalize_event_name` / `normalize_event`. `warehouse/client.py` stops importing it.
- **Ownership:** Track B owns `pipeline/taxonomy/`. When Track A adds instrumentation with a new
  name, they open a PR adding the alias (see sync doc). A name with no alias is dead-lettered
  loudly, not silently renamed — that is the behaviour change the plan wants.

### 3.3 Sessionisation — `silver.sessions`

**Problem:** `DATA_MODEL.md` Silver requires `silver.sessions` ("one row per session, with its
resolved attributes") and "Rebuilds sessions". Nothing builds a session entity today;
`dimension_invariance()` already assumes one.

**Priority note:** since `DATA_MODEL.md`'s KPI-source revision, `silver.events` / `silver.sessions`
carry **no KPI number** — they feed funnel stage detail and journey reconstruction only. The design
below is unchanged, but it is now Phase-3 *supporting* work, not on the critical path to a KPI.

**Design:**
- **Session key = the producer's `session_id`.** No 30-minute-gap inference — the
  `kyc_completion_rate` contract explicitly says "never inferred from a 30-minute gap", and
  `eventTracker.ts` already mints a stable per-session id. Rows with `session_id = ''` never reach
  `silver.sessions` (Trust Gate's `session_present` invariant catches those at KPI time).
- **`silver.sessions` schema** — `ReplacingMergeTree(_version)`, `ORDER BY (tenant_id, session_id)`:

  | column | derivation |
  |---|---|
  | `tenant_id`, `session_id` | group key |
  | `user_id` | the first non-anon `user_id` seen in the session, else the anon key |
  | `started_at`, `ended_at` | `min` / `max` event timestamp |
  | `event_count`, `distinct_events` | `count()`, `uniqExact(event_name)` |
  | `entry_event`, `exit_event` | `argMin(event_name, ts)`, `argMax(event_name, ts)` |
  | `channel`, `device_type`, `location`, `continent`, `city` | first non-empty value per key (session-invariant by producer design; a session carrying two values is logged to a QA table) |
  | `campaign` | first non-empty `metadata.campaign` |
  | `fabricated_dims` | `arrayDistinct(arrayFlatten(groupArray(metadata._simulated)))` |
  | `is_suspected_bot` | `event_count / (ended_at-started_at+1) > 5` OR UA heuristic |
  | `_version` | transform run timestamp |
- **Built by** `pipeline/transforms/silver_sessions.py` — either a ClickHouse MV on
  `silver.events` keyed by session, or a scheduled `INSERT … SELECT … GROUP BY session_id` over the
  transform window. MV preferred (incremental); the aggregate-state columns follow the same
  `AggregateFunction` discipline as the rollups.
- **Fabrication declaration** (`DATA_MODEL.md`: "Silver carries, per row, a declaration of which
  attributes were fabricated") lands as `silver.events.fabricated_dims Array(String)` =
  `metadata._simulated` parsed once at write, and its session-level union on `silver.sessions`.
  The contract loader refuses to localize any dimension that appears in `fabricated_dims` for the
  window (unless `dataset='seeded'`, matching today's `simulated_keys` behaviour).

### 3.4 `bronze.core_banking` landing table

**Problem:** `loaders.py` writes silver-grain facts straight from HTTP; the plan wants a bronze
copy first so silver facts re-derive without re-hitting NexaBank.

**Design:**
- **`bronze.core_banking`** — `MergeTree`, `PARTITION BY toYYYYMM(_extracted_at)`,
  `ORDER BY (tenant_id, entity, record_id)`:

  | column | meaning |
  |---|---|
  | `record_id` | the source id (`txn_id`, `application_id`, `customer_id`, `branch_code`, …) |
  | `entity` `LowCardinality(String)` | `transactions` \| `loan_applications` \| `customers` \| `campaigns` \| `branches` \| `calendar` \| `fee_schedule` |
  | `tenant_id` | analytics tenant |
  | `_source_id` `LowCardinality(String)` | `nexabank_core` \| `nexabank_crm` \| `market_ops` \| `reference_data` |
  | `_extracted_at` | when this batch ran |
  | `_source_updated_at` | the record's own `updatedOn` / `occurredAt` — the version clock |
  | `_page_cursor` | `(watermark, cursor_id)` the row was fetched under, for reconciliation |
  | `_raw` `String` | the JSON record verbatim from the extract API |
- `pipeline/extract/core_banking.py` (moved from `api/intelligence/loaders.py`) pages the extract
  API exactly as today (watermark + `cursor_id` keyset resume — that logic is good, keep it) and
  writes **only** `bronze.core_banking`. Watermarks + `source_freshness` bookkeeping unchanged.
- `pipeline/transforms/silver_facts.py` reads `bronze.core_banking`, parses `_raw` per entity, and
  populates `silver.fact_transactions` / `silver.fact_loan_applications` / `silver.dim_*` —
  `ReplacingMergeTree(_source_updated_at)` so a replay converges.
- The **HTTP contract with NexaBank does not change** (see sync doc — one minor request: add
  keyset params to `/api/extract/accounts`).

### 3.5 Migration reset

**Problem:** 19 migrations, many multi-step online-rename dances for a fresh-volume prototype;
`schema.sql` (the monolith) has drifted from them; no runner is wired into deploy.

**Design:**
- **Delete** `warehouse/clickhouse/schema.sql` and `warehouse/clickhouse/migrations/*` (all 19).
- **Authoritative DDL** = `warehouse/clickhouse/{bronze,silver,gold}/*.sql`, numbered, applied in
  layer order (bronze → silver → gold).
- `warehouse/migrate.py` keeps its ledger (`gold.schema_migrations`), `--status`, checksum-drift
  detection, and the refuse-on-already-migrated guard. New migration line starts at
  `0001_baseline` = the concatenated layer DDL. Post-baseline changes are numbered migrations,
  mirrored back into the layer files.
- **Compose:** a one-shot `migrate` service — `image` = the Python image, `command: python
  warehouse/migrate.py`, `depends_on: { clickhouse: { condition: service_healthy } }`.
  `ingestion`, `pipeline`, `analytics-api` gain `depends_on: { migrate: { condition:
  service_completed_successfully } }`.
- **Fresh volume** (the normal case now): `docker compose down -v` then `up`. The `migrate`
  service builds all three databases. The ClickHouse `docker-entrypoint-initdb.d` mount is
  removed — one code path applies schema, not two.

### 3.6 The Metric API HTTP contract

**Problem:** CLAUDE.md §13 names "the Metric API (the named reads the tools and dashboard call)" as
one of the four interfaces to agree first. It exists only as an in-process Python Protocol.

**Design — `api/metric_api/` FastAPI service on :8001, reads `silver` + `gold` only.** Per
`DATA_MODEL.md`, the KPI reads resolve `kpi_id` to a **`silver.fact_*` table + measure**, not
clickstream events; `/metric/funnel` is the one clickstream-fed read and produces stage detail,
never the KYC rate itself.

| Named read | Params | Returns | Used by |
|---|---|---|---|
| `GET /metric/kpi/series` | `tenant`, `kpi_id`, `start`, `end` | daily points from `silver.fact_*`; for a rate KPI, the rate + both fundamental count series, gap-filled with zeros | dashboard chart, Forecast, Detect |
| `GET /metric/kpi/total` | `tenant`, `kpi_id`, `start`, `end` | single value per fundamental + derived rate | Detect, Materiality |
| `GET /metric/kpi/by_dim` | `tenant`, `kpi_id`, `fundamental`, `dims` (csv), `start`, `end`, `min_volume` | `{cell: value}` over the segment cube built from the **measured fact columns** (region, branch_code, channel, mcc, loan_type, risk_segment, …); `unexplained_pct` | Localize |
| `GET /metric/kpi/cell_deltas` | + `baseline_start`, `baseline_end` | `{cell: (current, baseline)}` in one query | Localize |
| `GET /metric/funnel` | `tenant`, `funnel_id`, `start`, `end` | per-stage counts from `gold.funnel_daily` (clickstream) — abandonment / stage detail only | dashboard funnel, journey view |
| `GET /metric/dedup_counts` | `tenant`, `kpi_id`, `start`, `end` | `(rows_as_inserted, distinct_ids)` from the rollup — for the fact tables this is the write-time collapse check | Trust Gate |
| `GET /metric/freshness` | `tenant` | per-source rows: grain, cadence, SLA, minutes-behind, status | Trust Gate |
| `GET /metric/dimensions` | `tenant`, `kpi_id`, `window` | per allowed dim: measured / cardinality; the clickstream fabricated-dim list is separate and advisory | Localize, contract loader |
| `GET /metric/calendar` | `tenant`, `start`, `end` | holiday / weekend / season / label per day | Detect, abstain scenario |
| `GET /metric/campaigns` | `tenant`, `start`, `end` | campaigns overlapping the window | Causal, abstain scenario |
| `GET /metric/discover` | `tenant`, `start`, `end` | fact entities + measured columns present (Tier 0) | orchestrator |
| `GET /metric/watermark` | `tenant` | newest ingest time per source (clickstream + core-banking) | orchestrator (pins the run) |

Rules baked into every endpoint:
- Tenant-scoped: `tenant` is required, single value, validated against a known set.
- `kpi_id` resolves through the **contract loader** to the `silver.fact_*` table, measure and
  filter it names; an unknown `kpi_id` is a 404, not an empty 200.
- Exact aggregates only (`sum`, `count`, `uniqExact`, `min`, `max`) — the endpoint rejects a
  contract that names an approximate one.
- Half-open `[start, end)` windows, both bounds required.
- Never touches `bronze`.

**`api/metric_api/client.py`** — `MetricAPIClient` implements the existing `MetricSource` Protocol
by calling these endpoints, so Track C's stages swap `ClickHouseMetricLayer` → `MetricAPIClient`
with no other change. `StubMetricLayer` stays for tests.

### 3.7 The mock-data path — slow mode and fast mode (both kept)

The hackathon needs two seeding paths, and the bronze/silver/gold split changes *where fast mode
writes*, not *whether it exists*.

**Slow mode** — `scripts/seed_data.py` (operator tool) and NexaBank's `POST /events/simulate`
(default). Emits events through `POST /events` → Kafka → `pipeline/worker.py` → `bronze.events` →
transforms. This is the path the demo runs on: it proves the real architecture end to end, and
`seed_data.py --scenario` writes `fixtures/planted_truth.json` for the scenario checks. **Unchanged
by this plan** except that it now lands in `bronze.events` like everything else.

**Fast mode** — for volume. Skips **only the transport** (Kafka + the remote-Postgres round trips
that dominate slow mode's wall-clock), and keeps the real warehouse transforms so a fast-seeded
dataset is byte-identical downstream to a slow-seeded one.

- Because `DATA_MODEL.md` puts every KPI number on `silver.fact_*`, fast mode's priority is the
  **fact path**: `bronze.core_banking` → `silver.fact_*` → `gold.kpi_daily`. The clickstream rows
  it also writes only exercise the funnel / journey views, so a thin clickstream sample is fine.
- **`api/fast_seed.py` → `pipeline/dev/seed.py`.** It stops importing from
  `api/intelligence/loaders.py` (the column lists move to `pipeline/extract/`).
- It writes **`bronze.core_banking` (+ a `bronze.events` sample) directly** (the same rows the
  extract / ingestion would have produced, `_raw` included), then calls
  `pipeline.transforms.run_all(window)` synchronously for the seeded window — or, if silver/gold
  are MVs, the bronze insert populates them and `run_all` is a no-op. One transform code path, no
  drift.
- **New endpoint `POST /dev/seed` (+ `/dev/seed/purge`) on the pipeline service**, gated behind
  `ENABLE_DEV_SEED=1` so it is unmistakably a dev tool. NexaBank's `POST /events/simulate?mode=fast`
  re-points here from the old ingestion `/events/seed/fast` (sync doc A10 — coordinated, just a URL
  change).
- Scoped purge (`purge_tables`) and the paired-seed behaviour (fixed seed → same customer-days)
  carry over as-is; they now target `bronze.*` + re-run transforms.

`dataset='seeded'` is still honoured on the clickstream side for the funnel/journey views.

---

## 4. Disposition tables

### 4.1 Current tables

| Table | Verdict | Notes |
|---|---|---|
| `events_raw` | **SPLIT** | → `bronze.events` (plain MergeTree, `+_raw`) + `silver.events` (canonical, `fabricated_dims`) |
| `daily_feature_usage` + `mv_daily_feature_usage` | **REPLACE** | → `gold.kpi_daily` (kpi×fundamental grain) + `gold.kpi_daily_by_dim` |
| `events_dead_letter` | **KEEP → bronze** | add `silver_taxonomy_reject` stage value |
| `investigations`, `trust_findings`, `anomalies`, `root_causes`, `forecasts`, `causal_effects`, `recommendations`, `insights`, `model_runs`, `outcomes` | **KEEP → gold** | schema unchanged, DB name changes |
| `source_freshness`, `ingest_watermarks` | **KEEP → gold** | extract bookkeeping |
| `fact_transactions` | **KEEP → silver** | **carries** transaction failure rate (#5, `status`) and `fee_revenue` (#4); `channel`/`mcc`/`txn_type` are localizable dims |
| `fact_loan_applications` | **KEEP → silver** | **carries** kyc completion rate (#2, `kyc_step`), loan approval volume (#3, `status`/`decided_at`), and `interest_accrued` (#4) |
| `fact_account_openings` | **KEEP → silver** | decision D2 — signups (#1), `accounts_opened` by `opened_at` |
| `dim_customer`, `dim_branch` | **KEEP → silver** | measured segment dims (risk_segment, region, branch_code) for Localize |
| `dim_calendar` | **KEEP → silver** | abstain scenario, known-event suppression |
| `dim_fee_schedule` | **KEEP → silver** | revenue price side (#4), incl. the ATM/POS/interchange rows |
| `dim_campaign` | **KEEP → silver** | abstain scenario (real campaign vs suspected glitch) |
| `fact_cards` | **DROP** | card activations not in the 5-KPI chain |
| `fact_campaign_interactions` | **DROP** | CPA not in the chain |
| `dim_macro_environment` | **DROP** | net-deposit / external-rate driver not in the chain |
| `fact_loans`, `fact_account_daily` | **DROP** | already dead — no DDL in schema.sql, no loader, no reader, no extract endpoint. Revisit only if decision D1's interest line grows into an amortisation schedule. |
| `tenant_licenses` | **DROP** | SaaS feature-licensing. D1's `pro_revenue` line is pro-*subscription* transaction data (confirm the exact fundamental with Track C), not this table. |
| `tracking_toggles` | **DROP** | admin feature-toggle product (coordinate removal with Track A — sync doc) |
| `config_audit_log` | **DROP** | admin config audit |
| `ai_reports` | **DROP** | free-form LLM report — violates the golden rule |
| `schema_migrations` | **KEEP → gold** | migration ledger |

### 4.2 Current files

| File | Verdict |
|---|---|
| `ingestion/main.py` | **TRIM** — drop `/events/seed/fast*`, `is_tracking_disabled` + toggle cache, on-prem branch, `FastSeedRequest`; keep mask/validate/Kafka-heal/fallback/size-cap/dead-letter/`/health`; write `bronze.events` |
| `ingestion/envelope.py` | **TRIM** — drop `schema_version`, `_capture_unrecognized_fields`; `validate_event_name` → shape check only (no canonicalise); keep timestamp bounds, event_id policy |
| `ingestion/event_names.py` | **DELETE** — superseded by `pipeline/taxonomy/` (Silver-side, rejects) |
| `ingestion/masking.py` | **KEEP** |
| `pipeline/worker.py` | **KEEP core**, repoint to `bronze.events`, write `_raw` from `msg.value()` |
| `warehouse/config.py` | **TRIM** — drop `DeploymentMode`, `TENANT_ID`, `SYNC_ENABLED`, `CENTRAL_API_URL`, `OLLAMA_URL` |
| `warehouse/client.py` | **TRIM** — `insert_events` drops the canonical-name computation; stop importing `api.page_map`; split raw-insert vs stays generic |
| `warehouse/migrate.py` | **KEEP**, new baseline |
| `warehouse/clickhouse/schema.sql` | **DELETE** → `bronze/ silver/ gold/` layered DDL |
| `warehouse/clickhouse/migrations/*` (19) | **DELETE** |
| `api/main.py` (4176 lines) | **DELETE** — survivors move to `api/dashboard_api/` + `api/metric_api/` |
| `api/insights.py` | **DELETE** — free-form LLM insight path, golden-rule violation |
| `api/data_layer.py` | **DELETE** — heuristic `PRECOMPUTED_LAYER`, superseded by Metric API + Signal Store |
| `api/fast_seed.py` | **MOVE → `pipeline/dev/seed.py`** (§3.7) — fast mode is kept; it writes `bronze.*` + runs transforms, served by a gated `POST /dev/seed` on the pipeline service. Stop importing from `api/intelligence/`. |
| `scripts/seed_data.py` | **KEEP** — slow-mode operator tool + `planted_truth.json` writer; repoint entity names only |
| `api/seed_safexbank.py` | **DELETE** — this is the *second-tenant* seeder (redundant with `seed_data.py`), and it writes with no `event_id`. Not "mock data removal" — `seed_data.py` and `pipeline/dev/seed.py` cover seeding. |
| `api/schemas.py` | **TRIM** — drop `LicenseEntry`/`LicenseSyncRequest`/`TrackingToggleRequest`; keep `OutcomeRequest`/`AskRequest` (move to dashboard_api) |
| `api/middleware.py` | **TRIM** — drop `require_cloud_mode`/`require_tenant_access`; RBAC → persona resolution + Ops revenue filter |
| `api/page_map.py` (846 lines) | **SPLIT** — `URL_MAP`/display names stay (dashboard); `canonicalize_event_name`/`normalize_event`/alias maps → `pipeline/taxonomy/aliases.yaml` |
| `api/websocket_manager.py` | **KEEP** — real-time dashboard pulse; repoint its queries to Metric API |
| `api/insights.py` `query_vllm` / `_get_model_name` | **DELETE** — `api/intelligence/llm_client.py` owns LLM serving |
| `api/intelligence/loaders.py` | **MOVE → `pipeline/extract/`** + split bronze-landing vs silver-derive |
| `api/intelligence/metrics.py` `ClickHouseMetricLayer` | **REPLACE call sites with `MetricAPIClient`**; the SQL moves into `api/metric_api/reads.py` |
| `api/intelligence/facts.py` | **MOVE** the SQL into `api/metric_api/reads.py`; `FactReader` becomes internal to the Metric API |
| `scripts/seed_safexbank`, licensing/toggle scripts | **DELETE** |

### 4.3 Current `api/main.py` endpoints

| Endpoint(s) | Verdict |
|---|---|
| `/metrics/kpi`, `/metrics/secondary_kpi`, `/metrics/traffic`, `/metrics/feature_usage_series`, `/features/usage`, `/funnels` | **REBUILD** on Metric API under `dashboard_api`, keyed to the 5 KPIs |
| `/intelligence/*` (insight, insights, telemetry, sources, recommendations, series, rail, ask, ask/stream, outcome, personas) | **KEEP** — move to `dashboard_api`, already read Signal Store / Metric Layer |
| `/tenants/available`, `/tenants`, `/deployment/info` | **KEEP minimal** — single tenant, trivial responses |
| `/health` | **KEEP** |
| `/metrics/realtime_users`, `/metrics/pages_per_minute`, `/metrics/top_pages` | **KEEP only if** the dashboard's real-time pulse needs them; rebuild on Metric API, else drop |
| `/metrics/devices`, `/metrics/channels`, `/locations` | **DELETE** — these surface the *fabricated* clickstream dimensions; and since `DATA_MODEL.md` puts KPIs on the snapshot, they never feed a number |
| `/metrics/dimension_provenance` | **RECONSIDER — likely KEEP** — `DATA_MODEL.md` makes "measured vs fabricated" a live guard; this endpoint reports it. Rebuild it over the `silver` fabrication registry rather than delete. |
| `/metrics/retention`, `/features/heatmap`, `/features/compare-adoption`, `/features/activity`, `/features/configs`, `/journey/user`, `/journey/users`, `/segmentation/compare`, `/predictive/adoption`, `/tenants/compare`, `/transparency/cloud-data`, `/metrics/pro_users` | **DELETE** — Round 1 adoption-analytics surface |
| `/ai_report` | **DELETE** — golden-rule violation |
| `/license/usage`, `/license/sync` | **DELETE** |
| `/tracking/toggles` (GET/POST) | **DELETE** — coordinate with Track A's `/events/toggles/*` bridge |
| `/config/audit-log`, `/audit_logs` | **DELETE** |
| `/admin/summary`, `/admin/app/{id}/summary` | **DELETE** — super_admin aggregate view |

---

## 5. Phases

Each phase lists: **goal**, **tasks**, **exit criteria**, **unblocks**, **Track A dependency**.

### Phase 0 — Freeze interfaces & decisions (no code)

**Goal:** both Track A and Track C can build against a fixed target.

Decisions D1 (revenue composition) and D2 (signups source) are **made** — see § intro, both now
aligned to `docs/DATA_MODEL.md`'s "every KPI number from the snapshot" section. Track C adapts to
them later. The remaining Phase 0 work is publishing interfaces and the few open items that need
Track A's answer.

**Tasks:**
1. Publish the KPI→fundamental table (§ intro, incl. D1/D2, sourced from `silver.fact_*`) as
   `docs/INTERFACES/kpi_rollups.md` so Track C has the gold schema to write contracts against.
2. Freeze the **event envelope** — publish `docs/INTERFACES/event_envelope.md` from the current
   `forwardToIngestionAPI` shape, minus `schema_version`, plus the decision that the producer
   sends the *raw* instrumented name (no `enforceTaxonomy` coercion).
3. Freeze the **Metric API named-read catalogue** (§3.6) — publish `docs/INTERFACES/metric_api.md`.
4. Freeze the **extract API** contract. Its record shapes now carry **every KPI number**, so
   confirm each keeps the fields the rollups need: `fact_account_openings.opened_at`,
   `fact_loan_applications.{kyc_step, status, decided_at, principal_amount, interest_rate}`,
   `fact_transactions.{status, channel, txn_type, mcc}`, and the measured dims
   (region, branch_code, risk_segment, loan_type). **A4 is back:** `/api/extract/accounts` needs
   the same keyset (`since_id`) fix as the other core endpoints, since signups reads it (D2).
5. Decide reference-data ownership: fee schedule + calendar stay synthesised by Track B, **or**
   move to NexaBank + two new extract endpoints. **Track B default: NexaBank owns them** (matches
   the "source 3 / different cadence" story). Confirm with Track A; if they decline, Track B
   synthesises as today. (Sync doc A5 / open question #2.)
6. Decide `pipeline/taxonomy/aliases.yaml` ownership + PR process. **Track B default:** Track B
   owns the file, Track A opens a PR per instrumentation change.
7. Confirm the fast-mode seeder's new home with Track A (A10): `api/fast_seed.py` →
   `pipeline/dev/seed.py`, served by `POST /dev/seed` on the pipeline service (gated by
   `ENABLE_DEV_SEED`). NexaBank's `?mode=fast` re-points to the new URL. **Fast mode is kept** —
   it is how the intelligence layer gets volume (§3.7). Only the URL and the write target change.

**Exit:** four interface docs published (`kpi_rollups`, `event_envelope`, `metric_api`, and the
sync doc); Track A has answered the reference-data question (task 5) and acknowledged the
`/dev/seed` URL change (task 7).

**Unblocks:** everything.

**Track A dependency:** none — this is the handoff.

### Phase 1 — Warehouse re-layer (DDL + migration reset)

**Goal:** the three databases exist; the old ones are gone.

**Tasks:**
1. Write `warehouse/clickhouse/bronze/` — `events` (`+_raw`, plain MergeTree,
   `ORDER BY (tenant_id, event_name, timestamp, event_id)`), `core_banking` (§3.4),
   `events_dead_letter` (`+ silver_taxonomy_reject`).
2. Write `warehouse/clickhouse/silver/` — `events` (`+ event_name_raw`, `+ fabricated_dims`),
   `sessions` (§3.3), `fact_transactions`, `fact_loan_applications`, `dim_customer`, `dim_branch`,
   `dim_calendar`, `dim_fee_schedule`, `dim_campaign`.
3. Write `warehouse/clickhouse/gold/` — `kpi_daily`, `kpi_daily_by_dim`, `funnel_daily`,
   `source_freshness`, `ingest_watermarks`, Signal Store (lift the 10 tables verbatim, change DB),
   `schema_migrations`.
4. Delete `schema.sql` + all 19 migrations. New `0001_baseline`.
5. `migrate.py`: point `DB` constants at the three databases; add the layer-order apply.
6. `docker-compose.yml`: add the one-shot `migrate` service; remove the ClickHouse initdb mount;
   add `depends_on: migrate` to ingestion/pipeline/analytics-api.
7. `docker compose down -v && up` — verify all three DBs build clean.

**Exit:** `migrate.py --status` shows `0001_baseline` applied; `SHOW DATABASES` = bronze, silver,
gold; every table `DESCRIBE`s as designed.

**Unblocks:** Phases 2–4; Track C can point `contracts_loader` validation at the real schema.

**Track A dependency:** none.

### Phase 2 — Ingestion trim + write bronze

**Goal:** ingestion does mask / validate-shape / event-id / write `bronze.events` (+`_raw`) and
nothing else.

**Tasks:**
1. Strip `is_tracking_disabled` + toggle cache, the on-prem branch, the `settings.is_on_prem`
   path. **Leave `/events/seed/fast*` in place for now** — it relocates to `pipeline/dev/seed.py`
   in Phase 3 (§3.7), and removing it before `/dev/seed` exists would break fast mode.
2. `envelope.py`: drop `schema_version` + `_capture_unrecognized_fields`; `validate_event_name`
   → shape check only.
3. Direct-fallback + `warehouse/client.py insert_events` write `bronze.events` with `_raw`; drop
   `event_name_canonical` computation (Silver owns it now).
4. Keep: size cap, Kafka self-heal + real health probe, validation-fail dead-letter, `/health`.
5. Update `docker-compose.yml` env (drop `DEPLOYMENT_MODE`).

**Exit:** `POST /events` → row in `bronze.events` with populated `_raw`; a bad payload → row in
`bronze.events_dead_letter` (`stage='ingest_validation'`); `/health` honest.

**Unblocks:** Phase 3.

**Track A dependency:**
- Track A must stop sending `schema_version` (harmless if it lingers — field is just ignored) and
  **should** stop running `enforceTaxonomy` (see sync doc). Ingestion no longer rejects on unknown
  names — it defers to Silver — so a coercing producer is *tolerated* but defeats the reject-loudly
  goal.
- Fast-mode seeder (A10) is not touched here — it moves in Phase 3.

### Phase 3 — Pipeline: consumer + transforms + extract

**Goal:** `bronze` → `silver` → `gold` is real code in `pipeline/`.

**Tasks:**
1. **KPI path — do first, it carries every KPI number:**
   - `pipeline/extract/core_banking.py` — moved from `loaders.py`, writes **only**
     `bronze.core_banking`. Keep the watermark/cursor/freshness logic verbatim.
   - `pipeline/transforms/silver_facts.py` — `bronze.core_banking` → `silver.fact_account_openings`
     / `silver.fact_loan_applications` / `silver.fact_transactions` / `silver.dim_*`, collapsed at
     write (no reliance on async merges).
   - `pipeline/extract/reference.py` — fee schedule + calendar (synthesised, or from NexaBank per
     Phase 0 decision).
   - `pipeline/transforms/gold_kpi.py` — `silver.fact_*` → `gold.kpi_daily` + `gold.kpi_daily_by_dim`,
     the fundamental set per KPI from the § intro table. Rates store their two counts, never the
     ratio. Approval volume keys on `decided_at`. Segment cube is over the **measured fact columns**.
2. **Context path — supporting, no KPI number:**
   - `pipeline/worker.py` → `bronze.events`, `_raw` = `msg.value()`.
   - `pipeline/taxonomy/` (§3.2) + `aliases.yaml` merged from the three dialects. Unit tests: every
     currently-seen event name canonicalises or is a deliberate reject.
   - `pipeline/transforms/silver_events.py` — `bronze.events` → `silver.events`: canonicalise or
     dead-letter, verify masking, pin day/UTC, parse `metadata._simulated` → `fabricated_dims`,
     dedup by `event_id`.
   - `pipeline/transforms/silver_sessions.py` (§3.3).
   - `pipeline/transforms/gold_funnel.py` — `silver.events` → `gold.funnel_daily` (kyc funnel, txn
     funnel) — stage/abandonment detail only, never the KPI rate.
3. `pipeline/service.py` — the scheduler: consume loop + timed transform + timed extract, each
   guarded (an unhandled exception must not kill a loop silently — keep the existing pattern from
   `api/intelligence/service.py`).
4. Delete `api/intelligence/loaders.py`; update `api/intelligence/service.py` to drop
   `run_batch_loaders` (moved to `pipeline/service.py`).
5. `pipeline/dev/seed.py` (from `api/fast_seed.py`) + `POST /dev/seed` / `POST /dev/seed/purge`
   on the pipeline service, gated by `ENABLE_DEV_SEED` (§3.7). Writes `bronze.core_banking`
   (+ a `bronze.events` sample), then runs `transforms.run_all(window)`. NexaBank `?mode=fast`
   re-points here; the old ingestion `/events/seed/fast` is removed once this works. Keep
   `purge_tables` scoping and the fixed-seed paired-run behaviour.

**Exit:**
- KPI path: `bronze.core_banking` → `silver.fact_*` → `gold.kpi_daily` / `gold.kpi_daily_by_dim`
  has rows for all 5 KPIs' fundamentals, sourced from the fact tables.
- Context path: `bronze.events` → `silver.events` (+ rejects in dead-letter) → `silver.sessions`
  and `gold.funnel_daily`.
- A seeded run flows **both ways** — slow (`POST /events` → Kafka → bronze) and fast
  (`POST /dev/seed` → bronze) — and a fast-seeded and slow-seeded run of the same shape produce
  the same `gold.*` rows.
- Determinism check: run the transforms twice → byte-identical gold rows.

**Unblocks:** Phase 4.

**Track A dependency:**
- Extract API stable (Phase 0 freeze), incl. the **A4 keyset fix on `/api/extract/accounts`** —
  signups (D2) reads it, so it needs the same `since_id` cursor as the other core endpoints.
- Its record shapes must keep the fields the rollups read (see Phase 0 task 4).
- `metadata._simulated` must keep being emitted — it now only matters for the funnel/journey
  views, not for a KPI, but the fabricated-dim guard still reads it.
- If reference data moves to NexaBank (Phase 0 #5): two new extract endpoints
  (`fee_schedule`, `calendar`).
- **Coordinated (A10):** once `POST /dev/seed` is live (task 5), Track A re-points
  `eventRoutes.ts` `mode:"fast"` from `${ingestion}/events/seed/fast` to
  `${pipeline}/dev/seed`, then Track B removes the old ingestion endpoint. Track B keeps the old
  one alive until the re-point lands, so fast mode is never broken.

### Phase 4 — Metric API

**Goal:** the single doorway is live; tools and dashboard read through it.

**Tasks:**
1. `api/metric_api/main.py` + `reads.py` — implement the §3.6 catalogue over `silver` + `gold`.
   Lift the SQL from `metrics.py` / `facts.py`, keep the exact-aggregate discipline.
2. `api/contracts_loader.py` — move the loader out of `api/intelligence/`; validate `kpi_id` →
   fundamentals/table against the live silver+gold schema; feed the Metric API's `kpi_id`
   resolution.
3. `api/metric_api/client.py` — `MetricAPIClient` implementing `MetricSource`.
4. Track C swap (coordinate — small): `ClickHouseMetricLayer()` → `MetricAPIClient()` in
   `orchestrator` / `service` / `series`. `StubMetricLayer` unchanged.
5. `docker-compose.yml` — Metric API can be its own service or a router inside `analytics-api`;
   start as a router, split later if load warrants.

**Exit:** every §3.6 endpoint returns correct numbers for a seeded tenant; a tool run through
`MetricAPIClient` produces the same Signal Store rows as before; no code outside `api/metric_api/`
issues SQL against `silver`/`gold`; nothing issues SQL against `bronze`.

**Unblocks:** Phase 5, and Track C's stage work against real data.

**Track A dependency:** none.

### Phase 5 — Dashboard API + debloat

**Goal:** `api/main.py` is gone; only the endpoints the Round 2 dashboard needs remain.

**Tasks:**
1. `api/dashboard_api/main.py` — rebuild `/metrics/kpi`, `/funnels`, `/metrics/traffic`, the
   `/intelligence/*` reads, `/tenants*`, `/health` on top of `MetricAPIClient` + Signal Store
   `reader`.
2. RBAC → persona resolution (`resolve_persona`, `selectable_personas`) + the Ops-hides-revenue
   filter. Drop `super_admin`/`app_admin`/`X-Admin-Apps`/`APP_TENANT_SCOPES`/tenant-alias rewrite.
3. `websocket_manager.py` — repoint to Metric API.
4. Delete: `api/main.py`, `api/insights.py`, `api/data_layer.py`, `api/seed_safexbank.py`, the
   dead endpoints (§4.3), the dropped tables' any remaining references.
5. `api/schemas.py` / `api/middleware.py` / `api/page_map.py` trims (§4.2).
6. `docker-compose.yml` — drop `INTELLIGENCE_TENANTS=...,safexbank`, `OLLAMA_URL`, on-prem env.

**Exit:** repo has no `super_admin` / `license` / `tracking_toggle` / `ai_report` code; `grep -r
events_raw api/` returns nothing; the dashboard's KPI/funnel/persona/evidence calls resolve.

**Unblocks:** Track D (whenever it starts).

**Track A dependency:** **coordinated removal** — Track A drops the `/events/toggles/*` bridge and
`enforceTaxonomy`'s toggle enforcement in the same window Track B drops `/tracking/toggles`. Track
A drops `bank_b` seeding, the `bank_b` alias entries, `/events/location` + `/events/admin/locations`
(feed the deleted `/locations` view) — or keeps them harmless and unread. See sync doc.

### Phase 6 — Single-tenant collapse

**Goal:** one bank, everywhere.

**Tasks:**
1. Track B: remove `TENANT_ALIAS_MAP` (bank_a/bank_b), `APP_TENANT_SCOPES`, `TENANT_TO_APP`,
   `normalize_tenant_csv`, `rewrite_tenant_query_aliases`, `tenants_resolve_to_single_app`. Tenant
   is `nexabank`, validated as a constant.
2. Purge `safexbank` from configs, seeds, fixtures, `contracts/*` availability blocks (flag for
   Track C).
3. Keep `tenant_id` as a **column** everywhere (cheap, and the Signal Store determinism story
   wants it) — just stop pretending there is more than one.

**Exit:** `grep -ri safexbank` and `grep -ri bank_b` return only historical comments.

**Track A dependency:** Track A removes `bank_b` tenant from `seedTenants.ts`, the alias maps in
`eventRoutes.ts` / `eventTracker.ts` / `extractShared.ts`, `GLOBAL_*_TENANTS`.

### Phase 7 — Scenario & determinism verification

**Goal:** the four demo scenarios flow through Track B's pipeline (Track C wires the narratives).

**Tasks:**
1. Seed one run → verify each of the four CLAUDE.md §10 scenarios' *source data* lands correctly
   in `bronze` → `silver` → `gold`. Per `DATA_MODEL.md` the planted movements live in the **fact
   tables**, and `gold.kpi_daily_by_dim` cells are keyed on the **measured fact dims** (region,
   branch_code, channel, mcc, loan_type, risk_segment), not clickstream dims:
   - multi-factor movement: revenue drops in `gold.kpi_daily`; `gold.kpi_daily_by_dim` shows the
     planted segment for `kyc_completion_rate` and the `transaction_failure_rate` rise.
   - low confidence / abstain: the calendar/campaign context is readable via `/metric/calendar`
     and `/metric/campaigns`.
   - sparse history: the new KPI has `< min_history_days` points in `gold.kpi_daily`.
   - role entitlement: revenue fundamentals exist in `gold.kpi_daily` so the Ops filter has
     something to remove.
   - write-time collapse held: `silver.fact_*` rows == unique ids after a full re-read.
2. Determinism: full `down -v` → `up` → seed → snapshot `gold.*` → repeat → `diff` is empty.
3. Freshness: stop the extract loop → `/metric/freshness` reports the core-banking source as
   stale within its SLA.
4. Reject path: send an unmapped event name → it appears in `bronze.events_dead_letter`
   (`silver_taxonomy_reject`), not in `silver.events`, not in any KPI.

**Exit:** all four checks pass; the determinism diff is empty.

**Track A dependency:** `scripts/seed_data.py` scenarios still emit the right source data (they do
today). If Simulate-console scenarios need to be checkable, Track A adds a ground-truth writer (see
sync doc — CLAUDE.md §4).

### Phase 8 — Cleanup & docs

**Tasks:**
1. `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md` — reconcile with what was actually built (folder
   tree, DB names, the Metric API).
2. Delete dead `scripts/*` (safexbank, license, toggle helpers, `reconcile_kafka_offsets.py` if
   the offset story changed).
3. `requirements.txt` — drop anything only the deleted code used.
4. Update `CLAUDE.md` §12 folder tree to match.
5. Update the memory note `fininsights-round2-transition.md`.

---

## 6. Parallelism & sequencing

```
Phase 0 ─┬─────────────────────────────────────────────────▶ (Track A starts from sync doc)
         │
         ▼
Phase 1 (warehouse) ──▶ Phase 2 (ingestion) ──▶ Phase 3 (pipeline) ──▶ Phase 4 (metric api)
         │                                             │                        │
         │                                             ▼                        ▼
         └──────────────────────────────────▶ Phase 6 (tenant collapse)   Phase 5 (dashboard api + debloat)
                                                       │                        │
                                                       └────────┬───────────────┘
                                                                ▼
                                                     Phase 7 (verification) ──▶ Phase 8 (cleanup)
```

- Phases 1→2→3→4 are a hard chain.
- Phase 5 can start once Phase 4's client exists; Phase 6 can run any time after Phase 5 begins.
- Track C's real work starts after Phase 4 (real Metric API + real gold data). Until then Track C
  stays on `StubMetricLayer`.
- Track A runs entirely in parallel off the Phase 0 sync doc; the hard rendezvous are the
  `/dev/seed` re-point in Phase 3 and the coordinated removals in Phases 5–6.

---

## 7. Decisions & residual risks

### 7.1 Decisions taken (Track C adapts later — it will build against what Track B ships)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Revenue = `fee_revenue` + `interest_accrued` + `pro_revenue`** (aligned to `DATA_MODEL.md`), derived in the gold transform. `fee_revenue` = `fact_transactions` ⨝ `dim_fee_schedule` (interchange is a fee-schedule row class folded in, not a separate line). `interest_accrued` = approved `principal × rate / 365`, flat daily, not amortised. `pro_revenue` = the one line with no measured money — a `simulated:` contract block; Track B rolls up the pro-subscription fundamental Track C names. No new table, no new extract endpoint. | Uses data already flowing. `fact_loans` / `fact_account_daily` stay dropped unless amortisation is later required. |
| D2 | **Signups = daily snapshot** `silver.fact_account_openings`, `accounts_opened` by `opened_at` — **not** clickstream. | Reversed from the first draft to match `DATA_MODEL.md` ("every KPI number from the snapshot"). `fact_account_openings` **kept**; `/api/extract/accounts` **consumed**; sync-doc A4 **reinstated**. This also **supersedes CLAUDE.md §6**'s clickstream wording — flag §6 for a fix. |
| D3 | **`enforceTaxonomy` handling** — sync doc asks Track A to reduce it to a passthrough. If it still coerces when Phase 3 lands, Silver canonicalises every known name correctly regardless; only the "unknown name fails loudly" benefit is delayed. Not a blocker, no plan change. | The alias map absorbs known names either way. |
| D4 | **Fabricated dims** — `dataset='seeded'` gates Localize on seeded data (today's behaviour), so the engine is usable before Track A's P3 source fix (geo from branch, device from UA). `fabricated_dims` shrinks automatically when that lands. | Track B is ready both ways; no dependency. |
| D5 | **Contract loader move** (`api/intelligence/contracts.py` → `api/contracts_loader.py`) happens in Phase 4 with a heads-up to Track C. `load_all(...)` signature is unchanged. | Track C will see the move and repoint one import. |
| D6 | **`websocket_manager.py`** real-time pulse repoints to a `silver.events` recency read (or `/metric/discover`) in Phase 5. Cosmetic, low-risk. | The pulse never fed a number. |
| D7 | **Fast mode is kept** (§3.7). `api/fast_seed.py` → `pipeline/dev/seed.py`, served by a gated `POST /dev/seed` on the pipeline service; writes `bronze.*` + runs the real transforms so fast- and slow-seeded data are downstream-identical. NexaBank `?mode=fast` re-points to the new URL. | Volume for the intelligence layer is non-negotiable for a hackathon; the only thing that changes is the seeder's home and write target. |
| D8 | **Track B defaults for the two remaining Track-A questions** (confirm in Phase 0, fall back if no answer): reference data → NexaBank owns it; `aliases.yaml` → Track B owns, Track A PRs. | See Phase 0 tasks 5–6 and sync doc §8b. |

### 7.2 Residual risks

| # | Risk | Handling |
|---|---|---|
| R1 | Dashboard (Track D) currently binds to ~40 endpoints Phase 5 deletes. | Track D is a Round 2 rebuild that has not started. Track B ships the Metric API + `/intelligence/*` + the 5-KPI reads; Track D rebuilds against those when it starts. Not Track B's problem to solve now — flag at Track D kickoff. |
| R2 | Track C's eventual `revenue.yaml` may disagree with D1's accrual model, or name a different `pro_revenue` fundamental. | `DATA_MODEL.md` now spells out `fee_revenue` / `interest_accrued` / `pro_revenue` explicitly, so the gap is small. D1 is additive-friendly: the three fundamentals stand alone; an amortisation follow-on adds a fourth without reworking the first three. Confirm the `pro_revenue` fundamental with Track C in Phase 0. |
| R3 | Phase 3's Silver **fact** transform is now the critical-path code (it carries every KPI number); the events/sessions transform is supporting. | Build the fact path first (Phase 3 task 1), verify `gold.kpi_daily` against a seeded run before touching the context path. The determinism check (run twice, diff empty) in Phase 7 is the gate. |
| R4 | `pipeline/taxonomy/aliases.yaml` seeded from three drifted dialects may miss an alias, dead-lettering a live event. | Phase 3 task 2's unit test asserts every currently-seen name resolves or is a deliberate reject. A missed alias surfaces loudly in `bronze.events_dead_letter`, not silently — which is the design intent. |
