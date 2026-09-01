"""A real day-by-day path for one KPI, for charting.

Everything else on the intelligence page is a scalar: an observed value, an expected value, a
contribution share. None of those show a reader the SHAPE of the movement -- whether a metric
stepped, drifted or spiked, and whether the week being reported is unusual against the weeks
before it. That needs the series itself.

Two rules make this safe to put on a chart next to a narrative:

  * It reads through the Metric Layer, never raw SQL (CLAUDE.md rule 4), and through the SAME
    `ratio_series`/`fundamental_series` pair the orchestrator scores with. A chart drawn from a
    hand-written GROUP BY would disagree with the narrative the moment either changed.
  * The forecast band is read from the stored `forecasts` row, not recomputed. That row holds one
    scalar point and one band for the whole horizon -- there is no stored per-day path -- so it is
    published as a flat right-edge band and labelled as such, never interpolated into a fake curve.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from api.intelligence import config
from api.intelligence.contracts import load_declared
from api.intelligence.metrics import ClickHouseMetricLayer, Window, ratio_series
from api.metric_api.client import MetricAPIClient

# The layer caches resolved event names per (tenant, window), and that cache is the expensive part
# of an event-based read. One module-level instance amortises it across requests.
_LAYER: ClickHouseMetricLayer | None = None


def _layer() -> ClickHouseMetricLayer:
    global _LAYER
    if _LAYER is None:
        _LAYER = MetricAPIClient()
    return _LAYER


def _window(days: int, end: datetime | None = None) -> Window:
    """Half-open and bounded at BOTH ends -- a lower-bound-only window biases every comparison."""
    end = (end or datetime.utcnow()).replace(hour=0, minute=0, second=0, microsecond=0)
    end += timedelta(days=1)
    return Window(end - timedelta(days=days), end)


def kpi_series(tenant_id: str, kpi_id: str, days: int = 30) -> dict:
    """The daily path for one governed KPI, with its stored forecast band if there is one.

    Returns `points` as [{date, value}] in date order, gap-filled: a day with no rows is a real
    zero, not an absent point. `unit` says whether the values are a rate or the additive count the
    rate is built from -- the same distinction the narrative has to make, because a ratio whose
    denominator is missing falls back to counting.
    """
    contracts = load_declared()
    contract = contracts.get(kpi_id)
    if contract is None:
        return {"kpi_id": kpi_id, "points": [], "detail": "no declared contract for that metric"}

    window = _window(days)
    layer = _layer()

    scored_rate = False
    series = None
    if contract.is_ratio:
        series = ratio_series(layer, tenant_id, contract, window)
        scored_rate = series is not None
    if series is None:
        spec = contract.scored_fundamental
        if not spec:
            return {"kpi_id": kpi_id, "points": [],
                    "detail": "this contract declares no scored fundamental"}
        series = layer.fundamental_series(tenant_id, spec, window)

    points = [{"date": d, "value": round(float(series.points[d]), config.ROUND_DP)}
              for d in series.dates()]

    out = {
        "kpi_id": kpi_id,
        "name": str(contract.raw.get("name") or kpi_id.replace("_", " ").title()),
        "unit": "ratio" if scored_rate else "count",
        # Names the quantity actually plotted. A ratio contract that fell back to its numerator is
        # charting a count, and saying so is the difference between a figure and a wrong figure.
        "measure": str(contract.raw.get("unit") or "") if scored_rate else _measure_of(contract),
        "points": points,
        "days": days,
        "source": "metric_layer",
    }
    out.update(_band(tenant_id, kpi_id, window, [p["value"] for p in points], scored_rate))
    return out


def _measure_of(contract) -> str:
    spec = contract.scored_fundamental or {}
    return str(spec.get("name") or spec.get("measure") or spec.get("event") or "")


def _band(tenant_id: str, kpi_id: str, window: Window, values: list[float],
          scored_rate: bool) -> dict:
    """The stored forecast, as a flat band over the horizon. One row, so one band -- no curve.

    Withheld when it is not on the same scale as the series. A stored band can be a COUNT while
    this read returns a RATE -- `kyc_completion_rate` bands at 12.0 against a series that lives in
    [0, 1] -- because the run that wrote it fell back to the numerator. Drawing that band on this
    axis is a picture of a metric sitting far below expectation when it is not. A chart cannot
    caveat itself, so the only honest option is not to draw it.
    """
    try:
        from api.intelligence import signal_store
        row = signal_store.read_forecast(tenant_id, kpi_id, window.end)
    except Exception:                                               # noqa: BLE001
        return {}
    if not row:
        return {}
    try:
        point = round(float(row.get("point") or 0.0), config.ROUND_DP)
        lower = round(float(row.get("lower") or 0.0), config.ROUND_DP)
        upper = round(float(row.get("upper") or 0.0), config.ROUND_DP)
    except Exception:                                               # noqa: BLE001
        return {}

    if scored_rate and (point > 1.0 or upper > 1.0):
        return {"forecast_withheld":
                "the stored band was fitted on the additive count, not the rate, so it is not on "
                "this axis"}
    if values:
        ceiling = max(values) or 1.0
        if abs(point) > ceiling * 20:
            return {"forecast_withheld":
                    "the stored band is not on the same scale as this series"}

    return {"forecast": {
        "point": point, "lower": lower, "upper": upper,
        "method": str(row.get("method") or ""),
        "horizon_days": int(row.get("horizon_days") or 0),
        "flat": True,   # the stored row has no per-day path; never interpolate one
    }}
