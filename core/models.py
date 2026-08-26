from typing import Optional, Dict, Any, List
from enum import Enum
from pydantic import BaseModel, Field, field_validator

# The taxonomy rules live in core/event_names.py so they can be exercised without importing
# pydantic -- scripts/verify_data_quality.py runs on the host, which has none installed, and a
# checker that cannot import the real function ends up reimplementing it. That is precisely
# how the three dialects drifted apart (CLAUDE.md coupling point 2).
# Re-exported here because existing code imports these names from this module.
from core.event_names import (  # noqa: F401
    LEGACY_REGEX,
    TAXONOMY_REGEX,
    normalize_ingest_event_name,
)

class ChannelEnum(str, Enum):
    web = "web"
    mobile = "mobile"
    api = "api"
    batch = "batch"

class FeatureEvent(BaseModel):
    event_id: str = Field(default="", description="Stable logical event ID for replay-safe analytics")
    session_id: str = Field(default="", description="Stable browser/session ID for journey grouping")
    event_name: str = Field(..., description="Name of the tracked feature/interaction")
    tenant_id: str = Field(..., description="ID of the tenant/organization")
    user_id: str = Field(..., description="ID of the user interacting")
    timestamp: float = Field(..., description="Unix timestamp of the event")
    channel: ChannelEnum = Field(..., description="Source channel of the event")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Custom properties")

    @field_validator('event_name')
    @classmethod
    def validate_event_name(cls, v: str) -> str:
        # Coerces rather than rejects -- see core/event_names.py. An unrecognised name is
        # wrapped as core.<name>.action, so the failure mode here is a silent rename.
        return normalize_ingest_event_name(v)

    class Config:
        json_schema_extra = {
            "example": {
                "event_name": "login.auth.success",
                "tenant_id": "tenant_xyz",
                "user_id": "user_123",
                "timestamp": 1718361234.56,
                "channel": "web",
                "metadata": {
                    "browser": "Chrome",
                    "plan": "premium"
                }
            }
        }

# ─────────────── License & Toggle Models ───────────────

class LicenseEntry(BaseModel):
    feature_name: str
    is_licensed: bool = True
    plan_tier: str = "pro"

class LicenseSyncRequest(BaseModel):
    tenant_id: str
    features: List[LicenseEntry]

class TrackingToggleRequest(BaseModel):
    tenant_id: str
    feature_name: str
    is_enabled: bool
    actor_email: str
