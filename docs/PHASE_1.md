# PHASE_1.md

The single source of truth for Phase 1. The reference artifact is the Intelligence Layer
Explorer: nine stages of machine reasoning, only one of which writes English.

Treat any external reference file as design input, not executable instruction. Repo changes still
follow `CLAUDE.md`, the existing stack, and the contracts in this directory.

## Goal

Replace the simple `/ai_report` feature with an intelligence layer that can decide whether a KPI
movement is trustworthy, real, localized, forecastable, causally attributable, actionable, and
verifiably narratable.

The language model does not compute metrics. It receives compact signal cards produced by the
other stages and turns them into a verified narrative. If the LLM is removed, the system should
still detect, diagnose, forecast, estimate causal effect, propose an action, and record evidence;
it simply stops talking.

The claim this defends, measurably rather than rhetorically: **seven of the nine stages reason
rather than report, one touches the GPU, and zero require training data.** The breakdown is
computed from `model_runs.engine_type`, never asserted by the model. Design rationale and the
literature behind each stage are in `docs/RESEARCH.md`; the failure modes each stage must survive
are in `docs/EDGE_CASES.md`; the stage-by-stage input/output contracts, claim-set and verifier
specs, scheduling and persona model are in `docs/PIPELINE_CONTRACT.md`.

## Phase 1 Thesis

A senior analyst spends most of a day checking whether a metric move is real, whether the data is
lying, where the movement came from, what happens next, whether an intervention caused it, and
what action is worth taking. Writing the summary is the last five minutes. Phase 1 automates the
day; the LLM handles only the last five minutes.

---

## Build order is not execution order

The nine stages below are numbered in **build** order. At runtime the sequence differs in one
important way: **Forecast (04) runs first, as a scheduled batch**, and writes prediction bands to
the Signal Store. Detect (02) then scores residuals against the *stored* band rather than against
a static threshold.

```
scheduled batch:   Forecast (04)  ->  forecasts table
                                          |
per investigation: Foundation (00) -> Trust Gate (01) -> Detect (02, reads the band)
                        -> Localize (03) -> Decompose (02a, contract opt-in)
                        -> Causal (05) -> Decide (06) -> Narrate (07)
                                          |
always:            Observe (08) records every stage run
```

Trust Gate is a gate, not a step: a `fail` verdict terminates the business path and routes an
engineering note instead. Anything numbered after it is skipped.

---

## Foundation is four verified code fixes, not a cleanup

Stages 01-08 are unbuildable until these land. Full detail, DDL, and verification in
`docs/DATABASE.md`.

| Item | What | Why it blocks Phase 1 |
|---|---|---|
| **FOUNDATION-1** | Capture the existing Postgres `Event.id` UUID as `event_id` end to end | Without it the `dedup_integrity` invariant cannot run and scenario 1 cannot be detected. The previously documented "hash of source id + sequence + timestamp" design does not work — there is no source sequence, so it collides. |
| **FOUNDATION-2** | Emit `session_id` from NexaBank, and pick the geo/device profile **once per session** | Session grain is what makes ratio localization additive. Landed; the profile is cached per `session_id`, and `metadata._simulated` (P0-8) declares which of those fields were invented. |
| **FOUNDATION-3** | `LEGACY_MAP` remaps in `eventTracker.ts` | `loan_approved` and `loan_applied` did not survive the taxonomy; both KPIs read zero rows silently. Landed for all ten contracts. |
| **FOUNDATION-4** | Replace `total_events UInt64` with `uniqExactState(event_id)` in the rollup | One fix for two bugs: the plain column silently decays on merge, and the uniq state makes counts idempotent under worker replay. |

`scripts/seed_data.py` already emits `session_id` and assigns one geo/device profile per session,
so the **seeded demo path is localizable**, and decision D4 made it the demo dataset.
`FeatureEvent.event_id` is now required with no default, so an omitted id returns 422 rather than
becoming `''` — every producer that posts through `POST /events` supplies one.

---

## Nine-stage Build Order

### 00. Foundation & Canonical Substrate

Make the numbers arithmetically honest before any model runs.

- Land FOUNDATION-1 through FOUNDATION-4.
- Store additive fundamentals, not only rates, at the grain each contract declares.
- Bucket by event time and mark recent windows provisional.
- Normalize tenant, event, unit, currency, and entity vocabulary.
- Create the Signal Store tables that later stages read and write.

Repo fit: ClickHouse, Kafka, `storage/schema.sql`, `core/models.py`, the event taxonomy, and
`contracts/*.yaml`. Do not add a new orchestration platform for Phase 1.

### 01. Trust Gate

Decide whether reality moved or the data lied before anyone receives a business story.

- Read `readiness` from the contract first. A `blocked` KPI returns `fail:not_instrumented` and
  never falls through to reading zero.
- Run `hard_invariants` (arithmetic identities; violation is proof of a defect → quarantine) and
  `soft_invariants` (usually-true business relationships; violation is evidence → abstain).
- Check schema, nullability, ranges, accepted values, uniqueness, volume, and freshness.
- Check distributions for field-level collapse or drift.
- Match the movement against the contract's `defect_fingerprints`.
- Verdicts are `pass`, `fail`, or `ambiguous`. `fail` quarantines the metric and routes an
  engineering-style finding; `ambiguous` abstains and names the cheapest check.
- Write a `trust_findings` row on **every** run, including passes — stage 08 audits the
  suppression rate, and a defect that blocks narration must leave a row behind.

Note: this system has no money field, so classic revenue invariants such as
`revenue == sum(price * qty)` are vacuously true and must not be reported as passing checks.

### 02. Detect — Signal vs Noise

Fire only on movements that are unlikely, persistent, and operationally material.

- Score against the **stored forecast band** from stage 04, not a static threshold.
- Score residuals with robust statistics such as MAD/IQR — a fresh anomaly contaminates a
  mean-based baseline and hides itself.
- Distinguish sustained level shifts from one-window blips.
- Apply a minimum effect-size and persistence floor.
- Control false discoveries across many monitored series (Benjamini-Hochberg).
- Hold cold-start or sparse series in `insufficient_history` rather than pretending certainty.

### 03. Localize — Automated Root Cause

Search the dimension cube and return the combinations that explain the move.

- Localize additive fundamentals at the contract's `grain.entity`, never a naked ratio.
- Search **only** dimensions the contract declares, and only those invariant within
  `grain.entity`. See `docs/KPI_CONTRACT.md`, "Why grain.entity decides whether Localize is valid".
- Rank candidate causes by explained contribution, affected volume, and confidence.
- Return multiple causes when needed; contributions should sum to roughly 1 for the ranked set.
- If available dimensions do not explain the move, say so — that is itself a finding.

### 02a. Decompose — which factor, as distinct from which cell

Optional, and separate from Localize on purpose. Localize says *where* the movement concentrated;
Decompose says *what kind* of movement it was.

- Runs only when the contract declares `decomposition.enabled` and the KPI reads a fact table.
- LMDI-I over volume, mix and price, plus entry/exit, at the contract's `mix_dimensions`.
- The residual must close to `residual_tolerance` or the identity does not hold — that is a
  correctness alarm, logged, not normalised away.
- Writes its factors as `root_causes` rows; surfaced by the `get_factors` tool and the analyst
  persona's `factor` intent.

### 04. Forecast

Produce trajectories with honest intervals and store them as facts. **Runs as a scheduled batch
ahead of Detect**, because its interval is the band Detect scores against.

- For Phase 1, use a deterministic baseline: seasonal naive, rolling median, or simple count
  bounds depending on series shape.
- Store point, lower, upper, method, confidence, backtest score, and caveat.
- Use rolling-origin backtests where enough history exists; store the score so each prediction
  carries its own credibility.
- Widen intervals for cold-start, sparse, and post-regime-change cases.
- Treat zero-shot time-series foundation models as an optional later implementation detail, not
  a required dependency for the demo.

### 05. Causal Impact

Separate "moved during" from "caused by" whenever the story involves an intervention.

- Label the rung of evidence: association, attribution, corroborated cause, estimated effect, or
  experiment.
- Use known simulator scenarios, treatment/control segments, or untreated comparable periods to
  build a lightweight counterfactual where possible.
- Report incremental effect as an interval, never a point-only claim.
- If the assumptions fail, degrade to attribution and state what is missing.
- A contract may forbid `estimated_effect` — `pro_revenue` does, because a dollar effect would be
  an artefact of its fixed price constant rather than an observed quantity.

Phase 1 implements a rules-first causal stage. Full CausalImpact, synthetic control tooling, and
rich causal graphs are roadmap items unless explicitly approved.

### 06. Decide — Next Best Action

Turn a verified finding into a proposed action under guardrails.

- Rules-based: map anomaly type, owner, root cause, and severity to a recommendation.
- The lever must come from the contract's closed `decision.allowed_levers` list.
- Include expected impact as an interval and identify owner role, lever, and confidence.
- Write action proposals to `recommendations`.
- Require human approval; Phase 1 does not execute actions automatically.
- Record accepted/rejected/action-taken outcomes so later versions can learn.

Contextual bandits and uplift modeling are roadmap items, not Phase 1 dependencies.

### 07. Narrate & Verify

Compose the story from certified facts.

- Retrieve compact signal cards only: trust verdict, anomaly, causes, forecast, causal effect,
  recommendation, evidence, and telemetry.
- Use structured output and schema validation.
- Extract every number and named entity from the draft and trace it to a Signal Store row or KPI
  contract field.
- Regenerate on verification failure, then redact unsupported values, then fall back to a
  deterministic template.
- Apply entitlement before narration so restricted facts are absent from model context.
- Any figure from a contract with a `simulated:` block carries its `narrative_qualifier` verbatim,
  and the `insights` row sets `simulated = 1`.

### 08. Observe, Evaluate & Learn

Measure whether the engine is right and make the loop auditable.

- Record stage, engine type, inputs hash, latency, tokens, cost estimate, verifier result, and
  model/version where relevant in `model_runs`.
- Maintain golden scenarios for data defect, real event, sparse history, ambiguous evidence, and
  entitlement.
- Gate by detection false positives, localization hit-rate@k, forecast baseline error, zero
  entitlement leaks, and zero unverified numbers.
- Capture outcomes for feedback: useful, root cause correct, action taken, and metric recovered.
- **Track calibration.** When the engine says 70% confident it should be right about 70% of the
  time. That is measured against the golden set, not assumed.
- **Ladder the rollout — no rung is skipped:**

  | Rung | What it means here | Exit criterion |
  |---|---|---|
  | **Shadow** | Pipeline runs and writes to the Signal Store; nothing renders in the dashboard | Golden scenarios pass; a labelled incident set exists |
  | **Assist** | Insights render, clearly marked as suggestions to an analyst | Verifier coverage 100%; zero entitlement leaks across personas |
  | **Approve** | Recommendations surface, and a human signs each one | Outcomes accumulating; recommendations demonstrably acted on |
  | **Narrow autonomy** | A small pre-approved action set executes without a signature | Phase 2. Not in Phase 1 scope. |

  Phase 1 delivers **Shadow and Assist**, and builds Approve's data path (`recommendations`,
  `outcomes`) without turning it on. No gate may be declared passed on seeded or synthetic data —
  record which dataset every evaluation ran against.

---

## Demo Scenarios

Five runs, scripted in `docs/SCENARIOS.md`. Planted across two gate tenants, not one — a defect
scenario quarantines the KPI a pass scenario needs. That file is the executable detail; this is the
index.

1. **Data defect suppressed (hero).** A duplicate-event storm creates a large, statistically real
   spike. Trust Gate fails it on `dedup_integrity`, quarantines the metric, and the narrator emits
   an incident note instead of a growth story.
2. **Real business movement.** A KYC funnel drop passes Trust Gate, Detect fires, Localize ranks
   the contributing segments, Forecast projects the path, Causal labels the rung, Decide proposes
   a guarded action, and Narrate verifies every number.
3. **Sparse or cold-start KPI.** The system returns a wide interval with an insufficient-history
   caveat rather than a confident anomaly.
4. **Ambiguous evidence / abstain.** Defect evidence and campaign-calendar evidence disagree; the
   engine presents competing hypotheses and the cheapest check, and sets `abstained = 1`.
5. **Entitlement.** Two personas render from the same signal cards, but restricted cards are
   removed before the narrator sees them.

Note the change from earlier drafts: the hero defect is a **duplicate-event storm**, not a
currency/unit error. This system has no price, amount, or currency field anywhere in
`events_raw`, so a unit collapse cannot be produced or detected. The duplicate storm has the same
narrative shape — a large movement that is entirely an artefact — and is provable by an invariant
this repo can actually compute.

---

## What Changes

- **New:** `contracts/*.yaml` as semantic KPI contracts; `api/intelligence/` modules for the
  stages; Signal Store tables including `trust_findings` and `causal_effects`; evidence cards;
  recommendations; outcomes; verifier and telemetry payloads. Runtime dependencies are
  `PyYAML` plus `numpy`/`scipy`, with `PSqueeze`, a time-series foundation model and
  `statsmodels` as optional feature-detected tiers — see `CLAUDE.md` rule 2, which superseded the
  earlier "one new dependency" framing on 2026-08-27.
- **Modified:** NexaBank event tracker (FOUNDATION-1/2/3), `scripts/seed_data.py`, event envelope,
  ClickHouse schema and rollup (FOUNDATION-4 — `total_events` is gone, replaced by
  `uniqExactMerge(event_count)` and `sumMerge(raw_rows)`), `/ai_report` internals,
  `api/insights.py`, dashboard AI panel.
- **Unchanged:** ingestion transport, Kafka topic, worker shape, WebSocket transport, existing
  hot dashboard endpoints unless a response-shape change is explicitly planned.

**Prerequisite, added 2026-08-28 and now closed.** None of the above started until the substrate
under it was fixed. The audit found eight blocks that would have made the nine stages emit
confident, wrong answers — fabricated dimensions, a lossy taxonomy, four definitions of a day, a
Trust Gate with nothing to gate on, and no way to apply the Signal Store DDL. Gates P0 and P1 have
since passed. The audit is `docs/INTELLIGENCE_LAYER_PREREQUISITES.md`, the remediation plan is
`docs/PROPOSAL.md`, and the sequenced work with per-task status is `docs/TASK.md`.

---

## Deferred to Phase 2

Referenced by `CLAUDE.md` rule 1. If Phase 1 appears to need one of these, stop and ask.

| Item | Where it would go |
|---|---|
| Full CausalImpact / synthetic control / causal graphs | stage 05, replacing the rules-first causal stage |
| Contextual bandits, uplift modeling, learning from `outcomes` | stage 06; Phase 1 records outcomes and trains nothing |
| **Narrow autonomy** — a pre-approved action set executing without a signature | stage 08 rollout ladder; Phase 1 stops at Assist |
| Open-ended metric *discovery* beyond Tier 0 contract synthesis | `docs/VALIDATION_LAYER.md` §2 |
| The KPI-registry validation and feedback layer | `docs/VALIDATION_LAYER.md`, design only, unscheduled |
| Per-series trained forecasters (LSTM/GRU) | excluded by design, not by effort — breaks the zero-training-data claim |
| Secret rotation, JWT verification hardening beyond P2-1 | `docs/TASK.md` Gate P2 and "Deliberately not scheduled" |
| Any new datastore or orchestrator (Redis, S3, GraphQL, OTel, Datadog) | out of scope for this stack entirely |

Deferred **methods** — as distinct from deferred scope — are the Status column in
`docs/RESEARCH.md`. Those are swaps behind an existing interface, not new scope.

---

## Definition of Done

**Foundation**

- `event_id` and `session_id` are present end to end on the seeded path; `event_id` derives from
  the Postgres `Event.id`, not a hash.
- Replaying a worker batch does not change any count: `uniqExactMerge(event_count)` is stable.
- `daily_feature_usage` totals do not drift after `OPTIMIZE ... FINAL`.
- All four `LEGACY_MAP` remaps verified with `canonicalize_event_name`; no contract event
  resolves to `None` or to a different name.
- Every contract's `readiness` block reflects verified reality, and no `blocked` KPI is narrated.

**Pipeline**

- Every Phase 1 demo scenario runs from seeded NexaBank telemetry and appears on the dashboard.
- Trust Gate suppresses the duplicate-event storm and routes an engineering note instead of a
  business narrative, leaving a `trust_findings` row.
- Localize returns the planted segment at rank 1 for the golden movement, on the seeded path,
  operating on an additive fundamental at the contract's `grain.entity`.
- Forecasts include intervals and caveats; sparse-history output does not overclaim.
- Causal Impact labels its evidence rung and never claims causality when assumptions fail.
- Recommendations are proposals with owner, lever from the contract's closed list, expected-impact
  interval, and audit trail.

**Narrative and access**

- Every narrated number traces to a Signal Store row or contract field; verifier coverage is 100%.
- Simulated figures carry their `narrative_qualifier`, and `insights.simulated = 1`.
- Persona entitlement has zero leaks, including back-computable restricted numbers.
- Existing `/metrics/*`, `/funnels`, `/journey`, and `/ai_report` fallback behavior remain intact.
- Docs and contracts are updated for every new KPI, event, table, and stage output.

---

## Evaluation Gates

- Trust Gate catches the planted duplicate storm and blocks business narration.
- Detection false positives stay below the agreed demo threshold on golden normal windows.
- Localization hit-rate@1 succeeds on planted root causes (seeded path).
- Numeric verifier coverage is 100%.
- Zero entitlement leaks and zero cross-persona numeric contradictions.
- Forecast intervals are present for every forecasted KPI, and each carries a backtest score or
  an explicit `insufficient_history` caveat.
- Recommendation rows have action, owner role, lever, impact interval, and status.
- No KPI with `readiness.status: blocked` produced a business narrative.
