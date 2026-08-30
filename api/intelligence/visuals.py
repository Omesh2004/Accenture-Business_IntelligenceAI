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


_BUILDERS = {
    "get_causes": lambda d, c: _from_causes(d),
    "get_insight": _from_insight,
    "rank_movements": lambda d, c: _from_ranking(d),
}


def build(observations) -> list[dict]:
    """Every chart the run can honestly draw, in the order the finding is told."""
    out: list[dict] = []
    for obs in observations:
        builder = _BUILDERS.get(obs.tool)
        if not builder or not obs.ok:
            continue
        try:
            spec = builder(getattr(obs, "data", None) or {}, getattr(obs, "claims", None) or [])
        except Exception:                                           # noqa: BLE001
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
