"""Deterministic id derivation. No uuid4(), no now() -- see docs/PIPELINE_CONTRACT.md section 1."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from api.intelligence import config

ROUND_DP = config.ROUND_DP


def _norm(value: Any) -> str:
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, float):
        return f"{round(value, ROUND_DP):.6f}"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return str(value)


def derive_id(*parts: Any, length: int | None = None) -> str:
    """Stable id from inputs. Same inputs always produce the same id, on any machine."""
    joined = "|".join(_norm(p) for p in parts)
    length = config.ID_LENGTH if length is None else length
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:length]


def investigation_id(tenant_id: str, kpi_id: str, window_start: datetime, trigger: str) -> str:
    return derive_id(tenant_id, kpi_id, window_start, trigger)


def finding_id(investigation: str, check_id: str) -> str:
    return derive_id(investigation, check_id)


def anomaly_id(tenant_id: str, kpi_id: str, window_start: datetime, method: str) -> str:
    return derive_id(tenant_id, kpi_id, window_start, method)


def cause_id(anomaly: str, rank: int) -> str:
    return derive_id(anomaly, rank)


def forecast_id(tenant_id: str, kpi_id: str, as_of: datetime, method: str) -> str:
    return derive_id(tenant_id, kpi_id, as_of, method)


def effect_id(anomaly: str, intervention: str) -> str:
    return derive_id(anomaly, intervention)


def rec_id(anomaly: str, lever: str) -> str:
    return derive_id(anomaly, lever)


def insight_id(investigation: str, persona: str) -> str:
    return derive_id(investigation, persona)


def run_id(investigation: str, stage: str, attempt: int = 0) -> str:
    return derive_id(investigation, stage, attempt)


def outcome_id(insight: str, signal: str, actor: str) -> str:
    return derive_id(insight, signal, actor)


def inputs_hash(payload: Any) -> str:
    """Hash of a stage's inputs, for drift detection in model_runs."""
    return derive_id(payload, length=32)


def round6(value: float | int | None) -> float:
    """Round at the write boundary so float order-dependence cannot reach storage."""
    if value is None:
        return 0.0
    try:
        return round(float(value), ROUND_DP)
    except (TypeError, ValueError):
        return 0.0
