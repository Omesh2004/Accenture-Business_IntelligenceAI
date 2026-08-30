"""Stage 07 -- Narrate and Verify.

The claim set is built from Signal Store rows. The narrator may state only what it contains,
and the verifier rejects any figure in the draft that does not trace back to a claim.
Template mode is bit-exact and always available; the LLM is optional and changes only prose.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from api.intelligence import config
from api.intelligence.ids import insight_id, round6

# Personas are render configs over the SAME claim set, so numbers are identical by construction.
# Which sections each persona sees; an unknown persona gets everything.
# Every persona gets an action section. Which levers appear inside it is decided by
# `personas.owner_roles`, not by removing the section: a reader who is shown a movement and no
# route to act on it has been given half an answer, and the half that cannot be used.
PERSONA_SECTIONS = {
    "cfo": {"cause", "forecast", "impact", "action"},
    "ops_manager": {"cause", "action"},
    "analyst": {"cause", "forecast", "action", "impact"},
    "marketing_lead": {"cause", "forecast", "action"},
    "risk_officer": {"cause", "action", "forecast"},
    # A steward owns the `analytics` levers -- data quality remediation is still an action.
    "data_steward": {"cause", "action"},
}

# What EVERY known persona may see. An unrecognised persona gets this, not the widest set:
# adding a persona to rbac.json and forgetting it here must narrow the narrative, never widen it.
SAFE_SECTIONS = set.intersection(*PERSONA_SECTIONS.values()) if PERSONA_SECTIONS else set()

NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
# Dates are structural, not claims: the digits in 2026-08-01 are not three invented numbers.
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?")


@dataclass
class Claim:
    claim_id: str
    value: float
    unit: str
    source_table: str
    label: str


@dataclass
class ClaimSet:
    claims: dict[str, Claim] = field(default_factory=dict)
    facts: dict[str, str] = field(default_factory=dict)   # non-numeric, e.g. segment names

    def add(self, claim_id: str, value, unit: str, table: str, label: str) -> str:
        self.claims[claim_id] = Claim(claim_id, round6(value), unit, table, label)
        return claim_id

    def values(self) -> list[float]:
        return [c.value for c in self.claims.values()]

    def evidence(self) -> list[dict]:
        return [
            {"claim_id": c.claim_id, "value": c.value, "unit": c.unit,
             "source": c.source_table, "label": c.label}
            for c in sorted(self.claims.values(), key=lambda x: x.claim_id)
        ]


def build_claim_set(ctx, trust, anomaly, causes, band, causal, decision,
                    factors=None) -> ClaimSet:
    cs = ClaimSet()
    cs.facts["kpi"] = ctx.contract.name
    cs.facts["trust_verdict"] = trust.verdict
    cs.facts["window_start"] = ctx.window.start.date().isoformat()
    cs.facts["window_end"] = ctx.window.end.date().isoformat()
    # A trust finding is a Signal Store row, so any figure it carries is already evidence.
    if getattr(trust, "cheapest_check", ""):
        cs.facts["cheapest_check"] = trust.cheapest_check
    if getattr(trust, "fingerprint", ""):
        cs.facts["fingerprint"] = trust.fingerprint

    if anomaly:
        # A ratio KPI is scored on its own rate, so its figures are ratios, not counts.
        unit = "ratio" if getattr(ctx, "rate_scored", False) else "count"
        cs.add("observed", anomaly["observed"], unit, "anomalies", "observed value")
        cs.add("baseline", anomaly["baseline"], unit, "anomalies", "expected value")
        cs.add("magnitude", anomaly["magnitude"], unit, "anomalies", "absolute change")
        cs.add("materiality", anomaly["materiality"], "score", "anomalies", "materiality")
        base = abs(float(anomaly["baseline"])) or 1.0
        cs.add("pct_change", abs(float(anomaly["magnitude"])) / base * 100.0, "percent",
               "anomalies", "percent change")
        cs.facts["direction"] = "fell" if anomaly["direction"] < 0 else "rose"
        cs.facts["severity"] = anomaly["severity"]

    for i, cause in enumerate(causes[:3], start=1):
        cs.add(f"cause_{i}_contribution", cause["contribution"] * 100.0, "percent",
               "root_causes", f"rank {i} contribution")
        cs.facts[f"cause_{i}_segment"] = ", ".join(
            f"{k}={v}" for k, v in sorted(cause["dimensions"].items()))

    if band:
        cs.add("forecast_point", band.get("point", 0), "count", "forecasts", "forecast point")
        cs.add("forecast_lower", band.get("lower", 0), "count", "forecasts", "forecast lower")
        cs.add("forecast_upper", band.get("upper", 0), "count", "forecasts", "forecast upper")
        cs.facts["forecast_method"] = str(band.get("method", ""))
        if band.get("caveat"):
            cs.facts["forecast_caveat"] = str(band["caveat"])

    if causal:
        cs.facts["rung"] = causal.rung
        cs.add("effect_lower", causal.lower, "count", "causal_effects", "effect lower bound")
        cs.add("effect_upper", causal.upper, "count", "causal_effects", "effect upper bound")

    # Factor drivers: which of price/volume/mix moved, alongside WHERE it moved.
    if factors is not None and getattr(factors, "factors", None):
        top = factors.factors[0]
        cs.add("factor_1_share", abs(top["share_of_change"]) * 100.0, "percent",
               "root_causes", "top factor share of change")
        cs.facts["factor_1"] = top["factor"]
        cs.facts["factor_method"] = factors.method
        offsetting = [f["factor"] for f in factors.factors[1:]
                      if f["direction"] and f["direction"] != top["direction"]]
        if offsetting:
            cs.facts["factor_offset"] = offsetting[0]

    if decision:
        cs.facts["action"] = decision.action
        cs.facts["lever"] = decision.lever
        cs.facts["owner"] = decision.owner_role
        cs.add("impact_high", decision.impact_high, "count", "recommendations",
               "optimistic recoverable impact")
    return cs


def apply_entitlement(claim_set: ClaimSet, contract, persona: str) -> tuple[ClaimSet, bool]:
    """Every persona sees every movement. What changes is the ANSWER, not the visibility.

    This used to drop the whole claim set when `contract.visible_to` omitted the persona, and the
    result was a monitoring surface that monitored almost nothing: an Operations Manager could see
    2 of 20 metrics and none of the 7 that had actually moved, so the page truthfully reported "no
    movement recorded" while the business had seven anomalies running.

    Hiding a movement from the person who could act on it is the opposite of what this layer is
    for. Persona still shapes the answer, and it does so where it belongs:

      * `personas.detail`      how much method is shown (summary / standard / full)
      * `personas.lead_in`     how the finding is framed for that reader
      * `personas.owner_roles` which levers are THEIRS to pull; the rest are shown as belonging to
                               another owner rather than withheld

    `contract.visible_to` is left in the contracts as a record of intended readership, but it no
    longer gates what anyone is allowed to be told.
    """
    return claim_set, False


def verify(draft: str, claim_set: ClaimSet) -> tuple[bool, list[str]]:
    """Every number in the draft must trace to a claim within tolerance.

    Returns (ok, unsupported_tokens). This is the guarantee, not a hope: an unverified figure
    never reaches a reader.
    """
    text = DATE_RE.sub(" ", draft)

    allowed: set[float] = set()
    for value in claim_set.values():
        allowed.update({round(value, 2), round(value, 1), float(int(value))})
    # Numbers appearing inside a verified fact (a segment label such as tier=2) are supported.
    for fact in claim_set.facts.values():
        for token in NUMBER_RE.findall(str(fact)):
            allowed.add(float(token))

    unsupported: list[str] = []
    for token in NUMBER_RE.findall(text):
        value = float(token)
        if not any(abs(value - a) <= config.VERIFIER_TOLERANCE for a in allowed):
            unsupported.append(token)
    return (not unsupported), unsupported


def render_template(ctx, claim_set: ClaimSet, persona: str, trust, abstained: bool) -> tuple[str, str]:
    """Deterministic narrative. Bit-exact, always available, carries all five scenarios."""
    f = claim_set.facts
    c = claim_set.claims

    def num(key: str, fmt: str = "{:.2f}") -> str:
        return fmt.format(c[key].value) if key in c else "n/a"

    if trust.verdict == "fail":
        headline = f"{f.get('kpi', ctx.kpi_id)}: data defect, metric quarantined"
        body = (
            f"The movement in {f.get('kpi', ctx.kpi_id)} between {f.get('window_start')} and "
            f"{f.get('window_end')} is not a business event. Trust Gate failed on "
            f"{trust.fingerprint or 'a hard invariant'}, so the metric is quarantined and no "
            f"growth claim is made. Figures for this window are unreliable. Routed to "
            f"engineering."
        )
        return headline, body

    if abstained or trust.verdict == "ambiguous":
        headline = f"{f.get('kpi', ctx.kpi_id)}: evidence is ambiguous, abstaining"
        body = (
            f"Evidence for {f.get('kpi', ctx.kpi_id)} over {f.get('window_start')} to "
            f"{f.get('window_end')} does not settle the question. "
            f"{trust.cheapest_check or 'Gather more data'} is the cheapest check that would "
            f"resolve it. No recommendation is made until it does."
        )
        return headline, body

    if "observed" not in c:
        headline = f"{f.get('kpi', ctx.kpi_id)}: no material movement"
        return headline, (
            f"{f.get('kpi', ctx.kpi_id)} stayed within its expected band between "
            f"{f.get('window_start')} and {f.get('window_end')}.")

    direction = f.get("direction", "moved")
    headline = (f"{f.get('kpi', ctx.kpi_id)} {direction} {num('pct_change', '{:.1f}')}% "
                f"({f.get('severity', 'info')})")

    parts = [
        f"{f.get('kpi', ctx.kpi_id)} {direction} to {num('observed')} against an expected "
        f"{num('baseline')} between {f.get('window_start')} and {f.get('window_end')}, a change "
        f"of {num('pct_change', '{:.1f}')}%."
    ]
    if "cause_1_segment" in f:
        parts.append(
            f"It concentrates in {f['cause_1_segment']}, which accounts for "
            f"{num('cause_1_contribution', '{:.1f}')}% of the move.")
    sections = PERSONA_SECTIONS.get(persona, SAFE_SECTIONS)
    if "forecast" in sections and "forecast_point" in c:
        caveat = f.get("forecast_caveat")
        tail = f" ({caveat.replace('_', ' ')})" if caveat else ""
        parts.append(
            f"The {f.get('forecast_method', 'baseline')} forecast projects "
            f"{num('forecast_point')} with a band of {num('forecast_lower')} to "
            f"{num('forecast_upper')}{tail}.")
    if "factor_1" in f and "factor_1_share" in c:
        offset = f.get("factor_offset")
        tail = f", partly offset by {offset}" if offset else ""
        parts.append(
            f"By factor, {f['factor_1']} accounts for "
            f"{num('factor_1_share', '{:.1f}')}% of the change{tail}.")
    if "rung" in f:
        parts.append(f"Evidence rung: {f['rung'].replace('_', ' ')}.")
    if "action" in sections and "action" in f:
        parts.append(
            f"Proposed action for {f.get('owner', 'the owner')}: {f['action']} "
            f"(lever: {f.get('lever')}), worth up to {num('impact_high')} if fully recovered. "
            f"Requires approval.")

    sim = ctx.contract.simulated
    if sim and sim.get("narrative_qualifier"):
        parts.append(f"Figures are {sim['narrative_qualifier']}.")

    return headline, " ".join(parts)


def to_insight_row(ctx, persona: str, headline: str, narrative: str, claim_set: ClaimSet,
                   trust, anomaly, breakdown: dict, abstained: bool, verifier_pass: bool) -> dict:
    confidence = 0.5
    if anomaly:
        confidence = min(0.95, 0.5 + float(anomaly.get("materiality", 0)) * 0.5)
    if abstained or trust.verdict != "pass":
        confidence = 0.3
    return {
        "insight_id": insight_id(ctx.investigation_id, persona),
        "investigation_id": ctx.investigation_id,
        "tenant_id": ctx.tenant_id,
        "kpi_id": ctx.kpi_id,
        "anomaly_id": (anomaly or {}).get("anomaly_id", ""),
        "persona": persona,
        "generated_at": ctx.started_at,
        "trust_verdict": trust.verdict,
        "headline": headline,
        "narrative": narrative,
        "evidence": claim_set.evidence(),
        "llm_breakdown": breakdown,
        "confidence": round6(confidence),
        "simulated": int(bool(ctx.contract.simulated)),
        "abstained": int(abstained),
        "verifier_pass": int(verifier_pass),
    }
