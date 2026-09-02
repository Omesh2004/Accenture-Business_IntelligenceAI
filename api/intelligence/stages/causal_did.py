"""Difference-in-differences on the segment cube: an actual counterfactual, not a label.

Localize says WHERE a movement sits. That is attribution, and attribution is not an effect: the
segment it names may simply have been carried along by whatever moved the whole bank. To claim an
effect we have to say what that segment WOULD have done had nothing happened to it, and subtract.

The cube gives both windows for every leaf, so the counterfactual is available without any new
read. Treated cells are the ones Localize named; every other cell is the control group. Under the
parallel-trends assumption the control group's own pre-to-post ratio is what the treated cells
would have followed, so

    counterfactual = treated_pre * (control_post / control_pre)
    effect         = treated_post - counterfactual

which is difference-in-differences in the multiplicative form counts call for. The assumption is
not asserted, it is TESTED: the same estimator is run on an earlier window where, by construction,
the treatment had not happened yet. A placebo that returns a large effect means the two groups
were already diverging, parallel trends fails, and the caller must not claim an effect.

The interval is the spread of the per-cell effects (a t-interval over the treated cells), so a
movement concentrated in one cell reports a wide interval and an even one reports a narrow one.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import timedelta

from api.intelligence import config
from api.intelligence.metrics import Window

#: Student t, two-sided 95%, by degrees of freedom. Small samples are the normal case here.
_T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
        8: 2.306, 9: 2.262, 10: 2.228, 15: 2.131, 20: 2.086, 30: 2.042}


def _t_crit(df: int) -> float:
    if df <= 0:
        return 0.0
    for k in sorted(_T95):
        if df <= k:
            return _T95[k]
    return 1.96


@dataclass
class DidResult:
    ok: bool
    effect: float = 0.0
    lower: float = 0.0
    upper: float = 0.0
    counterfactual: float = 0.0
    observed: float = 0.0
    treated_cells: int = 0
    control_cells: int = 0
    placebo_effect: float = 0.0
    placebo_ratio: float = 1.0
    parallel_trends: bool = False
    reason: str = ""


def _split(leaves: dict[tuple, tuple[float, float]], dims: list[str],
           selector: dict[str, str]) -> tuple[list[tuple], list[tuple]]:
    """Treated cells are those matching every dimension value Localize named."""
    idx = {d: i for i, d in enumerate(dims)}
    pairs = [(idx[d], v) for d, v in selector.items() if d in idx]
    if not pairs:
        return [], []
    treated, control = [], []
    for cell in leaves:
        (treated if all(cell[i] == v for i, v in pairs) else control).append(cell)
    return treated, control


def _estimate(leaves: dict[tuple, tuple[float, float]], treated: list[tuple],
              control: list[tuple]) -> tuple[float, float, float, float]:
    """(effect, counterfactual, observed, per-cell standard error)."""
    c_post = sum(leaves[c][0] for c in control)
    c_pre = sum(leaves[c][1] for c in control)
    trend = (c_post / c_pre) if c_pre > 0 else 1.0

    per_cell = []
    for c in treated:
        post, pre = leaves[c]
        per_cell.append(post - pre * trend)
    observed = sum(leaves[c][0] for c in treated)
    counterfactual = sum(leaves[c][1] for c in treated) * trend
    effect = observed - counterfactual

    n = len(per_cell)
    if n < 2:
        return effect, counterfactual, observed, 0.0
    mean = sum(per_cell) / n
    var = sum((x - mean) ** 2 for x in per_cell) / (n - 1)
    # Standard error of the SUM of n cell effects.
    return effect, counterfactual, observed, math.sqrt(var * n)


def estimate(ctx, metric_layer, fundamental: dict, selector: dict[str, str]) -> DidResult:
    """Estimate the effect on the treated segment, and test the assumption it rests on."""
    if not selector or not hasattr(metric_layer, "leaf_cells"):
        return DidResult(False, reason="no cube available for a counterfactual")

    span = max(1, (ctx.window.end - ctx.window.start).days)
    pre = Window(ctx.window.start - timedelta(days=span), ctx.window.start)
    try:
        dims, leaves = metric_layer.leaf_cells(ctx.tenant_id, fundamental, ctx.window, pre, 0)
    except Exception as exc:
        return DidResult(False, reason=f"cube read failed: {exc}")

    treated, control = _split(leaves, dims, selector)
    if not treated:
        return DidResult(False, reason="the localized segment is not a cube dimension")
    if len(control) < config.DID_MIN_CONTROL_CELLS:
        return DidResult(False, treated_cells=len(treated), control_cells=len(control),
                         reason="too few unaffected segments to form a control group")

    effect, counterfactual, observed, se = _estimate(leaves, treated, control)

    # Placebo: the same estimator one window earlier, before the treatment. A real effect there
    # would mean the groups were already drifting apart and the estimate above is not causal.
    placebo = 0.0
    p_pre = Window(pre.start - timedelta(days=span), pre.start)
    try:
        p_dims, p_leaves = metric_layer.leaf_cells(ctx.tenant_id, fundamental, pre, p_pre, 0)
        p_treated, p_control = _split(p_leaves, p_dims, selector)
        if p_treated and len(p_control) >= config.DID_MIN_CONTROL_CELLS:
            placebo = _estimate(p_leaves, p_treated, p_control)[0]
    except Exception:
        placebo = 0.0

    ratio = abs(placebo) / abs(effect) if abs(effect) > 1e-9 else 1.0
    parallel = ratio <= config.DID_PLACEBO_MAX_RATIO

    half = _t_crit(len(treated) - 1) * se
    return DidResult(
        ok=True, effect=effect, lower=effect - half, upper=effect + half,
        counterfactual=counterfactual, observed=observed,
        treated_cells=len(treated), control_cells=len(control),
        placebo_effect=placebo, placebo_ratio=ratio, parallel_trends=parallel,
        reason="" if parallel else
        "placebo window shows the same divergence -- parallel trends does not hold",
    )
