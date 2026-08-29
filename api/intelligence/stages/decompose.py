"""Stage 02a -- Decompose. Which FACTOR moved, as distinct from which cell.

Localize answers "where in the cube". Decompose answers "price, volume or mix". Both are shown;
they answer different questions and a reader needs both to act.

LMDI-I (log-mean Divisia, Ang 2005) is used because it has a ZERO residual: the factor
contributions sum exactly to the observed change. The naive `delta_factor x share` split leaves
an interaction term that grows with the number of factors and visibly does not add up.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from api.intelligence.ids import derive_id, round6

EPSILON = 1e-12


@dataclass
class DecomposeResult:
    factors: list[dict] = field(default_factory=list)
    residual: float = 0.0
    total_change: float = 0.0
    method: str = "lmdi_i"
    note: str = ""

    @property
    def ok(self) -> bool:
        """A non-zero residual means the identity does not hold -- a correctness alarm."""
        return abs(self.residual) <= max(1e-6, abs(self.total_change) * 1e-9)


def log_mean(a: float, b: float) -> float:
    """L(a,b) = (a-b)/ln(a/b), with the limits LMDI needs at a==b and at zero."""
    if a <= 0 or b <= 0:
        return 0.0
    if abs(a - b) < EPSILON:
        return a
    return (a - b) / (math.log(a) - math.log(b))


def lmdi(current: dict[str, float], baseline: dict[str, float]) -> tuple[dict[str, float], float]:
    """Additive LMDI-I over a multiplicative identity V = prod(factors).

    Returns (per-factor contribution, residual). Contributions sum to V1 - V0 exactly.
    """
    v1 = 1.0
    for value in current.values():
        v1 *= value
    v0 = 1.0
    for value in baseline.values():
        v0 *= value

    total = v1 - v0
    if v1 <= 0 or v0 <= 0:
        # LMDI is undefined through zero; report rather than silently returning nonsense.
        return {}, total

    weight = log_mean(v1, v0)
    contributions = {}
    for name in sorted(current):
        a, b = current.get(name, 0.0), baseline.get(name, 0.0)
        if a <= 0 or b <= 0:
            contributions[name] = 0.0
            continue
        contributions[name] = weight * (math.log(a) - math.log(b))
    residual = total - sum(contributions.values())
    return contributions, residual


def price_volume_mix(current_cells: dict[tuple, dict],
                     baseline_cells: dict[tuple, dict]) -> DecomposeResult:
    """Split a value change into price, volume and mix across a set of cells.

    identity: value = total_volume x mix_share x price, per cell.
    Aggregating the per-cell LMDI terms gives the three headline factors with zero residual.
    """
    cur_vol = sum(c["volume"] for c in current_cells.values())
    base_vol = sum(c["volume"] for c in baseline_cells.values())
    cur_val = sum(c["value"] for c in current_cells.values())
    base_val = sum(c["value"] for c in baseline_cells.values())
    total_change = cur_val - base_val

    if cur_vol <= 0 or base_vol <= 0 or cur_val <= 0 or base_val <= 0:
        return DecomposeResult(total_change=round6(total_change), residual=round6(total_change),
                               note="a period has zero volume or value; LMDI is undefined there")

    # entry_exit carries cells present in only one period: LMDI is undefined through zero, and
    # skipping them would leave a residual -- the one thing LMDI-I is chosen to avoid.
    totals = {"volume": 0.0, "mix": 0.0, "price": 0.0, "entry_exit": 0.0}
    for cell in sorted(set(current_cells) | set(baseline_cells)):
        cur = current_cells.get(cell, {"volume": 0.0, "value": 0.0, "price": 0.0})
        base = baseline_cells.get(cell, {"volume": 0.0, "value": 0.0, "price": 0.0})
        cur_share = cur["volume"] / cur_vol if cur_vol else 0.0
        base_share = base["volume"] / base_vol if base_vol else 0.0

        decomposable = (cur["value"] > 0 and base["value"] > 0 and cur_share > 0
                        and base_share > 0 and cur["price"] > 0 and base["price"] > 0)
        if not decomposable:
            totals["entry_exit"] += cur["value"] - base["value"]
            continue

        # V_i = Q * share_i * price_i holds exactly, so these three terms sum to V_i1 - V_i0.
        weight = log_mean(cur["value"], base["value"])
        totals["volume"] += weight * (math.log(cur_vol) - math.log(base_vol))
        totals["mix"] += weight * (math.log(cur_share) - math.log(base_share))
        totals["price"] += weight * (math.log(cur["price"]) - math.log(base["price"]))

    residual = total_change - sum(totals.values())
    factors = [
        {"factor": name, "contribution": round6(value),
         "share_of_change": round6(value / total_change) if abs(total_change) > EPSILON else 0.0,
         "direction": 1 if value > 0 else (-1 if value < 0 else 0)}
        for name, value in sorted(totals.items(), key=lambda kv: (-abs(kv[1]), kv[0]))
    ]
    return DecomposeResult(factors=factors, residual=round6(residual),
                           total_change=round6(total_change))


def run(ctx, fact_reader, anomaly: dict, baseline_window) -> DecomposeResult:
    """Decompose the contract's declared factor identity, if it declares one."""
    identity = (ctx.contract.raw.get("decomposition") or {})
    if not identity.get("enabled"):
        return DecomposeResult(note="contract declares no factor identity")

    spec = None
    for fundamental in ctx.contract.fundamentals:
        if fundamental.get("table"):
            spec = fundamental
            break
    if spec is None:
        return DecomposeResult(note="factor decomposition needs a fact fundamental")

    dims = list(identity.get("mix_dimensions") or [])
    if not dims:
        return DecomposeResult(note="no mix dimensions declared")

    try:
        current = fact_reader.factors(ctx.tenant_id, spec, dims, ctx.window)
        baseline = fact_reader.factors(ctx.tenant_id, spec, dims, baseline_window)
    except Exception as exc:
        return DecomposeResult(note="factor read failed: %s" % type(exc).__name__)

    result = price_volume_mix(current, baseline)
    if not result.ok and result.factors:
        # Surfaced, never normalised away: a residual means the identity is wrong.
        result.note = "non-zero residual: the declared identity does not close"
    return result


def to_rows(ctx, anomaly: dict, result: DecomposeResult) -> list[dict]:
    """Factor contributions as root_causes rows, tagged so the UI can separate them from cells."""
    rows = []
    for rank, factor in enumerate(result.factors, start=1):
        rows.append({
            "cause_id": derive_id(anomaly["anomaly_id"], "factor", factor["factor"]),
            "investigation_id": ctx.investigation_id,
            "anomaly_id": anomaly["anomaly_id"],
            "tenant_id": ctx.tenant_id,
            "rank": rank,
            "dimensions": {"factor": factor["factor"]},
            "fundamental": "factor:%s" % factor["factor"],
            "contribution": abs(factor["share_of_change"]),
            "method": result.method,
            "explained_pct": round6(1.0 - abs(result.residual) /
                                    max(abs(result.total_change), EPSILON)),
            "engine_type": "stats",
        })
    return rows
