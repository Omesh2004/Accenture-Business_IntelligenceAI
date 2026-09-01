"""Request bodies the dashboard POSTs. Not part of the event envelope."""
from __future__ import annotations

from pydantic import BaseModel


class OutcomeRequest(BaseModel):
    """One-click feedback on an insight (CLAUDE.md §9 feedback loop)."""
    tenant_id: str = "nexabank"
    investigation_id: str = ""
    insight_id: str
    signal: str            # root_cause_correct | useful | action_taken | known_event
    value: str             # yes | no | partial | rating
    actor: str = ""


class AskRequest(BaseModel):
    question: str
    persona: str | None = None
    tenant_id: str | None = None
    #: The page's range selector. A question naming its own period overrides it for that turn.
    days: int | None = None
