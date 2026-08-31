"""Batch loader: core banking (source 2) and reference data (source 3) into ClickHouse.

Idempotent by construction. Facts are ReplacingMergeTree keyed on the source's own id and
versioned by its updated_at, so a replayed batch converges rather than double-counting -- the
same property the telemetry path gets from uniqExact(event_id).

Watermarks live in ingest_watermarks, so a run resumes instead of re-reading history.
"""
from __future__ import annotations

import json
import logging
import hashlib
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

logger = logging.getLogger(__name__)

DB = "feature_intelligence"
EXTRACT_URL = os.environ.get("EXTRACT_API_URL", "http://nexabank-backend:5000/api")
EXTRACT_TOKEN = os.environ.get("EXTRACT_API_TOKEN", "")
PAGE_SIZE = int(os.environ.get("EXTRACT_PAGE_SIZE", "1000"))
MAX_PAGES = int(os.environ.get("EXTRACT_MAX_PAGES", "200"))
HTTP_TIMEOUT_S = int(os.environ.get("EXTRACT_TIMEOUT_S", "30"))

EPOCH = datetime(1970, 1, 1)

# Declared cadence and SLA per source. Trust Gate reads the row a contract points at, because
# one global freshness number is meaningless when sources refresh at different rates.
SOURCES = {
    "nexabank_clickstream": {"grain": "event", "cadence": "real_time", "sla_minutes": 15},
    # Source A -- core banking.
    "nexabank_core": {"grain": "transaction|application|account|card", "cadence": "hourly_batch",
                      "sla_minutes": 120},
    # Source B -- CRM and marketing. Weekly, so a two-day lag is healthy here and an outage there.
    "nexabank_crm": {"grain": "customer|campaign|interaction", "cadence": "weekly",
                     "sla_minutes": 10080},
    # Source C -- branch operations and macro environment. Monthly, regional.
    "market_ops": {"grain": "branch|region_month", "cadence": "monthly", "sla_minutes": 44640},
    "reference_data": {"grain": "product|calendar_day", "cadence": "weekly", "sla_minutes": 10080},
}


def _ch():
    from warehouse.client import ch_client
    return ch_client


def _client():
    return _ch()._get_client()


def _money(value) -> Decimal:
    """Decimal, never float: a binary float cannot hold 0.10, so sums drift."""
    try:
        return Decimal(str(value if value is not None else 0)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0.00")


def _rate(value) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0)).quantize(Decimal("0.0001"))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0.0000")


def _dt(value) -> datetime:
    if not value:
        return EPOCH
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc).replace(tzinfo=None)
    except ValueError:
        return EPOCH


# ── watermarks ──────────────────────────────────────────────────────────────
def read_watermark(source_id: str, entity: str, tenant_id: str = "*") -> datetime:
    rows = _ch().query(
        f"SELECT max(watermark) AS w FROM {DB}.ingest_watermarks "
        "WHERE source_id = %(s)s AND entity = %(e)s AND tenant_id = %(t)s",
        {"s": source_id, "e": entity, "t": tenant_id})
    return rows[0]["w"] if rows and rows[0]["w"] and rows[0]["w"] > EPOCH else EPOCH


def read_cursor_id(source_id: str, entity: str, tenant_id: str = "*") -> str:
    """Second half of the resume cursor. Without it a page boundary that falls among rows sharing
    a timestamp drops the remainder permanently."""
    try:
        rows = _ch().query(
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
        client.insert(f"{DB}.ingest_watermarks",
                      [[source_id, entity, tenant_id, watermark, cursor_id, int(rows_seen),
                        datetime.utcnow()]],
                      column_names=["source_id", "entity", "tenant_id", "watermark", "cursor_id",
                                    "rows_seen", "updated_at"])
    finally:
        try:
            client.close()
        except Exception:
            pass


def record_freshness(source_id: str, tenant_id: str, max_source_ts: datetime, rows: int,
                     status: str = "ok", note: str = "") -> None:
    meta = SOURCES.get(source_id, {"grain": "unknown", "cadence": "unknown", "sla_minutes": 60})
    client = _client()
    try:
        client.insert(f"{DB}.source_freshness",
                      [[source_id, tenant_id, meta["grain"], meta["cadence"],
                        int(meta["sla_minutes"]), datetime.utcnow(), max_source_ts,
                        int(rows), status, note, datetime.utcnow()]],
                      column_names=["source_id", "tenant_id", "grain", "cadence", "sla_minutes",
                                    "last_loaded_at", "max_source_ts", "rows_loaded",
                                    "load_status", "note", "_version"])
    finally:
        try:
            client.close()
        except Exception:
            pass


def mark_source_failed(source_id: str, tenants: list[str], error: str) -> None:
    """Record a load failure without lying about data age.

    max_source_ts is carried over from the last successful load: the data really is that old, and
    overwriting it with `now` would make a broken source look perfectly fresh. Only load_status
    and the note change, which is what makes the failure visible to source_health and to Trust
    Gate rather than only to whoever is reading the logs.
    """
    note = ("%s: %s" % (type(error).__name__, error) if isinstance(error, BaseException)
            else str(error))[:400]
    for tenant in tenants or []:
        previous = EPOCH
        try:
            rows = _ch().query(
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


# ── extract ─────────────────────────────────────────────────────────────────
def _fetch(entity: str, params: dict) -> dict:
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(f"{EXTRACT_URL}/extract/{entity}?{query}",
                                 headers={"x-extract-token": EXTRACT_TOKEN}, method="GET")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _insert(table: str, columns: list[str], rows: list[list]) -> int:
    if not rows:
        return 0
    client = _client()
    try:
        client.insert(f"{DB}.{table}", rows, column_names=columns)
        return len(rows)
    finally:
        try:
            client.close()
        except Exception:
            pass


def _collapse(table: str, written: int) -> int:
    """Merge duplicates once a load finishes.

    ReplacingMergeTree merges asynchronously and may never run, so a re-read leaves every count
    doubled until it does. Called once per load, not per page: it rewrites the whole table.
    """
    if not written:
        return written
    client = _client()
    try:
        client.command(f"OPTIMIZE TABLE {DB}.{table} FINAL")
    except Exception:
        logger.warning("could not collapse duplicates in %s", table, exc_info=True)
    finally:
        try:
            client.close()
        except Exception:
            pass
    return written


def _reconcile(table: str, key_col: str, present: list[str]) -> int:
    """Drop reference rows whose key is gone from the source.

    An extract has no tombstone: a deleted row simply stops appearing, and a ReplacingMergeTree
    keyed on that row keeps the last version it ever saw, forever. For a watermarked feed there is
    no way to tell "deleted" from "unchanged", so this is unsafe there -- it is called ONLY from
    the full-re-read sources, where absence from the batch really does mean absence at source.

    Without it, globalising the branch vocabulary left `dim_branch` reporting the retired US
    regions alongside the new continents, so an enumeration of regions returned both geographies
    at once and the split this change removed was still visible downstream.
    """
    if not present:
        return 0
    client = _client()
    try:
        before = client.query(
            f"SELECT count() FROM {DB}.{table} FINAL WHERE {key_col} NOT IN %(present)s",
            parameters={"present": tuple(sorted(set(present)))}).result_rows[0][0]
        if before:
            # mutations_sync=1: the caller reports a count, and an async mutation would make that
            # count a guess about the future rather than a statement about the database.
            client.command(
                f"ALTER TABLE {DB}.{table} DELETE WHERE {key_col} NOT IN %(present)s",
                parameters={"present": tuple(sorted(set(present)))},
                settings={"mutations_sync": 1})
        return int(before)
    finally:
        try:
            client.close()
        except Exception:
            pass


# ── entity loaders ──────────────────────────────────────────────────────────
OPENING_COLUMNS = ["account_no", "tenant_id", "customer_id", "account_type",
                   "lifecycle_status", "interest_rate", "branch_code", "region", "country", "opened_at",
                   "loaded_at", "_version"]

CARD_COLUMNS = ["card_id", "tenant_id", "customer_id", "account_no", "product_name", "card_type",
                "network", "status", "credit_limit", "region", "country", "issued_at", "loaded_at",
                "_version"]

CUSTOMER_COLUMNS = ["customer_id", "tenant_id", "age_bracket", "income_bracket",
                    "employment_status", "risk_segment", "lifetime_value", "kyc_status",
                    "branch_code", "region", "country", "loaded_at", "_version"]

INTERACTION_COLUMNS = ["interaction_id", "tenant_id", "campaign_id", "campaign_name", "channel",
                       "customer_id", "interaction_type", "risk_segment", "region", "country",
                       "occurred_at", "loaded_at", "_version"]

BRANCH_COLUMNS = ["branch_code", "tenant_id", "name", "region", "country", "city", "manager_name",
                  "staffing_headcount", "opened_at", "loaded_at", "_version"]

MACRO_COLUMNS = ["region", "month_year", "competitor_deposit_rate", "central_bank_base_rate",
                 "regional_unemployment_rate", "recorded_at", "loaded_at", "_version"]

CAMPAIGN_COLUMNS = ["campaign_id", "tenant_id", "name", "channel", "segment", "start_date",
                    "end_date", "spend", "_version"]

TXN_COLUMNS = ["txn_id", "tenant_id", "customer_id", "account_no", "counterparty_acc",
               "direction", "branch_code", "region", "country", "txn_type", "category", "mcc",
               "merchant_name", "reference_number", "channel", "status", "amount",
               "occurred_at", "loaded_at", "_version"]

APP_COLUMNS = ["application_id", "tenant_id", "customer_id", "branch_code", "region",
               "country", "risk_segment", "loan_type", "status", "principal_amount",
               "interest_rate", "term_months", "kyc_step", "created_at", "decided_at",
               "loaded_at", "_version"]




def load_transactions(full: bool = False) -> int:
    entity, source = "transactions", "nexabank_core"
    since = EPOCH if full else read_watermark(source, entity)
    cursor_id = "" if full else read_cursor_id(source, entity)
    now = datetime.utcnow()
    total, max_ts = 0, since
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"since": since.isoformat(), "since_id": cursor_id,
                               "limit": PAGE_SIZE})
        records = page.get("records") or []
        if not records:
            break
        rows = []
        for r in records:
            occurred = _dt(r["occurred_at"])
            max_ts = max(max_ts, occurred)
            rows.append([r["txn_id"], r["tenant_id"], r["customer_id"], r["account_no"],
                         r.get("counterparty_acc", ""), r.get("direction", ""),
                         r.get("branch_code", ""), r.get("region", ""), r.get("country", ""),
                         r["txn_type"],
                         r.get("category", ""), r.get("mcc", ""), r.get("merchant_name", ""),
                         r.get("reference_number", ""), r["channel"], r["status"],
                         _money(r["amount"]), occurred, now, occurred])
        total += _insert("fact_transactions", TXN_COLUMNS, rows)
        since = _dt(page.get("watermark")) or max_ts
        cursor_id = str(page.get("cursor_id") or "")
        if not page.get("has_more"):
            break
    write_watermark(source, entity, max_ts, total, cursor_id=cursor_id)
    _collapse("fact_transactions", total)
    return total


def load_loan_applications(full: bool = False) -> int:
    entity, source = "loan_applications", "nexabank_core"
    since = EPOCH if full else read_watermark(source, entity)
    cursor_id = "" if full else read_cursor_id(source, entity)
    now = datetime.utcnow()
    total, max_ts = 0, since
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"since": since.isoformat(), "since_id": cursor_id,
                               "limit": PAGE_SIZE})
        records = page.get("records") or []
        if not records:
            break
        rows = []
        for r in records:
            updated = _dt(r["updated_at"])
            max_ts = max(max_ts, updated)
            rows.append([r["application_id"], r["tenant_id"], r["customer_id"],
                         r.get("branch_code") or "", r.get("region") or "",
                         r.get("country") or "", r.get("risk_segment") or "", r["loan_type"],
                         r["status"], _money(r["principal_amount"]), _rate(r["interest_rate"]),
                         int(r["term_months"] or 0), int(r["kyc_step"] or 0),
                         _dt(r["created_at"]), _dt(r.get("decided_at")), now,
                         # _version is the SOURCE's updated_at, so a status change wins over the
                         # older row and a replay of the same state is a no-op.
                         updated])
        total += _insert("fact_loan_applications", APP_COLUMNS, rows)
        since = _dt(page.get("watermark")) or max_ts
        cursor_id = str(page.get("cursor_id") or "")
        if not page.get("has_more"):
            break
    write_watermark(source, entity, max_ts, total, cursor_id=cursor_id)
    _collapse("fact_loan_applications", total)
    return total




def load_account_openings(full: bool = False) -> int:
    """Account OPENINGS -- a change feed, additive over time. Distinct from the daily snapshot,
    which is a balance sheet and must never be summed across dates."""
    entity, source = "accounts", "nexabank_core"
    since = EPOCH if full else read_watermark(source, entity)
    cursor_id = "" if full else read_cursor_id(source, entity)
    now = datetime.utcnow()
    total, max_ts = 0, since
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"since": since.isoformat(), "since_id": cursor_id,
                               "limit": PAGE_SIZE})
        records = page.get("records") or []
        if not records:
            break
        rows = []
        for r in records:
            opened = _dt(r["opened_at"])
            max_ts = max(max_ts, opened)
            rows.append([r["account_no"], r["tenant_id"], r["customer_id"], r["account_type"],
                         r.get("lifecycle_status", ""), _rate(r.get("interest_rate", 0)),
                         r.get("branch_code", ""), r.get("region", ""), r.get("country", ""),
                         opened, now, opened])
        total += _insert("fact_account_openings", OPENING_COLUMNS, rows)
        since = _dt(page.get("watermark")) or max_ts
        cursor_id = str(page.get("cursor_id") or "")
        if not page.get("has_more"):
            break
    write_watermark(source, entity, max_ts, total, cursor_id=cursor_id)
    _collapse("fact_account_openings", total)
    return total


def load_cards(full: bool = False) -> int:
    entity, source = "cards", "nexabank_core"
    since = EPOCH if full else read_watermark(source, entity)
    cursor_id = "" if full else read_cursor_id(source, entity)
    now = datetime.utcnow()
    total, max_ts = 0, since
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"since": since.isoformat(), "since_id": cursor_id,
                               "limit": PAGE_SIZE})
        records = page.get("records") or []
        if not records:
            break
        rows = []
        for r in records:
            updated = _dt(r["updated_at"])
            max_ts = max(max_ts, updated)
            rows.append([r["card_id"], r["tenant_id"], r["customer_id"], r["account_no"],
                         r["product_name"], r["card_type"], r["network"], r["status"],
                         _money(r.get("credit_limit", 0)), r.get("region", ""),
                         r.get("country", ""),
                         _dt(r["issued_at"]), now, updated])
        total += _insert("fact_cards", CARD_COLUMNS, rows)
        since = _dt(page.get("watermark")) or max_ts
        cursor_id = str(page.get("cursor_id") or "")
        if not page.get("has_more"):
            break
    write_watermark(source, entity, max_ts, total, cursor_id=cursor_id)
    _collapse("fact_cards", total)
    return total


# -- source B: CRM and marketing --------------------------------------------
def load_customers() -> int:
    """A full re-read: the CRM exposes no change feed, which is exactly why its cadence is weekly
    and its SLA is measured in days rather than minutes."""
    entity, source = "customers", "nexabank_crm"
    now = datetime.utcnow()
    total, offset = 0, 0
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"limit": PAGE_SIZE, "offset": offset})
        records = page.get("records") or []
        if not records:
            break
        rows = [[r["customer_id"], r["tenant_id"], r.get("age_bracket", ""),
                 r.get("income_bracket", ""), r.get("employment_status", ""),
                 r.get("risk_segment", ""), _money(r.get("lifetime_value", 0)),
                 r.get("kyc_status", ""), r.get("branch_code", ""), r.get("region", ""),
                 r.get("country", ""), now, now]
                for r in records]
        total += _insert("dim_customer", CUSTOMER_COLUMNS, rows)
        offset += len(records)
        if not page.get("has_more"):
            break
    write_watermark(source, entity, now, total)
    _collapse("dim_customer", total)
    return total


def load_campaigns(full: bool = False) -> int:
    """Real campaigns from the CRM, replacing the synthetic seed. Spend is CPA's numerator, so it
    must come from the system of record rather than be invented."""
    entity, source = "campaigns", "nexabank_crm"
    since = EPOCH if full else read_watermark(source, entity)
    cursor_id = "" if full else read_cursor_id(source, entity)
    total, max_ts = 0, since
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"since": since.isoformat(), "since_id": cursor_id,
                               "limit": PAGE_SIZE})
        records = page.get("records") or []
        if not records:
            break
        rows = []
        for r in records:
            updated = _dt(r["updated_at"])
            max_ts = max(max_ts, updated)
            rows.append([r["campaign_id"], r["tenant_id"], r["name"], r["channel"],
                         r.get("target_segment", ""), _dt(r["start_date"]).date(),
                         _dt(r["end_date"]).date(), _money(r.get("spend", 0)), updated])
        total += _insert("dim_campaign", CAMPAIGN_COLUMNS, rows)
        since = _dt(page.get("watermark")) or max_ts
        cursor_id = str(page.get("cursor_id") or "")
        if not page.get("has_more"):
            break
    write_watermark(source, entity, max_ts, total, cursor_id=cursor_id)
    _collapse("dim_campaign", total)
    return total


def load_campaign_interactions(full: bool = False) -> int:
    entity, source = "campaign_interactions", "nexabank_crm"
    since = EPOCH if full else read_watermark(source, entity)
    cursor_id = "" if full else read_cursor_id(source, entity)
    now = datetime.utcnow()
    total, max_ts = 0, since
    for _ in range(MAX_PAGES):
        page = _fetch(entity, {"since": since.isoformat(), "since_id": cursor_id,
                               "limit": PAGE_SIZE})
        records = page.get("records") or []
        if not records:
            break
        rows = []
        for r in records:
            occurred = _dt(r["occurred_at"])
            max_ts = max(max_ts, occurred)
            rows.append([r["interaction_id"], r["tenant_id"], r["campaign_id"],
                         r.get("campaign_name", ""), r.get("channel", ""), r["customer_id"],
                         r["interaction_type"], r.get("risk_segment", ""), r.get("region", ""),
                         r.get("country", ""), occurred, now, occurred])
        total += _insert("fact_campaign_interactions", INTERACTION_COLUMNS, rows)
        since = _dt(page.get("watermark")) or max_ts
        cursor_id = str(page.get("cursor_id") or "")
        if not page.get("has_more"):
            break
    write_watermark(source, entity, max_ts, total, cursor_id=cursor_id)
    _collapse("fact_campaign_interactions", total)
    return total


def load_crm(full: bool = False) -> dict:
    """Source B, one weekly batch."""
    counts = {
        "customers": load_customers(),
        "campaigns": load_campaigns(full),
        "campaign_interactions": load_campaign_interactions(full),
    }
    rows = _ch().query(
        f"SELECT tenant_id, max(occurred_at) AS m, count() AS n "
        f"FROM {DB}.fact_campaign_interactions GROUP BY tenant_id")
    for row in rows:
        record_freshness("nexabank_crm", str(row["tenant_id"]), row["m"], int(row["n"]))
    return counts


# -- source C: branch operations and macro environment ----------------------
# Entities whose rows carry a COPY of a branch attribute (region, country). They are watermarked
# on their own mutation clock, which a branch edit never touches -- so without this the analytics
# copy keeps the old geography forever. Same class of staleness the transaction extract documents
# for status, one level up.
# NB: the entity name is the loader's OWN watermark key, not the table it writes.
# `load_account_openings` writes fact_account_openings but registers as "accounts" -- resetting
# "account_openings" silently created a phantom row and reset nothing.
BRANCH_DERIVED_FEEDS = [
    ("nexabank_core", "transactions"),          # fact_transactions.region/country
    ("nexabank_core", "accounts"),              # fact_account_openings.region/country
    ("nexabank_core", "cards"),                 # fact_cards.region/country
    ("nexabank_crm", "campaign_interactions"),  # fact_campaign_interactions.region/country
    ("nexabank_crm", "customers"),              # dim_customer.region/country
]


def _branch_fingerprint(branches: list[dict]) -> str:
    """What a downstream row copies. Name and headcount are excluded: nothing denormalises them."""
    parts = sorted("%s|%s|%s" % (b.get("branch_code", ""), b.get("region", ""),
                                 b.get("country", "")) for b in branches)
    return hashlib.sha1(chr(10).join(parts).encode("utf-8")).hexdigest()


def _invalidate_on_branch_change(branches: list[dict], retired: int) -> list[str]:
    """Reset the watermarks of every feed that denormalises a branch attribute, when one changed.

    A watermarked extract cursors on the ENTITY's own `updatedOn`. Re-pointing a branch, or
    renaming its region, touches no transaction row, so the next incremental load reads nothing and
    `fact_transactions.region` keeps a value the source no longer holds. Resetting the watermark
    makes the following core/CRM load re-read in full, which is the only way the copy catches up.
    """
    client = _client()
    try:
        rows = client.query(
            f"SELECT cursor_id FROM {DB}.ingest_watermarks FINAL "
            "WHERE source_id = 'market_ops' AND entity = 'branch_fingerprint'").result_rows
        previous = rows[0][0] if rows else ""
    except Exception:
        previous = ""
    finally:
        try:
            client.close()
        except Exception:
            pass

    current = _branch_fingerprint(branches)
    if previous == current and not retired:
        return []

    for source_id, entity in BRANCH_DERIVED_FEEDS:
        write_watermark(source_id, entity, EPOCH, 0, cursor_id="")
    write_watermark("market_ops", "branch_fingerprint", datetime.utcnow(), len(branches),
                    cursor_id=current)
    return ["%s/%s" % (s, e) for s, e in BRANCH_DERIVED_FEEDS]


def load_market_ops(tenants: list[str] | None = None) -> dict:
    """Source C. Fully re-read every time: monthly reference data has no change feed, and
    re-reading a few hundred rows is cheaper than tracking a cursor for them."""
    now = datetime.utcnow()

    page = _fetch("branches", {})
    branches = page.get("records") or []
    branch_rows = [[b["branch_code"], b["tenant_id"], b["name"], b["region"],
                    b.get("country", ""), b["city"],
                    b["manager_name"], int(b.get("staffing_headcount", 0)),
                    _dt(b["opened_at"]), now, now] for b in branches]
    n_branch = _insert("dim_branch", BRANCH_COLUMNS, branch_rows)

    page = _fetch("macro_environment", {})
    macro = page.get("records") or []
    macro_rows = [[m["region"], m["month_year"], _rate(m["competitor_deposit_rate"]),
                   _rate(m["central_bank_base_rate"]), _rate(m["regional_unemployment_rate"]),
                   _dt(m["recorded_at"]), now, now] for m in macro]
    n_macro = _insert("dim_macro_environment", MACRO_COLUMNS, macro_rows)

    # Safe here and nowhere else: this source re-reads in full, so a key missing from the batch
    # has genuinely been retired. Macro reconciles on region, not (region, month): a month falling
    # out of the rolling window is history, not a deletion.
    dropped_branches = _reconcile("dim_branch", "branch_code",
                                  [b["branch_code"] for b in branches])
    invalidated = _invalidate_on_branch_change(branches, dropped_branches)
    dropped_macro = _reconcile("dim_macro_environment", "region",
                               [m["region"] for m in macro])

    latest = max((_dt(m["recorded_at"]) for m in macro), default=now)
    for tenant in (tenants or []):
        record_freshness("market_ops", tenant, latest, n_branch + n_macro)
    return {"branches": n_branch, "macro_environment": n_macro,
            "retired_branch_rows": dropped_branches, "retired_macro_rows": dropped_macro,
            "invalidated_watermarks": invalidated}


def load_core_banking(full: bool = False) -> dict:
    """Source 2, one hourly batch. Freshness is recorded per tenant from what actually landed."""
    counts = {
        "transactions": load_transactions(full),
        "loan_applications": load_loan_applications(full),
        "account_openings": load_account_openings(full),
        "cards": load_cards(full),
    }
    rows = _ch().query(
        f"SELECT tenant_id, max(occurred_at) AS m, count() AS n FROM {DB}.fact_transactions "
        "GROUP BY tenant_id")
    for row in rows:
        record_freshness("nexabank_core", str(row["tenant_id"]), row["m"], int(row["n"]))
    return counts


# ── source 3: reference data ────────────────────────────────────────────────
def seed_reference_data(tenants: list[str], days_back: int = 400, days_forward: int = 30) -> dict:
    """Slow-changing reference the bank does not own: fee schedule and trading calendar.

    Deterministic and idempotent -- ReplacingMergeTree keys mean re-seeding overwrites in place.
    """
    now = datetime.utcnow()
    today = now.date()

    fee_rows, cal_rows = [], []
    for tenant in tenants:
        # Price side of fee revenue. Without it there is no price factor to decompose.
        # One row per (txn_type, channel) the bank actually transacts on. A channel with no row
        # earns no fee, so a missing row silently removes it from revenue.
        for txn_type, channel, flat, pct in [
            ("TRANSFER", "WEB", "2.50", "0.0010"), ("TRANSFER", "MOBILE", "1.50", "0.0008"),
            ("WITHDRAWAL", "WEB", "5.00", "0.0000"), ("WITHDRAWAL", "MOBILE", "4.00", "0.0000"),
            ("WITHDRAWAL", "ATM", "2.00", "0.0000"), ("WITHDRAWAL", "POS", "1.00", "0.0000"),
            ("DEPOSIT", "WEB", "0.00", "0.0000"), ("DEPOSIT", "MOBILE", "0.00", "0.0000"),
            ("DEPOSIT", "ATM", "0.00", "0.0000"),
            ("PAYMENT", "WEB", "3.00", "0.0012"), ("PAYMENT", "MOBILE", "2.00", "0.0010"),
            # Card-present interchange: no flat fee, a percentage of the ticket.
            ("PAYMENT", "POS", "0.00", "0.0150"),
        ]:
            fee_rows.append([tenant, txn_type, channel, Decimal(flat), Decimal(pct),
                             today - timedelta(days=days_back), date(2099, 12, 31), now])

        for offset in range(-days_back, days_forward):
            day = today + timedelta(days=offset)
            is_weekend = 1 if day.weekday() >= 5 else 0
            next_day = day + timedelta(days=1)
            is_month_end = 1 if next_day.day == 1 else 0
            # Indian retail-banking calendar: quarter ends and the festive quarter drive volume.
            month = day.month
            season = ("festive" if month in (10, 11) else
                      "quarter_end" if month in (3, 6, 9, 12) else "regular")
            is_holiday = 1 if (month == 1 and day.day == 26) or (month == 8 and day.day == 15) else 0
            label = "republic_day" if (month == 1 and day.day == 26) else (
                "independence_day" if (month == 8 and day.day == 15) else "")
            cal_rows.append([day, tenant, is_holiday, is_weekend, is_month_end, season, label, now])

    n_fee = _insert("dim_fee_schedule",
                    ["tenant_id", "txn_type", "channel", "fee_flat", "fee_pct", "valid_from",
                     "valid_to", "_version"], fee_rows)
    n_cal = _insert("dim_calendar",
                    ["calendar_date", "tenant_id", "is_holiday", "is_weekend", "is_month_end",
                     "season", "label", "_version"], cal_rows)
    # dim_campaign is NOT seeded here any more: campaigns are real rows from the CRM extract
    # (load_campaigns). CPA divides by a spend figure, and inventing that number would make every
    # CPA the engine reports a fiction.
    for tenant in tenants:
        record_freshness("reference_data", tenant, now, n_fee + n_cal)
    return {"fee_schedule": n_fee, "calendar": n_cal}


def record_clickstream_freshness(tenants: list[str]) -> None:
    """Source 1's freshness, so all three sources report through one table."""
    for tenant in tenants:
        rows = _ch().query(
            f"SELECT max(timestamp) AS m, count() AS n FROM {DB}.events_raw "
            "WHERE tenant_id = %(t)s", {"t": tenant})
        if rows and rows[0]["m"]:
            record_freshness("nexabank_clickstream", tenant, rows[0]["m"], int(rows[0]["n"]))
