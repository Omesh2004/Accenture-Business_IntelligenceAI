import time
from typing import Optional, Dict, Any, List
from enum import Enum
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
    # No default: an omitted event_id must 422, not silently become "". Every read-time dedup
    # guarantee (uniqExact(event_id) in /metrics/kpi and mv_daily_feature_usage -- see
    # docs/DATABASE.md FOUNDATION-1/4) depends on this being a stable, non-empty ID at every
    # source. Phase 1 audit (docs/audits/clickhouse_pipeline_audit_phase1_findings.md, item 1)
    # found ingestion/main.py wrote an empty event_id straight through with no rejection; every
    # documented producer already sends one, so rejecting here is a no-op for real traffic and
    # closes the gap for anything else that calls POST /events.
    event_id: str = Field(..., description="Stable logical event ID for replay-safe analytics")
    session_id: str = Field(default="", description="Stable browser/session ID for journey grouping")
    event_name: str = Field(..., description="Name of the tracked feature/interaction")
    tenant_id: str = Field(..., description="ID of the tenant/organization")
    user_id: str = Field(..., description="ID of the user interacting")
    timestamp: float = Field(..., description="Unix timestamp of the event")
    channel: ChannelEnum = Field(..., description="Source channel of the event")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Custom properties")
    # Envelope shape version, not a data-quality field. Defaults to 1 (today's shape) so no
    # existing producer needs to change to keep working. Phase 3 proposal 4a
    # (docs/audits/clickhouse_pipeline_audit_phase3_proposals.md): cheap to add now, since a
    # version can never be backfilled onto rows that never carried one, and this mostly
    # future-proofs a scenario this repo doesn't have yet -- a rolling deploy where an older
    # ingestion service receives events shaped by a newer producer.
    schema_version: int = Field(default=1, description="Envelope shape version")

    @model_validator(mode="before")
    @classmethod
    def _capture_unrecognized_fields(cls, data: Any) -> Any:
        # extra="ignore" (below) never rejects an unrecognised top-level field, but it silently
        # drops it -- Phase 1 item 3 flagged this as invisible schema drift: a producer can start
        # sending a new field and nothing records that it happened. Surface what would otherwise
        # vanish into `metadata._unrecognized_fields` instead, purely additively: no payload is
        # rejected any differently than before this validator existed.
        if not isinstance(data, dict):
            return data

        known = {
            "event_id", "session_id", "event_name", "tenant_id", "user_id",
            "timestamp", "channel", "metadata", "schema_version",
        }
        extras = {k: v for k, v in data.items() if k not in known}
        if not extras:
            return data

        metadata = data.get("metadata", {})
        if metadata is None:
            metadata = {}
        if not isinstance(metadata, dict):
            # Malformed metadata is a separate problem. Leave it untouched so the normal
            # `metadata` field validation rejects it with its own error instead of this hook
            # masking that by replacing it with a dict that happens to validate.
            return data

        return {**data, "metadata": {**metadata, "_unrecognized_fields": extras}}

    @field_validator('event_id')
    @classmethod
    def validate_event_id(cls, v: str) -> str:
        # Rejects rather than coerces -- unlike event_name there is no safe fallback value to
        # wrap a blank ID into; fabricating one here would defeat replay-safe dedup instead of
        # fixing it. The value itself is never altered, only rejected when blank.
        if not v or not v.strip():
            raise ValueError(
                "event_id must be a non-empty, stable ID -- required for replay-safe analytics "
                "(uniqExact(event_id) dedup depends on it)."
            )
        return v

    @field_validator('event_name')
    @classmethod
    def validate_event_name(cls, v: str) -> str:
        # Coerces rather than rejects -- see core/event_names.py. An unrecognised name is
        # wrapped as core.<name>.action, so the failure mode here is a silent rename.
        return normalize_ingest_event_name(v)

    @field_validator('timestamp')
    @classmethod
    def validate_timestamp(cls, v: float) -> float:
        # D4 (docs/FinInsights_Bug_Audit.md): timestamp is client-supplied with no bound --
        # a skewed clock, or a producer sending milliseconds instead of seconds, lands events
        # in the year 55000, where they are counted in every "last N days" window forever and
        # permanently pollute /metrics/realtime_users. Rejects rather than coerces: there is no
        # safe guess at the "correct" timestamp, and this must 422 -> dead-letter (ingest_validation)
        # exactly like an invalid event_name or blank event_id, not silently clamp to `now()`.
        now = time.time()
        if v < now - 90 * 86400 or v > now + 5 * 60:
            raise ValueError(
                f"timestamp {v} is outside the accepted window "
                f"[now-90d, now+5m] = [{now - 90 * 86400}, {now + 5 * 60}]. "
                "Check for a clock skew or a milliseconds-vs-seconds unit mismatch."
            )
        return v

    # extra="ignore" is pydantic v2's default already (confirmed in Phase 1 audit) -- stated
    # explicitly here so the behavior this model relies on (never reject on an unrecognised
    # field) is documented, not just inherited silently. `_capture_unrecognized_fields` above is
    # what keeps that silence from being total.
    model_config = ConfigDict(
        extra="ignore",
        json_schema_extra={
            "example": {
                "event_id": "evt_1a2b3c4d5e6f",
                "event_name": "login.auth.success",
                "tenant_id": "tenant_xyz",
                "user_id": "user_123",
                "timestamp": 1718361234.56,
                "channel": "web",
                "schema_version": 1,
                "metadata": {
                    "browser": "Chrome",
                    "plan": "premium"
                }
            }
        },
    )

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
