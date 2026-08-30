"""The rail must account for every gate, and entitlement must be stated rather than applied silently.

Three failures these guard against, all of which shipped:

  * A compound question ("which moved most AND what should I do") stopped as soon as the first
    capability returned, so Decide never ran and the lever was never told.
  * A capability the persona may not use was filtered out of the catalogue before the planner saw
    it, so the reader got an adjacent answer with no indication anything had been withheld.
  * A gate that did not run reported nothing at all, which reads identically to a gate that ran
    and found nothing.
"""
from api.intelligence import gates, personas, planner, tools


def _ctx(question: str, persona: str = "cfo") -> planner.Context:
    return planner.Context("nexabank", question, persona,
                           metric_ids=["fee_revenue", "kyc_completion_rate"])


def test_every_gate_reports_an_outcome():
    """No gate may be silently absent: skipped is a state with a reason, not a gap."""
    rail = gates.rail_state({}, reached=False)
    assert [g["id"] for g in rail] == [g.id for g in gates.RAIL]
    for gate in rail:
        assert gate["status"] in ("engaged", "skipped", "failed", "restricted")
        assert gate["detail"], "%s reported no reason for its status" % gate["id"]


def test_forecast_precedes_detect_on_the_rail():
    """Detect scores against the band Forecast produced; the rail would lie if it read otherwise."""
    order = [g.id for g in gates.RAIL]
    assert order.index("forecast") < order.index("detect")
    assert order.index("detect") < order.index("localize")
    assert order.index("verify") == len(order) - 1


def test_restricted_gate_is_named_not_hidden():
    """A CFO asking for an action must be told Decide is withheld, not handed something adjacent."""
    ctx = _ctx("which metric moved most and what should I do?", "cfo")
    assert not personas.allows("cfo", "action"), "fixture assumes the CFO cannot act"
    blocked = planner.restricted_capabilities(ctx)
    assert "get_recommendations" in [s.name for s in blocked]

    rail = gates.rail_state({}, reached=False, restricted={"decide": "not available"})
    decide = next(g for g in rail if g["id"] == "decide")
    assert decide["status"] == "restricted"
    assert decide["detail"] == "not available"


def test_a_persona_that_may_act_has_nothing_restricted():
    """The guard must not fire on entitlement the persona actually holds."""
    ctx = _ctx("which metric moved most and what should I do?", "ops_manager")
    assert personas.allows("ops_manager", "action")
    assert "get_recommendations" not in [s.name for s in planner.restricted_capabilities(ctx)]


def test_a_compound_question_is_not_complete_after_one_part():
    """`sufficient` means something is worth saying; `complete` means the whole question was asked."""
    ctx = _ctx("which metric moved most and what should I do?", "ops_manager")
    observed = [planner.Observation("rank_movements", {}, True, "4 outside band", "insights")]
    verdict = planner.validate(ctx, observed, claims=[])
    assert verdict.sufficient, "a usable result must never be withheld"
    assert not verdict.complete, "the action half of the question has not been consulted"
    assert "get_recommendations" in verdict.uncovered


def test_completeness_is_reached_once_every_asked_capability_ran():
    ctx = _ctx("which metric moved most and what should I do?", "ops_manager")
    asked = [spec.name for _, spec in planner.candidates(ctx, tools.catalogue("ops_manager"))]
    observed = [planner.Observation(name, {}, True, "ok", "insights") for name in asked]
    verdict = planner.validate(ctx, observed, claims=[])
    assert verdict.sufficient and verdict.complete
    assert not verdict.uncovered


def test_every_mapped_intent_points_at_a_real_gate():
    """A typo in the intent->gate map would light the wrong stage, or none."""
    for intent, gate_id in gates.INTENT_GATE.items():
        assert gate_id in gates.BY_ID, "%s maps to unknown gate %s" % (intent, gate_id)
    known = {spec.intent for spec in tools.REGISTRY.values()}
    unknown = sorted(set(gates.INTENT_GATE) - known)
    assert not unknown, "intent(s) mapped to a gate but owned by no capability: %s" % unknown
