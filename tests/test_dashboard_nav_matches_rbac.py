"""Every link the sidebar renders must be a route that role is allowed to open.

`Sidebar.tsx` builds nav items per role and `lib/rbac.ts` decides what each role may open. They are
two independent lists, and nothing connects them -- adding a page to the sidebar without adding it
to the guard produces a visible link that lands on "Dashboard Access Denied". That is what
happened when the Intelligence page shipped.

A static cross-check, because the dashboard has no JS test runner and introducing one would be a
new dependency for a check this file already makes.
"""
from __future__ import annotations

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIDEBAR = os.path.join(ROOT, "analytics-dashboard", "src", "components", "Sidebar.tsx")
RBAC = os.path.join(ROOT, "analytics-dashboard", "src", "lib", "rbac.ts")

# href: buildAppScopedPath(activeAppId, '/x')  or  href: '/x'
HREF = re.compile(r"href:\s*(?:buildAppScopedPath\([^,]+,\s*)?'([^']+)'")
# The role blocks in canAccessRoute, in source order.
ROLE_BLOCK = re.compile(r"if \(role === '(\w+)'\) \{(.*?)\n  \}", re.S)
# Capture HOW the path is matched. `=== '/'` admits only the landing page; treating it as a
# prefix makes every route look reachable, which is how the first version of this guard
# passed while super_admin was in fact blocked from /intelligence.
ALLOWED = re.compile(
    r"normalizedPathname(\.startsWith\(|\s*===\s*)'([^']+)'\)?\)\s*return true")


def read(path: str) -> str:
    if not os.path.exists(path):
        pytest.skip(f"{os.path.basename(path)} not present")
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def nav_by_role() -> dict[str, list[str]]:
    """role -> the paths its sidebar renders."""
    src = read(SIDEBAR)
    out: dict[str, list[str]] = {}
    for role in ("app_admin", "super_admin"):
        start = src.find(f"role === '{role}'")
        if start == -1:
            continue
        end = src.find("];", start)
        out[role] = HREF.findall(src[start:end])
    return out


def allowed_by_role() -> dict[str, list[tuple[str, str]]]:
    """role -> [(kind, path)], kind being 'prefix' or 'exact'."""
    src = read(RBAC)
    out: dict[str, list[tuple[str, str]]] = {}
    for role, body in ROLE_BLOCK.findall(src):
        out[role] = [("prefix" if "startsWith" in op else "exact", path)
                     for op, path in ALLOWED.findall(body)]
    return out


def is_allowed(path: str, rules: list[tuple[str, str]]) -> bool:
    return any(path == p if kind == "exact" else path.startswith(p) for kind, p in rules)


def test_the_scan_finds_both_lists():
    """A regex that matched nothing would make every assertion below vacuous."""
    nav, allowed = nav_by_role(), allowed_by_role()
    assert nav.get("app_admin"), "no sidebar links parsed for app_admin"
    assert allowed.get("app_admin"), "no allowed routes parsed for app_admin"


@pytest.mark.parametrize("role", ["app_admin", "super_admin"])
def test_every_sidebar_link_is_reachable(role):
    nav = nav_by_role().get(role) or []
    allowed = allowed_by_role().get(role) or []
    if not nav:
        pytest.skip(f"{role} renders no sidebar links")
    blocked = [p for p in nav if not is_allowed(p, allowed)]
    assert not blocked, (
        f"{role} sees links it cannot open (they redirect to /unauthorized): {blocked}")


def test_intelligence_is_reachable_by_both_admin_roles():
    """The page this file was written for. rbac.json maps super_admin to the cfo persona, so the
    UI must not block the one page that persona exists to read."""
    allowed = allowed_by_role()
    for role in ("app_admin", "super_admin"):
        assert is_allowed("/intelligence", allowed.get(role) or []), f"{role} cannot open it"


def test_normal_users_reach_nothing():
    src = read(RBAC)
    assert "if (role === 'user') return false;" in src, (
        "the explicit deny for normal users is gone; the dashboard would fall through to a default")
