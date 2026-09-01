"""Reference data — fee schedule + trading calendar.

Slow-changing reference the bank does not own. Track B's Phase-0 default (D8 / sync-doc A5):
**Track B synthesises these** until/unless NexaBank exposes `/api/extract/fee_schedule` and
`/api/extract/calendar`. Written straight to `silver.dim_*` — there is no measured source to
land in bronze first.

Deterministic and idempotent: `ReplacingMergeTree` keys mean a re-run overwrites in place.
Ported from `api/intelligence/loaders.py::seed_reference_data`.

CASING: `channel` is written UPPERCASE (`WEB`/`MOBILE`/`ATM`/`POS`) and `txn_type` uppercase,
matching `silver.fact_transactions` (NexaBank's `TransactionChannel` / `TransactionType` enums
are uppercase). The `(txn_type, channel)` fee join in `gold_kpi.py` depends on this.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from warehouse.client import ch_client
from pipeline.extract.freshness import record_freshness

logger = logging.getLogger(__name__)
SILVER = "silver"

# One row per (txn_type, channel) the bank transacts on. A channel with no row earns no fee and
# silently vanishes from fee_revenue — that is intentional and matches DATA_MODEL.md.
FEE_SCHEDULE = [
    ("TRANSFER", "WEB", "2.50", "0.0010"), ("TRANSFER", "MOBILE", "1.50", "0.0008"),
    ("WITHDRAWAL", "WEB", "5.00", "0.0000"), ("WITHDRAWAL", "MOBILE", "4.00", "0.0000"),
    ("WITHDRAWAL", "ATM", "2.00", "0.0000"), ("WITHDRAWAL", "POS", "1.00", "0.0000"),
    ("DEPOSIT", "WEB", "0.00", "0.0000"), ("DEPOSIT", "MOBILE", "0.00", "0.0000"),
    ("DEPOSIT", "ATM", "0.00", "0.0000"),
    ("PAYMENT", "WEB", "3.00", "0.0012"), ("PAYMENT", "MOBILE", "2.00", "0.0010"),
    ("PAYMENT", "POS", "0.00", "0.0150"),   # card-present interchange: % of ticket, no flat
    ("PRO_LICENSE_FEE", "WEB", "0.00", "0.0000"), ("PRO_LICENSE_FEE", "MOBILE", "0.00", "0.0000"),
]


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _insert(table: str, columns: list[str], rows: list[list]) -> int:
    if not rows:
        return 0
    client = ch_client._get_client()
    try:
        client.insert(f"{SILVER}.{table}", rows, column_names=columns)
        client.command(f"OPTIMIZE TABLE {SILVER}.{table} FINAL")
        return len(rows)
    finally:
        try:
            client.close()
        except Exception:
            pass


def run(tenants: list[str], days_back: int = 400, days_forward: int = 30) -> dict:
    now = _now()
    today = now.date()
    fee_rows, cal_rows = [], []
    for tenant in tenants:
        for txn_type, channel, flat, pct in FEE_SCHEDULE:
            fee_rows.append([tenant, txn_type, channel, Decimal(flat), Decimal(pct),
                             today - timedelta(days=days_back), date(2099, 12, 31), now])
        for offset in range(-days_back, days_forward):
            day = today + timedelta(days=offset)
            is_weekend = 1 if day.weekday() >= 5 else 0
            is_month_end = 1 if (day + timedelta(days=1)).day == 1 else 0
            month = day.month
            season = ("festive" if month in (10, 11) else
                      "quarter_end" if month in (3, 6, 9, 12) else "regular")
            is_holiday = 1 if (month == 1 and day.day == 26) or (month == 8 and day.day == 15) else 0
            label = ("republic_day" if (month == 1 and day.day == 26) else
                     "independence_day" if (month == 8 and day.day == 15) else "")
            cal_rows.append([day, tenant, is_holiday, is_weekend, is_month_end, season, label, now])

    n_fee = _insert("dim_fee_schedule",
                    ["tenant_id", "txn_type", "channel", "fee_flat", "fee_pct", "valid_from",
                     "valid_to", "_version"], fee_rows)
    n_cal = _insert("dim_calendar",
                    ["calendar_date", "tenant_id", "is_holiday", "is_weekend", "is_month_end",
                     "season", "label", "_version"], cal_rows)
    for tenant in tenants:
        record_freshness("reference_data", tenant, now, n_fee + n_cal)
    return {"fee_schedule": n_fee, "calendar": n_cal}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run(["nexabank"]))
