"""Persona resolution and the RBAC gate in front of /intelligence.

CLAUDE.md coupling points 3 and 4: the header trio and the tenant vocabulary are a matched pair,
and a persona query parameter must never widen access. Both are silent when broken.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.main import RBACMiddleware, resolve_persona


class FakeRequest:
    def __init__(self, **headers):
        self.headers = {k.replace("_", "-"): v for k, v in headers.items()}


# ── persona resolution ─────────────────────────────────────────────────────
def test_role_maps_to_its_persona():
    assert resolve_persona(FakeRequest(X_User_Role="super_admin")) == "cfo"
    assert resolve_persona(FakeRequest(X_User_Role="app_admin")) == "ops_manager"
    assert resolve_persona(FakeRequest(X_User_Role="user")) == "analyst"


def test_unknown_role_falls_back_to_the_default_persona():
    assert resolve_persona(FakeRequest(X_User_Role="nonsense")) == "analyst"


def test_missing_role_header_still_resolves():
    assert resolve_persona(FakeRequest()) == "analyst"


def test_requested_persona_cannot_widen_access():
    """An analyst asking for the cfo narrative stays an analyst."""
    assert resolve_persona(FakeRequest(X_User_Role="user"), "cfo") == "analyst"


def test_requested_persona_that_matches_is_honoured():
    assert resolve_persona(FakeRequest(X_User_Role="super_admin"), "cfo") == "cfo"


def test_requested_persona_outside_the_allowed_list_is_ignored():
    assert resolve_persona(FakeRequest(X_User_Role="super_admin"), "root") == "cfo"


# ── the gate in front of /intelligence ─────────────────────────────────────
def test_intelligence_is_reachable_by_super_admin():
    """rbac.json maps super_admin -> cfo; without this the mapping is dead config."""
    assert any("/intelligence/insight".startswith(p)
               for p in RBACMiddleware.COMPANY_ADMIN_ALLOWED)


@pytest.mark.parametrize("path", ["/metrics/traffic", "/metrics/devices", "/features/activity"])
def test_detailed_endpoints_stay_blocked_for_super_admin(path):
    assert any(path.startswith(b) for b in RBACMiddleware.COMPANY_ADMIN_BLOCKED)


def test_intelligence_is_not_on_the_blocked_list():
    assert not any("/intelligence".startswith(b) for b in RBACMiddleware.COMPANY_ADMIN_BLOCKED)


# ── persona switching is a server-side allowlist, never a caller assertion ───

class _Req:
    def __init__(self, role="user", email=""):
        self.headers = {"X-User-Role": role, "X-User-Email": email}


def test_a_requested_persona_outside_the_role_allowlist_is_ignored():
    from api.main import resolve_persona
    # `user` may select only analyst; asking for cfo must not widen the view.
    assert resolve_persona(_Req("user"), "cfo") == "analyst"


def test_a_requested_persona_inside_the_allowlist_is_honoured():
    from api.main import resolve_persona
    # Without this, the persona parameter was inert and every role was locked to one shape.
    assert resolve_persona(_Req("super_admin"), "ops_manager") == "ops_manager"
    assert resolve_persona(_Req("app_admin"), "analyst") == "analyst"


def test_no_persona_requested_still_resolves_from_the_role():
    from api.main import resolve_persona
    assert resolve_persona(_Req("super_admin")) == "cfo"
    assert resolve_persona(_Req("app_admin")) == "ops_manager"


def test_an_unknown_role_cannot_select_anything():
    from api.main import resolve_persona, selectable_personas
    assert resolve_persona(_Req("root"), "cfo") == "analyst"
    assert selectable_personas(_Req("root")) == ["analyst"]
