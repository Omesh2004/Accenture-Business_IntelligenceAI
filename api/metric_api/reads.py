"""One function per §3.6 named read. Queries `silver` + `gold` ONLY — never `bronze`.

Every aggregate is exact (`sum`, `count`, `uniqExact`, `min`, `max`). Windows are half-open
`[start, end)`. `kpi_id` is resolved through `api.contracts_loader.resolve_kpi`; an unknown id
raises `UnknownKpi` (the endpoint turns that into a 404).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from warehouse.client import ch_client
from api.contracts_loader import resolve_kpi, KpiSpec

GOLD, SILVER = "gold", "silver"


def _q(sql: str, params: dict | None = None) -> list[dict]:
    return ch_client.query(sql, params or {})


def _days(start: date, end: date) -> list[str]:
    out, cur = [], start
    while cur < end:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def _rate(num: float, den: float) -> float | None:
    return round(num / den, 6) if den else None


# ── /metric/kpi/series ──────────────────────────────────────────────────────
def kpi_series(tenant: str, kpi_id: str, start: date, end: date) -> dict:
    spec = resolve_kpi(kpi_id)
    rows = _q(
        f"SELECT toString(date) AS d, fundamental AS f, "
        f"argMax(value, _version) AS v FROM {GOLD}.kpi_daily "
        "WHERE tenant_id=%(t)s AND kpi_id=%(k)s AND date>=%(s)s AND date<%(e)s "
        "GROUP BY d, f",
        {"t": tenant, "k": kpi_id, "s": start, "e": end})
    by_f: dict[str, dict[str, float]] = {f: {} for f in spec.fundamentals}
    for r in rows:
        by_f.setdefault(str(r["f"]), {})[str(r["d"])] = float(r["v"])
    days = _days(start, end)
    series = {f: [round(by_f.get(f, {}).get(d, 0.0), 6) for d in days] for f in spec.fundamentals}
    out = {"kpi_id": kpi_id, "kind": spec.kind, "dates": days, "fundamentals": series}
    if spec.kind == "rate":
        num, den = series[spec.numerator], series[spec.denominator]
        out["rate"] = [_rate(n, d) for n, d in zip(num, den)]
    return out


# ── /metric/kpi/total ───────────────────────────────────────────────────────
def kpi_total(tenant: str, kpi_id: str, start: date, end: date) -> dict:
    spec = resolve_kpi(kpi_id)
    rows = _q(
        f"SELECT f, sum(v) AS total FROM ("
        f"  SELECT date, fundamental AS f, argMax(value,_version) AS v "
        f"  FROM {GOLD}.kpi_daily WHERE tenant_id=%(t)s AND kpi_id=%(k)s "
        "   AND date>=%(s)s AND date<%(e)s GROUP BY date, fundamental) GROUP BY f",
        {"t": tenant, "k": kpi_id, "s": start, "e": end})
    totals = {str(r["f"]): round(float(r["total"]), 6) for r in rows}
    out = {"kpi_id": kpi_id, "kind": spec.kind,
           "fundamentals": {f: totals.get(f, 0.0) for f in spec.fundamentals}}
    if spec.kind == "rate":
        out["rate"] = _rate(totals.get(spec.numerator, 0.0), totals.get(spec.denominator, 0.0))
    return out


# ── /metric/kpi/by_dim ──────────────────────────────────────────────────────
def kpi_by_dim(tenant: str, kpi_id: str, fundamental: str, dims: list[str],
               start: date, end: date, min_volume: float = 0) -> dict:
    spec = resolve_kpi(kpi_id)
    if fundamental not in spec.fundamentals:
        raise ValueError(f"{fundamental!r} is not a fundamental of {kpi_id!r}")
    bad = [d for d in dims if d not in spec.dimensions]
    if bad:
        raise ValueError(f"dimensions {bad} are not localizable for {kpi_id!r}")
    result: dict[str, dict] = {}
    for dim in dims:
        rows = _q(
            f"SELECT value_key AS vk, sum(v) AS val FROM ("
            f"  SELECT value_key, argMax(value,_version) AS v FROM {GOLD}.kpi_daily_by_dim "
            "   WHERE tenant_id=%(t)s AND kpi_id=%(k)s AND fundamental=%(f)s AND dimension=%(d)s "
            "     AND date>=%(s)s AND date<%(e)s GROUP BY date, value_key) "
            "GROUP BY vk HAVING val >= %(mv)s ORDER BY val DESC",
            {"t": tenant, "k": kpi_id, "f": fundamental, "d": dim,
             "s": start, "e": end, "mv": float(min_volume)})
        cells = {str(r["vk"]): round(float(r["val"]), 6) for r in rows if str(r["vk"]) != ""}
        total = kpi_total(tenant, kpi_id, start, end)["fundamentals"].get(fundamental, 0.0)
        explained = sum(cells.values())
        result[dim] = {
            "cells": cells,
            "unexplained_pct": round(1 - (explained / total), 6) if total else None,
        }
    return {"kpi_id": kpi_id, "fundamental": fundamental, "by_dim": result}


# ── /metric/kpi/cells ───────────────────────────────────────────────────────
def kpi_cells(tenant: str, kpi_id: str, fundamental: str, start: date, end: date,
              baseline_start: date, baseline_end: date, min_volume: float = 0) -> dict:
    """Leaf cells of the multi-dimensional cube, current window against a baseline.

    The full dimension tuple, not a 1-D marginal: PSqueeze's ripple effect is defined over
    leaves, so a per-dimension view gives it no cuboids to combine.
    """
    spec = resolve_kpi(kpi_id)
    if fundamental not in spec.fundamentals:
        raise ValueError(f"{fundamental!r} is not a fundamental of {kpi_id!r}")

    def _sum(s: date, e: date) -> dict[str, tuple[list, list, float]]:
        rows = _q(
            f"SELECT cell_key, any(dims) AS dims, any(vals) AS vals, sum(v) AS val FROM ("
            f"  SELECT cell_key, dims, vals, argMax(value,_version) AS v FROM {GOLD}.kpi_cells "
            "   WHERE tenant_id=%(t)s AND kpi_id=%(k)s AND fundamental=%(f)s "
            "     AND date>=%(s)s AND date<%(e)s GROUP BY date, cell_key, dims, vals) "
            "GROUP BY cell_key",
            {"t": tenant, "k": kpi_id, "f": fundamental, "s": s, "e": e})
        return {str(r["cell_key"]): (list(r["dims"]), list(r["vals"]), float(r["val"]))
                for r in rows}

    cur, base = _sum(start, end), _sum(baseline_start, baseline_end)
    scale = max(1, (end - start).days) / max(1, (baseline_end - baseline_start).days)
    out = []
    for key in set(cur) | set(base):
        dims, vals, v = cur.get(key, (None, None, 0.0))
        bdims, bvals, b = base.get(key, (None, None, 0.0))
        dims, vals = dims or bdims or [], vals or bvals or []
        if max(v, b * scale) < float(min_volume):
            continue
        out.append({"cell_key": key, "dims": dims, "vals": vals,
                    "value": round(v, 6), "baseline": round(b * scale, 6)})
    return {"kpi_id": kpi_id, "fundamental": fundamental, "cells": out}


# ── /metric/kpi/cell_deltas ─────────────────────────────────────────────────
def kpi_cell_deltas(tenant: str, kpi_id: str, fundamental: str, dims: list[str],
                    start: date, end: date, baseline_start: date, baseline_end: date,
                    min_volume: float = 0) -> dict:
    spec = resolve_kpi(kpi_id)
    if fundamental not in spec.fundamentals:
        raise ValueError(f"{fundamental!r} is not a fundamental of {kpi_id!r}")
    out: dict[str, dict] = {}
    for dim in dims:
        rows = _q(
            f"SELECT value_key AS vk, "
            f"sumIf(v, d>=%(cs)s AND d<%(ce)s) AS cur, "
            f"sumIf(v, d>=%(bs)s AND d<%(be)s) AS base FROM ("
            f"  SELECT date AS d, value_key, argMax(value,_version) AS v "
            f"  FROM {GOLD}.kpi_daily_by_dim "
            "   WHERE tenant_id=%(t)s AND kpi_id=%(k)s AND fundamental=%(f)s AND dimension=%(dim)s "
            "     AND date >= least(%(cs)s,%(bs)s) AND date < greatest(%(ce)s,%(be)s) "
            "   GROUP BY date, value_key) "
            "GROUP BY vk HAVING (cur >= %(mv)s OR base >= %(mv)s) AND vk != ''",
            {"t": tenant, "k": kpi_id, "f": fundamental, "dim": dim,
             "cs": start, "ce": end, "bs": baseline_start, "be": baseline_end,
             "mv": float(min_volume)})
        out[dim] = {str(r["vk"]): [round(float(r["cur"]), 6), round(float(r["base"]), 6)]
                    for r in rows}
    return {"kpi_id": kpi_id, "fundamental": fundamental, "cell_deltas": out}


# ── /metric/funnel ──────────────────────────────────────────────────────────
def funnel(tenant: str, funnel_id: str, start: date, end: date) -> dict:
    rows = _q(
        f"SELECT stage, min(stage_order) AS so, sum(e) AS entered, sum(ev) AS events FROM ("
        f"  SELECT stage, stage_order, argMax(entered,_version) AS e, argMax(events,_version) AS ev "
        f"  FROM {GOLD}.funnel_daily WHERE tenant_id=%(t)s AND funnel_id=%(fn)s "
        "     AND date>=%(s)s AND date<%(e)s GROUP BY stage, stage_order, date) "
        "GROUP BY stage ORDER BY so",
        {"t": tenant, "fn": funnel_id, "s": start, "e": end})
    return {"funnel_id": funnel_id,
            "stages": [{"stage": str(r["stage"]), "order": int(r["so"]),
                        "entered": int(r["entered"]), "events": int(r["events"])} for r in rows]}


# ── /metric/dedup_counts ────────────────────────────────────────────────────
def dedup_counts(tenant: str, kpi_id: str, start: date, end: date) -> dict:
    resolve_kpi(kpi_id)
    rows = _q(
        f"SELECT sum(rr) AS raw_rows, sum(dc) AS distinct_ids FROM ("
        f"  SELECT date, fundamental, argMax(raw_rows,_version) AS rr, argMax(distinct_count,_version) AS dc "
        f"  FROM {GOLD}.kpi_daily WHERE tenant_id=%(t)s AND kpi_id=%(k)s "
        "     AND date>=%(s)s AND date<%(e)s GROUP BY date, fundamental)",
        {"t": tenant, "k": kpi_id, "s": start, "e": end})
    raw = int(rows[0]["raw_rows"] or 0) if rows else 0
    dist = int(rows[0]["distinct_ids"] or 0) if rows else 0
    return {"kpi_id": kpi_id, "rows_as_inserted": raw, "distinct_ids": dist,
            "collapsed_ok": raw == dist}


# ── /metric/freshness ───────────────────────────────────────────────────────
def freshness(tenant: str) -> dict:
    rows = _q(
        f"SELECT source_id, grain, cadence, sla_minutes, max_source_ts, last_loaded_at, "
        f"load_status FROM {GOLD}.source_freshness FINAL WHERE tenant_id=%(t)s ORDER BY source_id",
        {"t": tenant})
    now = datetime.utcnow()
    out = []
    for r in rows:
        mts = r["max_source_ts"]
        behind = round(max(0.0, (now - mts).total_seconds() / 60.0), 1) if mts else None
        sla = int(r["sla_minutes"] or 0)
        out.append({
            "source_id": str(r["source_id"]), "grain": str(r["grain"]),
            "cadence": str(r["cadence"]), "sla_minutes": sla,
            "minutes_behind": behind, "load_status": str(r["load_status"]),
            "status": "stale" if (behind is not None and sla and behind > sla) else "ok",
        })
    return {"tenant": tenant, "sources": out}


# ── /metric/dimensions ──────────────────────────────────────────────────────
def dimensions(tenant: str, kpi_id: str, start: date, end: date) -> dict:
    spec = resolve_kpi(kpi_id)
    out = {}
    for dim in spec.dimensions:
        rows = _q(
            f"SELECT uniqExact(value_key) AS n FROM {GOLD}.kpi_daily_by_dim "
            "WHERE tenant_id=%(t)s AND kpi_id=%(k)s AND dimension=%(d)s "
            "AND date>=%(s)s AND date<%(e)s AND value_key != ''",
            {"t": tenant, "k": kpi_id, "d": dim, "s": start, "e": end})
        out[dim] = {"measured": True, "cardinality": int(rows[0]["n"]) if rows else 0}
    return {"kpi_id": kpi_id, "dimensions": out,
            "fabricated_dims_note": "clickstream fabricated-dim list is advisory and separate"}


# ── /metric/calendar ────────────────────────────────────────────────────────
def calendar(tenant: str, start: date, end: date) -> dict:
    rows = _q(
        f"SELECT calendar_date, is_holiday, is_weekend, is_month_end, season, label "
        f"FROM {SILVER}.dim_calendar FINAL WHERE tenant_id=%(t)s "
        "AND calendar_date>=%(s)s AND calendar_date<%(e)s ORDER BY calendar_date",
        {"t": tenant, "s": start, "e": end})
    return {"days": [{"date": str(r["calendar_date"]), "is_holiday": int(r["is_holiday"]),
                      "is_weekend": int(r["is_weekend"]), "is_month_end": int(r["is_month_end"]),
                      "season": str(r["season"]), "label": str(r["label"])} for r in rows]}


# ── /metric/campaigns ───────────────────────────────────────────────────────
def campaigns(tenant: str, start: date, end: date) -> dict:
    rows = _q(
        f"SELECT campaign_id, name, channel, segment, start_date, end_date, spend "
        f"FROM {SILVER}.dim_campaign FINAL WHERE tenant_id=%(t)s "
        "AND start_date < %(e)s AND end_date >= %(s)s ORDER BY start_date",
        {"t": tenant, "s": start, "e": end})
    return {"campaigns": [{"campaign_id": str(r["campaign_id"]), "name": str(r["name"]),
                           "channel": str(r["channel"]), "segment": str(r["segment"]),
                           "start_date": str(r["start_date"]), "end_date": str(r["end_date"]),
                           "spend": float(r["spend"])} for r in rows]}


# ── /metric/discover ────────────────────────────────────────────────────────
def discover(tenant: str, start: date, end: date) -> dict:
    from api.contracts_loader import KPI_REGISTRY
    entities = {}
    for kid, spec in KPI_REGISTRY.items():
        rows = _q(
            f"SELECT count() AS n FROM {GOLD}.kpi_daily "
            "WHERE tenant_id=%(t)s AND kpi_id=%(k)s AND date>=%(s)s AND date<%(e)s",
            {"t": tenant, "k": kid, "s": start, "e": end})
        entities[kid] = {"fact_table": spec.fact_table, "fundamentals": list(spec.fundamentals),
                         "dimensions": list(spec.dimensions),
                         "rows_in_window": int(rows[0]["n"]) if rows else 0}
    return {"tenant": tenant, "kpis": entities}


# ── /metric/watermark ───────────────────────────────────────────────────────
def watermark(tenant: str) -> dict:
    rows = _q(
        f"SELECT source_id, max(max_source_ts) AS m FROM {GOLD}.source_freshness FINAL "
        "WHERE tenant_id=%(t)s GROUP BY source_id", {"t": tenant})
    out = {str(r["source_id"]): (r["m"].isoformat() if r["m"] else None) for r in rows}
    ev = _q(f"SELECT max(timestamp) AS m FROM {SILVER}.events WHERE tenant_id=%(t)s", {"t": tenant})
    if ev and ev[0]["m"]:
        out["nexabank_clickstream"] = ev[0]["m"].isoformat()
    return {"tenant": tenant, "watermarks": out}
