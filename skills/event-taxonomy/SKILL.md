---
name: event-taxonomy
description: >
  Use whenever adding, renaming, or wiring a tracked event in FinInsights. The event taxonomy
  lives in three implementations that disagree on singular/plural; miss one and the event lands
  in events_raw but is dropped from every chart. Trigger on any new event name, funnel step,
  KPI contract event, or "the event isn't showing up" symptom.
---

# Adding or renaming a tracked event

An event name is three lowercase dot-separated segments: `page.feature.status`
(e.g. `loan.kyc_completed.success`). The same logical event is normalized in THREE places that
do not agree, and the read layer is the one that decides what a chart shows.

## Why this is dangerous

Nothing rejects a bad name. Every layer **coerces** it:

- `enforceTaxonomy` (Node) falls through to `core.<name>.action` for anything not in `LEGACY_MAP`.
- `validate_event_name` (`core/models.py`) also coerces — it wraps unknown names as
  `core.<name>.action` and only raises 422 if even that fails. It is not the guard it looks like.
- `canonicalize_event_name` (`api/page_map.py`) then either maps the name, passes it through, or
  returns `None`.

So the failure mode is a **silent rename**, not an error. The row exists in `events_raw`, but it
appears in no funnel, no feature list, and no KPI. There is no log line at read time.

## Live examples of the failure shape

**The `loan_approved` case is fixed — do not use it as a live example any more.** FOUNDATION-3
landed; `eventTracker.ts:273-274` now carries `'loan_applied': 'loans.applied.success'` and
`'loan_approved': 'loans.approved.success'`, and both resolve correctly end to end (verified by
running the chain). It is still the clearest illustration of the shape, so:

```
trackEvent("loan_approved")        # BEFORE FOUNDATION-3
  -> enforceTaxonomy   : no LEGACY_MAP entry, 1 part -> "core.loan_approved.action"
  -> validate_event_name: "core" is in the preserve set -> unchanged
  -> canonicalize      : "core.loan_approved.action"
  => contracts/loan_approval_volume.yaml reads loan.approved.success -> ZERO ROWS, silently
```

**What is still broken, verified 2026-08-28 by running all 110 producer names through the real
chain** (`docs/INTELLIGENCE_LAYER_PREREQUISITES.md` Appendix A). These are live today:

| Producer emits | Canonical at read | The damage |
|---|---|---|
| `lending.loan.applied` | `loan.applied.success` | **`action` is promoted to `success`.** An attempt is indistinguishable from an outcome, so no attempt→success conversion rate is computable — in the exact vocabulary both funnel KPIs use |
| `lending.loan.kyc_abandoned` | `loan.kyc_abandoned.success` | an abandonment recorded as a success |
| `free.loan.kyc_failed` | `loan.kyc.failure` | feature identity lost: `kyc_failed` collapses to `kyc` |
| `free.payment.success` | `payment.success.action` | the **status became the feature**; no payment conversion event exists |
| `login.auth.error` | `login.auth.failed` | `login`/`register` have no `.failure` branch, so they keep `.failed` while every other page uses `.failure` |
| `pro.dashboard.view` | `dashboard.page.view` | identical to `free.dashboard.view` — **the tier is erased by prefix stripping** |
| `loan_rejected` | `core.loan_rejected.action` | no `LEGACY_MAP` entry — the original bug shape, still present |
| `pro-feature.crypto-trading.view` (frontend) | `pro_feature.crypto_trading.view` | a **parallel namespace** disjoint from the backend's `crypto-trading.*`, which is what `contracts/pro_revenue.yaml` counts |
| `pro.features_unlock.success` | `None` | dropped at read time entirely |

Two structural facts behind all of it: **canonicalisation happens at read time, in Python, over
raw names** — `events_raw` has no canonical column and `daily_feature_usage` is keyed on the raw
`event_name` — and the three dialects are fed by **four naming vocabularies** (backend
`trackEvent` literals, frontend `track` literals, `measureAndTrack` bases, seed scripts).

Fixing this properly is `docs/TASK.md` P0-5 and P0-6 (canonicalise once, at ingest); the semantic
decisions it forces are `docs/PROPOSAL.md` §2 Block B.

## Do this, in order

1. **Emit** the event from the producer with a 3-part name
   (`NexaBank/backend/src/middleware/eventTracker.ts`, or the browser `lib/tracker.ts`).
2. **Node taxonomy**: if the raw name is not already 3-part, add the mapping to `enforceTaxonomy`'s
   `LEGACY_MAP` in the Node backend so it forwards a canonical name. Do not rely on the generic
   fallback — that is what strands an event in the `core.*` junk namespace.
3. **Ingest validation**: confirm the name survives `validate_event_name` in `core/models.py`
   unchanged. Note that `free`/`pro`/`core`/`enterprise`/`lending` prefixes are preserved as-is,
   while other prefixes are rewritten.
4. **Read reconciliation** (`api/page_map.py`): add the name and any aliases to
   `CANONICAL_EVENT_ALIASES` and give it a label in `FEATURE_DISPLAY_NAMES`. This is the step
   that makes it show up. Decide singular vs plural here and match everything else to it.
5. **Page attribution** (only if it maps to a page): add to `URL_MAP` and `FEATURE_PAGE_MAP` so
   `resolve_page` files it correctly; add the page to `KNOWN_PAGES` in `get_top_pages` if new.
6. **Paid feature** (only if it is one): add it to the `feature_catalog` inside
   `get_license_usage` (`api/main.py:2216`). The catalog keys are **hyphenated**
   (`wealth-management-pro.rebalance.success`), while producers emit underscores — canonicalization
   bridges that, so verify rather than assume.

   Measured against what the producers actually emit: **13 of the catalog's 47 keys are
   unreachable from any literal producer name**, and **60 produced events are absent from the
   catalog** and therefore classified unknown/unlicensed
   (`docs/INTELLIGENCE_LAYER_PREREQUISITES.md` Appendix B). Adding a key here is not evidence it
   can ever match — run the chain and confirm. Note also that this inline dict, not the
   `tenant_licenses` table, is what `/license/usage` reads, so entitlement has two sources of
   truth today and the one the UI shows is identical for every tenant (`docs/TASK.md` P2-5).
7. **Seed data**: if the demo needs it, add it to `scripts/seed_data.py`. That script emits
   canonical names directly and bypasses the Node layer, so an event can work when seeded and be
   broken live, or vice versa. Check both paths.

## Verify — run this, do not reason about it

The whole taxonomy is one function call away. Check every name before you rely on it:

Run it in the container, not a host venv (`CLAUDE.md`, Key commands):

```bash
docker compose exec analytics-api python -c \
  "from api.page_map import canonicalize_event_name as c; print(c('loan.approved.success'))"
```

The output must equal the input for a canonical name. `None` means the event is dropped at read
time; a *different* string means it is silently refiled somewhere you are not looking.

To check what a producer's raw name actually becomes, execute the **real** Node dialect rather
than reading `LEGACY_MAP` (`eventTracker.ts:247`) and reasoning about it — an absent entry means
`core.<name>.action`, and the prefix and suffix rules are easy to get wrong by eye:

```bash
# host-only: needs node AND NexaBank's source, which no single image has
printf 'lending.loan.applied\nloan_rejected\n' > names.txt
node scripts/taxonomy_probe.js NexaBank/backend/src/middleware/eventTracker.ts names.txt
```

`scripts/taxonomy_probe.js` extracts and evaluates `enforceTaxonomy`'s own source, so it cannot
drift from the dialect it is checking. Chain its output through the two Python dialects to see the
full journey — that is exactly what `scripts/verify_data_quality.py` does for every contract
lineage event.

Then emit one real event and confirm it appears where expected (a funnel level, feature usage, or
a KPI). If it does not, the miss is almost always step 2 or step 4.

## Coupling note

This is coupling point 2 of **6** in `CLAUDE.md`. When a KPI contract (`contracts/*.yaml`)
references an event in its `fundamentals` or `lineage`, that exact name must survive all three
dialects, or the funnel behind the KPI reads zero. A contract that cannot be computed must declare
`readiness.status: blocked` so Trust Gate refuses it instead of narrating a phantom 100% decline —
see `docs/KPI_CONTRACT.md`.

Good news worth stating: **every event named in the three contracts' `fundamentals` and `lineage`
resolves correctly today** — `loan.kyc_started.success`, `loan.kyc_completed.success`,
`loan.applied.success`, `loan.approved.success` and all four `pro_revenue` conversion events, plus
`auth.role.violation` and `pro.new_feature.view` for scenarios 3 and 5. The contracts are correct;
the vocabulary *around* them is not, which is why an event that is not in a contract is far more
likely to be silently misfiled than one that is.
