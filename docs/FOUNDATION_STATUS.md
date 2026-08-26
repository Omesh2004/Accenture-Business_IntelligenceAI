# FOUNDATION_STATUS.md

What has been fixed in the data path, what it was verified against, and what is still missing
before `docs/PHASE_1.md`'s nine stages can be built.

Last updated: 2026-08-26.

Read this before re-doing any Foundation work. Several items in this repo were recorded as
`resolved` while still being completely inert — the section "Fixes that were recorded as done
but were not" exists so that does not happen again.

---

## Status at a glance

| Area | State |
|---|---|
| FOUNDATION-1 `event_id` | done, verified end to end including replay |
| FOUNDATION-2 `session_id` + session-invariant dimensions | done, verified on the live path |
| FOUNDATION-3 taxonomy remaps | done, all 3 contracts reach every lineage event on both paths |
| FOUNDATION-4 rollup `uniqExactState` | done, rollup agrees with `events_raw` |
| Signal Store tables | exist, all 10 empty — no writer yet (that is the pipeline) |
| Kafka → worker → ClickHouse | **now actually running**; had never carried an event before |
| Metric layer (the doorway stages read through) | **not built — critical path** |
| Contract loader | not built (`PyYAML` now declared) |
| Personas | do not exist anywhere |
| Dashboard / NexaBank UIs | **unverified — see "Not verified"** |

Re-assert the data claims rather than trusting this table:

```bash
python scripts/verify_data_quality.py     # 18 checks, exit 0 only when all pass
```

---

## How to verify

`scripts/verify_data_quality.py` runs on the **host** with the stack up. It needs `node`,
`requests` and `PyYAML` — deliberately no ClickHouse driver, so it talks to ClickHouse over the
HTTP interface and can run where the driver is not installed.

It executes the **real** Node `enforceTaxonomy` by extracting and evaluating that function's own
source (`scripts/taxonomy_probe.js`) rather than reimplementing it. A Python port would drift,
and a silently drifting taxonomy dialect is the failure mode `CLAUDE.md` coupling point 2 warns
about. For the same reason the ingest dialect was moved into `core/event_names.py`, which
`core/models.py` now delegates to — one implementation, exercisable without pydantic.

| Check | Asserts |
|---|---|
| `TAXONOMY` | every contract lineage event is reachable from both producer paths |
| `IDENTITY` | `event_id` and `session_id` populated on every row |
| `SESSIONS` | no `server-<uuid>` fallback ids; events per session well above 1 |
| `DUPES` | no identical (event_name, user_id, timestamp) repeats |
| `DIMS` | contract dimensions populated, and session-invariant where the contract localizes on them |
| `LANDED` | rows carrying each fundamental actually exist, canonicalized as a reader sees them |
| `ROLLUP` | `daily_feature_usage` agrees with `events_raw` |

`VERIFY_SINCE='YYYY-MM-DD HH:MM:SS'` scopes to newer telemetry. **Caveat:** it filters on event
time, not write time, and the simulation console backdates events across its history window — so
a wall-clock cutoff also sweeps in backdated simulated events. Treat it as "events dated after
X", not "rows written after X".

---

## Fixes that were recorded as done but were not

This is the most useful section in the file. Both of these were marked `resolved` in
`contracts/*.yaml` while being entirely non-functional, and neither produced an error anywhere.

### `session_id` was never leaving the browser

The `x-session-id` interceptor was registered on an `apiClient` axios instance that **no file
imported** — all 56 call sites used the bare `axios` default. So the header was never sent,
`getSessionId()` fell through to a fresh `server-<uuid>` per event, and because
`getSessionProfile()` is keyed on `session_id`, the per-session geo/device cache never hit
either. One unused import made two Foundation fixes inert at once.

| | events | sessions | events/session | locations | devices |
|---|---|---|---|---|---|
| before | 41 | 41 | 1.00 | 10 | 4 |
| after | 5 | 1 | 5.00 | 1 | 1 |

Fixed by also registering the interceptor on the global axios default, scoped to first-party
hosts — `useGeoLocation` calls `nominatim` and `ipapi`, and a session id must not leak there.

### The `LEGACY_MAP` remaps fixed keys the code never calls

`pro_revenue` reached **1 of its 7** lineage events. `proController.ts` emits dotted names
(`pro.crypto-trading.trade_execute`, `pro.payroll-pro.batch_process`,
`pro.finance-library.book_access`) which are already 3-part and therefore skip `LEGACY_MAP`
entirely. The one event that did work only did so because it was emitted a second time as an
explicit legacy duplicate.

Fixed by aligning the producers to the underscore vocabulary `scripts/seed_data.py` already
uses, verified to survive both dialects unchanged. Two defects surfaced underneath:

- **Outcome was being erased.** Five of seven `trade_execute` call sites are error paths, but
  all seven collapsed onto one canonical name, with success/failure surviving only in metadata
  that no KPI reads. Renaming without checking would have counted failed trades as revenue
  conversions. Event names now branch on outcome.
- **Deliberate duplicate emissions.** Three call sites re-fired a conversion under a second
  "legacy backward compat" name. Harmless while the primary name was broken; double-counting
  the moment it was fixed, since the aggregation is `uniqExact(event_id)` and each call mints
  its own id. Removed.

Now 7/7 on both paths.

---

## Other defects found and fixed

**`/funnels` was reading zero.** `expand_step_aliases` consulted only the hand-maintained alias
*dict*, but `canonicalize_event_name` also collapses names by **rule** — `loan.kyc_started.action`,
what the producer actually writes, has no dict entry. The endpoint searched for names nothing
emits. This is the endpoint `kyc_completion_rate` names in its `lineage`. Now data-driven:
36 → 13 (63.9% drop-off) instead of 0 → 0.

**Kafka had never carried a single event.** `ingestion/main.py` connected once in its lifespan
handler, lost the startup race with the broker (`depends_on` had no `condition:
service_healthy`), set `producer = None`, and never retried. Because the process never crashed,
`restart: unless-stopped` never fired. `feature-events` sat at LOG-END-OFFSET 0 and
`processing/worker.py` — batching, manual offset commits, at-least-once delivery — had never
executed. Fixed with a lazy self-healing producer plus a broker healthcheck. `GET /health` now
reports `ingest_path`; if it says `clickhouse_fallback`, the worker is idle.

**Tracking toggles were a no-op.** The dashboard writes toggles keyed on the **canonical** name;
ingest looked up the **raw** post-validate name. They never coincide, so disabling a feature in
the admin UI did nothing. This also silently disabled a documented Trust Gate signal —
`pro_revenue`'s `tracking_disabled` fingerprint is "ingestion 403 rate > 0", which could never
fire. Now cached with a short TTL and matched against both vocabularies.

**Geo was not session-invariant.** `location: metadata.country || geo.country` let events
carrying a real country diverge from siblings falling back to the session's simulated one — one
observed session carried `['', 'India', 'Germany']`. Geo is now resolved once per session and
never revised; late-arriving real geo is deliberately discarded, because a dimension that flips
mid-session breaks the contract's additivity.

**`channel` is not localizable at session grain.** 99 of 511 sessions carried two values,
because payment events pass their own `channel`. That is legitimate, so `channel` was moved to
`excluded` in the session-grain contract. The event-grain contracts keep it.

**Double-fired page views.** `track` was a `useCallback` over `[toggles]`; `toggles` starts `{}`
and is replaced when it resolves, changing `track`'s identity and re-running every
`useEffect(..., [track])`. Each duplicate carries its own `event_id`, so `uniqExact` cannot
collapse it — a genuine 2× on every live count. Fixed with a ref plus a short dedupe window.
`/events/location` was deduped separately with a ref.

**The dashboard did not compile.** 16 pre-existing type errors from commit `241cc05`, with no
`ignoreBuildErrors` — `next build` failed. Fixed by aligning pages to their own types rather
than adding alias fields.

**Worker robustness.** It now retries with backoff, applies backpressure instead of growing the
batch unbounded during a sink outage, and parks individually-failing rows in
`events_dead_letter`. It probes ClickHouse with `SELECT 1` to distinguish "sink is down — hold
and replay" from "this batch is malformed — dead-letter it", so a lone poison message on an
idle partition cannot stall the partition.

**Hygiene.** All 12 deprecated `utcnow()`/`utcfromtimestamp()` calls replaced with
behaviour-preserving equivalents (kept naive-UTC, so stored values are unchanged);
`daily_feature_usage_old` dropped; `PyYAML` declared in `requirements.txt` (it was not even
transitive — `pip show` reported `Required-by:` empty); `vllm_entrypoint.sh` converted from CRLF
to LF with a `.gitattributes` to stop it recurring — the CRLF made bash fail with `$'\r':
command not found` and the model server restart-looped.

---

## Traps worth knowing

**Deletes on `events_raw` silently desynchronize the rollup.** An `ALTER TABLE ... DELETE`
removes rows but leaves their `event_id`s inside `daily_feature_usage`'s `uniqExact` aggregate
state. Observed: deleting 11 rows left `events_raw` at 2041 and the rollup at 2052, permanently.
The rebuild procedure is in `docs/DATABASE.md`; the `ROLLUP` check catches it.

**Reserved event-name prefixes resolve differently per path.** The Node dialect strips
`free`/`pro`/`core`/`enterprise`/`lending`; the Python dialect preserves them. `pro.new_feature.view`
is the one live case, aliased in `api/page_map.py`. Prefer a first segment that is not a
reserved prefix.

**`channel` is a column, not a metadata key.** Every other contract dimension is read with
`JSONExtractString(metadata, ...)`; reading `channel` that way returns empty on every row.

---

## The simulation console

`POST /events/simulate` accepts a `behavior` block
(`NexaBank/backend/src/helper/simulationBehavior.ts`), surfaced as a dropdown on
NexaBank `/admin/simulate`. Eleven scenarios covering KYC funnel rates, loan approval rates,
segment mix, and pro conversion/errors.

**It records no ground truth.** No table, no fixture, no metadata flag says a movement was
introduced — the movement exists only as the shape of the events, so the intelligence layer has
to infer it rather than look it up. The API response echoes the applied behaviour to the
operator's screen and is never persisted.

Two properties make a movement detectable and both are exposed: a **window** (the change applies
to the last N days; earlier days run at baseline, so there is something to measure against) and
a **segment** (confine it to e.g. mobile traffic from India, so the movement concentrates in a
cell localization can recover).

Mix overrides apply per **session**, not per event — the contract requires invariance *within* a
session, and per-event re-rolling is the FOUNDATION-2 bug.

`loan_approval_volume`'s numerator previously had no source on this path at all: the route
created applications but never approved one. It now emits approvals at a controllable rate.

---

## Not verified

**Neither Next.js UI has been confirmed to render.** Everything above is backend, API, and
compiler evidence. `tsc --noEmit` passes for the analytics dashboard, NexaBank frontend and
NexaBank backend, but a type-clean change can still throw at runtime, and no page was loaded in
a browser. Files edited that both apps load at runtime: `lib/api.ts`, `useEventTracker.ts`,
`useGeoLocation.ts`, `UserContext.tsx`, the simulate page, `KPICard.tsx`,
`transparency/page.tsx`, `useRealtimeEvents.ts`.

At the time of writing there is an open report that `localhost:3001` and `localhost:3002` are
unreachable, not yet diagnosed.

---

## What is still missing before the pipeline

These are Stage 00 substrate items, not pipeline stages.

1. **The metric layer — critical path.** `docs/PIPELINE_CONTRACT.md` §3: *"Localize must not
   receive raw rows. It receives a `dict[cell_tuple, (numerator, denominator)]` already
   aggregated by the metric layer."* With rule 4, every stage reads through this doorway.
   Nothing provides it — `/funnels` is user-grain, which its own contract lineage note says is
   display-only. Stages 01–06 have nothing to read through until this exists.

2. **Contract loader.** Stages take "the loaded contract" in their `ctx`. `PyYAML` is declared;
   the loader is not written.

3. **The dataset is too thin to exercise the pipeline.** 28 days of history satisfies
   `min_history_days: 14`, but daily KYC denominators run 1–6 sessions against a contract floor
   of `min_denominator: 30`. Detect would abstain on every window and no scenario could fire.
   Either 100-user simulate runs (~20 min each, Postgres-bound) or `scripts/seed_data.py`, which
   posts straight to ingestion and generates thousands of events in seconds. Decide which is the
   demo dataset before building Detect against it.

4. **Personas do not exist.** `cfo`/`ops_manager`/`analyst` appear nowhere — not in `rbac.json`,
   not in `api/main.py`. Rule 11 requires resolving them server-side, with a persona query
   parameter never widening access. Scenario 5 is entirely blocked on this.

5. **Provisional windows.** All three contracts declare `provisional_window_minutes: 10`;
   nothing implements it. This matters more than it looks because the simulation console
   backdates events — a window can gain rows after it has been scored.

**Not a blocker:** the scheduling pattern `docs/PIPELINE_CONTRACT.md` §2 says to reuse is real
and correct — `start_data_layer_refresh` guards every iteration inside its `while True`, so
copying it will not silently kill the task.

---

## Files added

| Path | Purpose |
|---|---|
| `scripts/verify_data_quality.py` | the 18 checks above |
| `scripts/taxonomy_probe.js` | executes the real Node `enforceTaxonomy` |
| `core/event_names.py` | the ingest dialect, importable without pydantic |
| `NexaBank/backend/src/helper/simulationBehavior.ts` | behaviour knobs for the simulate console |
| `NexaBank/frontend/components/admin/BehaviorControls.tsx` | the scenario dropdown |
| `.gitattributes` | forces LF on `*.sh` so container entrypoints keep working |
| `feature_intelligence.events_dead_letter` | worker DLQ table (also in `storage/schema.sql`) |
