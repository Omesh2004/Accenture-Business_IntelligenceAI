# FinInsights Data Flow Guide

This document is an orientation map for AI agents working in this repository. It explains where data originates, how it is transformed, where it is stored, and how it reaches users.

## System Boundary

FinInsights is a monorepo containing separate deployable systems. The systems intentionally share only:

1. The HTTP event envelope sent to `POST /events`.
2. The tenant vocabulary used to filter analytics.

There is no shared library, shared database, or shared type system across the applications.

| System | Technology | Port | Entry point | Main responsibility |
|---|---|---:|---|---|
| NexaBank backend | Express + Prisma | 5000 | `NexaBank/backend/src/server.ts` | Banking operations, Postgres writes, backend event production |
| NexaBank frontend | Next.js | 3002 | `NexaBank/frontend/` | Banking UI and browser-direct telemetry |
| Ingestion API | FastAPI + aiokafka | 8000 | `ingestion/main.py` | Validate, sanitize, gate, and route telemetry |
| Kafka | Kafka + Zookeeper | 9092 | `docker-compose.yml` | Durable event buffer |
| Processor worker | confluent-kafka | - | `processing/worker.py` | Batch Kafka messages into ClickHouse |
| ClickHouse | OLAP database | 8123/9000 | `storage/schema.sql` | Raw telemetry, aggregates, configuration, intelligence findings |
| Analytics API | FastAPI | 8001 | `api/main.py` | Query ClickHouse and expose analytics JSON/WebSockets |
| Analytics dashboard | Next.js | 3001 | `analytics-dashboard/` | Fetch and render analytics |
| vLLM | OpenAI-compatible inference server | 8002 | `vllm_entrypoint.sh` | Optional narrative generation |
| Postgres | PostgreSQL via Supabase | 5432 | Prisma configuration | Banking state and source event record |

## Two Independent Data Domains

### Banking domain: Postgres

Postgres contains operational banking state accessed by NexaBank through Prisma:

- `Customer`: identity, credentials, role, tenant, KYC status
- `Account`: balances and account state
- `Transaction`: deposits, payments, transfers, amounts, statuses
- `Loan`: active loans and repayment data
- `LoanApplication`: applications, KYC step, approval state
- `Payee`: payment recipients
- `UserLocation`: location, IP, device and user-agent data
- `UserLicense`: customer-level licenses
- `FeatureToggle`: application feature switches
- `Event`: source event record used by backend telemetry

Postgres is used by the banking application. The Analytics API does not query Postgres, and analytics queries do not join Postgres records with ClickHouse records.

### Analytics domain: ClickHouse

ClickHouse contains telemetry and analytics-side configuration/derived results:

- Raw events in `feature_intelligence.events_raw`
- Daily aggregate states in `daily_feature_usage`
- Failed event payloads in `events_dead_letter`
- License catalog in `tenant_licenses`
- Tracking switches in `tracking_toggles`
- Administrative changes in `config_audit_log`
- Legacy reports in `ai_reports`
- Phase 1 investigation findings in the Signal Store tables

## Primary Telemetry Flow

```text
NexaBank backend / browser / seed script
    -> POST /events (:8000)
    -> FeatureEvent validation
    -> metadata sanitization
    -> tracking toggle check
    -> Kafka topic feature-events
         OR direct ClickHouse fallback when Kafka is unavailable
    -> processor-worker (Kafka path only)
    -> events_raw
    -> materialized view
    -> daily_feature_usage
    -> Analytics API (:8001)
    -> dashboard REST JSON or WebSocket messages
```

## Producer Paths

### 1. Live backend events

Backend controllers call `trackEvent()` in `NexaBank/backend/src/middleware/eventTracker.ts`.

```text
backend controller
    -> trackEvent(eventName, customerId, tenantId, metadata)
    -> hash customer ID with SHA-256
    -> create Postgres Event row
    -> forwardToIngestionAPI(...) without awaiting it
```

The Postgres `Event` row contains:

- Prisma-generated UUID `id`
- Original `eventName`
- Internal tenant ID (`bank_a` or `bank_b`)
- Hashed `userId`
- Optional raw `customerId`
- JSON metadata
- Event timestamp

The forwarding call contains a separate analytics envelope. It passes the Postgres UUID as `event_id`, so a retry refers to the same logical event.

Important behavior: telemetry forwarding is fire-and-forget. A failed analytics request must not break a banking request.

### 2. Browser-direct events

`NexaBank/frontend/lib/tracker.ts` posts directly to the ingestion API.

```text
NexaBank browser
    -> browser session ID and browser context
    -> POST /events (:8000)
```

This path does not first create a Postgres `Event` row. It generates its own `event_id`, sends an anonymous or authenticated user ID, and includes browser-derived device/location data when available.

### 3. Seed data

`scripts/seed_data.py` generates synthetic session events and posts them directly to `POST /events`.

It is synthetic analytics data, not banking ground truth. Its sessions keep a stable profile so event dimensions remain suitable for localization.

### 4. NexaBank simulation

`NexaBank/backend/src/routes/eventRoutes.ts` exposes the admin simulation route.

It can create synthetic Postgres customers, accounts, transactions, loan applications, locations, and licenses. It then calls `trackEvent()`, so its telemetry follows the live backend path:

```text
simulation route
    -> synthetic Postgres banking records
    -> Postgres Event rows
    -> ingestion API
    -> Kafka or ClickHouse
```

The simulator creates the shape of a KPI movement. It does not store causal ground truth explaining the movement.

## Event Envelope

`core/models.py` defines `FeatureEvent`, the contract accepted by the ingestion API:

```text
event_id: string       stable logical ID; default empty for legacy producers
session_id: string     session grouping ID; default empty for legacy producers
event_name: string    tracked event name
tenant_id: string      analytics tenant ID
user_id: string        hashed or anonymous user ID
timestamp: float      Unix timestamp
channel: enum         web | mobile | api | batch
metadata: object      event-specific JSON properties
```

ClickHouse stores the envelope as columns:

```text
event_id, session_id, tenant_id, event_name, user_id,
channel, timestamp, metadata
```

`metadata` is serialized as a JSON string. It is queried with ClickHouse `JSONExtract*` functions.

## Transformations Before Storage

### Event names

There are three taxonomy points:

1. NexaBank backend `enforceTaxonomy()` in `eventTracker.ts`
2. Ingestion normalization in `core/event_names.py`
3. Read-time canonicalization in `api/page_map.py`

The intended shape is:

```text
page.feature.status
```

Examples:

```text
login.auth.success
dashboard.page.view
loan.kyc_completed.success
transaction.pay_now.success
```

Unknown or legacy names are usually coerced instead of rejected. A name can become `core.<name>.action`, which means taxonomy mistakes often produce silent zeroes rather than HTTP errors.

Analytics readers canonicalize aliases before aggregating. Any new or renamed event must be checked in all relevant producer, ingestion, and read-time taxonomy paths.

### Tenant IDs

NexaBank's internal tenant IDs are mapped to analytics IDs:

```text
bank_a   -> nexabank
bank_b   -> safexbank
```

Analytics tenant filters must use `nexabank` and `safexbank` unless a specific boundary explicitly requires the internal name.

### User IDs

The backend hashes customer IDs with SHA-256 before sending telemetry. The browser tracker may use an authenticated ID or `anonymous`. ClickHouse telemetry does not contain the raw Postgres `customerId` relationship.

### Session IDs

Session IDs come from browser `sessionStorage`, the `x-session-id` request header, event metadata, or a generated fallback.

The backend caches geo/device/channel profile values by session ID. This makes dimensions invariant inside a session, which is required for valid session-grain funnel and localization calculations.

### Metadata enrichment

The backend forwarding path adds or derives:

- `session_id`
- `source_tenant`
- `role`
- `device_type`
- `location` (country value)
- `continent`
- `city`
- `response_time_ms`
- `path`
- `tier`

`channel` is a top-level ClickHouse column. It is not a metadata key for analytics queries.

`location` is the physical metadata key for country values. Do not invent a `country` key in KPI contracts or localization SQL.

### Metadata sanitization

`ingestion/main.py` calls `sanitize_metadata()` from `core/security.py` before routing. Sensitive metadata such as emails and IP addresses is redacted or masked before analytics storage.

## Ingestion Routing

The ingestion handler is `ingestion/main.py:/events`.

1. Parse and validate the `FeatureEvent`.
2. Sanitize metadata.
3. Read cached tracking toggles from ClickHouse.
4. Compare both the raw and canonical event-name forms.
5. Reject disabled telemetry with HTTP 403.
6. In cloud mode, send to Kafka first.
7. If Kafka cannot be reached or the send times out, insert directly into `events_raw`.
8. In on-prem mode, validate the configured tenant, anonymize the user ID, and insert directly into ClickHouse.

The fallback is intentional: analytics availability must not stop banking telemetry or banking requests.

`GET /health` reports whether the current ingest path is Kafka or the direct ClickHouse fallback.

## Kafka and Worker Flow

Kafka topic:

```text
feature-events
```

`processing/worker.py` uses:

- Consumer group: `feature-processor-group`
- `auto.offset.reset=earliest`
- Manual offset commits
- Batch size: 500
- Flush interval: 2 seconds

```text
Kafka message
    -> JSON decode
    -> in-memory batch
    -> ClickHouse insert_events()
    -> asynchronous Kafka offset commit
```

Offsets are committed only after the batch is durably inserted or failed rows are accounted for. The delivery model is at-least-once.

A worker crash after insertion but before offset commit can replay a message. `events_raw` is a `MergeTree` and does not physically deduplicate rows. Important readers therefore count distinct `event_id` values rather than rows.

Failure handling:

- Temporary ClickHouse outage: exponential backoff, keep the batch, stop pulling more Kafka messages.
- Individual poison rows: isolate rows, write them to `events_dead_letter`, continue with valid rows.
- Entire batch fails: probe ClickHouse; hold for replay if the sink is unavailable, dead-letter if the sink is reachable and rows are malformed.

## ClickHouse Tables and Derivations

### `events_raw`

Primary event-level telemetry table. It stores the normalized envelope and sanitized metadata.

Ordering is by tenant, event name, and timestamp. It is partitioned by event year in the current schema.

### `daily_feature_usage`

An `AggregatingMergeTree` populated by `mv_daily_feature_usage` whenever rows enter `events_raw`.

Grouping keys:

```text
tenant_id, event_name, toDate(timestamp)
```

Aggregate states:

- `event_count`: `uniqExact` state over event IDs
- `unique_users`: `uniq` state over user IDs

Read aggregate states with:

```sql
uniqExactMerge(event_count)
uniqMerge(unique_users)
```

Materialized views process new inserts only. They do not backfill old data automatically and do not observe deletes. If raw data is deleted, the derived rollup must be rebuilt.

### Configuration and administration tables

- `tenant_licenses`: which analytics features are licensed and their plan tier
- `tracking_toggles`: whether a feature's telemetry is enabled per tenant
- `config_audit_log`: who changed configuration, what changed, and when
- `events_dead_letter`: failed Kafka payloads and insertion errors
- `ai_reports`: legacy latest report per tenant

### Signal Store

Phase 1 tables are linked by `investigation_id`:

- `investigations`: one investigation run and its status
- `trust_findings`: data-quality verdicts, including passes
- `anomalies`: detected KPI movements
- `root_causes`: ranked additive-dimension contributions
- `forecasts`: scheduled prediction bands
- `causal_effects`: causal evidence rung and interval
- `recommendations`: guarded proposed actions
- `insights`: narrated result, evidence, qualifiers, and verifier state
- `model_runs`: stage telemetry and engine type
- `outcomes`: human feedback and action outcomes

Every number intended for narration should trace to a Signal Store fact or an approved contract field.

## Analytics API Read Path

The Analytics API is `api/main.py` on port 8001. It uses `storage/client.py`.

`ClickHouseClient` creates a fresh ClickHouse client per query or insert because the underlying client is not thread-safe in the FastAPI thread-pool model.

The dashboard never queries ClickHouse directly.

Main REST read groups:

| API group | Data returned |
|---|---|
| `/metrics/kpi` | Distinct event totals, active canonical features, period changes, latency-related KPIs |
| `/metrics/secondary_kpi` | Secondary KPI cards |
| `/metrics/traffic` | Date-based visitors/page views |
| `/metrics/feature_usage_series` | Feature usage over time |
| `/features/usage` | Event/feature totals and unique users |
| `/funnels` | Ordered user funnel counts and drop-offs using `windowFunnel` |
| `/features/activity` | Feature activity levels and time segments |
| `/features/heatmap` | Feature-by-group or feature-by-time matrix |
| `/metrics/devices` | Metadata device breakdown |
| `/metrics/channels` | Top-level event channel breakdown |
| `/locations` | Metadata location aggregation |
| `/metrics/top_pages` | Metadata path aggregation and nested feature counts |
| `/audit_logs` | Analytics-side activity/config logs |
| `/metrics/realtime_users` | Recent active user count |
| `/metrics/pages_per_minute` | Recent event activity by hour |
| `/metrics/retention` | User/session retention calculations |
| `/metrics/pro_users` | Pro-tier usage calculations |
| `/license/usage` | Licensed versus used features |
| `/journey/user`, `/journey/users` | User/session event journeys |
| `/predictive/adoption` | Existing predictive adoption output |
| `/tenants/compare` | Cross-tenant comparison |
| `/admin/summary` | Cloud-level aggregate summary |
| `/admin/app/{tenant_id}/summary` | App summary for super-admin views |
| `/transparency/cloud-data` | Deployment/data visibility information |
| `/insights` | Legacy cached or rule-based insights |
| `/ai_report` | Legacy report response shape; retained for compatibility |

Most endpoints accept comma-separated tenants and a range such as `7d`, `30d`, or `90d`. Tenant access is enforced using request headers and server-side role logic.

## Dashboard Read Path

The dashboard's central hook is `analytics-dashboard/src/hooks/useDashboard.ts`.

It resolves:

- Active app from the URL
- Allowed tenant scope from the authenticated session
- Selected tenants from Redux
- Time range from Redux

It then calls typed methods in `analytics-dashboard/src/lib/api.ts`. The main dashboard batch requests KPI, traffic, feature, funnel, tenant, real-time, location, audit, license, and retention data in parallel.

```text
Next.js page/component
    -> useDashboardData()
    -> dashboardAPI method
    -> Axios request to Analytics API :8001
    -> ClickHouse query
    -> UI-shaped JSON
    -> Redux / React Query
    -> cards, charts, tables, panels
```

The app URL does not select a different database. It selects an application scope, which resolves to a tenant list used in ClickHouse filters.

## Real-Time Flow

There are two WebSocket data paths, both served by the Analytics API.

### Event stream

`api/websocket_manager.py` consumes Kafka with consumer group `websocket-broadcaster-group`, starting at the latest messages. It broadcasts each event to connections registered for that tenant.

```text
Kafka feature-events
    -> websocket_manager.consume_kafka_events()
    -> REALTIME_EVENT
    -> dashboard useRealtimeEvents()
```

The dashboard event object contains event name, tenant ID, user ID, metadata, and client receipt time.

### Metric updates

Every 10 seconds, `poll_dashboard_metrics()` queries ClickHouse for KPI metrics and real-time users, then broadcasts:

```text
METRICS_UPDATE
```

`useDashboardData()` updates Redux and invalidates the active React Query dashboard query. It also performs a normal 15-second dashboard refetch while the page is active.

## Authentication and Authorization Data

Dashboard authentication uses Google OAuth and NextAuth JWT sessions in `analytics-dashboard/src/app/api/auth/[...nextauth]/route.ts`.

```text
Google identity
    -> NextAuth JWT
    -> role/admin-app lookup in rbac.json
    -> session.user.role
    -> session.user.adminApps
    -> Analytics API request headers
```

The dashboard sends:

```text
X-User-Email
X-User-Role
X-Admin-Apps
X-Active-App
```

`AuthGuard` protects browser routes, while Analytics API middleware performs server-side authorization. The browser guard is not a substitute for API authorization.

Roles:

- `super_admin`: global summaries and app summaries, not detailed analytics
- `app_admin`: detailed analytics for assigned app/tenants
- `user`: no analytics dashboard access

## App and Tenant URL Scoping

The Next.js route group `(main)` applies the common dashboard shell but does not appear in URLs.

The dynamic segment `[appName]` appears in URLs and scopes the selected app:

```text
(main)/[appName]/funnel/page.tsx -> /nexabank/funnel
(main)/[appName]/dashboard/page.tsx -> /nexabank/dashboard
```

The app-scoped pages re-export the underlying unscoped page implementations. `buildAppScopedPath()` creates these URLs, while `resolveAppIdFromPathname()` extracts the app ID and drives tenant selection.

The current app suite maps the `nexabank` app to both `nexabank` and `safexbank` analytics tenants.

## Current Legacy AI Path

The currently implemented report flow is:

```text
ClickHouse
    -> api/data_layer.py
    -> PRECOMPUTED_LAYER in process memory
    -> api/insights.py
    -> optional vLLM request (:8002)
    -> JSON parsing
    -> rule-based fallback if unavailable
    -> ai_reports ClickHouse row
    -> /insights or /ai_report
    -> dashboard AI panel
```

`api/data_layer.py` periodically computes low-adoption, trending, and performance summaries. `api/insights.py` turns those summaries into an LLM prompt or deterministic insight objects.

This is not yet the complete Phase 1 investigation pipeline.

## Intended Phase 1 Intelligence Path

The target flow in `docs/PHASE_1.md` is:

```text
Scheduled Forecast
    -> forecasts table

KPI movement
    -> Foundation
    -> Trust Gate
    -> Detect
    -> Localize
    -> Causal
    -> Decide
    -> Narrate and Verify
    -> Signal Store
    -> dashboard evidence and narrative
```

Rules for agents working on this path:

- Forecast runs before Detect and supplies the prediction band.
- Trust Gate is a gate. A failed verdict terminates the business path and produces an engineering/incident note.
- Specialists read through the Metric API or metric functions, not raw `events_raw` SQL.
- Localize additive fundamentals at the contract's declared grain; do not localize naked rates or distinct-user counts.
- Every stage writes the relevant Signal Store row.
- Every model/stage run writes `model_runs` with `engine_type` such as `llm`, `sql`, `stats`, `ml`, or `rule`.
- The narrator receives compact Signal Store cards, never unrestricted raw query output.
- Every narrated number must pass numeric verification against stored facts.
- Restricted claims are removed before the narrator receives context.
- Keep deterministic narration as the correctness fallback.

## Agent Safety Checks

Before changing a data path, check:

1. Which database owns the data: Postgres or ClickHouse?
2. Is the value raw telemetry, a derived aggregate, configuration, authentication data, or banking state?
3. Which tenant vocabulary is valid at this boundary?
4. Does the event pass through one, two, or three taxonomy dialects?
5. Is `event_id` preserved so replay-safe distinct counts remain correct?
6. Is `session_id` stable for the required grain?
7. Is `channel` a top-level column or a metadata key?
8. Is `location` the country-valued physical metadata key?
9. Does a schema change require both `storage/schema.sql` and manual DDL on a running ClickHouse volume?
10. Does an API response change require updates to `analytics-dashboard/src/lib/api.ts`, dashboard types, and all consumers?
11. Does the change preserve fire-and-forget telemetry forwarding?
12. Is the implementation current behavior or only a Phase 1 target?

## Verification Commands

From the repository root:

```powershell
python scripts/verify_data_quality.py
python compile_check.py
python check_syntax.py
```

For taxonomy behavior, execute the real function rather than duplicating its rules:

```powershell
python -c "import sys; sys.path.insert(0,'.'); from api.page_map import canonicalize_event_name as c; print(c('loan.approved.success'))"
```

For a running stack:

```powershell
docker compose up
```

Services:

```text
Dashboard:    http://localhost:3001
NexaBank UI:  http://localhost:3002
NexaBank API: http://localhost:5000
Ingestion:    http://localhost:8000
Analytics:    http://localhost:8001
ClickHouse:   http://localhost:8123
```

ClickHouse schema initialization runs only for an empty data volume. Editing `storage/schema.sql` alone does not migrate an existing volume.
