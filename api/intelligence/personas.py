"""Persona registry -- one place that says what each persona is for.

A persona is a RENDER CONFIG over the same verified claim set, never a different number. Two
personas asking the same question about the same KPI get the same figures; what changes is which
sections they see, which levers they are shown, and how the finding is framed.

Three things are declared here and nowhere else:

  * `intents`  -- the questions this persona may ask. Mirrors `PERSONA_SECTIONS` in narrate.py so
                  an ad-hoc question cannot reach a section the scheduled narrative withholds.
  * `owner_roles` -- the recommendation owners this persona acts on. A CFO is shown the financial
                  consequence of a lending decision; the lending owner is shown the lever. Rows
                  outside the set are summarised, never hidden, so nobody is told a movement has
                  no action when it has one someone else owns.
  * `lead_in`  -- the opening clause per intent. Framing only; it states no figure.

KPI-level entitlement is NOT here: it lives in each contract's `access_restriction.visible_to`
and is applied by `narrate.apply_entitlement` before an insight row is ever written.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Persona:
    id: str
    label: str
    remit: str
    greeting: str
    intents: frozenset[str]
    owner_roles: frozenset[str]
    lead_in: dict[str, str] = field(default_factory=dict)
    # When no metric is named, prefer these ids in order before falling back to the ranking.
    kpi_preference: tuple[str, ...] = ()
    # Examples offered by the help intent and by the dashboard's suggestion chips.
    examples: tuple[str, ...] = ()
    # How far to pursue a question. A CFO wants the position and the outlook; an analyst wants the
    # method. Depth bounds capabilities per round and re-planning rounds, so the same question
    # costs what the reader's role justifies rather than always costing the maximum.
    max_tools_per_round: int = 4
    max_rounds: int = 3
    # How much of a finding to show. Depth is NOT entitlement: every persona gets root-cause
    # analysis, because a CFO asking why revenue fell and being handed a movement summary with no
    # drivers is a worse answer than one with fewer decimal places.
    #   summary  -- the dominant driver and its rounded share
    #   standard -- the ranked drivers with their shares
    #   full     -- ranked drivers plus the localisation method
    detail: str = "full"


REGISTRY: dict[str, Persona] = {
    "cfo": Persona(
        id="cfo",
        label="Chief Financial Officer",
        remit="Financial outcome, exposure and outlook across the portfolio.",
        greeting="Good to see you. I report on the financial position of the monitored metrics.",
        # `action` included deliberately. Withholding the capability meant a CFO asking "what
        # should we do" was told nothing at all; the useful answer is the commercial lever plus
        # the name of whoever owns the rest, and `owner_roles` below already draws that line.
        intents=frozenset({"cause", "action", "forecast", "trust", "cost", "freshness", "status",
                           "catalog", "definition", "ranking", "trend", "greeting", "help"}),
        owner_roles=frozenset({"revenue_ops", "retail_banking", "marketing_ops",
                               "product_marketing", "growth_analytics"}),
        lead_in={
            "cause": "Financial position:",
            "forecast": "Outlook:",
            "ranking": "Ranked by financial materiality:",
            "action": "Commercial consequence:",
        },
        kpi_preference=("revenue", "loan_approval_volume"),
        examples=("Which metric moved most this week?",
                  "What drove the change in revenue?",
                  "What does the forecast say for revenue?",
                  "How reliable is the revenue figure?",
                  "What did this analysis cost to produce?"),
        max_tools_per_round=2, max_rounds=2, detail="summary",
    ),
    "ops_manager": Persona(
        id="ops_manager",
        label="Operations Manager",
        remit="Day-to-day operational levers, segment concentration and remediation.",
        greeting="Good to see you. I report on where operations moved and what can be done.",
        intents=frozenset({"cause", "action", "trust", "freshness", "status",
                           "catalog", "definition", "ranking", "trend", "greeting", "help"}),
        owner_roles=frozenset({"lending_ops", "digital_channels", "growth_analytics",
                               "retail_banking", "analytics"}),
        lead_in={
            "cause": "Operational position:",
            "action": "Recommended action:",
            "ranking": "Ranked by operational severity:",
        },
        kpi_preference=("kyc_completion_rate", "signups",
                        "loan_approval_volume", "transaction_failure_rate"),
        examples=("Why did KYC completion rate fall?",
                  "Where is the drop concentrated?",
                  "What action is recommended, and who owns it?",
                  "Is the loan approval volume reliable enough to act on?",
                  "How current is the data behind this?"),
        max_tools_per_round=3, max_rounds=3, detail="standard",
    ),
    "analyst": Persona(
        id="analyst",
        label="Analyst",
        remit="Full method detail: decomposition, localisation, provenance and runtime.",
        greeting="Good to see you. I have the full investigation record, method detail included.",
        intents=frozenset({"cause", "factor", "forecast", "action", "trust", "cost",
                           "freshness", "status", "catalog", "definition", "ranking",
                           "trend", "greeting", "help"}),
        owner_roles=frozenset(),          # empty == every owner
        lead_in={
            "cause": "Attribution:",
            "factor": "Factor decomposition:",
            "ranking": "Ranked by materiality:",
        },
        kpi_preference=(),
        examples=("Why did KYC completion rate fall, and where is it concentrated?",
                  "Was the change price, volume or mix?",
                  "Show the forecast band for transaction failure rate.",
                  "How reliable is this figure, and which checks passed?",
                  "What did this analysis cost in tokens and latency?",
                  "Which KPIs do you track?"),
        max_tools_per_round=4, max_rounds=3, detail="full",
    ),
    "risk_officer": Persona(
        id="risk_officer",
        label="Risk & Compliance Officer",
        remit="Onboarding and credit exposure: KYC integrity, approval discipline, auditability.",
        greeting="Good to see you. I report on onboarding and credit exposure, and what is provable.",
        intents=frozenset({"cause", "action", "trust", "forecast", "freshness", "status",
                           "catalog", "definition", "ranking", "trend", "greeting", "help"}),
        owner_roles=frozenset({"lending_ops", "retail_banking", "growth_analytics"}),
        lead_in={
            "cause": "Risk position:",
            "action": "Required control action:",
            "ranking": "Ranked by exposure:",
            "trust": "Evidence standing:",
        },
        kpi_preference=("transaction_failure_rate", "kyc_completion_rate",
                        "loan_approval_volume"),
        examples=("Why did KYC completion rate fall?",
                  "Is the loan approval rate verified and safe to act on?",
                  "Where is the KYC drop concentrated by segment?",
                  "What control action is recommended for loan approvals?",
                  "How current is the data behind these figures?"),
        max_tools_per_round=3, max_rounds=3, detail="full",
    ),
}

DEFAULT = "analyst"


def get(persona_id: str) -> Persona:
    """Never raises. An unknown persona falls back to the default rather than widening."""
    return REGISTRY.get(persona_id) or REGISTRY[DEFAULT]


def allows(persona_id: str, intent: str) -> bool:
    return intent in get(persona_id).intents


def owns(persona_id: str, owner_role: str) -> bool:
    """True when this persona acts on that owner's levers. An empty set means every owner."""
    roles = get(persona_id).owner_roles
    return not roles or (owner_role or "") in roles


def detail(persona_id: str) -> str:
    """How much of a finding this persona sees. Never whether they see it at all."""
    return get(persona_id).detail


def lead(persona_id: str, intent: str) -> str:
    return get(persona_id).lead_in.get(intent, "")


def as_dict(persona_id: str) -> dict:
    p = get(persona_id)
    return {"id": p.id, "label": p.label, "remit": p.remit,
            "intents": sorted(p.intents), "examples": list(p.examples)}
