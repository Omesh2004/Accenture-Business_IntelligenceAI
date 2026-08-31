# Interface — the event envelope (clickstream)

**Status:** FROZEN for Round 2 (Phase 0). Owner: Track B. Producer: Track A (`nexabank/`).

**What this is:** the JSON body NexaBank POSTs to `http://ingestion-api:8000/events`, one request
per event. Source of the shape: `nexabank/backend/src/middleware/eventTracker.ts`
→ `forwardToIngestionAPI`. Landing: `bronze.events` (verbatim, plus the exact body as `_raw`).

Per `docs/DATA_MODEL.md` the clickstream is **behavioural context only** — funnel stage detail and
journey reconstruction. **No KPI number is derived from an event.** All five KPI values come from
the daily banking snapshot (`bronze.core_banking` → `silver.fact_*`). See
[`kpi_rollups.md`](kpi_rollups.md).

---

## The shape

```jsonc
{
  "event_id":   "uuid",                       // REQUIRED, stable, non-empty. NexaBank Postgres Event.id.
  "session_id": "sess_...",                   // producer-minted, stable per session. "" tolerated but drops the row from silver.sessions.
  "event_name": "loan.kyc_started.success",   // the RAW instrumented name — NOT canonicalised by the producer (see §taxonomy)
  "tenant_id":  "nexabank",                   // analytics tenant
  "user_id":    "<sha256 hash>",              // hashed customer id, or anon_<hash(session)>
  "timestamp":  1725100000.0,                 // unix SECONDS (float)
  "channel":    "web",                        // web | mobile | api | batch
  "metadata": {
    "session_id":       "sess_...",           // duplicated into metadata, keep
    "device_type":      "mobile",
    "location":         "India",              // COUNTRY value (legacy name — not a country code)
    "continent":        "Asia",
    "city":             "Mumbai",
    "channel":          "mobile",
    "campaign":         "kyc_reactivation",   // when applicable
    "response_time_ms": 55,
    "_simulated":       ["location","city","continent","device_type","channel","response_time_ms"],
    "role":             "user",
    "tier":             "free",
    "path":             "/loans"              // cosmetic (dashboard); OK to keep
    // any other instrumentation keys ride into bronze.events._raw verbatim
  }
}
```

### Top-level fields — semantics frozen

| field | rule |
|---|---|
| `event_id` | required, non-empty, stable. Ingestion **rejects** (422 → `bronze.events_dead_letter`, `stage='ingest_validation'`) if missing/blank. Dedup key in Silver. |
| `session_id` | producer-minted, stable per session. No 30-minute-gap inference anywhere downstream. `""` is accepted into `bronze.events` but never reaches `silver.sessions`. |
| `event_name` | the **raw instrumented name**. Ingestion validates **shape only** — non-empty string matching `[a-z0-9_.]+`. Canonicalisation happens once, later, in the Silver transform (`pipeline/taxonomy/`), which **rejects** an unresolvable name to the dead-letter table rather than coercing it. |
| `tenant_id` | analytics tenant, currently always `nexabank`. Validated against a known set. |
| `user_id` | already hashed by the producer. Ingestion masks metadata further; Silver holds no raw identifier Bronze does not. |
| `timestamp` | unix **seconds** (float). Ingestion bounds it: `[now − 90d, now + 5min]`, else dead-letter. |
| `channel` | enum `web | mobile | api | batch`. |
| `metadata` | free-form object, written to `bronze.events._raw` verbatim. Keys below are read downstream. |

### Metadata keys read downstream

| key | read by | note |
|---|---|---|
| `_simulated` | Silver → `silver.events.fabricated_dims Array(String)`, unioned per session onto `silver.sessions`. The contract loader refuses to let Localize slice any dimension listed here (unless `dataset='seeded'`). **If the producer stops emitting this, the fabricated-dimension guard silently fails.** |
| `session_id` | session grouping (mirror of the top-level field) |
| `device_type`, `location`, `continent`, `city`, `channel` | funnel / journey context only — all currently fabricated per session, all currently in `_simulated` |
| `campaign` | journey context; abstain-scenario cross-check is done on `silver.dim_campaign` from the extract, not this key |
| `path`, `role`, `tier` | dashboard cosmetics |

---

## Changes from what the producer sends today

| # | change | blocking? |
|---|---|---|
| E1 | **Drop `schema_version`.** Track B removes it from `ingestion/envelope.py` (`FeatureEvent`). The producer does not send it today — no producer action needed. Sending it later is harmless (ignored). | no |
| E2 | **`event_name` is the RAW name.** Track A reduces `enforceTaxonomy` to a passthrough / shape-check (sync doc **A1**). Not blocking: if it still coerces when Phase 3 lands, Silver still canonicalises every *known* name correctly — only the "unknown name fails loudly" benefit is delayed. | no |
| E3 | Ingestion stops canonicalising (`validate_event_name` → shape check only) and stops computing `event_name_canonical` at write. | no (Track B internal) |

## What Track A must NOT change without Track B sign-off

- The **top-level** fields `event_id` / `session_id` / `timestamp` / `channel` / `tenant_id` and
  their semantics. Adding a `metadata.*` key is always fine.
- That `metadata._simulated` **exists** (its contents may change — see sync doc A3).
- Emitting **both** a banking fact and its matching clickstream event — Track B's cross-cadence
  reconciliation assumes a loan-application row always has a matching `loan.applied.*` event.

## Taxonomy ownership (frozen — sync doc §4, decision D8)

- **Track B owns the one vocabulary** — `pipeline/taxonomy/aliases.yaml`, applied in the Silver
  transform, rejecting unknowns to `bronze.events_dead_letter` (`stage='silver_taxonomy_reject'`).
- Track B seeds `aliases.yaml` from the union of the three current dialects
  (`ingestion/event_names.py`, `api/page_map.py`, `eventTracker.ts` `LEGACY_MAP`).
- When Track A adds or renames instrumentation, it opens a PR against `aliases.yaml` in the same
  change. A name with no alias is dead-lettered loudly — that is the intended behaviour.
