"""Personas are declared in four places. Nothing but this file stops them drifting.

`config.PERSONAS`, `rbac.json`, `narrate.PERSONA_SECTIONS` and `agent.PERSONA_INTENTS` must all
agree. A persona present in one and missing from another does not raise -- it silently falls back,
which is how an entitlement boundary quietly moves. Same failure shape as the tenant vocabulary in
CLAUDE.md coupling point 3.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence import agent, config
from api.intelligence.stages import narrate

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rbac_personas() -> dict:
    for path in ("/rbac.json", os.path.join(ROOT, "rbac.json")):
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return (json.load(fh) or {}).get("personas") or {}
    pytest.skip("rbac.json not available")


# ── the four registries agree ──────────────────────────────────────────────
def test_rbac_allowed_matches_config():
    assert set(rbac_personas().get("allowed") or []) == set(config.PERSONAS)


def test_every_persona_has_narrative_sections():
    missing = set(config.PERSONAS) - set(narrate.PERSONA_SECTIONS)
    assert not missing, f"no PERSONA_SECTIONS for {missing}; they would fall back silently"


def test_every_persona_has_agent_intents():
    missing = set(config.PERSONAS) - set(agent.PERSONA_INTENTS)
    assert not missing, f"no PERSONA_INTENTS for {missing}; they would be denied everything"


def test_no_extra_personas_defined_anywhere():
    """A persona defined in code but not in rbac.json can never be resolved -- dead config."""
    known = set(config.PERSONAS)
    assert set(narrate.PERSONA_SECTIONS) <= known
    assert set(agent.PERSONA_INTENTS) <= known


def test_role_mapping_targets_only_known_personas():
    personas = rbac_personas()
    known = set(personas.get("allowed") or [])
    for role, persona in (personas.get("by_role") or {}).items():
        assert persona in known, f"role {role} maps to unknown persona {persona}"
    for email, persona in (personas.get("by_email") or {}).items():
        assert persona in known, f"{email} maps to unknown persona {persona}"
    assert personas.get("default") in known


# ── the ad-hoc path may not exceed the scheduled path ──────────────────────
# Which narrative section an intent draws on. Meta-intents (trust, freshness, cost, status) ask
# about the pipeline rather than the KPI's business content, so they need no section.
INTENT_REQUIRES_SECTION = {
    "cause": "cause", "where": "cause", "factor": "cause",
    "forecast": "forecast", "action": "action",
}


def test_no_intent_exceeds_its_personas_narrative_sections():
    """If a persona cannot read something in its narrative, it must not ask for it either."""
    for persona, intents in agent.PERSONA_INTENTS.items():
        sections = narrate.PERSONA_SECTIONS[persona]
        for intent in intents:
            needed = INTENT_REQUIRES_SECTION.get(intent)
            if needed:
                assert needed in sections, (
                    f"{persona} may ask '{intent}' but its narrative has no '{needed}' section")


def test_a_persona_denied_cells_is_not_told_the_segment_anyway():
    """The 'why' answer must not smuggle in the 'where' a persona cannot ask for."""
    insight = {
        "kpi_id": "k", "trust_verdict": "pass", "headline": "It fell",
        "evidence": [{"claim_id": "observed", "value": 15.0, "unit": "count",
                      "source": "anomalies", "label": "observed"},
                     {"claim_id": "baseline", "value": 24.0, "unit": "count",
                      "source": "anomalies", "label": "expected"}],
        "causes": [{"rank": 1, "dimensions": {"device_type": "mobile"}, "contribution": 1.0}],
    }
    denied = [p for p in agent.PERSONA_INTENTS if "where" not in agent.PERSONA_INTENTS[p]]
    assert denied, "expected at least one persona without cell access"
    for persona in denied:
        out = agent._answer_cause("nexabank", "why did it drop", persona, insight)
        assert "mobile" not in out.answer, f"{persona} was told the segment"


# ── failing closed ─────────────────────────────────────────────────────────
def test_unknown_persona_gets_the_narrowest_sections():
    """The old default was the WIDEST set: a new persona would have seen everything."""
    assert narrate.SAFE_SECTIONS <= set.intersection(*narrate.PERSONA_SECTIONS.values())


def test_unknown_persona_is_denied_by_the_agent():
    out = agent.answer_question("nexabank", "where is it concentrated", "some_new_persona")
    assert out.persona in config.PERSONAS, "must fall back to a known persona, not pass through"


def test_contract_visibility_names_only_known_personas():
    import glob
    import yaml
    known = set(config.PERSONAS)
    for path in glob.glob(os.path.join(ROOT, "contracts", "*.yaml")):
        with open(path, encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
        visible = ((raw.get("access_restriction") or {}).get("visible_to")) or []
        unknown = set(visible) - known
        assert not unknown, f"{os.path.basename(path)} grants access to unknown persona {unknown}"
