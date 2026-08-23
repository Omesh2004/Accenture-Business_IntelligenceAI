# DATABASE.md

Everything about ClickHouse for Phase 1: how it works here, the migration procedure (there is
no runner), the exact Signal Store DDL to add, and the one correctness fix to verify.

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

## Current tables (do not change their shapes in Phase 1)

`events_raw` (MergeTree, PARTITION toYYYYMM(timestamp), ORDER BY tenant_id,event_name,timestamp;
`metadata` is a JSON String read with JSONExtract*), `daily_feature_usage` (AggregatingMergeTree
rollup via `mv_daily_feature_usage`), `tenant_licenses`, `tracking_toggles`, `config_audit_log`,
`ai_reports`.

### Two edits to existing objects

1. **Add `event_id` and `session_id` to `events_raw`.** `event_id` is a deterministic hash of the
   natural key (source id + source sequence + timestamp), added at emit time in the tracker and
   carried through `FeatureEvent`. It makes consumption idempotent so a worker restart cannot
   double-count. `session_id` comes from the tracker so sessions are exact rather than inferred
   by 30-minute gaps. Add the columns with `ALTER TABLE events_raw ADD COLUMN ... DEFAULT ''`.

2. **Verify the decaying-sum column in `daily_feature_usage`.** `unique_users` is
   `AggregateFunction(uniq)` and is correct (read with `uniqMerge`). Check whether there is an
   event-count/total column stored as a plain `UInt64` inside the AggregatingMergeTree. If so, it
   silently drifts as background merges collapse blocks (non-aggregate columns are not summed on
   merge). Fix by converting it to `SimpleAggregateFunction(sum, UInt64)` (or
   `AggregateFunction(sum, UInt64)` read with `sumMerge`) and always aggregate with `GROUP BY`.
   Confirm with a test: insert known blocks, `OPTIMIZE ... FINAL`, assert the sum is unchanged.

## Signal Store: new tables for Phase 1

Add these to `storage/schema.sql` and apply via the procedure above. Small demo tables, so
ORDER BY is enough; no partitioning needed. All findings are written here; the narrator may
state only what these tables contain.

```sql
-- The detected move. One row per (tenant, kpi, window, method).
CREATE TABLE IF NOT EXISTS anomalies (
    anomaly_id   String,            -- hash(tenant_id, kpi_id, window_start, method)
    tenant_id    String,
    kpi_id       String,            -- matches a contract id in contracts/*.yaml
    detected_at  DateTime,
    window_start DateTime,
    window_end   DateTime,
    method       String,            -- 'ruptures_pelt' | 'mad' | 'rule'
    direction    Int8,              -- -1 drop, +1 spike, 0 categorical
    magnitude    Float64,           -- signed effect size
    baseline     Float64,
    observed     Float64,
    materiality  Float64,           -- significance x impact x persistence
    severity     String,            -- 'info' | 'warn' | 'urgent'
    status       String DEFAULT 'open',   -- open|investigating|explained|dismissed
    engine_type  String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree(detected_at)
ORDER BY (tenant_id, kpi_id, window_start);

-- Ranked localization output. Contributions sum to ~1 across ranks.
CREATE TABLE IF NOT EXISTS root_causes (
    cause_id      String,
    anomaly_id    String,
    tenant_id     String,
    rank          UInt8,
    dimensions    String,           -- JSON: {"device_type":"mobile","country":"IN"}
    contribution  Float64,
    method        String,           -- 'psqueeze' | 'groupby'
    explained_pct Float64,
    engine_type   String DEFAULT 'stats'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, rank);

-- Only written for the sparse-history scenario.
CREATE TABLE IF NOT EXISTS forecasts (
    forecast_id  String,
    tenant_id    String,
    kpi_id       String,
    as_of        DateTime,
    horizon_days UInt16,
    point        Float64,
    lower        Float64,
    upper        Float64,
    method       String,            -- 'chronos' | 'seasonal_naive' | 'category_prior'
    confidence   Float64,
    caveat       String DEFAULT '', -- 'insufficient_history'
    engine_type  String DEFAULT 'ml'
) ENGINE = ReplacingMergeTree(as_of)
ORDER BY (tenant_id, kpi_id, as_of);

-- Minimal rules-based recommendation. Impact is an interval, never a point.
CREATE TABLE IF NOT EXISTS recommendations (
    rec_id          String,
    anomaly_id      String,
    tenant_id       String,
    action          String,
    lever           String,
    owner_role      String,
    expected_impact String,         -- JSON: {"low":..,"high":..}
    status          String DEFAULT 'proposed',
    engine_type     String DEFAULT 'rule'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, anomaly_id, rec_id);

-- The narrated output. One row per (tenant, persona, anomaly). Replaces ai_report content.
CREATE TABLE IF NOT EXISTS insights (
    insight_id    String,
    tenant_id     String,
    anomaly_id    String,
    persona       String,           -- 'cfo' | 'ops_manager' | 'default'
    generated_at  DateTime,
    headline      String,
    narrative     String,
    evidence      String,           -- JSON array: {metric_id, source, as_of, method,
                                     --             contribution, confidence, lineage_ref}
    llm_breakdown String,           -- JSON: which numbers came from which engine
    confidence    Float64,
    abstained     UInt8 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1
) ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (tenant_id, persona, anomaly_id);

-- Per-insight telemetry. The LLM-vs-non-LLM breakdown reads from here.
CREATE TABLE IF NOT EXISTS model_runs (
    run_id        String,
    insight_id    String,
    tenant_id     String,
    stage         String,           -- 'trust_gate'|'detect'|'localize'|'forecast'|'narrate'
    engine_type   String,           -- 'llm'|'sql'|'stats'|'ml'|'rule'
    model         String DEFAULT '',-- 'qwen2.5-3b-awq' or ''
    tokens_in     UInt32 DEFAULT 0,
    tokens_out    UInt32 DEFAULT 0,
    latency_ms    UInt32,
    cost_est_usd  Float64 DEFAULT 0,
    verifier_pass UInt8 DEFAULT 1,
    ts            DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, ts);

-- Human feedback loop (Should-have). Never train a policy on un-audited output.
CREATE TABLE IF NOT EXISTS outcomes (
    outcome_id String,
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
for the tenant and requested persona, plus the linked `anomalies` / `root_causes` / evidence.
Preserve the three-layer fallback: if no insight exists or the pipeline failed, fall back to the
existing rule-based summary rather than erroring.

## Engine-type vocabulary (used everywhere)

`llm` (a vLLM call), `sql` (a ClickHouse aggregation), `stats` (ruptures/MAD/BH/materiality),
`ml` (a forecast model), `rule` (deterministic heuristic). Every produced number carries one.
This is the backbone of the LLM-vs-non-LLM deliverable, so it must be recorded at write time,
never inferred later.
