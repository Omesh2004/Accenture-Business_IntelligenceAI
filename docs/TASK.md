# TASK.md

The work, sequenced. Every task carries the files it touches, an acceptance criterion, and a
command that proves it.

`docs/PROPOSAL.md` argues for this shape and records the open decisions.
`docs/INTELLIGENCE_LAYER_PREREQUISITES.md` is the audit each ID traces back to.
`CLAUDE.md` holds the standing rules; it deliberately holds no tasks.

**Rules for this file**

- A task is done when its **verification command passes**, not when the edit is written. Two
  Foundation fixes were recorded `resolved` while completely inert; that is what this column is
  for.
- Verification runs through Docker (`CLAUDE.md`, Key commands). The two host-only exceptions are
  marked.
- Status is one of `todo` / `in progress` / `partial` / `blocked` / `done`. Nothing starts as
  `done`, and nothing becomes `done` without the user confirming the verification output
  (`CLAUDE.md` rule 14).
- A task blocked on a decision names it (`D1`–`D6`, `docs/PROPOSAL.md` §3).

---

## Part 1 — Substrate remediation

These change code the intelligence layer does not own. Gates are ordered; tasks within a gate are
listed in dependency order.

### Gate P0 — the numbers mean something

Blocks every stage. Nothing in Part 2 starts until P0 passes.

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **P0-1** | Pin ClickHouse to UTC | `docker-compose.yml` | `docker compose exec clickhouse clickhouse-client --password clickhouse --query "SELECT timezone()"` returns `UTC` | done |
| **P0-2** | Replace all 64 `today()` with `toDate(now('UTC'))`; delete the three `+ INTERVAL 330 MINUTE` offsets | `api/main.py` | `grep -c "today()" api/main.py` returns 0; `grep -c "330 MINUTE" api/main.py` returns 0; the KPI card, traffic chart and rollup agree on the same day boundary for one window | done |
| **P0-3** | Equal-length current/previous windows, and an upper bound on every window | `api/main.py`, `api/data_layer.py` | `pct_change` for a frozen dataset is identical at 09:00 and 23:00 | done |
| **P0-4** | Timestamp bounds validator, rejects dead-lettered | `core/models.py` | An event dated year 55000 returns 422 and appears in `events_dead_letter` with `stage='ingest_validation'` | done |
| **P0-5** | **D2 resolved the other way.** Changing `canonicalize_event_name` moves all 94 canonical names and every dashboard chart at once. The Metric Layer instead resolves a contract's event to its exact stored names, so the layer is precise without a global rename. The frontend/backend namespace split was closed separately (P0-7) | `api/intelligence/metrics.py` | The layer counts the right rows; the dashboard vocabulary is unchanged | resolved by D2 |
| **P0-6** | Canonicalise at ingest: add `event_name_raw` + `event_name_canonical`; add the canonical column to the MV `GROUP BY`; switch `unique_users` to `uniqExact`; delete read-time canonicalisation | `ingestion/main.py`, `storage/schema.sql`, a new migration, `api/main.py` | `/features/usage`, `/license/usage` and `/predictive/adoption` return the **same** unique-user count for the same feature | done |
| **P0-7** | Converge the frontend `pro-feature.*` names on the backend spelling | `NexaBank/frontend` (`track`/`measureAndTrack` call sites) | No `pro_feature.*` names appear in `events_raw` for new traffic | done |
| **P0-8** | Emit `metadata._simulated` listing exactly the fabricated keys; omit keys sourced from a real signal | `NexaBank/backend/src/middleware/eventTracker.ts` | Every live event carries `_simulated`; an event from `POST /events/location` omits `location` from it | done |
| **P0-9** | Plumb the real latency measurement through (`responseTime` → `response_time_ms`); write `null` when unmeasured; make `/metrics/kpi` read the marker instead of inferring from key absence | `NexaBank/frontend/hooks/useEventTracker.ts`, `NexaBank/backend/src/middleware/eventTracker.ts`, `api/main.py` | The Avg Response Time card reports `simulated: true`, and a measured event reports its real latency | done |
| **P0-10** | Forwarder outcome counters + `GET /health/forwarder` + per-tenant heartbeat | `NexaBank/backend/src/middleware/eventTracker.ts`, a route | A deliberately disabled tracking toggle shows a non-zero 403 count within a minute | done |
| **P0-11** | Funnels and retention group on `session_id`; mint a stable anonymous id instead of the literal `"anonymous"` | `api/main.py`, `NexaBank/backend/src/middleware/eventTracker.ts` | `/funnels` no longer reports ~100% at a pre-login first step; the SQL grain matches `contracts/kyc_completion_rate.yaml`'s `grain.entity` | done |

**Gate P0 passes when:** `python scripts/verify_data_quality.py` exits 0 *(host-only)*, and P0-2,
P0-3 and P0-6's acceptance queries all hold.

### Gate P1 — somewhere to write, something to gate on

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **P1-1** | D3 resolved: own container, same image, different command | `docker-compose.yml` | `docker compose up -d intelligence` runs the sweep and forecast loops | done |
| **P1-2** | Idempotent migration runner (`schema_migrations` + startup job); demote `schema.sql` to the initial migration | new `storage/migrate.py`, `docker-compose.yml` | A fresh volume and a live volume converge on the same table set, verified by diffing `SHOW TABLES` | done |
| **P1-3** | Apply the Signal Store DDL to the running instance | `storage/migrations/2026-08-25_signal_store.sql` | All ten tables exist: `docker compose exec clickhouse clickhouse-client --password clickhouse --query "SHOW TABLES FROM feature_intelligence"` | done |
| **P1-4** | Add the ingest-watermark column to `investigations` | `storage/schema.sql`, a new migration | The column exists **before** the first stage writes a row | done |
| **P1-5** | D1 resolved: `raw_rows` in the MV. An MV fires on the inserted block, so it survives the merges that erase duplicates from `events_raw`. Fixture now emits byte-identical duplicates | `storage/schema.sql`, migration, `scripts/seed_data.py` | Verified live: `events_raw` shows raw=ids (merged away) while the rollup shows raw_rows 2383 vs distinct 2285 | done |
| **P1-6** | Make `event_id` mandatory at every writer; delete the legacy `concat('legacy:', ...)` dedup key | `api/seed_safexbank.py`, `api/seed_licenses.py`, `storage/schema.sql`, `api/main.py`, `api/data_layer.py` | No row in `events_raw` has an empty `event_id`; every seed script posts through `POST /events` | todo |
| **P1-7** | Parameterise the two `/tracking/toggles` queries; remove the forced `GLOBAL_TOGGLE_TENANTS` union | `api/main.py` | A `safexbank`-scoped admin cannot see `nexabank` toggles or `changed_by` | done |
| **P1-8** | **Decide D4**, then spread the scenario fixtures across daily buckets above `min_denominator` | `scripts/seed_data.py` | A seeded run produces ≥14 daily buckets for `kyc_completion_rate` with a daily denominator ≥30 | done |
| **P1-9** | Generate and commit `fixtures/planted_truth.json` | `fixtures/` | The file exists and names the planted segment for `real_kyc_drop_mobile_india` | done |

### Gate P2 — entitlement is real

Independent of P0/P1; can run in parallel. Gates scenario 5 and the Definition of Done.

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **P2-1** | Verify the NextAuth JWT server-side; stop publishing :8001 to the host; route the dashboard through its own Next.js server | `api/main.py`, `docker-compose.yml`, `analytics-dashboard/src/lib/api.ts` | A `curl` with forged `X-User-Role` headers returns 401, not data | todo |
| **P2-2** | Move `CORSMiddleware` last so a 403 carries CORS headers | `api/main.py` | A 403 renders as 403 in the browser, not as a CORS failure | done |
| **P2-3** | Add `cfo`/`ops_manager`/`analyst` to `rbac.json`; resolve persona server-side | `rbac.json`, `api/main.py` | A persona query parameter cannot widen access beyond the resolved identity | done |
| **P2-4** | Authenticate the WebSocket; broadcast aggregates rather than raw event payloads | `api/main.py`, `api/websocket_manager.py` | An unauthenticated socket to `/ws/dashboard/nexabank` is refused | todo |
| **P2-5** | `tenant_licenses` becomes the single entitlement source, keyed on the canonical name | `api/main.py` | `/license/usage` and `/segmentation/compare` agree, per tenant | todo |
| **P2-6** | Guard `POST /api/events/simulate` with `isLoggedIn` + `isAdmin` | `NexaBank/backend/src/routes/eventRoutes.ts` | An unauthenticated POST returns 401/403 | done |

### Gate P3 — it will survive a demo

Changes no number; decides whether a two-hour demo stays up.

| ID | Task | Files | Status |
|---|---|---|---|
| **P3-1** | ClickHouse healthcheck; dependents wait on `service_healthy` | `docker-compose.yml` | done |
| **P3-2** | Drop `--reload` from both FastAPI services (it drops WebSockets and kills the producer, and the services bind-mount nothing anyway) | `docker-compose.yml` | done |
| **P3-3** | `requirements-dev.txt` with `pytest`; make the files in `tests/` runnable; add CI | `requirements-dev.txt`, `Dockerfile`, `.github/` | partial — harness done (`tests` and `e2e` compose services, 28 test files); `.github/` does not exist |
| **P3-4** | Worker: `pause()`/`resume()` instead of skipping `poll()`; set `max.poll.interval.ms` and `session.timeout.ms` explicitly | `processing/worker.py` | done |
| **P3-5** | Worker: `dirty` flag so a dead-letter also triggers the commit path | `processing/worker.py` | done |
| **P3-6** | Key Kafka messages on `tenant_id`; raise the topic partition count | `ingestion/main.py`, `docker-compose.yml` | done |
| **P3-7** | Close ClickHouse clients; cache or event-drive the 10s WebSocket poller; snapshot the connection set before iterating; `finally: disconnect` | `storage/client.py`, `api/websocket_manager.py`, `api/main.py` | done |
| **P3-8** | Clamp `parse_range` to `[1, 365]`; validate `tenants` in a shared dependency and return 400 | `api/main.py` | done |
| **P3-9** | Session-profile eviction by last-seen TTL, not insertion order | `NexaBank/backend/src/middleware/eventTracker.ts` | done — `SessionProfile.lastSeen` drives eviction; insertion order is gone |
| **P3-10** | Derive `event_id` deterministically from `(session_id, event_name, coarse_timestamp, stable_metadata_hash)` so StrictMode duplicates share an id — **decide with D1/D5** | `NexaBank/frontend/hooks/useEventTracker.ts` | blocked (D5) |
| **P3-11** | Replace `hash()` with `hashlib.blake2b` for on-prem anonymisation; salt `hashUserId` | `ingestion/main.py`, `NexaBank/backend/src/middleware/eventTracker.ts` | todo |
| **P3-12** | Import `settings` in `ingestion/main.py` instead of a second ClickHouse client with different defaults | `ingestion/main.py` | todo — `settings` is imported and used for Kafka/tenant, but `_clickhouse_client()` still reads raw `os.environ` with its own defaults and no `CLICKHOUSE_DATABASE` |
| **P3-13** | Fix `allow_origins=["*"]` + `allow_credentials=True` in both services | `ingestion/main.py`, `api/main.py` | done |
| **P3-14** | Label every chart built on a fabricated field in the UI | `analytics-dashboard/src/components/` | partial — `KPICard`'s `simulated` badge now lights from `metadata._simulated` (P0-9); no other chart reads the marker |
| **P3-15** | Stop presenting `/tenants/compare`'s `conversion_rate` and `/predictive/adoption`'s projection as measurements | `api/main.py`, dashboard | todo |
| **P3-16** | Either wire or delete `analytics-dashboard/src/lib/tracker.ts` + `useAutoTrack.ts`, and `NexaBank/frontend/lib/tracker.ts` — all three are unreferenced | those files | todo |
| **P3-17** | Persist `schema_version` to a column, or drop the field | `core/models.py`, `storage/schema.sql` | todo |
| **P3-18** | Repo hygiene: untrack `__pycache__`; move or delete the root scratch scripts | repo root, `.gitignore` | partial — the five root scratch files are deleted; `storage/__pycache__/client.cpython-31{3,4}.pyc` are still tracked |

**Deliberately not scheduled:** secret rotation (flagged, Phase 2 per `CLAUDE.md`); the duplicate
`/insights` route, which is resolved while writing the new `/ai_report` reader, not before.

---

## Part 2 — Phase 1 build

The intelligence layer itself. **Does not start until Gate P0 passes**, except where a stub is
named. Scope and Definition of Done are `docs/PHASE_1.md`; interfaces are
`docs/PIPELINE_CONTRACT.md`; determinism rules are `docs/INTELLIGENCE_LAYER_PROPOSAL.md` §1.

| ID | Phase | Task | Done when | Status |
|---|---|---|---|---|
| **B-0** | 0 | Metric Layer + contract loader, with a stub returning known numbers | Stub and live implementations agree on golden inputs; every later stage is built against the stub from day one | done |
| **B-1** | 1 | Tier 0 contract discovery + Tier 1 declared overrides | Every canonical event resolves to a contract; the invariance test and the `_simulated` marker both filter dimensions (needs **P0-6**, **P0-8**) | done |
| **B-2** | 2 | Trust Gate + `trust_findings` | **Scenario 1 runs end to end with no LLM** — a real defect caught and suppressed (needs **P1-5**) | done |
| **B-3** | 3 | Forecast batch + `forecasts` | Every KPI has a band with an interval and a backtest score or an explicit caveat | done |
| **B-4** | 4 | Detect + materiality | Fires on the planted movement, silent on golden-normal windows (needs **P1-8**) | done |
| **B-5** | 5 | Localize + propagation | Planted segment at rank 1; contributions sum to ~1; N related alerts collapse to one story | done |
| **B-6** | 6 | Causal + Decide | Rung labelled; levers only from the contract's closed list | done |
| **B-7** | 7 | Claim set + entitlement + **template narrator** | **Gate D** — all five scenarios pass with zero `engine_type = 'llm'` rows in `model_runs` (needs **P2-3**) | done |
| **B-8** | 8 | LLM narrator + numeric verifier | **Gate L** — claim sets byte-identical to Gate D; turning the LLM on changes no number, only prose | todo |
| **B-9** | 9 | Dashboard endpoints + Observe | Evidence card, trust verdict, persona switch, abstain state and engine breakdown render; outcomes captured | partial — all seven `/intelligence/*` routes and the dashboard pages ship and render; `dashboardAPI.recordIntelligenceOutcome` has no call site, so outcomes are never captured from the UI |
| **B-10** | — | Determinism suite | Running any investigation twice over a frozen window produces byte-identical Signal Store rows; any diff is a build failure | done |

**Note on B-0.** The Metric Layer is the critical path *inside* the build, not a prerequisite to
it. Building every stage against the stub from day one is what keeps a slip there from blocking the
whole programme.

---

## Part 3 — Remaining work, phased

Everything left, in the order it should be done. Derived from the 2026-08-29 docs-vs-code audit,
`docs/HANDOFF.md` §2-§3, and the open rows in Parts 1 and 2. Every row here is `todo`; nothing in
this Part has been started.

**One row per ID.** A phase that carries an already-numbered task **links** to it; it does not
restate its status. Parts 1 and 2 remain the row of record for every `P*`/`B-*` ID, and only `R*`
IDs are declared here. Two rows for one task is how a status drifts, which is the failure this
repository keeps re-learning.

**The ordering principle.** A wrong number that looks right outranks a missing feature, so what
publishes a mis-named figure goes first. Then the refusals — this engine's value is that it
declines to answer when it cannot, and a refusal that is not recorded is indistinguishable from
one that never happened. Then the persona sequence, whose order the user fixed in review. Language,
identity and hygiene last, because none of them change a number.

**R4's internal order is not ours to change.** It was set in review (`docs/HANDOFF.md` §2) and each
step assumes the one before it.

| Phase | Goal | Gate |
|---|---|---|
| **R1** | A published figure is the quantity its name claims | No insight states a figure under a name it did not measure |
| **R2** | A refusal is recorded, never incidental | Every abstain, truncation and discovery failure leaves a row |
| **R3** | N alerts from one cause collapse to one story | Two linked KPIs with a shared cause surface once |
| **R4** | The persona sequence | Order fixed in review; do not resequence |
| **R5** | Language, and the last read path | Gate L; `/ai_report` reads `insights` |
| **R6** | Identity is real | A forged header returns 401, not data |
| **R7** | It survives someone else's machine | A clean clone reproduces every gate |

---

### Phase R1 — a published figure is the quantity its name claims

The system currently publishes a correct number under a wrong name, and every existing guard
passes it: the numeric verifier checks that a figure traces to a stored row, not that the row is
the quantity the sentence names. `api/intelligence/phrasing.py` makes the substitution *visible*;
this phase makes it unnecessary. This is P0 — it is the only remaining defect that produces
confident, wrong analysis rather than absent analysis.

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **R1-1** | **Decide D7**, then score ratio KPIs on a derived numerator/denominator series rather than on the numerator alone. Localize stays on the fundamentals, where additivity actually holds | `api/intelligence/stages/detect.py`, `orchestrator.py`, `contracts.py` | `digital_adoption_rate` scores 1.000 on a window where every transaction is digital, and reports no movement; `kyc_completion_rate` and `loan_approval_rate` score their rate too | blocked (D7) |
| **R1-2** | `Contract.is_ratio`/`numerator()`/`denominator()` recognise fact-table fundamentals (`table`/`measure`/`filter`), not only `event`/`events` | `api/intelligence/contracts.py` | `is_ratio` is `True` for every contract whose `unit` is `ratio`; a contract listing its denominator first is still scored on its numerator | todo |
| **R1-3** | Investigate `new_account_openings`' zero forecast band. Establish whether Forecast had history before trusting anything about that KPI | `api/intelligence/stages/forecast.py`, `scripts/seed_data.py` | The band is non-zero, or the KPI carries `caveat = insufficient_history` and is not narrated as a movement | todo |
| **R1-4** | Carry **P3-15** here. Presenting `/tenants/compare`'s `conversion_rate` and `/predictive/adoption`'s projection as measurements is a published-number defect, not hygiene, so it is scheduled with R1 rather than R7. Row of record: Gate P3 | `api/main.py`, `analytics-dashboard/src/` | Neither is labelled as a measured business metric in the API response or the UI | see **P3-15** |

**Gate R1 passes when:** `docker compose --profile test run --rm tests python scripts/run_intelligence_gates.py`
still exits 0, and a new assertion holds — for every `insights` row, the stored `observed` is in the
unit the headline names. `docs/FinInsights_Bug_Audit.md` §A8 and §A9 close.

**Decision D7 (new, needs a human).** §A8 lists two options and they are not equivalent: compute
the ratio as a derived series and score that (recommended — it is what the contract's `formula`
already declares), or rename each ratio contract to what is actually scored. The second is cheaper
and abandons every rate KPI on the platform. Add the resolution to `docs/PROPOSAL.md` §3.

---

### Phase R2 — a refusal is recorded, never incidental

Five places where the engine does the right thing and leaves no evidence, or does the right thing
for the wrong reason. Each is cheap; together they are the difference between "we abstained" and
"nothing ran". All five are `docs/FinInsights_Bug_Audit.md` Section L.

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **R2-1** | An unentitled persona gets an entitlement-filtered insight row, not no row (**L1**). `_narrate`'s `if restricted: continue` skips the persona entirely, so the Gate D leak assertion passes trivially | `api/intelligence/orchestrator.py`, `stages/narrate.py` | An `ops_manager` row exists for a `pro_revenue` investigation, contains no restricted claim, and names the owner role it cannot act for | todo |
| **R2-2** | Tier 0 discovery failure is recorded rather than swallowed (**L5**). `load_all`'s bare `except Exception: pass` makes an outage indistinguishable from an empty result | `api/intelligence/contracts.py` | A forced discovery failure logs, and coverage dropping to the declared contracts is visible rather than silent | todo |
| **R2-3** | Detect suppresses on a provisional window unless magnitude is extreme (**L6**). Contracts declare `provisional_window_minutes`; only Trust Gate reads it | `api/intelligence/stages/detect.py` | A window younger than the contract's provisional floor does not open an anomaly on a partial arrival | todo |
| **R2-4** | Persist `search_truncated` and `note` on `root_causes` (**L3**). §3c's "never silently truncate" currently holds in memory and is lost on write | `storage/schema.sql`, a new migration, `api/intelligence/stages/localize.py`, `signal_store.py` | A capped or errored cube search is readable from `root_causes` and rendered on the evidence card | todo |
| **R2-5** | Key coextensive-cell dedup on containment, not on an equal rounded delta (**L4**). Two distinct cells whose movements coincide currently collapse and one is dropped | `api/intelligence/stages/localize.py` | Two disjoint cells with equal deltas both survive to the ranking; a cell contained by a higher-ranked one still does not | todo |
| **R2-6** | Extend the determinism diff to all ten Signal Store tables (**L7**), excluding only the columns that cannot be byte-identical (`model_runs.latency_ms`) | `scripts/run_intelligence_gates.py` | `SIGNAL_TABLES` covers `forecasts`, `model_runs` and `outcomes`; `engine_type`, `inputs_hash` and `verifier_pass` are diffed | todo |

**Gate R2 passes when:** each item has a test, and the determinism diff is clean across all ten
tables rather than seven.

---

### Phase R3 — N alerts from one cause collapse to one story

`docs/PIPELINE_CONTRACT.md` §3b describes a propagation pass; steps 1 and 3 exist and step 2 does
not, so a single upstream cause still surfaces as N independent alerts and the reader does the
correlation the engine should have done. Untenable at Tier 0 scale.

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **R3-1** | Add `anomalies.explained_by`. It is documented in `docs/DATABASE.md` and exists in no SQL or Python | `storage/schema.sql`, a new migration | The column exists on the running instance and in `schema.sql`; `storage/migrate.py --status` is clean | todo |
| **R3-2** | The propagation pass sets `status = 'explained'` and `explained_by` when a declared `driven_by` edge, temporal precedence and direction all agree | `api/intelligence/orchestrator.py` | Explained anomalies persist as rows but are suppressed from the feed; the narrative roots at the anomaly nothing else explains | todo |
| **R3-3** | Detect contract-graph cycles at load time and refuse the contract set, rather than looping at runtime | `api/intelligence/contracts.py` | A deliberately cyclic pair of contracts fails `load_all` with a named error | todo |

**Gate R3 passes when:** a seeded run in which `kyc_completion_rate` drives `loan_approval_volume`
produces **one** surfaced insight naming both, not two.

---

### Phase R4 — the persona sequence

Order set by the user in review (`docs/HANDOFF.md` §2) and preserved verbatim. Each step assumes
the one before it. Do not resequence, and do not start R4-3 before R4-2's test exists.

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **R4-1** | `default_window` as a **contextual read**: one extra metric-layer query producing one framing figure, with its own window label in its own prose. The investigation stays canonical at its own window | `api/intelligence/personas.py`, `tools.py`, `phrasing.py` | A CFO answer reads "Quarter to date, fee revenue is down 4.2%"; the investigation window is unchanged; the cache key carries the as-of date | todo |
| **R4-2** | Out-of-scope residual disclosure, **with the back-computability test written alongside it**, not after | `api/intelligence/stages/narrate.py`, `tools.py`, `tests/` | Omitted governed KPIs are disclosed as a residual, and the test asserts non-derivability of `cost_per_acquisition`, `fee_revenue` and `pro_revenue` from the seven an ops manager can see | todo |
| **R4-3** | Abstention **wording** per persona. Abstention itself stays persona-invariant | `api/intelligence/phrasing.py`, `personas.py` | Wording differs by persona; a test asserts every persona abstains on the same inputs. One persona answering where another abstains is a bug in R4-3, not a feature | todo |
| **R4-4** | Restrict proactive alerting to Tier 1. `Contract.governed` exists; the scheduler path does not branch on it | `api/intelligence/service.py`, `orchestrator.py` | A Tier 0 series is answerable through `get_insight` but never proactively surfaced | todo |

**Gate R4 passes when:** `tests/test_persona_registry.py` and the new residual test pass, and no
persona's *entitlement* changed — only depth, framing and wording.

---

### Phase R5 — language, and the last read path

Nothing here changes a number. R5-1 is environment-gated rather than effort-gated.

Carried from Part 2, rows of record there:

- **B-8 — Gate L.** Turn the narrator on against a real model. Environment-gated: needs a GPU host,
  the NVIDIA Container Toolkit and an `HF_TOKEN`, and this machine has none of the three. Its logic
  is already validated against a scriptable OpenAI-compatible server, so what remains untested is
  the English quality of a specific model.
- **B-9 — outcomes capture.** The read surface is complete;
  `dashboardAPI.recordIntelligenceOutcome` has no call site, so the feedback loop's write half is
  dead.

New in this phase:

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **R5-2** | `/ai_report` becomes a thin reader over `insights`, keeping its response shape. The duplicate `/insights` route is resolved as part of this rewrite — never before it | `api/main.py`, `api/data_layer.py`, `api/insights.py` | `/ai_report` returns the stored insight for the tenant and persona, falls back to the rule-based summary when none exists, and `/admin/app/{id}/summary` is unchanged | todo |

**Gate R5 passes when:** Gate L's five checks pass with the LLM on, and every Gate D assertion still
passes with it off.

---

### Phase R6 — identity is real

Entitlement inside the layer has no leaks. The identity it resolves from is asserted by the caller,
so the Definition of Done's *"zero entitlement leaks"* currently holds for the pipeline and not for
the API surface. This phase is what makes that claim true end to end.

No new IDs. Carried from Gates P1 and P2, rows of record there, in this order:

1. **P2-1** — verify the NextAuth JWT server-side and stop publishing :8001 to the host. Everything
   else in this phase is decoration until the identity is real.
2. **P2-4** — authenticate the WebSocket and broadcast aggregates, not raw payloads.
3. **P2-5** — `tenant_licenses` as the single entitlement source, keyed on the canonical name.
4. **P1-6** — `event_id` mandatory at every writer, which is what lets the legacy
   `concat('legacy:', ...)` dedup key be deleted. Independent of the three above; grouped here
   because it is the last correctness hole in the write path.

**Gate R6 passes when:** `require_tenant_access` is no longer the only check standing between a
forged header and a tenant's data, and the legacy dedup key — which merges genuinely distinct
events sharing user, second, name and metadata — is gone.

---

### Phase R7 — it survives someone else's machine

Changes no number. Everything here is a thing that works on this checkout and would not on a clean
one, or a thing that will rot silently.

New here:

| ID | Task | Files | Done when | Status |
|---|---|---|---|---|
| **R7-1** | Restore `docs/audits/`, or move its reasoning into the comments citing it (**L9**). 50 comments across `api/`, `core/`, `ingestion/`, `processing/` and `storage/` cite two files that do not exist, and are the only surviving record of several real incidents | `docs/audits/`, or the citing comments | Every `docs/audits` citation in source resolves to something readable | todo |
| **R7-2** | `mark_source_failed` is passed an exception where it declares `error: str` (**L8**) | `api/intelligence/service.py`, `loaders.py` | The call and the annotation agree | todo |

Carried from Gate P3, rows of record there. **P3-3** (CI) first — it is what stops the rest from
rotting again:

**P3-3** CI · **P3-11** salted/blake2b anonymisation · **P3-12** one source of ClickHouse defaults ·
**P3-14** label every fabricated chart, not only the KPI card · **P3-16** wire or delete the three
unreferenced tracker modules · **P3-17** persist or drop `schema_version` · **P3-18** untrack the
two `.pyc` files · **P3-10** blocked on **D5**, and D1 removed the need for it — it survives only as
StrictMode hygiene.

**Gate R7 passes when:** a clean clone plus `docker compose up` plus the seed reaches Gate D with no
step that only works on this machine.

---

### Deliberately not scheduled

Not deferred by oversight. Each has a reason and a home.

| Item | Why not now |
|---|---|
| PSqueeze for cubes above ~10k cells (`PIPELINE_CONTRACT.md` §3c) | Approved, not needed: no cube is near that size. A swap behind the existing interface once one is |
| The Forecast method registry — `ets`, `sarima`, `chronos_bolt` (§4b) | Same. The promotion rule is already implemented, so a method can be added without a redesign |
| The KPI-registry validation layer (`docs/VALIDATION_LAYER.md`) | Design only. Needs the Tier 0-vs-declared registry question answered first |
| Secret rotation | Flagged, Phase 2 per `CLAUDE.md` |
| Everything on `docs/PHASE_1.md`'s Deferred list | Phase 2 by definition. If Phase 1 seems to need one, stop and ask |

---

## Progress

| | P0 | P1 | P2 | P3 | Build | R1 | R2 | R3 | R4 | R5 | R6 | R7 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| New IDs | 11 | 9 | 6 | 18 | 11 | 3 | 6 | 3 | 4 | 1 | 0 | 2 |
| Done | 11 | 8 | 3 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | — | 0 |
| Partial | 0 | 0 | 0 | 3 | 1 | 0 | 0 | 0 | 0 | 0 | — | 0 |
| Blocked on a decision | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | — | 0 |
| Todo | 0 | 1 | 3 | 5 | 1 | 2 | 6 | 3 | 4 | 1 | — | 2 |
| Carried in from Parts 1-2 | — | — | — | — | — | 1 | 0 | 0 | 0 | 2 | 4 | 8 |

R columns count **new** IDs only. Part 3 phases that carry an existing task link to it rather than
restating it, so P1-6, P2-1/4/5, B-8, B-9 and the open P3 rows are counted once, in their own gate.
R1-4 is the exception: it is a scheduling note on **P3-15**, not a new task, and carries no status
of its own.

Last re-derived from code on 2026-08-29, by the docs-vs-code audit. Statuses in this table are
only as good as the last run of each task's verification command — see `CLAUDE.md` rule 14.

**Gate P0 is complete.** One definition of a day (`TZ=UTC`, zero `today()` calls, no IST offsets),
symmetric bounded windows, a timestamp validator, canonical names written once at ingest, the
`_simulated` marker on the wire, real latency plumbed through, forwarder counters at
`/health/forwarder`, session-grain anonymous ids, and the frontend converged onto the backend's
pro-feature vocabulary.

**All six decisions (D1–D6) are resolved and implemented** — see `docs/PROPOSAL.md` §3.

**Foundational audit, 2026-08-28.** Six defects of one family: state that existed but never
varied, and harness faults that made the gates green for the wrong reason.

- **`Account.status` is gone.** It duplicated `lifecycleStatus`, could disagree with it, and could
  not express DORMANT or FROZEN at all -- so the richer state was decoration while the transfer
  paths gated on the poorer one. `Loan.status` became a `LoanStatus` enum for the same reason.
- **Lifecycle is derived from observed activity**, not rolled at creation
  (`scripts/applyLifecycle.ts`), so account, card and transaction state agrees with the
  transaction history rather than contradicting it. Every state now actually occurs.
- **Localize refuses a degenerate dimension.** One distinct value means one cell carrying 100% of
  the movement -- a tautology that ranks and states a confident share while explaining nothing.
  `sliceable_dimensions` skips it and `validate()` reports it. This is what turns an unpopulated
  schema field into an analytics claim, and it is now impossible.
- **Loan disbursements are excluded from Net Deposit Growth.** A disbursement credits the
  customer's account, so counting it made a lending push read as deposit growth. `exclude:` was
  added to the fact layer for it.
- **The Prisma migration ledger was empty while the schema was live.** `migrate deploy` would have
  replayed five historic migrations against a populated database. Replaced with one baseline
  covering all seventeen tables.
- **The gates were passing for the wrong reasons.** `scripts/seed_data.py` imported an undeclared
  `requests`; its URLs were hardcoded to `localhost`, so in a container it posted 0 of 7556 events
  and reported success; `SCENARIO_TENANTS` overrode `--tenants`, so planted movements and their
  baseline went to different tenants; and `fixtures/` was baked rather than mounted, so the truth
  file was written into a discarded container and every gate scored the previous run. Golden
  fixtures now live in their own tenants and the gates read the tenant list from the fixture.

**The retail banking data model is built.** NexaBank now carries the entities a real retail bank
has -- `Branch`, `Card`, `Campaign`, `CampaignInteraction`, `MacroEnvironment`, `Notification`,
plus CRM demographics on `Customer`, branch/rate/lifecycle on `Account`, and MCC/merchant on
`Transaction`. They reach ClickHouse through three watermarked extract sources at three cadences
(`nexabank_core` hourly, `nexabank_crm` weekly, `market_ops` monthly), which is what makes the
multi-source requirement real rather than nominal. Five new contracts read them:
`net_deposit_growth`, `new_account_openings`, `digital_adoption_rate`, `cost_per_acquisition` and
`new_product_activations`. All five pass `validate()` with no fabricated dimensions -- unlike the
three telemetry contracts, whose dimensions the forwarding layer synthesises. That contrast is
kept deliberately: it is the clearest demonstration that the engine's caution is real.

**The persona query agent is built** (`api/intelligence/agent.py`, `POST /intelligence/ask`). It
routes a natural-language question into a closed set of intents served from the Signal Store — a
router, not a query planner, so rule 4 holds by construction. Personas cannot ask past their
entitlement, a quarantined KPI refuses to name a cause, and every answer passes the same numeric
verifier as the scheduled narrative. Abstention is a first-class outcome.

**Gate D reached.** `docker compose --profile test run --rm tests python scripts/run_intelligence_gates.py`
proves it: the determinism diff is identical across the seven Signal Store tables it covers
(`SIGNAL_TABLES` — `forecasts`, `model_runs` and `outcomes` are not diffed, since they carry
batch and telemetry rows rather than investigation output), all five scenario gates pass, verifier
coverage is 100%, and `model_runs` contains **zero** rows with `engine_type = 'llm'` (breakdown:
rule=32, stats=12).

**What is still open, and why.** Sequenced in Part 3; the summary below says why each remains.

- **P1-6** (`event_id` mandatory at every writer) — `api/seed_safexbank.py` still writes directly
  without one. Needs those seed scripts rewritten onto `POST /events`.
- **P2-1 / P2-4 / P2-5** — JWT verification, WebSocket auth and `tenant_licenses` as the single
  entitlement source. Entitlement is enforced *inside* the layer and has zero leaks, but the
  identity it resolves from is still caller-asserted, so the DoD's zero-leak claim holds for the
  pipeline and not yet for the API surface.
- **P3-3 CI** — the test harness runs (`docker compose --profile test run --rm tests`, and the
  `e2e` service for Playwright), but there is no `.github/` and nothing runs either on a push.
- **P3-11** (unsalted `hashUserId`, Python `hash()` in on-prem anonymisation), **P3-12**,
  **P3-15**, **P3-16**, **P3-17** — the remaining producer and hygiene items.
- **P3-14** and **P3-18** are partial; **P3-10** stays blocked on **D5**.
- **B-9** — the read surface is complete; the write half of the feedback loop is not wired.
- **B-8 Gate L** — the LLM narrator's own logic is now validated end to end against a scriptable
  OpenAI-compatible server (`tests/test_intelligence_llm_narrator.py`, 15 tests): model discovery,
  guided-decoding fallback on 400/422, code-fenced and prose-wrapped JSON, and — the one that
  matters — a hallucinated figure being rejected so the deterministic template wins. What remains
  unvalidated is the *English quality of a specific model*, which needs vLLM, a GPU and an
  `HF_TOKEN`; this machine has none of the three. Turn it on with `INTELLIGENCE_LLM=1` once a GPU
  host is available; no model name is hardcoded anywhere, so any OpenAI-compatible server works.
