# CLAUDE.md

Entry point for Claude Code. Read this fully before touching anything.

## What this repo is

FinInsights is a product-analytics platform for multi-tenant fintech software, plus one
demo banking app (NexaBank) that generate its telemetry. One monorepo, five
deployable systems joined by exactly two contracts: an HTTP event envelope (`POST /events`)
and a tenant-id vocabulary. There is no shared library, no shared DB, no shared types.

Deep map: `docs/ARCHITECTURE.md`. Do not rediscover the architecture by grepping; read it first.

## Current task: Phase 1

We are replacing the simple `/ai_report` feature with an **agentic investigation pipeline** of
nine stages, only one of which writes English. The full definition, scope boundary, and Definition
of Done are in `docs/PHASE_1.md`. Read it before planning any change. If a request is not in
Phase 1 scope, stop and flag it.

One-line goal: when a KPI moves, run Foundation -> Trust Gate -> Detect -> Localize -> Causal ->
Decide -> Narrate, with Forecast running beforehand as a scheduled batch supplying the band
Detect scores against, and Observe recording every stage. Record every finding in a Signal Store
and render a persona-specific narrative with a traceable evidence card and an LLM-vs-non-LLM
breakdown. The LLM narrates and lightly plans; it is never the source of a number.

**Build-order numbering is not execution order,** and Trust Gate is a gate, not a step: a `fail`
verdict terminates the business path and routes an engineering note instead. The claim this
defends is measurable, not rhetorical: **seven of nine stages reason rather than report, one
touches the GPU, zero need training data** — computed from `model_runs.engine_type`.

## How to work on this repo

Understand -> Plan -> show me the plan -> Implement -> Test -> Verify.
Do not write code before showing a plan for anything beyond a one-file edit. Prefer the
smallest change that satisfies the Phase 1 item. Reuse existing code; this repo already
does most of Phase 1 (funnels, journeys, sessions, retention, AI report all exist).

Verify claims about the taxonomy, a canonical event name, or a metric by **running the function**,
not by reading the code. Most of this repo's failures are silent renames, not exceptions.

## Key commands

- Whole stack: `docker compose up` (dashboard :3001, NexaBank :3002/:5000,
  Ingestion :8000, Analytics API :8001, vLLM :8002, ClickHouse :8123, Kafka :9092).
- ClickHouse schema (`storage/schema.sql`) auto-runs ONLY on an empty volume. Applying a
  schema change to a running stack requires manual DDL. See `docs/DATABASE.md`.
- Check what an event really becomes:
  ```bash
  .venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'.'); \
    from api.page_map import canonicalize_event_name as c; print(c('loan.approved.success'))"
  ```
- Verify the telemetry is fit to build on: `python scripts/verify_data_quality.py`
  (host, stack up; needs `node`, `requests`, `PyYAML` — no ClickHouse driver).
- Produce a KPI movement to investigate: the admin simulation console at
  NexaBank `/admin/simulate`, or `POST /events/simulate` with a `behavior` block. It records
  **no** ground truth — the movement exists only as the shape of the events. See
  `docs/SCENARIOS.md`.
- There are no tests and no CI today. Add tests only where `docs/PHASE_1.md` requires them.

## Foundation: the four bugs stages 01-08 stand on — all four now land

Detail, DDL, and the traps each one hid in are in `docs/DATABASE.md`.

1. **`event_id`** — the Postgres `Event.id` UUID that `eventTracker.ts` mints. Do *not* hash
   (source id + sequence + timestamp): there is no source sequence, so it collides.
2. **`session_id`** — carried from the browser via `x-session-id`, and the geo/device profile is
   cached once per session. Session grain is what makes ratio localization additive; this is a
   correctness requirement, not a nicety.
3. **Taxonomy remaps** — all three contracts reach every lineage event on both producer paths.
4. **The rollup** — `event_count AggregateFunction(uniqExact, String)`, read with
   `uniqExactMerge`. Fixes the silent decay of a plain column inside an `AggregatingMergeTree`
   *and* makes counts idempotent under worker replay.

**Do not take that list on trust — it was wrong before.** Fixes 2 and 3 were recorded as
`resolved` in the KPI contracts while both were still inert: the `x-session-id` interceptor was
registered on an axios instance no file imported, and the `LEGACY_MAP` remaps fixed keys the code
never calls. Both failures were silent and neither showed up in any chart.

```bash
python scripts/verify_data_quality.py     # 16 checks; exit 0 only when all pass
```

It runs the real Node `enforceTaxonomy` by evaluating that function's own source rather than
reimplementing it, so it cannot drift from the dialect it is checking. Run it after touching any
producer, the taxonomy, or the schema.

## The six coupling points (break one and something silently 404s or vanishes)

Before you touch any of these, read the referenced doc. These are the only places a small
edit has large, non-obvious blast radius.

1. **Event envelope** `core/models.py` (`FeatureEvent`). Contract between 3 producers and the
   pipeline. Changing it touches every producer. Note `validate_event_name` **coerces** rather
   than rejecting — it wraps unknown names as `core.<name>.action`.
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
6. **Dimension vocabulary and grain** KPI contracts name **physical metadata keys** — there is no
   renaming layer, deliberately. `location` holds a country value; there is no `country` key.
   `channel` is the exception: it is a top-level `events_raw` **column**, not a metadata key, so
   reading it with `JSONExtractString(metadata, 'channel')` returns empty on every row.
   `tier` exists live but not in seeded data. A contract may only localize dimensions that are
   invariant within its `grain.entity`, or contribution shares are meaningless. See
   `docs/KPI_CONTRACT.md`.

## Mandatory rules

1. Do NOT implement Phase 2 items (see the Deferred list in `docs/PHASE_1.md`). If Phase 1
   seems to need one, stop and ask.
2. Do NOT add infrastructure or libraries. The reference artifact names `ruptures`, `PSqueeze`,
   `Chronos`, `CausalImpact`, `DoWhy`, `Evidently`, `Langfuse` — **none are Phase 1
   dependencies**. Phase 1 is deterministic and uses what is running, with robust statistics
   pushed into ClickHouse. The one new runtime dependency is `PyYAML`, for the contract loader.
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
9. A KPI whose contract `readiness.status` is `blocked` must return `fail:not_instrumented` from
   Trust Gate. Never let it fall through to reading zero and narrating a phantom decline.
10. Every Signal Store row carries `investigation_id`. Do NOT hang the audit trail off
    `anomaly_id` — a Trust Gate failure produces a narrative with no anomaly, and `model_runs`
    rows are written by stages that run before any insight exists. See `docs/DATABASE.md`.
11. Personas (`cfo`/`ops_manager`/`analyst`) do not exist in `rbac.json` yet. Resolve a persona
    server-side; a persona query parameter must never widen access. See `docs/PIPELINE_CONTRACT.md`.

## Never do

- Never delete or merge the duplicate `/insights` route blindly. One def (`api/main.py:566`) is
  the cached LLM variant HTTP callers hit; the other (`api/main.py:3425`) is the rule-based one
  that `/admin/app/{id}/summary` calls by function name. Read the `analytics-endpoint` skill first.
- Never `docker compose down -v` to apply a schema change on anything with data you want.
- Never commit secrets. Note: live Supabase credentials are already committed in
  `scripts/nexbank_user_lookup.py`. Do not add more;
  flag those for rotation, but do not "fix security" as part of Phase 1 (that is Phase 2).
- Never fabricate a metric silently. Response time, geo, and device are synthesised in the
  forwarding layer today; anything derived from them must be labelled simulated in the UI. There
  is **no money field anywhere** in `events_raw`, so every revenue figure is modelled and its
  contract must carry a `simulated:` block.
- Never localize a rate, or a distinct-**user** count. `/funnels` returns user-grain counts, which
  are not additive across dimensions. Localize the contract's additive fundamentals instead.
- Never treat a soft invariant as a hard one. `completed <= started` can break legitimately across
  sessions; that is an abstain, not a quarantine.

## Always do

- Canonicalise event names before aggregating (`canonicalize_event_name`).
- Use a fresh ClickHouse client per call (`ClickHouseClient`), `%(name)s` bound params, and the
  standard tenant-filter idiom (see `analytics-endpoint` skill).
- Write new findings to the Signal Store and read them back in the narrator; do not pass raw
  query output into the LLM context.
- Write a `trust_findings` row on every run, including passes — stage 08 audits the suppression
  rate, so an unrecorded pass is as much a hole as an unrecorded failure.
- Keep the three-layer `/ai_report` fallback so a demo never shows a stack trace.

## Where to find things

| Need to... | Read |
|---|---|
| Know what is already fixed, and what is left before the pipeline | `docs/FOUNDATION_STATUS.md` |
| Understand the system | `docs/ARCHITECTURE.md` |
| Know Phase 1 scope / DoD | `docs/PHASE_1.md` |
| Run or extend a demo scenario | `docs/SCENARIOS.md` |
| Build a stage / know its inputs and outputs | `docs/PIPELINE_CONTRACT.md` |
| Handle a stage's failure modes | `docs/EDGE_CASES.md` |
| Defend a design choice / plan a Phase 2 upgrade | `docs/RESEARCH.md` |
| Change ClickHouse / add Signal Store tables / Foundation fixes | `docs/DATABASE.md` |
| Define or read a KPI contract | `docs/KPI_CONTRACT.md`, `contracts/*.yaml` |
| Add or rename a tracked event | `skills/event-taxonomy/SKILL.md` |
| Add or change an Analytics API endpoint | `skills/analytics-endpoint/SKILL.md` |
| Build a specialist, the agent, or the narrator | `skills/intelligence-pipeline/SKILL.md` |
