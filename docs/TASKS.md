# TASKS.md

Status tracker for `docs/PROPOSAL.md`. One row per finding from `docs/FinInsights_Bug_Audit.md`.
Update this file as phases complete — do not let it drift the way `contracts/*.yaml` once did
(`docs/FOUNDATION_STATUS.md`'s "Fixes that were recorded as done but were not").

Last updated: 2026-08-27, through Phase 3.

## Status at a glance

| Phase | Area | Status |
|---|---|---|
| 1 | Time correctness (D1, D2, D4, G7) | **Done** |
| 2 | Canonical taxonomy (B1–B6, H3, H7, H9) | **Done** — scope changed after live verification, see below |
| 3 | Identity correctness (C1, C3, C4) | **Done** |
| 4 | Honest fabricated dimensions (A1–A7, E9) | Not started |
| 5 | Trust Gate observability (J1, J2, D5) | Not started |
| 6 | Schema/deployment durability (G1–G4, G6) | Not started |
| 7 | Query correctness cleanup (H1, H2, H4–H10) | Not started |
| 8 | Delivery/idempotency hardening (E1, E2, E7, E8) | Not started |
| — | Section F (security) | **Excluded by scope**, not tracked here |
| — | K1–K4 (LLM path) | **Excluded by scope** — Stage 07 build, not a bug fix |

Re-run before trusting any "Done" row: `python scripts/verify_data_quality.py` (stack up).

---

## Phase 1 — Time correctness — DONE

| Item | Status | Evidence |
|---|---|---|
| G7 — pin ClickHouse to UTC | ✅ Done | `TZ: UTC` added to the `clickhouse` service in `docker-compose.yml` |
| D1 — `/metrics/traffic` IST offset | ✅ Done | `+ INTERVAL 330 MINUTE` replaced with plain `toDate(timestamp)` |
| D1 — second `+330 MINUTE` site | ⏭️ Not fixed, by design | Lives inside the dead second `/insights` (line ~3563+); deleted outright in Phase 7 (H1) instead |
| D2 — unequal current/previous windows | ✅ Done | 8 sites in `api/main.py`: `sql_current`/`sql_response`/`sql_error` (`/metrics/kpi`), `sql_basic`/`sql_bounce`/`sql_time` (`/metrics/secondary_kpi`), `sql_wow` (`/tenants/compare`), `sql_trend` (`/predictive/adoption`) — all given an explicit `< today()` upper bound |
| D3 — partial-vs-full-day trending heuristic | ⏭️ Deferred | Superseded by Stage 02's real MAD/IQR detection; not worth a bespoke fix |
| D4 — timestamp validator | ✅ Done | `FeatureEvent.timestamp` field_validator in `core/models.py`, rejects outside `[now-90d, now+5m]`; confirmed dead-letters via existing `ingest_validation` path; confirmed compatible with the simulate console's 60-day backdate cap |
| D4 — blanket read-side upper-bound sweep (~70 sites) | ⏭️ Deferred | Ingestion-side gate (above) is the higher-leverage fix; sweep is optional cleanup, not correctness-required |

**Correction logged:** initially misread `ingestion/main.py:410`'s path check as `"\events"` (a bug);
re-checked with Grep, it correctly reads `"/events"`. No bug, no fix needed — noted here so this
false alarm isn't rediscovered.

**Verification:** AST-parsed all edited Python files. Full functional/live verification deferred to
Phase 2's stack-up (see below) — confirmed no regressions there (`TAXONOMY`/`IDENTITY`/`LANDED`/
`ROLLUP` all pass post-Phase-1-and-2 changes).

## Phase 2 — Canonical taxonomy — DONE (scope changed after verification)

| Item | Status | Evidence |
|---|---|---|
| B2 — login/register status-normalization asymmetry | ✅ Done | Added missing branch to `canonicalize_event_name` in `api/page_map.py`; verified live: `login.auth.failed` → `login.auth.failure`, matches `/license/usage`'s catalog for the first time |
| B1 — action→success coercion | ❌ **Won't fix** | Verified live against `events_raw`: no feature has both `.action` and `.success`/`.failure` — no funnel is being hidden. 3 of 8 contract lineage events (`loan.kyc_started.success`, `loan.kyc_completed.success`, `loan.applied.success`) are reachable *only* via this coercion. Changing it would zero out those lineage events. |
| B6 — raw-keyed rollup / double counting | ❌ **Won't fix now** | Verified live: only 2 canonical names affected (`account.page.view`, `dashboard.page.view`), neither a contract fundamental; existing `max()` is a safe-direction undercount; `daily_feature_usage` currently agrees exactly with `events_raw` (2051=2051). Correct fix belongs in the Stage-00 metric layer (not yet built), not a patch on two endpoints. |
| B3 — pro-prefix strip inconsistency | ⏭️ Not re-verified this pass | Self-documented as a known, contained, one-event trap in `core/event_names.py`'s own docstring |
| B4 — dead legacy-alias dict entries | ⏭️ Not touched this pass | Believed dead (raw producer names never reach `page_map.py` un-normalized) but not empirically confirmed; low risk, low value, deferred |
| B5 — Node/Python disagree on `kyc_started` legacy key | ⏭️ Not re-verified this pass | Same file/risk class as B3/B4 |
| H3, H7, H9 (name-matching half) | ⏭️ Deferred to Phase 7 | Depend on B1/B6 conclusions above; H9 also depends on Phase 4's A7 |
| **New finding (not in original audit):** `free.payment.success`/`free.payment.failed` → `payment.success.action`/`payment.failed.action` (258 rows) | 🚩 Flagged, not fixed | Traced to `NexaBank/backend/src/routes/eventRoutes.ts` (backdated simulate/seed-generation code, `dayTs + N` pattern) — excluded by the simulation-page scope boundary. Real payment flow (`transactionRoutes.ts`) unaffected. |

**Verification run (`scripts/verify_data_quality.py`, full history, 2051 rows):**
`TAXONOMY` ✅, `IDENTITY` ✅, `LANDED` ✅, `ROLLUP` ✅ (no regressions from Phase 1+2 changes).
8 pre-existing failures found; re-run scoped to today-only data (`VERIFY_SINCE`) showed:
- `SESSIONS` (server-minted fallback ids) and `DUPES` (duplicate page views) — **stale historical
  data from before earlier fixes landed**, clear on today's data. Not active.
- `DIMS` session-invariance (`device_type`/`location`/`continent`) — **still fails on today's
  data**, one session. Active, not caused by this work. Not chased down in Phase 3 (needs
  NexaBank running); carried forward to Phase 4 (see below).

## Phase 3 — Identity correctness — DONE

| Item | Status | Evidence |
|---|---|---|
| C1 — `/funnels` grouped by `user_id` | ✅ Done | `api/main.py`'s `/funnels` now groups the inner `windowFunnel` query by `session_id`, matching `kyc_completion_rate.yaml`'s declared `grain.entity: session`. Verified live against real data: `loan.kyc_started.success` → `loan.kyc_completed.success` returns 36 → 13 (63.89% drop-off), matching the number already on record in `docs/FOUNDATION_STATUS.md`. JSON response shape (`users_completed` field name) left unchanged per CLAUDE.md rule 6 — the endpoint has no shape/consumer change, only what it counts changed (sessions, not raw user_id rows). |
| C1 — literal `"anonymous"` string collapsing all logged-out visitors | ✅ Done | `NexaBank/backend/src/middleware/eventTracker.ts`'s `trackEvent` now uses `` `anon_${sessionId}` `` instead of the literal string, so distinct anonymous visitors no longer merge into one `GROUP BY` row. Does not give genuine cross-session anonymous retention (would need a durable per-browser id, out of scope) — it stops the false collapse, it doesn't invent new tracking. |
| **New finding, same bug class, different call site:** `proController.ts` passed the literal string `"anonymous"` *as* `customerId` (not `null`) at 3 call sites, bypassing the `customerId ?` check entirely | ✅ Done | All 3 sites (`getCryptoPrices`'s cache/live/error paths) changed from `customerId \|\| "anonymous"` to `customerId \|\| null`, routing correctly through the fixed anonymous-session path above. |
| C4 — `hashUserId` unsalted SHA-256 | ✅ Done | Added `USER_ID_HASH_SALT` (env-sourced secret) folded in along with `tenantId`, so the same customer hashes differently per tenant and a leaked salt for one tenant doesn't compromise others. Logs a startup warning if unset rather than silently running unsalted. |
| C4 — frontend's independent hash implementation | 🚩 Flagged, not fixed | `NexaBank/frontend/lib/tracker.ts`'s `hashUserIdHex` replicates the same algorithm client-side and is now stale relative to the salted backend version — but confirmed via grep it has **zero live call sites** (dead code), so this is a documentation fix (comment updated to explain the divergence and warn against restoring byte-for-byte parity by shipping the secret into the browser bundle), not an active bug. |
| C3 — ON_PREM anonymization via Python's randomized `hash()` | ✅ Done | `ingestion/main.py` now uses `hashlib.blake2b(salt:user_id)` with a 16-byte digest — stable across restarts (unlike `hash()`, which is re-seeded via `PYTHONHASHSEED` per process) and no realistic collision risk (unlike the old `% 1000000`). New `ON_PREM_USER_ID_SALT` setting in `core/config.py`, with the same unset-warning pattern as C4. Not live-tested (would require switching `DEPLOYMENT_MODE=ON_PREM`), verified by code/logic review and AST parse only. |
| C2 — pre-login events structurally impossible (`isLoggedIn` middleware) | 🚩 Flagged, not fixed | Per `docs/PROPOSAL.md`: changing a banking API's auth boundary needs explicit sign-off, not a bundled change. |

**Verification:**
- `NexaBank/backend`: `npx tsc --noEmit` — confirmed **zero new errors** introduced (14 pre-existing
  errors, unrelated to the edited files/lines, present identically before and after via `git
  stash` comparison; all are stale-Prisma-client issues, e.g. `Prisma.InputJsonValue` not
  exported, that predate this work).
- Rebuilt and restarted `ingestion-api`/`analytics-api`/`processor-worker` with the Phase 3
  changes; re-ran `scripts/verify_data_quality.py` — identical result to the Phase 2 baseline,
  same 8 pre-existing failures, zero new ones, `TAXONOMY`/`IDENTITY`/`LANDED`/`ROLLUP` all still
  pass.
- Live-exercised the fixed `/funnels` endpoint end-to-end against real ClickHouse data (see C1
  row above).
- **Not done:** NexaBank frontend/backend containers were not brought up this phase (only the
  core data-path services are running), so the C1/C3/C4 TypeScript changes are verified by
  typecheck and logic review, not by an actual browser/API request through NexaBank. The
  carried-forward DIMS live lead below still needs NexaBank running to chase.

---

## Carried forward into Phase 4

- **Live lead:** one session in today's data has non-invariant `device_type`/`location`/
  `continent` — C5-adjacent (session-profile eviction re-randomizing a live session). Needs
  NexaBank actually running to trace further; start Phase 4 here rather than the broad A1–A6
  sweep blind.
- **C2** (pre-login events impossible, `/events/track` requires `isLoggedIn`) — flagged in
  `docs/PROPOSAL.md`, needs explicit sign-off before touching a banking API's auth boundary. Not
  Phase 4's job either; carried as a standing flag until you decide.

## Not tracked here (excluded by scope, see `docs/PROPOSAL.md`)

- Section F (F1–F10) — security, per `CLAUDE.md`'s Phase 1/Phase 2 boundary.
- K1–K4 — LLM path replacement is Stage 07 construction, not a bug-fix task.
- G5, G8, G9, most of Section I, J4, J5 — deprioritized cleanup, not data-accuracy issues.
