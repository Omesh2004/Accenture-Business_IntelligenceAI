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

    for depth in range(1, max_depth + 1):
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

    # Every tie is broken, so rank-1 cannot flip between identical runs.
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

    causes: list[dict] = []
    covered = 0.0
    for rank, (combo, cell, delta, _base_v) in enumerate(deduped[:config.MAX_CAUSES], start=1):
        share = abs(delta) / total_move
        covered += share
        causes.append({
            "cause_id": cause_id(anomaly["anomaly_id"], rank),
            "investigation_id": ctx.investigation_id,
            "anomaly_id": anomaly["anomaly_id"],
            "tenant_id": ctx.tenant_id,
            "rank": rank,
            "dimensions": dict(zip(combo, cell)),
            "fundamental": str(fundamental.get("metric", "")),
            "contribution": round6(share),
            "method": "greedy_cube",
            "explained_pct": round6(covered),
            "engine_type": "stats",
        })

    return LocalizeResult(causes=causes, explained_pct=round6(covered),
                          search_truncated=truncated)
