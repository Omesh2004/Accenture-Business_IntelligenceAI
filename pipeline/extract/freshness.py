"""`gold.source_freshness` + `gold.ingest_watermarks` bookkeeping.

Lifted from `api/intelligence/loaders.py` (the mechanics are good — watermark + cursor_id
keyset resume, per-source SLA, a failure that preserves `max_source_ts` so a broken source
cannot look fresh). Only the database moved: `feature_intelligence` -> `gold`.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from warehouse.client import ch_client

logger = logging.getLogger(__name__)

DB = "gold"
EPOCH = datetime(1970, 1, 1)

# Declared cadence and SLA per source. The Trust Gate reads the row a contract points at,
# because one global freshness number is meaningless when sources refresh at different rates.
SOURCES = {
    "nexabank_clickstream": {"grain": "event", "cadence": "real_time", "sla_minutes": 15},
    "nexabank_core": {"grain": "transaction|application|account", "cadence": "hourly_batch",
                      "sla_minutes": 120},
    "nexabank_crm": {"grain": "customer|campaign", "cadence": "weekly", "sla_minutes": 10080},
    "market_ops": {"grain": "branch", "cadence": "monthly", "sla_minutes": 44640},
    "reference_data": {"grain": "product|calendar_day", "cadence": "weekly", "sla_minutes": 10080},
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _client():
    return ch_client._get_client()


# ── watermarks ──────────────────────────────────────────────────────────────
def read_watermark(source_id: str, entity: str, tenant_id: str = "*") -> datetime:
    rows = ch_client.query(
        f"SELECT max(watermark) AS w FROM {DB}.ingest_watermarks "
        "WHERE source_id = %(s)s AND entity = %(e)s AND tenant_id = %(t)s",
        {"s": source_id, "e": entity, "t": tenant_id})
    return rows[0]["w"] if rows and rows[0]["w"] and rows[0]["w"] > EPOCH else EPOCH


def read_cursor_id(source_id: str, entity: str, tenant_id: str = "*") -> str:
    try:
        rows = ch_client.query(
            f"SELECT cursor_id FROM {DB}.ingest_watermarks FINAL "
            "WHERE source_id = %(s)s AND entity = %(e)s AND tenant_id = %(t)s",
            {"s": source_id, "e": entity, "t": tenant_id})
        return str(rows[0]["cursor_id"]) if rows else ""
    except Exception:
        return ""


def write_watermark(source_id: str, entity: str, watermark: datetime, rows_seen: int,
                    tenant_id: str = "*", cursor_id: str = "") -> None:
    client = _client()
    try:
        client.insert(
            f"{DB}.ingest_watermarks",
            [[source_id, entity, tenant_id, watermark, cursor_id, int(rows_seen), _now()]],
            column_names=["source_id", "entity", "tenant_id", "watermark", "cursor_id",
                          "rows_seen", "updated_at"])
    finally:
        try:
            client.close()
        except Exception:
            pass


# ── freshness ───────────────────────────────────────────────────────────────
def record_freshness(source_id: str, tenant_id: str, max_source_ts: datetime, rows: int,
                     status: str = "ok", note: str = "") -> None:
    meta = SOURCES.get(source_id, {"grain": "unknown", "cadence": "unknown", "sla_minutes": 60})
    client = _client()
    try:
        client.insert(
            f"{DB}.source_freshness",
            [[source_id, tenant_id, meta["grain"], meta["cadence"], int(meta["sla_minutes"]),
              _now(), max_source_ts, int(rows), status, note, _now()]],
            column_names=["source_id", "tenant_id", "grain", "cadence", "sla_minutes",
                          "last_loaded_at", "max_source_ts", "rows_loaded", "load_status",
                          "note", "_version"])
    finally:
        try:
            client.close()
        except Exception:
            pass


def mark_source_failed(source_id: str, tenants: list[str], error) -> None:
    """Record a load failure without lying about data age: `max_source_ts` carries over from the
    last successful load, so a broken source cannot look fresh — only `load_status`/`note` move."""
    note = ("%s: %s" % (type(error).__name__, error) if isinstance(error, BaseException)
            else str(error))[:400]
    for tenant in tenants or []:
        previous = EPOCH
        try:
            rows = ch_client.query(
                f"SELECT max_source_ts FROM {DB}.source_freshness FINAL "
                "WHERE source_id = %(s)s AND tenant_id = %(t)s",
                {"s": source_id, "t": tenant})
            if rows and rows[0].get("max_source_ts"):
                previous = rows[0]["max_source_ts"]
        except Exception:
            pass
        try:
            record_freshness(source_id, tenant, previous, 0, status="failed", note=note)
        except Exception:
            logger.exception("could not record failure for source %s/%s", source_id, tenant)


def record_clickstream_freshness(tenants: list[str]) -> None:
    """Source 1's freshness, so all sources report through one table."""
    for tenant in tenants:
        rows = ch_client.query(
            "SELECT max(timestamp) AS m, count() AS n FROM bronze.events WHERE tenant_id = %(t)s",
            {"t": tenant})
        if rows and rows[0]["m"]:
            record_freshness("nexabank_clickstream", tenant, rows[0]["m"], int(rows[0]["n"]))
