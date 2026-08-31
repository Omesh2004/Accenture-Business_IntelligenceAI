import re
import time as _time
from typing import Any, Dict
from enum import Enum
from pydantic import BaseModel, ConfigDict, Field, field_validator

# P0-4 bounds. 90 days back covers any legitimate backfill or simulate-console backdating;
# 5 minutes forward covers ordinary clock skew.
MAX_EVENT_AGE_S = 90 * 24 * 3600
MAX_EVENT_SKEW_S = 5 * 60

# Shape only. Canonicalisation — resolving an instrumented name to the one vocabulary, and
# REJECTING what it cannot resolve — happens once, later, in the Silver transform
# (pipeline/taxonomy/). Ingestion no longer coerces: the raw instrumented name lands in
# bronze.events.event_name verbatim, and Silver decides what it becomes.
EVENT_NAME_SHAPE = re.compile(r'^[a-z0-9_.]+$')


class ChannelEnum(str, Enum):
    web = "web"
    mobile = "mobile"
    api = "api"
    batch = "batch"


class FeatureEvent(BaseModel):
    # No default: an omitted event_id must 422, not silently become "". Silver deduplicates by
    # event_id and the gold rollups count uniqExact(event_id) — every guarantee depends on this
    # being a stable, non-empty id at every source. Every documented producer already sends one.
    event_id: str = Field(..., description="Stable logical event ID for replay-safe analytics")
    session_id: str = Field(default="", description="Stable browser/session ID for journey grouping")
    event_name: str = Field(..., description="Raw instrumented name; canonicalised in Silver, not here")
    tenant_id: str = Field(..., description="Analytics tenant")
    user_id: str = Field(..., description="ID of the user interacting (already hashed by the producer)")
    timestamp: float = Field(..., description="Unix timestamp (seconds) of the event")
    channel: ChannelEnum = Field(..., description="Source channel of the event")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Custom properties")

    @field_validator('event_id')
    @classmethod
    def validate_event_id(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError(
                "event_id must be a non-empty, stable ID -- required for replay-safe analytics "
                "(uniqExact(event_id) dedup depends on it)."
            )
        return v

    @field_validator('timestamp')
    @classmethod
    def validate_timestamp(cls, v: float) -> float:
        # timestamp is client-supplied (Date.now()/1000 from a browser, or the Express clock).
        # Unbounded, a skewed clock or a producer sending milliseconds puts events in the year
        # 55000, where -- with no upper bound on any query window -- they are counted forever.
        now = _time.time()
        if not (now - MAX_EVENT_AGE_S) <= v <= (now + MAX_EVENT_SKEW_S):
            raise ValueError(
                f"timestamp {v} is outside the accepted window "
                f"[now-{MAX_EVENT_AGE_S}s, now+{MAX_EVENT_SKEW_S}s]. "
                "Check the producer clock and whether it is sending milliseconds."
            )
        return v

    @field_validator('event_name')
    @classmethod
    def validate_event_name(cls, v: str) -> str:
        # Shape check only -- does NOT canonicalise. A non-empty [a-z0-9_.] string is accepted
        # verbatim; anything else is rejected here (422 -> bronze.events_dead_letter).
        s = (v or "").strip()
        if not s or not EVENT_NAME_SHAPE.match(s):
            raise ValueError(
                f"event_name '{v}' must be a non-empty string matching [a-z0-9_.]+ "
                "(shape only; the canonical vocabulary is applied in Silver)."
            )
        return s

    # extra="ignore": an unrecognised top-level field is dropped, not rejected -- FeatureEvent is
    # the contract between three producers (CLAUDE.md coupling point 1) and must not 422 on a
    # field a newer producer adds. The full request body is preserved verbatim as
    # bronze.events._raw regardless, so nothing is actually lost.
    model_config = ConfigDict(
        extra="ignore",
        json_schema_extra={
            "example": {
                "event_id": "evt_1a2b3c4d5e6f",
                "session_id": "sess_abc123",
                "event_name": "loan.kyc_started.success",
                "tenant_id": "nexabank",
                "user_id": "u_9f8e7d",
                "timestamp": 1718361234.56,
                "channel": "web",
                "metadata": {"device_type": "mobile", "_simulated": ["device_type"]},
            }
        },
    )
