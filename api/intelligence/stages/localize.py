"""Stage 03 -- Localize. Which dimension cells explain the movement.

Operates on ADDITIVE fundamentals at the contract's grain.entity, never on a rate. For a ratio
the numerator and denominator are decomposed separately and reconciled, because a rate is not
additive across cells (CLAUDE.md, Never do).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations

from api.intelligence import config
from api.intelligence.ids import cause_id, round6
from api.intelligence.metrics import Window
from api.intelligence.stages import psqueeze


@dataclass
class LocalizeResult:
    causes: list[dict] = field(default_factory=list)
    explained_pct: float = 0.0
    inconclusive: bool = False
    search_truncated: bool = False
    note: str = ""


def run(ctx, metric_layer, anomaly: dict, dims: list[str], baseline_window) -> LocalizeResult:
    contract = ctx.contract
    if not dims:
        return LocalizeResult(inconclusive=True,
                              note="no admissible dimensions -- see contract dimensions.allowed")

    fundamental = contract.numerator() or (contract.fundamentals[0] if contract.fundamentals else None)
    if fundamental is None:
        return LocalizeResult(inconclusive=True, note="contract declares no fundamental")

    direction = int(anomaly.get("direction", -1))
    max_depth = min(contract.max_depth, len(dims))
    min_vol = contract.min_segment_volume

    ranked: list[tuple[tuple, tuple, float, float]] = []  # (dims, cell, delta, baseline_value)
    truncated = False

    # PSqueeze first (CLAUDE.md section 9). It needs the leaves -- the finest cells -- so it can
    # cluster by deviation and test the ripple effect; one query gives them all.
    ps = _psqueeze_causes(ctx, metric_layer, fundamental, dims, direction, max_depth,
                          min_vol, baseline_window)
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
            for cell, (cur_v, base_v) in pairs.items():
                delta = cur_v - base_v
                # Only cells moving the same way as the headline can explain it.
                if direction < 0 and delta >= 0:
                    continue
                if direction > 0 and delta <= 0:
                    continue
                ranked.append((combo, cell, delta, base_v))

    if not ranked:
        return LocalizeResult(inconclusive=True,
                              note="movement not explained by the available dimensions")

    # Share of the fundamental's total movement -- pooling overlapping depths would give
    # every cell an identical 1/N share.
    now_total = was_total = 0.0
    try:
        now_total = metric_layer.fundamental_total(ctx.tenant_id, fundamental, ctx.window)
        was_total = metric_layer.fundamental_total(ctx.tenant_id, fundamental, baseline_window)
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
                     baseline_window):
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

    best_per_dim = []
    for dim in dims:
        try:
            raw = metric_layer.cell_deltas(ctx.tenant_id, fundamental, [dim],
                                           ctx.window, long_base, min_vol)
            cells = {k: (cur, base * scale) for k, (cur, base) in raw.items()}
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
