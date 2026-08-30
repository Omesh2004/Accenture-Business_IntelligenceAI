"""The pipeline rail a question travels, and which capability answers for each gate.

The agent already chooses capabilities dynamically (`planner.py`). What was missing is that a
reader could not see WHICH STAGE OF THE PIPELINE each choice belonged to, or why a stage was not
engaged. A tool name is an implementation detail; "Decompose did not run, because this contract
declares no price/volume split" is an answer.

Two rules keep this honest:

  * A gate is `engaged` only when a capability mapped to it actually returned. Nothing here
    infers a gate from the question.
  * A gate that did not run carries the reason it did not, and the reasons are read from the
    contract and the observations -- never from a lookup keyed on the question.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Gate:
    id: str
    label: str
    question: str          # what this gate decides, in one line
    engine: str            # which engine class answers it, for the LLM-vs-not breakdown

    def as_dict(self) -> dict:
        return {"id": self.id, "label": self.label, "question": self.question,
                "engine": self.engine}


# Pipeline order as it actually executes. Forecast precedes Detect because Detect scores against
# the band Forecast produced -- the rail would lie if it read the other way.
RAIL: tuple[Gate, ...] = (
    Gate("scope", "Scope", "Which metric is this about, and may this persona see it?", "rule"),
    Gate("trust", "Trust Gate", "Is the data fit to answer from at all?", "rule"),
    Gate("forecast", "Forecast", "What was this metric expected to be?", "stats"),
    Gate("detect", "Detect", "Is the deviation a real anomaly, or noise?", "stats"),
    Gate("localize", "Localize", "Which segment is the movement concentrated in?", "stats"),
    Gate("decompose", "Decompose", "How much was price, volume or mix?", "stats"),
    Gate("causal", "Causal", "How strong is the evidence that this caused the move?", "rule"),
    Gate("decide", "Decide", "Which owned lever addresses it?", "rule"),
    Gate("verify", "Verify", "Does every figure trace to a stored row?", "rule"),
)

BY_ID: dict[str, Gate] = {g.id: g for g in RAIL}

# Which gate a capability answers for. A tool absent from this map is infrastructure (a greeting,
# a cost report) and belongs to no gate -- it must not light one up.
INTENT_GATE: dict[str, str] = {
    "catalog": "scope",
    "definition": "scope",
    "status": "detect",
    "ranking": "detect",
    "forecast": "forecast",
    "cause": "localize",
    "factor": "decompose",
    "action": "decide",
    "trust": "trust",
    "freshness": "trust",
}


def for_intent(intent: str) -> str:
    """The gate a capability answers for, or '' when it belongs to none."""
    return INTENT_GATE.get(intent, "")


# Why a gate did not engage. Keyed on gate id; each is a statement about THIS run, and is only
# used when the run genuinely did not reach that gate.
_NOT_ASKED = "the question did not call for it"


@dataclass
class GateState:
    id: str
    label: str
    question: str
    engine: str
    status: str = "idle"            # idle | engaged | skipped | failed | restricted
    detail: str = ""
    tools: list[str] = field(default_factory=list)
    claims: int = 0

    def as_dict(self) -> dict:
        return {"id": self.id, "label": self.label, "question": self.question,
                "engine": self.engine, "status": self.status, "detail": self.detail,
                "tools": self.tools, "claims": self.claims}


def rail_state(engaged: dict[str, dict], reached: bool,
               restricted: dict[str, str] | None = None) -> list[dict]:
    """The full rail with each gate's outcome for this run.

    `engaged` maps gate id -> {"tools": [...], "claims": n, "ok": bool, "detail": str}. `restricted`
    maps gate id -> the reason this persona may not reach it. Every other gate is reported as
    skipped with a reason, so the rail never shows a silent gap.
    """
    restricted = restricted or {}
    out: list[GateState] = []
    for gate in RAIL:
        state = GateState(gate.id, gate.label, gate.question, gate.engine)
        hit = engaged.get(gate.id)
        if gate.id in restricted and not hit:
            state.status = "restricted"
            state.detail = restricted[gate.id]
        elif hit:
            state.status = "engaged" if hit.get("ok") else "failed"
            state.tools = list(hit.get("tools") or [])
            state.claims = int(hit.get("claims") or 0)
            state.detail = str(hit.get("detail") or "")
        elif gate.id == "verify":
            # Verify only runs when there is a draft to check; saying "not asked" would be wrong.
            state.status = "skipped"
            state.detail = ("no draft reached the verifier" if not reached
                            else "no figure was stated, so there was nothing to trace")
        else:
            state.status = "skipped"
            state.detail = _NOT_ASKED
        out.append(state)
    return [s.as_dict() for s in out]


def catalogue() -> list[dict]:
    """The rail itself, for a UI that wants to render it before a question is asked.

    Returns the SAME shape as `rail_state`, every gate idle. Returning the bare `Gate` here shipped
    rows with no `status`/`tools`, and the streaming client -- which merges each step onto the gate
    it belongs to -- crashed on the first step with "g.tools is not iterable". One shape, always.
    """
    return [GateState(g.id, g.label, g.question, g.engine, status="idle").as_dict() for g in RAIL]
