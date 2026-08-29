# ARCHITECTURE.md

The system as it exists now, and exactly where the Phase 1 agentic layer plugs in. This
describes real files. When in doubt, trust the code over this doc and update this doc.

## The deployable systems

| System | Tech | Port | Entry |
|---|---|---|---|
| Ingestion API | FastAPI + aiokafka | 8000 | `ingestion/main.py` |
| Processor worker | confluent-kafka | - | `processing/worker.py` |
| Analytics API | FastAPI (~4,040 lines) | 8001 | `api/main.py` |
| Intelligence service | same image, own scheduler | - | `api/intelligence/service.py` |
| vLLM server | vllm-openai + GPU | 8002 | `vllm_entrypoint.sh` |
| Analytics dashboard | Next.js 16 | 3001 | `analytics-dashboard/` |
| NexaBank | Express + Prisma | 5000/3002 | `NexaBank/backend/src/server.ts` |
| ClickHouse | OLAP | 8123/9000 | `storage/schema.sql` |
| Kafka + Zookeeper | Confluent 7.4 | 9092 | init-kafka |
| Postgres | Supabase (external) | 5432 | Prisma |

They share nothing but the event envelope and the tenant vocabulary. Tenant maps and taxonomy
rules are re-implemented in several places; that duplication is a known cost, not a bug to fix
now. It is also the reason Phase 1 adds **no** new vocabulary layer — KPI contracts name physical
metadata keys directly rather than defining aliases.

## Data flow (telemetry, the primary type)

```
NexaBank UI / backend            (event producers)
  eventTracker.trackEvent  ->  Postgres Event (hashed userId, uuid PK)
                           ->  forwardToIngestionAPI  (UNAWAITED, fire-and-forget)
                                 synthesises geo/device/latency, maps bank_a -> nexabank
  POST /events  (:8000)  ->  validate FeatureEvent (name coerced to 3 lowercase segments)
                         ->  sanitize metadata (email/IPv4 redaction)
                         ->  tracking_toggles check, cached 20s, raw OR canonical name
                         ->  Kafka feature-events   (or direct-CH fallback if unreachable)
  processing/worker.py   ->  buffer 500 events / 2s  ->  ClickHouse events_raw
                         ->  on failure: backoff, isolate, events_dead_letter
  mv_daily_feature_usage ->  rolls up into daily_feature_usage automatically
  api/main.py reads      ->  canonicalize_event_name merges aliases at query time
  dashboard              ->  REST JSON (UI-shaped) + WS METRICS_UPDATE / REALTIME_EVENT
```

Key facts that constrain how you write code:
- **Kafka is the primary path, and for a long time it silently was not.** `ingestion/main.py`
  connected once in its lifespan handler; compose declared `depends_on: broker` with no
  `condition: service_healthy`, so it lost that race, set `producer = None`, and never retried.
  Every event took the direct-ClickHouse fallback, `feature-events` sat at LOG-END-OFFSET 0,
  and `processing/worker.py` had never executed at all. The producer now reconnects lazily and
  the broker has a healthcheck. `GET /health` reports `ingest_path`: if it says
  `clickhouse_fallback`, the worker is idle and nothing is buffering in Kafka.
- Delivery is at-least-once. `events_raw` is now `ReplacingMergeTree(_inserted_at)` ordered by
  `(tenant_id, event_name, timestamp, event_id)`, so a worker replay is collapsed **on merge** —
  but not before one runs, and merge timing is not something a reader controls. Reads are safe
  either way because every reader counts `uniqExact(event_id)`. Verified end to end on the
  previous plain-`MergeTree` shape: replaying 5 events took raw rows 5 -> 10 while `/metrics/kpi`
  stayed put.
  **The engine change has a consequence nothing else records:** `count() == uniqExact(event_id)`,
  the `dedup_integrity` hard invariant `contracts/kyc_completion_rate.yaml` builds scenario 1 on,
  becomes true again once a merge collapses a real replay. Whether the Trust Gate sees a duplicate
  storm therefore depends on whether a merge has run. See `docs/PROPOSAL.md` §2 Block D-ii for the
  three options and the recommendation.
- The worker applies backpressure rather than buffering without bound, retries with backoff,
  and parks rows that fail individually in `events_dead_letter` so one poison message cannot
  stall the partition. It probes ClickHouse with `SELECT 1` to tell "the sink is down, hold
  and replay" from "this batch is malformed, dead-letter it".
- FastAPI handlers are `def`, run in Starlette's thread pool, so `ClickHouseClient` builds a
  fresh client per call (clickhouse_connect is not thread-safe). Keep that pattern.
  `ingestion/main.py` is the exception: its handlers are `async def`, so blocking
  clickhouse_connect calls there go through `asyncio.to_thread` or they stall the event loop
  for every concurrent request.
- Tracking toggles are cached with a short TTL and matched against BOTH the raw and the
  canonical event name. The dashboard writes canonical keys and producers send raw ones; when
  ingest checked only the raw name, disabling a feature in the admin UI did nothing at all.
- Every read comes only from ClickHouse. Postgres (bank state) and ClickHouse (telemetry) are
  never joined.
- Bank state (customers, accounts, loans, licenses) lives in Postgres and never reaches
  ClickHouse. `LoanApplication.kycStep` and `.status` are in Postgres.
- `validate_event_name` in `core/models.py` **coerces** rather than rejecting: an unrecognised
  name is wrapped as `core.<name>.action` rather than raising 422. Silent renaming, not silent
  dropping, is the common failure here.
- The worker commits Kafka offsets **after** the ClickHouse insert, asynchronously. Delivery is
  at-least-once.

## The producer paths — four modules, two of them inert

| | `scripts/seed_data.py` (demo) | `eventTracker.ts` (live NexaBank) | `NexaBank/frontend/lib/tracker.ts` | `analytics-dashboard/src/lib/tracker.ts` |
|---|---|---|---|---|
| live? | **yes** | **yes** | **no — `track()` is never called** | **no — nothing imports it** |
| `session_id` | stable, one per session | from `x-session-id` header | `sessionStorage` | `sessionStorage` |
| geo / device | one profile per session, fabricated | one profile cached per session, fabricated | would be real, from `useGeoLocation` | would be `window.innerWidth` |
| event names | canonical, emitted directly | `LEGACY_MAP` + `enforceTaxonomy` | straight to ingest dialect | straight to ingest dialect |
| `event_id` | minted per event | Postgres `Event.id` | `crypto.randomUUID()` | **absent — would 422** |

**This table used to claim three live paths, one of which supplied real geo. Verified by grep, it
does not.** `nexaTracker.track()` has no call site — the only three are `setUser()` (the file's own
docstring admits this). `analytics-dashboard`'s `tracker` and `useAutoTrack` are imported by
nothing. So **two paths are live, and live geo, device and channel come from
`eventTracker.ts`'s `selectGeoProfile`/`selectDevice` dice roll** unless a real signal supplied
them — `sessionProfile.realCountry`/`realCity`/`realContinent`, populated from `POST /events/location`,
win when present. Every event carries `metadata._simulated` listing exactly the keys it invented,
so a fabricated dimension is declared rather than indistinguishable from a measured one.

Both live paths are session-grain. The live path was not until the `x-session-id` interceptor
actually reached the network: it was registered only on an `apiClient` axios instance that
**nothing imported**, so `getSessionId()` fell through to a fresh `server-<uuid>` per event, which
in turn meant the per-session geo/device cache (keyed on `session_id`) never hit. Measured before
the fix: 41 events across 41 sessions, 10 locations, 4 devices. After: 5 events, 1 session,
1 location, 1 device.

**Session-invariant is not the same as localizable.** FOUNDATION-2 made the dimension additive; it
did not make it informative. `metadata._simulated` now names the invented keys and
`contracts.sliceable_dimensions` refuses them on any dataset but `seeded`, so localizing on
`location` or `device_type` from the live path is blocked rather than merely discouraged.

Run `python scripts/verify_data_quality.py` on the host to re-assert this rather than trusting the
table.

Note that a browser path posting straight to `POST /events` would skip `enforceTaxonomy`, so only
two of the three dialects apply to it — currently moot, since neither browser path emits.
`pro.new_feature.view` is the one name where the two dialects disagree (Node strips the reserved
`pro.` prefix, Python preserves it); an alias in `api/page_map.py` converges them.

Note also that `location` holds a **country** value. There is no `country` key anywhere.

## Ingest routing and the worker

`POST /events` (`ingestion/main.py`) does, in order: validate `FeatureEvent` → sanitize metadata →
read cached tracking toggles → match against **both** the raw and canonical name → 403 if disabled
→ Kafka first in cloud mode → direct `events_raw` insert if Kafka is unreachable or times out.
On-prem skips Kafka entirely: validate the configured tenant, anonymize `user_id`, insert direct.
The fallback is deliberate — analytics availability must never block banking telemetry.
`GET /health` reports which path is live.

`processing/worker.py`: consumer group `feature-processor-group`, `auto.offset.reset=earliest`,
manual commits, batch 500, flush every 2s. Offsets commit only after a durable insert, so delivery
is at-least-once. Failure handling is three-way — a temporary ClickHouse outage backs off and
holds the batch while pausing consumption; individual poison rows go to `events_dead_letter`; a
whole failed batch is probed with `SELECT 1` to tell "sink down, replay" from "batch malformed,
dead-letter".

## The three batch sources (retail banking model)

The clickstream is one source among four, and deliberately the least trustworthy: its geo and
device dimensions are synthesised per session. The three batch sources below carry **measured**
dimensions, which is why the retail KPIs may localize on `region` and the telemetry KPIs may not.

| Source | id | Grain | Cadence | SLA | NexaBank tables |
|---|---|---|---|---|---|
| Clickstream | `nexabank_clickstream` | event | real time | 15 min | `Event` |
| A — Core banking | `nexabank_core` | transaction, account, card, application | hourly batch | 2 h | `Transaction`, `Account`, `Card`, `LoanApplication`, `Loan` |
| B — CRM & marketing | `nexabank_crm` | customer, campaign, interaction | weekly | 7 d | `Customer`, `Campaign`, `CampaignInteraction` |
| C — Branch ops & macro | `market_ops` | branch, region-month | monthly | 31 d | `Branch`, `MacroEnvironment` |

Every source reaches ClickHouse through a **watermarked extract API** on the NexaBank side
(`/api/extract/*`, guarded by `x-extract-token`), never a direct database connection: the
credentials stay in one service and the contract between systems is explicit.

The cadences differ by three orders of magnitude on purpose. A single global freshness rule
cannot gate them — 15 minutes is healthy for the clickstream and impossible for a monthly macro
feed — which is why Trust Gate scales the freshness floor by grain and checks each source
separately.

### Why source C exists

`dim_macro_environment` holds `competitor_deposit_rate`, `central_bank_base_rate` and
`regional_unemployment_rate` per region per month. It is the only place an **external** driver
can come from. When deposits fall in one region and no internal segment explains it, the engine
has somewhere to reach; without it, every "cause" would necessarily be internal, and the
multi-factor requirement would be satisfied only in appearance.

Nothing in the data records that a competitor rate rise *caused* an outflow. That inference is
the engine's job, and it may only reach `corroborated_cause` when both the internal segment and
the external factor are present — otherwise it degrades to `attribution`.

## Databases

ClickHouse `feature_intelligence`. Seven operational tables, the ten Signal Store tables, and
sixteen retail-source and bookkeeping tables:

- `events_raw` — **`ReplacingMergeTree(_inserted_at)`**, PARTITION BY month,
  ORDER BY `(tenant_id, event_name, timestamp, event_id)`; `metadata` is a JSON String read with
  `JSONExtract*`. Carries `kafka_partition`/`kafka_offset`/`kafka_topic`/`ingested_at`/
  `ingest_path` as well. `event_name_canonical` is written once at ingest (P0-6) and is what the
  MV groups on; read-time canonicalisation in Python is gone.
- `daily_feature_usage` — AggregatingMergeTree rollup. `event_count` and `unique_users` are both
  `AggregateFunction(uniqExact, String)` read with `uniqExactMerge` (FOUNDATION-4 landed; the old
  plain `total_events UInt64` is gone, and P0-6 replaced `unique_users`' `uniq` HyperLogLog state).
  `raw_rows` is `AggregateFunction(sum, UInt64)` — rows as INSERTED, which survives the
  `ReplacingMergeTree` merges that erase a replay from `events_raw` and is what `dedup_integrity`
  compares against. Keyed on the **canonical** `event_name`, so aliases of one feature are one row
  and their states merge. Carries no session state, so no session-grain ratio can be served from it.
- `events_dead_letter` — worker poison rows and pre-Kafka validation failures, distinguished by
  `stage`.
- `tenant_licenses`, `tracking_toggles`, `config_audit_log`, `ai_reports` (ReplacingMergeTree, one
  row per tenant, range smuggled into `generated_by`).
- Signal Store (Phase 1): `investigations`, `trust_findings`, `anomalies`, `root_causes`,
  `forecasts`, `causal_effects`, `recommendations`, `insights`, `model_runs`, `outcomes`.
- Retail banking facts and dimensions (sources A, B, C): `fact_transactions`,
  `fact_loan_applications`, `fact_loans`, `fact_account_daily`, `fact_account_openings`,
  `fact_cards`, `fact_campaign_interactions`, `dim_customer`, `dim_campaign`, `dim_branch`,
  `dim_macro_environment`, `dim_calendar`, `dim_fee_schedule`.
- Loader and runner bookkeeping: `source_freshness`, `ingest_watermarks`, `schema_migrations`.

**Migrations run through `storage/migrate.py`** (P1-2). It records every applied file in
`schema_migrations` by name and content hash, so re-running is a no-op and an *edited* migration is
reported rather than silently skipped. `storage/migrations/` holds eighteen SQL files. `schema.sql`
still runs only on an empty volume, so an already-migrated database must be baselined before the
first apply or historic migrations replay against it. Full detail, the four Foundation fixes and
the Phase 1 additions are in `docs/DATABASE.md`.

## Read paths

The dashboard never queries ClickHouse directly. Everything goes through `api/main.py` on :8001,
which builds a fresh `ClickHouseClient` per query (handlers are `def` and run in Starlette's
thread pool; the client is not thread-safe).

| API group | Returns |
|---|---|
| `/metrics/kpi`, `/metrics/secondary_kpi` | KPI cards, period change, latency |
| `/metrics/traffic`, `/metrics/feature_usage_series` | time series |
| `/metrics/devices`, `/metrics/channels`, `/locations`, `/metrics/top_pages` | metadata breakdowns |
| `/metrics/realtime_users`, `/metrics/pages_per_minute`, `/metrics/retention`, `/metrics/pro_users` | activity and retention |
| `/features/usage`, `/features/activity`, `/features/heatmap` | feature aggregates |
| `/funnels` | ordered counts via `windowFunnel` — **user-grain, display only** |
| `/journey/user`, `/journey/users` | per-user and per-session journeys |
| `/license/usage`, `/segmentation/compare` | entitlement (two disagreeing sources — see `docs/TASK.md` P2-5) |
| `/predictive/adoption`, `/tenants/compare` | heuristics presented as metrics (`docs/TASK.md` P3-15) |
| `/admin/summary`, `/admin/app/{tenant_id}/summary`, `/transparency/cloud-data` | admin rollups |
| `/tenants/available`, `/features/compare-adoption`, `/metrics/pro_users`, `/deployment/info` | scope and catalog |
| `/insights`, `/ai_report` | legacy AI path, not yet replaced — see below |
| `/audit_logs`, `/tracking/toggles`, `/license/sync`, `/config/audit-log` | configuration and audit |
| `/intelligence/*` | Signal Store reads and the query agent — see `docs/PIPELINE_CONTRACT.md` §8 |

Most accept comma-separated `tenants` and a `range` (`7d`/`30d`/`90d`).

Dashboard side: `useDashboard.ts` resolves active app from the URL, tenant scope from the session,
and range from Redux, then calls typed methods in `lib/api.ts`. The main batch fires ~17 parallel
requests every 15s per open tab — keep new endpoints out of it.

```
page -> useDashboardData() -> dashboardAPI -> axios :8001 -> ClickHouse -> UI-shaped JSON -> Redux/React Query
```

## Identity and app scoping

Google OAuth → NextAuth JWT → role and `adminApps` looked up in `rbac.json` → sent to the API as
`X-User-Email`, `X-User-Role`, `X-Admin-Apps`, `X-Active-App`. Roles: `super_admin` (aggregates
only), `app_admin` (detailed analytics for assigned tenants), `user` (no access).

**The API trusts those headers, and the browser sets them** — `AuthGuard` is a route guard, not
authorization, and :8001 is published to the host. See `docs/TASK.md` P2-1.

The `(main)` route group shapes the shell without appearing in URLs; `[appName]` scopes the app
(`/nexabank/dashboard`), with app-scoped pages re-exporting the unscoped implementations.
`buildAppScopedPath()` writes those URLs and `resolveAppIdFromPathname()` reads them back into a
tenant list. The app suite maps `nexabank` to both the `nexabank` and `safexbank` tenants — the URL
selects a scope, never a different database.

## The intelligence layer

Built, and running as the `intelligence` service. The legacy path it was meant to replace is still
live alongside it: `api/insights.py` is a vLLM client plus a rule-based fallback, and `/ai_report`
still makes one LLM pass over `PRECOMPUTED_LAYER` summaries (defined in `api/data_layer.py`) with a
three-layer fallback. Turning `/ai_report` into a reader over `insights` has not happened yet.

The pipeline (all specialists are deterministic, CPU-first, read via the Metric Layer or KPI
contracts, and write to the Signal Store):

```
Metric API (:8001)            the only doorway; existing /metrics, /funnels, /journey
      |
scheduled batch:  Forecast  ->  forecasts table (the band Detect scores against)
      |
Agent Orchestrator            deterministic sequence + optional LLM planning hook
      |
Foundation -> Trust Gate -=FAIL=->  incident note (business path terminates)
 event_id      verdict                        |
 sessions      + fingerprint                  |
                   | PASS                     |
                Detect -> Localize -> Causal -> Decide
                residual   additive   evidence   proposal
                vs band    causes     rung       owner/lever
                   |          |          |          |
                   +----------+----------+----------+
                            write findings
                                  v
                          Signal Store (ClickHouse)
        trust_findings, anomalies, root_causes, forecasts,
        causal_effects, recommendations, insights, model_runs, outcomes
                                  |  facts (compact signal cards only)
                                  v
   entitlement filter -> Narrator (vLLM, guided) -> numeric verifier -> insights row
                     drops restricted cards        traces every number    (per persona)
                                  |
                                  v
                 Dashboard AI panel: narrative + evidence card
                 + LLM-vs-non-LLM badge + telemetry
```

Build-order numbering (00-08 in `docs/PHASE_1.md`) is **not** execution order: Forecast runs first
as a scheduled batch because its prediction interval is what Detect scores residuals against.
Trust Gate is a gate, not a step — a `fail` terminates the business path entirely.

Design rules for this layer (enforced by `skills/intelligence-pipeline/SKILL.md`):
- The narrator receives compact signal cards, never raw query output.
- Every number the narrator writes is traced to a Signal Store row within tolerance, else it is
  regenerated, then redacted, then a deterministic template fills it. Keep the fallback.
- Localize operates on additive fundamentals at the contract's `grain.entity`, never on a rate.
  This is a correctness requirement, not a style preference — see `docs/KPI_CONTRACT.md`.
- Forecast, causal, and recommendation stages must write intervals or caveats rather than
  point-only claims when assumptions are weak.
- Every specialist run and LLM call writes a `model_runs` row tagged with `engine_type`. The
  LLM-vs-non-LLM breakdown is computed from that table, not asserted by the model.
- Personas read the same signal cards; entitlement is applied before the narrator, so a
  restricted number cannot be phrased or back-computed into the output.

## Real-time

`websocket_manager.py` fans out per tenant, consumes Kafka on `websocket-broadcaster-group`
(`auto_offset_reset=latest`), and polls ClickHouse every 10s to broadcast `METRICS_UPDATE`.
Phase 1 pushes only two things live: the KPI header counters (existing) and a new-insight ping.
Do not add Redis or a second real-time system; single instance is fine for the demo.

## Where the pipeline code lives

`api/intelligence/`, not `api/main.py`. Stages are a sub-package; everything else sits at the top
level.

| Group | Files |
|---|---|
| Control flow | `orchestrator.py` (stages + Observe), `service.py` (the three scheduler loops) |
| Substrate | `metrics.py` (Metric Layer), `facts.py` (fact tables), `loaders.py` (sources A/B/C), `contracts.py`, `signal_store.py`, `reader.py`, `ids.py`, `config.py` |
| Stages | `stages/trust_gate.py`, `detect.py`, `localize.py`, `decompose.py`, `forecast.py`, `causal_decide.py`, `narrate.py`, `llm_narrator.py` |
| Query agent | `agent.py`, `loop.py`, `planner.py`, `tools.py`, `matching.py`, `phrasing.py`, `personas.py`, `llm_client.py` |

Causal and Decide share one module; there is no `foundation.py` (stage 00 is substrate, not code
here) and no `observe.py` (Observe is `Orchestrator._record_run`). The KPI contract loader reads
`contracts/*.yaml` and needs `PyYAML`. See CLAUDE.md rule 2 for the approved library set.
