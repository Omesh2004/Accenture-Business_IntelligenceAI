"""Dashboard API — the endpoints the Round-2 dashboard calls, on :8001.

Everything reads through the Metric API router (KPI / funnel / evidence) or the Signal Store
reader (`api/intelligence/reader.py`, now pointed at `gold`). Persona is resolved server-side;
an `ops_manager` response has `revenue` stripped so it cannot be seen or back-computed.

`api/main.py` (4176 lines, ~45 Round-1 endpoints) is deleted; this is its replacement.
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from api.metric_api.main import router as metric_router, tenant_ok, KNOWN_TENANTS
from api.metric_api import reads
from api.contracts_loader import all_kpi_ids, KPI_REGISTRY, load_declared
from api.middleware import resolve_persona, selectable_personas, filter_revenue, hidden_kpis
from api.schemas import OutcomeRequest, AskRequest

TENANT_DEFAULT = os.environ.get("DASHBOARD_TENANT", "nexabank")

app = FastAPI(title="FinInsights Dashboard API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(metric_router)


def _tenant(tenants: str | None) -> str:
    t = ([x.strip() for x in (tenants or TENANT_DEFAULT).split(",") if x.strip()] or [TENANT_DEFAULT])[0]
    return tenant_ok(t)


def _window(days: int) -> tuple[date, date]:
    end = datetime.utcnow().date() + timedelta(days=1)
    return end - timedelta(days=days), end


# ── health / tenants ───────────────────────────────────────────────────────
@app.get("/health")
def health():
    from api.metric_api.main import metric_health
    return {"status": "ok", "metric_api": metric_health()}


@app.get("/tenants")
@app.get("/tenants/available")
def tenants():
    return {"tenants": sorted(KNOWN_TENANTS), "default": TENANT_DEFAULT}


@app.get("/deployment/info")
def deployment_info():
    return {"mode": "single_tenant", "tenant": TENANT_DEFAULT}


# ── dashboard KPI / funnel / traffic (rebuilt on the Metric API) ────────────
@app.get("/metrics/kpi")
def dashboard_kpis(request: Request,
                   tenants: str = Query(None), days: int = Query(30, ge=7, le=180),
                   persona: str = Query(None)):
    tenant = _tenant(tenants)
    p = resolve_persona(request, persona)
    hidden = hidden_kpis(p)
    start, end = _window(days)
    prev_start = start - (end - start)
    names = {k: c.name for k, c in load_declared().items()}
    out = []
    for kpi_id in all_kpi_ids():
        if kpi_id in hidden:
            continue
        total = reads.kpi_total(tenant, kpi_id, start, end)
        prev = reads.kpi_total(tenant, kpi_id, prev_start, start)
        out.append({"kpi_id": kpi_id, "name": names.get(kpi_id, kpi_id),
                    "kind": total["kind"],
                    "fundamentals": total["fundamentals"],
                    "rate": total.get("rate"),
                    "previous": {"fundamentals": prev["fundamentals"],
                                 "rate": prev.get("rate")}})
    return {"tenant": tenant, "persona": p, "days": days, "kpis": out}


@app.get("/metrics/traffic")
def dashboard_traffic(tenants: str = Query(None), days: int = Query(30, ge=7, le=180)):
    tenant = _tenant(tenants)
    start, end = _window(days)
    s = reads.kpi_series(tenant, "transaction_failure_rate", start, end)
    return {"tenant": tenant, "dates": s["dates"],
            "txn_total": s["fundamentals"].get("txn_total", []),
            "txn_failed": s["fundamentals"].get("txn_failed", [])}


@app.get("/funnels")
def dashboard_funnels(tenants: str = Query(None), days: int = Query(30, ge=7, le=180),
                      funnel_id: str = Query("kyc_funnel")):
    tenant = _tenant(tenants)
    start, end = _window(days)
    return reads.funnel(tenant, funnel_id, start, end)


# ── intelligence reads (Signal Store, via api/intelligence/reader.py -> gold) ──
def _reader():
    from api.intelligence import reader
    return reader


@app.get("/intelligence/personas")
def intelligence_personas(request: Request):
    from api.intelligence import personas as reg
    return {"resolved": resolve_persona(request),
            "personas": [reg.as_dict(p) for p in selectable_personas(request)]}


@app.get("/intelligence/insight")
def intelligence_insight(request: Request, tenants: str = Query(None),
                         kpi_id: str = Query(None), persona: str = Query(None)):
    tenant = _tenant(tenants)
    p = resolve_persona(request, persona)
    if kpi_id and kpi_id in hidden_kpis(p):
        raise HTTPException(status_code=403, detail=f"persona {p!r} may not view {kpi_id!r}")
    row = _reader().latest_insight(tenant, p, kpi_id)
    body = {"tenant_id": tenant, "persona": p,
            "insight": row or None,
            "detail": None if row else "no investigation has produced an insight yet"}
    return filter_revenue(p, body)


@app.get("/intelligence/insights")
def intelligence_insights(request: Request, tenants: str = Query(None),
                          limit: int = Query(20, ge=1, le=100)):
    tenant = _tenant(tenants)
    p = resolve_persona(request)
    return filter_revenue(p, {"tenant_id": tenant, "persona": p,
                              "insights": _reader().list_insights(tenant, p, limit)})


@app.get("/intelligence/sources")
def intelligence_sources(tenants: str = Query(None)):
    tenant = _tenant(tenants)
    try:
        return {"tenant_id": tenant, "sources": _reader().source_health(tenant)}
    except Exception:
        return {"tenant_id": tenant, "sources": reads.freshness(tenant)["sources"]}


@app.get("/intelligence/telemetry")
def intelligence_telemetry(tenants: str = Query(None)):
    tenant = _tenant(tenants)
    return {"tenant_id": tenant, "telemetry": _reader().runtime_telemetry(tenant)}


@app.get("/intelligence/recommendations")
def intelligence_recommendations(request: Request, tenants: str = Query(None),
                                 limit: int = Query(20, ge=1, le=100)):
    tenant = _tenant(tenants)
    p = resolve_persona(request)
    return filter_revenue(p, {"tenant_id": tenant,
                              "recommendations": _reader().recommendations(tenant, limit)})


@app.get("/intelligence/series")
def intelligence_series(request: Request, tenants: str = Query(None),
                        kpi_id: str = Query(...), days: int = Query(30, ge=7, le=120),
                        persona: str = Query(None)):
    tenant = _tenant(tenants)
    p = resolve_persona(request, persona)
    if kpi_id in hidden_kpis(p):
        raise HTTPException(status_code=403, detail=f"persona {p!r} may not view {kpi_id!r}")
    start, end = _window(days)
    return reads.kpi_series(tenant, kpi_id, start, end)


@app.get("/intelligence/rail")
def intelligence_rail():
    try:
        from api.intelligence import gates
        return {"gates": gates.catalogue()}
    except Exception:
        return {"gates": []}


@app.post("/intelligence/outcome")
def intelligence_outcome(req: OutcomeRequest):
    try:
        from api.intelligence import signal_store
        from api.intelligence.ids import outcome_id
        now = datetime.utcnow()
        signal_store.write_outcome({
            "outcome_id": outcome_id(req.insight_id, req.signal, req.actor),
            "investigation_id": req.investigation_id, "insight_id": req.insight_id,
            "tenant_id": req.tenant_id, "signal": req.signal, "value": req.value,
            "actor": req.actor, "ts": now})
        return {"status": "recorded"}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"feedback loop unavailable: {exc}")


@app.post("/intelligence/ask")
@app.post("/intelligence/ask/stream")
def intelligence_ask(req: AskRequest):
    raise HTTPException(
        status_code=503,
        detail="the intelligence agent is being rebuilt for Round 2 (Track C). "
               "The read endpoints (/intelligence/insight, /series, /recommendations) are live.")
