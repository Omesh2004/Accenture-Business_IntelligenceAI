"""Stage 02 -- Detect. Fires only on movements that are unlikely, persistent and material.

Scores against the STORED forecast band (stage 04), never a static threshold. Residuals use
median/MAD: a fresh anomaly contaminates a mean-based baseline and hides itself.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass

from api.intelligence import config
from api.intelligence.ids import anomaly_id, round6

EPSILON = 1e-9


@dataclass
class DetectResult:
    fired: bool
    reason: str = ""
    anomaly: dict | None = None
    materiality: float = 0.0
    p_value: float = 1.0


def benjamini_hochberg(pvalues: list[float], alpha: float | None = None) -> list[bool]:
    """FDR control. Across thousands of series, volume alone manufactures alarms."""
    alpha = config.FDR_ALPHA if alpha is None else alpha
    n = len(pvalues)
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: (pvalues[i], i))
    largest = 0
    for rank, idx in enumerate(order, start=1):
        if pvalues[idx] <= alpha * rank / n:
            largest = rank
    keep = [False] * n
    for rank, idx in enumerate(order, start=1):
        if rank <= largest:
            keep[idx] = True
    return keep


def z_to_p(z: float) -> float:
    """Two-sided normal tail. Detect needs a p-value so FDR can be applied across the sweep."""
    return max(1e-12, math.erfc(abs(z) / math.sqrt(2.0)))


def level_shift(recent: list[float], history: list[float]) -> float:
    """Share of the recent window sitting on one side of the historical median.

    A single spike is not a change point. 1.0 means every recent point moved the same way.
    """
    if not recent or not history:
        return 0.0
    med = statistics.median(history)
    above = sum(1 for v in recent if v > med)
    below = sum(1 for v in recent if v < med)
    return max(above, below) / len(recent)


def robust_z(value: float, history: list[float]) -> float:
    if not history:
        return 0.0
    med = statistics.median(history)
    scale = statistics.median([abs(h - med) for h in history]) * config.MAD_TO_SIGMA
    if scale < EPSILON:
        scale = statistics.pstdev(history) if len(history) > 1 else 0.0
    if scale < EPSILON:
        # A perfectly flat history means any deviation is infinitely surprising; cap it so
        # downstream arithmetic stays finite.
        return 0.0 if abs(value - med) < EPSILON else config.ROBUST_Z_THRESHOLD * 2
    return (value - med) / scale


def materiality(observed: float, baseline: float, critical_pct: float,
                affected: float, total: float, breaching: int, min_windows: int,
                strategic_weight: float = 0.5) -> float:
    """Ranking score: strength x reach x business weight. What to surface first."""
    return round6(strength(observed, baseline, critical_pct, breaching, min_windows)
                  * (min(1.0, affected / total) if total > EPSILON else 1.0)
                  * max(0.0, min(1.0, strategic_weight)))


def strength(observed: float, baseline: float, critical_pct: float,
             breaching: int, min_windows: int) -> float:
    """How big and how persistent the movement is, before business weighting.

    Severity reads this, not materiality: weighting severity by importance meant a KPI weighted
    0.7 could never cross the 0.75 urgent threshold however far it moved.
    """
    denom = max(abs(baseline), EPSILON)
    ratio = abs(observed - baseline) / denom / max(critical_pct / 100.0, EPSILON)
    # Saturating rather than capped: a hard min(1.0, ..) scored every real movement exactly 1.0,
    # so nothing could be ranked against anything else.
    effect = ratio / (ratio + 1.0)
    persistence = min(1.0, breaching / max(min_windows, 1))
    return round6(effect * persistence)


def severity_for(score: float) -> str:
    if score > config.SEVERITY_URGENT:
        return "urgent"
    if score >= config.SEVERITY_WARN:
        return "warn"
    return "info"


def run(ctx, series_values: list[float], band: dict | None, kpi_volume: float,
        tenant_volume: float, baseline_values: list[float] | None = None) -> DetectResult:
    cfg = ctx.contract.detection
    min_windows = max(1, int(cfg.get("min_persistence_windows", 2)))
    critical_pct = float(cfg.get("critical_pct_change", 20))
    direction_cfg = str(cfg.get("direction", "both"))

    if len(series_values) < min_windows + 1:
        return DetectResult(False, "insufficient_history")

    # A handful of events cannot support a claim about the business, whatever the percentage.
    if kpi_volume and kpi_volume < config.MIN_KPI_VOLUME:
        return DetectResult(False, "low_volume")

    recent = series_values[-min_windows:]
    history = series_values[:-min_windows]
    if not history:
        return DetectResult(False, "insufficient_history")

    observed = float(statistics.median(recent))

    # Robust baseline always runs; the forecast band corroborates it when one exists. Firing on
    # the band alone let a narrow band call any wobble an anomaly.
    # Prefer pre-window history; fall back to the in-window head when there is none.
    robust_history = baseline_values or history
    z = robust_z(observed, robust_history)
    robust_hit = abs(z) >= config.ROBUST_Z_THRESHOLD
    if band and band.get("lower") is not None:
        baseline = float(band.get("point") or statistics.median(history))
        lower, upper = float(band["lower"]), float(band["upper"])
        breaching = sum(1 for v in recent if v < lower or v > upper)
        outside = (observed < lower or observed > upper) and robust_hit
        method = "forecast_band+mad"
    else:
        baseline = float(statistics.median(history))
        breaching = sum(1 for v in recent
                        if abs(robust_z(v, robust_history)) >= config.ROBUST_Z_THRESHOLD)
        outside = robust_hit
        method = "mad"

    # A change point, not a one-day spike.
    if outside and level_shift(recent, robust_history) < config.LEVEL_SHIFT_MIN:
        return DetectResult(False, "not_a_level_shift")

    if not outside:
        return DetectResult(False, "within_band")
    if breaching < min_windows:
        return DetectResult(False, "not_persistent")

    direction = -1 if observed < baseline else 1
    if (direction_cfg == "down" and direction > 0) or (direction_cfg == "up" and direction < 0):
        return DetectResult(False, "wrong_direction")

    pct_change = abs(observed - baseline) / max(abs(baseline), EPSILON) * 100.0
    if pct_change < float(cfg.get("warn_pct_change", 0)):
        return DetectResult(False, "below_effect_floor")

    score = materiality(observed, baseline, critical_pct, kpi_volume, tenant_volume,
                        breaching, min_windows, ctx.contract.strategic_weight)
    if score < config.MATERIALITY_FLOOR:
        return DetectResult(False, "immaterial", materiality=score)

    return DetectResult(True, "", {
        "anomaly_id": anomaly_id(ctx.tenant_id, ctx.kpi_id, ctx.window.start, method),
        "investigation_id": ctx.investigation_id,
        "tenant_id": ctx.tenant_id,
        "kpi_id": ctx.kpi_id,
        "detected_at": ctx.started_at,
        "window_start": ctx.window.start,
        "window_end": ctx.window.end,
        "method": method,
        "direction": direction,
        "magnitude": round6(observed - baseline),
        "baseline": round6(baseline),
        "observed": round6(observed),
        "forecast_id": (band or {}).get("forecast_id", ""),
        "p_value": round6(z_to_p(z)),
        "materiality": score,
        "severity": severity_for(strength(observed, baseline, critical_pct,
                                          breaching, min_windows)),
        "status": "open",
        "engine_type": "stats",
    }, score)
