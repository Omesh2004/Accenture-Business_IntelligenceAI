"""`bronze.events` -> `silver.events`  (behavioural context only — no KPI number).

Per row:
  1. canonicalise the name (`pipeline.taxonomy`). Unresolved -> `bronze.events_dead_letter`
     (stage `silver_taxonomy_reject`), NOT propagated. `event_name_raw` keeps the original.
  2. verify masking (email / IPv4 must not survive; re-mask defensively).
  3. pin the day: `event_date` = UTC `toDate(timestamp)`.
  4. parse `metadata._simulated` -> `fabricated_dims Array(String)`.
  5. project the session-invariant context attributes for the funnel / journey views.
  6. dedup by `event_id` (ReplacingMergeTree + OPTIMIZE FINAL at write).
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from warehouse.client import ch_client
from ingestion.masking import sanitize_metadata
from pipeline.taxonomy import canonicalize

logger = logging.getLogger(__name__)
BRONZE, SILVER = "bronze", "silver"
_BATCH = 20000

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")

EVENT_COLS = ["event_id", "session_id", "tenant_id", "event_name", "event_name_raw", "user_id",
              "channel", "timestamp", "event_date", "metadata", "fabricated_dims", "device_type",
              "country", "continent", "city", "campaign", "_version"]
DL_COLS = ["event_id", "tenant_id", "event_name", "payload", "error", "stage"]


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _remask(meta: dict) -> dict:
    try:
        return sanitize_metadata(meta)
    except Exception:
        blob = json.dumps(meta, default=str)
        blob = _EMAIL.sub("[redacted-email]", blob)
        blob = _IPV4.sub("[redacted-ip]", blob)
        try:
            return json.loads(blob)
        except Exception:
            return {}


def run(limit_rows: int = 2_000_000) -> dict:
    rows = ch_client.query(
        f"SELECT event_id, session_id, tenant_id, event_name, user_id, channel, timestamp, "
        f"metadata FROM {BRONZE}.events ORDER BY _ingested_at LIMIT {int(limit_rows)}")
    keep, dead = [], []
    now = _now()
    for r in rows:
        raw_name = str(r["event_name"])
        canon = canonicalize(raw_name)
        try:
            meta = json.loads(r["metadata"]) if r["metadata"] else {}
        except Exception:
            meta = {}
        if not canon:
            dead.append([r["event_id"], r["tenant_id"], raw_name,
                         json.dumps(dict(r), default=str)[:4000],
                         f"unresolved event_name '{raw_name}'", "silver_taxonomy_reject"])
            continue
        meta = _remask(meta if isinstance(meta, dict) else {})
        sim = meta.get("_simulated") or []
        fabricated = sorted({str(x) for x in sim}) if isinstance(sim, list) else []
        ts = r["timestamp"]
        keep.append([
            r["event_id"], r["session_id"], r["tenant_id"], canon, raw_name, r["user_id"],
            str(r["channel"]), ts, ts.date() if hasattr(ts, "date") else ts,
            json.dumps(meta, ensure_ascii=True), fabricated,
            str(meta.get("device_type", "")), str(meta.get("location", "")),
            str(meta.get("continent", "")), str(meta.get("city", "")),
            str(meta.get("campaign", "")), now,
        ])

    client = ch_client._get_client()
    try:
        for i in range(0, len(keep), _BATCH):
            client.insert(f"{SILVER}.events", keep[i:i + _BATCH], column_names=EVENT_COLS)
        for i in range(0, len(dead), _BATCH):
            client.insert(f"{BRONZE}.events_dead_letter", dead[i:i + _BATCH], column_names=DL_COLS)
        if keep:
            client.command(f"OPTIMIZE TABLE {SILVER}.events FINAL")
    finally:
        try:
            client.close()
        except Exception:
            pass
    return {"silver_events": len(keep), "taxonomy_rejects": len(dead)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run())
