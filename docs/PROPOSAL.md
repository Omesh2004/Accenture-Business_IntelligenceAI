# PROPOSAL.md

The remediation plan for the substrate the intelligence layer will stand on: what is wrong, what
we propose to do about it, which decisions need a human, and what we are deliberately not doing.

**This file argues. `docs/TASK.md` executes.** Every proposal here resolves to numbered tasks
there; nothing here is a work item on its own.

Companion documents, and the boundary between them:

| File | Says |
|---|---|
| `docs/INTELLIGENCE_LAYER_PREREQUISITES.md` | The audit. What is broken, with evidence, and the prerequisite/build dividing line |
| `docs/FinInsights_Bug_Audit.md` | The earlier repository-wide bug sweep, by section (A–K) |
| **this file** | What we propose to do about it, and why that shape |
| `docs/TASK.md` | The sequenced work, with acceptance criteria |
| `docs/INTELLIGENCE_LAYER_PROPOSAL.md` | What gets built *on top* once this lands |

---

## 1. The finding this plan is a response to

The audit's one-line conclusion:

> The pipeline is not the weak layer. `processing/worker.py`, the migration files and the contract
> YAMLs are careful and largely correct. **The weak layer is the producer.** `eventTracker.ts`
> invents most dimensions, discards the one real measurement it is handed, swallows every failure,
> and disagrees with the Python taxonomy on both sides of it.

That matters because of what the intelligence layer does with what it is given. A transport bug is
visible — a chart is empty, an endpoint 500s. A **producer** bug is invisible, because the pipeline
faithfully carries invented data and every stage downstream treats it as measurement. Localize will
return contributions summing to ~1.0, ranked, with an `explained_pct`, over dice rolls, and nothing
downstream can tell.

So the ordering principle for this whole plan is:

> **Fix the source and the seam before adding anything that reasons over them.** Hardening the
> transport further buys nothing; the transport is already the best-engineered part of the repo.

---

## 2. Proposed remediation, by block

The audit names eight blocks. Each gets a proposed shape here; the tasks are in `docs/TASK.md`.

### Block A — fabricated dimensions

**Proposal: mark, do not remove.** Do not delete the geo/device simulation — the demo needs
plausible traffic and there is no real global user base. Instead make the fabrication *declared*:

- `eventTracker.ts` adds `metadata._simulated: ["location","city","continent","device_type","channel"]`
  listing exactly the keys it invented on that event, and **omits a key from the list when the
  value came from a real signal** (`POST /events/location`, or the simulate console's own
  per-session geo).
- The contract loader — Tier 0 discovery and the Tier 1 validator alike — refuses to admit any key
  named in `_simulated` into `dimensions.allowed`.
- The dashboard labels any chart built on a `_simulated` key.

**Landed:** the marker and the loader refusal (P0-8, B-1). **Open:** the dashboard labelling
(`docs/TASK.md` P3-14) -- the `KPICard` badge is wired and fed by `/metrics/kpi`, but no other
chart reads the marker.

**Why this shape.** "We detect our own simulated data and refuse to localize on it" is a stronger
and more honest demo than a plausible-looking false root cause, and it converts an invisible
correctness hole into a visible, testable property. It also costs one field in the envelope rather
than a redesign of the producer.

**Consequence to accept:** with `location`, `device_type` and `channel` excluded, the live path has
**no** localizable dimension left. That is the true state of the system, and it is why the seeded
path is the demo dataset (Block H). Discovering this at demo time would be much worse than
declaring it now.

### Block B — the taxonomy

**Proposal: canonicalise once, at ingest.** Store `event_name_raw` and `event_name_canonical` on
`events_raw`; add `event_name_canonical` to the materialized view's `GROUP BY`; delete read-time
canonicalisation from the endpoints.

This is the single highest-leverage change in the plan. It collapses, in one move: the three-dialect
drift, the `max(a,b)`-versus-`+=` unique-user inconsistency, the substring error-rate match, the
per-request `SELECT DISTINCT event_name` scan in `/funnels`, and the licence-catalog mismatch.

**Separate from the mechanism, four semantic decisions have to be made** — they are not
refactors and cannot be inferred from the code:

1. **`action` → `success`.** Today `lending.loan.applied` becomes `loan.applied.success`, so an
   attempt is indistinguishable from an outcome. Proposal: **stop coercing.** Keep `action` as a
   distinct status and let contracts name it explicitly. This changes what
   `kyc_completion_rate` and `loan_approval_volume` count, so it must be done before any
   baseline is computed, never after.
2. **`failed` vs `failure`.** Proposal: pick `failure` at the canonical layer and give `login` and
   `register` the branch they are currently missing.
3. **The `free.`/`pro.` prefix.** It is currently stripped, merging `pro.dashboard.view` with
   `free.dashboard.view` and erasing tier. Proposal: preserve tier as **metadata**, not as a name
   segment, and let the name carry only page/feature/status.
4. **The `pro_feature.*` namespace.** The frontend and backend record the same user action under
   two disjoint names. Proposal: converge the frontend on the backend's spelling; the backend's is
   what the contracts already count.

### Block C — time

**Proposal: one definition of a day, enforced at three levels.**

- `TZ=UTC` on the ClickHouse container, so `today()` stops being server-local.
- Every `today()` replaced with `toDate(now('UTC'))`; the three hardcoded `+ INTERVAL 330 MINUTE`
  offsets deleted; display-timezone conversion moves to the frontend where it belongs.
- Every window bounded at both ends, with current and previous windows the same length.
- A validator on `FeatureEvent.timestamp` rejecting anything outside `[now - 90d, now + 5m]`, with
  rejects dead-lettered — the DLQ path for validation failures already exists.

Mechanical, individually verifiable, and it removes a systematic upward bias from every
`pct_change` in the codebase rather than compensating for it downstream.

### Block D — the Trust Gate has nothing to gate on

Two independent problems that happen to share a stage.

**D-i, the forwarder.** `forwardToIngestionAPI` catches every exception and does nothing. Proposal:
count outcomes by status code, expose them at `GET /health/forwarder`, buffer failures with retry,
and emit a per-tenant heartbeat on a fixed cadence so **absence of data is itself observable**. The
call stays unawaited — `CLAUDE.md` rule 7 is not negotiable, and instrumenting a `catch` does not
block banking.

**D-ii, `dedup_integrity`.** `events_raw` is now `ReplacingMergeTree(_inserted_at)` ordered by
`(tenant_id, event_name, timestamp, event_id)`, so a real worker replay is collapsed by a
background merge and `count() == uniqExact(event_id)` becomes true again. Whether the hero scenario
is caught depends on whether a merge has run — non-deterministic, and a direct violation of the
determinism rule.

**This needs a decision, and the three options are not equivalent:**

| Option | Shape | Cost |
|---|---|---|
| **(a) Detect at the write boundary** *(recommended)* | The worker counts replayed offsets and publishes it as a signal the Trust Gate reads | New counter + a place to put it; robust to merges; detects the real thing |
| (b) Re-express the invariant | Find a formulation merges cannot collapse | May not exist; risks a second invariant that is also merge-dependent |
| (c) Revert `events_raw` to `MergeTree` | Restores the invariant exactly as contracts declare it | Gives up the dedup the engine change bought, and readers already absorb replay via `uniqExact` |

Recommendation is (a): the storm is a *write-path* event, so detecting it on the write path is the
honest place, and it survives any future storage-engine change.

Note the seeded fixture currently passes for a reason unrelated to the mechanism — it emits its
duplicate pair one minute apart, so the timestamps differ and the merge key does not match. Fixing
the fixture to emit true byte-identical duplicates is part of the same task, or the gate keeps
passing without testing anything.

### Block E — determinism

**Proposal: make the substrate capable of it, then let the layer's own discipline do the rest.**
Three substrate changes, all cheap now and expensive later:

- `daily_feature_usage.unique_users` becomes `AggregateFunction(uniqExact, String)`. It is
  HyperLogLog today, so any stage reading it is non-deterministic by construction.
- `investigations` gains an ingest-watermark column, pinned alongside the window. `ingested_at`
  already exists on `events_raw`; the simulate console backdates events into past partitions, so
  without a watermark an investigation computed yesterday is not reproducible today. **A column
  can never be backfilled onto rows that never carried one** — this is the cheapest task in the
  plan and the most expensive to defer.
- The `any()` calls in existing aggregate subqueries move to `min()`/`argMin()` if any metric
  function is going to reuse those query shapes.

### Block F — identity, personas, entitlement

**Proposal: verify the token server-side, then add personas on top of a real identity.**

`RBACMiddleware` trusts `X-User-Role`/`X-User-Email`/`X-Admin-Apps`; the browser sets them; :8001 is
published to the host. Personas layered on that would be decorative.

Order matters: verify the NextAuth JWT in the analytics API (shared `NEXTAUTH_SECRET`), stop
publishing 8001 to the host, route the dashboard through its own Next.js server — **then** add
`cfo`/`ops_manager`/`analyst` to `rbac.json` and resolve them server-side.

**This is scoped deliberately.** It is not "fix security", which `CLAUDE.md` puts in Phase 2. It is
the minimum that makes the Definition of Done's *"zero entitlement leaks, including
back-computable restricted numbers"* a claim we can actually make. The committed secrets stay
flagged for rotation and out of scope.

### Block G — applying schema changes

**Proposal: a ~40-line idempotent runner** — a `schema_migrations` table plus a startup job that
applies unapplied files in order — and demote `schema.sql` to the *initial* migration rather than a
living document.

At proposal time `storage/migrations/` held nine files and nothing applied them. This had already
caused a real incident: a fresh volume produced the old 8-column table while the running code
required 14, every insert failed, **and the dead-letter fallback failed too** because it had the
same gap — events were lost with no trace. That was patched by editing `schema.sql`, leaving the
failure mode structurally intact.

**Landed as `storage/migrate.py`** (P1-2, P1-3). It records name plus content hash, so an *edited*
migration is reported rather than skipped, and it carries a `--baseline` for an
already-migrated database. `schema.sql` still runs only on an empty volume, so the mirror-both-sides
rule stands.

### Block H — the demo dataset

**Proposal: the seeded path is the demo dataset; make it able to fire.**

At proposal time `seed_scenarios` emitted every scenario event with an offset in *minutes*, the
largest 240 — so all five landed inside one four-hour window, against contracts declaring
`grain.time: daily`, `min_history_days: 14` and `min_persistence_windows: 2`. A daily detector with
a two-window persistence floor cannot fire on one day of data.

**Landed** (P1-8, P1-9): the planted movement spreads across daily buckets (`anomaly_days: 7`) above
`min_denominator: 30`, and `fixtures/planted_truth.json` is generated and committed. One further
constraint emerged in the doing: golden fixtures and demo data must not share a tenant, and the two
defect scenarios must not share one with the pass scenario they would quarantine. The gates read
their tenant list from the fixture rather than a literal.

**Why seeded rather than live:** after Block A, the live path has no admissible dimension, so it
cannot support Localize at all. This is a consequence of being honest about fabrication, not a
regression.

---

## 3. Decisions that need a human

Nothing below can be resolved by reading the code. Each blocks the tasks named.

**All six were resolved on 2026-08-28 and are now implemented.** Recorded here with the reasoning,
because each shaped the code.

| # | Decision | Resolution |
|---|---|---|
| **D1** | Duplicate-storm detection under `ReplacingMergeTree` | **Count raw inserted rows in the materialized view.** An MV fires on the *inserted block* and never sees post-merge state, so a `sumState(1)` alongside `uniqExactState(event_id)` is immune to the merges that erase the duplicates from `events_raw`. A replay fires the MV again: raw rows climb, distinct ids do not. `dedup_integrity` becomes `sumMerge(raw_rows) > uniqExactMerge(event_count)`. Chosen over the write-boundary counter because it needs no worker change, no new table, and survives any future storage-engine change. |
| **D2** | Does `action` stop being coerced to `success`? | **No — not globally.** Changing `canonicalize_event_name` moves all 94 canonical names and every dashboard chart at once. Instead the **Metric Layer resolves a contract's declared event to the exact set of stored raw names** that canonicalize to it, and counts those. The intelligence layer gets precision; the dashboard keeps its vocabulary. One seam, no global rename — and a contract that needs attempt-vs-outcome separation declares the precise stored names. |
| **D3** | Own container? | **Yes, same image, separate compose service.** `api/intelligence/` is a package; the `intelligence` service runs it with a different `command`. No second Dockerfile, isolated process and scheduler, and it can be scaled or stopped without touching the API. |
| **D4** | Seeded or live demo dataset? | **Seeded.** After Block A the live path has no admissible dimension, so it cannot support Localize at all. |
| **D5** | Deterministic `event_id` from a metadata hash? | **Not needed for D1 any more**, since the MV approach detects storms without it. Stays a P3 hygiene item for StrictMode double-emission. |
| **D6** | `/funnels` vs Metric Layer | **Metric Layer.** `skills/intelligence-pipeline` rule 1 corrected to match `PIPELINE_CONTRACT.md` §3. |

---

## 4. Sequencing, and why this order

Four gates. The ordering is not arbitrary — each one removes a class of silent wrongness that
would otherwise be baked into everything built after it.

| Gate | Theme | Why it must precede the next |
|---|---|---|
| **P0** | The numbers mean something | Time, taxonomy and fabrication all change *what a number is*. Any baseline, band or contribution computed before these is computed in the wrong units and has to be thrown away. |
| **P1** | The layer has somewhere to write and something to gate on | Migration runner, watermark, dedup decision, dataset. Without these the first stage has no table, no reproducibility and no defect to catch. |
| **P2** | Entitlement is real | Personas and the zero-leak gate. Independent of P0/P1, so it can run in parallel, but it gates scenario 5 and the Definition of Done. |
| **P3** | It will survive a demo | Worker eviction, client leaks, `--reload`, hygiene. None of it changes a number; all of it decides whether a two-hour demo stays up. |

**P0 has no parallelism worth exploiting.** Its seven tasks are ordered by dependency:
time before windows, canonicalisation before anything that reads a name, markers before any
contract is discovered.

---

## 5. Explicitly out of scope

Stated so nobody re-derives them as gaps:

- **Secret rotation.** The committed Supabase credentials, `NEXTAUTH_SECRET` and
  `CLICKHOUSE_PASSWORD` are flagged, not fixed. `CLAUDE.md` puts this in Phase 2.
- **Anything on the Phase 2 Deferred list** in `docs/PHASE_1.md`.
- **Rewriting the worker.** It is correct. The three findings against it (WK-1..3) are narrow and
  sit in P3.
- **A new orchestrator, scheduler or datastore.** `PIPELINE_CONTRACT.md` §2's existing
  `asyncio.create_task` pattern is real and correct; reuse it.
- **The nine stages themselves.** They are the build, not the remediation — see
  `docs/INTELLIGENCE_LAYER_PROPOSAL.md` and the Phase 1 half of `docs/TASK.md`.

---

## 6. Risks

| Risk | Containment |
|---|---|
| **Canonicalisation at ingest breaks existing dashboards.** Every endpoint reads names by literal string. | Store *both* columns; migrate readers one endpoint at a time; keep `canonicalize_event_name` importable during the transition so a missed call site degrades to today's behaviour rather than to empty. |
| **Backfilling `event_name_canonical` over historic rows is expensive or lossy.** | Accept a cut-over date. Rows before it keep raw-only; the Metric Layer reports the boundary rather than silently mixing two vocabularies. |
| **Stopping the `action` → `success` coercion moves every number at once.** | That is the point, and it is why it is a P0 task rather than a later one. Re-run `verify_data_quality.py` and re-baseline before anything is compared against history. |
| **After Block A the live path has no localizable dimension, and the demo looks thinner.** | Declared here, not discovered at demo time. The seeded path carries the scenarios; the live path demonstrates the refusal, which is itself the stronger claim. |
| **The remediation slips and the layer waits.** | The Metric Layer stub (`INTELLIGENCE_LAYER_PROPOSAL.md` §6) lets every stage be built and tested against known numbers, so only final wiring blocks — not the whole programme. |
| **A "done" claim drifts from reality again.** This has happened twice, and is why `FOUNDATION_STATUS.md` exists. | Every task in `docs/TASK.md` carries a verification command that proves it. A task with no command is not done. |
