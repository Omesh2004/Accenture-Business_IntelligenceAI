"""Pipeline service: the batch scheduler for extract + transforms, and (Phase 3c) the gated
`POST /dev/seed` endpoint.

Runs in its own container. The Kafka consumer (`pipeline/worker.py`) is a separate process.

Two scheduled loops, each guarded — an unhandled exception must not kill a loop silently:
  - extract loop:   bronze.core_banking  (+ synthesised reference data)
  - transform loop: bronze -> silver -> gold
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from pipeline.extract import core_banking, reference
from pipeline.extract.freshness import mark_source_failed, record_clickstream_freshness
from pipeline.transforms import (silver_facts, gold_kpi,
                                 silver_events, silver_sessions, gold_funnel)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pipeline")

TENANTS = [t.strip() for t in os.environ.get("PIPELINE_TENANTS", "nexabank").split(",") if t.strip()]
# Tight enough that a change planted in NexaBank is visible in the warehouse within a
# couple of minutes. At five and three minutes the chain took the better part of half an
# hour to surface anything, which is not a loop anyone can watch.
EXTRACT_INTERVAL_S = int(os.environ.get("PIPELINE_EXTRACT_INTERVAL_S", "60"))
TRANSFORM_INTERVAL_S = int(os.environ.get("PIPELINE_TRANSFORM_INTERVAL_S", "60"))
GOLD_WINDOW_DAYS = int(os.environ.get("PIPELINE_GOLD_WINDOW_DAYS", "120"))
RUN_ON_START = os.environ.get("PIPELINE_RUN_ON_START", "1") == "1"

_last: dict = {"extract": None, "transform": None, "error": None}


def run_extract(full: bool = False) -> dict:
    out: dict = {}
    try:
        out["reference"] = reference.run(TENANTS)
    except Exception as exc:
        logger.exception("reference data failed")
        mark_source_failed("reference_data", TENANTS, exc)
        _last["error"] = f"reference: {exc}"
    try:
        out["core_banking"] = core_banking.run(full=full, tenants=TENANTS)
    except Exception as exc:
        logger.exception("core-banking extract failed")
        mark_source_failed("nexabank_core", TENANTS, exc)
        _last["error"] = f"core_banking: {exc}"
    try:
        record_clickstream_freshness(TENANTS)
    except Exception:
        logger.exception("clickstream freshness failed")
    _last["extract"] = out
    return out


def run_transforms(gold_days: int = GOLD_WINDOW_DAYS) -> dict:
    out: dict = {}
    # KPI path first — it carries every KPI number.
    try:
        out["silver_facts"] = silver_facts.run()
        out["gold_kpi"] = gold_kpi.run(days=gold_days)
    except Exception as exc:
        logger.exception("KPI-path transforms failed")
        _last["error"] = f"kpi transforms: {exc}"
    # Context path — funnel stage detail / journey reconstruction only.
    try:
        out["silver_events"] = silver_events.run()
        out["silver_sessions"] = silver_sessions.run()
        out["gold_funnel"] = gold_funnel.run(days=gold_days)
    except Exception as exc:
        logger.exception("context-path transforms failed")
        _last["error"] = f"context transforms: {exc}"
    _last["transform"] = out
    return out


def run_all(gold_days: int = GOLD_WINDOW_DAYS, full: bool = False) -> dict:
    """One synchronous end-to-end pass. Used by /dev/seed (Phase 3c) and on startup."""
    return {"extract": run_extract(full=full), "transforms": run_transforms(gold_days)}


async def _extract_loop() -> None:
    if RUN_ON_START:
        await asyncio.to_thread(run_extract, True)
    while True:
        await asyncio.sleep(EXTRACT_INTERVAL_S)
        try:
            await asyncio.to_thread(run_extract, False)
        except Exception:
            logger.exception("extract loop iteration failed")


async def _transform_loop() -> None:
    if RUN_ON_START:
        await asyncio.sleep(5)
        await asyncio.to_thread(run_transforms)
    while True:
        await asyncio.sleep(TRANSFORM_INTERVAL_S)
        try:
            await asyncio.to_thread(run_transforms)
        except Exception:
            logger.exception("transform loop iteration failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("pipeline service starting: tenants=%s", TENANTS)
    tasks = [asyncio.create_task(_extract_loop()), asyncio.create_task(_transform_loop())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Pipeline service", lifespan=lifespan)

ENABLE_DEV_SEED = os.environ.get("ENABLE_DEV_SEED", "0") == "1"


@app.get("/health")
async def health():
    return {"status": "ok", "tenants": TENANTS, "dev_seed": ENABLE_DEV_SEED, "last": _last}


class DevSeedRequest(BaseModel):
    """Operator-triggered mock data — never a real customer record. Same shape as the old
    ingestion `/events/seed/fast` (A10): NexaBank's `?mode=fast` re-points here."""
    tenant_id: str = "nexabank"
    users: int = 100
    days: int = 30
    seed: int | None = None
    passes: int = 1
    purge_first: bool = False
    purge_tables: list[str] | None = None
    behavior: dict | None = None
    create_accounts: bool = False


def _require_dev_seed():
    if not ENABLE_DEV_SEED:
        raise HTTPException(status_code=403, detail="dev seed disabled (set ENABLE_DEV_SEED=1)")


@app.post("/refresh")
def refresh(gold_days: int = GOLD_WINDOW_DAYS, full: bool = False) -> dict:
    """Run the whole chain now: extract, then every transform, synchronously.

    The loops already do this on a timer. This is for the moment someone plants a movement in
    NexaBank and wants to see it reach the warehouse without waiting for the next tick.
    """
    try:
        return {"ok": True, **run_all(gold_days=gold_days, full=full)}
    except Exception as exc:                                        # noqa: BLE001
        logger.exception("manual refresh failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/dev/seed")
async def dev_seed(req: DevSeedRequest):
    _require_dev_seed()
    from pipeline.dev import seed as devseed
    try:
        removed = (devseed.purge(req.tenant_id, req.purge_tables) if req.purge_first else {})
        passes = max(1, min(int(req.passes or 1), 10))
        written: dict = {}
        for i in range(passes):
            s = None if req.seed is None else req.seed + i
            one = await asyncio.to_thread(devseed.generate, req.tenant_id, req.users, req.days,
                                          s, req.behavior, req.create_accounts)
            for k, v in one.items():
                if k in ("bronze_core_banking", "bronze_events") and isinstance(v, int):
                    written[k] = written.get(k, 0) + v
                else:
                    written[k] = v
        transforms = await asyncio.to_thread(devseed.run_transforms_for_seed)
        return {"mode": "fast", "tenant_id": req.tenant_id, "written": written,
                "purged": removed, "passes": passes, "transforms": transforms}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("dev seed failed")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/dev/seed/purge")
async def dev_seed_purge(req: DevSeedRequest):
    _require_dev_seed()
    from pipeline.dev import seed as devseed
    try:
        return {"tenant_id": req.tenant_id,
                "purged": await asyncio.to_thread(devseed.purge, req.tenant_id, req.purge_tables)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


if __name__ == "__main__":
    # Allow `python pipeline/service.py` for a one-shot end-to-end run without uvicorn.
    logging.basicConfig(level=logging.INFO)
    import json
    print(json.dumps(run_all(full=True), indent=2, default=str))
