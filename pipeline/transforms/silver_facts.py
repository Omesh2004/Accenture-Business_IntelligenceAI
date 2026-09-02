"""`bronze.core_banking` -> `silver.fact_*` / `silver.dim_*`.

For each entity: take the latest bronze row per `record_id` (by `_source_updated_at`, then
`_extracted_at` as the tie-break so a re-extracted status change still wins), parse `_raw`, map
to the silver schema, insert, then `OPTIMIZE ... FINAL` so the collapse happens at write and
nothing depends on an async merge that may never run.

Full-re-read dimensions (branch, customer) are also reconciled: a `record_id` absent from the
newest extraction has genuinely been retired, so its silver row is deleted.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation

from warehouse.client import ch_client

logger = logging.getLogger(__name__)
BRONZE, SILVER = "bronze", "silver"
EPOCH = datetime(1970, 1, 1)


def _money(v) -> Decimal:
    try:
        return Decimal(str(v if v is not None else 0)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0.00")


def _rate(v) -> Decimal:
    try:
        return Decimal(str(v if v is not None else 0)).quantize(Decimal("0.0001"))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0.0000")


def _dt(v) -> datetime:
    if not v:
        return EPOCH
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(
            timezone.utc).replace(tzinfo=None)
    except ValueError:
        return EPOCH


def _date(v) -> date:
    d = _dt(v)
    return d.date() if d != EPOCH else date(1970, 1, 1)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _latest_raws(entity: str) -> list[dict]:
    rows = ch_client.query(
        "SELECT argMax(_raw, (_source_updated_at, _extracted_at)) AS raw "
        f"FROM {BRONZE}.core_banking WHERE entity = %(e)s GROUP BY record_id",
        {"e": entity})
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["raw"]))
        except Exception:
            continue
    return out


def _write(table: str, columns: list[str], rows: list[list]) -> int:
    """silver.fact_* / silver.dim_* are FULLY derived from bronze.core_banking, so each run
    rebuilds the table wholesale: TRUNCATE then INSERT the current latest-per-record_id set.
    A stale row whose bronze source was purged/replaced would otherwise persist forever
    (ReplacingMergeTree only collapses rows that share a key)."""
    client = ch_client._get_client()
    try:
        client.command(f"TRUNCATE TABLE {SILVER}.{table}")
        if rows:
            client.insert(f"{SILVER}.{table}", rows, column_names=columns)
            client.command(f"OPTIMIZE TABLE {SILVER}.{table} FINAL")
        return len(rows)
    finally:
        try:
            client.close()
        except Exception:
            pass


def _reconcile(table: str, key_col: str, entity: str) -> int:
    """Delete silver rows whose key is gone from the NEWEST full extraction.

    Compared against a subquery over `bronze.core_banking` (not a literal IN list — that blew
    `max_query_size` at ~7k ids).
    """
    present_sq = (
        f"SELECT record_id FROM {BRONZE}.core_banking WHERE entity = '{entity}' "
        f"AND _extracted_at = (SELECT max(_extracted_at) FROM {BRONZE}.core_banking "
        f"WHERE entity = '{entity}')")
    client = ch_client._get_client()
    try:
        if not client.query(f"SELECT 1 FROM ({present_sq}) LIMIT 1").result_rows:
            return 0
        before = client.query(
            f"SELECT count() FROM {SILVER}.{table} FINAL WHERE {key_col} NOT IN ({present_sq})"
        ).result_rows[0][0]
        if before:
            client.command(
                f"ALTER TABLE {SILVER}.{table} DELETE WHERE {key_col} NOT IN ({present_sq})",
                settings={"mutations_sync": 1})
        return int(before)
    finally:
        try:
            client.close()
        except Exception:
            pass


# ── per-entity transforms ───────────────────────────────────────────────────
TXN_COLS = ["txn_id", "tenant_id", "customer_id", "account_no", "counterparty_acc", "direction",
            "branch_code", "region", "country", "txn_type", "category", "mcc", "merchant_name",
            "reference_number", "channel", "status", "amount", "occurred_at", "loaded_at",
            "_source_updated_at"]
APP_COLS = ["application_id", "tenant_id", "customer_id", "loan_type", "status",
            "principal_amount", "interest_rate", "term_months", "kyc_step", "created_at",
            "decided_at", "loaded_at", "_source_updated_at"]
OPENING_COLS = ["account_no", "tenant_id", "customer_id", "account_type", "lifecycle_status",
                "interest_rate", "branch_code", "region", "country", "opened_at", "loaded_at",
                "_source_updated_at"]
CUSTOMER_COLS = ["customer_id", "tenant_id", "age_bracket", "income_bracket", "employment_status",
                 "risk_segment", "lifetime_value", "kyc_status", "branch_code", "region",
                 "country", "loaded_at", "_source_updated_at"]
BRANCH_COLS = ["branch_code", "tenant_id", "name", "region", "country", "city", "manager_name",
               "staffing_headcount", "opened_at", "loaded_at", "_source_updated_at"]
CAMPAIGN_COLS = ["campaign_id", "tenant_id", "name", "channel", "segment", "start_date",
                 "end_date", "spend", "_source_updated_at"]


def _transactions() -> int:
    now = _now()
    rows = []
    for r in _latest_raws("transactions"):
        occurred = _dt(r.get("occurred_at"))
        rows.append([r.get("txn_id", ""), r.get("tenant_id", ""), r.get("customer_id", ""),
                     r.get("account_no", ""), r.get("counterparty_acc", ""), r.get("direction", ""),
                     r.get("branch_code", ""), r.get("region", ""), r.get("country", ""),
                     r.get("txn_type", ""), r.get("category", ""), r.get("mcc", ""),
                     r.get("merchant_name", ""), r.get("reference_number", ""),
                     r.get("channel", ""), r.get("status", ""), _money(r.get("amount")),
                     occurred, now, occurred])
    return _write("fact_transactions", TXN_COLS, rows)


def _loan_applications() -> int:
    now = _now()
    rows = []
    for r in _latest_raws("loan_applications"):
        rows.append([r.get("application_id", ""), r.get("tenant_id", ""), r.get("customer_id", ""),
                     r.get("loan_type", ""), r.get("status", ""), _money(r.get("principal_amount")),
                     _rate(r.get("interest_rate")), int(r.get("term_months") or 0),
                     int(r.get("kyc_step") or 0), _dt(r.get("created_at")),
                     _dt(r.get("decided_at")), now, _dt(r.get("updated_at"))])
    return _write("fact_loan_applications", APP_COLS, rows)


def _account_openings() -> int:
    now = _now()
    rows = []
    for r in _latest_raws("accounts"):
        opened = _dt(r.get("opened_at"))
        rows.append([r.get("account_no", ""), r.get("tenant_id", ""), r.get("customer_id", ""),
                     r.get("account_type", ""), r.get("lifecycle_status", ""),
                     _rate(r.get("interest_rate", 0)), r.get("branch_code", ""),
                     r.get("region", ""), r.get("country", ""), opened, now, opened])
    return _write("fact_account_openings", OPENING_COLS, rows)


def _customers(reconcile: bool = True) -> int:  # reconcile kept for signature compat
    now = _now()
    raws = _latest_raws("customers")
    rows = [[r.get("customer_id", ""), r.get("tenant_id", ""), r.get("age_bracket", ""),
             r.get("income_bracket", ""), r.get("employment_status", ""), r.get("risk_segment", ""),
             _money(r.get("lifetime_value", 0)), r.get("kyc_status", ""), r.get("branch_code", ""),
             r.get("region", ""), r.get("country", ""), now, now] for r in raws]
    n = _write("dim_customer", CUSTOMER_COLS, rows)
    return n


def _branches(reconcile: bool = True) -> int:  # reconcile kept for signature compat
    now = _now()
    raws = _latest_raws("branches")
    rows = [[r.get("branch_code", ""), r.get("tenant_id", ""), r.get("name", ""),
             r.get("region", ""), r.get("country", ""), r.get("city", ""),
             r.get("manager_name", ""), int(r.get("staffing_headcount") or 0),
             _dt(r.get("opened_at")), now, now] for r in raws]
    n = _write("dim_branch", BRANCH_COLS, rows)
    return n


def _campaigns() -> int:
    now = _now()
    rows = [[r.get("campaign_id", ""), r.get("tenant_id", ""), r.get("name", ""),
             r.get("channel", ""), r.get("target_segment", ""), _date(r.get("start_date")),
             _date(r.get("end_date")), _money(r.get("spend", 0)), now]
            for r in _latest_raws("campaigns")]
    return _write("dim_campaign", CAMPAIGN_COLS, rows)


def run(reconcile: bool = True) -> dict:
    """`reconcile=False` (used by the dev seeder) skips the retire-missing-dim-rows step, which
    would otherwise delete every real customer/branch when the newest bronze batch is a seed."""
    return {
        "fact_transactions": _transactions(),
        "fact_loan_applications": _loan_applications(),
        "fact_account_openings": _account_openings(),
        "dim_customer": _customers(reconcile),
        "dim_branch": _branches(reconcile),
        "dim_campaign": _campaigns(),
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run())
