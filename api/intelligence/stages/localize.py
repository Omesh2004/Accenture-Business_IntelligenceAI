"""Stage 03 -- Localize. Which dimension cells explain the movement.

Operates on ADDITIVE fundamentals at the contract's grain.entity, never on a rate. For a ratio
the numerator and denominator are decomposed separately and reconciled, because a rate is not
additive across cells (CLAUDE.md, Never do).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from itertools import combinations

from api.intelligence import config
from api.intelligence.ids import cause_id, round6
from api.intelligence.metrics import Window
from api.intelligence.stages import psqueeze

logger = logging.getLogger(__name__)


@dataclass
class LocalizeResult:
    causes: list[dict] = field(default_factory=list)
    explained_pct: float = 0.0
    inconclusive: bool = False
    search_truncated: bool = False
    note: str = ""


def ratio_weights(ctx, metric_layer, contract, baseline_window) -> tuple[float, float] | None:
    """The denominator totals for the scored and baseline windows, or None when not a ratio.

    A rate is N/D. Decomposing only N answers a different question: for KYC the completion RATE
    fell while completions themselves ROSE, because starts rose faster. Every numerator cell then
    moved UP against a movement recorded as DOWN, the direction filter rejected all of them, and
    Localize reported that no segment was concentrated enough to be a driver -- of a leak that is
    plainly visible by region in the warehouse.

    With both totals in hand a cell's contribution becomes n_i/D, whose change across the two
    windows sums EXACTLY to the change in the rate. That is additive across cells, which is what
    the contribution figures have to be, and it is still computed on the underlying counts rather
    than on the rate itself.
    """
    if not contract.is_ratio:
        return None
    den = contract.denominator()
    if den is None:
        return None
    try:
        d_now = float(metric_layer.fundamental_total(ctx.tenant_id, den, ctx.window))
        d_base = float(metric_layer.fundamental_total(ctx.tenant_id, den, baseline_window))
    except Exception:                                               # noqa: BLE001
        return None
    if d_now <= 0 or d_base <= 0:
        return None
    return d_now, d_base


def _as_rate_shares(leaves: dict, weights: tuple[float, float] | None) -> dict:
    """Rescale raw counts into each cell's share of the rate, when the KPI is one."""
    if not weights:
        return leaves
    d_now, d_base = weights
    return {cell: (v / d_now, b / d_base) for cell, (v, b) in leaves.items()}


def _declined(ctx, note: str) -> "LocalizeResult":
    """Every inconclusive exit, logged against the KPI it happened on.

    Revenue published zero causes for weeks and the reason was never written down anywhere, so
    the dashboard showed an empty attribution card with no way to tell a genuine "no segment is
    concentrated" from a stage that had failed to run at all.
    """
    logger.info("localize declined for %s: %s", getattr(ctx, "kpi_id", "?"), note)
    return LocalizeResult(inconclusive=True, note=note)


def _moving_line(ctx, metric_layer, contract, baseline_window) -> dict | None:
    """For an additive KPI with several lines, the one that actually moved.

    Revenue is fee_revenue + interest_accrued + pro_revenue, and this used to take fundamentals[0]
    -- fee_revenue -- whatever the movement was made of. Interest accrued is by far the larger
    line, so a revenue move driven by it was searched inside a component that had not changed:
    no cell moved in the headline direction, every one was filtered out, and revenue published
    zero causes while every other KPI published several.

    CLAUDE.md section 5 says money is explained by which fee line moved, so choosing the line
    with the largest absolute movement IS the decomposition, not a shortcut past it.
    """
    lines = list(contract.fundamentals or [])
    if not lines:
        return None
    if len(lines) == 1:
        return lines[0]
    best, best_move = None, -1.0
    for spec in lines:                       # each is a {kpi_id, fundamental, ...} spec
        try:
            now = metric_layer.fundamental_total(ctx.tenant_id, spec, ctx.window)
            was = metric_layer.fundamental_total(ctx.tenant_id, spec, baseline_window)
        except Exception:                                            # noqa: BLE001
            continue
        move = abs(float(now) - float(was))
        if move > best_move:
            best, best_move = spec, move
    # Every line flat or unreadable: fall back to the declared order rather than returning none,
    # so the caller still gets a search instead of an abstention.
    return best or lines[0]


def run(ctx, metric_layer, anomaly: dict, dims: list[str], baseline_window) -> LocalizeResult:
    contract = ctx.contract
    if not dims:
        return _declined(ctx, "no admissible dimensions -- see contract dimensions.allowed")

    fundamental = contract.numerator() or _moving_line(ctx, metric_layer, contract, baseline_window)
    if fundamental is None:
        return _declined(ctx, "contract declares no fundamental")

    direction = int(anomaly.get("direction", -1))
    max_depth = min(contract.max_depth, len(dims))
    min_vol = contract.min_segment_volume
    # For a ratio every cell is measured as its share of the rate, so the parts sum to the
    # movement the anomaly recorded rather than to the numerator's own movement.
    weights = ratio_weights(ctx, metric_layer, contract, baseline_window)

    ranked: list[tuple[tuple, tuple, float, float]] = []  # (dims, cell, delta, baseline_value)
    truncated = False

    # PSqueeze first (CLAUDE.md section 9). It needs the leaves -- the finest cells -- so it can
    # cluster by deviation and test the ripple effect; one query gives them all.
    ps = _psqueeze_causes(ctx, metric_layer, fundamental, dims, direction, max_depth,
                          min_vol, baseline_window, weights)
    if ps:
        ranked = ps
        method = "psqueeze"
    else:
        method = "greedy_cube"

    for depth in range(1, max_depth + 1) if not ranked else []:
        for combo in combinations(dims, depth):
            try:
                # One query per combo, both windows at once.
                pairs = metric_layer.cell_deltas(
                    ctx.tenant_id, fundamental, list(combo), ctx.window, baseline_window,
                    min_vol)
            except Exception:
                truncated = True
                continue
            if weights:
                d_now, d_base = weights
                pairs = {c: (v / d_now, b / d_base) for c, (v, b) in pairs.items()}
            for cell, (cur_v, base_v) in pairs.items():
                delta = cur_v - base_v
                # Only cells moving the same way as the headline can explain it.
                if direction < 0 and delta >= 0:
                    continue
                if direction > 0 and delta <= 0:
                    continue
                ranked.append((combo, cell, delta, base_v))

    if not ranked:
        return _declined(ctx, "movement not explained by the available dimensions")

    # Share of the fundamental's total movement -- pooling overlapping depths would give
    # every cell an identical 1/N share.
    now_total = was_total = 0.0
    try:
        now_total = metric_layer.fundamental_total(ctx.tenant_id, fundamental, ctx.window)
        was_total = metric_layer.fundamental_total(ctx.tenant_id, fundamental, baseline_window)
        if weights:
            # Same units as the cells: the rate itself, so a contribution is a share of the
            # movement the reader was told about rather than of the numerator's own movement.
            d_now, d_base = weights
            now_total, was_total = now_total / d_now, was_total / d_base
        total_move = abs(now_total - was_total)
    except Exception:
        total_move = 0.0
    if total_move <= 0:
        total_move = max((abs(d) for _, _, d, _ in ranked), default=1.0)

    # A cell that took its own share of the movement explains nothing -- it is the distribution
    # restated. Unguarded, rank 1 was USA at 16.9% of the movement against a 16.5% natural
    # share, and three regions tied at ~25% of a uniform one. Shares below still cover every
    # cell, so contributions stay additive; this only decides whether ANY cell is concentrated
    # enough for the finding to name a driver at all.
    # Population share comes from the baseline, or from the current window when the baseline was
    # empty -- otherwise a cell that was zero looks infinitely concentrated and every cell passes.
    def _population_share(delta: float, base_v: float) -> float:
        """The cell's share of the population, from whichever window can support the estimate.

        A baseline holding a fraction of the current volume distributes as noise, and a cell that
        was absent from it looks infinitely concentrated -- both made ordinary cells rank first.
        """
        if base_v > 0 and was_total >= now_total * config.LOCALIZE_MIN_BASELINE_SHARE:
            return base_v / was_total
        return (base_v + delta) / now_total if now_total > 0 else 0.0

    if was_total > 0 or now_total > 0:
        margin = 1.0 + config.LOCALIZE_BASE_RATE_MARGIN
        if not any(abs(delta) > total_move * _population_share(delta, base_v) * margin
                   for _, _, delta, base_v in ranked):
            return LocalizeResult(
                inconclusive=True,
                note="every cell moved in proportion to its share of the population, so no "
                     "segment is concentrated enough to be called a driver")

    # Every tie is broken, so rank-1 cannot flip between identical runs. PSqueeze already
    # ordered by explanatory power; re-sorting on raw delta would throw that away and hand the
    # ranking back to whichever segment is simply biggest.
    if method != "psqueeze":
        order = {d: i for i, d in enumerate(dims)}
        ranked.sort(key=lambda r: (-abs(r[2]), len(r[0]),
                                   tuple(order.get(d, 99) for d in r[0]),
                                   "|".join(r[0]), "|".join(r[1])))

    # Coextensive cells describe the same rows under different names; an identical movement
    # is the signal for that, so keep only the simplest spelling.
    deduped: list[tuple[tuple, tuple, float, float]] = []
    seen_deltas: set[float] = set()
    for combo, cell, delta, base_v in ranked:
        key = round(delta, 6)
        if key in seen_deltas:
            continue
        seen_deltas.add(key)
        deduped.append((combo, cell, delta, base_v))

    # Coverage may only be summed WITHIN one dimension combination, where the cells partition
    # the population. Across combinations they overlap -- region "North America" and country
    # "USA" are the same rows -- and summing them reported 289% of the movement explained.
    per_combo: dict[tuple, float] = {}
    for combo, _cell, delta, _base_v in deduped[:config.MAX_CAUSES]:
        per_combo[combo] = per_combo.get(combo, 0.0) + abs(delta) / total_move
    covered = min(1.0, max(per_combo.values())) if per_combo else 0.0

    causes: list[dict] = []
    for rank, (combo, cell, delta, _base_v) in enumerate(deduped[:config.MAX_CAUSES], start=1):
        share = abs(delta) / total_move
        causes.append({
            "cause_id": cause_id(anomaly["anomaly_id"], rank),
            "investigation_id": ctx.investigation_id,
            "anomaly_id": anomaly["anomaly_id"],
            "tenant_id": ctx.tenant_id,
            "rank": rank,
            "dimensions": dict(zip(combo, cell)),
            "fundamental": str(fundamental.get("metric", "")),
            "contribution": round6(share),
            "method": method,
            "explained_pct": round6(covered),
            "engine_type": "stats",
        })

    return LocalizeResult(causes=causes, explained_pct=round6(covered),
                          search_truncated=truncated)


def _psqueeze_causes(ctx, metric_layer, fundamental, dims, direction, max_depth, min_vol,
                     baseline_window, weights=None):
    """PSqueeze per dimension, then rank the dimensions by how well each explains.

    gold.kpi_daily_by_dim is grained one dimension per row, so there are no cross-dimensional
    leaf cells to build cuboids from. Deviation clustering, the ripple effect and GPS all still
    apply within a dimension -- that is what lets a root cause be a SET (both affected regions)
    ranked by explanatory power rather than by raw size.
    """
    # The caller's baseline is the window immediately before this one, which a movement lasting
    # longer than one window sits inside -- comparing the leak against itself. Use the same long
    # pre-window history Detect uses, scaled to this window's length so deltas stay comparable.
    from datetime import timedelta
    span_days = max(1, (ctx.window.end - ctx.window.start).days)
    long_base = Window(ctx.window.start - timedelta(days=config.BASELINE_DAYS), ctx.window.start)
    scale = span_days / max(1, config.BASELINE_DAYS)

    # True multi-dimensional search when the cube is available: PSqueeze combines attributes
    # into cuboids, which 1-D marginals cannot support.
    if hasattr(metric_layer, "leaf_cells"):
        try:
            leaf_dims, leaves = metric_layer.leaf_cells(ctx.tenant_id, fundamental,
                                                        ctx.window, long_base, min_vol)
            # The long baseline is scaled to this window's length before it is turned into
            # shares, so the two sides of the comparison cover the same span.
            leaves = {c: (v, b * scale) for c, (v, b) in leaves.items()}
            leaves = _as_rate_shares(leaves, weights)
        except Exception:
            leaf_dims, leaves = [], {}
        usable = [d for d in leaf_dims if d in dims]
        if leaves and len(leaves) >= config.PSQUEEZE_MIN_LEAVES and usable:
            keep = [leaf_dims.index(d) for d in usable]
            packed = {tuple(cell[i] for i in keep): vf for cell, vf in leaves.items()}
            found = psqueeze.search(packed, usable, min(max_depth, len(usable)), direction)
            out = []
            for cand in found:
                idx = {d: i for i, d in enumerate(usable)}
                for value in cand.cell:
                    members = [c for c in cand.members
                               if all(c[idx[d]] == v for d, v in zip(cand.dims, value))]
                    if not members:
                        continue
                    delta = sum(packed[c][0] - packed[c][1] for c in members)
                    base = sum(packed[c][1] for c in members)
                    out.append((cand.dims, value, delta, base))
            if out:
                return out

    # Fall back to per-dimension marginals.
    best_per_dim = []
    for dim in dims:
        try:
            raw = metric_layer.cell_deltas(ctx.tenant_id, fundamental, [dim],
                                           ctx.window, long_base, min_vol)
            cells = {k: (cur, base * scale) for k, (cur, base) in raw.items()}
            # Same units as the cube path above. Left as raw counts this fallback handed the
            # concentration guard a count to compare against a rate, so a cell's "share of the
            # population" came out at 72 and every candidate was rejected.
            cells = _as_rate_shares(cells, weights)
        except Exception:
            continue
        if len(cells) < config.PSQUEEZE_MIN_LEAVES:
            continue
        found = psqueeze.search(cells, [dim], 1, direction)
        if found:
            best_per_dim.append((dim, found[0], cells))

    if not best_per_dim:
        return []
    # The dimension whose root-cause set explains the most comes first.
    best_per_dim.sort(key=lambda x: -x[1].gps)

    out = []
    for dim, cand, cells in best_per_dim:
        for value in cand.cell:
            if value not in cells:
                continue
            cur, base = cells[value]
            out.append(((dim,), value, cur - base, base))
    return out
