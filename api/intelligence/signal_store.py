"""Signal Store writers. Every row carries investigation_id; every float is rounded at write."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from typing import Any

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from api.intelligence.ids import round6  # noqa: E402

DB = "gold"


# Imported lazily so the stages are importable without the ClickHouse driver.
def _ch():
    from warehouse.client import ch_client
    return ch_client


def _client():
    return _ch()._get_client()


def _insert(table: str, columns: list[str], rows: list[list[Any]]) -> int:
    if not rows:
        return 0
    client = _client()
    try:
        client.insert(f"{DB}.{table}", rows, column_names=columns)
        return len(rows)
    finally:
        try:
            client.close()
        except Exception:
            pass


def _j(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def write_investigation(*, investigation_id, tenant_id, kpi_id, window_start, window_end,
                        trigger, status, dataset, started_at, terminal_stage="",
                        termination_reason="", ended_at=None, watermark=None) -> int:
    return _insert(
        "investigations",
        ["investigation_id", "tenant_id", "kpi_id", "window_start", "window_end", "trigger",
         "status", "terminal_stage", "termination_reason", "dataset", "started_at", "ended_at",
         "watermark_ingested_at"],
        [[investigation_id, tenant_id, kpi_id, window_start, window_end, trigger, status,
          terminal_stage, termination_reason, dataset, started_at,
          ended_at or datetime(1970, 1, 1), watermark or datetime(1970, 1, 1)]],
    )


def write_trust_findings(rows: list[dict]) -> int:
    return _insert(
        "trust_findings",
        ["finding_id", "investigation_id", "tenant_id", "kpi_id", "window_start", "window_end",
         "verdict", "check_id", "fingerprint", "observed", "expected", "cheapest_check",
         "blocks_narrative", "engine_type", "ts"],
        [[r["finding_id"], r["investigation_id"], r["tenant_id"], r["kpi_id"], r["window_start"],
          r["window_end"], r["verdict"], r["check_id"], r.get("fingerprint", ""),
          _j(r.get("observed")), _j(r.get("expected")), r.get("cheapest_check", ""),
          int(r.get("blocks_narrative", 0)), r.get("engine_type", "rule"), r["ts"]] for r in rows],
    )


def write_anomaly(r: dict) -> int:
    return _insert(
        "anomalies",
        ["anomaly_id", "investigation_id", "tenant_id", "kpi_id", "detected_at", "window_start",
         "window_end", "method", "direction", "magnitude", "baseline", "observed", "forecast_id",
         "materiality", "severity", "status", "engine_type"],
        [[r["anomaly_id"], r["investigation_id"], r["tenant_id"], r["kpi_id"], r["detected_at"],
          r["window_start"], r["window_end"], r["method"], int(r["direction"]),
          round6(r["magnitude"]), round6(r["baseline"]), round6(r["observed"]),
          r.get("forecast_id", ""), round6(r["materiality"]), r["severity"],
          r.get("status", "open"), r.get("engine_type", "stats")]],
    )


def write_root_causes(rows: list[dict]) -> int:
    return _insert(
        "root_causes",
        ["cause_id", "investigation_id", "anomaly_id", "tenant_id", "rank", "dimensions",
         "fundamental", "contribution", "method", "explained_pct", "engine_type"],
        [[r["cause_id"], r["investigation_id"], r["anomaly_id"], r["tenant_id"], int(r["rank"]),
          _j(r["dimensions"]), r["fundamental"], round6(r["contribution"]), r["method"],
          round6(r["explained_pct"]), r.get("engine_type", "stats")] for r in rows],
    )


def write_forecast(r: dict) -> int:
    return _insert(
        "forecasts",
        ["forecast_id", "tenant_id", "kpi_id", "as_of", "horizon_days", "point", "lower", "upper",
         "method", "confidence", "backtest_mase", "caveat", "engine_type"],
        [[r["forecast_id"], r["tenant_id"], r["kpi_id"], r["as_of"], int(r["horizon_days"]),
          round6(r["point"]), round6(r["lower"]), round6(r["upper"]), r["method"],
          round6(r["confidence"]), round6(r.get("backtest_mase", 0)), r.get("caveat", ""),
          r.get("engine_type", "stats")]],
    )


def read_forecast(tenant_id: str, kpi_id: str, as_of: datetime) -> dict | None:
    rows = _ch().query(
        f"SELECT * FROM {DB}.forecasts WHERE tenant_id = %(t)s AND kpi_id = %(k)s "
        "AND as_of <= %(a)s ORDER BY as_of DESC, forecast_id ASC LIMIT 1",
        {"t": tenant_id, "k": kpi_id, "a": as_of},
    )
    return rows[0] if rows else None


def write_causal_effect(r: dict) -> int:
    return _insert(
        "causal_effects",
        ["effect_id", "investigation_id", "anomaly_id", "tenant_id", "kpi_id", "intervention",
         "rung", "effect_point", "effect_lower", "effect_upper", "method", "assumptions_met",
         "degraded_reason", "engine_type"],
        [[r["effect_id"], r["investigation_id"], r["anomaly_id"], r["tenant_id"], r["kpi_id"],
          r["intervention"], r["rung"], round6(r["effect_point"]), round6(r["effect_lower"]),
          round6(r["effect_upper"]), r["method"], int(r.get("assumptions_met", 1)),
          r.get("degraded_reason", ""), r.get("engine_type", "stats")]],
    )


def write_recommendation(r: dict) -> int:
    return _insert(
        "recommendations",
        ["rec_id", "investigation_id", "anomaly_id", "tenant_id", "action", "lever", "owner_role",
         "expected_impact", "status", "engine_type"],
        [[r["rec_id"], r["investigation_id"], r["anomaly_id"], r["tenant_id"], r["action"],
          r["lever"], r["owner_role"], _j(r["expected_impact"]), r.get("status", "proposed"),
          r.get("engine_type", "rule")]],
    )


def write_insight(r: dict) -> int:
    return _insert(
        "insights",
        ["insight_id", "investigation_id", "tenant_id", "kpi_id", "anomaly_id", "persona",
         "generated_at", "trust_verdict", "headline", "narrative", "evidence", "llm_breakdown",
         "confidence", "simulated", "abstained", "verifier_pass"],
        [[r["insight_id"], r["investigation_id"], r["tenant_id"], r["kpi_id"],
          r.get("anomaly_id", ""), r["persona"], r["generated_at"], r["trust_verdict"],
          r["headline"], r["narrative"], _j(r["evidence"]), _j(r["llm_breakdown"]),
          round6(r["confidence"]), int(r.get("simulated", 0)), int(r.get("abstained", 0)),
          int(r.get("verifier_pass", 1))]],
    )


def write_model_run(r: dict) -> int:
    return _insert(
        "model_runs",
        ["run_id", "investigation_id", "insight_id", "tenant_id", "stage", "engine_type", "model",
         "inputs_hash", "tokens_in", "tokens_out", "latency_ms", "cost_est_usd", "verifier_pass",
         "ts"],
        [[r["run_id"], r["investigation_id"], r.get("insight_id", ""), r["tenant_id"], r["stage"],
          r["engine_type"], r.get("model", ""), r.get("inputs_hash", ""),
          int(r.get("tokens_in", 0)), int(r.get("tokens_out", 0)), int(r["latency_ms"]),
          round6(r.get("cost_est_usd", 0)), int(r.get("verifier_pass", 1)), r["ts"]]],
    )


def write_outcome(r: dict) -> int:
    return _insert(
        "outcomes",
        ["outcome_id", "investigation_id", "insight_id", "tenant_id", "signal", "value", "actor",
         "ts"],
        [[r["outcome_id"], r["investigation_id"], r["insight_id"], r["tenant_id"], r["signal"],
          r["value"], r["actor"], r["ts"]]],
    )


def engine_breakdown(investigation_id: str) -> dict[str, int]:
    """LLM-vs-non-LLM, computed from model_runs -- never asserted by the model.

    uniqExact(run_id), not count(): model_runs is a plain MergeTree and run_id is derived, so a
    re-run appends identical rows. Counting them would inflate the breakdown on every replay.
    """
    rows = _ch().query(
        f"SELECT engine_type, uniqExact(run_id) AS n FROM {DB}.model_runs "
        "WHERE investigation_id = %(i)s GROUP BY engine_type ORDER BY engine_type",
        {"i": investigation_id},
    )
    return {str(r["engine_type"]): int(r["n"]) for r in rows}
