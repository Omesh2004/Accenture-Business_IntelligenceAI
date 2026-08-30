# CLAUDE.md

Entry point for Claude Code. Read this fully before touching anything.

## What this repo is

FinInsights is a product-analytics platform for multi-tenant fintech software, plus one
demo banking app (NexaBank) that generate its telemetry. One monorepo, five
deployable systems joined by exactly two contracts: an HTTP event envelope (`POST /events`)
and a tenant-id vocabulary. There is no shared library, no shared DB, no shared types.

Deep map: `docs/ARCHITECTURE.md`. Do not rediscover the architecture by grepping; read it first.


## How to work on this repo

Understand -> Plan -> show me the plan -> Implement -> Test -> Verify.
Do not write code before showing a plan for anything beyond a one-file edit. Prefer the
smallest change that satisfies the Phase 1 item. Reuse existing code; this repo already
does most of Phase 1 (funnels, journeys, sessions, retention, AI report all exist).

**This file carries no work items.** What to do is `docs/TASK.md`; why it is shaped that way,
and the six open decisions, is `docs/PROPOSAL.md`. Take the task's ID with you — a task is done
when its verification command passes, not when the edit is written. Report that pass and **ask
before writing it into `docs/TASK.md`** (rule 14).

**If `docs/HANDOFF.md` exists, read it before anything else.** It is a session handoff, not a
standing document: where an in-flight thread stopped, what was decided in conversation rather than
written down, and the environment traps that cost the previous agent time. It carries the running
sequence that `docs/TASK.md` is too coarse to hold. Delete it when its sequence is finished — a
stale handoff is worse than none.

Verify claims about the taxonomy, a canonical event name, or a metric by **running the function**,
not by reading the code. Most of this repo's failures are silent renames, not exceptions.

That applies to this repo's own status documents as much as to its code, and it has failed in both
directions. Six status claims were once checked and found false — the `_simulated` marker recorded
as landed when it did not exist, `docs/ARCHITECTURE.md`'s three live producer paths when only two
emit. Then Gates P0/P1 shipped and the same documents went stale the other way, recording as
missing several things that had landed. The audit of record is
`docs/INTELLIGENCE_LAYER_PREREQUISITES.md` §2; live per-task status is `docs/TASK.md`. Re-run the
check, do not trust either.

## File Operations Policy

Use the dedicated tools for all file operations — never bash equivalents:

- Reading a file → `Read`, never `cat`, `head`, `tail`, `sed -n`
- Searching file contents → `Grep`, never `grep`/`egrep`/`rg` in Bash
- Finding files by name/pattern → `Glob`, never `find`
- Modifying part of an existing file → `Edit`, never `sed -i`, `awk`, or a Python/Node script that opens and rewrites the file
- Creating a new file or fully overwriting one → `Write`, never `cat <<EOF > file` or a script that writes file contents
- Editing Jupyter notebooks → `NotebookEdit`, never manual JSON editing

**Before editing:** always `Read` the file first in this session (even if you edited it earlier and think you remember its contents) — a stale in-memory copy is the main reason `Edit` fails and falls back to `Write` or a script. If a file changed on disk since you last read it, `Read` it again before touching it.

**Bash is still correct for:** package installs, builds, test runners, git operations, and any CLI tool with no dedicated tool equivalent (e.g. `npm install`, `pytest`, `git commit`). Do not use Bash as a substitute for Read/Edit/Write/Glob/Grep just because it's faster to type.

If you catch yourself about to run `cat`, `find`, `grep`, or a file-writing script inside a Bash call, stop and use the dedicated tool instead.

## Key commands

**Run everything through Docker.** `docker compose exec <service> ...` is the default for every
check, query, type-check and script in this repo. Do not reach for `.venv/Scripts/python.exe`,
a host `python`, a host `node`, or `npm run` — the container is the environment the code actually
executes in, and a host venv or a host `node_modules` drifts from it silently. The two genuine
exceptions are named at the bottom of this section, with the reason.

Which service to exec into, and what `/app` contains there:

| Service | Image | `/app` is | Use it for |
|---|---|---|---|
| `analytics-api`, `ingestion-api`, `processor-worker` | `python:3.11-slim` | the repo root **minus** `NexaBank/` and `analytics-dashboard/` (see `.dockerignore`) | anything Python: `api/`, `core/`, `storage/`, `contracts/`, `scripts/`, `tests/` |
| `clickhouse` | `clickhouse-server:24.3` | — | `clickhouse-client`, DDL, ad-hoc queries |
| `broker` | `cp-kafka:7.4.0` | — | topic and consumer-group inspection |
| `nexabank-backend`, `nexabank-frontend` | `node:22-alpine` | that subproject only | `tsc`, `npx`, anything Node in NexaBank |
| `analytics-dashboard` | `node:22-slim` | the dashboard only | `tsc`, `npx` |

- Whole stack: `docker compose up` (dashboard :3001, NexaBank :3002/:5000,
  Ingestion :8000, Analytics API :8001, vLLM :8002, ClickHouse :8123, Kafka :9092).
- **The three Python services bind-mount nothing.** Their source is baked in at build time, so
  editing `api/main.py` on the host changes nothing until you rebuild — `--reload` in their
  compose command is watching files that never change:
  ```bash
  docker compose up -d --build analytics-api      # required after ANY Python edit
  ```
  The three Node services do bind-mount `src`, so their edits are live.
- ClickHouse schema (`storage/schema.sql`) auto-runs ONLY on an empty volume. Applying a
  schema change to a running stack requires manual DDL. See `docs/DATABASE.md`. Pipe a migration
  in with `-T`:
  ```bash
  docker compose exec -T clickhouse clickhouse-client --password clickhouse \
    --multiquery < storage/migrations/2026-08-25_signal_store.sql
  ```
- Query ClickHouse:
  ```bash
  docker compose exec clickhouse clickhouse-client --password clickhouse \
    --database feature_intelligence --query "SELECT count() FROM events_raw"
  ```
- Check what an event really becomes (`/app` is the repo root, so no `sys.path` juggling):
  ```bash
  docker compose exec analytics-api python -c \
    "from api.page_map import canonicalize_event_name as c; print(c('loan.approved.success'))"
  ```
- Type-check a TypeScript project without touching host `node_modules`:
  ```bash
  docker compose exec analytics-dashboard npx tsc --noEmit
  docker compose exec nexabank-backend    npx tsc --noEmit
  docker compose exec nexabank-frontend   npx tsc --noEmit
  ```
- Confirm Kafka is actually carrying events rather than the pipeline silently running on the
  ClickHouse fallback — the failure that hid for the whole of Phase 1:
  ```bash
  docker compose exec broker kafka-consumer-groups --bootstrap-server broker:29092 \
    --describe --group feature-processor-group        # LOG-END-OFFSET 0 => nothing ever arrived
  docker compose logs -f --tail=100 processor-worker
  curl -s localhost:8000/health                        # ingest_path: kafka | clickhouse_fallback
  ```
- Produce a KPI movement to investigate: the admin simulation console at
  NexaBank `/admin/simulate`, or `POST /events/simulate` with a `behavior` block. It records
  **no** ground truth — the movement exists only as the shape of the events. See
  `docs/SCENARIOS.md`.
- Rebuild the whole demo dataset from simulated users. `/events/simulate` is the only generator
  that writes BOTH telemetry and real core-banking rows, so seeding tables directly would produce
  facts with no matching clickstream. The reset preserves ADMIN logins and the three ledger
  accounts (`EXTERNAL-BANK`, `MERCHANT-ID`, `NEXABANK-SYSTEM`); deleting either makes the next
  run fail on a foreign key rather than produce an empty dataset:
  ```bash
  docker compose exec nexabank-backend npx tsx src/scripts/resetDemoData.ts --yes
  docker compose exec nexabank-backend npx tsx src/scripts/seedReferenceData.ts   # sources B and C
  # then truncate feature_intelligence.* and re-seed licences, then:
  docker compose exec nexabank-backend npx tsx src/scripts/generateDemoData.ts
  ```
  `seedReferenceData` must run **before** generation: branches are reference data, and a customer
  created against an empty branch table gets a null branch, which silently removes `region` from
  every KPI that localizes on it. The simulate route refuses with 409 rather than let that happen.
  Then load the three batch sources (this runs in the `intelligence` service, the only one holding
  `EXTRACT_API_TOKEN` — least privilege, so it will 401 from `analytics-api`):
  ```bash
  docker compose run --rm --no-deps -T intelligence python -c     "from api.intelligence import loaders;      print(loaders.load_core_banking()); print(loaders.load_crm());      print(loaders.load_market_ops(['nexabank','safexbank']))"
  ```
  A batch outlives the client's 5-minute header timeout, so the script waits on the database
  rather than the HTTP response. Roughly 20 minutes for ~200 users.
- Run the tests. The `tests` service is the only image carrying `requirements-dev.txt`, so every
  runtime image stays lean. It mounts `api/`, `tests/`, `scripts/` and `contracts/` rather than
  baking them, so a gate that lints source sees the working copy, not a stale build:
  ```bash
  docker compose --profile test run --rm tests
  ```
- Prove the intelligence layer end to end -- determinism, the five scenarios, entitlement,
  multi-source coverage, the read path and idempotency. Exits non-zero on any failure, so it can
  gate a build:
  ```bash
  docker compose stop intelligence   # it sweeps the same tables on a timer
  docker compose --profile test run --rm tests python scripts/run_intelligence_gates.py
  docker compose start intelligence
  ```
  Re-seed first, **into the gate tenants**, or the planted truth will not match:
  ```bash
  docker compose --profile test run --rm tests python scripts/seed_data.py --scenario all     --tenants gate_alpha,gate_beta --realtime-tenant gate_alpha     --users-per-tenant 320 --sessions-per-tenant 700
  ```
  Golden fixtures and demo data **must not share a tenant**. They did, and each diluted the other:
  the planted KYC drop was swamped by simulated traffic, while fixture events polluted the demo
  KPIs. The gates now read their tenant list from `fixtures/planted_truth.json` rather than a
  literal, so wherever the fixture is planted is where they score. `fixtures/` is mounted
  read-write into the `tests` service for the same reason — baked into the image, the seed wrote
  the truth file into a container that was then discarded, and every gate scored the run before.
  The gates truncate and re-sweep the Signal Store, so a running scheduler writes mid-comparison
  and every determinism gate fails for a reason unrelated to determinism. A preflight detects this
  and exits 2 rather than reporting seven misleading failures.
- Apply schema changes. **Baseline an existing database before the first apply** -- running
  historic migrations against an already-migrated schema drops the live materialized view:
  ```bash
  docker compose exec -T ingestion-api python storage/migrate.py --status
  docker compose exec -T ingestion-api python storage/migrate.py
  ```

- Turn the LLM narrator on. It is **off by default and the layer is complete without it** — the
  model only phrases English; every figure is re-checked against the claim set, so an
  unverifiable draft falls back to the deterministic template. Requires an NVIDIA GPU (the
  entrypoint picks Qwen2.5 7B/3B/1.5B AWQ by free VRAM), the NVIDIA Container Toolkit, and an
  `HF_TOKEN` in `.env`. `vllm-server` sits behind a `gpu` profile so it is not started on a
  machine without one:
  ```bash
  # .env: HF_TOKEN=hf_...  and  INTELLIGENCE_LLM=1
  docker compose --profile gpu up -d vllm-server
  curl localhost:8002/v1/models                       # what it actually serves
  docker compose up -d --build intelligence analytics-api
  ```
  No model name is hardcoded anywhere: `INTEL_LLM_MODEL` pins one, empty asks the server. Any
  OpenAI-compatible server works. Confirm it is really in play with
  `SELECT engine_type, count() FROM feature_intelligence.model_runs GROUP BY engine_type`.

**The two commands that used to need the host now run in the `tests` service** (2026-08-30). Both
need `node` *and* NexaBank's source in one place. That was the gap: `NexaBank/` is excluded by
`.dockerignore` from the Python image's build **context**, so it can never be baked in. Closed by
installing `nodejs` under the existing `INSTALL_DEV` flag (dev-only, runtime images stay lean) and
bind-mounting the two source subtrees the checks read:

```bash
docker compose --profile test run --rm -e CLICKHOUSE_URL=http://clickhouse:8123   tests python scripts/verify_data_quality.py
docker compose --profile test run --rm tests   node scripts/taxonomy_probe.js NexaBank/backend/src/middleware/eventTracker.ts names.txt
```

`CLICKHOUSE_URL` must be passed: the script defaults to `localhost:8123`, which inside a container
is the container itself. It still runs on the host unchanged if you prefer.

**Why this mattered more than convenience.** Twelve regression guards keyed on the same two
prerequisites, and pytest reports an unmeetable prerequisite as a **skip** — which reads as green.
Seven taxonomy and identity guards had been passing by not running at all, over source they were
meant to police. The suite went 466 passed / 12 skipped → **478 passed / 0 skipped** with no test
changed. Treat a skip in this repo as a failure until you have read its reason.

## Foundation: the four bugs stages 01-08 stand on — all four now land

Detail, DDL, and the traps each one hid in are in `docs/DATABASE.md`.

1. **`event_id`** — the Postgres `Event.id` UUID that `eventTracker.ts` mints. Do *not* hash
   (source id + sequence + timestamp): there is no source sequence, so it collides.
2. **`session_id`** — carried from the browser via `x-session-id`, and the geo/device profile is
   cached once per session. Session grain is what makes ratio localization additive; this is a
   correctness requirement, not a nicety.
3. **Taxonomy remaps** — all three contracts reach every lineage event on both producer paths.
4. **The rollup** — `event_count AggregateFunction(uniqExact, String)`, read with
   `uniqExactMerge`. Fixes the silent decay of a plain column inside an `AggregatingMergeTree`
   *and* makes counts idempotent under worker replay.

**Do not take that list on trust — it was wrong before.** Fixes 2 and 3 were recorded as
`resolved` in the KPI contracts while both were still inert: the `x-session-id` interceptor was
registered on an axios instance no file imported, and the `LEGACY_MAP` remaps fixed keys the code
never calls. Both failures were silent and neither showed up in any chart.

```bash
python scripts/verify_data_quality.py     # exit 0 only when every check passes
```

It runs the real Node `enforceTaxonomy` by evaluating that function's own source rather than
reimplementing it, so it cannot drift from the dialect it is checking. Run it after touching any
producer, the taxonomy, or the schema.

**What the four fixes do not buy, verified against the code:**

- **Session-invariant is not the same as informative.** `selectGeoProfile`/`selectDevice` in
  `eventTracker.ts` still pick `location`, `city`, `continent`, `device_type` and `channel` at
  random, once per session. FOUNDATION-2 fixed additivity; it did not make the dimension mean
  anything. The envelope now says so — `metadata._simulated` lists the invented keys per event, and
  `contracts.sliceable_dimensions` refuses them outside the seeded dataset.
- **`count() == uniqExact(event_id)` is not merge-stable.** `events_raw` is now
  `ReplacingMergeTree(_inserted_at)` ordered by `(tenant_id, event_name, timestamp, event_id)`, so
  a real worker replay is collapsed by a background merge and the invariant becomes true again.
  The seeded duplicate-storm fixture survives only because it emits its pair one minute apart, so
  the timestamps differ and the merge key does not match.
- **`event_id` is still absent at one writer.** `api/seed_safexbank.py` inserts through
  `storage/client.py` directly with no `event_id`, no `session_id` and no taxonomy pass, which is
  what keeps the legacy `concat('legacy:', ...)` dedup key load-bearing — and that key merges
  genuinely distinct events that share user, second, name and metadata.

## The six coupling points (break one and something silently 404s or vanishes)

Before you touch any of these, read the referenced doc. These are the only places a small
edit has large, non-obvious blast radius.

1. **Event envelope** `core/models.py` (`FeatureEvent`). Contract between 3 producers and the
   pipeline. Changing it touches every producer. Note `validate_event_name` **coerces** rather
   than rejecting — it wraps unknown names as `core.<name>.action`.
2. **Event taxonomy** lives in THREE dialects that disagree on singular/plural
   (`enforceTaxonomy` in Node, `validate_event_name` on ingest, `canonicalize_event_name` on
   read), fed by FOUR naming vocabularies: backend `trackEvent` literals, frontend `track`
   literals, `measureAndTrack` bases, and the seed scripts. Adding or renaming an event without
   updating all three dialects makes it land in `events_raw` but vanish from every chart. Use the
   `event-taxonomy` skill. Running all 110 literal producer names through the real chain resolves
   them to 94 canonical events, and the transit is lossy in ways that change meaning
   (`docs/INTELLIGENCE_LAYER_PREREQUISITES.md` Appendix A has the table):
   - `action` is promoted to `success` on read, so `lending.loan.applied` becomes
     `loan.applied.success` and an attempt is indistinguishable from an outcome. This is the
     vocabulary `kyc_completion_rate` and `loan_approval_volume` are computed in.
   - `failed` (write) and `failure` (read) both exist. `login` and `register` are the pages
     `canonicalize_event_name` has no branch for, so they keep `.failed`.
   - The reserved `free.`/`pro.` prefix is stripped by the Node dialect, so `pro.dashboard.view`
     and `free.dashboard.view` land on one canonical name and the tier is gone.
   - The frontend's `pro-feature.*` names resolve into a `pro_feature.*` namespace disjoint from
     the backend's `crypto-trading.*`/`wealth-management-pro.*`, which are the names
     `contracts/pro_revenue.yaml` counts.
   - `canonicalize_event_name` returns `None` for some valid stored names
     (`pro.features_unlock.success` is one). Every caller must handle it.

   Canonicalisation happens **once at ingest** (P0-6): `events_raw.event_name_canonical` is written
   by `ingestion/main.py` and the MV groups on it, so `daily_feature_usage` is keyed on the
   canonical name and aliases of one feature merge into one row. The read paths no longer
   canonicalise in Python, which is what removed the `max(a, b)` / `+=` disagreement between
   `/features/usage` and `/predictive/adoption`. `canonicalize_event_name` remains the authority
   for the mapping itself.
3. **Tenant vocabulary** four independent maps must agree (`lib/feature-map.ts`,
   `APP_TENANT_SCOPES`/`TENANT_TO_APP`/`KNOWN_TENANTS` in `api/main.py`, `rbac.json`).
   Miss one and the WebSocket closes with 1008 and requests 403.
4. **RBAC header trio** the `lib/api.ts` axios interceptor and `RBACMiddleware` are a matched
   pair. Rename a header on one side and everything 403s.
5. **ClickHouse schema** every analytics endpoint references tables/columns by literal name.
   No compile check: a renamed column is a runtime 500 or a silently empty list. `storage/migrate.py`
   applies `storage/migrations/*.sql` and records each in `schema_migrations` by name and content
   hash — **baseline an existing database before the first apply**, or historic migrations replay
   and drop the live materialized view. `schema.sql` still runs only on an empty volume, so every
   change must land in both places. `daily_feature_usage.unique_users` is now
   `AggregateFunction(uniqExact, String)`, and `raw_rows` counts rows as INSERTED — that pair is
   what `dedup_integrity` reads, because `events_raw` merges duplicates away. The rollup carries no
   session state, so no session-grain ratio can be served from it. See `docs/DATABASE.md`.
6. **Dimension vocabulary and grain** KPI contracts name **physical metadata keys** — there is no
   renaming layer, deliberately. `location` holds a country value; there is no `country` key.
   `channel` is the exception: it is a top-level `events_raw` **column**, not a metadata key, so
   reading it with `JSONExtractString(metadata, 'channel')` returns empty on every row.
   `tier` exists live but not in seeded data. A contract may only localize dimensions that are
   invariant within its `grain.entity`, or contribution shares are meaningless. On the live path
   every one of these dimensions is synthesised per session by `eventTracker.ts`, and
   `metadata._simulated` declares exactly which — that marker, not the invariance test, is the
   load-bearing gate, because a per-session fabrication passes an invariance test cleanly. See
   `docs/KPI_CONTRACT.md`.

## Mandatory rules

1. Do NOT implement Phase 2 items (see the Deferred list in `docs/PHASE_1.md`). If Phase 1
   seems to need one, stop and ask.
2. Specialist libraries are **approved where they earn their place at platform scale**
   (decision, 2026-08-27, superseding the earlier deterministic-only rule). The engine must
   cover every KPI on the platform, not a hand-picked few — see `docs/KPI_CONTRACT.md`,
   "Two tiers of contract". At that scale hand-rolled baselines stop being the conservative
   choice and start being the fragile one.
   - **Approved:** `PyYAML` (contracts), `numpy`/`scipy` (robust statistics),
     `PSqueeze` (Localize, MIT), a time-series foundation model — `Chronos-Bolt` or
     equivalent — for Forecast, and `statsmodels` for classical fallbacks.
   - **Still requires a plan entry (rule 5):** anything else, including `DoWhy`, `CausalImpact`,
     `Evidently`, `Langfuse`, and any new datastore or orchestrator.
   - **Non-negotiable regardless of library:** every method still writes the same row shape and
     carries an `engine_type`, still degrades to a dependency-free fallback when the library or
     GPU is unavailable, and still needs zero training data. A library is an implementation of a
     stage, never a new source of truth.
3. The LLM never produces a number that reaches the user unverified. Every number in a
   narrative must trace to a Signal Store row (numeric verifier). Specialists compute numbers;
   the narrator only phrases them. See the `intelligence-pipeline` skill.
4. Specialists and the agent read data ONLY through the Metric API / metric functions, never
   raw SQL against `events_raw`, and write findings to the Signal Store.
5. Do NOT introduce a new dependency without stating why in the plan.
6. Do NOT change an analytics endpoint's response shape without updating its `lib/api.ts`
   method, its `types/index.ts` type, and every consumer. Watch handlers called internally by
   `/ai_report` and `/admin/app/{id}/summary`.
7. Preserve the "telemetry never blocks banking" rule: forwarding stays fire-and-forget.
8. Tag every produced number with its engine (`llm`/`sql`/`stats`/`ml`/`rule`) so the
   LLM-vs-non-LLM breakdown is real, not narrated.
9. A KPI whose contract `readiness.status` is `blocked` must return `fail:not_instrumented` from
   Trust Gate. Never let it fall through to reading zero and narrating a phantom decline.
10. Every Signal Store row carries `investigation_id`. Do NOT hang the audit trail off
    `anomaly_id` — a Trust Gate failure produces a narrative with no anomaly, and `model_runs`
    rows are written by stages that run before any insight exists. See `docs/DATABASE.md`.
11. Personas (`cfo`/`ops_manager`/`analyst`) live in `rbac.json` (`personas.by_role`, and
    `personas.selectable_by_role` for switching) and in `api/intelligence/personas.py`, which is
    the single source for each persona's intents, recommendation owner roles and metric
    priorities. Resolve a persona server-side; a requested persona is honoured only if the
    caller's ROLE lists it in the allowlist, so it can never widen access. See
    `docs/PIPELINE_CONTRACT.md` §7 and §8b.
    Note the identity a persona would resolve from is itself asserted by the caller:
    `RBACMiddleware` trusts `X-User-Role`/`X-User-Email`/`X-Admin-Apps`, the dashboard's axios
    interceptor sets them from the browser, and :8001 is published to the host. Entitlement
    enforced above an identity anyone can assert is not entitlement.
12. **The intelligence layer is fully deterministic: same rows in, byte-identical Signal Store rows
    out.** Concretely — derive ids, never generate them; pin the window once at the top and never
    call `now()` inside a stage; use `uniqExact`/`quantileExact`/`medianExact`, because ClickHouse's
    `uniq` is HyperLogLog and `quantile` is **reservoir sampling with an RNG** (its own docs say
    "the result is non-deterministic"); give every ranking a unique tiebreaker or rank-1 can flip
    between identical runs; round floats at the write boundary. Model stages achieve this by
    persisting output and re-reading it, not by bit-exact math. See
    `docs/INTELLIGENCE_LAYER_PROPOSAL.md` §1. Both substrate holes are closed:
    `daily_feature_usage.unique_users` is a `uniqExact` state (P0-6), and `investigations` pins
    `watermark_ingested_at` (P1-4) so a backdated write cannot change what a re-run sees.
13. A dimension may not be localized until it is known to be **measured rather than fabricated**.
    Session-invariance makes contributions add up; it does not make them mean anything. Ranked,
    confident, meaningless output is the worst failure mode this system has, because it looks
    correct — Localize will return contributions summing to ~1.0 with an `explained_pct` over
    dice rolls and nothing downstream can tell.
14. **Never edit a `docs/TASK.md` status without asking first.** When a task's verification
    command passes, report the ID, the command and its output, and the status the row should move
    to — then wait for confirmation before touching the row, the Progress table, or the "What is
    still open" prose. The same applies in reverse: a task found broken is a *proposal* to re-open,
    not a re-open. Those status columns are this repo's memory across sessions, and an unconfirmed
    status is exactly how two Foundation fixes were recorded `resolved` while completely inert.
    Never mark a task done on the strength of the edit alone — run the command.

## Never do

- Never delete or merge the duplicate `/insights` route blindly. One def (`api/main.py:566`) is
  the cached LLM variant HTTP callers hit; the other (`api/main.py:3425`) is the rule-based one
  that `/admin/app/{id}/summary` calls by function name. Read the `analytics-endpoint` skill first.
- Never `docker compose down -v` to apply a schema change on anything with data you want.
- Never commit secrets. Note: live Supabase credentials are already committed in
  `scripts/nexbank_user_lookup.py`. Do not add more;
  flag those for rotation, but do not "fix security" as part of Phase 1 (that is Phase 2).
- Never fabricate a metric silently. Response time, geo, and device are synthesised in the
  forwarding layer today; anything derived from them must be labelled simulated in the UI. There
  is **no money field anywhere** in `events_raw`, so every revenue figure is modelled and its
  contract must carry a `simulated:` block.
- Never localize a rate, or a distinct-**user** count. `/funnels` returns user-grain counts, which
  are not additive across dimensions. Localize the contract's additive fundamentals instead.
- Never treat a soft invariant as a hard one. `completed <= started` can break legitimately across
  sessions; that is an abstain, not a quarantine.
- Never use `today()` in new code. It is ClickHouse **server-local**. P0-1..P0-3 pinned the
  container to `TZ=UTC` and replaced all 64 `today()` calls and the three hardcoded
  `+ INTERVAL 330 MINUTE` offsets with `toDate(now('UTC'))`; `grep -c "today()" api/main.py` must
  stay 0. One `today()` reintroduces the split where the KPI card, the traffic chart and
  `daily_feature_usage` bucket into different days.
- Never write a time filter with only a lower bound, and never compare a partial current window
  against a full previous one. `timestamp >= today() - 7` against
  `>= today() - 14 AND < today() - 7` biases every `pct_change` in the codebase upward, growing
  through the day and resetting at midnight. There is also no validator on `FeatureEvent.timestamp`,
  so a client-supplied year-55000 event is counted in every "last N days" window forever.
- Never trust `X-User-Role`, `X-User-Email` or `X-Admin-Apps` as identity, and do not rely on
  `require_tenant_access` — it only enforces in `ON_PREM` mode, so it is a no-op in the CLOUD
  default the stack actually runs.
- Never test against a host `.venv`, a host `node`, or `npm run`. Those environments are not what
  runs in production and drift from the image without warning. Use `docker compose exec` — see
  Key commands for the service map and the two documented exceptions.
- Never assume a Python edit is live because the service runs `--reload`. The three Python
  services bind-mount nothing; their source is baked in at build time, so an edit does nothing
  until `docker compose up -d --build <service>`.
- Never assume a **TypeScript** edit is live either. `analytics-dashboard/src` (Turbopack) and
  `NexaBank/backend/src` (nodemon) do bind-mount, but neither watcher reliably sees a write
  through a Windows bind mount, so the running process keeps serving the old code with no error
  anywhere. `docker compose restart <service>` before judging the change. `tsc --noEmit` passing
  proves the mount is current and proves nothing about the running process — that combination,
  a clean type-check over code that is not running, is what makes this one hard to spot.
- Never state a figure without the unit it was actually measured in. Detect scores an **additive
  fundamental**, never a rate, so `digital_adoption_rate`'s stored `observed` is a count of digital
  transactions — and it was narrated as the rate: "rose 79.6% … to 97.00". The real rate was 1.000
  on every day of that window. The numeric verifier cannot catch this; it checks that a number came
  from a row, not that the row is the quantity the sentence names. Phrase through
  `api/intelligence/phrasing.py`, and see `docs/FinInsights_Bug_Audit.md` §A8.
- Never assume a metric is the metric its name claims. `/tenants/compare` publishes
  `countIf(event_count > 3) / count()` as `conversion_rate`; `/predictive/adoption` publishes a
  heuristic that saturates at ±50% growth as a forecast, with no interval.

## Always do

- Run every check, query, script and type-check through `docker compose exec`, and rebuild the
  Python services after editing them. Verify a claim inside the container that serves it, not on
  the host.
- Canonicalise event names before aggregating (`canonicalize_event_name`).
- Use a fresh ClickHouse client per call (`ClickHouseClient`), `%(name)s` bound params, and the
  standard tenant-filter idiom (see `analytics-endpoint` skill).
- Write new findings to the Signal Store and read them back in the narrator; do not pass raw
  query output into the LLM context.
- Write a `trust_findings` row on every run, including passes — stage 08 audits the suppression
  rate, so an unrecorded pass is as much a hole as an unrecorded failure.
- Keep the three-layer `/ai_report` fallback so a demo never shows a stack trace.
- Handle a `None` return from `canonicalize_event_name`; it is reachable from names that are
  already stored.
- Bound every window at both ends, and give the current and previous windows the same length.
- Apply Signal Store and other DDL by hand against the running instance, then mirror it into both
  `storage/schema.sql` and `storage/migrations/` — there is no runner, and the two have diverged
  before, which cost a fresh volume every insert with no trace.

## Where to find things

| Need to... | Read |
|---|---|
| **Pick up an in-flight thread, and know what the last agent hit** | **`docs/HANDOFF.md`** (if present) |
| **Know what to work on next, and when it counts as done** | **`docs/TASK.md`** |
| **Know why the work is shaped that way, and what is still undecided** | **`docs/PROPOSAL.md`** |
| Know what is already fixed, and what is left before the pipeline | `docs/FOUNDATION_STATUS.md` |
| Know what must change in the existing codebase before the layer is built, and what is the layer's own build | `docs/INTELLIGENCE_LAYER_PREREQUISITES.md` |
| Read the standing repository-wide bug audit | `docs/FinInsights_Bug_Audit.md` |
| Decide how a stored figure should READ (units, cells, windows) | `api/intelligence/phrasing.py`, `docs/PIPELINE_CONTRACT.md` §8c |
| Understand the system | `docs/ARCHITECTURE.md` |
| Know Phase 1 scope / DoD | `docs/PHASE_1.md` |
| Know how the layer gets built, and its determinism guarantee | `docs/INTELLIGENCE_LAYER_PROPOSAL.md` |
| Run or extend a demo scenario | `docs/SCENARIOS.md` |
| Build a stage / know its inputs and outputs | `docs/PIPELINE_CONTRACT.md` |
| Handle a stage's failure modes | `docs/EDGE_CASES.md` |
| Defend a design choice / plan a Phase 2 upgrade | `docs/RESEARCH.md` |
| Read the parked KPI-registry validation design (not scheduled) | `docs/VALIDATION_LAYER.md` |
| Change ClickHouse / add Signal Store tables / Foundation fixes | `docs/DATABASE.md` |
| Define or read a KPI contract | `docs/KPI_CONTRACT.md`, `contracts/*.yaml` |
| Add or rename a tracked event | `skills/event-taxonomy/SKILL.md` |
| Add or change an Analytics API endpoint | `skills/analytics-endpoint/SKILL.md` |
| Build a specialist, the agent, or the narrator | `skills/intelligence-pipeline/SKILL.md` |
| Add a capability the query agent can use | `api/intelligence/tools.py` (one `ToolSpec`; the planner finds it) |
| Change how the agent decides what to call | `api/intelligence/planner.py`, `api/intelligence/loop.py` |
