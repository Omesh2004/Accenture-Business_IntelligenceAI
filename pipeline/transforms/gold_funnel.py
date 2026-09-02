"""`silver.events` -> `gold.funnel_daily`  (stage / abandonment detail only — never a KPI rate).

The KYC and transaction rates themselves come from `silver.fact_*` (gold_kpi.py). This table
answers "which step did they abandon", for the dashboard funnel and the journey view.

A stage counts DISTINCT USERS who reached it, and only those who reached the stage before it
first. Two things this fixes, both of which made the funnel untrustworthy:

  - counting distinct sessions per day and summing across days is not a distinct count over the
    window. A user active on four days was counted four times, and by a different factor at each
    stage, so the shape of the funnel was an artefact of how often people came back;
  - stages were counted independently, so a loan application whose KYC start fell outside the
    window landed at stage 3 without ever passing stage 1. Nothing stopped a later stage from
    being larger than an earlier one, which is not a funnel.

The per-day rows carry a uniqExact STATE, so the reader merges them into one distinct count over
whatever window it asks for instead of adding daily numbers together.

Idempotent: windowed ALTER DELETE + INSERT ... SELECT + OPTIMIZE FINAL.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from warehouse.client import ch_client

logger = logging.getLogger(__name__)
GOLD, SILVER = "gold", "silver"

# funnel_id -> [(stage, order, [event names counting as the stage], prerequisite stage or None)]
# The prerequisite is what makes it a funnel rather than five unrelated counts.
FUNNELS: dict[str, list[tuple[str, int, list[str], str | None]]] = {
    "kyc_funnel": [
        ("kyc_started", 1, ["loan.kyc_started.success"], None),
        ("kyc_completed", 2, ["loan.kyc_completed.success"], "kyc_started"),
        ("loan_applied", 3, ["loan.applied.success"], "kyc_completed"),
        ("loan_approved", 4, ["loan.approved.success"], "loan_applied"),
        # Abandonment is a leak off stage 1, not a step after stage 4.
        ("kyc_abandoned", 9, ["loan.kyc_abandoned.failure", "loan.kyc_failed.failure"],
         "kyc_started"),
    ],
}


def _chain(stages: list[tuple], stage: str) -> list[tuple]:
    """The stage and every stage it depends on, earliest first."""
    by_name = {st[0]: st for st in stages}
    out: list[tuple] = []
    cur = by_name.get(stage)
    while cur is not None:
        out.append(cur)
        cur = by_name.get(cur[3]) if cur[3] else None
    return list(reversed(out))


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
        for stage, order, _names, _req in stages:
            chain = _chain(stages, stage)
            # One first-touch timestamp per user per step in the chain.
            firsts, guards = [], []
            for i, (st, _o, names, _r) in enumerate(chain):
                in_list = ",".join(f"'{n}'" for n in names)
                firsts.append(f"minIf(timestamp, event_name IN ({in_list})) AS t{i}")
                firsts.append(f"countIf(event_name IN ({in_list})) AS c{i}")
                guards.append(f"c{i} > 0")
                if i:
                    guards.append(f"t{i} >= t{i - 1}")
            last = len(chain) - 1
            _exec(f"""
INSERT INTO {GOLD}.funnel_daily
    (tenant_id, funnel_id, date, stage, stage_order, entered, events, entered_users, _version)
SELECT tenant_id, '{funnel_id}' AS funnel_id, date, '{stage}' AS stage,
       {order} AS stage_order,
       toUInt64(uniqExact(user_id)) AS entered,
       toUInt64(sum(hits)) AS events,
       uniqExactState(user_id) AS entered_users,
       now() AS _version
FROM (
    SELECT tenant_id, user_id, toDate(t{last}) AS date, c{last} AS hits
    FROM (
        SELECT tenant_id, user_id, {', '.join(firsts)}
        FROM {SILVER}.events
        WHERE event_date >= %(start)s AND event_date < %(end)s
        GROUP BY tenant_id, user_id
    )
    -- The user reached every earlier step, and reached them in order.
    WHERE {' AND '.join(guards)}
)
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
