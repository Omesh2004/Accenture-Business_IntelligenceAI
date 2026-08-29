"""Persona query agent: routing, entitlement, and the refusal to invent a number.

The failure this file exists to prevent is a confident answer that is not backed by a stored row.
Abstention is the correct behaviour far more often than an answer.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence import agent
from api.intelligence.stages.narrate import ClaimSet


# ── intent classification ──────────────────────────────────────────────────
@pytest.mark.parametrize("question,expected", [
    ("why did loan approval rate drop?", "cause"),
    ("what caused the fall in fee revenue", "cause"),
    ("where is the drop concentrated?", "where"),
    ("give me the breakdown by device", "where"),
    ("was it price or volume?", "factor"),
    ("what is the forecast for next week", "forecast"),
    ("what should I do about it", "action"),
    ("is the data fresh?", "freshness"),
    ("can i trust this number", "trust"),
    ("how many tokens did this cost", "cost"),
    ("what happened this week", "status"),
])
def test_questions_route_to_the_right_intent(question, expected):
    assert agent.classify(question)[0] == expected


def test_unrecognised_question_is_unknown():
    assert agent.classify("what is the capital of France")[0] == "unknown"
    assert agent.classify("")[0] == "unknown"


def test_classification_is_deterministic():
    """Same question, same intent -- a router that drifts cannot be audited."""
    q = "why did fee revenue drop and where is it concentrated"
    assert len({agent.classify(q) for _ in range(20)}) == 1


def test_why_outranks_a_bare_status_cue():
    """'why did X change' contains a status cue too; cause must win."""
    assert agent.classify("why did this change happen")[0] == "cause"


# ── KPI resolution ─────────────────────────────────────────────────────────
CANDIDATES = ["fee_revenue", "loan_approval_rate", "kyc_completion_rate", "pro_revenue"]


def test_kpi_is_resolved_from_the_question():
    assert agent.resolve_kpi("why did fee revenue drop", CANDIDATES) == "fee_revenue"
    assert agent.resolve_kpi("kyc completion looks off", CANDIDATES) == "kyc_completion_rate"


def test_unmatched_kpi_returns_empty_rather_than_guessing():
    assert agent.resolve_kpi("how is the weather", CANDIDATES) == ""


def test_kpi_resolution_is_order_independent():
    assert (agent.resolve_kpi("fee revenue", CANDIDATES)
            == agent.resolve_kpi("fee revenue", list(reversed(CANDIDATES))))


# ── entitlement ────────────────────────────────────────────────────────────
def test_persona_intents_never_exceed_the_analyst():
    """The analyst is the widest persona; no other may see something it cannot."""
    analyst = agent.PERSONA_INTENTS["analyst"]
    for persona, intents in agent.PERSONA_INTENTS.items():
        assert intents <= analyst, persona


def test_the_cfo_does_get_root_cause_analysis():
    """Corrected expectation. This test used to assert the opposite, and the opposite was a bug.

    `cause` sat in the CFO profile while the only driver capability was gated on a `where` intent
    the CFO did not have, so the CFO received movement summaries with no explanation of any of
    them. Depth belongs to the persona; the capability does not.
    """
    from api.intelligence import personas
    assert "cause" in agent.PERSONA_INTENTS["cfo"]
    assert personas.detail("cfo") == "summary"
    assert personas.detail("analyst") == "full"


def test_a_capability_no_persona_can_reach_is_a_wiring_bug():
    """Every intent a persona declares must be answerable by some tool, or it is dead config."""
    from api.intelligence import personas, tools as registry
    gated = {spec.intent for spec in registry.REGISTRY.values()}
    for pid, profile in personas.REGISTRY.items():
        unreachable = profile.intents - gated
        assert not unreachable, "%s declares %s, which no capability answers" % (pid, unreachable)


def test_ops_manager_cannot_ask_for_cost_telemetry():
    assert "cost" not in agent.PERSONA_INTENTS["ops_manager"]
    out = agent.answer_question("nexabank", "how many tokens did this cost", "ops_manager")
    assert out.abstained


def test_unknown_persona_falls_back_rather_than_widening():
    out = agent.answer_question("nexabank", "where is it concentrated", "root")
    assert out.persona in agent.config.PERSONAS


# ── abstention ─────────────────────────────────────────────────────────────
def test_unrecognised_question_abstains_with_a_reason():
    out = agent.answer_question("nexabank", "what is the capital of France", "analyst")
    assert out.abstained
    assert out.reason and out.intent == "unknown"


def test_abstention_carries_no_evidence():
    out = agent.answer_question("nexabank", "tell me a joke", "analyst")
    assert out.evidence == []


def test_answer_serialises_to_the_documented_shape():
    out = agent.answer_question("nexabank", "nonsense question here", "analyst").as_dict()
    for key in ("question", "persona", "intent", "answer", "evidence", "abstained",
                "verifier_pass", "engine_type"):
        assert key in out


# ── the numeric guarantee ──────────────────────────────────────────────────
def test_finish_rejects_a_draft_with_an_unsupported_number():
    """A figure that traces to no claim must turn the answer into an abstention."""
    cs = ClaimSet()
    cs.add("observed", 15.0, "count", "anomalies", "observed")
    out = agent._finish("q", "analyst", "cause", {"kpi_id": "k"}, cs,
                        "It fell to 15.00 from 99.00.")
    assert out.abstained and not out.verifier_pass


def test_finish_accepts_a_draft_whose_numbers_all_trace():
    cs = ClaimSet()
    cs.add("observed", 15.0, "count", "anomalies", "observed")
    out = agent._finish("q", "analyst", "cause", {"kpi_id": "k"}, cs, "It fell to 15.00.")
    assert not out.abstained and out.verifier_pass


def test_quarantined_metric_refuses_to_name_a_cause():
    """Trust Gate failing means the movement is a data defect, not a business event."""
    insight = {"kpi_id": "k", "trust_verdict": "fail", "evidence": [], "causes": []}
    out = agent._answer_cause("nexabank", "why did it drop", "analyst", insight)
    assert out.abstained and "quarantine" in out.reason


# ── a KPI that did not move is a finding, not a cause ────────────────────────

def _steady_insight():
    """An insight for a KPI Detect found nothing in: no anomaly_id, no causes, no recs."""
    return {
        "kpi_id": "loan_approval_volume",
        "trust_verdict": "pass",
        "anomaly_id": "",
        "headline": "Loan Approval Volume: no material movement",
        "causes": [],
        "factors": [],
        "recommendations": [],
        "evidence": [
            {"claim_id": "observed", "label": "observed", "value": 128.0, "unit": "count",
             "source": "anomalies", "field": "observed"},
            {"claim_id": "baseline", "label": "baseline", "value": 130.0, "unit": "count",
             "source": "anomalies", "field": "baseline"},
        ],
    }


def test_no_movement_does_not_read_as_a_broken_cause_sentence():
    out = agent._answer_cause("nexabank", "why did it change", "analyst", _steady_insight())
    assert "No single segment explains it" not in out.answer
    assert "no movement to explain" in out.answer
    assert out.verifier_pass


def test_no_movement_where_says_there_is_nothing_to_localize():
    out = agent._answer_where("nexabank", "where is it concentrated", "analyst", _steady_insight())
    assert out.abstained and "nothing to localize" in out.reason


def test_no_movement_action_does_not_imply_a_missing_lever(monkeypatch):
    # The Signal Store is live in this image; pin the read so the test states one thing.
    monkeypatch.setattr(agent.reader, "recommendations", lambda *a, **k: [])
    out = agent._answer_action("nexabank", "what should i do", "analyst", _steady_insight())
    assert out.abstained and "within its expected range" in out.reason


def test_a_real_movement_still_names_its_cause():
    """The no-movement branch must not swallow the case it was added beside."""
    insight = dict(_steady_insight())
    insight["anomaly_id"] = "anom-1"
    insight["headline"] = "Loan Approval Volume fell materially"
    insight["causes"] = [{"rank": 1, "fundamental": "approved", "method": "psqueeze",
                          "contribution": 0.62, "dimensions": {"region": "Northeast"}}]
    insight["evidence"].append(
        {"claim_id": "cause_1_contribution", "label": "cause_1_contribution", "value": 62.0, "unit": "percent",
         "source": "root_causes", "field": "contribution"})
    out = agent._answer_cause("nexabank", "why did it drop", "analyst", insight)
    assert "region=Northeast" in out.answer and "62.0%" in out.answer


def test_an_intent_cue_is_not_read_as_a_metric_name():
    """`volume` selects the factor intent; it must not also select loan_approval_volume."""
    stripped = agent._without_cues("Was it price or volume?", "factor")
    assert agent.resolve_kpi(stripped, ["loan_approval_volume", "digital_adoption_rate"]) == ""


def test_headline_and_detail_do_not_run_together():
    insight = dict(_steady_insight())
    insight["anomaly_id"] = "anom-2"
    insight["headline"] = "Digital Adoption Rate rose (urgent)"
    out = agent._answer_cause("nexabank", "why did it rise", "analyst", insight)
    assert "(urgent) It moved" not in out.answer
    assert "(urgent). It moved" in out.answer
