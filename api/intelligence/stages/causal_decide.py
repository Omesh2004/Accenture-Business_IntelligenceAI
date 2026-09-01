"""Stage 05 Causal and Stage 06 Decide.

Causal estimates the effect where the data supports one and labels the rung honestly where it
does not. It never claims more than the assumptions it tested.
Decide proposes from the contract's CLOSED lever list and never invents one.
"""
from __future__ import annotations

from dataclasses import dataclass

from api.intelligence import levers as lever_lib
from api.intelligence.stages import causal_did
from api.intelligence.ids import effect_id, rec_id, round6

RUNGS = ["association", "attribution", "corroborated_cause", "estimated_effect"]


@dataclass
class CausalResult:
    rung: str
    intervention: str
    point: float
    lower: float
    upper: float
    method: str
    assumptions_met: bool
    degraded_reason: str = ""
    #: what the treated segment would have done absent the movement, and what it actually did
    counterfactual: float = 0.0
    observed: float = 0.0
    placebo_effect: float = 0.0
    control_cells: int = 0


def run_causal(ctx, anomaly: dict, causes: list[dict], upstream_anomaly: dict | None = None,
               metric_layer=None) -> CausalResult:
    """Climb only as far as the evidence allows.

    association          -- something moved
    attribution          -- we know WHERE it moved (Localize returned cells)
    corroborated_cause   -- a declared upstream KPI moved first, in a consistent direction
    estimated_effect     -- a counterfactual was actually built and its assumption held: the
                            unaffected segments give the trend the localized segment would have
                            followed, difference-in-differences gives the effect, and a placebo
                            run on an earlier window confirms the two were not already diverging
    """
    contract = ctx.contract
    cfg = contract.causal_cfg
    degrade_to = cfg.get("degrade_to", "attribution")
    allowed = cfg.get("evidence_rungs", RUNGS)

    magnitude = float(anomaly.get("magnitude", 0.0))
    baseline = float(anomaly.get("baseline", 0.0)) or 1.0
    # Interval from the localization spread: wider when the move is diffuse.
    top = causes[0]["contribution"] if causes else 0.0
    spread = abs(magnitude) * (1.0 - min(top, 1.0)) if causes else abs(magnitude)

    # Try for a real effect first. Attribution is only the ceiling when no counterfactual holds.
    did = None
    if causes and metric_layer is not None and "estimated_effect" in allowed:
        fundamental = contract.numerator() or (contract.fundamentals[0]
                                               if contract.fundamentals else None)
        if fundamental is not None:
            did = causal_did.estimate(ctx, metric_layer, fundamental,
                                      causes[0].get("dimensions") or {})

    # An interval that spans zero is not an effect, however clean the estimate looks: the data
    # cannot rule out that nothing happened to this segment. Keep the number, drop the claim.
    significant = (did is not None and did.ok
                   and (did.lower > 0 or did.upper < 0))

    if did is not None and did.ok and did.parallel_trends and significant:
        seg = ", ".join(f"{k}={v}" for k, v in (causes[0].get("dimensions") or {}).items())
        return CausalResult(
            rung="estimated_effect", intervention=f"segment:{seg}",
            point=round6(did.effect), lower=round6(did.lower), upper=round6(did.upper),
            method="difference_in_differences", assumptions_met=True, degraded_reason="",
            counterfactual=round6(did.counterfactual), observed=round6(did.observed),
            placebo_effect=round6(did.placebo_effect), control_cells=did.control_cells)

    if upstream_anomaly is not None:
        rung = "corroborated_cause"
        intervention = f"upstream:{upstream_anomaly.get('kpi_id', '')}"
        reason = ""
        met = True
    elif causes:
        rung = "attribution"
        intervention = "none_declared"
        if did is not None and did.ok and did.parallel_trends and not significant:
            reason = ("counterfactual built, but its interval spans zero -- the segment's "
                      "movement is not separable from the movement of the rest")
        elif did is not None and did.reason:
            reason = did.reason
        else:
            reason = "no counterfactual available for this window; attribution is the ceiling"
        met = False
    else:
        rung = "association"
        intervention = "none_declared"
        reason = "no localized cells and no declared intervention"
        met = False

    if rung not in allowed:
        rung = degrade_to if degrade_to in allowed else "association"

    # A contract may forbid estimated_effect outright (pro_revenue does -- a dollar effect
    # would be an artefact of its fixed price constant).
    if rung == "estimated_effect" and "estimated_effect" not in allowed:
        rung = degrade_to
        reason = "contract forbids estimated_effect"

    return CausalResult(
        rung=rung, intervention=intervention,
        point=round6(magnitude), lower=round6(magnitude - spread),
        upper=round6(magnitude + spread), method="rule",
        counterfactual=round6(did.counterfactual) if did is not None and did.ok else 0.0,
        observed=round6(did.observed) if did is not None and did.ok else 0.0,
        placebo_effect=round6(did.placebo_effect) if did is not None and did.ok else 0.0,
        control_cells=did.control_cells if did is not None and did.ok else 0,
        assumptions_met=met, degraded_reason=reason,
    )


def to_effect_row(ctx, anomaly: dict, res: CausalResult) -> dict:
    return {
        "effect_id": effect_id(anomaly["anomaly_id"]),
        "investigation_id": ctx.investigation_id,
        "anomaly_id": anomaly["anomaly_id"],
        "tenant_id": ctx.tenant_id,
        "kpi_id": ctx.kpi_id,
        "intervention": res.intervention,
        "rung": res.rung,
        "effect_point": res.point,
        "effect_lower": res.lower,
        "effect_upper": res.upper,
        "method": res.method,
        "assumptions_met": int(res.assumptions_met),
        "degraded_reason": res.degraded_reason,
        "counterfactual": res.counterfactual,
        "observed": res.observed,
        "placebo_effect": res.placebo_effect,
        "control_cells": res.control_cells,
        "engine_type": "stats" if res.method != "rule" else "rule",
    }


# ---------------------------------------------------------------------------
# Stage 06 -- Decide

LEVER_HINTS = {
    "fix_kyc_step": ("kyc", "a KYC step is failing for the localized segment"),
    "simplify_form": ("form", "form friction in the localized segment"),
    "adjust_messaging": ("messaging", "messaging mismatch for the localized segment"),
    "review_approval_rules": ("approval", "approval rules may have tightened"),
    "investigate": ("", "insufficient evidence for a specific lever"),
}


@dataclass
class DecideResult:
    driver: str
    action: str
    lever: str
    owner_role: str
    impact_low: float
    impact_high: float
    confidence: float
    monitoring: dict


def _confidence(anomaly: dict, causes: list[dict], causal: CausalResult) -> float:
    """How much to trust this recommendation: evidence rung x how much the driver explains."""
    rung = {"association": 0.35, "attribution": 0.6,
            "corroborated_cause": 0.85, "estimated_effect": 0.95}.get(causal.rung, 0.35)
    share = float(causes[0].get("contribution", 0.0)) if causes else 0.0
    return round6(max(0.05, min(0.95, rung * (0.4 + 0.6 * min(1.0, share)))))


def run_decide(ctx, anomaly: dict, causes: list[dict], causal: CausalResult) -> DecideResult:
    contract = ctx.contract
    candidates = lever_lib.for_kpi(ctx.kpi_id, contract.allowed_levers)

    driver = ""
    if causes:
        driver = ", ".join(f"{k}={v}" for k, v in sorted(causes[0]["dimensions"].items()))

    # A lever needs a localized driver and evidence past mere association. Without that the
    # honest move is to investigate, not to propose an action nobody can justify.
    chosen, spec = "investigate", lever_lib.load_levers().get("investigate", {})
    if causes and causal.rung in {"attribution", "corroborated_cause", "estimated_effect"}:
        for name, cand in candidates:
            if name == "investigate":
                continue
            chosen, spec = name, cand
            break

    action = (f"{spec.get('label', chosen.replace('_', ' '))} — {driver}" if driver
              else spec.get("label", chosen.replace("_", " ")))

    # The gap this driver actually explains, scaled by the lever's declared recovery range.
    recoverable = abs(float(anomaly.get("magnitude", 0.0))) * (
        float(causes[0].get("contribution", 0.0)) if causes else 0.0)
    low, high = lever_lib.impact_range(spec, recoverable)

    return DecideResult(driver=driver or ctx.kpi_id, action=action, lever=chosen,
                        owner_role=contract.owner_role,
                        impact_low=round6(low), impact_high=round6(high),
                        confidence=_confidence(anomaly, causes, causal),
                        monitoring=lever_lib.monitoring(spec, ctx.kpi_id))


def to_rec_row(ctx, anomaly: dict, res: DecideResult) -> dict:
    return {
        "rec_id": rec_id(anomaly["anomaly_id"], res.lever),
        "investigation_id": ctx.investigation_id,
        "anomaly_id": anomaly["anomaly_id"],
        "tenant_id": ctx.tenant_id,
        "driver": res.driver,
        "action": res.action,
        "lever": res.lever,
        "owner_role": res.owner_role,
        "expected_impact": {"low": res.impact_low, "high": res.impact_high},
        "confidence": res.confidence,
        "monitoring": res.monitoring,
        "status": "proposed",
        "engine_type": "rule",
    }
