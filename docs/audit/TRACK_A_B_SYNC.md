# Track A ⇄ Track B sync

**For:** whoever is building Track A (`NexaBank/` — the data source: banking domain, event
tracking + taxonomy, the Simulate panel, ground-truth fixtures).

**From:** Track B (`ingestion/`, `pipeline/`, `warehouse/`, `api/` — ingestion, the
bronze/silver/gold warehouse, the Metric API).

**Why:** A and B are being rebuilt in parallel for the Round 2 brief (`CLAUDE.md` +
`docs/SOLUTION.md` etc.). Track C (the intelligence layer) comes after both land. A and B meet at
exactly four interfaces and a handful of coordinated deletions. This doc is the contract between
us so neither side blocks the other.

Track B's full plan: [`TRACK_B_PHASED_PLAN.md`](TRACK_B_PHASED_PLAN.md). You only need this file.

---

## 1. TL;DR — what Track A needs to do

| # | Change | Rendezvous with Track B phase | Blocking? |
|---|---|---|---|
| A1 | Stop coercing unknown event names in `enforceTaxonomy` — send the raw instrumented name | Phase 2/3 | No (defeats a goal if late, doesn't break anything) |
| A2 | Keep emitting `metadata._simulated` on every forwarded event (already done) | Phase 3 | Yes — silently breaks the fabricated-dimension guard if dropped |
| A3 | Fix the *source* of fabricated dims: derive geo from the customer's branch, device from the real user-agent (`CLAUDE.md` / `DATA_MODEL.md` P3) | Any time; nice-to-have | No |
| ~~A4~~ | ~~keyset params on `/api/extract/accounts`~~ — **cancelled**: Track B decided signups is clickstream-sourced (D2), so that endpoint is unused | — | — |
| A5 | Decide + possibly expose fee schedule + calendar as extract endpoints (Track B default: NexaBank owns them) | Phase 0 decision, Phase 3 build | No |
| A6 | Make the Simulate console write a ground-truth fixture (`CLAUDE.md` §4) | Phase 7 | No (only `scripts/seed_data.py` scenarios are checkable without it) |
| A7 | Drop the `bank_b` / `safexbank` tenant everywhere | Phase 6 | No |
| A8 | Remove the `/events/toggles/*` bridge + `enforceTaxonomy` toggle enforcement | Phase 5 (coordinated) | Yes — coordinated, must land together |
| A9 | Decide fate of `/events/location`, `/events/admin/locations`, `userLocation` | Phase 5 | No |
| A10 | Re-point the Simulate console's **fast mode** — it stays, but `POST /events/seed/fast` moves off ingestion to `POST /dev/seed` on the pipeline service (built Phase 3) | Phase 3 (coordinated) | Yes — fast simulate breaks if not re-pointed |
| A11 | Note which `/api/extract/*` endpoints Track B will stop calling — delete or leave dormant | Phase 3 | No |

Details below.

---

## 2. Frozen interface #1 — the event envelope

**What NexaBank POSTs to `http://ingestion-api:8000/events`** (from `eventTracker.ts` →
`forwardToIngestionAPI`). This shape is **frozen** for Round 2. Do not add, rename, or drop a
top-level field without Track B sign-off.

```jsonc
{
  "event_id":   "uuid",              // REQUIRED, stable, non-empty. NexaBank Postgres Event.id.
  "session_id": "sess_...",          // REQUIRED for session-grain KPIs. Producer-minted, stable per session.
  "event_name": "loan.kyc_started.success",  // the RAW instrumented name — see #4
  "tenant_id":  "nexabank",          // analytics tenant (not the Prisma bank_a)
  "user_id":    "<sha256 hash>",     // hashed customer id, or anon_<hash(session)>
  "timestamp":  1725100000.0,        // unix SECONDS (float)
  "channel":    "web",               // web | mobile | api | batch
  "metadata": {
    "session_id":   "sess_...",      // duplicated into metadata, keep
    "device_type":  "mobile",
    "location":     "India",         // COUNTRY value (name is legacy debt — do not "fix" to a country code)
    "continent":    "Asia",
    "city":         "Mumbai",
    "channel":      "mobile",
    "campaign":     "kyc_reactivation",   // when applicable
    "response_time_ms": 55,
    "_simulated":   ["location","city","continent","device_type","channel","response_time_ms"],
    "role":         "user",
    "tier":         "free",
    "path":         "/loans"         // cosmetic (dashboard); OK to keep
    // ... any other instrumentation keys are fine, they ride into bronze verbatim
  }
}
```

**Changes from today:**
- **Drop `schema_version`.** Track B removes it from the envelope model. Sending it is harmless
  (ignored) but stop bothering.
- **`event_name` is now the RAW name** — see #4.

**What Track B does with it:** writes the whole thing verbatim (including the exact JSON body as
`_raw`) into `bronze.events`. Nothing is rejected on the ingestion side except a malformed
envelope (missing `event_id`, out-of-range `timestamp`, non-string `event_name`).

---

## 3. Frozen interface #2 — the extract API

**`GET /api/extract/{entity}`** on the NexaBank backend, `x-extract-token` header, keyset
pagination `?since=<iso>&since_id=<id>&limit=<n>` (or `?offset=` for `customers`). Response:
`{ entity, count, watermark, cursor_id, has_more, records: [...] }`.

This contract is **good as-is** — watermarked, keyset-exact, token-guarded. **Frozen.** Track B
moves to landing every record in `bronze.core_banking` (raw JSON kept) before deriving silver
facts, but that is invisible to NexaBank.

**Entities Track B will consume for the 5-KPI chain:**

| Entity | Feeds | Keep? |
|---|---|---|
| `transactions` | revenue, transaction-failure cross-check | **yes** |
| `loan_applications` | loan approval volume, KYC cross-check | **yes** |
| `customers` | segment dimensions (risk_segment, age/income bracket) | **yes** |
| `campaigns` | abstain scenario (real campaign vs suspected glitch) | **yes** |
| `branches` | segment dimensions (region, country, city) | **yes** |
| `accounts` | ~~signups~~ — **not used**: Track B decided signups is clickstream-sourced (D2) | **drop** |
| `cards` | card activations — **not in the 5-KPI chain** | **drop unless Track C asks** |
| `campaign_interactions` | CPA — **not in the chain** | **drop unless Track C asks** |
| `macro_environment` | external rate driver — **not in the chain** | **drop unless Track C asks** |

**A4 — cancelled.** Track B decided signups is a clickstream count (`register.auth.success`), not a
banking-record count, so `/api/extract/accounts` is not consumed and needs no keyset fix. You may
delete that handler too.

**A5 — decision needed:** fee schedule (`dim_fee_schedule`) and calendar (`dim_calendar`) are
**currently synthesised by Track B** (`api/intelligence/loaders.py::seed_reference_data`). Revenue
decomposition (D1) needs the fee schedule. **Track B's default is NexaBank owns them** — if you
don't object in Phase 0, that's the plan:
- **(default)** NexaBank owns them as "source 3 / reference data": add
  `GET /api/extract/fee_schedule` and `GET /api/extract/calendar` (you already have
  `seedReferenceData.ts` generating similar data). Cleaner story, matches `CLAUDE.md` §6's
  "different cadences".
- **(fallback)** Track B keeps synthesising them. Faster to ship, but the fee schedule is then not
  "from the system of record", which weakens the revenue evidence card.

Confirm or object in Phase 0.

---

## 4. Frozen interface #3 — the taxonomy / event names

**The problem:** today the name is canonicalised in **three** places that have drifted
(`ARCHITECTURE.md` coupling point 2): `eventTracker.ts::enforceTaxonomy` (coerces unknowns to
`core.<x>.action`), `ingestion/event_names.py` (coerces), `api/page_map.py` (a third map). The
Round 2 plan (`DATA_MODEL.md` Silver) wants **one** vocabulary, applied **once**, that **rejects**
what it cannot resolve instead of silently renaming it.

**The new split:**
- **Track B owns the one vocabulary** — a new module `pipeline/taxonomy/` with
  `pipeline/taxonomy/aliases.yaml`. It runs in the **Silver transform**. An unmapped name goes to
  `bronze.events_dead_letter` (loud, replayable) — it does **not** get renamed and it does **not**
  reach any KPI.
- **Ingestion** validates *shape* only (`event_name` is a non-empty `[a-z0-9_.]+` string).
- **NexaBank (A1):** reduce `enforceTaxonomy` to a **passthrough** (or a light shape check). Send
  the name your instrumentation actually uses — `loans.kyc_started.success`,
  `loan.proceed_to_kyc.success`, `transfer_completed`, whatever it is. Do **not** map it to
  `core.*.action`. Track B's alias map will resolve the known ones; a genuinely unknown one
  *should* fail loudly so we fix the instrumentation, which is the whole point.

**A1 is not blocking.** If `enforceTaxonomy` still coerces when Phase 3 lands, Silver still
canonicalises correctly for every *known* name — we just lose the "unknown name fails loudly"
benefit until you strip it. But please strip it.

**A6b — the alias map:** Track B seeds `aliases.yaml` from the union of today's three maps
(including every entry in `enforceTaxonomy`'s `LEGACY_MAP`). When you add or rename instrumentation
after that, **open a PR against `pipeline/taxonomy/aliases.yaml`** in the same change. That is the
new "add an alias" process — one file, reviewed by Track B.

---

## 5. Frozen interface #4 — `metadata._simulated` (fabricated-dimension declaration)

**Keep doing exactly what you do now.** `eventTracker.ts` already unions:
- keys the session profile invented (`selectGeoProfile` / `selectDevice` output when the caller
  supplied nothing),
- `response_time_ms` when not measured,
- whatever the caller declared in `metadata._simulated` (the Simulate engine declares
  `["location","city","continent","device_type","channel"]`).

**Track B (A2) reads this** into a `silver.events.fabricated_dims` column and its per-session
union on `silver.sessions`. The contract loader then **refuses to let Localize slice any dimension
that appears there** (unless `dataset='seeded'`). This is the `CLAUDE.md` rule-13 guard —
"ranked, confident, meaningless output is the worst failure mode".

**If you drop `_simulated`, that guard silently fails** and the engine will confidently attribute
KPI movements to dice rolls. So: **do not remove it.**

**A3 — the real fix (P3, not blocking):** `DATA_MODEL.md` says the proper fix is to *measure* these
instead of faking them — derive geography from the customer's `branchCode` → `branch.region /
country / city`, and device from the real `user-agent` (you already parse it in
`/events/location` via `UAParser`). When you do that, drop those keys from `_simulated` and Track
B's `fabricated_dims` shrinks automatically — Localize then gets real segments to work with. Track
B is ready for this whenever it lands; nothing on our side needs to change.

---

## 6. Track B is dropping these — what NexaBank must do about it

Only the drops that touch Track A code are listed. (Track B is also deleting a lot that NexaBank
never touches — the whole `feature_intelligence` DB, `events_raw`/`daily_feature_usage`,
`ai_reports`, ~40 dashboard endpoints, licensing tables. None of that reaches you.)

### A10 — the fast-mode simulate proxy is moving (Phase 3, coordinated)

**Fast mode stays.** It is how the intelligence layer gets enough volume to demo — nobody is
dropping it. What changes is only the endpoint it calls.

`eventRoutes.ts`'s `POST /events/simulate` with `mode: "fast"` currently proxies to
`${INGESTION_API_URL}/events/seed/fast` (+ `/events/seed/fast/purge`). Track B is **moving** those
endpoints **off the ingestion service** — seeding/mock-data is not an ingestion responsibility in
the Round 2 layout, and after the bronze/silver/gold split the seeder needs to write `bronze.*`
and run the pipeline transforms, which is pipeline-service territory.

- New endpoints: **`POST /dev/seed` and `POST /dev/seed/purge` on the pipeline service**, gated by
  an `ENABLE_DEV_SEED` env flag.
- Same request/response shape as today (`tenant_id`, `users`, `days`, `seed`, `passes`,
  `purge_first`, `purge_tables`, `behavior`, `create_accounts`).
- Behaviour is identical downstream: fast mode writes `bronze.events` + `bronze.core_banking`
  (with `_raw`), then runs the real silver/gold transforms — so a fast-seeded dataset is
  indistinguishable from a slow-seeded one. It only skips Kafka and the remote-Postgres writes.

**What you do:** in `eventRoutes.ts` fast mode, change the target from
`${base}/events/seed/fast` to the pipeline service's `${PIPELINE_URL}/dev/seed`. Track B provides
the exact URL/host in Phase 3 and keeps the old ingestion endpoint alive until `/dev/seed` is
live, so there is no window where fast mode is broken.

### A11 — extract endpoints that lose their consumer (Phase 3, FYI)

The Round 2 KPI chain is 5 KPIs. Track B will **only** call these extract endpoints:
`transactions`, `loan_applications`, `customers`, `campaigns`, `branches` (and `accounts` *only if*
signups turns out to be snapshot-sourced — open question #1).

**Track B will stop calling:** `/api/extract/cards`, `/api/extract/campaign_interactions`,
`/api/extract/macro_environment` (and possibly `/api/extract/accounts`). They support KPIs the
brief dropped (card activations, CPA, net-deposit / external-rate driver).

You may delete those route handlers from `extractRefRoutes.ts` for your own debloat, or leave them
dormant — nothing will break either way. Just don't rely on them being exercised. If Track C later
resurrects one of those KPIs, the endpoint comes back into use.

---

## 6b. Coordinated deletions (must land together)

### A8 — feature toggles (Phase 5)

Track B is **deleting** `tracking_toggles`, `GET/POST /tracking/toggles`, and the ingestion-side
toggle enforcement (`is_tracking_disabled`). In the **same window**, Track A must remove:
- `GET /events/toggles/:tenantId` and `PUT /events/toggles/:key` in `eventRoutes.ts` (they proxy
  to Track B's `/tracking/toggles`),
- any `enforceTaxonomy` / middleware path that blocks an event because a feature is toggled off,
- the local `prisma.featureToggle` fallback if nothing else uses it.

The admin feature-toggle product is not in the Round 2 brief. If the NexaBank UI has a toggle
screen, it goes too.

### A7 — the second tenant (Phase 6)

Round 2 is **one bank: `nexabank`**. Track A removes:
- `bank_b` from `seedTenants.ts`,
- the `bank_a→nexabank / bank_b→safexbank` alias maps in `eventTracker.ts`, `eventRoutes.ts`,
  `extractShared.ts` (keep only `bank_a→nexabank`, or better, rename the Prisma tenant to
  `nexabank` and drop the map entirely),
- `GLOBAL_ANALYTICS_TENANTS` / `GLOBAL_LOCAL_TENANTS`,
- `bank_b` / `safexbank` branches from `plantMovement.ts` and any seed script.

Track B removes its half (`TENANT_ALIAS_MAP`, `APP_TENANT_SCOPES`, `seed_safexbank.py`, …) in the
same phase.

### A9 — location capture (Phase 5, softer)

`POST /events/location`, `GET /events/admin/locations`, and the `userLocation` table feed the
dashboard's `/locations` and `/metrics/devices` views — **which Track B is deleting** because they
surface fabricated geography (`ARCHITECTURE.md`: "A dimension may not be localized until it is known
to be measured"). Options:
- delete them, or
- keep `POST /events/location` **only** if you're doing A3 (real geo from the browser) — in which
  case it becomes a *source of truth* rather than decoration, and Track B may want it after all.

Flag your intent; not blocking either way.

---

## 7. What Track A must NOT change without Track B sign-off

- The **event envelope** top-level fields (#2). Adding a metadata key is fine; changing
  `event_id` / `session_id` / `timestamp` / `channel` / `tenant_id` semantics is not.
- The **extract API** response envelope (`watermark` / `cursor_id` / `has_more` / `records`) and
  the keyset pagination contract (#3).
- The **`_simulated`** mechanism (#5) — you can change *what's in it*, not *that it exists*.
- The `x-extract-token` auth scheme.
- Emitting **both** a banking fact and its matching clickstream event (`ARCHITECTURE.md` data-flow
  rule 1) — Track B's cross-cadence reconciliation assumes a loan application row always has a
  matching `loan.applied.success` event and vice versa.

---

## 8. Track B decisions that affect you (already made — for your awareness)

- **Signups = clickstream** (`register.auth.success`). `/api/extract/accounts` is not consumed;
  A4 cancelled.
- **Revenue interest line = flat daily accrual** (`principal × rate / 365`) on approved loan
  applications, computed by Track B from `/api/extract/loan_applications`. **No new extract
  endpoint, no `fact_loans` table.** If Track C later decides `revenue.yaml` needs a real
  amortisation schedule, *that* becomes a new ask on you (a loans/accrual extract endpoint) — but
  not now, and not unless Track C raises it.

## 8b. Open questions for Track A (answer in Phase 0)

1. **Reference data ownership** (A5) — do you take fee schedule + calendar as extract endpoints
   (Track B's default), or does Track B keep synthesising them?
2. **`enforceTaxonomy`** (A1) — can you reduce it to a passthrough for Round 2, and by when?
3. **Ground truth from the console** (A6) — will `/events/simulate` (or a wrapper script) write
   `fixtures/planted_truth.json` the way `scripts/seed_data.py` does? `CLAUDE.md` §4 requires every
   planted scenario to record its own ground truth. Today only the Python seeder does.
4. **Location capture** (A9) — delete, or keep and make it real?

(Fast mode — A10 — is **not** an open question: it stays, the endpoint just moves. See §6.)

---

## 9. Track A checklist (pull from here as you go)

- [ ] A1 — `enforceTaxonomy` → passthrough / shape-check only
- [ ] A2 — `metadata._simulated` still emitted on every forwarded event (regression-test it)
- [ ] A3 — (optional) geo from branch, device from UA; drop those from `_simulated`
- [ ] ~~A4~~ — cancelled (signups is clickstream-sourced); `/api/extract/accounts` may be deleted
- [ ] A5 — reference-data decision made; `fee_schedule` + `calendar` endpoints added if chosen
- [ ] A6 — Simulate console writes `planted_truth.json`
- [ ] A7 — `bank_b` / `safexbank` removed from tenants, aliases, seeds, `plantMovement.ts`
- [ ] A8 — `/events/toggles/*` bridge + toggle enforcement removed (with Track B, same window)
- [ ] A9 — location-capture decision made
- [ ] A10 — fast-mode simulate re-pointed from `/events/seed/fast` to the pipeline `/dev/seed` (fast mode kept)
- [ ] A11 — noted which `/api/extract/*` endpoints go unconsumed; deleted or left dormant
- [ ] Envelope: `schema_version` no longer sent
- [ ] `docs/INTERFACES/event_envelope.md` and `docs/INTERFACES/metric_api.md` reviewed
