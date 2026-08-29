# INTELLIGENCE_LAYER_PREREQUISITES.md

The **evidence** behind the substrate remediation: what was found, where, and how it was proven.

Audit date 2026-08-28, against `main` at `c9c4d7f` plus uncommitted doc changes. Scope: `NexaBank/`,
`ingestion/`, `processing/`, `core/`, `storage/`, `api/`, `analytics-dashboard/`, `contracts/`,
`scripts/`, `docker-compose.yml`, `rbac.json`, `tests/`.

**This file changed no code, and it schedules no work.** It is the evidence of record for one
date and is not re-run; live status per finding is the `Task` column's ID in `docs/TASK.md`.

| File | Role |
|---|---|
| **this file** | Findings + proof |
| `docs/PROPOSAL.md` | What to do about them, and the six open decisions |
| `docs/TASK.md` | The sequenced work, with acceptance criteria |
| `docs/FinInsights_Bug_Audit.md` | The earlier repository-wide sweep (sections A–K) |

Claims tagged **[ran]** were produced by executing the real functions — per `CLAUDE.md`, *"verify
claims about the taxonomy, a canonical event name, or a metric by running the function"*. Commands
are in Appendix C. Everything else is a code read with a file and line reference.

Severity: **B0** build on it and stages emit confident, wrong answers · **B1** blocks a specific
Phase 1 gate or scenario · **B2** will surface during the build or the demo.

The prerequisite/build dividing line, the eight blocks these group into, and the rationale for the
gate ordering now live in `docs/PROPOSAL.md`. This file keeps the proof.

---

## 1. Findings index

43 findings, each traceable to a file and a task. Severity and grouping as above.

**Closed since the audit** (verified against the working tree, 2026-08-29): NB-2, NB-6, ING-1,
ING-2, CH-1, CH-2, CH-4, CH-5, CH-6, API-1, API-2, API-3, API-4, API-5, API-7, API-9, API-12,
API-13, WK-1, WK-2, WK-3, DASH-1, DATA-1, DATA-2, OPS-1, OPS-2, OPS-3, OPS-6, OPS-7, and OPS-5
except CI. **Still open:** NB-1 (mitigated by the marker, not removed), NB-3 (counters added,
failures still swallowed by design — CLAUDE.md rule 7), NB-4, NB-5, NB-7, NB-8, ING-3, ING-4,
ING-5, ING-6, CH-3, API-6, API-8, API-10, API-11, API-14, DASH-2, DASH-3, DATA-3, OPS-4.

**NexaBank (producer)**

| ID | Sev | Finding | Evidence | Task |
|---|---|---|---|---|
| NB-1 | B0 | `location`, `city`, `continent`, `device_type` and `channel` are dice rolls | `NexaBank/backend/src/middleware/eventTracker.ts:106` | P0-8 |
| NB-2 | B0 | the real latency measurement is thrown away, and the honesty flag can never fire | `NexaBank/frontend/hooks/useEventTracker.ts:104-118` | P0-9 |
| NB-3 | B0 | `forwardToIngestionAPI` swallows every failure | `eventTracker.ts:470-473` | P0-10 |
| NB-4 | B1 | all logged-out traffic collapses into one user called `anonymous` | `eventTracker.ts:487` | P0-11 |
| NB-5 | B2 | session-profile eviction re-randomises a live session | `eventTracker.ts:184-188` | P3-9 |
| NB-6 | B1 | `POST /api/events/simulate` is unauthenticated | `NexaBank/backend/src/app.ts:47` | P2-6 |
| NB-7 | B2 | StrictMode/duplicate suppression is edge-side and incomplete | `useEventTracker.ts:36-64` | P3-10 |
| NB-8 | B2 | `hashUserId` is unsalted SHA-256 | `eventTracker.ts:13` | P3-11 |

**Ingestion API**

| ID | Sev | Finding | Evidence | Task |
|---|---|---|---|---|
| ING-1 | B0 | no canonical event name is ever stored | `ingestion/main.py:452` | P0-6 |
| ING-2 | B0 | `FeatureEvent.timestamp` has no bounds validator | `core/models.py:37` | P0-4 |
| ING-3 | B1 | on-prem anonymisation uses Python's `hash()` | `ingestion/main.py:469` | P3-11 |
| ING-4 | B2 | a second ClickHouse client with different defaults | `ingestion/main.py:105-115` | P3-12 |
| ING-5 | B1 | `POST /events` is unauthenticated, and `allow_credentials` is invalid | `ingestion/main.py:319-325` | P3-13 |
| ING-6 | B2 | `schema_version` is validated then discarded | `core/models.py:44` | P3-17 |

**ClickHouse / storage**

| ID | Sev | Finding | Evidence | Task |
|---|---|---|---|---|
| CH-1 | B0 | the rollup is keyed on raw names and uses HyperLogLog | `storage/schema.sql:56-77` | P0-6 |
| CH-2 | B0 | `ReplacingMergeTree` now erases the evidence the hero scenario depends on | `storage/schema.sql:35-50` | P1-5 |
| CH-3 | B1 | `api/seed_safexbank.py` bypasses validation entirely | `api/seed_safexbank.py` | P1-6 |
| CH-4 | B1 | there is no migration runner | `schema.sql` | P1-2 |
| CH-5 | B0 | `investigations` cannot record what it saw | `storage/schema.sql:313-327` | P1-4 |
| CH-6 | B0 | no timezone pinned on the ClickHouse container | `docker-compose.yml:53-66` | P0-1 |

**Analytics API**

| ID | Sev | Finding | Evidence | Task |
|---|---|---|---|---|
| API-1 | B0 | canonicalisation at read time, in Python, over raw names | `api/page_map.py:573` | P0-5, P0-6 |
| API-2 | B0 | four definitions of "a day" coexist | `storage/schema.sql:69` | P0-2 |
| API-3 | B0 | current and previous comparison windows are different lengths | `api/main.py:684` | P0-3 |
| API-4 | B1 | `pct_change` fabricates a zero for the case Detect most needs | `api/main.py:713-717` | P0-3 |
| API-5 | B1 | error rate is a substring match on the whole event name | `api/main.py:769` | P0-6 |
| API-6 | B1 | entitlement has two sources of truth, and the one the UI reads is not per-tenant | `api/main.py:2216-2267` | P2-5 |
| API-7 | B1 | SQL injection in `/tracking/toggles`, and a forced cross-tenant leak | `api/main.py:2489` | P1-7 |
| API-8 | B1 | RBAC is client-asserted headers on a directly reachable API | `api/main.py:207-327` | P2-1 |
| API-9 | B1 | personas do not exist anywhere | `rbac.json` | P2-3 |
| API-10 | B1 | the WebSocket has no authentication and broadcasts raw payloads | `api/main.py:246` | P2-4 |
| API-11 | B2 | the duplicate `/insights` route | `api/main.py:625` | — |
| API-12 | B2 | client and connection hygiene | `storage/client.py:20` | P3-7 |
| API-13 | B2 | `parse_range` accepts anything | `api/main.py:20-27` | P3-8 |
| API-14 | B1 | `/predictive/adoption` and `/tenants/compare` publish invented metrics | `api/main.py:2956-3080` | P3-15 |

**Processing worker**

| ID | Sev | Finding | Evidence | Task |
|---|---|---|---|---|
| WK-1 | B2 | the consumer is evicted from the group during a sink outage over 5 minutes | `processing/worker.py:168-181` | P3-4 |
| WK-2 | B2 | an undecodable message's offset may never commit | `processing/worker.py:377-385` | P3-5 |
| WK-3 | B2 | Kafka messages have no partition key, and the topic has one partition | `ingestion/main.py:486` | P3-6 |

**Analytics dashboard**

| ID | Sev | Finding | Evidence | Task |
|---|---|---|---|---|
| DASH-1 | B1 | the `simulated` badge is wired but can never light up | `components/KPICard.tsx:59` | P0-9, P3-14 |
| DASH-2 | B1 | the dashboard talks to `:8001` directly, so headers are browser-set | `lib/api.ts:31` | P2-1 |
| DASH-3 | B2 | `lib/tracker.ts` sends no `event_id` | `analytics-dashboard/src/lib/tracker.ts:52-67` | P3-16 |

**Demo dataset**

| ID | Sev | Finding | Evidence | Task |
|---|---|---|---|---|
| DATA-1 | B1 | the scenario fixtures span four hours, against contracts that need fourteen days | `scripts/seed_data.py:346-460` | P1-8 |
| DATA-2 | B2 | `fixtures/planted_truth.json` has never been generated | `scripts/seed_data.py:502-517` | P1-9 |
| DATA-3 | B2 | the seeded and live paths fabricate on different distributions | `scripts/seed_data.py:140-153` | P1-8 |

**Platform, compose and CI**

| ID | Finding | Severity |
|---|---|---|
| **OPS-1** | No `TZ=UTC` on the ClickHouse container — root cause of API-2. `docker-compose.yml:53-66`. | B0 |
| **OPS-2** | No ClickHouse healthcheck; `ingestion-api` and `analytics-api` use `condition: service_started`, so they can start before ClickHouse accepts queries. Kafka got a healthcheck after exactly this race; ClickHouse did not. | B2 |
| **OPS-3** | `--reload` on both FastAPI services (`:86`, `:118`). Any file touch drops every WebSocket and kills the Kafka producer, which then takes up to 15 s to re-establish (`PRODUCER_RETRY_COOLDOWN_S`). During a demo this is a visible outage. | B2 |
| **OPS-4** | Secrets committed: `NEXTAUTH_SECRET=nucleus-analytics-secret-key-2026` and `CLICKHOUSE_PASSWORD=clickhouse` in `docker-compose.yml`; real email addresses in `rbac.json`; live Supabase credentials in `scripts/nexbank_user_lookup.py` (already flagged in `CLAUDE.md` — **flag for rotation, do not fix as part of Phase 1**). | B2 |
| **OPS-5** | No CI, no `requirements-dev.txt`, `pytest` not declared anywhere. **Eleven test files in `tests/` that nothing runs.** `INTELLIGENCE_LAYER_PROPOSAL.md` §1.8 makes determinism *"a test, not a promise"* and §4 says each phase must be independently verifiable "because there is no CI yet". The determinism diff needs somewhere to run. | B1 |
| **OPS-6** | No container or compose service for the intelligence layer. `INTELLIGENCE_LAYER_PROPOSAL.md` §3 asks for *"a new service, `api/intelligence/`, with its own container"*. Decide this before writing the first stage, since it determines whether stages import `api/main.py` or not. | B1 (decision) |
| **OPS-7** | Repo hygiene: `__pycache__/*.pyc` committed; `check_brackets.py`, `check_syntax.py`, `compile_check.py`, `refactor_main.py`, `broker-inspect.json`, `rebuild.ps1` are scratch files at the repo root. | B2 |

---

---

## 2. Corrections to the repository's own status documents

These matter because plans are being made against them.

### 2.1 The `_simulated` marker did not exist  [ran] — **closed by P0-8**

`docs/INTELLIGENCE_LAYER_PROPOSAL.md` §5 stated: *"The `_simulated` marker landing in the last
merge removed the largest blocker."* At audit time it had not: a repository-wide search returned
**one hit**, `contracts/pro_revenue.yaml:22`'s unrelated `is_simulated`. No producer emitted it and
no consumer read it, so both gates protecting cube search from fabricated dimensions were missing.

**Closed.** `eventTracker.ts` emits `metadata._simulated` listing exactly the keys that event
invented, omitting any supplied by a real signal; `scripts/seed_data.py` emits it too.
`metrics.simulated_keys` reads it, and `discover_tier0`, `contracts.validate` and
`contracts.sliceable_dimensions` all consult it. The second gate, the measured invariance test, is
`metrics.dimension_invariance` against `INTEL_INVARIANCE_FLOOR`. Block A is gated on both sides.

### 2.2 There are two live producer paths, not three  [grep]

`docs/ARCHITECTURE.md` documents three producer paths and credits the browser path with *"real,
from `useGeoLocation`"* geo. `NexaBank/frontend/lib/tracker.ts`'s `nexaTracker.track()` **is never
called** — the only three call sites (`app/(auth)/login/page.tsx:76`,
`components/context/UserContext.tsx:265`, `components/register/Register3.tsx:112`) call
`setUser()`. The file's own docstring already admits this.

Consequence: **100% of live telemetry geo, device and channel comes from `eventTracker.ts`'s
random simulation, with no exception.** The "real geo" column in the architecture table describes
a path that emits nothing.

Separately, `analytics-dashboard/src/lib/tracker.ts` and `src/lib/useAutoTrack.ts` are also
entirely unwired — nothing imports either. The dashboard is not a producer today. This corrects
`docs/FinInsights_Bug_Audit.md` J1, which predicts *"a large pile"* of `ingest_validation`
dead-letters from that tracker: it sends nothing, so there is no pile. The missing `event_id` is
still a real latent defect the moment anyone wires it up.

### 2.3 `docs/FOUNDATION_STATUS.md` says 18 checks; `CLAUDE.md` says 16 — **closed**

Both quoted a fixed number for `scripts/verify_data_quality.py`, and neither was stable: several
`record()` calls sit inside loops over the contract set and its declared dimensions, so the count
grows with `contracts/*.yaml`. Both files now say to judge the exit code, not a count.

### 2.4 Referenced documents that do not exist

- `docs/audits/` — referenced by **50** comments across `api/`, `core/`, `ingestion/`,
  `processing/`, `storage/`. The directory is absent. Every "see the audit for why" comment is a
  dead link, and those comments are the only surviving record of several real incidents.
- The remediation plan and its task companion — named in `docs/INTELLIGENCE_LAYER_PROPOSAL.md`'s
  opening paragraph, as `PROPOSAL.md` and `TASKS.md`, and absent at audit time.
  **Resolved 2026-08-28:** `docs/PROPOSAL.md` and `docs/TASK.md` (singular) now exist and carry
  that role; the reference in `INTELLIGENCE_LAYER_PROPOSAL.md` was corrected to match.

### 2.5 Line numbers for the duplicate `/insights` go stale on every edit

`CLAUDE.md` cited `api/main.py:566` and `:3425`; this file then cited `:625` and `:3563`; as of
2026-08-29 they are **`:725`** and **`:3846`**, with `/admin/app/{id}/summary` at **`:2190`**.
Three sets of stale anchors for one pair of routes. The behaviour is what is stable and what to
cite: FastAPI routes HTTP callers to the **first** registration (the cached LLM variant), and
`/admin/app/{id}/summary` calls the **second** (rule-based) by module name. Find them with
`grep -n '@app.get("/insights")' api/main.py` rather than trusting any line number here.

### 2.6 Two design documents disagreed on what a specialist may read — **closed by D6**

Resolved in favour of the Metric Layer; `skills/intelligence-pipeline/SKILL.md` rule 1 carries the
correction. The original disagreement:

- `skills/intelligence-pipeline/SKILL.md` rule 1: *"Read only through the Metric API / metric
  functions (existing `/metrics`, `/funnels`, `/journey`...)"*.
- `docs/PIPELINE_CONTRACT.md` §3: *"Localize must not receive raw rows. It receives a
  `dict[cell_tuple, (numerator, denominator)]` already aggregated by the metric layer"*, and
  `contracts/kyc_completion_rate.yaml`'s lineage note says `/funnels` output is **display-only and
  is not the localizable fundamental**.

Not compatible. Resolve before anyone builds Localize against `/funnels`.

---

---

## Appendix A — verified taxonomy resolution  [ran]

Every literal event name emitted by NexaBank, run through the **real** `enforceTaxonomy` (via
`scripts/taxonomy_probe.js`, which evaluates the function's own source), then
`core.event_names.normalize_ingest_event_name`, then `api.page_map.canonicalize_event_name`.

- Literal producer names analysed: **110** (48 backend `trackEvent` literals, 28 frontend `track`
  literals, 34 `measureAndTrack` bases expanded to `.success`/`.error`)
- Distinct canonical events produced: **94**
- Names resolving to `None`: **0** among these literals — but note `pro.features_unlock.success`
  (a `LEGACY_MAP` target for `pro_unlocked`) **does** resolve to `None`, so a `None` canonical is
  reachable and every consumer must handle it.

**Canonical collisions from the backend's 48** — distinct producer names landing on one canonical:

| Canonical | Merged from |
|---|---|
| `dashboard.page.view` | `free.dashboard.view`, `pro.dashboard.view` — **tier erased** |
| `loan.applied.success` | `lending.loan.applied`, `loan_applied` |
| `loan.kyc_completed.success` | `free.loan.kyc_completed`, `kyc_completed`, `lending.loan.kyc_completed` |
| `login.auth.success` | `auth.login.success`, `free.auth.login.success` |
| `register.auth.success` | `auth.register.success`, `free.auth.register.success` |

**Names whose meaning changes in transit:**

| Producer | Canonical | What changed |
|---|---|---|
| `lending.loan.applied` | `loan.applied.success` | attempt → success |
| `free.loan.kyc_started` | `loan.kyc_started.success` | attempt → success |
| `lending.loan.kyc_abandoned` | `loan.kyc_abandoned.success` | abandonment → success |
| `free.loan.kyc_failed` | `loan.kyc.failure` | feature identity lost |
| `free.payment.success` | `payment.success.action` | status became the feature |
| `free.payment.failed` | `payment.failed.action` | status became the feature |
| `login.auth.error` | `login.auth.failed` | not normalised to `.failure` like every other page |
| `register.auth.error` | `register.auth.failed` | same |
| `loan_rejected` | `core.loan_rejected.action` | no `LEGACY_MAP` entry — falls to the generic wrapper |
| `pro.features.unlock_success` | `features.unlock.success` | `pro.` prefix stripped |
| `pro-feature.wealth-management-pro.rebalance` (+`.success`) | `pro_feature.wealth_management_pro_rebalance.success` | parallel namespace, disjoint from `wealth-management-pro.rebalance.success` |

**Good news:** every event named in the three contracts' `fundamentals` and `lineage` blocks
resolves correctly — `loan.kyc_started.success`, `loan.kyc_completed.success`,
`loan.applied.success`, `loan.approved.success`, and all four `pro_revenue` conversion events.
`auth.role.violation` and `pro.new_feature.view` (scenarios 3 and 5) canonicalize to themselves.
**The contracts are correct; the vocabulary around them is not.**

## Appendix B — licence catalog reachability  [ran]

`api/main.py:2216-2267`'s inline `feature_catalog`, diffed against the 94 canonical events the
producers actually generate.

**13 of 47 catalog keys are unreachable from any literal producer name:**

```
ai-insights.book.access            loan.kyc_failed.failure       transaction.pay_now.failure
ai-insights.page.view              loan.rejected.failure         transaction.pay_now.success
bulk-payroll-processing.page.view  login.auth.failure            wealth-management-pro.page.view
bulk-payroll-processing.search.failure   register.auth.failure
dashboard.location.captured        loan.kyc_abandoned.failure
```

**60 produced events are absent from the catalog**, so they are classified unknown/unlicensed —
including every `pro_feature.*` event, `auth.role.violation`, `features.unlock.success`,
`features.unlock.failed`, `payment.success.action`, `payment.failed.action`,
`loan.kyc_abandoned.success`, `loan.kyc.failure`, `core.loan_rejected.action`,
`profile.location.success`, `crypto-trading.price_feeds.failure`,
`wealth-management-pro.insights.failure`, `ai-insights.book.failure`, and all 15
`admin_*` events.

## Appendix C — how the verified claims were produced

```bash
# 1. Extract every literal event name the backend emits
grep -rhoE "trackEvent\(\s*[\"'][^\"']+[\"']" NexaBank/backend/src --include="*.ts" \
  | sed -E "s/trackEvent\(\s*[\"']//; s/[\"']$//" | sort -u > evnames.txt      # 48 names

# 2. Same for the two frontend entry points
grep -rhoE "track\(\s*[\`\"'][^\`\"'\$]+[\`\"']" NexaBank/frontend --include="*.tsx" --include="*.ts"
grep -rhoE "measureAndTrack\(\s*[\`\"'][^\`\"'\$]+[\`\"']" NexaBank/frontend --include="*.tsx" --include="*.ts"

# 3. Run the REAL Node dialect (evaluates enforceTaxonomy's own source; cannot drift)
node scripts/taxonomy_probe.js NexaBank/backend/src/middleware/eventTracker.ts evnames.txt

# 4. Chain through the two Python dialects (in the container -- CLAUDE.md, Key commands)
docker compose exec analytics-api python -c \
  "from core.event_names import normalize_ingest_event_name as ing; \
   from api.page_map import canonicalize_event_name as canon; \
   print(canon(ing('lending.loan.applied')))"     # -> loan.applied.success

# 5. Marker search (one hit: contracts/pro_revenue.yaml:22)
grep -rn "_simulated\|_synthetic" --include="*.ts" --include="*.tsx" --include="*.py" \
  --include="*.yaml" --include="*.sql" . | grep -v node_modules

# 6. Producer-path liveness
grep -rn "nexaTracker\." NexaBank/frontend --include="*.ts" --include="*.tsx"   # setUser only
grep -rn "useAutoTrack\|from '@/lib/tracker'" analytics-dashboard/src           # no importers

# 7. Migration runner search (zero hits outside docs/)
grep -rn "migrations" --include="*.py" --include="*.yml" --include="*.yaml" \
  --include="*.sh" --include="*.ps1" --include="*.ts" .
```

Not run, because the stack was down during this audit and both need it:

```bash
python scripts/verify_data_quality.py     # host-only; exit 0 only when every check passes
docker compose up                          # then re-assert every data claim above
```

Run both before acting on Gate P0. `CLAUDE.md` is right that this repository's failures are
silent renames rather than exceptions — including in its own status documents.
