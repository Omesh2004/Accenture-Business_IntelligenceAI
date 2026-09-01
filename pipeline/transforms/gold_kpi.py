"""`silver.fact_*` -> `gold.kpi_daily` + `gold.kpi_daily_by_dim`.

The five KPIs, their fundamentals, and their day-attribution column, per
`docs/INTERFACES/kpi_rollups.md` (decisions D1/D2). Rates store their two counts, never the
ratio. Loan approval volume attributes on `decided_at`. The segment cube is built over the
MEASURED fact columns only.

Rebuild is windowed and idempotent: for the target window, delete the existing rows, then
INSERT ... SELECT ... GROUP BY, then OPTIMIZE ... FINAL. Re-running produces byte-identical
`gold.*` rows (the Phase 7 determinism gate).

Revenue (provisional until Track C's `revenue.yaml`):
  fee_revenue      = SUCCESS fact_transactions ⨝ dim_fee_schedule on (txn_type, channel), valid-dated
  interest_accrued = flat daily accrual: each day, sum over APPROVED apps decided on/before that
                     day of principal * rate / 365   (not amortised)
  pro_revenue      = SUCCESS fact_transactions where txn_type = 'PRO_LICENSE_FEE'
"""
from __future__ import annotations

import json as _json
import logging
from datetime import date, datetime, timedelta, timezone

from warehouse.client import ch_client

logger = logging.getLogger(__name__)
GOLD, SILVER = "gold", "silver"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _exec(sql: str, params: dict | None = None, settings: dict | None = None) -> None:
    client = ch_client._get_client()
    try:
        client.command(sql, parameters=params or {}, settings=settings or {})
    finally:
        try:
            client.close()
        except Exception:
            pass


# ── one fundamental = one spec ──────────────────────────────────────────────
# t       : the tenant_id expression (e.g. "a.tenant_id")
# d       : the day expression       (e.g. "toDate(a.decided_at)")
# frm     : everything after FROM, including the WHERE clause it starts
# value   : aggregate expr for `value`
# distinct: aggregate expr for `distinct_count` (0 where N/A)
# dims    : {dimension_name: sql_expr}
# xtra_where (optional): appended with AND to bound the day window (defaults to `d`)
SPECS: list[dict] = [
    dict(kpi="signups", fund="accounts_opened",
         t="tenant_id", d="toDate(opened_at)",
         frm=f"{SILVER}.fact_account_openings",
         where="1=1",
         value="toFloat64(count())", distinct="uniqExact(account_no)",
         dims={"account_type": "account_type", "branch_code": "branch_code",
               "region": "region", "country": "country"}),

    dict(kpi="kyc_completion_rate", fund="kyc_started",
         t="a.tenant_id", d="toDate(a.created_at)",
         frm=f"{SILVER}.fact_loan_applications a LEFT JOIN {SILVER}.dim_customer c "
             f"ON a.tenant_id=c.tenant_id AND a.customer_id=c.customer_id",
         where="a.kyc_step >= 1",
         value="toFloat64(count())", distinct="uniqExact(a.application_id)",
         dims={"loan_type": "a.loan_type", "risk_segment": "c.risk_segment",
               "region": "c.region", "branch_code": "c.branch_code"}),
    dict(kpi="kyc_completion_rate", fund="kyc_completed",
         t="a.tenant_id", d="toDate(a.created_at)",
         frm=f"{SILVER}.fact_loan_applications a LEFT JOIN {SILVER}.dim_customer c "
             f"ON a.tenant_id=c.tenant_id AND a.customer_id=c.customer_id",
         where="a.kyc_step >= 3",
         value="toFloat64(count())", distinct="uniqExact(a.application_id)",
         dims={"loan_type": "a.loan_type", "risk_segment": "c.risk_segment",
               "region": "c.region", "branch_code": "c.branch_code"}),

    dict(kpi="loan_approval_volume", fund="loans_approved",
         t="a.tenant_id", d="toDate(a.decided_at)",
         frm=f"{SILVER}.fact_loan_applications a LEFT JOIN {SILVER}.dim_customer c "
             f"ON a.tenant_id=c.tenant_id AND a.customer_id=c.customer_id",
         where="a.status = 'APPROVED' AND a.decided_at > toDateTime('1971-01-01')",
         value="toFloat64(count())", distinct="uniqExact(a.application_id)",
         dims={"loan_type": "a.loan_type", "risk_segment": "c.risk_segment", "region": "c.region"}),
    dict(kpi="loan_approval_volume", fund="principal_approved",
         t="a.tenant_id", d="toDate(a.decided_at)",
         frm=f"{SILVER}.fact_loan_applications a LEFT JOIN {SILVER}.dim_customer c "
             f"ON a.tenant_id=c.tenant_id AND a.customer_id=c.customer_id",
         where="a.status = 'APPROVED' AND a.decided_at > toDateTime('1971-01-01')",
         value="round(toFloat64(sum(a.principal_amount)), 2)", distinct="toUInt64(0)",
         dims={"loan_type": "a.loan_type", "risk_segment": "c.risk_segment", "region": "c.region"}),

    dict(kpi="transaction_failure_rate", fund="txn_total",
         t="tenant_id", d="toDate(occurred_at)",
         frm=f"{SILVER}.fact_transactions",
         where="1=1",
         value="toFloat64(count())", distinct="uniqExact(txn_id)",
         dims={"channel": "channel", "txn_type": "txn_type", "mcc": "mcc",
               "region": "region", "branch_code": "branch_code"}),
    dict(kpi="transaction_failure_rate", fund="txn_failed",
         t="tenant_id", d="toDate(occurred_at)",
         frm=f"{SILVER}.fact_transactions",
         where="status = 'FAILED'",
         value="toFloat64(count())", distinct="uniqExact(txn_id)",
         dims={"channel": "channel", "txn_type": "txn_type", "mcc": "mcc",
               "region": "region", "branch_code": "branch_code"}),

    dict(kpi="revenue", fund="pro_revenue",
         t="tenant_id", d="toDate(occurred_at)",
         frm=f"{SILVER}.fact_transactions",
         where="status = 'SUCCESS' AND txn_type = 'PRO_LICENSE_FEE'",
         value="round(toFloat64(sum(amount)), 2)", distinct="toUInt64(0)",
         dims={"channel": "channel", "region": "region", "branch_code": "branch_code"}),

    # ClickHouse 24.3 rejects a non-equi join condition even when written in WHERE (it treats a
    # cross-table predicate as a join condition). The fee schedule is resolved to its currently
    # valid row per (txn_type, channel) in a subquery, so the join is pure equi.
    dict(kpi="revenue", fund="fee_revenue",
         t="t.tenant_id", d="toDate(t.occurred_at)",
         frm=f"""{SILVER}.fact_transactions t
INNER JOIN (
    SELECT txn_type, channel,
           argMax(fee_flat, valid_from) AS fee_flat, argMax(fee_pct, valid_from) AS fee_pct
    FROM {SILVER}.dim_fee_schedule FINAL
    WHERE valid_from <= today() AND valid_to > today()
    GROUP BY txn_type, channel
) f ON t.txn_type = f.txn_type AND t.channel = f.channel""",
         where="t.status = 'SUCCESS'",
         value="round(toFloat64(sum(f.fee_flat + t.amount * f.fee_pct)), 2)", distinct="toUInt64(0)",
         dims={"channel": "t.channel", "txn_type": "t.txn_type", "mcc": "t.mcc",
               "region": "t.region", "branch_code": "t.branch_code"}),

    # interest_accrued: a date-series cross join. `d` is the series day; the window bound is
    # baked into the series itself, so `win_bound=False` skips the usual `AND <d> >= start ...`.
    dict(kpi="revenue", fund="interest_accrued", win_bound=False,
         t="a.tenant_id", d="days.d",
         frm=f"""(SELECT toDate(%(start)s) + number AS d FROM numbers(toUInt64(%(ndays)s))) days
CROSS JOIN {SILVER}.fact_loan_applications a
LEFT JOIN {SILVER}.dim_customer c ON a.tenant_id=c.tenant_id AND a.customer_id=c.customer_id""",
         where="a.status = 'APPROVED' AND a.decided_at > toDateTime('1971-01-01') "
               "AND toDate(a.decided_at) <= days.d",
         # interest_rate is a percent (7..14), not a fraction.
         value="round(toFloat64(sum(a.principal_amount * a.interest_rate / 100 / 365)), 2)",
         distinct="toUInt64(0)",
         dims={"loan_type": "a.loan_type", "risk_segment": "c.risk_segment", "region": "c.region"}),
]


def _win_clause(s: dict) -> str:
    if s.get("win_bound") is False:
        return ""
    return f" AND {s['d']} >= %(start)s AND {s['d']} < %(end)s"


def _daily_sql(s: dict) -> str:
    return f"""
INSERT INTO {GOLD}.kpi_daily
SELECT {s['t']} AS tenant_id, '{s['kpi']}' AS kpi_id, {s['d']} AS date,
       '{s['fund']}' AS fundamental, {s['value']} AS value,
       toUInt64({s['distinct']}) AS distinct_count, toUInt64(count()) AS raw_rows,
       now() AS _version
FROM {s['frm']}
WHERE {s['where']}{_win_clause(s)}
GROUP BY tenant_id, date
"""


def _by_dim_sql(s: dict, dim: str, expr: str) -> str:
    return f"""
INSERT INTO {GOLD}.kpi_daily_by_dim
SELECT {s['t']} AS tenant_id, '{s['kpi']}' AS kpi_id, {s['d']} AS date,
       '{s['fund']}' AS fundamental, '{dim}' AS dimension, toString({expr}) AS value_key,
       {s['value']} AS value, toUInt64({s['distinct']}) AS distinct_count,
       toUInt64(count()) AS raw_rows, now() AS _version
FROM {s['frm']}
WHERE {s['where']}{_win_clause(s)}
GROUP BY tenant_id, date, value_key
"""


def _cells_sql(s: dict) -> str:
    """The leaf cell: every dimension of this KPI at once, which is what PSqueeze searches."""
    dims = sorted(s["dims"])
    keyparts = " , '|' , ".join(f"'{d}=' , toString({s['dims'][d]})" for d in dims)
    arr_dims = ", ".join(f"'{d}'" for d in dims)
    arr_vals = ", ".join(f"toString({s['dims'][d]})" for d in dims)
    group = ", ".join(f"toString({s['dims'][d]})" for d in dims)
    return f"""
INSERT INTO {GOLD}.kpi_cells
SELECT {s['t']} AS tenant_id, '{s['kpi']}' AS kpi_id, {s['d']} AS date,
       '{s['fund']}' AS fundamental,
       concat({keyparts}) AS cell_key,
       [{arr_dims}] AS dims, [{arr_vals}] AS vals,
       {s['value']} AS value, now() AS _version
FROM {s['frm']}
WHERE {s['where']}{_win_clause(s)}
GROUP BY tenant_id, date, {group}
"""


def _window(days: int) -> tuple[date, date]:
    end = _now().date() + timedelta(days=1)
    return end - timedelta(days=days), end


def run(days: int = 120) -> dict:
    start, end = _window(days)
    p = {"start": start, "end": end, "ndays": (end - start).days}
    ms = {"mutations_sync": 1}

    _exec(f"ALTER TABLE {GOLD}.kpi_daily DELETE WHERE date >= %(start)s AND date < %(end)s", p, ms)
    _exec(f"ALTER TABLE {GOLD}.kpi_daily_by_dim DELETE WHERE date >= %(start)s AND date < %(end)s", p, ms)
    _exec(f"ALTER TABLE {GOLD}.kpi_cells DELETE WHERE date >= %(start)s AND date < %(end)s", p, ms)

    for s in SPECS:
        _exec(_daily_sql(s), p)
        for dim, expr in s["dims"].items():
            _exec(_by_dim_sql(s, dim, expr), p)
        if s["dims"]:
            _exec(_cells_sql(s), p)

    _exec(f"OPTIMIZE TABLE {GOLD}.kpi_cells FINAL")
    _exec(f"OPTIMIZE TABLE {GOLD}.kpi_daily FINAL")
    _exec(f"OPTIMIZE TABLE {GOLD}.kpi_daily_by_dim FINAL")

    rows = ch_client.query(
        f"SELECT kpi_id, fundamental, count() AS days, round(sum(value), 2) AS total "
        f"FROM {GOLD}.kpi_daily FINAL GROUP BY kpi_id, fundamental ORDER BY kpi_id, fundamental")
    return {f"{r['kpi_id']}.{r['fundamental']}": {"days": r["days"], "total": r["total"]}
            for r in rows}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(_json.dumps(run(), indent=2, default=str))
