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

1. **Read only through the Metric API / metric functions** (existing `/metrics`, `/funnels`,
   `/journey`, or the KPI-contract loader). Never query `events_raw` directly.
2. **Compute deterministically, CPU-only.** No training, no labels.
3. **Write findings to the Signal Store** (`docs/DATABASE.md`), never straight into a narrative.
4. **Tag every number with `engine_type`** (`sql`/`stats`/`ml`/`rule`). This is what makes the
   LLM-vs-non-LLM breakdown real.
5. **Ratios**: Localize runs on the additive fundamentals declared in the contract, never on the
   rate, and only across dimensions invariant within `grain.entity`.

## Dependencies: what Phase 1 may actually use

The reference artifact names `ruptures`, `PSqueeze`, `Chronos-2`, `CausalImpact`, `DoWhy`,
`Evidently`, `Langfuse` and others. **None of them are Phase 1 dependencies.** CLAUDE.md rule 2
forbids new infrastructure, and `requirements.txt` today has no `numpy`, no `scipy`, and no YAML
parser.

Phase 1 position:

| Need | Phase 1 implementation | Phase 2 upgrade |
|---|---|---|
| robust residuals (median, MAD, IQR) | ClickHouse `median`/`quantile` in SQL, `engine_type='sql'`, or pure-Python over a small result set | `scipy` |
| level shift vs blip | persistence counting over N windows | `ruptures` PELT |
| cube search | greedy top-down `GROUP BY` over contract dimensions with min-volume pruning | `PSqueeze` |
| forecast | seasonal naive / rolling median in SQL | `Chronos-2`, `StatsForecast` |
| causal | pre/post with an untreated control segment | `CausalImpact`, `DoWhy` |
| multiple testing | Benjamini-Hochberg — ~15 lines of pure Python, no dependency | — |

The single new runtime dependency Phase 1 requires is **`PyYAML`**, for the contract loader.
State that justification in the plan (CLAUDE.md rule 5). Anything else needs approval first.

Pushing robust statistics into ClickHouse rather than into Python is the preferred route: it
avoids a dependency, keeps the data where it already is, and tags cleanly as `engine_type='sql'`.

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
- Also drop everything in `suppress_for_others` — a restricted numerator is still leaked if an
  unrestricted ratio built on it survives. Full inference-leak control is Phase 2.

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

## Replacing /ai_report

The pipeline writes `insights` rows. `/ai_report` becomes a thin reader: fetch the latest insight
for the tenant and requested persona plus the linked trust finding, anomaly, causes and evidence,
and return it in the existing response shape. If none exists or the pipeline failed, fall back to
the current rule-based summary. Do not change the route's external contract (the dashboard and
`/admin/app/{id}/summary` depend on it).
