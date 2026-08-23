# PHASE_1.md

The single source of truth for what Phase 1 is and is not. If a change is not traceable to an
item here, it is out of scope.

## Goal

Replace the simple `/ai_report` (one LLM call over precomputed summaries) with an **agentic
investigation pipeline** that detects a material KPI move, verifies the data, localizes the
cause, forecasts when history is thin, narrates it per persona with a traceable evidence card,
enforces one entitlement rule, and records runtime cost. The banking app (NexaBank) is the
data source. The LLM narrates and lightly plans; specialists produce every number.

## Expected final behavior

Given the seeded NovaCart-style banking dataset, the system can run four scripted scenarios
end to end and show them on the dashboard:

1. **Multi-factor KPI movement.** KYC completion rate drops; Localize returns a ranked set of
   segments (device, region, KYC step) with contribution shares; the narrative names the drivers.
2. **Low-confidence / abstain.** A spike where the Trust Gate and the calendar disagree; the
   engine abstains, states what is known and missing, and names the one cheapest check.
3. **Sparse-history / new KPI.** A newly launched feature with days of history returns a wide,
   caveated interval, not a false anomaly.
4. **Entitlement.** The ops-manager persona structurally never receives the margin signal card;
   an unauthorized-role access event is detected, flagged urgent, and isolated.

Each insight carries: an evidence card (source freshness, method, contribution, confidence,
lineage), an LLM-vs-non-LLM breakdown, and per-insight telemetry (latency, model calls,
tokens, estimated cost).

## Scope

### Must build (in dependency order)

1. **Plantable anomalies in the NexaBank simulator.** Extend the simulation engine in
   `NexaBank/backend/src/routes/eventRoutes.ts` so a run can inject a named, known anomaly
   (a KYC drop concentrated in a segment, a defect-shaped spike, a burst of unauthorized-role
   access). This is the keystone: all four scenarios and all evaluation depend on known ground
   truth. Keep it a flag/param on the existing simulate path.
2. **YAML KPI contract** (`contracts/*.yaml`) and a small loader. Fields per `docs/KPI_CONTRACT.md`,
   including `strategic_weight` (feeds materiality), `access_restriction` (feeds entitlement),
   and `lineage` (feeds the evidence card). Build this first; items 5 and 8 read from it.
3. **Signal Store tables** (`anomalies`, `root_causes`, `forecasts`, `recommendations`,
   `insights`, `model_runs`, `outcomes`) and the DDL apply procedure. See `docs/DATABASE.md`.
4. **Materiality score** = statistical significance x business impact (`strategic_weight` x value
   at risk) x persistence, one number that ranks what surfaces. Reuses Benjamini-Hochberg and
   robust effect size already in Detect.
5. **Evidence card** endpoint + payload, read from the KPI contract + Signal Store rows.
6. **The agentic pipeline** replacing `/ai_report` internals: Trust Gate (lightweight/rule) ->
   Detect -> if anomaly Localize (PSqueeze + a group-by driver read) -> Materiality ->
   Forecast only if sparse -> Narrator with numeric verifier. Deterministic orchestration;
   optional LLM planning hook. Writes `insights` rows; `/ai_report` reads them; keep the
   3-layer fallback. See `skills/intelligence-pipeline/SKILL.md`.
7. **Two personas** (`cfo`, `ops_manager`) rendered from the SAME signal cards, plus the
   entitlement filter that drops restricted cards before the narrator sees them.
8. **Role-access anomaly path**: simulator emits an unauthorized-role access event -> Detect
   treats it as categorical -> narrator flags urgent and isolates the actor/segment.
9. **Per-insight telemetry**: every specialist run and LLM call writes a `model_runs` row with
   `engine_type`, tokens, latency, and estimated cost. The LLM-vs-non-LLM breakdown reads
   from this table.
10. **Correctness fixes that would embarrass a demo**: add a deterministic `event_id` and a
    `session_id` on the event; verify and fix the decaying-sum column in `daily_feature_usage`
    (see `docs/DATABASE.md`); resolve the duplicate `/insights` route before extending it.

### Should have (improves reliability, not required for the demo to run)

- One-click feedback capture writing `outcomes` rows (root-cause correct? useful? action taken?).
- A minimal recommendation per anomaly (`recommendations` row: action, lever, owner_role) with
  an impact interval, rules-based only.
- Golden dataset from the plantable anomalies for the evaluation gates below.

### Nice to have (postpone freely)

- A second data source at a different grain (daily loan-outcomes extract) to make the KPI chain
  cross-source. If time is short, simulate the chain within ClickHouse from the same events.
- Cross-persona consistency test.

### Phase 2 / do NOT build now

Semantic-layer product (Cube/dbt/MetricFlow), Neo4j lever ontology, OpenLineage/Marquez,
exact PVM/Aumann-Shapley decomposition, conformal prediction intervals (EnbPI/SPCI),
MinT reconciliation, LP/MILP allocation, contextual bandits / uplift, CausalImpact, DPO or any
fine-tuning, provider prompt caching, semantic caching. Also all production hardening:
header-RBAC replacement, unauthenticated `/events/simulate`, Kafka partitioning, process-local
state externalization, `api/main.py` refactor, JavaBank fork dedup. Put these on a one-slide
roadmap; do not implement.

## Architecture touchpoints (what changes)

- **New**: Signal Store tables; a `contracts/` dir + loader; specialist modules; an orchestrator
  module; evidence + telemetry payloads; a persona render step. Prefer new modules under `api/`
  (e.g. `api/intelligence/`) over growing `api/main.py`.
- **Modified**: `api/insights.py` (narrator + verifier), the `/ai_report` handler (reads Signal
  Store, keeps fallback), `core/models.py` (`event_id`, `session_id`), the NexaBank simulator,
  the dashboard AI panel (evidence card + LLM/non-LLM badge + telemetry).
- **Unchanged**: ingestion, Kafka, worker, `page_map`, the existing `/metrics/*`, `/funnels`,
  `/journey`, `/metrics/retention`, WebSocket transport.

## Definition of Done

Phase 1 is done when all of the following are objectively true:

- **Functionality**: all four scenarios run end to end from a single seeded simulator run and
  appear on the dashboard.
- **Correctness**: `event_id` present end to end; a killed-and-restarted worker does not change
  counts (idempotent); `daily_feature_usage` totals do not drift after `OPTIMIZE ... FINAL`.
- **Intelligence**: every number in every narrative traces to a Signal Store row (verifier at
  100% coverage); on injected ground truth, Localize returns the planted segment at rank 1.
- **Personas/entitlement**: the two personas render from the same signal cards with identical
  numbers where shared; the restricted card never appears in the ops-manager output (red-team
  a phrasing/ratio leak and confirm it is blocked).
- **Abstention**: the low-confidence scenario abstains and names one check; it does not guess.
- **Evidence + telemetry**: every insight shows freshness, method, contribution, confidence,
  lineage, the LLM-vs-non-LLM split, and token/latency/cost.
- **Regression safety**: existing `/metrics/*`, `/funnels`, `/journey` responses are unchanged;
  the `/ai_report` route still returns on model failure (fallback intact).
- **Docs**: any new event name is registered in all three taxonomy dialects; any schema change
  is in `storage/schema.sql` AND applied via the documented DDL procedure.

## Evaluation gates (use the golden dataset from item 1)

- Localize F1 on injected root causes >= 0.8.
- Numeric-verifier coverage = 100% (zero unverified numbers shipped).
- Zero entitlement leaks; zero cross-persona numeric contradictions.
- Abstention fires on the contradictory-evidence case.
