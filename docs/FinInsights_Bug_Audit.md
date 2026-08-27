# FinInsights — Repository Bug Audit

Scope: full read of `ingestion/`, `processing/`, `storage/`, `core/`, `api/`, `contracts/`, `scripts/`, `docker-compose.yml`, `NexaBank/backend/src/middleware/eventTracker.ts`, `NexaBank/backend/src/routes/eventRoutes.ts`, `NexaBank/frontend/hooks/useEventTracker.ts`, `analytics-dashboard/src/lib/*`, `analytics-dashboard/next.config.ts`.

Method: code read, plus I executed the taxonomy functions directly to prove the drift claims rather than reasoning about them. Every claim marked **[verified by running code]** was produced by actually calling the function.

Severity key:
- **P0 — blocks the intelligence layer.** Build on top of this and the Trust Gate / Detect / Localize / Narrator will emit confident, wrong answers.
- **P1 — wrong numbers today.** The dashboard already lies, just less visibly.
- **P2 — will break under load, restart, or a second replica.**
- **P3 — cleanliness, cost, maintainability.**

---

## Section A — Fabricated data presented as measurement (P0)

This is the single biggest risk to the intelligence layer, bigger than any idempotency issue. The pipeline is technically sound but is transporting invented numbers.

### A1. `location`, `city`, `continent` are randomly generated. P0
`NexaBank/backend/src/middleware/eventTracker.ts` → `selectGeoProfile()` picks a weighted-random country per session. Unless the user hit `/events/location`, `metadata.location` is a dice roll.

Why it matters: your Localize stage decomposes a KPI move across `dimensions.allowed`. If `location` is random, Localize will still return contributions that sum to ~1.0, ranked, with an `explained_pct`. It will look completely valid and mean nothing. The contract note `live-dimensions-are-noise: resolved` is only half true — FOUNDATION-2 made the dimension *session-invariant*, which fixes additivity. It did not make it *informative*. Session-invariant randomness is still randomness.

Fix: mark simulated dimensions in the event itself (`metadata._simulated: ["location","device_type","channel"]`), and have the contract loader refuse to list a simulated dimension in `dimensions.allowed`. If you want geography in the demo, derive it once from a real signal (Accept-Language, or the actual `/events/location` payload) and leave it null otherwise. A null dimension is honest; a random one is not.

### A2. `device_type` and `channel` are randomly generated. P0
Same function, same problem. `selectDevice(geo)` rolls desktop/mobile/tablet against a hardcoded bias table. Your dashboard's Device Breakdown chart is a random number generator with a bar chart on it.

### A3. `response_time_ms` is a log-normal random draw, and the real measurement is silently thrown away. P0
`simulateResponseTime()` produces `exp(4.0 + z*0.7)` clamped to 15–300 ms.

Worse — and this is a genuine bug, not just a design choice — the frontend **does** measure real latency. `useEventTracker.measureAndTrack` writes `responseTime` (camelCase) into metadata. `forwardToIngestionAPI` reads `metadata.response_time_ms` (snake_case). The names never match, so the fallback fires every time. The real number rides along in metadata, unused, while the random one is written to the column everything reads.

### A4. The "simulated" honesty flag on the Avg Response Time KPI can never fire. P0
`api/main.py` `/metrics/kpi` counts a value as synthesised when `JSONHas(metadata,'response_time_ms')` is false. But the producer always sets that key (to the random value). So `synthesised = 0` and the card renders `simulated: false` on a value that is 100% synthetic. The safeguard is defeated by the producer that created the problem.

Fix for A3+A4: rename the frontend field to `response_time_ms`; when no real measurement exists write `null` and set `metadata._synthetic_fields: ["response_time_ms"]`; make the KPI read that flag rather than inferring from absence.

### A5. `/metrics/kpi` also synthesises latency a second time, in SQL. P1
`15 + (cityHash64(event_name, toString(timestamp)) % 285)` inside the query. So there are two independent fabrication layers stacked on the same metric. The previous-period query does the same but does not report a `simulated` count at all, so the percentage-change arrow compares fabricated against fabricated.

### A6. `/tenants/compare` invents a metric called "conversion rate". P1
```
countIf(event_count > 3) / count()   -- users with more than 3 events
```
That is not conversion. It is "users who clicked around a bit". It is labelled `conversion_rate` in the API response and rendered as a business KPI. Any narrator reading this will produce a sentence that is factually false.

### A7. `seed_licenses.py` and `seed_safexbank.py` write names no reader can resolve. P1
Licences are seeded under `pro-feature?id=crypto-trading` and `wealth_rebalance`. **[verified by running code]**:
```
'pro-feature?id=crypto-trading' -> stored 'core.pro_feature_id_crypto_trading.action'
'wealth_rebalance'              -> stored 'core.wealth_rebalance.action'
```
Neither appears in `/license/usage`'s catalog. Seeded Pro usage therefore never registers as Pro usage.

---

## Section B — Taxonomy: three dialects that disagree (P0)

There are three independent implementations of "what is this event called":
1. `NexaBank/.../eventTracker.ts` → `enforceTaxonomy()` (Node, write-side)
2. `core/event_names.py` → `normalize_ingest_event_name()` (Python, write-side)
3. `api/page_map.py` → `canonicalize_event_name()` (Python, read-side)

They are not equivalent. **[verified by running code]**:

| Producer emits | Stored in `events_raw` | Canonical at read |
|---|---|---|
| `loan.applied.action` | `loan.applied.action` | `loan.applied.success` |
| `transaction.pay_now.failed` | `transaction.pay_now.failed` | `transaction.pay_now.failure` |
| `free.loan.kyc_started` | `free.loan.kyc_started` | `loan.kyc_started.success` |
| `pro.crypto-trading.page.view` | `crypto_trading.page.view` | `crypto-trading.page.view` |
| `payment_completed` | `core.payment_completed.action` | `core.payment_completed.action` |

### B1. `action` is silently promoted to `success`. P0
`canonicalize_event_name` coerces any status not in `{view, success, failure}` to `success`. So `loan.applied.action` ("user pressed Apply") becomes `loan.applied.success` ("loan application succeeded"). You cannot compute an attempt→success conversion rate, because attempts have been relabelled as successes. This directly breaks `kyc_completion_rate` and `loan_approval_volume`.

### B2. Two spellings of failure: `failed` at write, `failure` at read. P0
The Node dialect emits `failed`. The read canonicaliser emits `failure` — but **only for pages it has an explicit branch for** (payee, transaction, account, loan, profile, the four pro pages). For `login` and `register` it falls through and returns the name unchanged. **[verified by running code]**:
```
login.auth.failed    -> canonical 'login.auth.failed'
loan.rejected.failed -> canonical 'loan.rejected.failure'
```
So the vocabulary is inconsistent *within a single function*. The `/license/usage` catalog contains `login.auth.failure` and `register.auth.failure` — keys that no real event can ever produce. Login failures are silently classified as unknown/unlicensed.

### B3. `pro.` prefix survives for 3-part names and is stripped for 4-part names. P1
`pro.crypto_trading.trade_execution.success` (4 parts) → prefix stripped. `pro.features_unlock.success` (3 parts) → preserved by Python, but mangled by Node into `features_unlock.success.action` (the status becomes the feature). Pro/entitlement detection depends on this prefix.

### B4. `normalize_event`'s legacy alias table is mostly dead code. P1
It maps raw legacy names like `payment_completed`, `kyc_started`, `location_captured`. But by the time a row is in `events_raw`, ingestion has already rewritten `payment_completed` → `core.payment_completed.action`. The alias key can never match. Dozens of entries in that dict cannot fire for anything that came through `POST /events`.

### B5. Node and Python disagree on the same legacy key. P0
`enforceTaxonomy`: `kyc_started` → `loans.kyc_started.success`.
`page_map.normalize_event`: `kyc_started` → `loans.proceed_to_kyc.action`.
Two names for the same event depending on which map you read.

### B6. Canonicalisation happens at read time, in Python, over raw names. P0
`daily_feature_usage` is keyed on the **raw** `event_name`. Every endpoint then collapses aliases in Python after the fact. Consequences:
- `uniqMerge(unique_users)` cannot be merged across aliases, so the code does `max(a, b)` instead of a union. That is not a union — it under-counts. Present in `/features/usage`, `/license/usage`, and elsewhere. Search for the comment "Avoid inflated counts".
- `/predictive/adoption` does the opposite and **adds** per-alias `uniqExact(user_id)`, which over-counts the same user twice.
- The same underlying fact yields three different unique-user numbers on three pages.

**Fix (the single highest-leverage change in this document):** canonicalise **once, at ingest**, and store both `event_name_raw` and `event_name_canonical` on the row. Add a `canonical_event` column to `daily_feature_usage` and make the MV group on it. Delete the read-time canonicalisation from all API endpoints. One dialect, one function, one place, applied before the data is written. Everything in Sections B and A7 collapses once this is done.

---

## Section C — Identity: user_id and session_id (P0)

### C1. All logged-out traffic collapses into one user called `anonymous`. P0
`trackEvent`: `const hashedUserId = customerId ? hashUserId(customerId) : "anonymous"`.

This is not a small thing. `/funnels` does:
```sql
SELECT user_id, windowFunnel(window)(timestamp, cond1, ..., condN) FROM events_raw GROUP BY user_id
```
Every logged-out person in the entire tenant is a single row in that GROUP BY. Across thousands of people, "anonymous" will have performed every step of every funnel, so `windowFunnel` returns the maximum level. Any funnel whose first stage is pre-login reports near-100% conversion. `uniq(user_id)`, bounce rate, retention, and `users_pct` in `/predictive/adoption` are all distorted by the same collapse.

Fix: funnel and retention must group on `session_id`, not `user_id` — which is also what `contracts/kyc_completion_rate.yaml` declares (`grain.entity: session`). The SQL does not match the contract. Additionally, mint a stable anonymous ID (the `sessionStorage` ID already exists) instead of the literal string.

### C2. `/events/track` requires login, so no pre-login event can exist at all. P1
`router.post("/events/track", isLoggedIn, ...)`. The register and login funnels physically cannot have a pre-auth stage. Your funnel screenshot starts at `Login.auth.success` at 100.0% — that is a definitional artefact, not a measurement.

### C3. On-prem anonymisation uses Python's `hash()`. P0
`ingestion/main.py`: `event.user_id = f"anon_{hash(event.user_id) % 1000000}"`.

Python randomises string hashing per process (PYTHONHASHSEED). The same user gets a different anon ID after every container restart. Cross-restart user identity is destroyed, so retention/DAU in ON_PREM mode is meaningless. The `% 1000000` also guarantees collisions above a few thousand users. Use `hashlib.blake2b(user_id + tenant_salt)`.

### C4. `hashUserId` is unsalted SHA-256. P2
For a banking dataset, unsalted SHA-256 over a bounded ID space is reversible by brute force. The system documentation calls this "an anonymized user identifier". Add a per-tenant secret salt.

### C5. Session profile eviction re-randomises a live session's dimensions. P2
`sessionProfiles` is capped at 10,000 with FIFO eviction. An evicted-but-still-active session gets a brand new random geo/device on its next event — reintroducing exactly the intra-session flip that FOUNDATION-2 fixed. Use a TTL keyed on last-seen, not insertion order, and size it against real concurrency.

---

## Section D — Time (P0)

### D1. Three different definitions of "a day" coexist. P0
- `daily_feature_usage.date` = `toDate(timestamp)` — plain UTC.
- `/metrics/traffic`, `/tenants/compare` trend = `toDate(timestamp + INTERVAL 330 MINUTE)` — hardcoded IST.
- 64 call sites use `today()` — ClickHouse **server-local**, which is unset in `docker-compose.yml`.
- 3 call sites use `now('UTC')` — explicit UTC.

So the KPI card, the traffic chart, and the rollup bucket events into different days. Summing the chart will not equal the card. For the intelligence layer this is fatal: an anomaly "on 2026-08-24" refers to a different 24 hours depending on which query found it, and `investigations.window_start` will not line up with the data it was computed from.

Fix: set `TZ=UTC` on the ClickHouse container, replace every `today()` with `toDate(now('UTC'))`, delete the `+330 MINUTE` offsets, and do all display-timezone conversion in the frontend.

### D2. Current and previous comparison windows are different lengths. P0
Everywhere, the pattern is:
```sql
current : timestamp >= today() - 7                              -- 7 full days + today so far
previous: timestamp >= today() - 14 AND timestamp < today() - 7  -- exactly 7 days
```
Current is 7 + (fraction of today); previous is exactly 7. Every `pct_change` in the codebase is therefore biased upward, growing through the day and resetting at midnight. Affects `/metrics/kpi`, `/metrics/secondary_kpi`, `/predictive/adoption`, `/tenants/compare`, `/insights`. Your Materiality stage will inherit this bias directly.

Fix: `timestamp >= toDate(now('UTC')) - 7 AND timestamp < toDate(now('UTC'))` for both windows — exclude the partial day, or include it symmetrically in both.

### D3. `data_layer.py` / `insights.py` compare a partial day against a full day. P1
```sql
uniqExactMergeIf(event_count, date = today()) > uniqExactMergeIf(event_count, date = today()-1) * 1.5
```
`today()` is incomplete. This "trending" rule under-fires in the morning and over-fires at night, deterministically. It is a clock, not a signal.

### D4. No upper bound on any time filter. P0
Every query is `timestamp >= X` with no `AND timestamp < Y`. `timestamp` is client-supplied (`Date.now()/1000` from the browser in `analytics-dashboard/src/lib/tracker.ts`, and the Express server clock elsewhere) with **no validation in `FeatureEvent`**. A skewed clock, or one producer sending milliseconds instead of seconds, puts events in the year 55000 — where they will be counted in every "last N days" window forever, and pollute `/metrics/realtime_users` permanently.

Fix: add a validator on `FeatureEvent.timestamp` rejecting anything outside `[now - 90d, now + 5m]`, dead-letter the rejects, and add an explicit upper bound to every window.

### D5. Backdated events silently rewrite history. P1
`trackEvent(..., timestampOverride)` (used by the admin simulate screens) inserts events into past date partitions. The MV updates `daily_feature_usage` for those past days. Anything the intelligence layer computed yesterday becomes non-reproducible today, with no record that the input changed.

Fix: since `ingested_at` already exists, use it as a watermark. Detect on `timestamp` but record `max(ingested_at)` in `investigations`, so a re-run can reproduce exactly what was visible at the time.

### D6. `parse_range` accepts anything. P3
`range=-5` → `today() - (-5)` → a future date → empty result set, no error. `range=99999d` → full-table scan. Clamp to `[1, 365]`.

---

## Section E — Idempotency and delivery (P1–P2)

Credit where due: the worker is the best-engineered file in the repo. The retry/backoff, `batch_stuck` freeze, poison-row isolation and sink-liveness probe are all correct. The remaining issues are narrower.

### E1. Consumer is evicted from the group during a sink outage longer than 5 minutes. P2
When `batch_stuck` is true, `_should_poll()` returns False and `consumer.poll()` is never called. librdkafka enforces `max.poll.interval.ms` (default 300000). Past that the consumer is considered failed and the group rebalances. Because `on_revoke` is dispatched from `poll()`, and `poll()` is not being called, the handler cannot run cleanly either.

Fix: keep calling `poll()` while paused, but use `consumer.pause(assignment)` / `consumer.resume()` so no new messages arrive. That is what pause/resume is for. Also set `max.poll.interval.ms` and `session.timeout.ms` explicitly rather than inheriting defaults.

### E2. An undecodable message's offset may never commit. P2
On `JSONDecodeError` the message is dead-lettered but not appended to `batch`. The flush condition requires `len(batch) > 0`. If that message is the last one on an otherwise idle partition, no flush occurs, no commit occurs, and on restart it is redelivered and dead-lettered again — forever, growing `events_dead_letter` on every restart.

Fix: track a `dirty` flag that is set by a dead-letter as well as by a successful insert, and let it trigger the commit path.

### E3. Kafka messages have no partition key. P2
`producer.send_and_wait(topic, event_dict)` sends `key=None`. Harmless today because the topic has `--partitions 1`, but the moment you raise the partition count, events for the same tenant/session scatter across partitions and all ordering assumptions break. Key on `tenant_id` (or `session_id` if you want per-session ordering) now, before it matters.

### E4. Topic has one partition, so the worker cannot scale. P2
`init-kafka` creates `--partitions 1`. A second `processor-worker` replica sits idle. Use 3–6 partitions.

### E5. Kafka-timeout fallback can double-write. P2 (mitigated, not eliminated)
On `asyncio.TimeoutError` the code drops the producer and inserts directly to ClickHouse — but the Kafka send may have landed. The result is one row via the worker and one via the fallback. `ReplacingMergeTree` will collapse them on merge because `(tenant_id, event_name, timestamp, event_id)` matches, and readers use `uniqExact(event_id)`. So this is currently safe. It is worth documenting as intentional, because it is only safe as long as **every** reader uses the dedup key — see E7.

### E6. `insert_deduplication_token` is a no-op. P3 (already documented in the code)
`non_replicated_deduplication_window` is 0 on `events_raw`, so the token is accepted and discarded. The code says so honestly. **Warning before you enable it:** ClickHouse's docs and the Altinity KB both confirm that block-level dedup on the source table *skips the dependent materialized view insert as well* by default, and that `deduplicate_blocks_in_dependent_materialized_views` can cause *false* dedup when the MV's output block happens to be byte-identical across two different inserts. Turning this on could silently drop legitimate `daily_feature_usage` rows. Test it against a real replay before shipping.

### E7. The MV does not see ReplacingMergeTree dedup. P1
Materialized views in ClickHouse are insert triggers over the raw inserted block — they never see the post-merge state of the source table. Your MV happens to be safe because `uniqExactState(event_id)` absorbs replays. But this is load-bearing and undocumented at the MV itself: if anyone ever changes `event_count` to `countState()`, replays start double-counting with no error. Put that constraint in a comment on the MV and in a test.

### E8. The MV's legacy fallback key can silently merge distinct events. P1
```sql
concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata)
```
Two genuinely different events from the same user, same second, same name, same metadata collapse into one. This is exactly the shape `seed_safexbank.py` produces (no `event_id`, second-granularity timestamps). Worse, `events_raw`'s ORDER BY includes `event_id`, so with `event_id = ''` a merge can physically delete one of the two rows.

Fix: make `event_id` mandatory at every writer including the seed scripts, then delete the legacy branch.

### E9. `seed_safexbank.py` is not idempotent and bypasses all validation. P1
It writes directly through `ch_client.insert_events()` — no `event_id`, no `session_id`, no taxonomy normalisation, random timestamps. Running it twice doubles the data. Running it at all injects untaxonomised names into `events_raw`.

Fix: make every seed script post through `POST /events` like `scripts/seed_data.py` already does, with deterministic `event_id`s derived from a seed so a re-run is a no-op.

---

## Section F — Security and multi-tenancy (P0)

### F1. RBAC is entirely client-asserted headers on a directly reachable API. P0
`RBACMiddleware` trusts `X-User-Role`, `X-User-Email`, `X-Admin-Apps`, `X-Active-App`. The browser sets these itself from the NextAuth session (`analytics-dashboard/src/lib/api.ts`), and `API_BASE_URL` defaults to `http://localhost:8001` — the analytics API is published straight to the host in `docker-compose.yml`.

```
curl -H "X-User-Role: app_admin" -H "X-User-Email: x@x.com" \
     -H "X-Admin-Apps: nexabank" "http://localhost:8001/journey/user?tenants=nexabank&user_id=..."
```
That returns another tenant's user-level journey data. NextAuth is decorative. Every isolation claim in the system documentation is unenforced.

Fix: the analytics API must verify the NextAuth JWT itself (shared `NEXTAUTH_SECRET`, verify signature, read role and apps from claims). Do not expose port 8001 to the host; route through the Next.js server so the token is attached server-side.

### F2. SQL injection in `/tracking/toggles` (GET and POST). P0
```python
tenants_sql = ", ".join([f"'{t}'" for t in scope_tenants])   # line 2489 and 2644
... WHERE tenant_id IN ({tenants_sql})
```
`scope_tenants` includes the caller-supplied `tenants` CSV verbatim, with no escaping. Every other endpoint correctly uses `%(tenant_ids)s` parameters; these two do not.

Fix: parameterise. The `sql_quote` helper already exists in `/funnels` — but even that is hand-rolled escaping and should be replaced by real parameters.

### F3. The WebSocket endpoint has no authentication at all. P0
`RBACMiddleware.dispatch` returns early for `path.startswith("/ws/")`. `consume_kafka_events` then broadcasts the **entire raw event payload** — `user_id`, full metadata — to anyone connected to `/ws/dashboard/{tenant_id}`. Any browser can open a socket for any tenant and stream live user behaviour.

Fix: require a token in the subprotocol or a query param, validate it in `websocket_dashboard` before `manager.connect()`, and broadcast aggregates rather than raw payloads.

### F4. `/tracking/toggles` forcibly leaks across tenants. P1
```python
GLOBAL_TOGGLE_TENANTS = ["nexabank", "safexbank"]
scope_tenants = sorted(set(GLOBAL_TOGGLE_TENANTS + tenant_list))
```
A `safexbank`-scoped admin always receives `nexabank`'s toggle state, including `changed_by` (an email address). The middleware's scope check is bypassed inside the handler.

### F5. `require_tenant_access` is a no-op in CLOUD mode. P1
`core/middleware.py` only enforces when `settings.is_on_prem`. Default is CLOUD. So every `require_tenant_access(...)` call in `api/main.py` does nothing in the configuration you actually run.

### F6. `POST /events` is completely unauthenticated. P1
Anyone can inject events for any `tenant_id`. There is no producer key, no HMAC, no allowlist. Combined with D4 (no timestamp bound), a single curl can poison any KPI window.

### F7. `allow_origins=["*"]` with `allow_credentials=True`. P2
Invalid per the CORS spec — browsers reject the combination. Present in both `ingestion/main.py` and `api/main.py`.

### F8. RBAC middleware is outermost, so 403s carry no CORS headers. P2
Starlette's `add_middleware` inserts at position 0, so the last-added middleware is outermost. `RBACMiddleware` is added after `CORSMiddleware`, so its early `JSONResponse` never passes through CORS. The browser reports a CORS failure instead of a 403, which is why the `OPTIONS` special-case exists — it patches the symptom. Add `CORSMiddleware` last.

### F9. Secrets in the repo. P2
`NEXTAUTH_SECRET=nucleus-analytics-secret-key-2026` and `CLICKHOUSE_PASSWORD=clickhouse` are hardcoded in `docker-compose.yml`; `rbac.json` contains real email addresses. Cookies are `secure: false`.

### F10. PII masking is easily bypassed. P3
`core/security.py` masks emails and IPv4 only, and only at the top two levels of nesting for lists. Phone numbers, account numbers, names, PAN/Aadhaar-shaped strings all pass through. `sanitize_metadata` will also raise if `metadata` is not a dict.

---

## Section G — Schema, migrations, deployment (P1)

### G1. There is no migration runner. P0 for reproducibility
`storage/migrations/*.sql` exists — eight files — and **nothing applies them**. `grep -rn "migrations"` across all Python, YAML, shell and PowerShell returns zero hits. `schema.sql` is mounted at `/docker-entrypoint-initdb.d/init.sql`, which ClickHouse runs *only on first initialisation of an empty data directory*.

Consequence, already documented in your own schema comments: a fresh `docker compose up` produced the old 8-column table while the running code required 14 columns, every insert failed with "Unrecognized column", and the dead-letter fallback failed too because `events_dead_letter.stage` had the same gap. Events were lost with no trace. That failure mode is still structurally present — it was patched by editing `schema.sql`, not by fixing the mechanism.

Fix: a tiny idempotent migration runner (a `schema_migrations` table + a startup job that applies unapplied files in order) is maybe 40 lines and removes an entire class of "works on my machine". Make `schema.sql` the *initial* migration, not a living document.

### G2. `schema_version` is validated then thrown away. P2
`FeatureEvent.schema_version` exists, defaults to 1, and is never written to any ClickHouse column. It cannot do the job it was added for.

### G3. `ingestion/main.py` builds its own ClickHouse client with different defaults. P2
```python
host=os.environ.get("CLICKHOUSE_HOST", "localhost")       # core/config default: "clickhouse"
password=os.environ.get("CLICKHOUSE_PASSWORD","clickhouse") # core/config default: ""
```
Two components, two default hosts, two default passwords, and `CLICKHOUSE_PORT`/`CLICKHOUSE_DATABASE` ignored entirely on this path. `.env.example` ships `CLICKHOUSE_PASSWORD=` (empty), which contradicts `docker-compose.yml`. Import `settings` and delete the duplicate.

### G4. `NEXT_PUBLIC_ANALYTICS_WS_URL=ws://analytics-api:8001` cannot work. P1
`NEXT_PUBLIC_*` is inlined into the browser bundle. A browser cannot resolve the Docker service name `analytics-api`. The WebSocket connection fails on every page load. Should be `ws://localhost:8001` (or the public host).

### G5. `--reload` in the compose command for both FastAPI services. P2
Uvicorn's reloader in a "Production-Ready" stack. Any file touch drops every WebSocket and kills the Kafka producer, which then takes up to 15 s to re-establish (`PRODUCER_RETRY_COOLDOWN_S`).

### G6. ClickHouse has no healthcheck. P2
`ingestion-api` and `analytics-api` use `condition: service_started`, so they can start before ClickHouse accepts queries. Kafka got a healthcheck after you hit exactly this race; ClickHouse did not.

### G7. No timezone pinned on the ClickHouse container. P0 (root cause of D1)
Add `environment: TZ=UTC` and `<timezone>UTC</timezone>` in the server config.

### G8. No CI. P2
No `.github/` directory. The test suite in `tests/` cannot even be collected without the full dependency set, and there is no `requirements-dev.txt`. Eleven test files exist that nothing runs.

### G9. Repo hygiene. P3
`__pycache__/*.pyc` committed. `check_brackets.py`, `check_syntax.py`, `compile_check.py`, `refactor_main.py`, `broker-inspect.json`, `rebuild.ps1` are scratch files at the repo root.

---

## Section H — Query correctness (P1)

### H1. `/insights` is registered twice. P1
Defined at line 625 and again at line 3563 in `api/main.py`. FastAPI keeps the first registration; the ~100 lines of the second implementation are unreachable. The second `def get_insights` also shadows the first in the module namespace, so any direct import gets the dead one. Delete one, deliberately.

### H2. Empty or malformed `tenants` produces a 500. P2
```python
tenant_list = [t.strip() for t in tenants.split(",") if t.strip()]
params = {...tenant_list[0]...} if len(tenant_list)==1 else {"tenant_ids": tuple(tenant_list)}
```
`?tenants=,` yields `tuple([])` → `IN ()` → ClickHouse syntax error → 500 with the raw SQL error leaked in `detail`. Repeated in ~20 endpoints. Validate once in a shared dependency and return 400.

### H3. Error rate is a substring match on the event name. P1
```sql
countIf(lower(event_name) LIKE '%error%' OR lower(event_name) LIKE '%fail%')
```
This matches the *feature* segment too, not just the status. A feature named `failover_test` or `error_log` counts as an error. Given B2 (`failed` vs `failure`), the `%fail%` wildcard is currently masking the vocabulary split — fix B2 and this will start reporting differently. Use `splitByChar('.', event_name)[3] IN ('failed','failure')` on a properly canonicalised column.

### H4. `pct_change` returns `(0.0, "up")` when the previous value is zero. P1
A metric going 0 → 500 reports "0% change, up". That is precisely the "new signal" case Detect most needs. Return `None` and let the caller render "new" rather than fabricating a zero.

### H5. `/predictive/adoption` is statistically unsound end to end. P0 for the Forecast stage
- `trend_score = clamp(growth_rate + 50, 0, 100)` saturates at ±50% growth. A feature growing 60% and one growing 6000% score identically.
- `anomaly = abs(growth_rate) > 50` fires at exactly the saturation point, so every flagged anomaly has a saturated score.
- No multiple-testing correction. Your own screenshot shows 83 features modelled and 45 anomalies. That is not detection, that is noise.
- `projected_next_7d = recent * (1 + growth/100)` is naive linear extrapolation with no interval, no seasonality, no baseline. The UI renders it as "PROJECTED 7D VOLUME 1,138" — a bare point estimate. Your own `forecasts` table schema mandates `lower`/`upper`/`backtest_mase`; this endpoint violates it.
- `recent_7d` window is `date >= today()-7` (8 buckets) vs `prev_7d` `today()-14 .. today()-8` (7 buckets) — D2 again.
- `feature_users_map[canonical] += uniqExact(user_id)` sums distinct-user counts across aliases (over-counts); `frequency_map[canonical] += active_days` can exceed the 14-day window and saturates `freq_score` to 100 for any aliased feature.

Replace this wholesale with the seasonal-naive baseline your contract already specifies, and write to the `forecasts` table with real intervals.

### H6. `/funnels` will report phantom conversions. P1
`windowFunnel` is called with no mode. `timestamp` is `DateTime` (second granularity), and windowFunnel sorts internally by `(timestamp, event_type)`. When two funnel steps land in the same second, the tie-break is the *step index*, so `applied` and `kyc_completed` in the same second count as a completed sequence regardless of the true order.

Fix: pass `'strict_increase'` (and consider `'strict_order'`), and move to `DateTime64(3)` so sub-second ordering is real.

### H7. `/funnels` scans all distinct event names on every request. P2
`SELECT DISTINCT event_name FROM events_raw WHERE ...` runs before the funnel itself, on every call, purely to build the alias list. Once B6 is fixed (canonical column) this query disappears.

### H8. Percentage change on error rate loses precision. P3
`err_change = pct_change(int(error_rate*10), int(error_rate_prev*10))` — 3.94% and 3.99% both become 39.

### H9. `/license/usage` entitlement is a hardcoded Python dict, not the `tenant_licenses` table. P0
The catalog of which features are `enterprise` vs `free` lives inline in the endpoint, is identical for every tenant, and uses a name vocabulary that does not match what producers emit (see B2, A7). Meanwhile `tenant_licenses` is populated by `seed_licenses.py` and `POST /license/sync` and is not consulted for the usage view.

For your Phase 1 entitlement scenario you need exactly one authoritative answer to "is tenant T licensed for feature F at time X". Right now there are two sources, in two vocabularies, and the one the UI reads is not per-tenant.

Fix: `tenant_licenses` is the single source of truth, keyed on the canonical event name, read with `FINAL` (or `argMax(is_licensed, updated_at)`), and the endpoint joins against it.

### H10. `seed_licenses.py` seeds `bank_a`, which the API rewrites away. P2
`rewrite_tenant_query_aliases` maps `bank_a` → `nexabank` on every request, so the `bank_a` rows can never be read. `safexbank` is never seeded at all, so its licence page is empty.

---

## Section I — Runtime, performance, resource leaks (P2)

### I1. Every query creates a brand-new ClickHouse client that is never closed. P1
`ClickHouseClient._get_client()` calls `clickhouse_connect.get_client(...)` per query and never calls `.close()`. Each one opens a new HTTP session and connection pool. `/metrics/kpi` alone fires six queries → six clients per request. Over hours of dashboard polling this leaks file descriptors and accumulates ClickHouse sessions.

Fix: one module-level client (clickhouse_connect clients are thread-safe and pool internally), or a small pool with explicit close.

### I2. The WebSocket poller hammers ClickHouse forever. P1
`poll_dashboard_metrics` runs every 10 s per connected tenant, calling `get_kpi_metrics` (6 queries) and `get_realtime_users` (1 query). Combined with I1 that is 42 new ClickHouse clients per minute per tenant, whether or not the data changed. Add caching, or push only on Kafka-triggered deltas.

### I3. `broadcast_to_tenant` iterates a set that another coroutine can mutate. P2
It holds a live reference to `self.active_connections[tenant_id]` and `await`s inside the loop. A concurrent `connect()` during that await raises `RuntimeError: Set changed size during iteration`. Iterate over a snapshot (`list(connections)`).

### I4. WebSocket connections leak on non-disconnect exceptions. P2
`websocket_dashboard` only catches `WebSocketDisconnect`. Any other exception leaves the socket in `active_connections` forever, so the poller keeps querying for a dead tenant. Use `finally: manager.disconnect(...)`.

### I5. The WebSocket Kafka consumer breaks with more than one API replica. P2
`group_id="websocket-broadcaster-group"` with a single shared group. Two `analytics-api` replicas split the partitions, so a browser connected to replica A never sees events landing on replica B's partitions. Real-time updates become randomly incomplete. Use a unique group id per process (this is a fanout consumer, not a work queue).

### I6. Live events on the ClickHouse fallback path never reach the WebSocket. P2
`consume_kafka_events` reads from Kafka. When Kafka is down, `_insert_direct_to_clickhouse` writes straight to ClickHouse. Those events land in the database but never appear on the live dashboard — so "live" and "stored" silently disagree exactly when something is already wrong.

### I7. `PRECOMPUTED_LAYER` never expires. P2
`data_layer.py` refreshes every 30 minutes. If `fetch_tenant_summaries` starts failing, the exception is caught and printed, the old entry stays, and `generate_insights` keeps serving indefinitely stale data with a `last_updated` field nobody checks. Add a staleness check and surface it.

### I8. `_toggle_cache` is mutated from threadpool threads without a lock. P3
`is_tracking_disabled` runs under `asyncio.to_thread`, and `_refresh_toggle_cache` rebinds two module globals with no lock. Benign in CPython today; not by design.

### I9. `_get_model_name()` caches the vLLM model name forever. P3
If vLLM restarts serving a different model, every subsequent request uses a stale name. Re-resolve on 404.

---

## Section J — Producers (P1)

### J1. The dashboard's own tracker sends no `event_id`, so 100% of its events are rejected. P1
`analytics-dashboard/src/lib/tracker.ts` builds its payload with `event_name / tenant_id / user_id / timestamp / channel / metadata` — no `event_id`. `FeatureEvent.event_id` is `Field(...)` with a validator that rejects blank values. Every one of these posts returns 422, gets dead-lettered as `ingest_validation`, and is swallowed by `catch { console.warn }`. `useAutoTrack` calls this on every page navigation. Check `events_dead_letter WHERE stage='ingest_validation'` — I expect a large pile.

### J2. `forwardToIngestionAPI` swallows every failure. P0 for the Trust Gate
```ts
} catch (_err: unknown) {
  // Silent fail — analytics should never break the primary app
}
```
No retry, no queue, no counter, 3 s timeout. A 403 (tracking disabled), a 422, a timeout, a restart — all identical from the outside. The event exists in NexaBank's Postgres and not in ClickHouse.

This is the exact failure your `pro_revenue` contract's `tracking_disabled` fingerprint is supposed to catch ("ingestion 403 rate > 0"), and it cannot, because the 403 is discarded at the producer. **Your Trust Gate cannot distinguish "the KPI genuinely dropped" from "the forwarder is failing".** That is the whole point of a Trust Gate.

Fix: count outcomes by status code and expose them (`/health/forwarder`), buffer failures to a local disk queue with retry, and emit a heartbeat event per tenant per minute so absence of data is itself detectable.

### J3. Browser-supplied timestamps are never validated. P0
`tracker.ts` sends `Date.now() / 1000` from the client. See D4.

### J4. Weak session ID generation. P3
`'sess_' + Math.random().toString(36).substring(2, 15)` — roughly 60 bits from a non-crypto PRNG, and `Math.random()` degrades. Use `crypto.randomUUID()`.

### J5. `res.end` monkey-patching in `apiTrackingMiddleware`. P3
`@ts-ignore` on a rebound `res.end(...args)` that returns the original's value. Fragile with streaming responses. Use the `finish` event.

### J6. React StrictMode double-emission is only partially suppressed. P2
The comment in `useEventTracker.ts` is honest about this: the 700 ms suppression map now excludes `responseTime` from the key, which fixes the common case. But it is a module-level `Map`, so it does not survive a full page reload, and any other volatile metadata field (an error string, a timestamp, an amount) will still defeat the key. Since the two emissions get distinct `event_id`s, `uniqExact` cannot collapse them — they are a genuine 2× on live counts.

Fix properly: derive `event_id` deterministically from `(session_id, event_name, coarse_timestamp, stable_metadata_hash)` so duplicates share an ID and dedup absorbs them, instead of suppressing at the edge.

---

## Section K — The LLM path (P1)

Relevant because it is what the intelligence layer replaces.

### K1. `generate_insights` lets the LLM write numbers. P0 against your own architecture rule
The prompt hands raw counts to the model and asks for prose. The example output in the prompt literally contains `"Login grew by 200%"`. Whatever comes back is `json.loads`'d and returned to the client with no schema validation, no numeric verification, and no check that any figure in the narrative appears in the input.

This is the exact thing your Phase 1 design forbids. Do not port any of it. The Narrator must receive pre-computed, verified figures and a numeric verifier must reject any digit in the output that is not in the evidence set.

### K2. The JSON parse path is fragile. P2
It strips ` ```json ` prefix and ` ``` ` suffix by fixed offsets, then `json.loads`. Any preamble text, any trailing newline after the fence, and it silently falls back to rule-based output. `json_format: bool = True` is accepted as a parameter and never used — vLLM supports `response_format: {"type":"json_object"}` and guided decoding; use it.

### K3. `temperature=0.2`, no `seed`. P2
The same investigation produces different narratives on re-run, and `model_runs.inputs_hash` cannot be used to prove reproducibility. Set `temperature=0` and a fixed `seed`.

### K4. `AI_REPORT_CACHE` is an unbounded module-level dict. P3
Never evicted; keyed on `f"{tenant_id}:{range}"` with a 1 h TTL that is checked on read but never swept.

---

## Fix order

You cannot fix all of this before Round 2, and you should not try. This is the order that maximises what the intelligence layer can honestly claim.

**Tier 1 — do these or the intelligence layer is built on sand (roughly 2–3 days)**

1. **G7 + D1** — pin ClickHouse to UTC, replace all `today()` with `toDate(now('UTC'))`, delete the `+330 MINUTE` offsets. One definition of a day.
2. **D2** — make current/previous windows equal length everywhere. Mechanical find-and-replace; removes a systematic bias from every change metric.
3. **B6** — canonicalise once at ingest, store `event_name_canonical`, add it to the MV, delete read-time canonicalisation. This collapses B1–B5, A7, H3, H7, H9.
4. **A1/A2/A3/A4** — mark simulated fields in the event envelope; make the contract loader refuse simulated dimensions in `dimensions.allowed`. Being able to say "we detect our own simulated data and refuse to localize on it" is a stronger demo than a plausible-looking false root cause.
5. **C1** — funnel and retention group on `session_id`, matching your contract's declared grain.
6. **J2** — forwarder outcome counters + `/health/forwarder`. Without this the Trust Gate has nothing real to gate on.
7. **D4** — timestamp bounds validator + upper bound on every window.

**Tier 2 — before anyone else touches the repo (1–2 days)**

8. **F1, F2, F3** — JWT verification, parameterised SQL, WebSocket auth. F2 is a ten-minute fix.
9. **G1** — a real migration runner. Removes a whole class of silent data loss.
10. **I1** — one ClickHouse client instead of one per query.
11. **J1** — add `event_id` to `tracker.ts`.
12. **H1, H2** — delete the duplicate `/insights`; validate `tenants` in a shared dependency.

**Tier 3 — as the intelligence layer lands**

13. **H5** — replace `/predictive/adoption` with the seasonal-naive baseline writing to `forecasts` with real intervals.
14. **H9** — `tenant_licenses` becomes the single entitlement source.
15. **E1, E2, E3, E4** — worker pause/resume, dirty-flag commit, partition key, more partitions.
16. **K1** — the Narrator with a numeric verifier replaces `generate_insights` entirely.

**Tier 4 — cleanup**

17. Everything else, plus CI that runs the eleven tests already written.

---

## One closing observation

The engineering discipline in `processing/worker.py`, the migration files, and the contract YAMLs is genuinely strong — the comments document real incidents with real measurements, which is rare. The weak layer is not the pipeline. It is the **producer**: `eventTracker.ts` fabricates most dimensions, discards real measurements, swallows every failure, and disagrees with the Python taxonomy.

The pipeline faithfully transports whatever it is given. Right now a meaningful share of what it is given is invented at the source, and nothing downstream can tell. Fixing the producer is worth more than any further hardening of the transport.
