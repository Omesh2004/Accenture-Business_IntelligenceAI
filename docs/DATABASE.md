# DATABASE.md

Everything about ClickHouse for Phase 1: how it works here, the migration procedure (there is
no runner), the four Foundation fixes that everything downstream depends on, and the exact
Signal Store DDL to add.

## How the app talks to ClickHouse

- `storage/client.py` `ClickHouseClient` builds a fresh `clickhouse_connect` client on every
  `query()` and `insert_events()`. This is deliberate: FastAPI handlers are `def` and run in a
  thread pool, and the client is not thread-safe. Keep this pattern; do not add a pooled global.
- No ORM, no query builder. Every endpoint embeds f-string SQL with `%(name)s` bound params.
- Multi-tenant idiom, used in ~25 endpoints:
  ```python
  cond = "tenant_id = %(tenant_id)s" if len(tenants) == 1 else "tenant_id IN %(tenant_ids)s"
  ```
- Deletes/updates do not happen. Correction relies on `ReplacingMergeTree` merges, which is why
  some queries append `FINAL`. Use `FINAL` sparingly; prefer `GROUP BY` + `-Merge` for rollups.

## Migrations: there is no runner

`storage/schema.sql` is mounted into the ClickHouse init dir and runs ONLY when the data volume
is empty. Editing it does nothing to a running stack. To apply a schema change to a live stack:

1. Add the DDL to `storage/schema.sql` (so a fresh volume is correct).
2. ALSO apply it by hand to the running instance:
   ```bash
   docker compose exec clickhouse clickhouse-client --multiquery < path/to/change.sql
   ```
3. Update every SQL string and column list that references the table (there is no compile check;
   a renamed column is a runtime 500 or a silently empty list).

Never `docker compose down -v` to force a re-init on anything whose data you want to keep.

**Materialized views do not backfill.** `CREATE MATERIALIZED VIEW` only transforms rows inserted
*after* it exists. Any MV change needs an explicit backfill `INSERT ... SELECT` for history.
`ALTER TABLE ... MODIFY COLUMN` also cannot convert a plain column into an `AggregateFunction`;
that needs the shadow-table procedure in FOUNDATION-4.

**Materialized views do not see deletes either, and this one bites silently.** An
`ALTER TABLE feature_intelligence.events_raw DELETE WHERE ...` removes rows from `events_raw`
but leaves their `event_id`s inside `daily_feature_usage`'s `uniqExact` aggregate state. The
rollup then reports MORE events than the raw table contains, permanently, and every endpoint
reading the rollup disagrees with every endpoint reading `events_raw`. Observed: deleting 11
diagnostic rows left `events_raw` at 2041 and the rollup at 2052.

This is the concrete reason the note above says deletes do not happen here. If you must delete
from `events_raw`, rebuild the rollup from source afterwards -- it is derived data, so this is
always safe:

```sql
TRUNCATE TABLE feature_intelligence.daily_feature_usage;
INSERT INTO feature_intelligence.daily_feature_usage
SELECT tenant_id, event_name, toDate(timestamp) AS date,
       uniqExactState(if(length(event_id) > 0, event_id,
           concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))) AS event_count,
       uniqState(user_id) AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;
```

`scripts/verify_data_quality.py` compares the two on every run (the ROLLUP check), so this
cannot drift unnoticed for long.

## Current tables

`events_raw` (MergeTree, PARTITION toYYYYMM(timestamp), ORDER BY tenant_id,event_name,timestamp;
`metadata` is a JSON String read with JSONExtract*), `daily_feature_usage` (AggregatingMergeTree
rollup via `mv_daily_feature_usage`), `tenant_licenses`, `tracking_toggles`, `config_audit_log`,
`ai_reports`.

---

# The four Foundation fixes

Stages 01-08 are built on these. Each is verified against the code, not assumed.

## FOUNDATION-1 — `event_id`, and why the old design was wrong

**The problem.** `processing/worker.py:65-66` inserts a batch then commits Kafka offsets
asynchronously, with `enable.auto.commit = False`. If the worker dies between the insert and the
commit landing, the batch is re-consumed and **re-inserted**. `events_raw` is a plain `MergeTree`,
which never deduplicates, so the rows genuinely double. `mv_daily_feature_usage` fires again on
the replayed insert, so the rollup doubles too.

**Do not use a hash of (source id + source sequence + timestamp).** That was the previous design
in this file and it does not work: there is no source sequence anywhere in the producer, so two
events from one user in the same second collide, and dedup would then delete a real event.

**Use the key that already exists.** `NexaBank/backend/prisma/schema.prisma:131` declares
`Event.id String @id @default(uuid())`. `eventTracker.ts:401` already awaits
`prisma.event.create({...})` and **discards the return value**. Capturing it yields a UUID minted
exactly once per logical event, stable across every retry, with no collision risk:

```ts
const row = await prisma.event.create({ data: { ... } });
forwardToIngestionAPI(eventName, hashedUserId, tenantId, metadata, timestampOverride, tier, row.id)
  .catch(() => {});
```

**Adding the column alone changes nothing.** A `MergeTree` will not dedup on it. Idempotency is
delivered at *read* time by FOUNDATION-4, which replaces `count()` with `uniqExact(event_id)`.

```sql
ALTER TABLE feature_intelligence.events_raw ADD COLUMN IF NOT EXISTS event_id String DEFAULT '';
```

Also add `event_id: str = ""` to `FeatureEvent` in `core/models.py`, and have
`scripts/seed_data.py` emit one per event (it currently emits none).

## FOUNDATION-2 — `session_id`, and why it is a correctness requirement

`session_id` is not a nicety that replaces 30-minute gap inference. It is the precondition that
makes ratio localization mathematically valid — see `docs/KPI_CONTRACT.md`, "Why grain.entity
decides whether Localize is valid".

```sql
ALTER TABLE feature_intelligence.events_raw ADD COLUMN IF NOT EXISTS session_id String DEFAULT '';
```

Today `session_id` is read out of the metadata JSON with a fallback
(`api/main.py:1513`, `concat('user:', user_id)`). Promote it to a real column and keep the
metadata read as a fallback during migration.

**Status: resolved on every producer.** Re-assert with `python scripts/verify_data_quality.py`
(the SESSIONS and DIMS checks) rather than trusting this table.

| Producer | `session_id` | Dimensions | Localizable |
|---|---|---|---|
| `scripts/seed_data.py` | stable per session (`generate_session_events`) | one profile per session | **yes** |
| `analytics-dashboard/src/lib/tracker.ts` | `sessionStorage`-backed | browser-derived | yes |
| `NexaBank/frontend/lib/tracker.ts` | `sessionStorage`-backed | real geo cached by `useGeoLocation` | yes |
| `NexaBank/.../eventTracker.ts` | from the `x-session-id` header | one profile cached per `session_id` | **yes** |

**The trap this fell into, because it will recur.** The fix looked complete and was not. The
interceptor that attaches `x-session-id` was registered on an `apiClient` axios instance that
**no file imported** -- all 56 call sites used the bare `axios` default. So:

- the header never left the browser;
- `getSessionId()` fell through to `server-<uuid>`, minting a new id per event;
- `getSessionProfile()` is keyed on `session_id`, so its cache never hit either, and geo/device
  went on being re-rolled per event exactly as before.

One unused import made two Foundation fixes silently inert while the contracts recorded both as
`resolved`. Measured: 41 events / 41 sessions / 10 locations / 4 devices. The real fix registers
the interceptor on the global axios default too, scoped to first-party hosts so a session id is
never attached to a third-party request (`useGeoLocation` calls `nominatim` and `ipapi`).

**Reading it back.** `session_id` is a real column. Prefer it, keep the metadata read as a
fallback for rows written before the column existed:

```sql
multiIf(
  length(session_id) > 0, session_id,
  JSONHas(metadata, 'session_id') AND length(JSONExtractString(metadata, 'session_id')) > 0,
      JSONExtractString(metadata, 'session_id'),
  concat('user:', user_id)
)
```

## FOUNDATION-3 — taxonomy remaps (coupling point 2)

**Status: resolved. All three contracts reach every lineage event on both producer paths.**
Re-assert with `python scripts/verify_data_quality.py` (the TAXONOMY checks) -- it runs the real
Node `enforceTaxonomy` by extracting and evaluating the function's own source, so it cannot drift
from the implementation the way a hand-written port would.

The original four, verified by calling `canonicalize_event_name` directly:

| Emitted | Ends up as | Contract expects | Status |
|---|---|---|---|
| `trackEvent("loan_approved")` | `core.loan_approved.action` | `loan.approved.success` | **was reading zero** |
| `trackEvent("loan_applied")` | `loan.submit_application.success` | `loan.applied.success` | **was reading zero** |
| `trackEvent("wealth_rebalance")` | `wealth_management.rebalance.success` | `wealth-management-pro.rebalance.success` | not a licensed feature |
| `trackEvent("bulk_payroll_processing")` | `payroll.page.view` | `bulk-payroll-processing.batch.success` | not a conversion |

**Fixing `LEGACY_MAP` was necessary but nowhere near sufficient.** Two of those four keys are
never called: `proController.ts` emits DOTTED names (`pro.crypto-trading.trade_execute`,
`pro.payroll-pro.batch_process`, `pro.finance-library.book_access`) which are already 3-part and
therefore skip `LEGACY_MAP` entirely. `pro_revenue` still reached 1 of its 7 lineage events.

The durable fix was to align the producers with the vocabulary `scripts/seed_data.py` already
uses -- underscore forms like `crypto_trading.trade_execution.success` -- because those are
verified to survive **both** dialects unchanged and to land on the hyphenated licence-catalog key.
The catalog and `FEATURE_DISPLAY_NAMES` already held the correct names; only the producers were
wrong.

Two defects surfaced underneath:

- **Outcome was being erased.** 5 of 7 `trade_execute` call sites are error paths, but all 7
  collapsed onto one canonical name, with success/failure surviving only in metadata that no KPI
  reads. Renaming without checking would have counted failed trades as revenue conversions.
  Event names now branch on outcome.
- **Deliberate duplicate emissions.** Three call sites re-fired a conversion under a second
  "legacy backward compat" name. Harmless while the primary name was broken; double-counting the
  moment it was fixed, since the aggregation is `uniqExact(event_id)` and each call mints its own
  `event_id`. Removed.

**One name still resolves differently per path.** `pro.new_feature.view`: the Node dialect strips
the reserved `pro.` prefix (`new_feature.view.action`), the Python dialect preserves it. Producers
that go through the NexaBank backend take the first, `scripts/seed_data.py` takes the second. An
alias in `api/page_map.py` converges them. Any name whose first segment is `free`/`pro`/`core`/
`enterprise`/`lending` has this hazard -- prefer a first segment that is not a reserved prefix.

`loan_approved` is absent from `LEGACY_MAP` (`eventTracker.ts:176`), so `enforceTaxonomy` falls
through to its generic wrapper (`core.<name>.action`), and `canonicalize_event_name` leaves that
untouched. Fix in `LEGACY_MAP` — each target verified against `canonicalize_event_name`:

```ts
'loan_approved':           'loans.approved.success',                  // -> loan.approved.success
'loan_applied':            'loans.applied.success',                   // -> loan.applied.success
'wealth_rebalance':        'wealth_management_pro.rebalance.success', // -> wealth-management-pro...
'bulk_payroll_processing': 'bulk_payroll_processing.batch.success',   // -> bulk-payroll-processing...
```

`scripts/seed_data.py` emits canonical names directly and is unaffected — except that it emits no
`loan.approved.*` at all. Add one, or `loan_approval_volume` has no source on either path.

## FOUNDATION-4 — the rollup: one fix for two bugs

`storage/schema.sql:23` declares `total_events UInt64` inside an `AggregatingMergeTree`, fed by
`count()` in `mv_daily_feature_usage`. A plain column inside an aggregating engine is **not**
summed when background merges collapse blocks — it silently decays. Confirmed present, not
hypothetical.

Replacing it with a `uniqExact` state over `event_id` fixes the decay **and** delivers the
replay-idempotency FOUNDATION-1 set up, because re-inserting identical `event_id`s collapses:

```sql
-- 1. shadow table with the corrected shape
CREATE TABLE IF NOT EXISTS feature_intelligence.daily_feature_usage_v2 (
    tenant_id    String,
    event_name   String,
    date         Date,
    event_count  AggregateFunction(uniqExact, String),   -- was: total_events UInt64
    unique_users AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, event_name, date);

-- 2. point the MV at it (an MV only sees rows inserted after it exists)
DROP TABLE IF EXISTS feature_intelligence.mv_daily_feature_usage;
CREATE MATERIALIZED VIEW feature_intelligence.mv_daily_feature_usage
TO feature_intelligence.daily_feature_usage_v2 AS
SELECT tenant_id, event_name, toDate(timestamp) AS date,
       uniqExactState(event_id) AS event_count,
       uniqState(user_id)       AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

-- 3. backfill history, then swap
INSERT INTO feature_intelligence.daily_feature_usage_v2
SELECT tenant_id, event_name, toDate(timestamp) AS date,
       uniqExactState(event_id) AS event_count,
       uniqState(user_id)       AS unique_users
FROM feature_intelligence.events_raw
GROUP BY tenant_id, event_name, date;

RENAME TABLE feature_intelligence.daily_feature_usage    TO feature_intelligence.daily_feature_usage_old,
             feature_intelligence.daily_feature_usage_v2 TO feature_intelligence.daily_feature_usage;
```

**Reader migration — 12 expressions across 6 query blocks, with no compile check:**

| Was | Becomes |
|---|---|
| `sum(total_events)` | `uniqExactMerge(event_count)` |
| `sumIf(total_events, <cond>)` | `uniqExactMergeIf(event_count, <cond>)` |

Sites: `api/data_layer.py:30,41,42`, `api/insights.py:126,139,140`,
`api/main.py:554,1911,1919,2780,2833,2834`. Other `total_events` occurrences in `api/main.py` are
local `count()` aliases over `events_raw`, not this column — leave those alone.

**Trade-off, stated honestly:** `uniqExact` retains every distinct value, so state size grows with
events per (tenant, event, date) cell. Correct and cheap at demo volume. At real scale, switch to
`uniq` (HyperLogLog, ~0.5% error) and accept approximate counts, or dedup upstream.

**Verification test (required by the Definition of Done):** insert known blocks, force a merge,
assert the total is unchanged — then replay the same batch and assert it is still unchanged.

```sql
OPTIMIZE TABLE feature_intelligence.daily_feature_usage FINAL;
SELECT tenant_id, event_name, uniqExactMerge(event_count)
FROM feature_intelligence.daily_feature_usage
GROUP BY tenant_id, event_name;
```

---

# Signal Store: new tables for Phase 1

Add these to `storage/schema.sql` and apply via the procedure above. Small demo tables, so
ORDER BY is enough; no partitioning needed. All findings are written here; the narrator may
state only what these tables contain.

## The investigation spine

Every table below is joined by `investigation_id`, minted once when a run starts and threaded
through every write. **Do not hang the audit trail off `anomaly_id`.** Two cases break if you do:

- **Trust Gate runs before an anomaly exists.** A `fail` verdict terminates the run, so scenario 1
  produces an incident-note `insights` row with **no anomaly at all**. Keyed on `anomaly_id`, that
  narrative cannot be linked to the finding that caused it — the schema would be unable to
  represent the hero scenario's output.
- **`model_runs` is written by every stage,** including the ones that run before Narrate. Keyed on
  `insight_id`, the rows for Trust Gate, Detect and Localize would all carry an empty key — so the
  LLM-vs-non-LLM breakdown would be missing exactly the stages that did the non-LLM work.

`forecasts` is the one exception: it is produced by a scheduled batch, not by an investigation, so
it carries its own `forecast_id` and is referenced by `anomalies.forecast_id`.

```sql
-- Stage 00. The run itself. One row per investigation, created before any stage executes.
CREATE TABLE IF NOT EXISTS investigations (
    investigation_id String,
    tenant_id        String,
    kpi_id           String,
    window_start     DateTime,
    window_end       DateTime,
    trigger          String,            -- 'scheduled' | 'manual' | 'ping'
    status           String,            -- 'running'|'completed'|'terminated'|'error'
    terminal_stage   String DEFAULT '', -- where it stopped: 'trust_gate'|'detect'|'narrate'
    termination_reason String DEFAULT '',-- 'not_instrumented'|'defect'|'ambiguous'|'immaterial'
    dataset          String,            -- 'seeded' | 'live'  -- no gate passes on seeded data
    started_at       DateTime,
    ended_at         DateTime DEFAULT toDateTime(0)
) ENGINE = ReplacingMergeTree(started_at)
ORDER BY (tenant_id, kpi_id, investigation_id);
```

```sql
-- Stage 01. Trust Gate verdicts. Written on EVERY run, including passes -- stage 08 audits the
-- suppression rate, and a defect that blocks narration must leave a row behind.
CREATE TABLE IF NOT EXISTS trust_findings (
    finding_id       String,
    investigation_id String,           -- the spine; see "The investigation spine" below
    tenant_id        String,
    kpi_id           String,
    window_start     DateTime,
    window_end       DateTime,
    verdict          String,            -- 'pass' | 'fail' | 'ambiguous'
    check_id         String,            -- contract hard_invariants / soft_invariants id
    fingerprint      String DEFAULT '', -- contract defect_fingerprints id
    observed         String,            -- JSON: what the check actually saw
    expected         String,            -- JSON: what the contract required
    cheapest_check   String DEFAULT '', -- required when verdict = 'ambiguous'
    blocks_narrative UInt8 DEFAULT 0,
    engine_type      String DEFAULT 'rule',
    ts               DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ts)
ORDER BY (tenant_id, kpi_id, window_start, check_id);

-- Stage 02. The detected move. One row per (tenant, kpi, window, method).
CREATE TABLE IF NOT EXISTS anomalies (
    anomaly_id   String,
    investigation_id String,            -- hash(tenant_id, kpi_id, window_start, method)
    tenant_id    String,
    kpi_id       String,            -- matches a contract id in contracts/*.yaml
    detected_at  DateTime,
    window_start DateTime,
    window_end   DateTime,
    method       String,            -- 'mad' | 'seasonal_residual' | 'rule'
    direction    Int8,              -- -1 drop, +1 spike, 0 categorical
    magnitude    Float64,           -- signed effect size
    baseline     Float64,           -- from the stored forecast band where one exists
    observed     Float64,
    forecast_id  String DEFAULT '', -- the band this was scored against (stage 04)
    materiality  Float64,           -- significance x impact x persistence
    severity     String,            -- 'info' | 'warn' | 'urgent'
    status       String DEFAULT 'open',   -- open|investigating|explained|dismissed
    engine_type  String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree(detected_at)
ORDER BY (tenant_id, kpi_id, window_start);

-- Stage 03. Ranked localization. Contributions sum to ~1 across ranks -- which is only
-- meaningful because the fundamental is additive at the contract's grain.entity.
CREATE TABLE IF NOT EXISTS root_causes (
    cause_id      String,
    investigation_id String,
    anomaly_id    String,
    tenant_id     String,
    rank          UInt8,
    dimensions    String,           -- JSON: {"device_type":"mobile","location":"India"}
    fundamental   String,           -- which additive fundamental was decomposed
    contribution  Float64,
    method        String,           -- 'greedy_cube' | 'groupby'
    explained_pct Float64,
    engine_type   String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, rank);

-- Stage 04. Runs as a SCHEDULED BATCH, ahead of Detect. Stage 02 scores residuals against the
-- band stored here; this is not a sparse-history-only table.
CREATE TABLE IF NOT EXISTS forecasts (
    forecast_id   String,
    tenant_id     String,
    kpi_id        String,
    as_of         DateTime,
    horizon_days  UInt16,
    point         Float64,
    lower         Float64,
    upper         Float64,
    method        String,            -- 'seasonal_naive' | 'rolling_median' | 'category_prior'
    confidence    Float64,
    backtest_mase Float64 DEFAULT 0, -- vs seasonal-naive; 0 = not backtested
    caveat        String DEFAULT '', -- 'insufficient_history'
    engine_type   String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree(as_of)
ORDER BY (tenant_id, kpi_id, as_of);

-- Stage 05. Causal impact. `rung` is mandatory; a point estimate without an interval is not a
-- Phase 1 causal result.
CREATE TABLE IF NOT EXISTS causal_effects (
    effect_id       String,
    investigation_id String,
    anomaly_id      String,
    tenant_id       String,
    kpi_id          String,
    intervention    String,           -- contract causal.interventions id
    rung            String,           -- association|attribution|corroborated_cause|estimated_effect
    effect_point    Float64,
    effect_lower    Float64,
    effect_upper    Float64,
    method          String,           -- 'pre_post' | 'control_segment' | 'rule'
    assumptions_met UInt8 DEFAULT 1,
    degraded_reason String DEFAULT '',
    engine_type     String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, effect_id);

-- Stage 06. Rules-based recommendation. Impact is an interval, never a point.
CREATE TABLE IF NOT EXISTS recommendations (
    rec_id          String,
    investigation_id String,
    anomaly_id      String,
    tenant_id       String,
    action          String,
    lever           String,          -- must be in the contract's decision.allowed_levers
    owner_role      String,
    expected_impact String,          -- JSON: {"low":..,"high":..}
    status          String DEFAULT 'proposed',
    engine_type     String DEFAULT 'rule'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, rec_id);

-- Stage 07. The narrated output. One row per (tenant, persona, anomaly).
CREATE TABLE IF NOT EXISTS insights (
    insight_id    String,
    investigation_id String,
    tenant_id     String,
    kpi_id        String,
    anomaly_id    String DEFAULT '', -- empty when Trust Gate failed: an incident note has no anomaly
    persona       String,           -- 'cfo' | 'ops_manager' | 'default'
    generated_at  DateTime,
    trust_verdict String,           -- copied from trust_findings; 'fail' => incident note
    headline      String,
    narrative     String,
    evidence      String,           -- JSON array: {metric_id, source, as_of, method,
                                    --             contribution, confidence, lineage_ref}
    llm_breakdown String,           -- JSON: which numbers came from which engine
    confidence    Float64,
    simulated     UInt8 DEFAULT 0,  -- any figure sourced from a contract `simulated:` block
    abstained     UInt8 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1
) ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (tenant_id, persona, anomaly_id);

-- Stage 08. Per-run telemetry. The LLM-vs-non-LLM breakdown reads from here.
CREATE TABLE IF NOT EXISTS model_runs (
    run_id        String,
    investigation_id String,           -- ALWAYS set; stages run before an insight exists
    insight_id    String DEFAULT '', -- set only once Narrate has produced one
    tenant_id     String,
    stage         String,           -- trust_gate|detect|localize|forecast|causal|decide|narrate
    engine_type   String,           -- 'llm'|'sql'|'stats'|'ml'|'rule'
    model         String DEFAULT '',-- 'qwen2.5-3b-awq' or ''
    inputs_hash   String DEFAULT '',
    tokens_in     UInt32 DEFAULT 0,
    tokens_out    UInt32 DEFAULT 0,
    latency_ms    UInt32,
    cost_est_usd  Float64 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1,
    ts            DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, ts);

-- Stage 08. Human feedback loop. Never train a policy on un-audited output.
CREATE TABLE IF NOT EXISTS outcomes (
    outcome_id String,
    investigation_id String,
    insight_id String,
    tenant_id  String,
    signal     String,               -- 'root_cause_correct'|'useful'|'action_taken'
    value      String,               -- 'yes'|'no'|'partial'|rating
    actor      String,
    ts         DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, insight_id, ts);
```

## How `/ai_report` changes

Keep the route and its response contract so the dashboard and `/admin/app/{id}/summary` do not
break. Internally it stops calling the LLM directly and instead reads the latest `insights` row
for the tenant and requested persona, plus the linked `trust_findings` / `anomalies` /
`root_causes` / evidence. Preserve the three-layer fallback: if no insight exists or the pipeline
failed, fall back to the existing rule-based summary rather than erroring.

## Engine-type vocabulary (used everywhere)

`llm` (a vLLM call), `sql` (a ClickHouse aggregation), `stats` (robust residuals, BH, materiality,
baseline forecasts), `ml` (a learned forecast model — unused in Phase 1), `rule` (deterministic
heuristic). Every produced number carries one. This is the backbone of the LLM-vs-non-LLM
deliverable, so it must be recorded at write time, never inferred later.
