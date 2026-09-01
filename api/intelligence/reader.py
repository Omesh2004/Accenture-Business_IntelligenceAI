"""Read side: what the dashboard AI panel consumes.

The narrator may state only what the Signal Store contains, so the reader returns stored rows --
it never recomputes a number.
"""
from __future__ import annotations

import json
from typing import Any

DB = "gold"


def _ch():
    from warehouse.client import ch_client
    return ch_client


class RegistryUnavailable(RuntimeError):
    """The contract registry could not be read, so governance cannot be determined."""


def _declared_ids() -> tuple[str, ...]:
    """Tier 1 contract ids for ORDERING. Degrading here only costs rank quality, not truth."""
    try:
        from api.intelligence.contracts import load_declared
        return tuple(sorted(load_declared())) or ("",)
    except Exception:
        return ("",)


def _governed_ids() -> tuple[str, ...]:
    """Tier 1 contract ids for FILTERING. Raises rather than degrading.

    The lenient fallback returns `("",)`, and `kpi_id IN ('')` matches nothing -- so an unreadable
    contracts/ directory emptied the ranked list and the agent reported "no governed metric is
    currently outside its expected band". A registry failure must not render as an analytical
    finding. Callers turn this into a stated tool failure instead.
    """
    try:
        from api.intelligence.contracts import load_declared
        ids = tuple(sorted(load_declared()))
    except Exception as exc:                                        # noqa: BLE001
        raise RegistryUnavailable("contract registry unreadable: %s" % exc) from exc
    if not ids:
        raise RegistryUnavailable("the contract registry is empty")
    return ids


def _loads(value: Any, default):
    try:
        return json.loads(value) if isinstance(value, str) else (value or default)
    except (ValueError, TypeError):
        return default


def latest_insight(tenant_id: str, persona: str = "analyst",
                   kpi_id: str | None = None) -> dict | None:
    """The insight most worth reading for a tenant/persona, with evidence and engine breakdown.

    `generated_at` is pinned to the window end for determinism, so every insight in a sweep shares
    it and ordering by time alone tiebreaks on `insight_id` -- which surfaced an arbitrary quiet
    KPI while an urgent anomaly sat unread. Rank by whether an anomaly was raised, then by whether
    the KPI is a governed Tier 1 contract (those are the ones with an owner and a lever list),
    then by materiality, before falling back to recency.
    """
    declared = _declared_ids()
    sql = (
        "SELECT i.* FROM ("
        f"  SELECT * FROM {DB}.insights FINAL WHERE tenant_id = %(t)s AND persona = %(p)s "
        + ("  AND kpi_id = %(k)s " if kpi_id else "")
        + ") AS i LEFT JOIN ("
          f"  SELECT anomaly_id, max(materiality) AS materiality FROM {DB}.anomalies FINAL "
          "  GROUP BY anomaly_id"
          ") AS a USING (anomaly_id) "
          "ORDER BY i.anomaly_id != '' DESC, i.kpi_id IN %(declared)s DESC, "
          "a.materiality DESC, i.generated_at DESC, i.confidence DESC, i.insight_id ASC LIMIT 1"
    )
    params = {"t": tenant_id, "p": persona, "declared": declared}
    if kpi_id:
        params["k"] = kpi_id
    rows = _ch().query(sql, params)
    if not rows:
        return None
    row = dict(rows[0])
    row["evidence"] = _loads(row.get("evidence"), [])
    row["llm_breakdown"] = _loads(row.get("llm_breakdown"), {})
    row["engine_breakdown"] = engine_breakdown(row["investigation_id"])
    row["trust"] = trust_summary(row["investigation_id"])
    row["causes"] = causes_for(row.get("anomaly_id", ""))
    row["anomaly"] = anomaly_row(row.get("anomaly_id", ""))
    row["factors"] = factor_breakdown(row.get("anomaly_id", ""))
    row["sources"] = source_health(tenant_id)
    return row


def list_insights(tenant_id: str, persona: str = "analyst", limit: int = 20) -> list[dict]:
    # One CURRENT insight per KPI. Every sweep writes a row keyed on its anomaly, and
    # generated_at is the window end rather than the run time, so the table accumulates rows
    # that cannot be ordered by time. A finding whose anomaly no longer exists is stale, so
    # live findings rank first and LIMIT 1 BY keeps one per KPI.
    rows = _ch().query(
        f"SELECT insight_id, investigation_id, kpi_id, anomaly_id, persona, generated_at, "
        f"trust_verdict, headline, confidence, simulated, abstained, verifier_pass FROM ("
        f"  SELECT i.insight_id, i.investigation_id, i.kpi_id, i.anomaly_id, i.persona, "
        f"         i.generated_at, i.trust_verdict, i.headline, i.confidence, i.simulated, "
        f"         i.abstained, i.verifier_pass, if(a.anomaly_id != '', 1, 0) AS live "
        f"  FROM {DB}.insights AS i FINAL "
        f"  LEFT JOIN (SELECT anomaly_id FROM {DB}.anomalies FINAL WHERE tenant_id = %(t)s) AS a "
        f"    ON i.anomaly_id = a.anomaly_id "
        f"  WHERE i.tenant_id = %(t)s AND i.persona = %(p)s"
        f") ORDER BY kpi_id ASC, live DESC, generated_at DESC, insight_id ASC "
        f"LIMIT 1 BY kpi_id LIMIT %(n)s",
        {"t": tenant_id, "p": persona, "n": int(limit)},
    )
    return [dict(r) for r in rows]


def anomaly_row(anomaly_id: str) -> dict:
    """The scored movement itself: window, direction, size and grade.

    The insight row records the CONCLUSION but not what it was scored over, so an answer built
    from it alone could not say which week it was talking about. Everything a reader needs to
    place the figure in time lives here.
    """
    if not anomaly_id:
        return {}
    rows = _ch().query(
        f"SELECT kpi_id, window_start, window_end, direction, magnitude, baseline, observed, "
        f"materiality, severity, method FROM {DB}.anomalies FINAL WHERE anomaly_id = %(a)s "
        "ORDER BY detected_at DESC LIMIT 1",
        {"a": anomaly_id},
    )
    return dict(rows[0]) if rows else {}


def causes_for(anomaly_id: str) -> list[dict]:
    if not anomaly_id:
        return []
    rows = _ch().query(
        f"SELECT rank, dimensions, fundamental, contribution, explained_pct, method "
        f"FROM {DB}.root_causes FINAL WHERE anomaly_id = %(a)s "
        "AND NOT startsWith(fundamental, 'factor:') ORDER BY rank ASC",
        {"a": anomaly_id},
    )
    out = []
    for r in rows:
        d = dict(r)
        d["dimensions"] = _loads(d.get("dimensions"), {})
        out.append(d)
    return out


def trust_summary(investigation_id: str) -> dict:
    """Every check, including passes -- stage 08 audits the suppression rate."""
    rows = _ch().query(
        f"SELECT check_id, verdict, fingerprint, cheapest_check, blocks_narrative, observed "
        f"FROM {DB}.trust_findings FINAL WHERE investigation_id = %(i)s ORDER BY check_id ASC",
        {"i": investigation_id},
    )
    checks = []
    for r in rows:
        d = dict(r)
        d["observed"] = _loads(d.get("observed"), {})
        checks.append(d)
    return {
        "checks": checks,
        "passed": sum(1 for c in checks if c["verdict"] == "pass"),
        "failed": sum(1 for c in checks if c["verdict"] == "fail"),
        "ambiguous": sum(1 for c in checks if c["verdict"] == "ambiguous"),
    }


def engine_breakdown(investigation_id: str) -> dict:
    """LLM-vs-non-LLM, computed from model_runs -- never asserted by the model."""
    rows = _ch().query(
        f"SELECT engine_type, count() AS runs, max(latency_ms) AS latency_ms, "
        f"sum(tokens) AS tokens FROM ("
        f"  SELECT run_id, min(engine_type) AS engine_type, min(latency_ms) AS latency_ms, "
        f"    min(tokens_in) + min(tokens_out) AS tokens "
        f"  FROM {DB}.model_runs WHERE investigation_id = %(i)s GROUP BY run_id"
        ") GROUP BY engine_type ORDER BY engine_type",
        {"i": investigation_id},
    )
    by_engine = {str(r["engine_type"]): {"runs": int(r["runs"]),
                                         "latency_ms": int(r["latency_ms"] or 0),
                                         "tokens": int(r["tokens"] or 0)} for r in rows}
    total = sum(v["runs"] for v in by_engine.values()) or 1
    llm = by_engine.get("llm", {}).get("runs", 0)
    return {
        "by_engine": by_engine,
        "total_runs": total,
        "llm_runs": llm,
        "non_llm_runs": total - llm,
        "llm_share_pct": round(llm / total * 100.0, 2),
    }


def recommendations(tenant_id: str, limit: int = 20, anomaly_id: str | None = None) -> list[dict]:
    """Filter in SQL, not after the limit: a tenant-wide top-N ordered by rec_id can exclude the
    one recommendation the caller actually asked about."""
    params = {"t": tenant_id, "n": int(limit)}
    where = "tenant_id = %(t)s"
    if anomaly_id:
        where += " AND anomaly_id = %(a)s"
        params["a"] = anomaly_id
    rows = _ch().query(
        f"SELECT rec_id, anomaly_id, action, lever, owner_role, expected_impact, status "
        f"FROM {DB}.recommendations FINAL WHERE {where} "
        "ORDER BY rec_id ASC LIMIT %(n)s",
        params,
    )
    out = []
    for r in rows:
        d = dict(r)
        d["expected_impact"] = _loads(d.get("expected_impact"), {})
        out.append(d)
    return out


def source_health(tenant_id: str) -> list[dict]:
    """Per-source freshness for the evidence card: cadence, SLA and how far behind each is."""
    rows = _ch().query(
        f"SELECT source_id, grain, cadence, sla_minutes, last_loaded_at, max_source_ts, "
        f"rows_loaded, load_status FROM {DB}.source_freshness FINAL "
        "WHERE tenant_id = %(t)s ORDER BY source_id", {"t": tenant_id})
    out = []
    for r in rows:
        d = dict(r)
        behind = None
        if d.get("max_source_ts") and d.get("last_loaded_at"):
            behind = round(max(0.0, (d["last_loaded_at"] - d["max_source_ts"]).total_seconds()
                               / 60.0), 1)
        d["minutes_behind"] = behind
        d["within_sla"] = behind is None or behind <= int(d.get("sla_minutes") or 0)
        out.append(d)
    return out


def factor_breakdown(anomaly_id: str) -> list[dict]:
    """Factor contributions (price/volume/mix), separate from the dimension cells."""
    if not anomaly_id:
        return []
    rows = _ch().query(
        f"SELECT rank, dimensions, fundamental, contribution, explained_pct, method "
        f"FROM {DB}.root_causes FINAL WHERE anomaly_id = %(a)s "
        "AND startsWith(fundamental, 'factor:') "
        "ORDER BY rank ASC", {"a": anomaly_id})
    out = []
    for r in rows:
        d = dict(r)
        d["dimensions"] = _loads(d.get("dimensions"), {})
        d["factor"] = d["dimensions"].get("factor", "")
        out.append(d)
    return out


def runtime_telemetry(tenant_id: str) -> dict:
    """Latency, model calls, tokens and estimated cost -- the PS's runtime telemetry."""
    rows = _ch().query(
        f"SELECT stage, engine_type, count() AS runs, sum(latency_ms) AS latency_ms, "
        f"sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, "
        f"sum(cost_usd) AS cost_usd FROM ("
        f"  SELECT run_id, min(stage) AS stage, min(engine_type) AS engine_type, "
        f"    min(latency_ms) AS latency_ms, min(tokens_in) AS tokens_in, "
        f"    min(tokens_out) AS tokens_out, min(cost_est_usd) AS cost_usd "
        f"  FROM {DB}.model_runs WHERE tenant_id = %(t)s GROUP BY run_id"
        ") GROUP BY stage, engine_type ORDER BY stage, engine_type", {"t": tenant_id})
    by_stage = [dict(r) for r in rows]
    total_runs = sum(int(r["runs"]) for r in by_stage) or 1
    llm_runs = sum(int(r["runs"]) for r in by_stage if r["engine_type"] == "llm")
    return {
        "by_stage": by_stage,
        "total_runs": total_runs,
        "llm_runs": llm_runs,
        "non_llm_runs": total_runs - llm_runs,
        "llm_share_pct": round(llm_runs / total_runs * 100.0, 2),
        "total_latency_ms": sum(int(r["latency_ms"] or 0) for r in by_stage),
        "total_tokens": sum(int(r["tokens_in"] or 0) + int(r["tokens_out"] or 0)
                            for r in by_stage),
        "total_cost_usd": round(sum(float(r["cost_usd"] or 0) for r in by_stage), 6),
    }


def top_movements(tenant_id: str, persona: str = "analyst", limit: int = 5,
                  governed_only: bool = True) -> list[dict]:
    """Metrics that moved, most material first -- the "what should I look at?" read.

    `governed_only` is the tier boundary. Materiality on a governed KPI means "warrants a
    decision"; on an auto-discovered series it can only mean "statistically unusual". Ranking
    both on one scale put page-view series beside revenue, so the default is Tier 1 only.

    Personas see only the KPIs whose contracts admit them, which entitlement already enforced
    when the insight row was written.
    """
    # Filtering uses the strict read: an unreadable registry raises instead of silently
    # matching nothing, which would report every metric as quiet.
    tier = "   AND kpi_id IN %(declared)s " if governed_only else " "
    declared = _governed_ids() if governed_only else _declared_ids()
    rows = _ch().query(
        "SELECT i.kpi_id AS kpi_id, i.headline AS headline, i.anomaly_id AS anomaly_id, "
        "       a.materiality AS materiality, a.severity AS severity, a.direction AS direction "
        "FROM ("
        f"  SELECT kpi_id, headline, anomaly_id FROM {DB}.insights FINAL "
        "   WHERE tenant_id = %(t)s AND persona = %(p)s AND anomaly_id != '' " + tier +
        ") AS i INNER JOIN ("
        f"  SELECT anomaly_id, max(materiality) AS materiality, any(severity) AS severity, "
        f"         any(direction) AS direction FROM {DB}.anomalies FINAL GROUP BY anomaly_id"
        ") AS a USING (anomaly_id) "
        # One row per KPI -- a KPI investigated twice in a window otherwise appears twice in a
        # list whose whole purpose is a priority order.
        "ORDER BY a.materiality DESC, i.kpi_id ASC, i.anomaly_id ASC "
        "LIMIT 1 BY i.kpi_id LIMIT %(n)s",
        {"t": tenant_id, "p": persona, "n": int(limit), "declared": declared},
    )
    return [dict(r) for r in rows]
