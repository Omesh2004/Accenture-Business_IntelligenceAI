# CLAUDE.md

Entry point for Claude Code. Read this fully before touching anything.

## What this repo is

FinInsights is a product-analytics platform for multi-tenant fintech software, plus one
demo banking app (NexaBank) that generate its telemetry. One monorepo, five
deployable systems joined by exactly two contracts: an HTTP event envelope (`POST /events`)
and a tenant-id vocabulary. There is no shared library, no shared DB, no shared types.

Deep map: `docs/ARCHITECTURE.md`. Do not rediscover the architecture by grepping; read it first.

## Current task: Phase 1

We are replacing the simple `/ai_report` feature with an **agentic investigation pipeline**.
The full definition, scope boundary, and Definition of Done are in `docs/PHASE_1.md`.
Read it before planning any change. If a request is not in Phase 1 scope, stop and flag it.

One-line goal: when a KPI moves, run Trust Gate -> Detect -> Localize -> Materiality ->
(Forecast if sparse) -> Narrate, record every finding in a Signal Store, and render a
persona-specific narrative with a traceable evidence card and an LLM-vs-non-LLM breakdown.
The LLM narrates and lightly plans; it is never the source of a number.

## How to work on this repo

Understand -> Plan -> show me the plan -> Implement -> Test -> Verify.
Do not write code before showing a plan for anything beyond a one-file edit. Prefer the
smallest change that satisfies the Phase 1 item. Reuse existing code; this repo already
does most of Phase 1 (funnels, journeys, sessions, retention, AI report all exist).

## Key commands

- Whole stack: `docker compose up` (dashboard :3001, NexaBank :3002/:5000,
  Ingestion :8000, Analytics API :8001, vLLM :8002, ClickHouse :8123, Kafka :9092).
- ClickHouse schema (`storage/schema.sql`) auto-runs ONLY on an empty volume. Applying a
  schema change to a running stack requires manual DDL. See `docs/DATABASE.md`.
- There are no tests and no CI today. Add tests only where `docs/PHASE_1.md` requires them.

## The five coupling points (break one and something silently 404s or vanishes)

Before you touch any of these, read the referenced doc. These are the only places a small
edit has large, non-obvious blast radius.

1. **Event envelope** `core/models.py` (`FeatureEvent`). Contract between 3 producers and the
   pipeline. Changing it touches every producer.
2. **Event taxonomy** lives in THREE dialects that disagree on singular/plural
   (`enforceTaxonomy` in Node, `validate_event_name` on ingest, `canonicalize_event_name` on
   read). Adding or renaming an event without updating all three makes it land in `events_raw`
   but vanish from every chart. Use the `event-taxonomy` skill.
3. **Tenant vocabulary** four independent maps must agree (`lib/feature-map.ts`,
   `APP_TENANT_SCOPES`/`TENANT_TO_APP`/`KNOWN_TENANTS` in `api/main.py`, `rbac.json`).
   Miss one and the WebSocket closes with 1008 and requests 403.
4. **RBAC header trio** the `lib/api.ts` axios interceptor and `RBACMiddleware` are a matched
   pair. Rename a header on one side and everything 403s.
5. **ClickHouse schema** every analytics endpoint references tables/columns by literal name.
   No migration runner, no compile check. A renamed column is a runtime 500 or a silently
   empty list. See `docs/DATABASE.md`.

## Mandatory rules

1. Do NOT implement Phase 2 items (see the Deferred list in `docs/PHASE_1.md`). If Phase 1
   seems to need one, stop and ask.
2. Do NOT add infrastructure (Cube, dbt, Neo4j, Redis, OpenLineage, a vector store, a
   migration framework). Phase 1 uses only what is already running.
3. The LLM never produces a number that reaches the user unverified. Every number in a
   narrative must trace to a Signal Store row (numeric verifier). Specialists compute numbers;
   the narrator only phrases them. See the `intelligence-pipeline` skill.
4. Specialists and the agent read data ONLY through the Metric API / metric functions, never
   raw SQL against `events_raw`, and write findings to the Signal Store.
5. Do NOT introduce a new dependency without stating why in the plan.
6. Do NOT change an analytics endpoint's response shape without updating its `lib/api.ts`
   method, its `types/index.ts` type, and every consumer. Watch handlers called internally by
   `/ai_report` and `/admin/app/{id}/summary`.
7. Preserve the "telemetry never blocks banking" rule: forwarding stays fire-and-forget.
8. Tag every produced number with its engine (`llm`/`sql`/`stats`/`ml`/`rule`) so the
   LLM-vs-non-LLM breakdown is real, not narrated.

## Never do

- Never delete or merge the duplicate `/insights` route blindly. One def (~:571) is the
  cached LLM variant HTTP callers hit; the other (~:3430) is the rule-based one that
  `/admin/app/{id}/summary` calls by function name. Read the `analytics-endpoint` skill first.
- Never `docker compose down -v` to apply a schema change on anything with data you want.
- Never commit secrets. Note: live Supabase credentials are already committed in
  `scripts/nexbank_user_lookup.py` and `scripts/javabank_user_lookup.py`. Do not add more;
  flag those for rotation, but do not "fix security" as part of Phase 1 (that is Phase 2).
- Never fabricate a metric silently. Response time, geo, and device are synthesised in the
  forwarding layer today; anything derived from them must be labelled simulated in the UI.

## Always do

- Canonicalise event names before aggregating (`canonicalize_event_name`).
- Use a fresh ClickHouse client per call (`ClickHouseClient`), `%(name)s` bound params, and the
  standard tenant-filter idiom (see `analytics-endpoint` skill).
- Write new findings to the Signal Store and read them back in the narrator; do not pass raw
  query output into the LLM context.
- Keep the three-layer `/ai_report` fallback so a demo never shows a stack trace.

## Where to find things

| Need to... | Read |
|---|---|
| Understand the system | `docs/ARCHITECTURE.md` |
| Know Phase 1 scope / DoD | `docs/PHASE_1.md` |
| Change ClickHouse / add Signal Store tables | `docs/DATABASE.md` |
| Define or read a KPI contract | `docs/KPI_CONTRACT.md`, `contracts/*.yaml` |
| Add or rename a tracked event | `skills/event-taxonomy/SKILL.md` |
| Add or change an Analytics API endpoint | `skills/analytics-endpoint/SKILL.md` |
| Build a specialist, the agent, or the narrator | `skills/intelligence-pipeline/SKILL.md` |
