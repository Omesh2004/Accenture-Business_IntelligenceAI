"""The Decide tool's lever library, from contracts/levers.yaml.

A recommendation is assembled from a declared lever, never invented: Decide may only name a
lever that BOTH this library knows and the KPI's own contract allows.
"""
from __future__ import annotations

import os
from functools import lru_cache

import yaml

LEVERS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "contracts", "levers.yaml")


@lru_cache(maxsize=1)
def load_levers() -> dict[str, dict]:
    try:
        with open(LEVERS_PATH, encoding="utf-8") as fh:
            return (yaml.safe_load(fh) or {}).get("levers") or {}
    except FileNotFoundError:
        return {}


def for_kpi(kpi_id: str, allowed: list[str]) -> list[tuple[str, dict]]:
    """Levers this KPI may use: declared in the library AND allowed by the contract."""
    lib = load_levers()
    out = []
    for name in allowed:
        spec = lib.get(name)
        if spec and kpi_id in (spec.get("applies_to") or []):
            out.append((name, spec))
    return out


def impact_range(spec: dict, recoverable: float) -> tuple[float, float]:
    """The lever's declared share of the gap it recovers, applied to the localized gap."""
    imp = spec.get("expected_impact") or {}
    lo = float(imp.get("low", 0.0)) * recoverable
    hi = float(imp.get("high", 0.0)) * recoverable
    return (min(lo, hi), max(lo, hi))


def monitoring(spec: dict, kpi_id: str) -> dict:
    m = spec.get("monitoring") or {}
    return {"watch": m.get("watch") or kpi_id,
            "threshold": m.get("threshold", ""),
            "for_days": int(m.get("for_days", 7))}
