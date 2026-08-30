# FOUNDATION_STATUS.md

What has been fixed in the data path, what it was verified against, and what is still missing
before `docs/PHASE_1.md`'s nine stages can be built.

Last updated: 2026-08-29, after Gates P0 and P1 closed.

Read this before re-doing any Foundation work. Several items in this repo were recorded as
`resolved` while still being completely inert — the section "Fixes that were recorded as done
but were not" exists so that does not happen again.

**It happened again, in this file's own neighbours — and then it happened in reverse.** The
2026-08-28 audit checked six claims across the status documents by running the code and found all
six false or stale (`docs/INTELLIGENCE_LAYER_PREREQUISITES.md` §2). Gates P0 and P1 then closed most
of them, and this file went stale in the opposite direction: it recorded as *missing* several things
that had shipped. Both failure modes are the same one — a status column nobody re-ran.

The one finding from that audit that still stands here:

- **There are two live producer paths, not three.** `nexaTracker.track()` in
  `NexaBank/frontend/lib/tracker.ts` has no call site, and `analytics-dashboard`'s tracker is
  imported by nothing. Live geo/device is the `eventTracker.ts` per-session dice roll unless
  `POST /events/location` supplied a real value, in which case `sessionProfile.realCountry` wins.

---

## Status at a glance

| Area | State |
|---|---|
| FOUNDATION-1 `event_id` | done, verified end to end including replay |
| FOUNDATION-2 `session_id` + session-invariant dimensions | done, verified on the live path — but see the caveat below the table |
| FOUNDATION-3 taxonomy remaps | done, all 10 contracts reach every lineage event on both paths |
| FOUNDATION-4 rollup `uniqExactState` | done for `event_count` **and** `unique_users` (P0-6); `raw_rows` added alongside (D1) |
| Signal Store tables | applied to the running instance (P1-3), via `storage/migrate.py` (P1-2) |
| Kafka → worker → ClickHouse | running; had never carried an event before |
| Metric layer (the doorway stages read through) | built — `api/intelligence/metrics.py`, with a `StubMetricLayer` twin |
| Contract loader | built — `api/intelligence/contracts.py`, Tier 0 discovery + Tier 1 declared |
| Personas | built (P2-3) in `rbac.json` and `api/intelligence/personas.py`; **the identity they resolve from is still caller-asserted** |
| `_simulated` marker | on the wire (P0-8), and read by discovery, `validate()` and `sliceable_dimensions` |
| Canonical event name at rest | `events_raw.event_name_canonical`, written at ingest (P0-6) |
| `investigations` ingest watermark | `watermark_ingested_at` (P1-4) |
| Dashboard / NexaBank UIs | verified — 12 Playwright specs green against :3001, see `docs/HANDOFF.md` §1 |

**Caveat on FOUNDATION-2.** It made the dimensions session-*invariant*, which is what makes ratio
localization additive. It did not make them *informative*: `selectGeoProfile`/`selectDevice` still
pick `location`, `city`, `continent`, `device_type` and `channel` at random, once per session.
Session-invariant randomness is still randomness — and it passes an invariance test cleanly, which
is why the `_simulated` marker rather than the invariance test is the load-bearing gate.
`sliceable_dimensions` now refuses a marked key on any dataset but `seeded`.

**Caveat on the `dedup_integrity` invariant — resolved by D1.** `events_raw` is
`ReplacingMergeTree(_inserted_at)` ordered by `(tenant_id, event_name, timestamp, event_id)`, so a
real worker replay is collapsed by a background merge and `count() == uniqExact(event_id)` becomes
true again. The check therefore no longer reads `events_raw`: it compares
`sumMerge(raw_rows)` against `uniqExactMerge(event_count)` in `daily_feature_usage`. An MV fires on
the *inserted block* and never sees post-merge state, so a replay raises `raw_rows` while distinct
ids stay flat. The fixture emits byte-identical duplicates (P1-5). See `docs/PROPOSAL.md` §3 D1.

Re-assert the data claims rather than trusting this table:

```bash
docker compose --profile test run --rm -e CLICKHOUSE_URL=http://clickhouse:8123 \n  tests python scripts/verify_data_quality.py     # exit 0 only when every check passes
```

The emitted check count is **not fixed** — several `record()` calls sit inside loops over the
contract set and its declared dimensions, so it grows with `contracts/*.yaml`. Earlier versions of
this file and of `CLAUDE.md` quoted 18 and 16 respectively; neither was a stable number. Judge the
exit code, not a count.

---

## How to verify

`scripts/verify_data_quality.py` runs in the **`tests` service** with the stack up (it also still
runs on the host). It needs `node`, `requests` and `PyYAML` — deliberately no ClickHouse driver, so
it talks to ClickHouse over the HTTP interface and can run where the driver is not installed. Pass
`CLICKHOUSE_URL=http://clickhouse:8123`; the default is `localhost`, which inside a container is the
container itself.

> **It cannot currently exit 0, for a reason unrelated to data quality.** The `DIMS ... declared
> dimensions populated` check looks for every contract dimension as a **metadata key in
> `events_raw`**. The seven retail contracts declare **fact-table columns** (`region`,
> `branch_code`, `txn_type`, `account_type`, ...), which are not in `events_raw` at all, so they
> fail by construction. The check predates fact-based contracts and needs to branch on
> `Contract.is_fact_based`. Until it does, read the check list, not the exit code.

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
session, and per-event re-rolling is the FOUNDATION-2 bug. Measured on 110 console sessions: zero
carry two values of `location`, `device_type` or `continent`.

**It now declares what it invented** (2026-08-30). Every console event carries
`metadata._simulated` listing the dimensions it generated, and `response_time_ms` with them — it is
a log-normal draw, not a measurement. Before this the console supplied those keys itself and
`eventTracker` read "the caller supplied the key" as "a real signal supplied it", so console geo
reached `events_raw` indistinguishable from measured geo and the Avg Response Time honesty badge
could not fire.

**A forced mix value is excluded from that list, and only it.** When an operator forces
`deviceWeights` / `countryWeights` / `channelWeights`, that dimension carries the intent the
movement is meant to concentrate in — which is exactly what Localize has to be allowed to recover.
Anything unforced stays a weighted dice roll and stays declared. A forced country also re-resolves
its city and continent from the same city table, so the three agree; patching only `location` left
sessions reporting India from a North American city, and `continent` is a declared dimension, so
that cell was not merely generated, it was wrong.

`loan_approval_volume`'s numerator previously had no source on this path at all: the route
created applications but never approved one. It now emits approvals at a controllable rate.

### Two modes, and why the slow one is slow

`POST /events/simulate` takes `mode: "slow" | "fast"`, surfaced as a toggle on `/admin/simulate`.

**Slow mode** is the default and the one that proves anything: every row goes to Postgres, then
through `POST /events` → Kafka → worker → ClickHouse. Its cost is not the pipeline. Postgres is
**remote** (`aws-1-ap-south-1`, measured **~350 ms per round trip**) while every other component is
a local container (ingestion 17 ms). A run is therefore almost entirely time spent waiting on a
network, linear in users x days.

Three changes took 3 users x 7 days from **54.7 s to 11.5 s**, and 25 x 21 from *failing after
~23 minutes* to **82.8 s**:

| Change | Why it mattered |
|---|---|
| `trackEventsBatch` — one `createMany` per user instead of one insert per event | Events were the bulk of the round trips. `event_id` is minted in the app rather than by the database default, because `createMany` cannot return generated ids and forwarding needs one |
| Bounded concurrency across users (`SIMULATE_CONCURRENCY`, default 6) | Users are independent and the work is waiting. The cap is what keeps the Supabase pooler from closing a long run — that is what killed 25 x 21 |
| Hash the demo password once; drop 8 redundant balance writes; payee pass reads memory | Each was a remote round trip buying nothing. The payee pass re-read customers and accounts this same request had created seconds earlier |

Concurrency required one correctness change: the journey model is built **per user**, not per
request. It carries mutable per-session state, so one shared instance would let concurrent users
satisfy each other's prerequisites and suppress each other's back-fills.

**Fast mode** (`api/fast_seed.py`) skips Postgres *and* the ingestion path and writes the analytics
tables directly — `events_raw` plus `fact_transactions`, `fact_account_openings`, `fact_cards`,
`fact_loan_applications`, `fact_campaign_interactions` and `dim_customer`, so **all ten KPIs
compute from a single run**. Measured: **2,000 users x 45 days = 73,571 rows in 3.0 s**
(~24,600 rows/sec), against hours for the same shape through the pipeline.

It is safe for one reason only: operator-triggered mock data, never a real record. `POST /events`
remains the only door for anything real. What it costs you: no Postgres rows, so those customers
do not exist in the NexaBank UI and the extract has nothing to ship for them; and the ingestion
path is not exercised, which is precisely what slow mode is for. `purge_first` clears anything a
previous fast run wrote, by id prefix.

It lives in the **ingestion service**, not NexaBank: the bank has no ClickHouse client and must not
grow one, and ingestion already owns writing `events_raw` directly on its fallback path. Geography
is read from `dim_branch` rather than redefined, so fast mode cannot drift into a second
geography the way the reference data once did.

The UI warns before a slow run only when the estimate exceeds a minute, and separately above five
minutes where the pooler starts dropping connections. A warning on every run is one nobody reads.

### The journey model

`NexaBank/backend/src/helper/journeyModel.ts`. The generator emits ~40 raw event names, and
whether one is *allowed to occur* depends on what the session has already done: KYC has to start
before it completes, a loan has to be applied for before it can be approved, a pro feature has to
be reached before it can be used. That ordering used to live implicitly in the generator's control
flow. It is now data, so it can be reasoned about and extended.

It is deliberately **not** a fourth taxonomy dialect (CLAUDE.md coupling point 2). It maps each raw
name to the canonical name Phase 0 verified it resolves to, plus its route and place in the graph,
and is an internal concern of the generator — no contract with ingest or the read layer.

**Two kinds of edge, and only one carries volume.**

| | `FUNNEL_PREREQS` | `CONTEXT_PREREQS` |
|---|---|---|
| Declared how | hand-listed; domain knowledge a name cannot express | rule-derived, so a new event inheriting the taxonomy gets sensible ones free |
| Examples | `approved ← applied ← kyc_completed ← kyc_started`, `unlock ← view` | every non-entry event needs a login or register; a pro-gated event needs the pro area reached; a failure needs its sibling `*.view` |
| Enforced | yes | yes |
| Propagates traffic | **yes** — raising a funnel endpoint raises every step feeding it | no, gate only |
| Satisfied by | the exact prerequisite | **any-of** a group |

**Missing prerequisites are back-filled, and nothing marks them.** `planBackfill` emits the missing
steps as ordinary events — real `event_id`, real row — immediately before the event that needed
them, then marks them satisfied so a sibling does not re-emit them. Two consequences worth holding:
the event count a run produces is not the count it rolled, and a funnel step can appear that the
generator never explicitly decided to emit. That is the correct behaviour for keeping a session a
valid journey, but it means "how many kyc_started did the run intend?" is not answerable from the
data.

**Per-route and per-event knobs.** `behavior.targets` carries a `traffic` and a `failure`
multiplier per route or event, validated against the real vocabulary — an identifier the generator
cannot produce is **dropped, not coerced**. Two details that surprise:

- A directly-targeted event with `traffic > 1` can be **introduced** from a baseline of ~0, floored
  at `INJECT_FLOOR` (0.03). "Generate more traffic through this event" has to be able to create
  `auth.role.violation`, whose base rate is zero. Multipliers that arrive by funnel propagation
  never inject — they only scale what the generator already rolls.
- `relaxJourney: true` turns the safeguard off for targeted routes and events: they may fire
  without prerequisites and stop pulling their funnel with them. It is how an operator produces a
  deliberately inconsistent session; it is not a performance switch.

**`GET /events/simulate/catalog`** (admin only) serves the route and event vocabulary the console's
picker offers, built from this module — so the picker cannot offer an identifier the generator is
unable to emit.

**Still no ground truth.** The journey model writes nothing. Which routes an operator targeted, and
whether the safeguard was relaxed, appear only in the API response echo. Back-filled events are
real events that plausibly happened, and nothing records that they were back-filled.

---

## Not verified

**The LLM narrator's English quality.** Its logic is validated end to end against a scriptable
OpenAI-compatible server (`tests/test_intelligence_llm_narrator.py`) — model discovery, guided-
decoding fallback, a hallucinated figure rejected so the template wins. What a specific model
actually writes needs vLLM, a GPU and an `HF_TOKEN`, and is Gate L (`docs/TASK.md` B-8).

Browser rendering **is** now verified: `tsc --noEmit` is clean for all three TypeScript projects,
and the Playwright suite in `e2e/` covers the dashboard, its RBAC surface, the agent panel and
NexaBank navigation. Note the trap in `docs/HANDOFF.md` §5 — Turbopack does not reliably see writes
through a Windows bind mount, so a frontend change may need
`docker compose restart analytics-dashboard` before it is judged.

---

## What is still missing before the pipeline

**Ten of the twelve items this section used to list are closed.** The metric layer, contract
loader, personas, migration runner, canonical name at rest, `_simulated` marker, ingest watermark
and one-definition-of-a-day all landed in Gates P0 and P1; the demo dataset question was settled as
**seeded** (decision D4) and `scripts/seed_data.py` is the generator. Per-task evidence and the
verification command for each is `docs/TASK.md`.

What is genuinely still open:

1. **Provisional windows are half-implemented.** Contracts declare
   `provisional_window_minutes: 10`, and Trust Gate folds it into the grain-scaled freshness floor
   (`stages/trust_gate.py`). Detect does **not** suppress on a provisional window. This matters
   because the simulation console backdates events — a window can gain rows after it has been
   scored.

2. **`event_id` is not mandatory at every writer.** `api/seed_safexbank.py` still inserts through
   `storage/client.py` with no `event_id`, no `session_id` and no taxonomy pass, which is what
   keeps the legacy `concat('legacy:', ...)` dedup key load-bearing — and that key merges genuinely
   distinct events sharing user, second, name and metadata. (`docs/TASK.md` P1-6)

3. **The identity entitlement resolves from is caller-asserted.** Personas exist and cannot widen
   access, but `RBACMiddleware` still trusts `X-User-Role`/`X-User-Email`/`X-Admin-Apps` and :8001
   is published to the host. (`docs/TASK.md` P2-1, P2-4, P2-5)

**Not a blocker:** the scheduler. `api/intelligence/service.py` guards every iteration inside each
`while True`, so a stage exception cannot silently kill a loop.

---

## Files added

| Path | Purpose |
|---|---|
| `scripts/verify_data_quality.py` | the checks above; count varies with the contract set |
| `scripts/taxonomy_probe.js` | executes the real Node `enforceTaxonomy` |
| `core/event_names.py` | the ingest dialect, importable without pydantic |
| `NexaBank/backend/src/helper/simulationBehavior.ts` | behaviour knobs for the simulate console |
| `NexaBank/frontend/components/admin/BehaviorControls.tsx` | the scenario dropdown |
| `.gitattributes` | forces LF on `*.sh` so container entrypoints keep working |
| `feature_intelligence.events_dead_letter` | worker DLQ table (also in `storage/schema.sql`) |
| `storage/migrate.py` | idempotent migration runner + `schema_migrations` ledger (P1-2) |
| `core/config.py`, `core/security.py` | settings and PII redaction, importable without FastAPI |
| `requirements-dev.txt`, the `tests` compose service | the only image carrying `pytest` |
| `scripts/run_intelligence_gates.py` | the executable Gate D suite |
| `fixtures/planted_truth.json` | recorded ground truth for the five scenarios (P1-9) |
| `e2e/` | Playwright specs + NextAuth JWT minting, and the `e2e` compose service |
| `NexaBank/backend/src/routes/extract*.ts` | the watermarked extract API for sources A, B and C |
| `NexaBank/backend/src/scripts/` | `resetDemoData`, `seedReferenceData`, `generateDemoData`, `applyLifecycle` |
