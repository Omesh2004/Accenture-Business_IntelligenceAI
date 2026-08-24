# KPI_CONTRACT.md

KPI contracts are the semantic contract for Phase 1. A contract says what the number means, how
it is assembled from additive fundamentals, how it should be checked, which dimensions may be
searched, who may see it, and which intelligence stages may operate on it.

Contracts live in `contracts/*.yaml`. Every KPI that can appear in a narrative, evidence card,
forecast, causal card, or recommendation must have a contract.

The contract loader needs a YAML parser. `PyYAML` is not currently in `requirements.txt` and is
the one new runtime dependency Phase 1 requires; add it with that justification.

---

## Why `grain.entity` decides whether Localize is valid

This is the single most important rule in this document. Get it wrong and stage 03 produces
confident, ranked, meaningless output.

Localization decomposes a movement across a dimension cube and reports each cell's contribution.
That arithmetic is only defined if the measure is **additive** over the cells:

```
metric(total) == sum over cells of metric(cell)
```

Distinct-entity counts are additive across a dimension **only if the entity cannot span two
values of it**. That is the whole test.

| Fundamental | Additive across `device_type`? | Why |
|---|---|---|
| event count | **yes** | an event happens on exactly one device |
| session count | **yes** | a session runs on exactly one device |
| distinct **user** count | **no** | one user can browse on mobile Monday and desktop Tuesday, and is then counted in both cells, so the cells over-sum |

`/funnels` in `api/main.py` computes `windowFunnel(...) GROUP BY user_id`, so it returns
**user-grain** counts. A ratio built directly on that output is **not localizable** — contribution
shares cannot sum to 1, and the ranking is an artefact.

So each contract declares two axes:

```yaml
grain:
  time: daily
  entity: session        # or: event
```

- **Ratio / conversion KPIs → `entity: session`.** A session is nested inside one device, one
  geo, one channel, so session counts are additive across exactly those dimensions. This is also
  the business-correct definition of a completion rate.
- **Pure count KPIs → `entity: event`.** Every event sits in exactly one cell, so any event-level
  attribute is additive by construction.

Consequences the contract must then honour:

1. `dimensions.allowed` may contain **only attributes invariant within `grain.entity`**. For a
   session-grain KPI, `kyc_step` is disqualified: a session traverses several steps, so session
   counts are not additive across it. Localize step drop-off as a separate event-grain finding.
2. Fundamentals declare their aggregation explicitly — `uniqExact(session_id)` or
   `uniqExact(event_id)`, never a bare `count()`, which is not replay-safe (see
   `docs/DATABASE.md` FOUNDATION-1).
3. The **rate is never localized**. Localize the numerator and denominator separately, then
   reconcile which one moved.

---

## Dimensions name physical keys. There is no renaming layer.

`dimensions.allowed` lists the **exact metadata keys present in `events_raw`**. Contracts do not
define aliases and there is no contract-level mapping block.

This is deliberate. CLAUDE.md documents that this repo already re-implements the event taxonomy
in three disagreeing dialects and the tenant vocabulary in four maps. A per-contract renaming
layer would add a fifth place for the vocabulary to drift, which is precisely how this system
breaks itself. If a key has a bad name, rename it at ingestion — in one place — or live with it.

Known naming debt, accepted for Phase 1: **`location` holds a country value.** There is no
`country` key anywhere in the pipeline. Contracts say `location`.

Keys verified to exist, and where:

| Key | `scripts/seed_data.py` (demo path) | live NexaBank path | Notes |
|---|---|---|---|
| `session_id` | yes, stable per session | **no** | FOUNDATION-2 |
| `device_type` | yes, one per session | present but **re-rolled per event** | live value is noise |
| `location` | yes, one per session | present but **re-rolled per event** | holds a country |
| `continent`, `city` | yes, one per session | re-rolled per event | |
| `channel` | yes | yes | also a top-level column |
| `tier` | **no** | yes | live-only; excluded from demo contracts |
| `event_name` | column, not metadata | column | per-feature splits |
| `country`, `feature_id`, `kyc_step` | **do not exist** | — | never reference them |

Because `forwardToIngestionAPI` calls `selectGeoProfile()` and `selectDevice()` once **per event**,
`location` and `device_type` are statistically independent of user, session and outcome on the
live path. Localize cannot recover a planted segment from live traffic. The seeded path assigns
one profile per session and is the path the Phase 1 demo runs on.

---

## Readiness: a contract must know whether it can be computed

The signature failure of this repo is a metric that reads **zero rows, silently**, because an
event name did not survive the three taxonomy dialects. A contract therefore declares its own
instrumentation status, and Trust Gate reads it before anything else runs.

```yaml
readiness:
  status: ready | degraded | blocked
  seeded_path: ready
  live_path: blocked
  blockers:
    - id: short-slug
      affects: [seeded, live]
      detail: >
        What is broken, naming the file and line.
      fix: "The specific change, and the FOUNDATION- item that carries it."
  gate: >
    What the pipeline does while this status holds.
```

Rule: **a `blocked` KPI returns `fail:not_instrumented` from Trust Gate and produces no business
narrative.** It must never fall through to reading zero and narrating a 100% decline.

---

## Simulated metrics must say so

CLAUDE.md forbids fabricating a metric silently. `events_raw` carries no price, amount, or
currency field anywhere, so any money figure in this system is modelled. A contract whose value
depends on a constant declares it:

```yaml
simulated:
  is_simulated: true
  simulated_component: estimated_revenue_per_conversion
  reason: "No money field exists in events_raw."
  ui_label: "Simulated"
  narrative_qualifier: "modelled at a fixed $49 per conversion"
  consequence: >
    Trust Gate cannot run money invariants. `revenue == sum(price * qty)` is vacuously true by
    construction and must NOT be reported as a passing check.
```

The narrator must use `narrative_qualifier` verbatim whenever it states such a figure, and the
`insights` row carries `simulated = 1`.

---

## Required Shape

```yaml
id: stable_metric_id
name: Human Label
definition: >
  One sanctioned sentence the narrator may use to define the KPI.
formula: numerator / denominator
unit: ratio
additivity: non-additive        # of the KPI itself; its fundamentals are additive

grain:
  time: daily
  entity: session               # decides which dimensions are localizable -- see above

readiness:
  status: ready
  seeded_path: ready
  live_path: ready
  blockers: []
  gate: "..."

source:
  name: nexabank_clickstream
  system: ClickHouse.events_raw
  cadence: real-time
  event_time: timestamp

identity:
  event_id: required
  session_id: required          # `optional` for entity: event contracts
  user_id: hashed

fundamentals:
  - metric: numerator_metric
    event: event.name.success
    aggregation: uniqExact(session_id)
    additivity: additive
    engine_type: sql
  - metric: denominator_metric
    event: event.name.started
    aggregation: uniqExact(session_id)
    additivity: additive
    engine_type: sql

dimensions:
  allowed: [device_type, location, channel, continent]
  session_invariant: true
  max_depth: 3
  min_segment_volume: 20
  availability:
    device_type: {seeded: true, live: noise}
  excluded:
    - key: kyc_step
      reason: "Varies within a session; session counts are not additive across it."

quality:
  freshness_sla_minutes: 15
  provisional_window_minutes: 10
  hard_invariants:              # violation => quarantine, no business narrative
    - id: dedup_integrity
      expr: count() == uniqExact(event_id)
      on_fail: quarantine
  soft_invariants:              # violation => abstain, name the cheapest check
    - id: funnel_order
      expr: numerator_metric <= denominator_metric
      on_fail: ambiguous
  corroboration:
    - related_event.name.success
  defect_fingerprints:
    - id: duplicate_event_storm
      signature: "count() >> uniqExact(event_id) within the anomaly window"
      verdict: fail

detection:
  direction: down
  band_source: forecast         # Detect scores against the stored band, not a static threshold
  warn_pct_change: 8
  critical_pct_change: 15
  min_persistence_windows: 2
  min_denominator: 30
  robust_scorer: mad
  multiple_testing: benjamini_hochberg
  sparse_history_policy: abstain_with_interval

forecast:
  enabled: true
  horizon_days: 7
  baseline: seasonal_naive
  interval_required: true
  fallback: rolling_median
  min_history_days: 14

causal:
  enabled: true
  evidence_rungs: [association, attribution, corroborated_cause, estimated_effect]
  interventions: [campaign, simulator_anomaly]
  control_dimensions: [location, channel]
  degrade_to: attribution

decision:
  owner: growth_analytics
  allowed_levers: [fix_flow, adjust_messaging, investigate]
  requires_human_approval: true
  expected_impact: interval

lineage:
  events: [event.name.started, event.name.success]
  endpoint: /funnels?steps=event.name.started,event.name.success
  tables: [events_raw, daily_feature_usage]

access_restriction:
  visible_to: [cfo, ops_manager, analyst]
  suppress_for_others: []       # fundamentals/ratios that would leak a restricted number

observability:
  golden_scenarios: [real_movement, sparse_history]
  verifier_required: true
  engine_type: sql

interconnection:
  drives: downstream_metric_id
```

---

## Hard/soft invariants: why the split matters

A hard invariant is an arithmetic identity that a real-world change cannot break. `dedup_integrity`
(`count() == uniqExact(event_id)`) is one: no business event makes the same event id appear twice.
Violation is proof of a defect → **quarantine**.

A soft invariant is a usually-true business relationship. `kyc_completed <= kyc_started` at session
grain looks like an identity but is not: a session may legitimately complete a KYC that began in an
earlier session. Violation is evidence, not proof → **abstain and name the cheapest check**.

Treating a soft invariant as hard is how a trust gate starts suppressing real movements.

---

## Validation checklist for a new or edited contract

Run all of these before committing. Most take one command.

1. **Every event canonicalizes to itself.** For each name in `fundamentals` and `lineage.events`:
   ```bash
   .venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'.'); \
     from api.page_map import canonicalize_event_name as c; print(c('YOUR.EVENT.NAME'))"
   ```
   The output must equal the input. `None` or a different string means the KPI reads zero.
2. **Some producer emits it.** Grep `scripts/seed_data.py` and `LEGACY_MAP` in
   `eventTracker.ts`. If neither produces it, `readiness.status` is `blocked`.
3. **Every `dimensions.allowed` key exists** in the table above, on the path you intend to run.
4. **Every allowed dimension is invariant within `grain.entity`.**
5. **Fundamentals declare `aggregation`**, and it is not a bare `count()`.
6. **Ratios are non-additive**; their fundamentals are additive.
7. **Money or constant-derived values carry a `simulated:` block.**
8. **`decision.allowed_levers` is closed** — Decide may not invent a lever outside it.
9. **YAML parses.** There is no PyYAML in the venv yet; the structural linter used during this
   work lives in the session scratchpad and checks tabs, duplicate keys, `': '` inside plain
   scalars, and unterminated quotes.

---

## Rules

- Ratios are never localized directly. Localize numerator and denominator fundamentals, then
  reconcile the rate movement.
- Every contract event must survive all three event-taxonomy dialects (`skills/event-taxonomy`).
- Trust Gate failures stop business narration for that KPI.
- A forecast without an interval is not a Phase 1 forecast.
- Causal output must label its evidence rung; if assumptions fail, it must degrade to attribution.
- Recommendations are proposals, not automatic actions.
- Restricted facts must be removed before the narrator sees the signal cards.
- Every produced number must carry an `engine_type` and trace to a Signal Store row or contract
  field.

---

## Connected Banking KPI Chain

Phase 1 keeps one banking story for the demo:

```text
kyc_completion_rate      (session grain, ratio)        readiness: degraded -- seeded ok, live blocked
        drives
loan_approval_volume     (event grain, count)          readiness: blocked  -- no emitter on any path
        drives
pro_revenue              (event grain, simulated)      readiness: degraded -- seeded ok, live partial
```

The chain is intentionally small. It is enough to prove the intelligence layer can carry a KPI
movement through trust, detection, localization, forecast, causal labelling, recommendation,
narration, and observability without inventing numbers — and its current readiness states are an
honest picture of what is instrumented today, not an aspiration.
