# PROPOSAL.md

What is being done to `docs/FinInsights_Bug_Audit.md`'s findings, and why, before the Phase 1
intelligence layer is built on top of this data. Companion to `docs/TASKS.md`, which tracks status;
this file is the plan itself — scope, sequencing, and the reasoning behind each phase.

Source of every numbered finding (A1, B2, D4, ...) is `docs/FinInsights_Bug_Audit.md`. Read that
first if a finding ID here is unfamiliar.

---

## Goal

Make the telemetry `events_raw`/`daily_feature_usage` and the analytics endpoints read from
**accurate** for the nine-stage intelligence pipeline in `docs/PHASE_1.md` — not "fix everything
in the audit," but fix everything that would make a stage compute or narrate a wrong number
without anyone noticing.

## Scope boundaries (fixed for the whole effort, not per-phase)

1. **The simulation page is untouched.** `/admin/simulate`, `POST /events/simulate`,
   `NexaBank/backend/src/helper/simulationBehavior.ts`, `BehaviorControls.tsx`, and `trackEvent`'s
   `timestampOverride` parameter are not modified. Where a fix must survive what that page does
   (e.g. backdated events), the *pipeline* is made robust to it — the page itself is not changed.
2. **All of Section F (security) is excluded**, per `CLAUDE.md`'s own "Never do" list: *"do not
   'fix security' as part of Phase 1 (that is Phase 2)."* This includes the SQL injection in
   `/tracking/toggles` (F2) even though it is a small fix — it is a security fix, not a data-
   accuracy fix, and CLAUDE.md draws that line explicitly.
3. **Deprioritized, not excluded:** G5/G8/G9 (reload flag, CI, repo hygiene), most of Section I
   (client-leak/perf items), J4/J5 (session-id entropy, `res.end` patching). These don't change
   whether a number is correct. Listed at the end as a cleanup tier.
4. **No new dependencies, no new infrastructure**, per `CLAUDE.md` rule 2 — every fix here uses
   what the stack already runs.
5. **Every finding is verified against the live stack before it is changed**, not inferred from
   reading code — `CLAUDE.md`'s standing rule, and the reason Phase 2 below did not go the way
   the audit assumed it would (see "What changed after verification").

## Execution model

Phase-by-phase, pausing for review after each phase — not one uninterrupted pass through all
8 phases. Two of `docs/FinInsights_Bug_Audit.md`'s coupling points (event taxonomy, tenant/session
grain) are exactly the highest-blast-radius items `CLAUDE.md` warns about, so each gets its own
verification pass rather than being bundled.

---

## Phase 1 — Time correctness (D1, D2, D4, G7)

**Why first:** every later phase's "current vs previous," "last N days," and "is this window
still provisional" logic sits on top of what "a day" and "now" mean. Fixing this after Phase 4+
would mean re-verifying those phases' output.

| Item | Fix |
|---|---|
| G7 / D1 | Pin `TZ: UTC` on the ClickHouse container — the actual root cause; `today()`/`now()` with no explicit timezone were resolving against whatever the base image's `/etc/localtime` happened to be. |
| D1 (the one live IST-offset site) | `/metrics/traffic` bucketed by `toDate(timestamp + INTERVAL 330 MINUTE)`; changed to plain `toDate(timestamp)` to agree with `daily_feature_usage`'s day boundary. The *other* `+330 MINUTE` site the audit flagged lives inside the dead second `/insights` definition (see Phase 7/H1) — left alone, since it is deleted outright rather than fixed in place. |
| D2 | 8 call sites across `/metrics/kpi`, `/metrics/secondary_kpi`, `/tenants/compare`'s week-over-week, and `/predictive/adoption`'s trend query had an unbounded "current" window (`>= today()-N`, implicitly through now) compared against a clean "previous" window (`>= today()-2N AND < today()-N`) — current was systematically N days + a partial day, biasing every `pct_change` upward. Added the missing upper bound so both sides are equal, complete windows. Not applied to plain trend-chart queries (e.g. `/metrics/traffic`'s own chart data) — those aren't comparisons, and truncating today's partial bar would be a regression. |
| D4 | Added a `field_validator` on `FeatureEvent.timestamp` (`core/models.py`) rejecting anything outside `[now-90d, now+5m]`. Raises `ValueError` → FastAPI 422 → the existing `ingestion/main.py` handler already dead-letters this under `stage='ingest_validation'`, so no new wiring was needed. Checked against the simulate console's own limits first: `simulationBehavior.ts`/`eventRoutes.ts` cap backdating at 60 days, comfortably inside the 90-day floor. The blanket "add an upper bound to all ~70 remaining read-side queries" half of D4 is deferred — closing the ingestion door is the higher-leverage fix; the read-side sweep is optional cleanup, not a correctness requirement, once bad timestamps can't land in the first place. |
| D3 | **Deferred on purpose.** `data_layer.py`/`insights.py`'s partial-today-vs-full-yesterday "trending" heuristic would need an invented scaling correction to fix properly, and Stage 02 (Detect) is going to replace this heuristic with real MAD/IQR statistics per `docs/PIPELINE_CONTRACT.md` anyway. Patching it now is throwaway work. |

## Phase 2 — Canonical taxonomy (B1–B6, H3, H7, H9's name-matching half)

**What the proposal originally said:** add an `event_name_canonical` column, repoint the MV's
`GROUP BY` to it, delete `page_map.py`'s independent re-canonicalization from every endpoint.

**What verification against live `events_raw` actually found**, and why the plan changed:

- **B1 (action→success coercion) is not a bug to fix.** Queried every feature that ever emits an
  `.action` status against whether it also has a `.success`/`.failure` sibling in the same table.
  None do. Three of the eight lineage events across all three contracts
  (`loan.kyc_started.success`, `loan.kyc_completed.success`, `loan.applied.success`) are reachable
  *only* because the coercion runs. There is no attempt-vs-completion funnel being hidden on this
  instrumentation — these are genuinely single-shot events. Removing the coercion would zero out
  three lineage events for no corresponding gain. **Decision: leave the coercion as-is.**
- **B2 (login/register asymmetry) — fixed.** `canonicalize_event_name` had no branch for
  `login`/`register`, so `login.auth.failed` never became `login.auth.failure` the way every
  other page's `failed`→`failure` did. Added the missing branch, deliberately *without* the
  "any other status → success" coercion other branches have — no producer, contract, or seed
  script emits an "action"-suffixed auth event, so there's nothing that needs it. Verified this
  makes `/license/usage`'s `login.auth.failure`/`register.auth.failure` catalog entries reachable
  for the first time.
- **B6 (raw-keyed rollup, double-counting) is real but far narrower than the audit implied.**
  Exactly two canonical names are currently reached by more than one raw spelling
  (`account.page.view`, `dashboard.page.view`), both page-view display counts, neither a contract
  fundamental. The existing `max()` approach is a documented, safe-direction *undercount*, never
  an overcount. Also confirmed live: `daily_feature_usage` currently agrees exactly with
  `events_raw` (2051 = 2051) — no drift today. **Decision: the correct fix belongs in the Stage-00
  metric layer (`docs/PIPELINE_CONTRACT.md` §3, not yet built), not a patch bolted onto two ad hoc
  endpoints for a non-contract-critical estimate.**
- **B3, B4, B5** — not independently re-verified this pass; B3 is self-documented as a known,
  contained, one-event trap in `core/event_names.py`'s own docstring. Left alone.
- **New finding, not in the original audit:** 258 rows (`free.payment.success`/
  `free.payment.failed`) get mangled by `enforceTaxonomy`'s prefix-stripping logic into
  `payment.success.action`/`payment.failed.action` — the status token gets misread as the feature
  name. Traced to `NexaBank/backend/src/routes/eventRoutes.ts`, which is backdated (`dayTs + N`)
  simulate/seed-generation code — the real payment flow (`transactionRoutes.ts`) is unaffected.
  **Not fixed — it lives inside the simulate-generation surface excluded by scope boundary #1.**

## Phase 3 — Identity correctness (C1, C3, C4)

- `/funnels` and retention: group on `session_id`, matching `kyc_completion_rate.yaml`'s declared
  `grain.entity: session` — the SQL doesn't match its own contract today.
- Replace `trackEvent`'s literal `"anonymous"` string with a stable per-session anonymous id
  derived from `session_id` (already minted), so distinct logged-out visitors stop collapsing
  into one `GROUP BY` row. **Found during implementation:** `proController.ts` had 3 call sites
  passing the literal string `"anonymous"` *as* `customerId` (`customerId || "anonymous"`),
  bypassing `trackEvent`'s `customerId ?` branch entirely — same bug, different guise. Fixed
  alongside the main change (`customerId || null`).
- Add a per-tenant secret salt to `hashUserId` (C4) — currently unsalted SHA-256 over a bounded ID
  space.
- C3: swap `ingestion/main.py`'s ON_PREM anonymization from Python's per-process-randomized
  `hash()` to `hashlib.blake2b(user_id + tenant_salt)`.
- C2 (pre-login events structurally impossible because `/events/track` requires `isLoggedIn`) —
  flagged, not fixed. Changing a banking API's auth boundary needs explicit sign-off, not a
  bundled change.
- **Known live lead to chase first:** `verify_data_quality.py`'s `DIMS` check still fails on
  today-scoped data for one session (`device_type`/`location`/`continent` not session-invariant),
  discovered during Phase 2's verification pass. This is C5-adjacent (session-profile eviction)
  and needs NexaBank actually running to trace — start there before the broader C1/C3/C4 sweep.

## Phase 4 — Honest fabricated dimensions (A1–A6, A7, E9)

Treats `eventTracker.ts`'s geo/device randomization as intentional demo behavior, not something
to eliminate — the fix is to make the fabrication **visible and excluded**, not to rip it out.

- Tag `metadata._simulated: [...]` on the shared producer path (`forwardToIngestionAPI`, not the
  simulate page); contract loader (built as part of Stage 00) refuses those dimensions in
  `dimensions.allowed`.
- A3: fix the confirmed-live naming bug — frontend still writes `responseTime` (camelCase),
  backend still reads `metadata.response_time_ms` (snake_case), so the real measurement is
  discarded and the random fallback fires every time. Rename the frontend field; write `null` +
  `_synthetic_fields` when no real measurement exists.
- A4: make the `/metrics/kpi` "simulated" flag read `_synthetic_fields` instead of inferring from
  key-presence (which the producer always satisfies today, defeating the check).
- A5: gate the second, SQL-level latency fabrication behind the same synthetic flag.
- A6: rename `/tenants/compare`'s `conversion_rate` (actually "users with >3 events") to something
  accurate.
- A7 / E9: route `seed_safexbank.py` through `POST /events` like `scripts/seed_data.py` already
  does, with deterministic `event_id`s; fix `seed_licenses.py`'s feature names to match what
  `/license/usage`'s catalog resolves. These are seed *scripts*, not the simulate page, and the
  seeded dataset is `FOUNDATION_STATUS.md`'s own candidate demo dataset — in scope.

## Phase 5 — Give Trust Gate something real to gate on (J1, J2, D5's pipeline-side half)

- `forwardToIngestionAPI`'s `catch` block: add outcome counters (status/timeout/network),
  exposed at `/health/forwarder`. This is what `pro_revenue`'s `tracking_disabled` fingerprint
  ("ingestion 403 rate > 0") needs to ever be able to fire — right now the 403 is discarded at
  the producer and Trust Gate has no way to distinguish a real KPI drop from a broken forwarder.
- `analytics-dashboard/src/lib/tracker.ts`: add `event_id` (J1) so its own posts stop getting
  422'd and silently dead-lettered.
- D5, pipeline-side only: use `ingested_at` as a watermark so a re-run can reproduce exactly what
  was visible at scoring time, regardless of what the simulate console backdates in afterward.
  Closes `FOUNDATION_STATUS.md`'s "still missing #5: provisional windows."

## Phase 6 — Schema/deployment durability (G1–G4, G6)

- G1: a small `schema_migrations` table + startup job applying unapplied `storage/migrations/*.sql`
  files in order; `schema.sql` becomes migration #0, not a living document.
- G2: write `FeatureEvent.schema_version` to an actual column instead of discarding it.
- G3: delete `ingestion/main.py`'s duplicate ClickHouse client construction; import `settings`.
- G4: fix `NEXT_PUBLIC_ANALYTICS_WS_URL` to a browser-resolvable host.
- G6: ClickHouse healthcheck + `condition: service_healthy` on both API services.

## Phase 7 — Query correctness cleanup (H1, H2, H4, H5, H6, H8, H9, H10)

- H1: delete the dead second `/insights` (confirmed still present at both line ranges) —
  confirm which one `/admin/app/{id}/summary` calls by function name first, per `CLAUDE.md`'s
  explicit warning on this exact pair.
- H2: validate `tenants` in a shared dependency, 400 instead of a leaked ClickHouse error.
- H4: `pct_change` returns `None` ("new") instead of fabricating `(0.0, "up")` on 0→N.
- H5: replace `/predictive/adoption`'s scoring wholesale with the seasonal-naive baseline +
  real intervals `forecasts`'s schema already mandates. This is really Stage 04 construction.
- H6: `windowFunnel(..., 'strict_increase')`, `timestamp` → `DateTime64(3)`.
- H8: fix the error-rate precision loss.
- H9: make `tenant_licenses` the single entitlement source, replacing the hardcoded catalog dict —
  depends on Phase 2's B2 fix and Phase 4's A7 fix already landing.
- H10: fix `seed_licenses.py` to seed post-rewrite tenant ids (`nexabank`/`safexbank`).

## Phase 8 — Delivery/idempotency hardening (E1, E2, E7, E8)

Not personally re-verified — `processing/worker.py` changed substantially in the `b35fe8e`
hardening commit that landed before this effort started. Run `scripts/reconcile_kafka_offsets.py`
and `scripts/find_dual_path_duplicates.py` (both added in that commit) before touching anything
here; they may already answer whether E1/E2/E8 are still live.

- E1: `consumer.pause()`/`resume()` instead of stopping `poll()` during a sink outage.
- E2: a `dirty` flag set by dead-lettering as well as successful inserts.
- E7: document the "MV safety depends on `uniqExactState`, never `countState`" constraint as a
  schema comment and a test.
- E8: make `event_id` mandatory at every writer, then delete the `legacy:` concat fallback key.
- E3/E4/E5/E6 — leaving as-is: E5 self-mitigates today, E6 is correctly a documented no-op,
  E3/E4 only matter once replicas actually scale.

## Not included in this proposal

- **All of Section F** — per `CLAUDE.md`, see scope boundary #2.
- **K1–K4** (LLM path) — Stage 07 construction (the Narrator + numeric verifier), not a "make
  existing data accurate" fix. New code against `docs/PIPELINE_CONTRACT.md`, scoped separately
  via the `intelligence-pipeline` skill.
- G5/G8/G9, most of Section I, J4/J5 — see scope boundary #3.
