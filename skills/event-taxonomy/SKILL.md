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

## Live example: this is broken in the repo right now

`NexaBank/backend/src/routes/loanRoutes.ts:214` calls `trackEvent("loan_approved", ...)`.
`loan_approved` is **not** in `LEGACY_MAP`, so:

```
trackEvent("loan_approved")
  -> enforceTaxonomy   : no LEGACY_MAP entry, 1 part -> "core.loan_approved.action"
  -> validate_event_name: "core" is in the preserve set -> unchanged
  -> canonicalize      : "core.loan_approved.action"   (alias map only has ...view)
```

`contracts/loan_approval_volume.yaml` reads `loan.approved.success`, which therefore matches
**zero rows, forever, silently**. `loan_applied` has the same shape of bug: it maps to
`loans.submit_application.success`, which canonicalizes to `loan.submit_application.success`, not
`loan.applied.success`. Both fixes are FOUNDATION-3 in `docs/DATABASE.md`.

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
   `get_license_usage` (`api/main.py:2088`). The catalog keys are **hyphenated**
   (`wealth-management-pro.rebalance.success`), while producers emit underscores — canonicalization
   bridges that, so verify rather than assume.
7. **Seed data**: if the demo needs it, add it to `scripts/seed_data.py`. That script emits
   canonical names directly and bypasses the Node layer, so an event can work when seeded and be
   broken live, or vice versa. Check both paths.

## Verify — run this, do not reason about it

The whole taxonomy is one function call away. Check every name before you rely on it:

```bash
.venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'.'); \
  from api.page_map import canonicalize_event_name as c; \
  print(c('loan.approved.success'))"
```

The output must equal the input for a canonical name. `None` means the event is dropped at read
time; a *different* string means it is silently refiled somewhere you are not looking.

To check what a producer's raw name actually becomes, feed it the post-`enforceTaxonomy` value —
read `LEGACY_MAP` in `eventTracker.ts:176` to find it, and remember that an absent entry means
`core.<name>.action`.

Then emit one real event and confirm it appears where expected (a funnel level, feature usage, or
a KPI). If it does not, the miss is almost always step 2 or step 4.

## Coupling note

This is coupling point 2 of 5 in `CLAUDE.md`. When a KPI contract (`contracts/*.yaml`) references
an event in its `fundamentals` or `lineage`, that exact name must survive all three dialects, or
the funnel behind the KPI reads zero. A contract that cannot be computed must declare
`readiness.status: blocked` so Trust Gate refuses it instead of narrating a phantom 100% decline —
see `docs/KPI_CONTRACT.md`.
