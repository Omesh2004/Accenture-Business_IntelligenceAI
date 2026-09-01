"""Charts derived from what the agent already read -- never from a fresh query.

A figure and the chart beside it must be the same number. The way that breaks is a chart that
re-queries: the panel and the sentence then answer from two reads of a moving table, and the
mismatch is invisible because both look authoritative.

So every series here is built from a `ToolResult.data` the agent already observed, and carries the
same `source` table the prose cites. A visual that cannot be built from an observation is simply
not emitted.
"""
from __future__ import annotations

from api.intelligence import phrasing

MAX_BARS = 6


def _cell_label(cause: dict) -> str:
    """The stored label, phrased the way the prose phrases it, so the two cannot disagree."""
    return phrasing.cell_phrase(cause.get("dimensions") or {}) or "unlabelled"


def _from_causes(data: dict) -> dict | None:
    """Ranked drivers as a bar chart. Contribution is already a share of the movement."""
    causes = (data.get("shown") or data.get("causes") or [])[:MAX_BARS]
    if not causes:
        return None
    bars = [{"label": _cell_label(c), "value": round(float(c.get("contribution") or 0.0) * 100, 1)}
            for c in causes]
    if not any(b["value"] for b in bars):
        return None
    return {
        "kind": "bars",
        "title": "Where the movement concentrated",
        "subtitle": "share of the movement, ranked",
        "unit": "%",
        "series": bars,
        "source": "root_causes",
        "gate": "localize",
    }


def _from_insight(data: dict, claims: list[dict]) -> dict | None:
    """Observed against expected. Two bars is the whole finding: how far outside the band it fell."""
    by_id = {c["claim_id"]: c["value"] for c in claims}
    if "observed" not in by_id or "baseline" not in by_id:
        return None
    measure = data.get("measure") or ""
    return {
        "kind": "delta",
        "title": "Observed against expected",
        "subtitle": phrasing.window_phrase(
            (data.get("anomaly") or {}).get("window_start"),
            (data.get("anomaly") or {}).get("window_end")) or "",
        "unit": measure,
        "series": [{"label": "Expected", "value": by_id["baseline"]},
                   {"label": "Observed", "value": by_id["observed"]}],
        "pct_change": by_id.get("pct_change"),
        "source": "anomalies",
        "gate": "detect",
    }


def _from_ranking(data: dict) -> dict | None:
    """The portfolio, ordered by recorded materiality. Answers "what should I look at first"."""
    from api.intelligence.tools import pretty_name
    rows = (data.get("rows") or [])[:MAX_BARS]
    bars = []
    for row in rows:
        kpi = row.get("kpi_id") or ""
        value = row.get("materiality")
        if not kpi or value is None:
            continue
        share = float(value)
        bars.append({"label": pretty_name(kpi),
                     "value": round(share * 100, 1) if share <= 1.0 else round(share, 1),
                     "severity": str(row.get("severity") or "info")})
    if len(bars) < 2:
        return None
    return {
        "kind": "bars",
        "title": "Portfolio by materiality",
        "subtitle": "every metric currently outside its band",
        "unit": "%",
        "series": bars,
        "source": "anomalies",
        "gate": "detect",
    }


def _waterfall(data: dict, claims: list[dict]) -> dict | None:
    """How the drivers add up from the expected level to the observed one.

    The ranked bars say which segment is biggest; this says whether they ACCOUNT for the
    movement. A set of drivers that sums to a third of the gap looks convincing on a bar chart
    and is plainly incomplete here, which is the honest reading.
    """
    causes = (data.get("shown") or data.get("causes") or [])[:MAX_BARS]
    by_id = {c["claim_id"]: c["value"] for c in claims}
    if not causes or "baseline" not in by_id or "observed" not in by_id:
        return None
    baseline = float(by_id["baseline"])
    observed = float(by_id["observed"])
    gap = observed - baseline
    if abs(gap) < 1e-12:
        return None

    steps = [{"label": "Expected", "value": round(baseline, 6), "role": "start"}]
    running = baseline
    explained = 0.0
    for cause in causes:
        share = float(cause.get("contribution") or 0.0)
        step = gap * share
        explained += share
        running += step
        steps.append({"label": _cell_label(cause), "value": round(step, 6),
                      "at": round(running, 6), "role": "step"})
    rest = gap * max(0.0, 1.0 - explained)
    if abs(rest) > abs(gap) * 0.01:
        running += rest
        steps.append({"label": "Not localised", "value": round(rest, 6),
                      "at": round(running, 6), "role": "rest"})
    steps.append({"label": "Observed", "value": round(observed, 6), "role": "end"})

    return {
        "kind": "waterfall",
        "title": "How the drivers add up",
        "subtitle": "from the expected level to the observed one",
        "unit": data.get("measure") or "",
        "series": steps,
        "source": "root_causes",
        "gate": "localize",
    }


def _band(data: dict, claims: list[dict]) -> dict | None:
    """The forecast band, and where the reading fell against it."""
    by_id = {c["claim_id"]: c["value"] for c in claims}
    if "forecast_point" not in by_id:
        return None
    lower = by_id.get("forecast_lower")
    upper = by_id.get("forecast_upper")
    if lower is None or upper is None:
        return None
    return {
        "kind": "band",
        "title": "Against the expected range",
        "subtitle": "the band this reading was scored against",
        "unit": data.get("measure") or "",
        "series": [
            {"label": "Lower", "value": float(lower)},
            {"label": "Forecast", "value": float(by_id["forecast_point"])},
            {"label": "Upper", "value": float(upper)},
        ],
        "observed": by_id.get("observed"),
        "source": "forecasts",
        "gate": "forecast",
    }


def _explained(data: dict, _claims: list[dict]) -> dict | None:
    """How much of the movement the localisation actually accounts for."""
    causes = data.get("causes") or []
    if not causes:
        return None
    covered = float(causes[0].get("explained_pct") or 0.0)
    if covered <= 0:
        return None
    covered = min(1.0, covered)
    return {
        "kind": "donut",
        "title": "How much is explained",
        "subtitle": "share of the movement the named segments account for",
        "unit": "%",
        "series": [
            {"label": "Localised", "value": round(covered * 100, 1)},
            {"label": "Unaccounted", "value": round((1 - covered) * 100, 1)},
        ],
        "source": "root_causes",
        "gate": "localize",
    }


def _trend(data: dict, _claims: list[dict]) -> dict | None:
    """The metric's daily path, with the scored window and the expected band marked.

    Built from the series the tool actually read, never re-queried here: a chart that fetches its
    own data and a sentence that quotes a stored figure are two reads of a moving table, and the
    mismatch between them is invisible because both look authoritative.
    """
    points = data.get("points") or []
    if len(points) < 2:
        return None
    return {
        "kind": "trend",
        "title": "How it moved",
        "subtitle": "daily, over the window this answer covers",
        "unit": "ratio" if data.get("is_ratio") else "",
        "series": [{"label": str(p["date"]), "value": float(p["value"])} for p in points],
        "window_start": data.get("window_start") or "",
        "window_end": data.get("window_end") or "",
        "lower": data.get("lower"),
        "upper": data.get("upper"),
        "source": "gold.kpi_daily",
        "gate": "detect",
    }


#: A tool may contribute more than one chart. They are drawn in the order listed.
_BUILDERS = {
    "get_causes": [lambda d, c: _from_causes(d), _waterfall, _explained],
    "get_insight": [_from_insight],
    "get_forecast": [_band],
    "get_trend": [_trend],
    "rank_movements": [lambda d, c: _from_ranking(d)],
}


def build(observations) -> list[dict]:
    """Every chart the run can honestly draw, in the order the finding is told."""
    out: list[dict] = []
    # Claims pooled across the run. A chart often needs figures from two capabilities -- the
    # waterfall needs the level from Detect and the shares from Localize -- and every one of them
    # is still a claim the verifier checked, so pooling widens what can be drawn without
    # loosening what may be stated.
    pool: list[dict] = []
    for obs in observations:
        if obs.ok:
            pool.extend(getattr(obs, "claims", None) or [])
    for obs in observations:
        builders = _BUILDERS.get(obs.tool)
        if not builders or not obs.ok:
            continue
        for builder in builders:
            try:
                spec = builder(getattr(obs, "data", None) or {}, pool)
            except Exception:                                       # noqa: BLE001
                spec = None
            if spec:
                spec["tool"] = obs.tool
                out.append(spec)
    return out


# ── result tables ──────────────────────────────────────────────────────────────────────────────
def _causes_table(data: dict) -> dict | None:
    """Ranked cells, exactly as Localize recorded them."""
    causes = data.get("causes") or []
    if not causes:
        return None
    rows = [[c.get("rank"), _cell_label(c),
             round(float(c.get("contribution") or 0.0) * 100, 1),
             c.get("method") or ""]
            for c in causes]
    return {"title": "Ranked drivers for %s" % (data.get("measure") or data.get("kpi_id") or ""),
            "columns": ["RANK", "SEGMENT", "SHARE %", "METHOD"], "rows": rows,
            "source": "root_causes"}


def _ranking_table(data: dict) -> dict | None:
    from api.intelligence.tools import pretty_name
    rows = data.get("rows") or []
    if not rows:
        return None
    return {"title": "Metrics outside their expected band",
            "columns": ["METRIC", "SEVERITY", "MATERIALITY %"],
            "rows": [[pretty_name(r.get("kpi_id") or ""), str(r.get("severity") or "info"),
                      round(float(r.get("materiality") or 0.0) * 100, 1)] for r in rows],
            "source": "anomalies"}


def _claims_table(claims: list[dict], title: str, source: str) -> dict | None:
    """Every figure an observation produced, with the table each was read from."""
    if not claims:
        return None
    return {"title": title, "columns": ["FIGURE", "VALUE", "UNIT", "SOURCE TABLE"],
            "rows": [[c.get("label"), c.get("value"), c.get("unit"), c.get("source")]
                     for c in claims],
            "source": source}


_TABLES = {
    "get_causes": lambda d, c: _causes_table(d),
    "rank_movements": lambda d, c: _ranking_table(d),
    "get_insight": lambda d, c: _claims_table(c, "Recorded finding", "insights"),
    "get_recommendations": lambda d, c: _claims_table(c, "Proposed actions", "recommendations"),
    "get_forecast": lambda d, c: _claims_table(c, "Forecast band", "forecasts"),
    "get_trust": lambda d, c: _claims_table(c, "Trust checks", "trust_findings"),
}


def datasets(observations) -> list[dict]:
    """The result sets behind the narrative, in the order they were produced.

    This is the workspace half of the answer: the prose says what happened, and these are the rows
    it says it from. Built from the same observations, so a table can never show something the
    narrative contradicts.
    """
    out: list[dict] = []
    for obs in observations:
        builder = _TABLES.get(obs.tool)
        if not builder or not obs.ok:
            continue
        try:
            table = builder(getattr(obs, "data", None) or {},
                            getattr(obs, "claims", None) or [])
        except Exception:                                           # noqa: BLE001
            table = None
        if table and table.get("rows"):
            table["tool"] = obs.tool
            out.append(table)
    return out
