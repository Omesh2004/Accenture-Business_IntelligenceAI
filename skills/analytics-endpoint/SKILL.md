---
name: analytics-endpoint
description: >
  Use when adding or modifying an endpoint in the FinInsights Analytics API (api/main.py, port
  8001). Encodes the repo's fixed patterns (thread-safe ClickHouse client, bound params, tenant
  filter idiom, UI-shaped responses, canonicalize-before-aggregate) and its traps (the duplicate
  /insights route, f-string SQL, the 17-parallel-call dashboard batch, the change-shape checklist).
---

# Working on an Analytics API endpoint

`api/main.py` is ~3,610 lines: all endpoints plus `RBACMiddleware`, SQL embedded in handlers, no
repository layer. Follow the existing shape rather than introducing a new one. For new Phase 1
pipeline code, prefer a new module under `api/intelligence/` and keep `api/main.py` thin.

## Patterns to follow

- All analytics endpoints are `GET`, take `tenants` (comma-separated) and usually `range`
  (`"7d"`, parsed by `parse_range`, default 7), and are gated by `RBACMiddleware`.
- Responses are pre-shaped for the UI: icon names, hex colors, formatted strings. Match that; the
  dashboard renders the payload directly.
- Build a ClickHouse client per call via `ClickHouseClient` (handlers are `def`, run in a thread
  pool; the client is not thread-safe). Do not add a pooled global.
- Use `%(name)s` bound params. The tenant idiom, repeated in ~25 endpoints:
  ```python
  cond = "tenant_id = %(tenant_id)s" if len(tenants) == 1 else "tenant_id IN %(tenant_ids)s"
  ```
- Canonicalize event names before aggregating (`canonicalize_event_name`), or aliases split into
  separate buckets and counts look wrong.

## Traps (these have bitten before)

- **The duplicate `/insights` route.** `@app.get("/insights")` is declared twice: one handler
  (`api/main.py:625`) is cache/DB-backed LLM insights, the other (`api/main.py:3563`) is pure
  rule-based SQL. FastAPI serves the FIRST to HTTP callers, but the Python name `get_insights`
  resolves to the SECOND, which `/admin/app/{id}/summary` calls directly at `api/main.py:2082`.
  Do not add a third, and do not delete either without tracing both call paths. For Phase 1,
  resolve this while writing the new `/ai_report` reader, not before.
- **f-string SQL — and there is live SQL injection.** SQL is string-built. Any value interpolated
  as a literal (e.g. funnel step names in `/funnels`) must be escaped with the local `sql_quote`;
  prefer `%(name)s` params. **`/tracking/toggles` GET and POST (`api/main.py:2489` and `:2644`)
  interpolate a caller-supplied tenant CSV with no escaping at all** — a ten-minute fix that has
  not been made (`docs/TASK.md` P1-7). Copy the parameterised idiom, never these two.
- **Time.** Do not use `today()` — it is ClickHouse **server-local** and no timezone is pinned on
  the container. Use `toDate(now('UTC'))`, bound the window at **both** ends, and make the current
  and previous windows the same length; the existing
  `>= today() - 7` vs `>= today() - 14 AND < today() - 7` pattern biases every `pct_change` in the
  file upward. See `CLAUDE.md`, Never do.
- **Exact aggregates only if the number must be reproducible.** `uniq()` is HyperLogLog and
  `quantile()`/`median()` are **reservoir sampling with an RNG**. Use `uniqExact`,
  `quantileExact`, `medianExact`, and `min()`/`argMin()` rather than `any()`. Existing code does
  not follow this — `/metrics/kpi` and `api/data_layer.py` both use `any()` inside aggregate
  subqueries, and `daily_feature_usage.unique_users` is a `uniq` state.
- **The dashboard batch.** `useDashboard.ts` fires ~17 parallel calls every 15s per open tab, each
  opening a fresh ClickHouse connection. If you add an endpoint to that hook, you add to that load;
  keep new endpoints cheap or out of the hot batch.
- **Internal callers.** `/ai_report` and `/admin/app/{id}/summary` call handler functions
  directly, not over HTTP. Changing a handler's return type can break them silently.
- **`/funnels` is user-grain.** It computes `windowFunnel(...) GROUP BY user_id`, so its counts are
  distinct **users**, which are not additive across dimensions. That output is for display; it is
  not a localizable fundamental. See `docs/KPI_CONTRACT.md`.
- **`total_events` is two different things.** In `daily_feature_usage` it **was** a stored column;
  FOUNDATION-4 has landed and it is now `event_count AggregateFunction(uniqExact, String)`, read
  with `uniqExactMerge`. Elsewhere in `api/main.py`, `total_events` is still a local `count()`
  alias over `events_raw` — do not confuse the two. The rollup readers are
  `api/data_layer.py:30,41,42`, `api/insights.py:126,139,140`, and
  `api/main.py:554,1911,1919,2780,2833,2834`.
- **The rollup cannot answer alias or session questions.** `daily_feature_usage` is keyed on the
  **raw** `event_name`, so aliases of one canonical feature are separate rows whose `uniq` states
  cannot be merged — which is why `/features/usage` does `max(a, b)` (under-counts) while
  `/predictive/adoption` does `+=` (over-counts), and the same fact yields different numbers on
  different pages. It also carries no session state, so no session-grain metric can come from it.
- **RBAC is not enforcing what it looks like.** `require_tenant_access` only acts in `ON_PREM`
  mode, so it is a **no-op in the CLOUD default the stack runs**, and `RBACMiddleware` trusts
  browser-set headers. Do not treat either as an access-control guarantee when adding an endpoint
  that returns user-level data.

## When you change a response shape (`CLAUDE.md` rule 6)

Update all four, in this order, or the dashboard breaks:
1. the handler in `api/main.py`,
2. the matching method and `Backend*` interface in `analytics-dashboard/src/lib/api.ts`,
3. the type in `analytics-dashboard/src/types/index.ts`,
4. the consuming component (and `useDashboard.ts`'s return object if it is a batched call).

The `lib/api.ts` header interceptor and `RBACMiddleware` are a matched pair (coupling point 4):
never rename a header on one side only.

## Phase 1 additions

New reads for the pipeline (evidence card, insight, telemetry breakdown) should read from the
Signal Store tables (see `docs/DATABASE.md`), not from `events_raw` directly. Keep them out of the
15-second dashboard batch; fetch them on insight open or on the new-insight WebSocket ping.

Specialists must not gain their own SQL path into `events_raw` — they read through the Metric API
or the KPI-contract loader, so that every number has one definition. If a specialist needs an
aggregation no endpoint provides, add a metric function rather than an ad-hoc query.

Robust statistics (median, MAD, quantiles) can live in ClickHouse — it keeps the data where it is
and tags cleanly as `engine_type='sql'`. **But use the `Exact` variants.** ClickHouse's
`quantile()` and `median()` are reservoir sampling with an RNG; their own docs say the result is
non-deterministic, and Detect is exactly where someone reaches for `quantile()` to compute a
median/MAD by reflex. `quantileExact`/`medianExact` are the only acceptable forms.

The "it avoids a new dependency" argument no longer applies: `numpy` and `scipy` are approved and
declared (`CLAUDE.md` rule 2, superseding the earlier deterministic-only rule), so pick whichever
is clearer for the stage. What does not change is that every method writes the same row shape,
carries an `engine_type`, and degrades to a dependency-free fallback.
