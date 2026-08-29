---
name: intelligence-pipeline
description: >
  Use when building or wiring any part of the Phase 1 agentic pipeline in FinInsights: a
  specialist (Trust Gate, Detect, Localize, Forecast, Causal, Decide), the Agent Orchestrator,
  the Narrator, the numeric verifier, personas, the entitlement filter, or per-insight telemetry
  and evaluation. Encodes the non-negotiable contract that keeps the LLM out of the numbers.
---

# Building the intelligence pipeline

This replaces the simple `/ai_report`. Specialists produce every number; the LLM plans lightly
and narrates. Put new modules under `api/intelligence/`. The narrator extends `api/insights.py`.

Read `docs/PHASE_1.md` for scope, `docs/KPI_CONTRACT.md` for why grain decides what Localize may
do, and **`docs/PIPELINE_CONTRACT.md` for the actual interfaces** — stage I/O, the investigation
spine, the claim set, the verifier algorithm, materiality, scheduling and personas. Do not start a specialist before its KPI's `readiness` block says it can be computed.

## The contract every specialist obeys

1. **Read only through the Metric Layer / metric functions.** Never query `events_raw` directly.

   **Corrected 2026-08-28:** an earlier version of this rule named `/metrics`, `/funnels` and
   `/journey` as acceptable doorways. They are not, and `docs/PIPELINE_CONTRACT.md` §3 governs:
   Localize receives a `dict[cell_tuple, (numerator, denominator)]` **already aggregated by the
   Metric Layer**, at the contract's `grain.entity`. `/funnels` returns user-grain counts via
   `windowFunnel GROUP BY user_id` — which `contracts/kyc_completion_rate.yaml`'s own lineage note
   calls display-only and explicitly not the localizable fundamental, and which collapses every
   logged-out visitor into a single `user_id` of `"anonymous"`. Do not build a stage on it
   (decision **D6**, `docs/PROPOSAL.md` §3).

   The Metric Layer does not exist yet (`docs/TASK.md` B-0). Build every stage against its stub
   from day one, so a slip there blocks only the final wiring rather than the whole programme.
2. **Compute deterministically, CPU-only.** No training, no labels.
3. **Write findings to the Signal Store** (`docs/DATABASE.md`), never straight into a narrative.
4. **Tag every number with `engine_type`** (`sql`/`stats`/`ml`/`rule`). This is what makes the
   LLM-vs-non-LLM breakdown real.
5. **Ratios**: Localize runs on the additive fundamentals declared in the contract, never on the
   rate, and only across dimensions invariant within `grain.entity`.

## Dependencies: the approved set

Superseding the earlier deterministic-only rule (decision 2026-08-27). The engine must cover
**every** KPI on the platform, and at that scale hand-rolled baselines are the fragile choice, not
the conservative one. See CLAUDE.md rule 2.

| Need | Implementation | Fallback when unavailable |
|---|---|---|
| robust residuals (median, MAD, IQR) | ClickHouse SQL, or `numpy`/`scipy` | — (SQL always available) |
| multiple testing | Benjamini-Hochberg, ~15 lines | — |
| cube search | **PSqueeze** above ~10k cells | greedy exact search, `search_truncated` recorded |
| forecast | **Chronos-Bolt** or equivalent TSFM, zero-shot | ETS/SARIMA, then seasonal-naive |
| classical forecast tier | `statsmodels` | seasonal-naive |
| contracts | `PyYAML` | — (required) |

Three rules survive the change and are not negotiable:

1. **Every method writes the same row shape** and carries an `engine_type`. A library implements a
   stage; it never becomes a new source of truth.
2. **Every method degrades.** A missing library or an absent GPU drops to the next tier and records
   that it did. The pipeline never fails because an optional dependency is not installed.
3. **Zero training data.** A pretrained zero-shot model is fine — it arrives with its weights.
   Anything fitted per series (LSTM, GRU) is not, and recreates the per-stream tuning burden that
   motivated purpose-built forecasters in the first place.

Anything outside the table still needs a plan entry (CLAUDE.md rule 5), `DoWhy`, `CausalImpact`,
`Evidently` and `Langfuse` included.

## The orchestrator

Deterministic control flow, with an optional LLM planning hook (the LLM may choose which KPI to
investigate; it does not compute). **Forecast runs beforehand as a scheduled batch** — its
interval is the band Detect scores against, so it is not a step inside this sequence.

```
readiness check  --blocked--> fail:not_instrumented, stop (never read zero and narrate)
      | ready/degraded
  Trust Gate  --fail-------->  incident note, stop (business path terminates)
      |        --ambiguous-->  abstain: rank hypotheses, name cheapest check, stop
      | pass
   Detect  -->  [anomaly?] --no--> stop (nothing material)
      | yes
  Localize  -->  Causal  -->  Decide  -->  Narrate
```

Re-plan minimally. Stop when evidence is sufficient. Enforce a hard step/time budget so a plan
cannot loop. Every stage writes a `model_runs` row whether or not it produced a finding.

## Trust Gate

Order matters — cheapest and most decisive first:

1. **`readiness`** from the contract. A `blocked` KPI returns `fail:not_instrumented`. This exists
   because the signature failure of this repo is a metric that reads zero rows silently after an
   event name stops surviving the taxonomy.
2. **`hard_invariants`** — arithmetic identities a real-world change cannot break, e.g.
   `count() == uniqExact(event_id)`. Violation is proof of a defect → `fail`, quarantine.

   > **That specific invariant is not currently trustworthy.** `events_raw` is
   > `ReplacingMergeTree(_inserted_at)` ordered by `(tenant_id, event_name, timestamp, event_id)`,
   > so a real worker replay is collapsed on merge and the identity becomes true again — whether
   > the storm is caught depends on merge timing. The seeded fixture only passes because it emits
   > its duplicate pair a minute apart. Resolve decision **D1** (`docs/PROPOSAL.md` §2 Block D-ii)
   > before building this check; the recommendation is to detect replays at the write boundary in
   > `processing/worker.py`, where the event actually happens.
3. **`soft_invariants`** — usually-true business relationships, e.g. `completed <= started` at
   session grain, which a cross-session completion can legitimately break. Violation is evidence,
   not proof → `ambiguous`, name the cheapest check.
4. **Freshness, ranges, distribution collapse**, then the contract's `defect_fingerprints`.

Never treat a soft invariant as hard; that is how a trust gate starts suppressing real movements.

This system has no money field, so `revenue == sum(price * qty)` is vacuously true. Do not report
it as a passing check.

Write a `trust_findings` row on **every** run, including passes — stage 08 audits the suppression
rate, so an unrecorded pass is as much a hole as an unrecorded failure.

## Detect

Score against the **stored forecast band**, not a static threshold. Use median/MAD rather than
mean/stddev: a fresh anomaly contaminates a mean-based baseline and hides itself. Require the
contract's `min_persistence_windows` and minimum effect size before firing, and apply
Benjamini-Hochberg across the series you monitored in that run. Sparse series go to
`insufficient_history`, never to a confident anomaly.

## Localize

Localize the additive fundamentals separately (numerator and denominator for a ratio), then
reconcile which one moved. Search only `dimensions.allowed`, respecting `max_depth` and
`min_segment_volume`. Record `fundamental` on each `root_causes` row so the evidence card can show
what was decomposed.

> **Do not run this against live-path dimensions yet.** `location`, `city`, `continent`,
> `device_type` and `channel` are produced by `selectGeoProfile()`/`selectDevice()` — a weighted
> dice roll, cached once per session. They are session-*invariant*, so contributions will sum to
> ~1.0 and every check below will pass, over noise. **This is the worst output this system can
> produce, because it is indistinguishable from a correct one.**
>
> The `_simulated` marker that is supposed to exclude them does not exist (`docs/TASK.md` P0-8),
> and an invariance test cannot substitute for it — a per-session dice roll passes invariance
> cleanly. Until the marker lands, run Localize against the **seeded** path only, and treat any
> live-path `dimensions.allowed` entry as unverified (`CLAUDE.md` rule 13).

Contributions summing to ~1 is a **check**, not a formatting detail: if they do not, either the
fundamental is not additive at that grain or a dimension is not invariant within the entity. Fail
loudly rather than normalising the numbers to look right.

If available dimensions do not explain the move, return that as the finding.

## Causal

Label the rung: `association`, `attribution`, `corroborated_cause`, `estimated_effect`. Degrade to
the contract's `degrade_to` when assumptions fail and record `degraded_reason`. Always write an
interval. Respect contracts that forbid `estimated_effect` — `pro_revenue` does, because a dollar
effect there would be an artefact of its fixed price constant.

## Decide

The lever must come from the contract's closed `decision.allowed_levers` list; Decide may not
invent one. Expected impact is an interval. Everything is a proposal with an owner role and an
audit trail; Phase 1 executes nothing.

## Narrator + numeric verifier

- Input is **compact signal cards only** (trust verdict, anomaly, top root causes, forecast,
  causal effect, recommendation) pulled from the Signal Store. Never put raw query output or event
  metadata into the LLM context — that is also the prompt-injection surface.
- Use guided/constrained decoding (the existing vLLM + Pydantic path in `api/insights.py`).
- **Verify**: extract every number and named entity from the draft and trace each to a Signal
  Store row within tolerance. If any number is unsupported: regenerate (bounded), then redact,
  then fill from a deterministic template. Keep this three-layer fallback; the demo must never
  show a stack trace or an unverifiable number.
- A figure from a contract with a `simulated:` block must carry its `narrative_qualifier`
  verbatim, and the row sets `simulated = 1`.
- Write one `insights` row per persona with `narrative`, `evidence` (JSON), `llm_breakdown`
  (JSON), `confidence`, `trust_verdict`, `simulated`, `abstained`, `verifier_pass`.

## Personas and entitlement

- Build the personas (`cfo`, `ops_manager`) as render configs over the SAME signal cards, so the
  numbers are identical by construction. Template/slot-fill the numbers; let the LLM vary only
  tone and vocabulary.
- Apply the **entitlement filter before the narrator**: read `access_restriction` from the KPI
  contract and drop any restricted card from the set the narrator can see. A restricted number
  must be structurally absent, not redacted after the fact.
- **The identity personas resolve from does not exist yet, and is currently forgeable.**
  `cfo`/`ops_manager`/`analyst` are in no `rbac.json`, and `RBACMiddleware` trusts
  `X-User-Role`/`X-User-Email`/`X-Admin-Apps`, which the browser sets, on a port published to the
  host. Entitlement enforced above an asserted identity is decorative. `docs/TASK.md` P2-1 and
  P2-3 land in that order for a reason.
- Also drop everything in `suppress_for_others` — a restricted numerator is still leaked if an
  unrestricted ratio built on it survives. Full inference-leak control is Phase 2.

## Sources and what a contract may localize on

Four sources, three of them batch. `nexabank_core` (hourly), `nexabank_crm` (weekly) and
`market_ops` (monthly) carry MEASURED dimensions -- `region` and `branch_code` reach a transaction
through the account's branch of record. The clickstream's `location`/`city`/`device_type` are
drawn at random once per session by `eventTracker.ts`.

That difference decides what Localize is allowed to do. A retail contract may slice on `region`;
a telemetry contract may not slice on `location`, and `validate()` fails it if it tries. **Do not
silence that failure by editing `allowed`** -- it is the only thing standing between the engine
and a ranked, confident, meaningless answer over dice rolls.

Adding a source means: an extract endpoint on the NexaBank side, an entry in `loaders.SOURCES`
with its real grain and cadence, a loader keyed for idempotent replay, and a `sources:` block in
every contract that reads it. Trust Gate checks each source's freshness separately against a
grain-scaled floor, because a 15-minute SLA is meaningless for a monthly feed.

## The query agent (`api/intelligence/agent.py`)

`POST /intelligence/ask` answers an ad-hoc question. It is a **router, not a query planner**: the
question is classified into a closed set of intents (`cause`, `where`, `factor`, `forecast`,
`action`, `trust`, `freshness`, `cost`, `status`), each served from rows a stage already computed.
Nothing generates SQL, so rule 4 holds by construction.

- `PERSONA_INTENTS` mirrors `PERSONA_SECTIONS` in `narrate.py`. An ad-hoc question must not be a
  way around the entitlement the scheduled narrative applies — a `cfo` asking for a segment
  breakdown abstains.
- Every answer is built as a `ClaimSet` and passed through the SAME `narrate.verify`. A draft
  containing a number no row supports becomes an abstention, never a published sentence.
- The tenant is a **query parameter**, not a body field: `RBACMiddleware` scopes an `app_admin`
  from query params, so a body-only tenant would bypass the check it is meant to pass.
- A quarantined KPI (`trust_verdict == "fail"`) refuses to name a cause: the movement is a data
  defect, not a business event.
- Classification is deterministic — ties break on the fixed `INTENT_CUES` order, so the same
  question always routes the same way and the router can be audited.

## Abstention

When two signals disagree (a soft invariant wobbles but the calendar shows a real event), do not
pick one. Emit ranked hypotheses, set `abstained = 1`, and state what is known, what is missing,
and the single cheapest check that resolves it.

## Telemetry and evaluation (stage 08)

Every specialist run and every LLM call writes a `model_runs` row: `stage`, `engine_type`,
`model`, `inputs_hash`, `tokens_in/out`, `latency_ms`, `cost_est_usd`, `verifier_pass`. The
dashboard's LLM-vs-non-LLM panel and the per-insight cost are computed from this table. Do not
have the model describe its own cost; read it from `model_runs`.

Golden scenarios live in `docs/SCENARIOS.md` and are the regression suite: re-run them on every
prompt or model change. Gate on detection false positives, localization hit-rate@1, forecast error
vs seasonal-naive, zero entitlement leaks, and zero unverified numbers. Precision is weighted over
recall — alert fatigue is the usual production failure.

Two things block that suite today. **`fixtures/planted_truth.json` has never been generated**, so
hit-rate@1 has no recorded answer to score against; and **every scenario fixture lands inside a
single four-hour window** (offsets in minutes, max 240) against contracts declaring
`grain.time: daily`, `min_history_days: 14` and `min_persistence_windows: 2` — a daily detector
with a two-window persistence floor cannot fire on one day of data. `docs/TASK.md` P1-8, P1-9.

**Determinism is part of the suite, not a separate concern.** Run any investigation twice over a
frozen window and diff every Signal Store row; any difference is a build failure
(`docs/INTELLIGENCE_LAYER_PROPOSAL.md` §1.8). Two substrate facts will break it before your code
does: `daily_feature_usage.unique_users` is a `uniq` (HyperLogLog) state, and `investigations`
carries no ingest watermark while the simulate console backdates events into past partitions.

## Replacing /ai_report

The pipeline writes `insights` rows. `/ai_report` becomes a thin reader: fetch the latest insight
for the tenant and requested persona plus the linked trust finding, anomaly, causes and evidence,
and return it in the existing response shape. If none exists or the pipeline failed, fall back to
the current rule-based summary. Do not change the route's external contract (the dashboard and
`/admin/app/{id}/summary` depend on it).
