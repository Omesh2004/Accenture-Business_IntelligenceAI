# SCENARIOS.md

The five demo runs Phase 1 must produce, scripted with `scripts/seed_data.py --scenario all`.
This is the ground truth the plantable-anomaly simulator injects and the evaluation gates check
against. Everything rides one story, but it is planted across **two** tenants
(`SCENARIO_TENANT_INDEX`): scenarios 1 and 4 quarantine `kyc_completion_rate`, which is the KPI
scenario 2 needs to pass, so the defect cases get their own tenant. `fixtures/planted_truth.json`
records which tenant carries which scenario and the gates read that list rather than a literal.

The story: NexaBank's loan-KYC funnel. KYC completion gates loan approvals, which gate revenue
(`kyc_completion_rate -> loan_approval_volume -> pro_revenue`, see `docs/KPI_CONTRACT.md`).

These five correspond one-to-one with the list in `docs/PHASE_1.md`. If you change one, change
both.

---

## Two ways to produce a movement

**1. `scripts/seed_data.py --scenario <name>` — scripted, with recorded ground truth.**
Writes the planted truth to `fixtures/planted_truth.json` (planted segment, magnitude, expected
rank-1 cause). This is what the Evaluation Gates below are scored against; a hit-rate@1 number
cannot be computed without a recorded answer.

> **Both blockers on this path are closed.** `fixtures/planted_truth.json` is generated and
> committed (P1-9), and the scenarios now spread across daily buckets — each entry carries
> `anomaly_days: 7`, above `detection.min_persistence_windows: 2` and with enough history for
> `forecast.min_history_days` (P1-8, decision **D4**).
>
> `fixtures/` is mounted read-write into the `tests` service, not baked. Baked, the seed wrote the
> truth file into a container that was then discarded and every gate scored the run before.

**2. The admin simulation console — operator-driven, with NO recorded ground truth.**
`POST /events/simulate` accepts a `behavior` block (see
`NexaBank/backend/src/helper/simulationBehavior.ts`). An operator picks a scenario from a dropdown
— KYC completions falling for mobile users in India, loan approvals slowing, traffic shifting to
mobile, pro conversions collapsing, an unauthorized-access burst — and the generator produces
users who genuinely behave that way.

Beyond the scenario dropdown there are **per-route and per-event knobs**: `behavior.targets` scales
traffic and failure for identifiers drawn from `GET /events/simulate/catalog`, and a journey model
enforces that a session cannot emit an event whose prerequisites it has not met — back-filling them
when it must. `relaxJourney: true` switches that safeguard off, which is how an operator produces a
deliberately inconsistent session. Full behaviour, and the two things about it that surprise, are
in `docs/FOUNDATION_STATUS.md` § "The journey model".

Nothing is recorded about what changed. No table, no fixture, no metadata flag. The movement
exists **only** as the shape of the events, so the intelligence layer has to infer it the way it
would for a real incident rather than look up the answer. The API response echoes the applied
behaviour back to the operator's screen and is never persisted.

Use (1) for automated scoring and regression. Use (2) for the demo, and for honestly answering
"why did this move?" without the pipeline having had a hint.

**Both paths are localizable now.** The live path was not until FOUNDATION-2 actually landed —
see `docs/DATABASE.md`, which records why it appeared to and did not. Two properties make a
movement recoverable, and the console surfaces both:

- **A window.** The change applies only to the last N days; earlier days generate at baseline.
  Without that history there is nothing to score a residual against.
- **A segment.** The change can be confined to e.g. `{device_type: mobile, location: India}`, so
  the movement concentrates in a cell localization can recover instead of shifting everything
  uniformly.

Mix overrides (device/country/channel) apply per **session**, not per user — `kyc_completion_rate`
requires only that a dimension be invariant *within* a session, and a user on mobile one day and
desktop the next is realistic. Re-rolling per event is the FOUNDATION-2 bug and must not return.

Scenarios 1 and 2 also require FOUNDATION-1 (`event_id`), without which `dedup_integrity` cannot
run at all.

Events used — verify each with `canonicalize_event_name` before planting (see
`skills/event-taxonomy`): `loan.kyc_started.success`, `loan.kyc_completed.success`,
`loan.applied.success`, plus two new ones, `pro.new_feature.view` and `auth.role.violation`, which
both canonicalize to themselves but still need `FEATURE_DISPLAY_NAMES` labels.

---

## Scenario 1 — Data defect suppressed (the hero)

Replaces the currency/unit-error case from the reference artifact. This system has **no price,
amount, or currency field anywhere** in `events_raw` — its columns are `tenant_id`, `event_name`,
`user_id`, `channel`, `timestamp`, `metadata` — so a unit collapse cannot be produced or detected
here, and `revenue == sum(price * qty)` is vacuously true. A duplicate-event storm has the same
narrative shape (a large movement that is entirely an artefact) and is provable by an invariant
this repo can actually compute.

**Plant:** over the anomaly window, re-emit a subset of `loan.kyc_completed.success` events
byte-identically — same `event_id`, same timestamp — simulating a worker replay after a failed
offset commit. `raw_rows` spikes; distinct event ids do not move. Leave sessions, starts, and
applies flat.

> **The invariant does not read `events_raw` (decision D1).** `events_raw` is
> `ReplacingMergeTree(_inserted_at)` ordered by `(tenant_id, event_name, timestamp, event_id)`, so
> a **real** worker replay produces rows identical on all four columns and a background merge
> collapses them — `count() == uniqExact(event_id)` becomes true again, on merge timing no reader
> controls.
>
> `dedup_integrity` therefore compares `sumMerge(raw_rows)` against `uniqExactMerge(event_count)`
> in `daily_feature_usage`. A materialized view fires on the *inserted block* and never sees
> post-merge state, so a replay raises `raw_rows` while distinct ids stay flat, whatever the merges
> do afterwards. The fixture emits true byte-identical duplicates (`docs/TASK.md` P1-5), so it
> tests the mechanism rather than a timestamp accident.

**Expected pipeline behavior:**
- Trust Gate: **FAIL** on the `dedup_integrity` hard invariant
  (`sumMerge(raw_rows) > uniqExactMerge(event_count)`), fingerprint `duplicate_event_storm`.
  Writes a `trust_findings` row with `blocks_narrative = 1`.
- Detect: the movement is statistically real — large, persistent, well outside the band. That is
  exactly why detection alone is insufficient; the gate has already routed it to the defect path,
  so no business investigation opens.
- Localize / Forecast / Causal / Decide: not run for the business story. Localize may run in
  blast-radius mode only, to scope which tenant and window carry the corruption.
- Narrate: emits an **incident note**, not a growth story: what is wrong, which window is
  unreliable, and that figures are quarantined. Routed to the engineering owner.

**Gate:** business narration is blocked; a `trust_findings` row exists with verdict `fail`; the
narrative contains no growth claim and no unverified number.

## Scenario 2 — Real business movement

**Plant:** over the anomaly window, drop `kyc_completion_rate` ~18%, concentrated in
`device_type=mobile` AND `location=India`, with a coincident dip in `loan.applied.success`
(downstream) and no data-quality flag. Because seeded dimensions are session-invariant, the
planted cell is genuinely recoverable.

**Expected pipeline behavior:**
- Trust Gate: **PASS** — `dedup_integrity` holds, sessions and applies moved together, no defect
  fingerprint matches.
- Detect: fires on the rate, scored against the stored forecast band; persistence gate satisfied.
- Localize: runs on the additive session-grain fundamentals (`uniqExact(session_id)` for the
  numerator and denominator separately), **not** the rate. Returns rank-1
  `{device_type: mobile, location: India}` with the largest contribution.
- Causal: labels the rung. With no controlled intervention, `attribution` is the honest ceiling
  unless an untreated comparable segment supports `corroborated_cause`.
- Decide: proposes a lever from `kyc_completion_rate`'s closed list
  (`fix_kyc_step`, `simplify_form`, `adjust_messaging`, `investigate`) with an impact interval.
- Narrate: names the segment and the driver chain, every number traced.

**Gate:** Localize returns the planted segment at rank 1 (element-F1 >= 0.8); contributions sum to
~1; narrative numbers 100% verified.

## Scenario 3 — Sparse / cold-start KPI

**Plant:** a new feature (`pro.new_feature.view`) with only a few days of history, given a mild
wobble that a naive detector would call an anomaly.

**Expected pipeline behavior:**
- Detect: suppressed or downgraded — history is below `forecast.min_history_days`, so the series
  is held in `insufficient_history` rather than alerted on.
- Forecast: returns a WIDE interval with `caveat = insufficient_history` and method
  `category_prior` or `seasonal_naive`, not a confident point. `backtest_mase` stays 0, marking it
  as un-scored rather than credible.
- Narrate: reports the wide band and the caveat; does not raise a false anomaly.

**Gate:** no false anomaly on the sparse series; the insight carries the insufficient-history
caveat and a visibly wide interval.

## Scenario 4 — Ambiguous evidence / abstain

**Plant:** a sharp `kyc_completion_rate` spike driven by a *partial* duplicate burst — enough to
wobble the soft invariant but not to break `dedup_integrity` outright — landing at the same time
as a real marketing campaign event, so the defect and real-event signals genuinely conflict.

**Expected pipeline behavior:**
- Trust Gate: the hard invariant passes, but the `funnel_order` **soft** invariant wobbles while
  the calendar shows a real campaign. Verdict `ambiguous`, with `cheapest_check` populated. This
  is exactly why hard and soft invariants are separated — treating `funnel_order` as hard would
  suppress a real movement.
- Orchestrator: does NOT pick one. Sets `abstained = 1`.
- Causal: not run. Attribution without a trusted baseline would dress a coin flip in statistics.
- Narrate: states what is known, what is missing, and the single cheapest disambiguating check
  ("confirm whether the spike survives event_id de-duplication"). No causal story asserted.

**Gate:** the run abstains rather than guessing; the narrative contains exactly one named check
and no unverified number.

## Scenario 5 — Role-based entitlement + unauthorized access

Two things at once: persona entitlement, and an access-violation anomaly.

**Plant:**
- Enterprise conversion events in the window, so `pro_revenue` has a value to hide from ops.
- A burst of `auth.role.violation` events: a `user`-role actor hitting an admin-scoped action.

**Expected pipeline behavior:**
- Entitlement: `pro_revenue` declares `visible_to: [cfo, analyst]`. The `cfo` persona sees the
  revenue card; the `ops_manager` persona's card set has it removed **before** the narrator sees
  it — structurally absent, not redacted after the fact. Its `suppress_for_others` list also
  removes `pro_conversion_events` and any ratio built on it, so the figure cannot be
  back-computed.
- Simulated labelling: every `pro_revenue` figure the CFO sees carries the contract's
  `narrative_qualifier` ("modelled at a fixed $49 per conversion") and sets `insights.simulated = 1`.
- Detect: treats the role-violation burst as a categorical anomaly.
- Narrate: flags it `severity = urgent`, isolates the actor/segment, and recommends the action to
  the authorized owner role only.

**Gate:** the ops-manager output never contains the revenue number (red-team a phrasing or ratio
leak and confirm it is blocked); the two personas agree on every shared number; the violation is
flagged urgent and isolated.

---

## Cross-scenario checks

- Every insight in every scenario shows the evidence card (freshness, method, contribution,
  confidence, lineage) and the LLM-vs-non-LLM breakdown read from `model_runs`.
- Every scenario writes a `trust_findings` row, including the passes — stage 08 audits the
  suppression rate, so a silent pass is as much a missing record as a silent failure.
- One seeded run produces all five, across the two gate tenants; re-running with the same seed
  reproduces the same planted ground truth (deterministic).
- No scenario narrates a KPI whose contract `readiness.status` is `blocked`. All ten contracts are
  `ready` -- see each contract's `readiness.blockers` for the resolved Foundation items. This rule
  still applies to any future KPI landed with `readiness.status: blocked`.
