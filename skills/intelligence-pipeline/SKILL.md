---
name: intelligence-pipeline
description: >
  Use when building or wiring any part of the Phase 1 agentic pipeline in FinInsights: a
  specialist (Trust Gate, Detect, Localize, Forecast, Materiality), the Agent Orchestrator, the
  Narrator, the numeric verifier, personas, the entitlement filter, or per-insight telemetry.
  Encodes the non-negotiable contract that keeps the LLM out of the numbers.
---

# Building the intelligence pipeline

This replaces the simple `/ai_report`. Specialists produce every number; the LLM plans lightly
and narrates. Put new modules under `api/intelligence/`. The narrator extends `api/insights.py`.

## The contract every specialist obeys

1. **Read only through the Metric API / metric functions** (existing `/metrics`, `/funnels`,
   `/journey`, or the KPI-contract loader). Never query `events_raw` directly.
2. **Compute deterministically, CPU-only.** No training, no labels. Robust stats (median/MAD,
   IQR), ruptures/PELT for level shifts, Benjamini-Hochberg for FDR, PSqueeze for localization.
3. **Write findings to the Signal Store** (`docs/DATABASE.md`), never straight into a narrative.
4. **Tag every number with `engine_type`** (`sql`/`stats`/`ml`/`rule`). This is what makes the
   LLM-vs-non-LLM breakdown real.
5. **Ratios**: Localize runs on the additive numerator and denominator from the KPI contract,
   never on the rate. The contract's `ratio` block tells you the fundamentals.

## The orchestrator

Deterministic control flow, with an optional LLM planning hook (the LLM may choose which KPI to
investigate; it does not compute). Baseline sequence:

```
Trust Gate  ->  Detect  ->  [anomaly?] --no--> stop (nothing material)
                                |yes
                             Localize  ->  Materiality  ->  [sparse history?] --yes--> Forecast
                                                                    |no
                                                                 Narrate
```

Re-plan minimally: only Localize if Detect fired; only Forecast if the series is too short to
trust a point anomaly. Stop when evidence is sufficient. Enforce a hard step/time budget so a
plan cannot loop.

## Trust Gate (lightweight for Phase 1)

Rule-based: declarative checks (schema, null/range, freshness vs the contract's
`freshness_sla_minutes`), an internal invariant or two (e.g. numerator <= denominator for a
ratio), and a coincident-change check against the simulator's known events. If it fails, mark the
anomaly a probable defect and do NOT narrate it as a business change. If a real event and a defect
could both be present, abstain and name the disambiguating check.

## Narrator + numeric verifier

- Input is **compact signal cards only** (the anomaly, top root causes, the relevant KPI numbers)
  pulled from the Signal Store / `PRECOMPUTED_LAYER`. Never put raw query output or event
  metadata into the LLM context (that is also the prompt-injection surface).
- Use guided/constrained decoding (the existing vLLM + Pydantic path in `api/insights.py`).
- **Verify**: extract every number and named entity from the draft and trace each to a Signal
  Store row within tolerance. If any number is unsupported: regenerate (bounded), then redact,
  then fill from a deterministic template. Keep this three-layer fallback; the demo must never
  show a stack trace or an unverifiable number.
- Write one `insights` row per persona with `narrative`, `evidence` (JSON), `llm_breakdown`
  (JSON), `confidence`, `abstained`, `verifier_pass`.

## Personas and entitlement

- Build the personas (`cfo`, `ops_manager`) as render configs over the SAME signal cards, so the
  numbers are identical by construction. Template/slot-fill the numbers; let the LLM vary only
  tone and vocabulary.
- Apply the **entitlement filter before the narrator**: read `access_restriction` from the KPI
  contract and drop any restricted card from the set the narrator can see. A restricted number
  must be structurally absent, not redacted after the fact. For the demo, if a restricted
  numerator would be back-computable from an unrestricted ratio, suppress the ratio for that
  persona too, and note in the roadmap that full inference-leak control is Phase 2.

## Abstention

When two signals disagree (Trust Gate flags a defect but the calendar shows a real event), do not
pick one. Emit the ranked hypotheses, set `abstained = 1`, and state what is known, what is
missing, and the single cheapest check that resolves it.

## Telemetry (the LLM-vs-non-LLM deliverable)

Every specialist run and every LLM call writes a `model_runs` row: `stage`, `engine_type`,
`model`, `tokens_in/out`, `latency_ms`, `cost_est_usd`, `verifier_pass`. The dashboard's
LLM-vs-non-LLM panel and the per-insight cost are computed from this table. Do not have the model
describe its own cost; read it from `model_runs`.

## Replacing /ai_report

The pipeline writes `insights` rows. `/ai_report` becomes a thin reader: fetch the latest insight
for the tenant and requested persona plus the linked anomaly/causes/evidence, and return it in
the existing response shape. If none exists or the pipeline failed, fall back to the current
rule-based summary. Do not change the route's external contract (the dashboard and
`/admin/app/{id}/summary` depend on it).
