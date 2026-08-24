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
  (`api/main.py:566`) is cache/DB-backed LLM insights, the other (`api/main.py:3425`) is pure
  rule-based SQL. FastAPI serves the FIRST to HTTP callers, but the Python name `get_insights`
  resolves to the SECOND, which `/admin/app/{id}/summary` calls directly. Do not add a third, and
  do not delete either without tracing both call paths. For Phase 1, resolve this (one
  implementation) before extending.
- **f-string SQL.** SQL is string-built. Any value interpolated as a literal (e.g. funnel step
  names in `/funnels`) must be escaped with the local `sql_quote`; prefer `%(name)s` params.
- **The dashboard batch.** `useDashboard.ts` fires ~17 parallel calls every 15s per open tab, each
  opening a fresh ClickHouse connection. If you add an endpoint to that hook, you add to that load;
  keep new endpoints cheap or out of the hot batch.
- **Internal callers.** `/ai_report` and `/admin/app/{id}/summary` call handler functions
  directly, not over HTTP. Changing a handler's return type can break them silently.
- **`/funnels` is user-grain.** It computes `windowFunnel(...) GROUP BY user_id`, so its counts are
  distinct **users**, which are not additive across dimensions. That output is for display; it is
  not a localizable fundamental. See `docs/KPI_CONTRACT.md`.
- **`total_events` is two different things.** In `daily_feature_usage` it is a stored column
  (being replaced by `uniqExactState(event_id)` — FOUNDATION-4); elsewhere in `api/main.py` it is
  a local `count()` alias over `events_raw`. Do not migrate the wrong ones. The rollup readers are
  `api/data_layer.py:30,41,42`, `api/insights.py:126,139,140`, and
  `api/main.py:554,1911,1919,2780,2833,2834`.

## When you change a response shape (coupling point 4)

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

Robust statistics (median, MAD, quantiles) belong in ClickHouse rather than Python: it avoids a
new dependency, keeps the data where it is, and tags cleanly as `engine_type='sql'`.
