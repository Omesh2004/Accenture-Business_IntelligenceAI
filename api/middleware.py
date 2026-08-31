"""Persona resolution + the Ops-hides-revenue entitlement filter.

Round 2 has one tenant and no admin roles. RBACMiddleware, cloud-mode and
tenant-scope guards are gone. What remains: resolve which persona LENS a request gets (from
`rbac.json`, server-side — a `?persona=` request can never widen it), and strip revenue from an
`ops_manager` response so it cannot be seen or back-computed (CLAUDE.md §7, §10 scenario 4).
"""
from __future__ import annotations

import json
import os
from functools import lru_cache

_RBAC_PATH = os.environ.get(
    "RBAC_CONFIG",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rbac.json"))


@lru_cache(maxsize=1)
def _cfg() -> dict:
    try:
        with open(_RBAC_PATH, encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("personas") or {}
    except Exception:
        return {}


def _headers(request) -> tuple[str, str, str]:
    h = getattr(request, "headers", {}) or {}
    return (str(h.get("X-User-Persona") or "").strip().lower(),
            str(h.get("X-User-Role") or "").strip().lower(),
            str(h.get("X-User-Email") or "").strip().lower())


def resolve_persona(request, requested: str | None = None) -> str:
    """The persona this caller gets. `requested` (a `?persona=` param) or `X-User-Persona` is
    honoured only if it is in `selectable`; otherwise the role/email default applies."""
    cfg = _cfg()
    allowed = set(cfg.get("allowed") or ["analyst"])
    selectable = set(cfg.get("selectable") or allowed)
    default = cfg.get("default", "analyst")

    hdr_persona, role, email = _headers(request)
    base = (cfg.get("by_email") or {}).get(email) or (cfg.get("by_role") or {}).get(role) or default
    base = base if base in allowed else "analyst"

    want = (requested or hdr_persona or "").strip().lower()
    if want and want in selectable and want in allowed:
        return want
    return base


def selectable_personas(request) -> list[str]:
    cfg = _cfg()
    allowed = set(cfg.get("allowed") or ["analyst"])
    out = [p for p in (cfg.get("selectable") or sorted(allowed)) if p in allowed]
    return out or [resolve_persona(request)]


def hidden_kpis(persona: str) -> set[str]:
    """KPI ids this persona must not see. Only `ops_manager` hides `revenue` today."""
    if persona == "ops_manager":
        return set(_cfg().get("ops_hides") or ["revenue"])
    return set()


def filter_revenue(persona: str, payload):
    """Recursively strip anything that names a hidden KPI from a response body, so the number is
    neither shown nor back-computable. Applied at the dashboard-API boundary, before the client."""
    hidden = hidden_kpis(persona)
    if not hidden:
        return payload

    def _hidden_item(x) -> bool:
        if isinstance(x, str):
            return x in hidden
        if isinstance(x, dict):
            return str(x.get("kpi_id") or x.get("kpi") or "") in hidden
        return False

    def _scrub(obj):
        if isinstance(obj, dict):
            return {k: _scrub(v) for k, v in obj.items()
                    if k not in hidden and not (k in ("kpi_id", "kpi") and str(v) in hidden)}
        if isinstance(obj, list):
            return [_scrub(x) for x in obj if not _hidden_item(x)]
        return obj

    return _scrub(payload)
