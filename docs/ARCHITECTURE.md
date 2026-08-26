# ARCHITECTURE.md

The system as it exists now, and exactly where the Phase 1 agentic layer plugs in. This
describes real files. When in doubt, trust the code over this doc and update this doc.

## The deployable systems

| System | Tech | Port | Entry |
|---|---|---|---|
| Ingestion API | FastAPI + aiokafka | 8000 | `ingestion/main.py` |
| Processor worker | confluent-kafka | - | `processing/worker.py` |
| Analytics API | FastAPI (~3,610 lines) | 8001 | `api/main.py` |
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
- Delivery is at-least-once and `events_raw` never deduplicates, so a worker replay genuinely
  doubles rows. That is safe ONLY because every reader counts `uniqExact(event_id)`. Verified
  end to end: replaying 5 events took raw rows 5 -> 10 while `/metrics/kpi` stayed put.
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
  at-least-once, and `events_raw` is a plain `MergeTree` that never deduplicates.

## The three producer paths

| | `scripts/seed_data.py` (demo) | `eventTracker.ts` (live NexaBank) | `lib/tracker.ts` (browser) |
|---|---|---|---|
| `session_id` | stable, one per session | from `x-session-id` header | `sessionStorage` |
| geo / device | one profile per session | one profile cached per session | real, from `useGeoLocation` |
| event names | canonical, emitted directly | `LEGACY_MAP` + `enforceTaxonomy` | straight to ingest dialect |
| localizable | **yes** | **yes** | yes, once geo resolves |

All three are now session-grain and localizable. The live path was not until the `x-session-id`
interceptor actually reached the network: it was registered only on an `apiClient` axios instance
that **nothing imported**, so `getSessionId()` fell through to a fresh `server-<uuid>` per event,
which in turn meant the per-session geo/device cache (keyed on `session_id`) never hit. Measured
before the fix: 41 events across 41 sessions, 10 locations, 4 devices. After: 5 events, 1 session,
1 location, 1 device.

Run `python scripts/verify_data_quality.py` to re-assert this rather than trusting the table.

Note the browser path skips `enforceTaxonomy` entirely -- it posts straight to `POST /events`, so
only two of the three dialects apply to it. `pro.new_feature.view` is the one name where the two
dialects disagree (Node strips the reserved `pro.` prefix, Python preserves it); an alias in
`api/page_map.py` converges them.

Note also that `location` holds a **country** value. There is no `country` key anywhere.

## Databases

ClickHouse `feature_intelligence`, six tables today: `events_raw` (MergeTree, PARTITION by
month, ORDER BY tenant_id,event_name,timestamp; metadata is a JSON String read with
JSONExtract*), `daily_feature_usage` (AggregatingMergeTree rollup; `unique_users` is
AggregateFunction(uniq) read with uniqMerge, but `total_events` is a plain `UInt64` that silently
decays on merge — see FOUNDATION-4), `tenant_licenses`, `tracking_toggles`, `config_audit_log`,
`ai_reports` (ReplacingMergeTree, one row per tenant, range smuggled into `generated_by`). No
migration tooling; `schema.sql` runs only on an empty volume. Full detail, the four Foundation
fixes, and the Phase 1 additions are in `docs/DATABASE.md`.

## The intelligence layer (what Phase 1 adds)

Today: `api/insights.py` is a vLLM client plus a rule-based fallback, and `/ai_report` makes one
LLM pass over `PRECOMPUTED_LAYER` summaries (defined in `api/data_layer.py`) with a three-layer
fallback. That is the piece we replace.

Target pipeline (all specialists are deterministic, CPU-first, read via the Metric API or KPI
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

## Where Phase 1 code should live

Put the new pipeline in a new package (suggested `api/intelligence/`: `orchestrator.py`,
`contracts.py`, `foundation.py`, `trust_gate.py`, `detect.py`, `localize.py`, `forecast.py`,
`causal.py`, `decide.py`, `signal_store.py`, `personas.py`, `observe.py`) rather than growing
`api/main.py`. The narrator/verifier extends `api/insights.py`. The KPI contract loader reads
`contracts/*.yaml` and needs `PyYAML`, the one new runtime dependency Phase 1 requires.
`/ai_report` becomes a thin reader over the `insights` table.
