from typing import Optional, Dict, Any, List
from enum import Enum
from pydantic import BaseModel, Field, field_validator
import re

class ChannelEnum(str, Enum):
    web = "web"
    mobile = "mobile"
    api = "api"
    batch = "batch"

# Taxonomy regex: strict [page].[feature].[status] (exactly 3 parts)
TAXONOMY_REGEX = re.compile(r'^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
# Legacy regex: simple flat name (e.g. login, view_feed)
LEGACY_REGEX = re.compile(r'^[a-z][a-z0-9_]*$')

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
        def normalize_status(status: str) -> str:
            s = re.sub(r'[^a-z0-9_]', '_', status or '').strip('_')
            if s in {'error', 'fail'}:
                return 'failed'
            if s == 'viewed':
                return 'view'
            if s == 'access':
                return 'success'
            return s or 'action'

        def normalize_part(part: str) -> str:
            p = re.sub(r'[^a-z0-9_]', '_', part or '').strip('_')
            return p or 'core'

        def split_feature_status(token: str) -> tuple[str, str]:
            t = normalize_part(token)
            suffix_map = {
                '_success': 'success',
                '_failed': 'failed',
                '_error': 'failed',
                '_view': 'view',
                '_access': 'success',
                '_action': 'action',
            }
            for suffix, status in suffix_map.items():
                if t.endswith(suffix) and len(t) > len(suffix):
                    return normalize_part(t[:-len(suffix)]), status
            return t, 'action'

        raw = v.strip().lower().replace('-', '_')

        if TAXONOMY_REGEX.match(raw):
            page, feature, status = raw.split('.')
            if page in {'free', 'pro', 'core', 'enterprise', 'lending'}:
                # Preserve prefixed 3-part taxonomy events as-is (with normalized status).
                # Historical analytics aliases rely on keys like `free.dashboard.view`.
                return f"{normalize_part(page)}.{normalize_part(feature)}.{normalize_status(status)}"
            if page == 'auth' and feature in {'login', 'register'}:
                return f"{feature}.auth.{normalize_status(status)}"
            return f"{normalize_part(page)}.{normalize_part(feature)}.{normalize_status(status)}"

        if LEGACY_REGEX.match(raw):
            return f"core.{raw}.action"

        parts = [p for p in raw.split('.') if p]
        while len(parts) >= 3 and parts[0] in {'free', 'pro', 'core', 'enterprise', 'lending'}:
            parts = parts[1:]

        if len(parts) == 3 and parts[0] == 'auth' and parts[1] in {'login', 'register'}:
            return f"{parts[1]}.auth.{normalize_status(parts[2])}"

        if len(parts) == 2:
            page = normalize_part(parts[0])
            feature, status = split_feature_status(parts[1])
            candidate = f"{page}.{feature}.{normalize_status(status)}"
            if TAXONOMY_REGEX.match(candidate):
                return candidate

        if len(parts) >= 3:
            page = normalize_part(parts[0])
            status = normalize_status(parts[-1])
            feature = normalize_part('_'.join(parts[1:-1])) or 'action'
            candidate = f"{page}.{feature}.{status}"
            if TAXONOMY_REGEX.match(candidate):
                return candidate

        fallback = f"core.{normalize_part(raw)}.action"
        if TAXONOMY_REGEX.match(fallback):
            return fallback

        raise ValueError(
            f"Invalid event_name '{v}'. Must normalize to strict 'page.feature.status' taxonomy."
        )

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
