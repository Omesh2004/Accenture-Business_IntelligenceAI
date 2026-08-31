# Track B audit — current vs proposed

Scope: `ingestion/`, `pipeline/`, `warehouse/`, `api/` (the Metric API half; `api/intelligence/`
is Track C but is referenced where Track B code has leaked into it).

Proposal source: `CLAUDE.md` + `docs/SOLUTION.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`,
`docs/INTELLIGENCE.md`. Nothing here proposes an approach the docs do not; where the docs leave a
real gap it is called out under **Missing puzzle pieces**.

Legend:
- **MATCH** — current workflow already does what the proposal asks; keep as-is.
- **CHANGE** — current workflow contradicts the proposal and must be reworked.
- **CUT** — current workflow does more than the proposal asks; remove for debloat.
- **GAP** — the proposal needs something that is not designed anywhere.

---

## 1. Executive summary

The current codebase is the **Round 1 "Feature Adoption Analytics" product**. Track B's job for
Round 2 is largely a **teardown and re-layer**, not a patch:

| Area | Verdict |
|---|---|
| Warehouse layering (bronze/silver/gold) | **CHANGE** — does not exist. One flat `feature_intelligence` DB with ~30 peer tables — the exact anti-pattern `DATA_MODEL.md` documents as the prototype's mistake. |
| Metric API as the only doorway | **CHANGE** — `api/main.py` runs ~45 dashboard endpoints with inline raw SQL against `events_raw` (48 refs) and `daily_feature_usage` (28 refs). No single named-read doorway. |
| Ingestion (mask / id / validate) | **MATCH** on the core three; **CUT** the seeding, toggle-enforcement, on-prem and multi-tenant extras bolted onto it. |
| Pipeline (kafka → bronze → silver → gold) | **CHANGE** — `pipeline/worker.py` only does kafka → `events_raw`. No silver/gold transform code anywhere. |
| Kafka consumer robustness | **MATCH** — dead-letter, poison isolation, backpressure, commit-after-insert, dedup token: all solid. |
| Signal Store schema | **MATCH** — all 10 tables present, `investigation_id` spine, Trust-Gate-writes-passes. Only the DB name differs. |
| Daily-snapshot extract | **MATCH** on mechanics (watermarks, per-source freshness, idempotent replay); **CHANGE** its location — it lives in `api/intelligence/loaders.py`, not `pipeline/`. |
| Migration runner | **MATCH** — `warehouse/migrate.py` is better than the docs specify. |
| Determinism discipline | **MATCH** — `uniqExact`-only, id tiebreakers, `TZ=UTC`, `toDate(now('UTC'))`, two-sided windows in newer code, write-boundary rounding. |
| Multi-tenant / licensing / on-prem / feature-toggle / ai_report machinery | **CUT** — none of it is in Round 2 scope. |

---

## 2. Warehouse — `warehouse/`

### 2.1 Three-layer split — **CHANGE (largest single item)**

**Proposed** (`DATA_MODEL.md`): three ClickHouse databases.
- `bronze` — raw, immutable, append-only, **no `ReplacingMergeTree`** ("Bronze must not collapse
  anything, because a duplicate arriving twice is itself the evidence the Trust Gate reads"). Read
  by the pipeline only. Tables: `bronze.events`, `bronze.core_banking`, `bronze.events_dead_letter`.
  Every row carries `event_id`/`record_id`, `_ingested_at`, `_source_id`, `_kafka_partition`,
  `_kafka_offset`, `_raw` (untouched payload).
- `silver` — cleaned/conformed: canonical names resolved once at write, deduped by `event_id`,
  PII masked, **sessions rebuilt**, day/timezone pinned, **rejects rather than coerces** unknown
  names. Read by the Metric API only. Tables incl. `silver.events`, `silver.sessions`,
  `silver.fact_*`, `silver.dim_*`, plus a **per-row declaration of which attributes were
  fabricated**.
- `gold` — serving: narrow-long KPI rollups (`gold.kpi_daily` = tenant×kpi×date×fundamental),
  the segment cube (`gold.kpi_daily_by_dim`), `gold.funnel_daily` (stage counts, so a rate is
  always derived from counts), and the Signal Store. Read by Metric API, tools, dashboard.
- **The dashboard and tools never read Bronze** — "not as a convention — Bronze is a separate
  database and the read paths do not have it in scope."

**Current** (`warehouse/clickhouse/schema.sql`): one database `feature_intelligence`, every table
a peer:
- Raw: `events_raw` — but it is `ReplacingMergeTree(_inserted_at) ORDER BY (tenant_id,
  event_name, timestamp, event_id)`. It **tries to dedup** (contradicts the Bronze rule), and it
  **already carries silver concerns**: `event_name_canonical` computed at write, PII already
  masked upstream, kafka metadata columns. Bronze and Silver are mashed into one table.
- No `_raw` untouched-payload column on successful rows. The verbatim payload survives **only in
  `events_dead_letter.payload` on failure**. A taxonomy-fix replay (`DATA_MODEL.md`: "Replay
  after a taxonomy fix reads `bronze.events` — everything, deliberately, offline") is impossible:
  the only copy was canonicalised and masked in place.
- Rollup: only `daily_feature_usage` (tenant×**event_name**×date, `uniqExact` states + `raw_rows`
  sumState). Grain is event-name, not kpi/fundamental. No `kpi_daily`, no `kpi_daily_by_dim`
  segment cube, no `funnel_daily`. Localize builds its cube **on the fly from `events_raw`** in
  `api/intelligence/metrics.py` — a tool reading raw Bronze, which the proposal forbids twice.
- Facts + dims (`fact_transactions`, `fact_loan_applications`, `fact_account_openings`,
  `fact_cards`, `fact_campaign_interactions`, `dim_customer`, `dim_branch`, `dim_calendar`,
  `dim_campaign`, `dim_fee_schedule`, `dim_macro_environment`) — sit in the same DB as raw events
  and the Signal Store. These are silver-grain but not in a silver DB, and are written **directly
  by the HTTP extract** (`loaders.py`) with no bronze landing copy.
- Signal Store: `investigations`, `trust_findings`, `anomalies`, `root_causes`, `forecasts`,
  `causal_effects`, `recommendations`, `insights`, `model_runs`, `outcomes` — all peers of raw
  events.
- Operational tables that should not be in an analytics warehouse at all: `tenant_licenses`,
  `tracking_toggles`, `config_audit_log`, `ai_reports` (see **CUT**).

**What matches within this:**
- `events_dead_letter` — shared by ingestion + worker, `stage` column distinguishes writers,
  replayable verbatim payload. Maps cleanly to `bronze.events_dead_letter`. **MATCH.**
- `daily_feature_usage.raw_rows` (sumState of rows-as-inserted, survives merges) is exactly the
  `DATA_MODEL.md` rule "Row counts as inserted are kept alongside deduplicated counts". **MATCH**
  — carry the idea into `gold.kpi_daily`.
- Distinct counts stored as `AggregateFunction(uniqExact, String)` states, not plain columns —
  matches "Distinct counts are aggregate states, not plain columns". **MATCH.**
- Facts are `ReplacingMergeTree(_version)` keyed on the source's own `updated_at` — matches "a
  full replay of any extract is idempotent". **MATCH.**

**Action for Track B:** create `bronze` / `silver` / `gold` databases; split `events_raw` into
`bronze.events` (plain `MergeTree`, `+ _raw`) and `silver.events` (`ReplacingMergeTree`, canonical,
masked, deduped); add `silver.sessions`; build `gold.kpi_daily`, `gold.kpi_daily_by_dim`,
`gold.funnel_daily`; move the Signal Store DDL under `gold`; move `tenant_licenses` /
`tracking_toggles` / `config_audit_log` / `ai_reports` out of the warehouse (or delete — see CUT).

### 2.2 Migration runner — **MATCH (exceeds the spec)**

`warehouse/migrate.py`: idempotent ledger in `schema_migrations`, name + content-hash, `--status`,
`--baseline`, and an explicit **refuse-to-apply** when the schema looks migrated but the ledger is
empty (`_looks_migrated()`). This directly satisfies `DATA_MODEL.md` / `ARCHITECTURE.md`:
"Baseline an existing database before the first migration run", "an edited migration is detected
rather than silently re-applied". Keep it. Only change: when the bronze/silver/gold rebuild lands,
collapse the 19-file migration history to a clean baseline (see CUT 4.7).

### 2.3 `warehouse/client.py` — **MATCH, with one CHANGE**

- Fresh client per call, explicit `connect_timeout`/`send_receive_timeout`, client closed after
  query (fd leak fix) — all good, keep.
- `insert_events()` computes `event_name_canonical` at write via `api.page_map.canonicalize_event_name`
  — this is **Silver work done in the Bronze writer**. Under the new split, the raw insert writes
  `bronze.events` with no canonical column; a silver transform computes it. **CHANGE.**
- `warehouse/client.py` importing from `api.page_map` is a layering inversion (warehouse depends
  on api). See **GAP 5.2** (canonicalisation dialect ownership).

### 2.4 `warehouse/config.py` — **CUT the deployment-mode split**

`DeploymentMode` CLOUD/ON_PREM, `TENANT_ID`, `SYNC_ENABLED`, `CENTRAL_API_URL`, `OLLAMA_URL` +
`VLLM_URL` both. Round 2 is one bank, one deployment, vLLM (Ollama only as a starting fallback).
Keep: Kafka + ClickHouse settings. Drop the mode enum and the on-prem federation fields.

---

## 3. Ingestion — `ingestion/`

### 3.1 Mask / assign-id / validate — **MATCH (mostly)**

`CLAUDE.md` §11: "Receives events, masks personal data, assigns a deterministic event id (so
retries cannot double-count), validates the event shape."

- **Mask** — `ingestion/masking.py` `sanitize_metadata()` recurses metadata, redacts email + IPv4.
  MATCH (basic, but sufficient for the brief).
- **Validate shape** — `ingestion/envelope.py` `FeatureEvent`, plus timestamp bounds
  (`MAX_EVENT_AGE_S` / `MAX_EVENT_SKEW_S` — closes the "far-future event counted forever" trap in
  `ARCHITECTURE.md`). MATCH.
- **Deterministic event id** — **partial CHANGE**. Current impl *requires* a non-empty
  `event_id` from the producer and 422s if missing; it does not *assign* one. `ARCHITECTURE.md`
  step 3 and `CLAUDE.md` §11 both say ingestion "assigns a deterministic event id". Either update
  the doc to "validates that the producer supplied one", or have ingestion derive
  `hash(tenant, source, payload)` when absent. Today every producer sends one, so this is latent,
  not broken — but the contract is ambiguous.

### 3.2 Kafka producer robustness — **MATCH**

Lazy self-healing producer, per-cooldown retry, `drop_producer()` on mid-send failure, real broker
probe in `/health` (`fetch_all_metadata`, not cached `cluster.brokers()`), `_ingest_stats` with
`ingest_path` — this is the fix for the `ARCHITECTURE.md` "silent Kafka fallback" trap, and it is
done well. `key=tenant_id` on `send_and_wait` matches "one topic, partitioned by tenant". Keep.

### 3.3 Direct-ClickHouse fallback — **MATCH the concept, CHANGE the target**

Fallback with bounded retry/backoff, honest `ingest_path` labelling (`fallback_cloud` /
`fallback_onprem`), never assumes `kafka` — matches "Forwarding outcomes are counted, because the
Trust Gate cannot otherwise tell 'the KPI dropped' from 'the forwarder broke'". Under the new
split it must write `bronze.events` (with `_raw`), not `events_raw`.

### 3.4 Ingestion extras — **CUT**

Bolted onto the ingestion service, none of it in the `CLAUDE.md` §11 responsibility list:

| Item | Why cut |
|---|---|
| `POST /events/seed/fast`, `/events/seed/fast/purge` (+ `FastSeedRequest`) | Seeding belongs in `nexabank/simulate/` (`CLAUDE.md` §12). Pulls `api.fast_seed` → `api.intelligence.loaders` into the ingestion image: a cross-track dependency ingestion should not have. |
| `is_tracking_disabled()` + toggle cache + 403-on-disabled-feature | Reads `feature_intelligence.tracking_toggles`. Admin feature-toggle product surface from Round 1. Not in Round 2. |
| `settings.is_on_prem` branch (anon user hash, tenant check, direct insert) | On-prem federation is not Round 2. One code path, not two. |
| `schema_version` field + `_capture_unrecognized_fields` | Envelope's own comment: "mostly future-proofs a scenario this repo doesn't have yet — a rolling deploy where an older ingestion service receives events shaped by a newer producer." Speculative. |
| `CORSMiddleware allow_origins=["*"]` on the ingestion app | Ingestion takes machine-to-machine POSTs from NexaBank; it does not need permissive browser CORS. |

Keep in ingestion: `MAX_EVENT_BODY_BYTES` cap, the `RequestValidationError` → dead-letter handler
(matches "a payload that fails validation ... reached `events_dead_letter`"), `/health`.

---

## 4. Pipeline — `pipeline/`

### 4.1 Kafka consumer → warehouse — **MATCH**

`pipeline/worker.py`: batch + manual offset commit **after** successful insert (at-least-once),
`flush_batch()` with retry/backoff then poison-row isolation, `_sink_is_reachable()` to tell
"ClickHouse down" from "row is poison", pause/resume backpressure (`_should_poll`, keeps the
consumer in the group past `max.poll.interval.ms`), `on_revoke` synchronous flush, undecodable-
message dead-lettering, `insert_deduplication_token` from ordered `event_id`s. This is a careful,
correct consumer and it matches the determinism + at-least-once story. Keep essentially as-is.

### 4.2 Bronze → silver → gold transforms — **CHANGE (they do not exist)**

`CLAUDE.md` §12: `pipeline/` = "kafka consumer **and the bronze → silver → gold transforms**".
`DATA_MODEL.md`: Silver "is where every correctness rule is applied exactly once" — canonicalise,
dedup, mask, **rebuild sessions**, pin the day, **reject** unknown names.

Current: the worker writes `events_raw` and stops. There is **no transform stage**. "Silver" work
is smeared across:
- write time — `event_name_canonical` in `warehouse/client.py` and `ingestion/main.py`;
- read time — `DEDUP_EVENT_KEY` re-implemented **three times** (`api/main.py`,
  `api/data_layer.py`, `mv_daily_feature_usage` SQL) and applied in every query;
- an MV — `mv_daily_feature_usage` is the only "gold" transform, defined in `schema.sql`, not in
  pipeline code.

Session reconstruction does not happen at all (see GAP 5.4). Unknown names are **coerced**
(`core.<name>.action`) not rejected (see GAP 5.2).

**Action:** build the transform layer in `pipeline/` — `bronze.events` → `silver.events` (+
`silver.sessions`), `silver.*` → `gold.kpi_daily` / `gold.kpi_daily_by_dim` / `gold.funnel_daily`.
Whether via ClickHouse MVs, scheduled `INSERT ... SELECT`, or Python is an implementation choice;
the code and DDL must live under `pipeline/` + `warehouse/clickhouse/{silver,gold}/`.

### 4.3 Daily banking snapshot extract — **MATCH mechanics, CHANGE location**

`api/intelligence/loaders.py` (674 lines) is the source-2/3 batch extract: paged HTTP pull from
NexaBank's `/api/extract/*`, watermark + `cursor_id` resume (`ingest_watermarks`), per-source
freshness with per-cadence SLA (`source_freshness`), `mark_source_failed()` that preserves
`max_source_ts` so a broken source cannot look fresh, branch-fingerprint watermark invalidation,
`_reconcile()` for full-re-read sources. This is a genuinely good implementation of "the daily
extract pulls loan, account and ledger state ... into the same Bronze layer with its own source id
and its own freshness watermark".

Two problems:
1. **Location.** `CLAUDE.md` §12/§13 put the extract in `pipeline/` and make it Track B's. It is
   in `api/intelligence/` (Track C) and is invoked by `api/intelligence/service.py`'s
   `run_batch_loaders()` loop. Move `loaders.py` → `pipeline/`.
2. **No bronze landing.** It writes `fact_transactions` / `fact_loan_applications` / etc. directly
   (silver grain). `DATA_MODEL.md` wants `bronze.core_banking` ("one row per extracted record")
   first, so silver facts can be re-derived without re-hitting NexaBank. **CHANGE.**

`fast_seed.py` also imports column lists (`TXN_COLUMNS`, `APP_COLUMNS`, …) from `loaders.py` — that
coupling moves with the file.

### 4.4 `daily_feature_usage` MV — **CHANGE grain**

Matches the *pattern* the proposal wants (pre-aggregate, `uniqExact` states, `raw_rows` for replay
detection) but the *grain* is wrong: event-name, not kpi×fundamental. Replace with
`gold.kpi_daily` fed from `silver`, keyed by the contract's fundamentals.

---

## 5. Metric API — `api/`

### 5.1 "The only doorway" — **CHANGE (fundamental)**

`CLAUDE.md` §11: "Metric API. Python, FastAPI. The only doorway into the warehouse. Named,
tenant-scoped reads. No tool and no agent writes raw SQL against raw tables; they call the Metric
API." §12: `api/` = "FastAPI service on 8001 (the Metric API and endpoints)".

**Current state of `api/main.py` (4176 lines, ~45 endpoints):**
- Every dashboard endpoint hand-writes SQL inline against `events_raw` (48 occurrences) and
  `daily_feature_usage` (28). Examples: `/metrics/kpi`, `/features/usage`, `/funnels`,
  `/metrics/traffic`, `/metrics/secondary_kpi`, `/metrics/feature_usage_series`,
  `/features/heatmap`, `/locations`, `/journey/user`, `/predictive/adoption`, `/metrics/retention`,
  `/metrics/devices`. This is the opposite of a named-read doorway.
- There **is** a "Metric Layer" — `api/intelligence/metrics.py` `ClickHouseMetricLayer` — with a
  `MetricSource` Protocol, exact-aggregate discipline (`_agg` forces `uniqExact`), gap-filled
  series, a `StubMetricLayer` for tests. This is the right shape. But:
  - it is an **in-process Python class, not a FastAPI service / HTTP contract**;
  - it **reads `events_raw` directly** (Bronze) because there is no Silver to read — its docstring
    claims "Stages never touch events_raw" while the layer does so on their behalf;
  - only `api/intelligence/` uses it; the dashboard does not.
- The intelligence read endpoints (`/intelligence/insight`, `/intelligence/telemetry`,
  `/intelligence/series`, …) **do** go through `reader.py` (Signal Store only) and `series.py`
  (metric layer). `/intelligence/series`'s docstring — "Read through the Metric Layer, so the
  chart and the narrative are computed by the same code" — is precisely the target philosophy,
  applied to exactly one endpoint. **MATCH (as a template for the rest).**

**Action:** promote the Metric Layer to *the* Metric API: a FastAPI surface of named,
tenant-scoped, contract-driven reads over `silver` + `gold`; repoint every dashboard KPI/funnel/
series endpoint at it; delete the inline `events_raw` SQL. Publish the named-read catalogue as the
"Metric API" interface from `CLAUDE.md` §13 (see GAP 5.5).

### 5.2 RBAC / personas — **MATCH the persona idea, CUT the SaaS scaffolding**

- `resolve_persona()` / `selectable_personas()` from `rbac.json`, server-side, "a requested
  persona is honoured only when the caller's ROLE lists it" — matches `INTELLIGENCE.md` "A
  persona is resolved server-side. A requested persona is honoured only if the caller role allows
  it". **MATCH.** Keep.
- `RBACMiddleware` `super_admin` / `app_admin` / `X-Admin-Apps` / `X-Active-App` /
  `APP_TENANT_SCOPES` / cross-app comparison guards / `TENANT_ALIAS_MAP` (bank_a/bank_b) — a
  multi-app SaaS entitlement model. Round 2 is one bank, three personas (CFO / Ops / Risk).
  `ARCHITECTURE.md` even lists "the identity headers are asserted, not proven" as a **known gap,
  not a control**. **CUT** down to persona resolution + the entitlement filter that removes
  revenue from the Ops view. (Entitlement enforcement itself is Track C.)

### 5.3 Signal Store DDL + reader — **MATCH**

`schema.sql` Signal Store block ↔ `DATA_MODEL.md` "The Signal Store" table: `investigations`,
`trust_findings` (**incl. passes** — `blocks_narrative`, suppression-rate audit), `anomalies`,
`root_causes`, `forecasts` (own `forecast_id`, scheduled batch), `causal_effects` (`rung`),
`recommendations` (`expected_impact` JSON interval), `insights` (per persona), `model_runs`
(`investigation_id` always set, `engine_type` sql|stats|rules|ml|llm), `outcomes`. Every row keyed
by `investigation_id`. `investigations.watermark_ingested_at` pins the run. This is a faithful
implementation. Only change: move under `gold`.

### 5.4 Cadence reconciliation — **MATCH**

`source_freshness` (per-source SLA), `ingest_watermarks` (`cursor_id`), `FactReader.source_freshness()`,
`ClickHouseMetricLayer.freshness_minutes()` (event-time, not ingest-time) — the pieces for "compute
against the oldest common data time, and if they are too far apart we say so or abstain" exist.
Consumed by Track C's Trust Gate; Track B owns keeping the tables fed (loaders + a clickstream
freshness recorder).

### 5.5 Determinism — **MATCH**

- `uniqExact` / exact aggregates only — `metrics.py._agg`, `facts.py.FACT_AGGREGATIONS` whitelist
  (`sum, count, uniqExact, min, max`), no `uniq`/`quantile`/`topK`/`any` in metric paths.
- Unique tiebreakers in `ORDER BY` (`event_id`, `txn_id`, `cause_id`, `rank`).
- Window pinned once by the orchestrator (`Window` frozen dataclass, `service.py.current_window()`
  on whole UTC midnights), never `now()` inside a stage.
- `TZ=UTC` pinned in compose; `toDate(now('UTC'))` used, `today()` avoided — matches the trap.
- Two-sided time windows (`>= start AND < end`) in the metric layer and newer endpoints — matches
  "Bound every window at both ends". (Older `api/main.py` endpoints are inconsistent; they go away
  with the rewrite.)
- Money as `Decimal` in `loaders.py` (`_money`), `Decimal64(2)` in fact DDL — matches "revenue ==
  sum(price*qty) fails for reasons that have nothing to do with the business" if float is used.

---

## 6. Missing puzzle pieces (needed by the proposal, designed nowhere)

1. **`_raw` payload retention.** `DATA_MODEL.md` Bronze mandates an untouched-payload column so a
   taxonomy-fix replay is possible. No current table keeps the verbatim payload for **successful**
   rows (only `events_dead_letter` on failure). This is a concrete new schema + writer change the
   docs assume exists.

2. **Which canonicalisation dialect is Silver's, and where the alias map lives.** Three dialects
   exist — `ingestion/event_names.py` (ingest, **coerces**), `api/page_map.py`
   (`canonicalize_event_name`, analytics, 846 lines, imported by ingestion + warehouse + api), and
   a NexaBank Node dialect. `ARCHITECTURE.md` coupling-point-2 flags the drift. `DATA_MODEL.md`
   Silver says "canonicalises the name, once ... **rejects rather than coerces**". The docs do not
   say which dialect wins, where the one vocabulary file lives, or how `warehouse/` stops
   depending on `api/page_map.py`. Needs a decision before the silver transform can be written.

3. **Sessionisation.** `DATA_MODEL.md` Silver: `silver.sessions` "one row per session, with its
   resolved attributes", and "Rebuilds sessions". Current: `session_id` is whatever the producer
   put in `metadata.session_id`; there is no session entity, no attribute resolution, no
   reconstruction. `dimension_invariance()` already assumes a session grain that nothing builds.
   This is a non-trivial new build the plan states as a one-liner.

4. **Migration strategy across the rebuild.** `migrate.py` is good, but nothing says who runs it
   or when (no compose service; manual `docker compose exec`). Moving to bronze/silver/gold needs
   an explicit "baseline the old `feature_intelligence` DB, then start the new migration line"
   plan, and the 19 existing migrations (many multi-step online-rename dances for a fresh-volume
   prototype) need a collapse-to-baseline decision.

5. **The Metric API HTTP contract.** `CLAUDE.md` §13 lists "The Metric API (the named reads the
   tools and dashboard call)" as one of the **four interfaces to agree first**. That catalogue
   does not exist as a spec — the `MetricSource` Protocol in `metrics.py` is the nearest artifact
   and it is Python-internal. Track B should publish it (endpoint list, params, response shapes)
   as `docs/` before the dashboard and tools build against it.

6. **`bronze.core_banking` landing table + extract→bronze split.** `loaders.py` writes silver
   facts straight from HTTP. The plan wants a bronze copy of every extracted record first. No DDL,
   no writer.

7. **Dead schema referenced by the plan's cadence story.** `fact_account_daily` (the daily
   *balance* snapshot — "a third grain and a third cadence") and `fact_loans` are defined in
   `migrations/2026-08-28_multi_source_facts.sql` but appear in **no** current `schema.sql`, are
   loaded by **nothing**, and are absent from `facts.py.FACT_TABLES`. If the revenue chain needs a
   balance snapshot, someone has to actually build its loader; if not, delete the DDL.

---

## 7. Debloat — things the current workflow does beyond the proposal (**CUT**)

Ordered roughly by size of removal.

| # | Cut | Location | Rationale |
|---|---|---|---|
| 7.1 | The Round 1 dashboard endpoint surface: `/metrics/realtime_users`, `/metrics/pages_per_minute`, `/metrics/top_pages`, `/metrics/devices`, `/metrics/channels`, `/locations`, `/metrics/retention`, `/metrics/dimension_provenance`, `/features/heatmap`, `/features/compare-adoption`, `/features/activity`, `/features/configs`, `/journey/user`, `/journey/users`, `/segmentation/compare`, `/predictive/adoption`, `/transparency/cloud-data`, `/metrics/pro_users`, `/tenants/compare` | `api/main.py` | "Feature adoption analytics" product. Not the 5-KPI intelligence-to-action engine. `/locations` + `/metrics/devices` + `/metrics/dimension_provenance` surface exactly the **fabricated** geography/device dimensions the plan says must not be shown. |
| 7.2 | `/ai_report` + all of `api/insights.py` (`generate_insights`, `query_vllm`, `_get_model_name`) | `api/main.py` ~L3504–3978, `api/insights.py` (213 lines) | A second LLM path that asks the model for "3 strategic insights" as free-form JSON over heuristic context — **directly violates the golden rule** (LLM emitting claims not traced to a stored signal). Duplicates LLM-client logic that `api/intelligence/llm_client.py` owns. `ai_reports` table goes with it. |
| 7.3 | `api/data_layer.py` (`PRECOMPUTED_LAYER`, `start_data_layer_refresh`, `fetch_tenant_summaries`) | `api/data_layer.py` (104 lines) | In-memory dict refreshed every 30 min by `error`/`fail` `LIKE` heuristics over `events_raw`. Superseded by Signal Store + Metric Layer. Re-implements `DEDUP_EVENT_KEY` a third time. |
| 7.4 | Multi-tenant machinery: `safexbank` as a second tenant, `TENANT_ALIAS_MAP`, `APP_TENANT_SCOPES`, `TENANT_TO_APP`, `normalize_tenant_csv`, `rewrite_tenant_query_aliases`, cross-app guards, `INTELLIGENCE_TENANTS=nexabank,safexbank` | `api/main.py`, `docker-compose.yml`, `api/seed_safexbank.py` | Round 2 is one bank. `seed_safexbank.py` also writes via `ch_client.insert_events` with **no `event_id`** (falls to the legacy concat dedup branch). |
| 7.5 | SaaS licensing + admin config: `tenant_licenses` table, `/license/usage`, `/license/sync`, `LicenseSyncRequest`; `tracking_toggles` table, `/tracking/toggles` GET/POST, `TrackingToggleRequest`; `config_audit_log` table, `/config/audit-log`; `/audit_logs` | `api/main.py`, `api/schemas.py`, `schema.sql` | Round 1 product surface. Personas + `rbac.json` replace it. |
| 7.6 | Deployment-mode split: `DeploymentMode` enum, `is_on_prem`/`is_cloud`, on-prem branch in `ingestion/main.py`, `require_cloud_mode` / `require_tenant_access` in `api/middleware.py`, `SYNC_ENABLED`, `CENTRAL_API_URL` | `warehouse/config.py`, `ingestion/main.py`, `api/middleware.py` | On-prem federation is not Round 2. Removes an entire parallel ingest path. |
| 7.7 | Migration-file sprawl | `warehouse/clickhouse/migrations/` (19 files) | Multi-step online rename dances (`events_raw_v2_shadow_table` → `_backfill` → `_repoint_mv` → `_swap`) for a fresh-volume prototype. Collapse to one baseline when bronze/silver/gold lands. |
| 7.8 | Dead DDL: `fact_loans`, `fact_account_daily` | `migrations/2026-08-28_multi_source_facts.sql` | Defined once, never in `schema.sql`, never loaded, never read. Delete or actually build (see GAP 7). |
| 7.9 | Facts/dims for KPIs the plan drops: `fact_cards`, `dim_macro_environment`, `fact_campaign_interactions` (+ `dim_campaign` beyond the abstain scenario) | `schema.sql`, `loaders.py`, `facts.py` | The 5-KPI chain (signups, kyc_completion_rate, loan_approval_volume, revenue, transaction_failure_rate) needs `fact_transactions`, `fact_loan_applications`, `fact_account_openings`, `dim_fee_schedule`, `dim_calendar`, `dim_campaign`, `dim_customer`, `dim_branch`. Card activations, macro environment, and campaign-interaction facts support CPA / net-deposit / product-activation KPIs that are **not** in the plan. **Verify against the final Track C contract set before deleting.** |
| 7.10 | `schema_version` envelope field, `_unrecognized_fields` capture | `ingestion/envelope.py` | Self-described as future-proofing "a scenario this repo doesn't have yet". |
| 7.11 | `OLLAMA_URL` alongside `VLLM_URL`; third hardcoded model default in `insights.py` | `warehouse/config.py`, `api/insights.py` | Pick one LLM serving path. |

---

## 8. Suggested Track B sequence

1. **Agree the two interfaces Track B owns** (`CLAUDE.md` §13): the event envelope (mostly stable
   — resolve the "assign vs require event_id" wording and drop `schema_version`) and the **Metric
   API named-read catalogue** (GAP 5.5). Publish both in `docs/`.
2. **Resolve the canonicalisation-dialect decision** (GAP 5.2) — pick the one Silver vocabulary,
   decide where it lives, break `warehouse/` → `api/page_map` dependency.
3. **Stand up `bronze` / `silver` / `gold` databases** + DDL under `warehouse/clickhouse/{bronze,silver,gold}/`.
   Move Signal Store DDL under `gold`. Add `_raw` to `bronze.events`.
4. **Repoint ingestion + worker** at `bronze.events`; strip the ingestion extras (CUT 3.4).
5. **Build the transform layer in `pipeline/`**: `bronze → silver.events` + `silver.sessions`;
   `silver → gold.kpi_daily` / `gold.kpi_daily_by_dim` / `gold.funnel_daily`.
6. **Move `loaders.py` → `pipeline/`**, add the `bronze.core_banking` landing step.
7. **Promote the Metric Layer to the Metric API** (FastAPI over silver+gold); repoint the surviving
   dashboard endpoints; delete inline `events_raw` SQL and the CUT 7.1 endpoints.
8. **Debloat pass**: CUT 7.2–7.11.
9. **Migration baseline** (GAP 5.4) and a compose service (or documented step) that runs
   `migrate.py` on deploy.
