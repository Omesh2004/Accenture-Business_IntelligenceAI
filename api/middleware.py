from fastapi import HTTPException
from traceback import format_exc
import logging

from warehouse.config import settings

logger = logging.getLogger(__name__)

def require_cloud_mode():
    """
    Dependency to ensure an endpoint is only accessible in CLOUD mode.
    Raises 403 Forbidden if accessed in ON_PREM mode.
    """
    if settings.is_on_prem:
        logger.warning(f"Blocked cross-tenant access attempt in ON_PREM mode.")
        raise HTTPException(
            status_code=403, 
            detail="Forbidden: This endpoint is only available in CLOUD deployment mode."
        )

def require_tenant_access(requested_tenant_id: str):
    """
    Ensures the requested tenant(s) match the local instance when running in ON_PREM mode.
    Supports both single tenant IDs and comma-separated lists.
    """
    if settings.is_on_prem:
        # Parse comma-separated tenant list
        tenant_list = [t.strip() for t in requested_tenant_id.split(",") if t.strip()]
        for tid in tenant_list:
            if tid != settings.TENANT_ID:
                logger.warning(f"Blocked access to tenant '{tid}'. Active local tenant is '{settings.TENANT_ID}'.")
                raise HTTPException(
                    status_code=403, 
                    detail=f"Forbidden: Cross-tenant data access is blocked in ON_PREM mode. Tenant '{tid}' is not the local tenant."
                )
