"""Stage 04 -- Forecast. Scheduled batch; its interval is the band Detect scores against.

Method registry (docs/PIPELINE_CONTRACT.md 4b): a method is used only if it has enough history,
its deps import, and it beats the contract baseline on rolling-origin MASE for that series.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass

from api.intelligence import config
from api.intelligence.ids import forecast_id, round6


@dataclass
class ForecastResult:
    point: float
    lower: float
    upper: float
    method: str
    confidence: float
    backtest_mase: float
    caveat: str
    engine_type: str = "stats"


def mad(values: list[float]) -> float:
    """Median absolute deviation. A fresh anomaly cannot contaminate it."""
    if not values:
        return 0.0
    med = statistics.median(values)
    return statistics.median([abs(v - med) for v in values])


def seasonal_naive(values: list[float], period: int | None = None) -> float:
    period = period or config.SEASONAL_PERIOD_DAYS
    if len(values) >= period:
        return values[-period]
    return values[-1] if values else 0.0


def rolling_median(values: list[float], window: int | None = None) -> float:
    window = window or config.SEASONAL_PERIOD_DAYS
    return statistics.median(values[-window:]) if values else 0.0


METHODS = {"seasonal_naive": seasonal_naive, "rolling_median": rolling_median}


def _mase(actual: list[float], predicted: list[float], naive: list[float]) -> float:
    """Mean absolute scaled error vs the naive baseline. Lower is better; 0 means unscorable."""
    if not actual or len(actual) != len(predicted):
        return 0.0
    err = sum(abs(a - p) for a, p in zip(actual, predicted)) / len(actual)
    base = sum(abs(a - n) for a, n in zip(actual, naive)) / len(actual)
    return err / base if base > 0 else 0.0


def backtest(values: list[float], fn, period: int | None = None,
             folds: int | None = None) -> float:
    period = period or config.SEASONAL_PERIOD_DAYS
    folds = folds or config.BACKTEST_FOLDS
    if len(values) < period + 2:
        return 0.0
    actual, predicted, naive = [], [], []
    for i in range(max(period, len(values) - folds), len(values)):
        hist = values[:i]
        actual.append(values[i])
        predicted.append(fn(hist))
        naive.append(seasonal_naive(hist, period))
    return round6(_mase(actual, predicted, naive))


def run(kpi_id: str, series_values: list[float], contract, as_of, tenant_id: str) -> ForecastResult:
    cfg = contract.forecast_cfg
    min_history = int(cfg.get("min_history_days", 14))
    period = config.SEASONAL_PERIOD_DAYS
    # The +/-1 floor below is a COUNT resolution -- you cannot resolve below one event. On a
    # ratio it spans the whole of [0,1], so the band swallowed every rate movement and no rate
    # anomaly could ever fire. Scale the floor to what the contract says it is measuring.
    floor = config.RATE_SPREAD_FLOOR if str(contract.raw.get("unit") or "") == "ratio" else 1.0

    # Cold start: widen honestly rather than pretend precision.
    if len(series_values) < min_history:
        point = rolling_median(series_values)
        spread = max(mad(series_values) * 3.0, abs(point) * 0.5, floor)
        return ForecastResult(round6(point), round6(max(0.0, point - spread)),
                              round6(point + spread), "rolling_median",
                              config.COLD_START_CONFIDENCE, 0.0, "insufficient_history")

    scored = {name: backtest(series_values, fn) for name, fn in METHODS.items()}
    baseline = cfg.get("baseline", "seasonal_naive")
    if baseline not in METHODS:
        baseline = "seasonal_naive"

    # Promotion: a method must beat the contract baseline on THIS series to be used.
    best = baseline
    best_score = scored.get(baseline, 0.0)
    for name in sorted(scored):
        score = scored[name]
        if score and best_score and score < best_score * config.PROMOTION_MARGIN:
            best, best_score = name, score

    fn = METHODS[best]
    point = fn(series_values)
    resid = [series_values[i] - fn(series_values[:i]) for i in range(period, len(series_values))]
    sigma = mad(resid) * config.MAD_TO_SIGMA if resid else max(abs(point) * 0.2, floor)
    spread = max(config.Z_95 * sigma, floor)

    return ForecastResult(
        round6(point), round6(max(0.0, point - spread)), round6(point + spread), best,
        round6(max(config.COLD_START_CONFIDENCE, min(0.95, 1.0 - min(best_score, 1.0) * 0.5))),
        round6(best_score), "")


def to_row(result: ForecastResult, tenant_id: str, kpi_id: str, as_of, horizon_days: int) -> dict:
    return {
        "forecast_id": forecast_id(tenant_id, kpi_id, as_of, result.method),
        "tenant_id": tenant_id, "kpi_id": kpi_id, "as_of": as_of,
        "horizon_days": horizon_days, "point": result.point, "lower": result.lower,
        "upper": result.upper, "method": result.method, "confidence": result.confidence,
        "backtest_mase": result.backtest_mase, "caveat": result.caveat,
        "engine_type": result.engine_type,
    }
