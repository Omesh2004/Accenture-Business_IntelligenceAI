"""Request bodies the dashboard POSTs. Not part of the event envelope."""
from typing import List

from pydantic import BaseModel


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
