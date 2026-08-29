"""The orchestration layer: dynamic tool selection, guardrails, validation and re-planning.

These lock the properties that make an LLM safe to put in charge of control flow:
  * the flow is not hard-coded -- the same loop serves every question, and which tools run is
    decided from the catalogue at runtime;
  * a bad plan fails closed -- unknown tools, unentitled tools and unknown arguments are refused
    before execution;
  * the model never supplies a number -- every figure comes from a tool result and is verified;
  * the loop terminates -- it stops on the critic's verdict or on the round bound, never later.
"""
import pytest

from api.intelligence import loop, personas, planner, tools


class _Spy:
    """A planner that returns a scripted sequence, so the loop's behaviour is what is under test."""

    engine = "spy"

    def __init__(self, plans):
        self.plans = plans
        self.seen: list[int] = []

    def plan(self, ctx, observations, round_n):
        self.seen.append(round_n)
        return self.plans[min(round_n, len(self.plans) - 1)]


# ── tool registry ──────────────────────────────────────────────────────────
def test_every_tool_declares_what_the_planner_needs():
    for name, spec in tools.REGISTRY.items():
        assert spec.description and len(spec.description) > 20, name
        assert spec.intent, name
        assert "tenant_id" in spec.params, name
        assert spec.render is not None, name


def test_a_tools_citation_names_a_real_source():
    """A source chip that names nothing is worse than no chip."""
    known = {"insights", "anomalies", "root_causes", "recommendations", "trust_findings",
             "forecasts", "source_freshness", "model_runs", "contracts", "tools"}
    res = tools.run("list_metrics", {"tenant_id": "nexabank"}, "analyst")
    assert not res.ok or res.citation in known


def test_the_catalogue_is_persona_scoped():
    cfo = {s.name for s in tools.catalogue("cfo")}
    ops = {s.name for s in tools.catalogue("ops_manager")}
    analyst = {s.name for s in tools.catalogue("analyst")}
    # Root-cause analysis is NOT a persona privilege. Every persona gets drivers; depth decides
    # how many and at what precision. Withholding the capability left the CFO with movement
    # summaries and no explanation of any of them.
    assert "get_causes" in cfo and "get_causes" in ops and "get_causes" in analyst
    # Depth and decision rights still scope the catalogue.
    assert "get_factors" not in cfo, "method-level decomposition is an analyst section"
    assert "get_recommendations" not in cfo, "the CFO does not own operational levers"
    assert cfo < analyst


# ── guardrails ─────────────────────────────────────────────────────────────
def test_an_unknown_tool_is_refused():
    with pytest.raises(tools.ToolError):
        tools.validate_call("drop_database", {"tenant_id": "t"}, "analyst")


def test_an_unentitled_tool_is_refused():
    # `get_factors` is method-level decomposition, an analyst section. (`get_causes` used to be
    # the example here, until withholding drivers from the CFO turned out to be the bug.)
    with pytest.raises(tools.ToolError):
        tools.validate_call("get_factors", {"tenant_id": "t"}, "cfo")


def test_an_argument_the_schema_does_not_name_is_refused():
    """A hallucinated argument must fail closed rather than reach the function."""
    with pytest.raises(tools.ToolError):
        tools.validate_call("get_insight", {"tenant_id": "t", "sql": "DROP TABLE"}, "analyst")


def test_a_missing_required_argument_is_refused():
    with pytest.raises(tools.ToolError):
        tools.validate_call("compare_metrics", {"tenant_id": "t"}, "analyst")


def test_a_tool_that_raises_becomes_an_observation(monkeypatch):
    monkeypatch.setattr(tools.REGISTRY["list_metrics"], "fn",
                        lambda **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    res = tools.run("list_metrics", {"tenant_id": "t"}, "analyst")
    assert not res.ok and "boom" in res.reason


# ── dynamic selection ──────────────────────────────────────────────────────
def test_tool_selection_is_not_a_fixed_sequence():
    """Different questions must produce different plans from the same code path."""
    brain = planner.RulePlanner()
    ctx_a = planner.Context("nexabank", "why did it drop", "analyst", ["loan_approval_volume"])
    ctx_b = planner.Context("nexabank", "how current is the data", "analyst",
                            ["loan_approval_volume"])
    a = {c.tool for c in brain.plan(ctx_a, [], 0).calls}
    b = {c.tool for c in brain.plan(ctx_b, [], 0).calls}
    assert a != b
    assert "get_source_health" in b and "get_source_health" not in a


def test_independent_tools_are_planned_in_one_round():
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", "why did it drop and what should we do", "analyst",
                          ["loan_approval_volume"])
    plan = brain.plan(ctx, [], 0)
    assert len(plan.calls) >= 2, "a two-part question should fan out rather than serialise"


def test_the_planner_replans_when_nothing_came_back():
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", "how current is loan approval volume", "analyst",
                          ["loan_approval_volume"])
    ctx.focus_metric = "loan_approval_volume"
    failed = [planner.Observation("get_source_health", {}, False, "", "", "no source loaded")]
    plan = brain.plan(ctx, failed, 1)
    assert plan.calls and plan.calls[0].tool != "get_source_health"


def test_the_planner_does_not_widen_onto_an_unrelated_metric():
    """Widening after an empty result must not answer a question nobody asked."""
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", "what is the capital of France", "analyst",
                          ["loan_approval_volume"])
    failed = [planner.Observation("get_metric_contract", {}, False, "", "", "no contract")]
    plan = brain.plan(ctx, failed, 1)
    assert plan.done and not plan.calls


def test_the_planner_stops_once_nothing_relevant_is_left():
    """Stopping is about coverage, not about the first success.

    It used to stop as soon as ONE tool returned something, so a two-part question was answered
    in half. It now stops when no relevant capability remains untried.
    """
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", "why did it drop", "analyst", [])
    tried = [planner.Observation(spec.name, {}, True, "ok", "insights")
             for _, spec in brain._candidates(ctx, tools.catalogue("analyst"))]
    assert brain.plan(ctx, tried, 1).done


def test_the_planner_pursues_the_part_it_has_not_answered_yet():
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", "why did it drop and what should we do", "analyst",
                          ["loan_approval_volume"])
    ctx.focus_metric = "loan_approval_volume"
    partial = [planner.Observation("get_insight", {}, True, "movement recorded", "insights")]
    plan = brain.plan(ctx, partial, 1)
    assert not plan.done, "a half-answered question must not be declared finished"
    assert "get_insight" not in {c.tool for c in plan.calls}, "it must not repeat itself"
    assert plan.calls


# ── the loop ───────────────────────────────────────────────────────────────
def test_the_loop_is_bounded(monkeypatch):
    """A planner that never says done must still terminate."""
    never_done = _Spy([planner.Plan("keep going", [planner.Call("list_metrics",
                                                                {"tenant_id": "nexabank"})])])
    monkeypatch.setattr(planner, "choose", lambda engine="auto": never_done)
    res = loop.run("nexabank", "anything", "analyst")
    assert res.rounds <= loop.MAX_ROUNDS
    assert len(never_done.seen) <= loop.MAX_ROUNDS


def test_a_refused_call_does_not_stop_the_round(monkeypatch):
    plan = planner.Plan("mixed", [planner.Call("not_a_tool", {"tenant_id": "nexabank"}),
                                  planner.Call("list_metrics", {"tenant_id": "nexabank"})])
    monkeypatch.setattr(planner, "choose", lambda engine="auto": _Spy([plan]))
    res = loop.run("nexabank", "which kpis do you track", "analyst")
    assert "list_metrics" in res.tools_used
    assert any(s["status"] == "failed" for s in res.trace)


def test_the_trace_shows_every_phase():
    res = loop.run("nexabank", "why did loan approval volume fall", "analyst")
    kinds = {s["kind"] for s in res.trace}
    assert {"reason", "act", "validate"} <= kinds
    assert [s["n"] for s in res.trace] == list(range(1, len(res.trace) + 1))


def test_the_answer_carries_its_sources():
    res = loop.run("nexabank", "why did loan approval volume fall", "analyst")
    assert not res.abstained
    assert res.citations and all(c["tool"] and c["source"] for c in res.citations)


def test_a_figure_with_no_stored_row_is_refused(monkeypatch):
    """The verifier is the last gate: prose that states an unsourced number cannot ship."""
    monkeypatch.setattr(tools.REGISTRY["list_metrics"], "render",
                        lambda res, persona: "Exactly 4242 metrics are tracked.")
    plan = planner.Plan("one call", [planner.Call("list_metrics", {"tenant_id": "nexabank"})])
    monkeypatch.setattr(planner, "choose", lambda engine="auto": _Spy([plan]))
    res = loop.run("nexabank", "which kpis do you track", "analyst")
    assert res.abstained and not res.verifier_pass


def test_contradiction_between_two_sources_is_surfaced():
    ctx = planner.Context("nexabank", "q", "analyst", [])
    obs = [planner.Observation("a", {}, True, "ok", "insights"),
           planner.Observation("b", {}, True, "ok", "anomalies")]
    claims = [{"claim_id": "observed", "value": 10.0, "unit": "count", "source": "insights",
               "label": "observed"},
              {"claim_id": "observed", "value": 42.0, "unit": "count", "source": "anomalies",
               "label": "observed"}]
    result = planner.validate(ctx, obs, claims)
    assert result.sufficient and any("disagree" in i for i in result.issues)


def test_repeated_empty_results_escalate_rather_than_guess():
    ctx = planner.Context("nexabank", "q", "analyst", [])
    obs = [planner.Observation("a", {}, False, "", "", "nothing"),
           planner.Observation("b", {}, False, "", "", "nothing")]
    result = planner.validate(ctx, obs, [])
    assert not result.sufficient and result.escalate


# ── persona shaping through the loop ───────────────────────────────────────
def test_the_same_question_reaches_different_tools_per_persona():
    """Asserted on capability, not on today's data: whether a metric happens to have moved
    depends on the scoring window, and a test that drifts with it stops meaning anything."""
    cfo = loop.run("nexabank", "why did loan approval volume fall", "cfo")
    ops = loop.run("nexabank", "why did loan approval volume fall", "ops_manager")
    assert "get_causes" not in cfo.tools_used, "the CFO view has no segment section"

    # Runtime cost is analyst-only, so the same question must diverge whatever the data shows.
    analyst = loop.run("nexabank", "what did this analysis cost", "analyst")
    ops_cost = loop.run("nexabank", "what did this analysis cost", "ops_manager")
    assert "get_runtime_cost" in analyst.tools_used
    assert "get_runtime_cost" not in ops_cost.tools_used
    assert analyst.answer != ops_cost.answer


def test_a_persona_never_reaches_a_tool_outside_its_catalogue():
    for pid in personas.REGISTRY:
        allowed = {s.name for s in tools.catalogue(pid)}
        res = loop.run("nexabank", "how much did this cost and where is it concentrated", pid)
        assert set(res.tools_used) <= allowed, pid


def test_extending_the_registry_needs_no_change_to_the_loop(monkeypatch):
    """The point of the split: a new capability becomes usable without touching orchestration."""
    called = {}

    def _fn(tenant_id, persona, **_):
        called["yes"] = True
        return tools.ToolResult(True, summary="ok", facts={"note": "hello"}, citation="insights")

    spec = tools.ToolSpec("brand_new_capability", "A capability added at runtime for this test.",
                          "status", {"tenant_id": {"type": "string", "required": True}}, _fn,
                          selectors=("zzzunique",), render=lambda r, p: "A new capability ran.")
    monkeypatch.setitem(tools.REGISTRY, "brand_new_capability", spec)
    res = loop.run("nexabank", "zzzunique please", "analyst")
    assert called.get("yes") and "brand_new_capability" in res.tools_used


# ── the model planner, exercised without a model ────────────────────────────
# vLLM is optional and unavailable on some hosts, so the LLM control path is proven by stubbing
# the transport. What is under test is the orchestration contract, not the model.

def _stub_llm(monkeypatch, replies):
    calls = {"n": 0}

    def _complete(prompt, max_tokens=None):
        i = min(calls["n"], len(replies) - 1)
        calls["n"] += 1
        return replies[i], 120, 30

    monkeypatch.setattr(loop.llm_client, "available", lambda: (True, "stub-model"))
    monkeypatch.setattr(planner.llm_client, "available", lambda: (True, "stub-model"))
    monkeypatch.setattr(planner.llm_client, "complete_json", _complete)
    return calls


def test_a_model_plan_is_executed_as_written(monkeypatch):
    _stub_llm(monkeypatch, [
        {"thought": "I need the standing finding and its segments.", "done": False,
         "calls": [{"tool": "get_insight", "args": {"tenant_id": "nexabank"}},
                   {"tool": "get_causes", "args": {"tenant_id": "nexabank"}}]},
        {"thought": "That answers it.", "done": True, "calls": []},
    ])
    res = loop.run("nexabank", "why did loan approval volume fall", "analyst", engine="llm")
    assert res.engine_type == "llm"
    # ATTEMPTED, not succeeded: a tool may legitimately return nothing when the metric is quiet.
    # What is under test is that the loop runs the plan it was handed.
    attempted = {s["tool"] for s in res.trace if s["tool"].startswith("tools.")}
    assert attempted == {"tools.get_insight", "tools.get_causes"}
    assert any("I need the standing finding" in s["detail"] for s in res.trace)
    assert res.tokens_in > 0


def test_a_model_that_asks_for_a_forbidden_tool_is_refused(monkeypatch):
    """The catalogue is persona-scoped, but the guardrail must hold even if a plan ignores it."""
    _stub_llm(monkeypatch, [
        {"thought": "Decompose it by factor.", "done": False,
         "calls": [{"tool": "get_factors", "args": {"tenant_id": "nexabank"}}]},
        {"thought": "Try the standing finding instead.", "done": False,
         "calls": [{"tool": "get_insight", "args": {"tenant_id": "nexabank"}}]},
    ])
    res = loop.run("nexabank", "was it price or volume", "cfo", engine="llm")
    assert "get_factors" not in res.tools_used
    assert any(s["status"] == "failed" and "may not use" in s["detail"] for s in res.trace)


def test_a_model_that_invents_an_argument_is_refused(monkeypatch):
    _stub_llm(monkeypatch, [
        {"thought": "Query it directly.", "done": False,
         "calls": [{"tool": "get_insight",
                    "args": {"tenant_id": "nexabank", "sql": "SELECT * FROM events_raw"}}]},
        {"thought": "Fall back.", "done": True, "calls": []},
    ])
    res = loop.run("nexabank", "why did it drop", "analyst", engine="llm")
    assert any("unexpected argument" in s["detail"] for s in res.trace)


def test_unparseable_model_output_falls_back_to_the_deterministic_planner(monkeypatch):
    _stub_llm(monkeypatch, [None])
    res = loop.run("nexabank", "why did loan approval volume fall", "analyst", engine="llm")
    assert res.tools_used, "a model that returns nothing must not silence the agent"
    assert not res.abstained


def test_the_model_cannot_introduce_a_number(monkeypatch):
    """Even if a plan's prose contains figures, only tool output reaches the answer."""
    _stub_llm(monkeypatch, [
        {"thought": "Revenue is definitely down 91.7% this week.", "done": False,
         "calls": [{"tool": "get_insight", "args": {"tenant_id": "nexabank"}}]},
        {"thought": "Done.", "done": True, "calls": []},
    ])
    res = loop.run("nexabank", "why did loan approval volume fall", "analyst", engine="llm")
    assert "91.7" not in res.answer


def test_an_unrelated_question_is_not_answered_with_a_variance_report():
    """The worst failure mode: a confident, sourced answer to a question nobody asked."""
    for persona in ("cfo", "ops_manager", "analyst"):
        res = loop.run("nexabank", "What is the capital of France?", persona)
        assert res.abstained, persona
        assert "loan" not in res.answer.lower(), persona
        assert res.suggestions, persona


def test_a_definition_question_still_works_when_the_metric_is_named():
    res = loop.run("nexabank", "what is net deposit growth", "analyst")
    assert not res.abstained
    assert "get_metric_contract" in res.tools_used


def test_an_abstention_names_the_reason_a_reader_can_act_on():
    """"nothing attempted" is not a reason. A metric outside the persona's view is."""
    res = loop.run("nexabank", "compare fee revenue and pro revenue", "ops_manager")
    assert res.abstained
    assert "outside the Operations Manager view" in res.answer

    res = loop.run("nexabank", "tell me a joke", "ops_manager")
    assert res.abstained and "nothing attempted" not in res.answer
