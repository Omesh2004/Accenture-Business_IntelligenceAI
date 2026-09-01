"""Metric API — the one doorway into the warehouse (CLAUDE.md §11, §13).

Named, tenant-scoped, contract-driven reads over `silver` + `gold` only. No tool and no dashboard
endpoint issues SQL against the warehouse except through here.

Exposed as an `APIRouter` (`router`) so the dashboard API mounts it on the same `:8001` app, and
as a standalone `app` for running it alone.
"""
from __future__ import annotations

import os
import sys
from datetime import date

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fastapi import APIRouter, FastAPI, HTTPException

from api.contracts_loader import all_kpi_ids, validate_against_schema, UnknownKpi
from api.metric_api import reads
from warehouse.client import ch_client

KNOWN_TENANTS = set(t.strip() for t in
                    os.environ.get("METRIC_API_TENANTS", "nexabank").split(",")
                    if t.strip())

router = APIRouter()


def tenant_ok(tenant: str) -> str:
    if tenant not in KNOWN_TENANTS:
        raise HTTPException(status_code=400, detail=f"unknown tenant {tenant!r}")
    return tenant


def _guard(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except UnknownKpi as exc:
        raise HTTPException(status_code=404, detail=f"unknown kpi_id {exc.args[0]!r}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/metric/health")
def metric_health():
    try:
        problems = validate_against_schema(ch_client)
    except Exception as exc:
        return {"status": "degraded", "error": str(exc)}
    return {"status": "ok" if not problems else "degraded", "schema_problems": problems,
            "tenants": sorted(KNOWN_TENANTS), "kpis": all_kpi_ids()}


@router.get("/metric/kpi/series")
def r_series(tenant: str, kpi_id: str, start: date, end: date):
    return _guard(reads.kpi_series, tenant_ok(tenant), kpi_id, start, end)


@router.get("/metric/kpi/total")
def r_total(tenant: str, kpi_id: str, start: date, end: date):
    return _guard(reads.kpi_total, tenant_ok(tenant), kpi_id, start, end)


@router.get("/metric/kpi/by_dim")
def r_by_dim(tenant: str, kpi_id: str, fundamental: str, dims: str,
             start: date, end: date, min_volume: float = 0):
    return _guard(reads.kpi_by_dim, tenant_ok(tenant), kpi_id, fundamental,
                  [d for d in dims.split(",") if d], start, end, min_volume)


@router.get("/metric/kpi/cell_deltas")
def r_cell_deltas(tenant: str, kpi_id: str, fundamental: str, dims: str,
                  start: date, end: date, baseline_start: date, baseline_end: date,
                  min_volume: float = 0):
    return _guard(reads.kpi_cell_deltas, tenant_ok(tenant), kpi_id, fundamental,
                  [d for d in dims.split(",") if d], start, end,
                  baseline_start, baseline_end, min_volume)


@router.get("/metric/funnel")
def r_funnel(tenant: str, funnel_id: str, start: date, end: date):
    return _guard(reads.funnel, tenant_ok(tenant), funnel_id, start, end)


@router.get("/metric/dedup_counts")
def r_dedup(tenant: str, kpi_id: str, start: date, end: date):
    return _guard(reads.dedup_counts, tenant_ok(tenant), kpi_id, start, end)


@router.get("/metric/freshness")
def r_freshness(tenant: str):
    return _guard(reads.freshness, tenant_ok(tenant))


@router.get("/metric/dimensions")
def r_dimensions(tenant: str, kpi_id: str, start: date, end: date):
    return _guard(reads.dimensions, tenant_ok(tenant), kpi_id, start, end)


@router.get("/metric/calendar")
def r_calendar(tenant: str, start: date, end: date):
    return _guard(reads.calendar, tenant_ok(tenant), start, end)


@router.get("/metric/campaigns")
def r_campaigns(tenant: str, start: date, end: date):
    return _guard(reads.campaigns, tenant_ok(tenant), start, end)


@router.get("/metric/discover")
def r_discover(tenant: str, start: date, end: date):
    return _guard(reads.discover, tenant_ok(tenant), start, end)


@router.get("/metric/watermark")
def r_watermark(tenant: str):
    return _guard(reads.watermark, tenant_ok(tenant))


# Standalone app (for running the Metric API alone).
app = FastAPI(title="Metric API")
app.include_router(router)


@app.get("/health")
def health():
    return metric_health()
