# VALIDATION_LAYER.md

Status: **design only, not implemented.** No code, table, or dependency described here exists yet.
This is a proposal for a KPI-registry validation and feedback layer that sits around the Phase 1
intelligence pipeline (`docs/PHASE_1.md`). Read that file and `docs/KPI_CONTRACT.md` first --
most of what this layer needs already exists as those pieces.

## Why this doc exists

The intelligence pipeline (Trust Gate -> Detect -> Localize -> Causal -> Decide -> Narrate,
Forecast batched ahead, Observe recording every stage) answers "is this one KPI movement real and
what should we do about it." This layer answers a different, longer-horizon question: **across
every run, is the pipeline covering the business metrics we already know matter, computing them
consistently, and is it worth promoting anything it repeatedly surfaces that isn't in the registry
yet?** It is an audit layer, not a gate -- it never blocks or delays an investigation.

```
Predefined KPI Registry -> Data Preprocessing -> Intelligence Pipeline
        -> Metrics/KPIs Used or Discovered -> Validation Against Registry
        -> Store Results and Feedback -> Improve the Pipeline and KPI Registry Over Time
```

## Where this sits in the existing architecture

This is **not a new numbered pipeline stage.** It is an extension of Stage 08 (Observe, Evaluate &
Learn) in `docs/PHASE_1.md`, which already exists to "measure whether the engine is right and make
the loop auditable" -- registry coverage is one more thing that loop measures. It runs as a
scheduled batch job over a completed window, reads what Stage 08 already recorded, and never
touches the live Trust Gate -> ... -> Narrate path. A validation run finding a gap does not block
the next investigation; it produces a report a human or a later process reads.

## 1. The registry: `contracts/*.yaml`, not a new store

The registry this design needs already exists: `contracts/kyc_completion_rate.yaml`,
`loan_approval_volume.yaml`, `pro_revenue.yaml`. Each already carries id, formula, numerator/
denominator (`fundamentals`), dimensions (`allowed`/`excluded`/`availability`), grain, unit,
source mappings (`source`, `lineage`), and quality invariants (`hard_invariants`/
`soft_invariants`/`defect_fingerprints`). Duplicating this into a second hand-maintained store
would create a fourth vocabulary to keep in sync -- exactly what CLAUDE.md's coupling-points
section warns against.

Instead, add a **read-only ClickHouse projection**, rebuilt from the YAML on every contract-loader
run (truncate + insert, never hand-edited), purely so validation queries can `JOIN` against it in
SQL instead of shelling out to a YAML parser per check:

```sql
CREATE TABLE IF NOT EXISTS feature_intelligence.kpi_registry (
    kpi_id            String,
    name              String,
    formula           String,
    unit              String,
    additivity        String,
    grain_time        String,
    grain_entity      String,
    dimensions_allowed String,   -- JSON array, copied from contract.dimensions.allowed
    fundamentals      String,    -- JSON array: [{metric, event, aggregation, engine_type}]
    readiness_status  String,    -- copied from contract.readiness.status
    source_system     String,
    contract_hash     String,    -- hash of the YAML file, so a run can detect drift
    loaded_at         DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(loaded_at)
ORDER BY (kpi_id);
```

`contract_hash` exists so a validation report can flag "this KPI's definition changed since the
last run" without re-parsing YAML at query time.

## 2. Recording what the pipeline used -- mostly already covered

`model_runs` (`docs/DATABASE.md`) already records one row per stage per investigation, tagged with
`engine_type`. `investigations.kpi_id` already ties every run to a registry entry. **No schema
change is needed to know which registered KPIs the pipeline touched and how** -- that is a join:

```sql
SELECT r.kpi_id, count() AS runs, countIf(i.status = 'error') AS errored
FROM feature_intelligence.kpi_registry r
LEFT JOIN feature_intelligence.investigations i ON i.kpi_id = r.kpi_id
    AND i.window_start >= {period_start} AND i.window_start < {period_end}
GROUP BY r.kpi_id;
```

What is missing is a place to record a metric the pipeline **surfaced but that has no `kpi_id` in
the registry.** That case cannot happen with the pipeline as documented today: Detect/Localize
only ever operate inside one contract's declared fundamentals and dimensions (see
`docs/KPI_CONTRACT.md`, "grain.entity decides whether Localize is valid"). There is no open-ended
"scan the dataset for interesting metrics" capability in any of the nine stages. So:

> **This is the one real gap.** "The pipeline discovers useful new metrics on its own" requires a
> discovery capability that does not exist yet and is not scoped in `docs/PHASE_1.md`. Per
> CLAUDE.md rule 1, that is a Phase-2-shaped addition and needs its own explicit scoping before
> any code lands, not something this validation layer can quietly assume.

If/when that capability is designed, its output would land in a small holding table so this layer
has something to count without re-running discovery itself:

```sql
CREATE TABLE IF NOT EXISTS feature_intelligence.discovered_metrics (
    candidate_id   String,
    investigation_id String,       -- the spine, same convention as the rest of the Signal Store
    tenant_id      String,
    proposed_name  String,
    definition     String,         -- what was computed and how (JSON)
    supporting_event String,
    first_seen     DateTime,
    last_seen      DateTime,
    times_surfaced UInt32 DEFAULT 1,
    status         String DEFAULT 'candidate', -- candidate|promoted|rejected
    engine_type    String DEFAULT 'stats'      -- discovery must stay non-LLM too, see section 4
) ENGINE = ReplacingMergeTree(last_seen)
ORDER BY (tenant_id, proposed_name);
```

## 3. The comparison: deterministic joins, no LLM

Everything the user's four questions ask for is a set operation over tables that already exist or
are proposed above -- none require a language model:

| Question | Mechanism | Engine |
|---|---|---|
| Missing known KPIs | Anti-join: `kpi_registry` ids with zero `investigations` rows in the period | `sql` |
| Inconsistent calculations | Already computed: aggregate `trust_findings.verdict` by `kpi_id`/`check_id` over the period; a rising `fail`/`ambiguous` rate on a `hard_invariant`/`soft_invariant` *is* the inconsistency signal | `sql` |
| Contract drift | Compare current contract_hash in `kpi_registry` vs the hash stored on the `investigations` rows it produced | `sql` |
| Repeatedly useful new metrics | `discovered_metrics` rows where `times_surfaced` crosses a fixed threshold over a fixed window -- a count-based rule, not a judgment call | `rule` |

This matches CLAUDE.md's Rule 3 directly (the LLM never produces or verifies a number) and the
user's own instruction: deterministic math/rules wherever a check is possible, no LLM
equivalence-judging.

## 4. Storing results over time -- extends Stage 08, one new table

`model_runs` and `outcomes` already exist for the human-feedback half of Stage 08. This layer adds
one more: a per-run report, so coverage/consistency trends are queryable without re-deriving them
from raw joins every time someone wants a trend line.

```sql
CREATE TABLE IF NOT EXISTS feature_intelligence.registry_validation_runs (
    run_id            String,
    period_start      DateTime,
    period_end        DateTime,
    total_registry_kpis UInt16,
    covered_kpis      UInt16,
    missing_kpis      String,   -- JSON array of kpi_id
    inconsistent_kpis String,   -- JSON array: [{kpi_id, check_id, fail_rate}]
    drifted_kpis      String,   -- JSON array of kpi_id whose contract_hash changed mid-period
    candidate_metrics String,   -- JSON array of discovered_metrics ids crossing the promotion threshold
    engine_type       String DEFAULT 'rule',
    generated_at      DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (period_start, run_id);
```

This is intentionally the *only* new table for the audit-report half. It is written by a scheduled
job (mirrors how Forecast, stage 04, already runs as a batch ahead of the live path), not by
anything in the live investigation path.

## 5. No human-review dependency in the core runtime

This layer never gates an investigation. It:

- Runs on a schedule (e.g. daily), reading a closed time window of already-written Signal Store
  rows.
- Writes exactly one `registry_validation_runs` row per run -- pass or fail, same principle as
  "write a `trust_findings` row on every run, including passes" (CLAUDE.md).
- Is consumed later, by a person or a future dashboard/alert. Nothing in Trust Gate, Detect,
  Localize, Causal, Decide, or Narrate reads from it or waits on it.

A `candidate_metrics` entry crossing the promotion threshold does not auto-promote itself into
`contracts/*.yaml` -- that edit stays a deliberate, human, out-of-band action, same as any other
contract change. The layer's job stops at "here is the evidence," matching the existing
Approve rung in Stage 08's rollout ladder ("a human signs each one").

## Build order (once this moves from design to plan)

This layer cannot produce a real report before there is something to report on. In order:

1. **Contract loader** (`PyYAML`, per CLAUDE.md's one allowed new dependency) -- reads
   `contracts/*.yaml`, is the thing that populates `kpi_registry`. Needed by the live pipeline
   stages too, not just this layer.
2. **A minimal Trust Gate** that writes real `investigations` + `trust_findings` rows against at
   least one contract. Without this, `kpi_registry` has entries and `investigations` has none --
   every coverage report reads "0/3 covered," which is accurate but not yet useful for judging the
   pipeline.
3. **`kpi_registry` projection + `registry_validation_runs` table**, this layer's own two additions.
4. Everything in section 2's "real gap" (open-ended discovery, `discovered_metrics`) is explicitly
   deferred and out of scope until scoped on its own.

See `docs/PIPELINE_CONTRACT.md` and the `intelligence-pipeline` skill for how to build step 2.
