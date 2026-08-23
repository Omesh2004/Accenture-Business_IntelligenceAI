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

The Node layer maps `payment_completed -> transactions.pay_now.success` (plural), while the read
layer canonicalizes to `transaction.pay_now.success` (singular). If your new name is not
reconciled at the read layer, the row exists in `events_raw` but `canonicalize_event_name` drops
or misfiles it, so it appears in no funnel, no feature list, and no KPI. There is no error.

## Do this, in order

1. **Emit** the event from the producer with a 3-part name
   (`NexaBank/backend/src/middleware/eventTracker.ts`, or the browser `lib/tracker.ts`).
2. **Node taxonomy**: if the raw name is not already 3-part, add the mapping to `enforceTaxonomy`'s
   `LEGACY_MAP` in the Node backend so it forwards a canonical name.
3. **Ingest validation**: confirm the name passes `validate_event_name` in `core/models.py`
   (exactly three lowercase segments, else 422). Adjust nothing here unless the format is wrong.
4. **Read reconciliation** (`api/page_map.py`): add the name and any aliases to
   `CANONICAL_EVENT_ALIASES` and give it a label in `FEATURE_DISPLAY_NAMES`. This is the step
   that makes it show up. Decide singular vs plural here and match everything else to it.
5. **Page attribution** (only if it maps to a page): add to `URL_MAP` and `FEATURE_PAGE_MAP` so
   `resolve_page` files it correctly; add the page to `KNOWN_PAGES` in `get_top_pages` if new.
6. **Paid feature** (only if it is one): add it to the `feature_catalog` inside
   `get_license_usage`.

## Verify

Emit one event, then confirm it appears where expected (a funnel level, feature usage, or a KPI)
rather than being silently dropped. If it does not appear, the miss is almost always step 4
(alias/plural mismatch).

## Coupling note

This is coupling point 2 of 5 in `CLAUDE.md`. When a KPI contract (`contracts/*.yaml`) references
an event in its `ratio` or `lineage`, that exact name must survive all three dialects, or the
funnel behind the KPI reads zero.
