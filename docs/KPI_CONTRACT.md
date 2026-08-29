# KPI_CONTRACT.md

KPI contracts are the semantic contract for Phase 1. A contract says what the number means, how
it is assembled from additive fundamentals, how it should be checked, which dimensions may be
searched, who may see it, and which intelligence stages may operate on it.

Contracts live in `contracts/*.yaml`. Every KPI that can appear in a narrative, evidence card,
forecast, causal card, or recommendation must have a contract.

The contract loader needs `PyYAML`, which is declared in `requirements.txt`. For the wider
approved library set (PSqueeze, a time-series foundation model, numpy/scipy) see CLAUDE.md rule 2.

---

## Two tiers of contract

The engine must answer for **every** KPI on the platform, not a hand-picked few. NexaBank alone
resolves to 48 canonical events across 13 namespaces; multiply by tenants and dimension cells and
the real series count is in the thousands. Hand-authoring a contract per KPI does not scale.

So contracts come in two tiers. **Coverage comes from discovery; depth comes from declaration.**

### Tier 0 — discovered, automatic, conservative

A discovery pass enumerates every canonical event with data in the window and synthesises a
contract for it. Nothing is hand-written and nothing is guessed:

| Field | Derived how |
|---|---|
| `id` | the canonical event name |
| `grain.entity` | `event` — a raw count is additive at event grain, always |
| `fundamentals` | `uniqExact(event_id)` for that event; replay-safe by construction |
| `dimensions.allowed` | observed metadata keys that **pass the invariance test below** |
| `readiness` | `ready` if rows exist in the window, `blocked` otherwise — computed, not asserted |
| `detection` | platform defaults, scored against the forecast band |
| `access_restriction` | **most restrictive by default**; widened only by declaration |
| `causal`, `decision` | **absent.** Interventions and levers are semantic and cannot be inferred |

**The invariance test is measurable, not assumed.** A dimension may be localized only if it does
not vary within the grain entity. That is a query, not a judgement call:

```sql
-- a key is session-invariant if virtually every session sees exactly one value of it
SELECT JSONExtractString(metadata, %(key)s) AS k, uniqExact(k) AS vals
FROM events_raw WHERE ... GROUP BY session_id
-- admit the key when quantileExact(0.99)(vals) = 1
-- quantileExact, NOT quantile: the default is reservoir sampling with an RNG, which would make
-- the discovered dimension set differ between runs. See docs/PIPELINE_CONTRACT.md §0.
```

Keys that fail are excluded automatically, as are any listed in the event's `_simulated` marker.
This is what stops a fabricated or session-varying field from ever entering a cube search — the
protection is enforced by measurement rather than by someone remembering to exclude it.

> **Both halves now exist.** The marker is emitted by `eventTracker.ts` (P0-8) and by
> `scripts/seed_data.py`, and read by `metrics.simulated_keys`, which `discover_tier0`,
> `contracts.validate` and `contracts.sliceable_dimensions` all consult. The invariance test is
> `metrics.dimension_invariance`, scored against `INTEL_INVARIANCE_FLOOR` (0.99).
>
> The two gates are **not** interchangeable. `eventTracker.ts` caches its random geo/device profile
> **once per session**, so a fabricated dimension passes the invariance test cleanly — it is
> perfectly session-invariant and completely meaningless. The invariance test catches
> *session-varying* keys such as `channel`; only the marker catches *fabricated* ones.
> On the live path that is `location`, `city`, `continent`, `device_type` and `channel` — every
> dimension the telemetry contracts declare, which is why `sliceable_dimensions` admits a
> contract-declared `live_fabricated` key on the `seeded` dataset only.

### Tier 1 — declared, hand-authored, deep

A file in `contracts/` overrides and extends the discovered contract for that id. Declaration is
what unlocks everything a machine cannot infer:

- **Ratios.** Which numerator over which denominator is a semantic choice. Tier 0 never invents
  one, so every rate KPI is Tier 1 — and gets `grain.entity: session` with it.
- **Invariants and defect fingerprints.** What *must* be arithmetically true of this metric.
- **Entitlement.** Who may see it, and what must be suppressed to stop back-computation.
- **Causal config.** Eligible interventions and control dimensions.
- **Levers.** The closed list Decide may propose from.
- **Graph edges.** `drives` / `driven_by`, which the propagation pass traverses.
- **Simulated blocks.** Anything modelled rather than measured.

### What this means for the narrative

The tier is visible in the output, because it bounds what can honestly be said:

| | Tier 0 | Tier 1 |
|---|---|---|
| Detect, Localize, Forecast | yes | yes |
| Trust Gate | structural checks only | full invariants + fingerprints |
| Causal | association / attribution only | up to the contract's ceiling |
| Recommendation | none — no declared levers | yes |
| Entitlement | most restrictive | as declared |

A Tier 0 KPI still gets a real, verified answer: it moved, by this much, concentrated here, heading
there. It simply does not get a causal claim or an action, because nobody has declared what an
intervention or a lever would mean for it. **That is the honest ceiling for an undeclared metric,
and promoting one is writing its contract file — nothing else changes.**

---

## Contracts are the app-portability layer

FinInsights is a multi-tenant platform. NexaBank is **one demo tenant that generates telemetry**,
not the product, and the pipeline is not built around it.

That is structural, not aspirational: **no stage in `api/intelligence/` contains a domain noun.**
Detect sees a series, Localize sees a cube of additive counts, Causal sees a treated and an
untreated segment, Narrate sees a set of permitted figures. Nothing there knows what a loan or a
KYC step is. Every app-specific fact lives in exactly two places:

1. **`contracts/*.yaml`** — what the app's KPIs mean, what they are made of, which of its fields
   may be sliced, who may see them.
2. **The Metric Layer** — how to fetch those fundamentals for that app's events.

Onboarding a second app is therefore *write its contracts, point the Metric Layer at its events*.
No stage code changes. The input contract already exists at the platform level and is not owned by
this service: the `FeatureEvent` envelope on `POST /events`, plus the tenant vocabulary.

### What the engine requires of an app — properties, not a schema

- Fundamentals that are **additive at a declared `grain.entity`**.
- Dimensions that are **invariant within that entity** (see the next section for why).
- Enough history for the contract's `forecast.min_history_days`, or an honest sparse caveat.
- **Synthetic fields marked as synthetic**, so `dimensions.allowed` can exclude them.

A banking funnel, a checkout flow and a support queue all satisfy that list in their own
vocabulary. Nothing above mentions banking.

### Why there is deliberately no shared field vocabulary

Each app names its own physical fields, and its contract uses those names directly. That looks
like a missed abstraction and is not: a shared translation layer would be a **fifth** place the
vocabulary can drift out of sync (CLAUDE.md coupling points 2 and 3 document what the existing
four already cost). Per-app contracts naming per-app fields keep drift impossible by construction —
there is only ever one name for a field, the real one.

The consequence to accept: two apps measuring "the same" KPI get two contracts. That is correct.
They are different measurements over different instrumentation, and pretending otherwise is how a
cross-tenant comparison silently becomes meaningless.

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
| `session_id` | yes, stable per session | yes, from `x-session-id` | FOUNDATION-2 |
| `device_type` | yes, one per session | one per session, fabricated | listed in `_simulated` |
| `location` | yes, one per session | one per session, fabricated unless `POST /events/location` supplied it | holds a country |
| `continent`, `city` | yes, one per session | one per session, same rule as `location` | |
| `channel` | yes | yes | also a top-level column |
| `tier` | **no** | yes | live-only; excluded from demo contracts |
| `event_name` | column, not metadata | column | per-feature splits |
| `_simulated` | yes, `["ip","response_time_ms"]` | yes, the keys that event invented | array; read by `metrics.simulated_keys` |
| `country`, `feature_id`, `kyc_step` | **do not exist** | — | never reference them |

`selectGeoProfile()` and `selectDevice()` run once per **session** now, so live dimensions are
additive — but still invented, and `_simulated` says so. Localize cannot recover a planted segment
from live traffic and is not permitted to try. The seeded path assigns one profile per session and
is the path the Phase 1 demo runs on (decision **D4**).

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

# Multi-source KPIs declare `sources:` INSTEAD of `source:`. Trust Gate checks each one against
# its own SLA, because a KPI spanning a stream and a monthly feed cannot be gated by one number.
sources:
  - id: nexabank_core
    system: ClickHouse.fact_transactions
    grain: transaction
    cadence: hourly_batch
    freshness_sla_minutes: 120
  - id: market_ops
    system: ClickHouse.dim_macro_environment
    grain: region_month
    cadence: monthly
    freshness_sla_minutes: 44640
    role: corroboration          # excluded from `primary_source`

identity:
  event_id: required
  session_id: required          # `optional` for entity: event contracts
  user_id: hashed

# Clickstream form: an `event` (or `events`) key. `Contract.is_ratio`, `numerator()` and
# `denominator()` recognise only this form -- see docs/FinInsights_Bug_Audit.md A5.
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

# Fact-table form: `table`/`measure`/`aggregation`, with optional `filter:` and `exclude:` maps.
# `Contract.is_fact_based` branches on the presence of `table`.
#  - metric: deposit_amount
#    table: fact_transactions
#    measure: amount
#    aggregation: sum
#    filter: {txn_type: DEPOSIT, status: SUCCESS}
#    exclude: {category: Loan Disbursement}

# Optional. Enables stage 02a (Decompose): which FACTOR moved, as distinct from which cell.
decomposition:
  enabled: true
  method: lmdi_i
  factors: [volume, mix, price]
  mix_dimensions: [txn_type, channel]
  residual_tolerance: 0.000001

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
   docker compose exec analytics-api python -c \
     "from api.page_map import canonicalize_event_name as c; print(c('YOUR.EVENT.NAME'))"
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
9. **The loader accepts it.** `PyYAML` is declared in `requirements.txt`, so parse and validate
   in one step:
   ```bash
   docker compose exec analytics-api python -c \
     "from api.intelligence.contracts import load_declared, validate; \
      c=load_declared()['YOUR_ID']; print(validate(c))"
   ```
   An empty list means the contract is safe to run.

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

Ten contracts, in two families. The split matters more than the count: the retail family reads
**measured** dimensions from the core banking system, the telemetry family reads dimensions the
forwarding layer synthesises per session. `fee_revenue` and `loan_approval_rate` are retail
despite being named alongside the telemetry chain in earlier drafts — both read fact tables.

### Retail banking (sources A, B and C) — dimensions are measured

```text
cost_per_acquisition     (campaign grain, currency, weekly)  sources: B + A
        drives
new_account_openings     (account grain, count, daily)       sources: A + B
        drives
net_deposit_growth       (transaction grain, currency, monthly)  sources: A + C + B
        drives
digital_adoption_rate    (transaction grain, ratio, daily)   sources: A + C

new_product_activations  (card grain, count, daily)          sources: A + B
        -- deliberately sparse: the product launched days ago

fee_revenue              (transaction grain, currency, daily) sources: A + reference data
loan_approval_rate       (application grain, ratio, daily)    sources: A
```

Each is a genuine multi-source KPI, and the sources disagree on cadence by three orders of
magnitude (hourly / weekly / monthly). That is the point: a KPI whose numerator refreshes hourly
and whose denominator refreshes weekly can move for reasons that have nothing to do with the
business, and the Trust Gate has to catch that before Detect narrates it.

**`net_deposit_growth` is the multi-factor case.** Deposits falling in one region is an internal
observation; `dim_macro_environment.competitor_deposit_rate` is the external factor that explains
it. Causal may only reach `corroborated_cause` when both are present and must degrade to
`attribution` otherwise — so a regional drop with no external corroboration is reported as a
correlation, not a cause.

**`new_product_activations` is the sparse-history case.** Its `min_history_days` (28) deliberately
exceeds the product's age. The forecast must come back caveated with a wide band and the narrative
must say early adoption is being monitored rather than projected.

**`new_account_openings` carries the low-confidence case.** Its `unattributed_opening_spike`
fingerprint fires when openings spike and no campaign in the CRM covers the window. The CRM is
weekly, so a fresh spike may legitimately have no campaign row yet — a reason to abstain, never a
reason to declare the spike organic.

### Telemetry (clickstream) — dimensions are fabricated

```text
kyc_completion_rate      (session grain, ratio)        readiness: ready -- both paths
        drives
loan_approval_volume     (event grain, count)          readiness: ready -- both paths
        drives
pro_revenue              (event grain, simulated)      readiness: ready -- both paths
```

All ten contracts now declare `readiness.status: ready`; the resolved blockers are recorded per
contract in `readiness.blockers`.

These three still fail `validate()` with *"fabricated dimensions in allowed"* — `location`,
`city`, `continent`, `device_type` and `channel` are drawn at random once per session by
`eventTracker.ts`, and their contracts declare `dimensions.availability.<key>.live_fabricated`
saying so. That failure is **correct and load-bearing**: it is the check that stops a confident,
ranked, meaningless localization, and `sliceable_dimensions` enforces it by admitting those keys on
the `seeded` dataset only. Do not silence it by removing the dimensions from `allowed`; fix the
producer, or leave the KPI honest about what it cannot slice.

The contrast is the useful part of the demo. The same engine, over two families of KPI, reaches
different conclusions about what it is allowed to say — because one set of dimensions is measured
and the other is not.
