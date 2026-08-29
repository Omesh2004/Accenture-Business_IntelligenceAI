"""The query agent as an orchestrator: visible tool trace, wider coverage, persona shaping.

These lock the three properties the surface is judged on:
  * every answer shows which tool produced it, so a claim can be traced without reading code;
  * a question outside the analytical intents (a greeting, "what do you track", "what is X")
    is answered rather than refused;
  * two personas asking the same question get materially different briefings.
"""
import pytest

from api.intelligence import agent, personas


# ── trace ──────────────────────────────────────────────────────────────────
def test_every_answer_carries_a_tool_trace():
    out = agent.answer_question("nexabank", "hello", "analyst")
    assert out.trace, "an answer with no trace cannot be audited"
    for step in out.trace:
        assert step["tool"] and step["label"]
        assert step["status"] in {"ok", "skipped", "abstained", "failed"}
        assert step["ms"] >= 0


def test_trace_steps_are_numbered_in_order():
    out = agent.answer_question("nexabank", "which kpis do you track", "analyst")
    assert [s["n"] for s in out.trace] == list(range(1, len(out.trace) + 1))


def test_an_abstention_still_shows_what_was_tried():
    out = agent.answer_question("nexabank", "tell me a joke", "analyst")
    assert out.abstained
    assert any(s["tool"] == "agent.classify_all" for s in out.trace)


def test_the_trace_names_real_tools():
    """A trace that invents step names is decoration. Each tool must exist on its module."""
    import api.intelligence.reader as reader
    out = agent.answer_question("nexabank", "how current is the data", "analyst")
    for step in out.trace:
        module, _, func = step["tool"].partition(".")
        target = {"agent": agent, "reader": reader, "personas": personas}.get(module)
        if target is not None:
            assert hasattr(target, func), step["tool"]


# ── conversational coverage ────────────────────────────────────────────────
@pytest.mark.parametrize("question,intent", [
    ("hello", "greeting"),
    ("hi there", "greeting"),
    ("good morning", "greeting"),
    ("what can you help me with", "help"),
    ("which kpis do you track", "catalog"),
    ("which metric moved most", "ranking"),
    ("what should i look at first", "ranking"),
    ("what is kyc completion rate", "definition"),
    ("how is loan approval volume calculated", "definition"),
])
def test_wider_question_coverage_routes(question, intent):
    assert agent.classify(question)[0] == intent


def test_a_greeting_is_answered_not_refused():
    out = agent.answer_question("nexabank", "hello", "cfo")
    assert not out.abstained
    assert "Chief Financial Officer" in out.persona_label
    assert out.answer


def test_help_lists_only_this_personas_intents():
    out = agent.answer_question("nexabank", "what can i ask you", "ops_manager")
    assert not out.abstained
    assert "cost" not in out.answer, "ops_manager has no cost intent and must not advertise it"
    assert "action" in out.answer


def test_a_dead_end_still_offers_something_answerable():
    out = agent.answer_question("nexabank", "what is the capital of France", "analyst")
    assert out.abstained and out.suggestions
    assert "capital" not in out.answer.lower() or "could not map" in out.answer


def test_a_bare_what_is_needs_a_metric_to_read_as_a_definition():
    assert agent.classify("what is the capital of France")[0] == "unknown"
    assert agent.classify("what is net deposit growth")[0] == "definition"


# ── multi-intent ───────────────────────────────────────────────────────────
def test_two_asks_in_one_question_are_both_answered():
    ranked = [i for i, _ in agent.classify_all("why did it drop and what should we do")]
    assert "cause" in ranked and "action" in ranked


def test_a_greeting_is_never_paired_with_an_analytical_section():
    out = agent.answer_question("nexabank", "hi, why did it drop?", "analyst")
    # Whichever wins, the reply is one coherent thing rather than a greeting plus a variance report.
    assert len(out.intents) == 1 or "greeting" not in out.intents


# ── persona shaping ────────────────────────────────────────────────────────
def test_persona_registry_never_exceeds_the_analyst():
    analyst = personas.get("analyst").intents
    for pid, profile in personas.REGISTRY.items():
        assert profile.intents <= analyst, pid


def test_every_rbac_persona_exists_in_the_registry():
    """rbac.json and the registry are edited by different hands; drift silently widens or blanks."""
    import json
    with open("rbac.json", encoding="utf-8") as fh:
        cfg = json.load(fh)
    for pid in (cfg.get("personas") or {}).get("allowed") or []:
        assert pid in personas.REGISTRY, pid
    for role, choices in ((cfg.get("personas") or {}).get("selectable_by_role") or {}).items():
        for pid in choices:
            assert pid in personas.REGISTRY, "%s -> %s" % (role, pid)


def test_a_lever_outside_the_persona_is_referred_not_hidden(monkeypatch):
    """Telling an owner "no action" when another team owns one is worse than naming the owner."""
    insight = {"kpi_id": "fee_revenue", "anomaly_id": "a1", "trust_verdict": "pass",
               "evidence": [], "causes": []}
    monkeypatch.setattr(agent.reader, "recommendations", lambda *a, **k: [
        {"rec_id": "r1", "action": "adjust fee schedule", "lever": "adjust_fee_schedule",
         "owner_role": "revenue_ops", "expected_impact": {"high": 100.0}, "status": "proposed"},
    ])
    out = agent._answer_action("nexabank", "what should we do", "ops_manager", insight)
    assert not out.abstained
    assert "revenue_ops" in out.answer
    assert "adjust_fee_schedule" not in out.answer, "a lever this persona does not own is named " \
                                                    "by its owner, not handed over"


def test_a_lever_the_persona_owns_is_stated_in_full(monkeypatch):
    insight = {"kpi_id": "loan_approval_volume", "anomaly_id": "a1", "trust_verdict": "pass",
               "evidence": [], "causes": []}
    monkeypatch.setattr(agent.reader, "recommendations", lambda *a, **k: [
        {"rec_id": "r1", "action": "review approval rules", "lever": "review_approval_rules",
         "owner_role": "lending_ops", "expected_impact": {"high": 42.0}, "status": "proposed"},
    ])
    out = agent._answer_action("nexabank", "what should we do", "ops_manager", insight)
    assert not out.abstained and "review_approval_rules" in out.answer and "42" in out.answer


def test_the_analyst_owns_every_lever():
    assert personas.owns("analyst", "revenue_ops")
    assert personas.owns("analyst", "anything_at_all")


def test_a_persona_lead_in_states_no_figure():
    for pid in personas.REGISTRY:
        for lead in personas.get(pid).lead_in.values():
            assert not any(ch.isdigit() for ch in lead), lead
