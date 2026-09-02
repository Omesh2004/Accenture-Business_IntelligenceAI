"""Dashboard API — the endpoints the Round-2 dashboard calls, on :8001.

Everything reads through the Metric API router (KPI / funnel / evidence) or the Signal Store
reader (`api/intelligence/reader.py`, now pointed at `gold`). Persona is resolved server-side;
an `ops_manager` response has `revenue` stripped so it cannot be seen or back-computed.

`api/main.py` (4176 lines, ~45 Round-1 endpoints) is deleted; this is its replacement.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

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
    start, end = _window(days)
    prev_start = start - (end - start)
    names = {k: c.name for k, c in load_declared().items()}
    out = []
    # The portfolio is the same for every reader. Entitlement lives in the ANSWER: what the agent
    # will discuss, which figures it may quote, and what it removes before the narrator sees the
    # claim set. Hiding a metric from the board as well left a reader unable to tell whether the
    # thing they own is the one that matters.
    for kpi_id in all_kpi_ids():
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
    # Never select a finding this reader may not see. Filtering the response after the
    # fact left the metric's name in the headline and narrative.
    row = _reader().latest_insight(tenant, p, kpi_id,
                                   exclude_kpis=tuple(hidden_kpis(p)))
    body = {"tenant_id": tenant, "persona": p,
            "insight": row or None,
            "detail": None if row else "no investigation has produced an insight yet"}
    return filter_revenue(p, body)


@app.post("/intelligence/rescore")
def intelligence_rescore(tenants: str = Query(None), days: int = Query(0, ge=0, le=365),
                         all_windows: bool = Query(False)):
    """Re-run the investigation sweep now, for one window or for all of them.

    The service sweeps on a timer. This is for the moment a movement has just been planted in
    NexaBank and pushed through the pipeline: without it the engine keeps answering from the last
    tick, and an anomaly that already exists in the data reads as "no material movement" until the
    clock comes round.
    """
    from api.intelligence import config as icfg
    from api.intelligence.orchestrator import Orchestrator
    from api.intelligence.service import current_window
    from api.metric_api.client import MetricAPIClient

    tenant = _tenant(tenants)
    # One window by default. Sweeping all three takes minutes and times the request out; the
    # window on screen is the one a demo needs back immediately.
    windows = ([days] if days
               else list(icfg.WINDOW_CHOICES) if all_windows
               else [icfg.WINDOW_DAYS])
    orch = Orchestrator(MetricAPIClient())
    out = []
    for span in windows:
        try:
            results = orch.sweep(tenant, current_window(span), dataset=icfg.DATASET,
                                 run_forecast=True)
            out.append({"window_days": span, "investigations": len(results),
                        "anomalies": sum(1 for r in results if r.get("anomaly"))})
        except Exception as exc:                                    # noqa: BLE001
            out.append({"window_days": span, "error": str(exc)})
    return {"tenant_id": tenant, "swept": out}


@app.get("/intelligence/insights")
def intelligence_insights(request: Request, tenants: str = Query(None),
                          limit: int = Query(20, ge=1, le=100),
                          days: int = Query(0, ge=0, le=365)):
    """`days` selects the findings scored over that window. Without it the newest of any window
    wins, which is how a 90-day movement ended up marked on a 7-day chart."""
    tenant = _tenant(tenants)
    p = resolve_persona(request)
    rows = _reader().list_insights(tenant, p, limit, window_days=days or None)
    return filter_revenue(p, {"tenant_id": tenant, "persona": p, "days": days,
                              "insights": rows})


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


@app.post("/intelligence/ask/stream")
def intelligence_ask_stream(request: Request, req: AskRequest):
    """Same answer as /ask, streamed as SSE so the trace appears while the agent works.

    Frames: rail | pending | step | result | answer | error, each `event:`/`data:` separated by
    a blank line.
    """
    from api.intelligence import loop

    tenant = _tenant(req.tenant_id)
    p = resolve_persona(request, req.persona)
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")

    def frame(kind: str, payload) -> str:
        body = json.dumps(payload, default=str)
        return "event: " + kind + "\ndata: " + body + "\n\n"

    def generate():
        queue: list[str] = []

        def emit(kind: str, payload) -> None:
            queue.append(frame(kind, payload))

        try:
            res = loop.run(tenant, question, p, emit=emit,
                           window_days=int(req.days or 0), history=req.history or [])
        except Exception as exc:
            yield frame("error", {"detail": str(exc)})
            return
        # Steps first, then the finished answer, so the reader sees the work before the verdict.
        for chunk in queue:
            yield chunk
        body = filter_revenue(p, res.as_dict())
        if body.get("rail"):
            yield frame("rail", {"gates": body["rail"]})
        yield frame("answer", body)

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/intelligence/ask")
def intelligence_ask(request: Request, req: AskRequest):
    """Ask the agent a question. Persona is resolved server-side, never from the body."""
    from api.intelligence import loop
    tenant = _tenant(req.tenant_id)
    p = resolve_persona(request, req.persona)
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    res = loop.run(tenant, question, p, window_days=int(req.days or 0),
                   history=req.history or [])
    # Entitlement is applied inside the agent before assembly; this is belt and braces at the
    # boundary, so a new field can never leak a hidden KPI.
    return filter_revenue(p, res.as_dict())
