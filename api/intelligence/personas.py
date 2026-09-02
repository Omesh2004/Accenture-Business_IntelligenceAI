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
    # Capabilities this reader always wants on an investigation, on top of what the question
    # explicitly asked for. This is what makes one question produce four different answers: a CFO
    # asking "why did it move" wants the money broken down and the outlook, an analyst wants the
    # path and the method, an ops manager wants the segment and the lever. Same verified numbers,
    # different account of them.
    chain_bias: tuple[str, ...] = ()
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
        # Money broken into its lines, and where it is heading.
        chain_bias=("factor", "forecast", "action"),
        # Openers, not follow-ups. Every one names a metric and stands on its own, because on a
        # fresh conversation there is nothing for "this figure" or "this analysis" to refer to --
        # and examples[0] is also offered bare as "Try: ..." when a question cannot be answered.
        examples=("What drove the change in revenue?",
                  "What does the forecast say for revenue?",
                  "Which metric moved most this week?"),
        max_tools_per_round=2, max_rounds=2, detail="summary",
    ),
    "ops_manager": Persona(
        id="ops_manager",
        label="Operations Manager",
        remit="Day-to-day operational levers, segment concentration and remediation.",
        greeting="Good to see you. I report on where operations moved and what can be done.",
        intents=frozenset({"cause", "action", "trust", "freshness", "status",
                           "catalog", "definition", "ranking", "trend", "greeting", "help"}),
        # `onboarding_ops` owns every KYC lever in contracts/levers.yaml, and this persona IS the
        # onboarding manager. Leaving it out meant the one reader who can fix a KYC leak was told
        # "no lever here is yours to pull" and handed their own action to someone else.
        owner_roles=frozenset({"onboarding_ops", "lending_ops", "digital_channels",
                               "growth_analytics", "retail_banking", "analytics"}),
        lead_in={
            "cause": "Operational position:",
            "action": "Recommended action:",
            "ranking": "Ranked by operational severity:",
        },
        kpi_preference=("kyc_completion_rate", "signups",
                        "loan_approval_volume", "transaction_failure_rate"),
        # Where it leaked, and the lever that closes it.
        chain_bias=("cause", "action"),
        examples=("Why did KYC completion rate fall?",
                  "Where is the KYC drop concentrated by segment?",
                  "What action is recommended for KYC completion, and who owns it?"),
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
        # The path, the attribution and how it was arrived at.
        chain_bias=("trend", "cause", "factor", "trust"),
        examples=("Why did KYC completion rate fall, and where is it concentrated?",
                  "Show the forecast band for transaction failure rate.",
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
        # Risk owns the controls on onboarding integrity and on payments failures, which is what
        # its remit names. Without these it could describe an exposure and never act on one.
        owner_roles=frozenset({"onboarding_ops", "payments_ops", "lending_ops",
                               "retail_banking", "growth_analytics"}),
        lead_in={
            "cause": "Risk position:",
            "action": "Required control action:",
            "ranking": "Ranked by exposure:",
            "trust": "Evidence standing:",
        },
        kpi_preference=("transaction_failure_rate", "kyc_completion_rate",
                        "loan_approval_volume"),
        # Exposure, and whether the finding is provable.
        chain_bias=("cause", "trust", "action"),
        examples=("Why did KYC completion rate fall?",
                  "Is the loan approval volume verified and safe to act on?",
                  "What control action is recommended for loan approvals?"),
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
