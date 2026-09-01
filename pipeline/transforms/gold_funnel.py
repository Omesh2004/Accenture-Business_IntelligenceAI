"""`silver.events` -> `gold.funnel_daily`  (stage / abandonment detail only — never a KPI rate).

The KYC and transaction rates themselves come from `silver.fact_*` (gold_kpi.py). This table
answers "which step did they abandon", for the dashboard funnel and the journey view.

Idempotent: windowed ALTER DELETE + INSERT ... SELECT + OPTIMIZE FINAL.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from warehouse.client import ch_client

logger = logging.getLogger(__name__)
GOLD, SILVER = "gold", "silver"

# funnel_id -> [(stage, order, [canonical event names that count as reaching the stage])]
FUNNELS: dict[str, list[tuple[str, int, list[str]]]] = {
    "kyc_funnel": [
        ("kyc_started", 1, ["loan.kyc_started.success"]),
        ("kyc_completed", 2, ["loan.kyc_completed.success"]),
        ("loan_applied", 3, ["loan.applied.success"]),
        ("loan_approved", 4, ["loan.approved.success"]),
        ("kyc_abandoned", 9, ["loan.kyc_abandoned.failure", "loan.kyc_failed.failure"]),
    ],
    "txn_funnel": [
        ("txn_page_view", 1, ["transaction.page.view"]),
        ("pay_now_success", 2, ["transaction.pay_now.success"]),
        ("pay_now_failure", 8, ["transaction.pay_now.failure"]),
        ("transfer_success", 3, ["transaction.transfer.success"]),
        ("transfer_failure", 8, ["transaction.transfer.failure"]),
    ],
}


def _exec(sql: str, params: dict | None = None, settings: dict | None = None) -> None:
    client = ch_client._get_client()
    try:
        client.command(sql, parameters=params or {}, settings=settings or {})
    finally:
        try:
            client.close()
        except Exception:
            pass


def _window(days: int) -> tuple[date, date]:
    end = datetime.now(timezone.utc).date() + timedelta(days=1)
    return end - timedelta(days=days), end


def run(days: int = 120) -> dict:
    start, end = _window(days)
    p = {"start": start, "end": end}
    _exec(f"ALTER TABLE {GOLD}.funnel_daily DELETE WHERE date >= %(start)s AND date < %(end)s",
          p, {"mutations_sync": 1})

    for funnel_id, stages in FUNNELS.items():
        for stage, order, names in stages:
            in_list = ",".join(f"'{n}'" for n in names)
            _exec(f"""
INSERT INTO {GOLD}.funnel_daily
SELECT tenant_id, '{funnel_id}' AS funnel_id, event_date AS date, '{stage}' AS stage,
       {order} AS stage_order, toUInt64(uniqExact(session_id)) AS entered,
       toUInt64(count()) AS events, now() AS _version
FROM {SILVER}.events
WHERE event_name IN ({in_list})
  AND event_date >= %(start)s AND event_date < %(end)s
GROUP BY tenant_id, date
""", p)

    _exec(f"OPTIMIZE TABLE {GOLD}.funnel_daily FINAL")
    rows = ch_client.query(
        f"SELECT funnel_id, stage, sum(entered) AS e FROM {GOLD}.funnel_daily FINAL "
        f"GROUP BY funnel_id, stage ORDER BY funnel_id, stage")
    return {f"{r['funnel_id']}.{r['stage']}": int(r["e"]) for r in rows}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run())
