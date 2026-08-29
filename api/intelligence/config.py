"""Tunables for the intelligence layer. Every value is env-overridable; nothing is hardcoded."""
from __future__ import annotations

import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _s(name: str, default: str) -> str:
    return os.environ.get(name, default) or default


def _list(name: str, default: str) -> list[str]:
    return [x.strip() for x in _s(name, default).split(",") if x.strip()]


# --- rounding / determinism -------------------------------------------------
ROUND_DP = _i("INTEL_ROUND_DP", 6)
ID_LENGTH = _i("INTEL_ID_LENGTH", 16)

# --- contract discovery -----------------------------------------------------
# A dimension is sliceable only if it varies this rarely within the grain entity.
INVARIANCE_FLOOR = _f("INTEL_INVARIANCE_FLOOR", 0.99)
TIER0_MIN_EVENTS = _i("INTEL_TIER0_MIN_EVENTS", 1)
TIER0_MAX_METADATA_KEYS = _i("INTEL_TIER0_MAX_KEYS", 40)
# Identity-ish keys are never cube dimensions regardless of invariance.
NON_DIMENSION_KEYS = set(_list(
    "INTEL_NON_DIMENSION_KEYS",
    "session_id,user_id,event_id,ip,email,path,referrer,user_agent,screen_width",
))

# --- detect -----------------------------------------------------------------
MATERIALITY_FLOOR = _f("INTEL_MATERIALITY_FLOOR", 0.15)
# Absolute events a KPI must carry in the window before a breach is worth investigating.
MIN_KPI_VOLUME = _f("INTEL_MIN_KPI_VOLUME", 20)
SEVERITY_WARN = _f("INTEL_SEVERITY_WARN", 0.40)
SEVERITY_URGENT = _f("INTEL_SEVERITY_URGENT", 0.75)
ROBUST_Z_THRESHOLD = _f("INTEL_ROBUST_Z", 3.0)
FDR_ALPHA = _f("INTEL_FDR_ALPHA", 0.05)

# --- forecast ---------------------------------------------------------------
SEASONAL_PERIOD_DAYS = _i("INTEL_SEASONAL_PERIOD_DAYS", 7)
BACKTEST_FOLDS = _i("INTEL_BACKTEST_FOLDS", 5)
# A method must beat the contract baseline by this margin on its own series to be promoted.
PROMOTION_MARGIN = _f("INTEL_PROMOTION_MARGIN", 0.95)
Z_95 = _f("INTEL_Z_95", 1.959964)
MAD_TO_SIGMA = _f("INTEL_MAD_TO_SIGMA", 1.4826)
COLD_START_CONFIDENCE = _f("INTEL_COLD_START_CONFIDENCE", 0.3)

# --- localize ---------------------------------------------------------------
MAX_CAUSES = _i("INTEL_MAX_CAUSES", 5)

# --- trust gate -------------------------------------------------------------
# A daily series is at best one bucket stale, so a streaming SLA can never pass on daily grain.
DAILY_FRESHNESS_FLOOR_MIN = _i("INTEL_DAILY_FRESHNESS_FLOOR_MIN", 1440)

# --- narrate ----------------------------------------------------------------
PERSONAS = _list("INTEL_PERSONAS", "cfo,ops_manager,analyst")
DEFAULT_PERSONA = _s("INTEL_DEFAULT_PERSONA", "analyst")
VERIFIER_TOLERANCE = _f("INTEL_VERIFIER_TOLERANCE", 0.01)

# --- llm (optional; the layer is complete without it) -----------------------
LLM_ENABLED = _s("INTELLIGENCE_LLM", "0") == "1"
LLM_BASE_URL = _s("VLLM_URL", "http://vllm-server:8000/v1")
# Empty means "ask the server what it serves" -- no model name is assumed anywhere.
LLM_MODEL = _s("INTEL_LLM_MODEL", "")
LLM_MAX_ATTEMPTS = _i("INTEL_LLM_MAX_ATTEMPTS", 2)
LLM_TIMEOUT_S = _i("INTEL_LLM_TIMEOUT_S", 60)
LLM_MAX_TOKENS = _i("INTEL_LLM_MAX_TOKENS", 400)
LLM_TEMPERATURE = _f("INTEL_LLM_TEMPERATURE", 0.0)
LLM_SEED = _i("INTEL_LLM_SEED", 1337)
LLM_DISCOVERY_TIMEOUT_S = _i("INTEL_LLM_DISCOVERY_TIMEOUT_S", 5)

# --- service ----------------------------------------------------------------
TENANTS = _list("INTELLIGENCE_TENANTS", "nexabank,safexbank")
WINDOW_DAYS = _i("INTELLIGENCE_WINDOW_DAYS", 7)
BASELINE_DAYS = _i("INTELLIGENCE_BASELINE_DAYS", 28)
DATASET = _s("INTELLIGENCE_DATASET", "seeded")
FORECAST_INTERVAL_MIN = _i("INTELLIGENCE_FORECAST_INTERVAL_MIN", 60)
SWEEP_INTERVAL_MIN = _i("INTELLIGENCE_SWEEP_INTERVAL_MIN", 15)
# Source 2 refreshes hourly; source 3 weekly but re-seeding is a no-op.
BATCH_INTERVAL_MIN = _i("INTELLIGENCE_BATCH_INTERVAL_MIN", 60)
# Bounds a sweep so thousands of series cannot make one run unbounded.
MAX_KPIS_PER_SWEEP = _i("INTELLIGENCE_MAX_KPIS_PER_SWEEP", 200)
# Agent loop: how many reason->act->observe->validate rounds before it must answer or
# abstain. Bounded so a re-planning loop cannot run away on a live request.
AGENT_MAX_ROUNDS = _i("INTEL_AGENT_MAX_ROUNDS", 3)
