"""Fact reads for sources 2 and 3 (core banking, reference data).

A fundamental is either EVENT-based (clickstream, `event`/`events`) or FACT-based (`table`).
Fact specs name their own table, measure and aggregation, so a KPI can span sources at different
grains without any stage knowing which source it came from.
"""
from __future__ import annotations

from datetime import datetime

from api.intelligence.metrics import DB, Series, Window

FACT_TABLES = {
    "fact_transactions": {"time_col": "occurred_at", "grain": "transaction",
                          "source": "nexabank_core"},
    "fact_loan_applications": {"time_col": "created_at", "grain": "application",
                               "source": "nexabank_core"},
    "fact_account_openings": {"time_col": "opened_at", "grain": "account",
                              "source": "nexabank_core"},
    "fact_cards": {"time_col": "issued_at", "grain": "card", "source": "nexabank_core"},
    "fact_campaign_interactions": {"time_col": "occurred_at", "grain": "interaction",
                                   "source": "nexabank_crm"},
}

# Only these may appear in a contract. All are exact; nothing approximate can enter a KPI.
FACT_AGGREGATIONS = {"sum", "count", "uniqExact", "min", "max"}


def _sql(spec: dict, window: Window, tenant_id: str):
    """(select, from, where, params). FINAL so a mutated row is read once, at its latest state."""
    table = spec["table"]
    if table not in FACT_TABLES:
        raise ValueError("unknown fact table %r" % table)
    agg = str(spec.get("aggregation", "sum"))
    if agg not in FACT_AGGREGATIONS:
        raise ValueError("aggregation %r is not allowed in a contract" % agg)

    meta = FACT_TABLES[table]
    time_col = meta["time_col"]
    if meta.get("snapshot"):
        # A snapshot is Date-typed and must never be summed across dates.
        clause = "%s >= toDate(%%(w_start)s) AND %s < toDate(%%(w_end)s)" % (time_col, time_col)
    else:
        clause = "%s >= %%(w_start)s AND %s < %%(w_end)s" % (time_col, time_col)

    where = "tenant_id = %(tenant_id)s AND " + clause
    params = {"tenant_id": tenant_id, **window.params()}

    for i, (key, value) in enumerate(sorted((spec.get("filter") or {}).items())):
        if isinstance(value, (list, tuple)):
            params["f%d" % i] = tuple(value) or ("",)
            where += " AND %s IN %%(f%d)s" % (key, i)
        else:
            params["f%d" % i] = value
            where += " AND %s = %%(f%d)s" % (key, i)

    # `exclude` is not sugar. A deposit KPI has to be able to say "money customers brought in, but
    # NOT our own loan disbursements" -- those are booked as credits too, and counting them makes
    # lending look like deposit growth.
    for i, (key, value) in enumerate(sorted((spec.get("exclude") or {}).items())):
        if isinstance(value, (list, tuple)):
            params["x%d" % i] = tuple(value) or ("",)
            where += " AND %s NOT IN %%(x%d)s" % (key, i)
        else:
            params["x%d" % i] = value
            where += " AND %s != %%(x%d)s" % (key, i)

    measure = spec.get("measure", "1")
    select = "count()" if agg == "count" else "%s(%s)" % (agg, measure)
    return select, "%s.%s FINAL" % (DB, table), where, params


def _time_expr(spec: dict) -> str:
    meta = FACT_TABLES[spec["table"]]
    return meta["time_col"] if meta.get("snapshot") else "toDate(%s)" % meta["time_col"]


class FactReader:
    """Bound to a ClickHouseMetricLayer's client; shares its exact-aggregate discipline."""

    def __init__(self, client):
        self.client = client

    def total(self, tenant_id: str, spec: dict, window: Window) -> float:
        select, source, where, params = _sql(spec, window, tenant_id)
        rows = self.client.query("SELECT %s AS v FROM %s WHERE %s" % (select, source, where),
                                 params)
        return float(rows[0]["v"] or 0) if rows else 0.0

    def series(self, tenant_id: str, spec: dict, window: Window) -> Series:
        select, source, where, params = _sql(spec, window, tenant_id)
        rows = self.client.query(
            "SELECT %s AS d, %s AS v FROM %s WHERE %s GROUP BY d ORDER BY d"
            % (_time_expr(spec), select, source, where), params)
        found = {str(r["d"]): float(r["v"] or 0) for r in rows}
        # Gap-fill: a day with no rows is a real zero, not an absent point.
        points = {d.isoformat(): found.get(d.isoformat(), 0.0) for d in window.days()}
        return Series(kpi_id=str(spec.get("metric", "")), points=points)

    def by_cell(self, tenant_id: str, spec: dict, dims: list[str], window: Window,
                min_volume: int = 0) -> dict[tuple, float]:
        if not dims:
            return {}
        select, source, where, params = _sql(spec, window, tenant_id)
        cols = ", ".join("toString(%s) AS d%d" % (d, i) for i, d in enumerate(dims))
        groups = ", ".join("d%d" % i for i in range(len(dims)))
        rows = self.client.query(
            "SELECT %s, %s AS v FROM %s WHERE %s GROUP BY %s HAVING v >= %d "
            "ORDER BY v DESC, %s ASC"
            % (cols, select, source, where, groups, int(min_volume), groups), params)
        out: dict[tuple, float] = {}
        for r in rows:
            cell = tuple(str(r["d%d" % i]) for i in range(len(dims)))
            if any(c == "" for c in cell):
                continue
            out[cell] = float(r["v"] or 0)
        return out

    def cell_deltas(self, tenant_id: str, spec: dict, dims: list[str], window: Window,
                    baseline: Window, min_volume: int = 0) -> dict[tuple, tuple[float, float]]:
        """{cell: (current, baseline)} in one conditional-aggregation query."""
        if not dims:
            return {}
        span = Window(min(window.start, baseline.start), max(window.end, baseline.end))
        _, source, where, params = _sql(spec, span, tenant_id)
        meta = FACT_TABLES[spec["table"]]
        col = meta["time_col"]
        cast = "toDate" if meta.get("snapshot") else ""
        agg = str(spec.get("aggregation", "sum"))
        measure = spec.get("measure", "1")
        params.update({"c_start": window.start, "c_end": window.end,
                       "b_start": baseline.start, "b_end": baseline.end})
        cur_win = "%s >= %s(%%(c_start)s) AND %s < %s(%%(c_end)s)" % (col, cast, col, cast)
        base_win = "%s >= %s(%%(b_start)s) AND %s < %s(%%(b_end)s)" % (col, cast, col, cast)
        agg_if = "countIf" if agg == "count" else "%sIf" % agg
        arg = "" if agg == "count" else "%s, " % measure
        cols = ", ".join("toString(%s) AS d%d" % (d, i) for i, d in enumerate(dims))
        groups = ", ".join("d%d" % i for i in range(len(dims)))
        rows = self.client.query(
            "SELECT %s, %s(%s%s) AS cur, %s(%s%s) AS base FROM %s WHERE %s "
            "GROUP BY %s HAVING cur >= %d OR base >= %d ORDER BY %s ASC"
            % (cols, agg_if, arg, cur_win, agg_if, arg, base_win, source, where,
               groups, int(min_volume), int(min_volume), groups), params)
        out: dict[tuple, tuple[float, float]] = {}
        for r in rows:
            cell = tuple(str(r["d%d" % i]) for i in range(len(dims)))
            if any(c == "" for c in cell):
                continue
            out[cell] = (float(r["cur"] or 0), float(r["base"] or 0))
        return out

    def dimension_cardinality(self, tenant_id: str, key: str, window: Window,
                              spec: dict) -> int:
        """Distinct values of a fact column in the window."""
        _, source, where, params = _sql(spec, window, tenant_id)
        rows = self.client.query(
            "SELECT uniqExact(toString(%s)) AS n FROM %s WHERE %s" % (key, source, where), params)
        return int(rows[0]["n"]) if rows else 0

    def factors(self, tenant_id: str, spec: dict, dims: list[str],
                window: Window) -> dict[tuple, dict]:
        """Per-cell volume, value and derived price -- the inputs a factor decomposition needs.

        price is computed as value/volume rather than stored, because a stored rate cannot be
        aggregated across cells.
        """
        if not dims:
            return {}
        _, source, where, params = _sql(spec, window, tenant_id)
        measure = spec.get("measure", "1")
        cols = ", ".join("toString(%s) AS d%d" % (d, i) for i, d in enumerate(dims))
        groups = ", ".join("d%d" % i for i in range(len(dims)))
        rows = self.client.query(
            "SELECT %s, count() AS volume, sum(%s) AS value FROM %s WHERE %s "
            "GROUP BY %s ORDER BY %s ASC"
            % (cols, measure, source, where, groups, groups), params)
        out: dict[tuple, dict] = {}
        for r in rows:
            cell = tuple(str(r["d%d" % i]) for i in range(len(dims)))
            volume, value = float(r["volume"] or 0), float(r["value"] or 0)
            out[cell] = {"volume": volume, "value": value,
                         "price": (value / volume) if volume else 0.0}
        return out

    # -- source 3 and cross-source context ----------------------------------
    def source_freshness(self, source_id: str, tenant_id: str,
                         as_of: datetime) -> tuple[float | None, int]:
        """(minutes behind, declared SLA). Sources refresh at different rates, so one global
        freshness number cannot gate them all."""
        rows = self.client.query(
            "SELECT max_source_ts, sla_minutes FROM %s.source_freshness FINAL "
            "WHERE source_id = %%(s)s AND tenant_id = %%(t)s" % DB,
            {"s": source_id, "t": tenant_id})
        if not rows or not rows[0]["max_source_ts"]:
            return None, 0
        behind = max(0.0, (as_of - rows[0]["max_source_ts"]).total_seconds() / 60.0)
        return behind, int(rows[0]["sla_minutes"] or 0)

    def active_campaigns(self, tenant_id: str, window: Window) -> list[dict]:
        """Declared interventions overlapping the window. Causal may not claim an estimated
        effect without one."""
        rows = self.client.query(
            "SELECT campaign_id, name, channel, segment, start_date, end_date, spend "
            "FROM %s.dim_campaign FINAL WHERE tenant_id = %%(t)s "
            "AND start_date < toDate(%%(w_end)s) AND end_date >= toDate(%%(w_start)s) "
            "ORDER BY campaign_id" % DB, {"t": tenant_id, **window.params()})
        return [dict(r) for r in rows]

    def calendar_flags(self, tenant_id: str, window: Window) -> dict[str, dict]:
        """Holiday/weekend/season per day, so Detect need not alarm on a known event."""
        rows = self.client.query(
            "SELECT calendar_date, is_holiday, is_weekend, is_month_end, season, label "
            "FROM %s.dim_calendar FINAL WHERE tenant_id = %%(t)s "
            "AND calendar_date >= toDate(%%(w_start)s) AND calendar_date < toDate(%%(w_end)s) "
            "ORDER BY calendar_date" % DB, {"t": tenant_id, **window.params()})
        return {str(r["calendar_date"]): dict(r) for r in rows}

    def fee_schedule(self, tenant_id: str) -> dict[tuple, dict]:
        """(txn_type, channel) -> {flat, pct}: the price side of fee revenue."""
        rows = self.client.query(
            "SELECT txn_type, channel, fee_flat, fee_pct FROM %s.dim_fee_schedule FINAL "
            "WHERE tenant_id = %%(t)s ORDER BY txn_type, channel" % DB, {"t": tenant_id})
        return {(str(r["txn_type"]), str(r["channel"])):
                {"flat": float(r["fee_flat"]), "pct": float(r["fee_pct"])} for r in rows}
