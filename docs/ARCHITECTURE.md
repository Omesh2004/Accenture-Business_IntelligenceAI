# ARCHITECTURE.md

The system as it exists now, and exactly where the Phase 1 agentic layer plugs in. This
describes real files. When in doubt, trust the code over this doc and update this doc.

## The five systems

| System | Tech | Port | Entry |
|---|---|---|---|
| Ingestion API | FastAPI + aiokafka | 8000 | `ingestion/main.py` |
| Processor worker | confluent-kafka | - | `processing/worker.py` |
| Analytics API | FastAPI (~3,615 lines) | 8001 | `api/main.py` |
| vLLM server | vllm-openai + GPU | 8002 | `vllm_entrypoint.sh` |
| Analytics dashboard | Next.js 16 | 3001 | `analytics-dashboard/` |
| NexaBank | Express + Prisma | 5000/3002 | `NexaBank/backend/src/server.ts` |
| JavaBank | Spring Boot + JPA | 5001/3000 | `JavaBank/` |
| ClickHouse | OLAP | 8123/9000 | `storage/schema.sql` |
| Kafka + Zookeeper | Confluent 7.4 | 9092 | init-kafka |
| Postgres | Supabase (external) | 5432 | Prisma / JPA |

They share nothing but the event envelope and the tenant vocabulary. Tenant maps and taxonomy
rules are re-implemented in five places; that duplication is a known cost, not a bug to fix now.

## Data flow (telemetry, the primary type)

```
NexaBank UI / backend            (event producers)
  eventTracker.trackEvent  ->  Postgres Event (hashed userId)
                           ->  forwardToIngestionAPI  (UNAWAITED, fire-and-forget)
                                 synthesises geo/device/latency, maps bank_a -> nexabank
  POST /events  (:8000)  ->  validate FeatureEvent (name = 3 lowercase segments or 422)
                         ->  sanitize metadata (email/IPv4 redaction)
                         ->  tracking_toggles check (403 if disabled)
                         ->  Kafka feature-events   (or direct-CH fallback on 5s timeout)
  processing/worker.py   ->  buffer 500 events / 2s  ->  ClickHouse events_raw
  mv_daily_feature_usage ->  rolls up into daily_feature_usage automatically
  api/main.py reads      ->  canonicalize_event_name merges aliases at query time
  dashboard              ->  REST JSON (UI-shaped) + WS METRICS_UPDATE / REALTIME_EVENT
```

Key facts that constrain how you write code:
- FastAPI handlers are `def`, run in Starlette's thread pool, so `ClickHouseClient` builds a
  fresh client per call (clickhouse_connect is not thread-safe). Keep that pattern.
- Every read comes only from ClickHouse. Postgres (bank state) and ClickHouse (telemetry) are
  never joined.
- Bank state (customers, accounts, loans, licenses) lives in Postgres and never reaches
  ClickHouse. `LoanApplication.kycStep` and `.status` are in Postgres.

## Databases

ClickHouse `feature_intelligence`, six tables today: `events_raw` (MergeTree, PARTITION by
month, ORDER BY tenant_id,event_name,timestamp; metadata is a JSON String read with
JSONExtract*), `daily_feature_usage` (AggregatingMergeTree rollup; `unique_users` is
AggregateFunction(uniq) read with uniqMerge), `tenant_licenses`, `tracking_toggles`,
`config_audit_log`, `ai_reports` (ReplacingMergeTree, one row per tenant, range smuggled into
`generated_by`). No migration tooling; `schema.sql` runs only on an empty volume. Full detail
and the Phase 1 additions are in `docs/DATABASE.md`.

## The intelligence layer (what Phase 1 adds)

Today: `api/insights.py` is a vLLM client plus a rule-based fallback, and `/ai_report` makes one
LLM pass over `PRECOMPUTED_LAYER` summaries with a three-layer fallback. That is the piece we
replace.

Target pipeline (all specialists are deterministic, CPU-only, read via the Metric API, write to
the Signal Store):

```
Metric API (:8001)            the only doorway; existing /metrics, /funnels, /journey
      |
Agent Orchestrator            deterministic sequence + optional LLM planning hook
      |  plans
Trust Gate  -> Detect  -> [anomaly?] -> Localize -> Materiality -> [sparse?] -> Forecast
   rule       ruptures/MAD              PSqueeze     sig x impact              cold-start
      |            |                       |            x persistence            wide interval
      +------------+-----------------------+-------------------+------------------+
                                    write findings
                                          v
                                  Signal Store (ClickHouse)
                     anomalies, root_causes, forecasts, recommendations,
                     insights, model_runs, outcomes
                                          |  facts (compact signal cards only)
                                          v
   entitlement filter -> Narrator (vLLM, guided) -> numeric verifier -> insights row
                     drops restricted cards        traces every number    (per persona)
                                          |
                                          v
                     Dashboard AI panel: narrative + evidence card
                     + LLM-vs-non-LLM badge + telemetry
```

Design rules for this layer (enforced by `skills/intelligence-pipeline/SKILL.md`):
- The narrator receives compact signal cards, never raw query output.
- Every number the narrator writes is traced to a Signal Store row within tolerance, else it is
  regenerated, then redacted, then a deterministic template fills it. Keep the fallback.
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
`trust_gate.py`, `detect.py`, `localize.py`, `forecast.py`, `materiality.py`, `signal_store.py`,
`personas.py`) rather than growing `api/main.py`. The narrator/verifier extends `api/insights.py`.
The KPI contract loader reads `contracts/*.yaml`. `/ai_report` becomes a thin reader over the
`insights` table.
