"""Intelligence service entrypoint (D3): same image, own container, own scheduler.

    docker compose up -d intelligence

Three loops, matching docs/PIPELINE_CONTRACT.md section 2. Each guards every iteration -- an
unhandled exception kills an asyncio task silently and the pipeline would just stop.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import datetime, timedelta

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from api.intelligence import config
from api.intelligence import loaders
from api.intelligence.contracts import load_all
from api.intelligence.metrics import ClickHouseMetricLayer, Window
from api.intelligence.orchestrator import Orchestrator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("intelligence")

TENANTS = config.TENANTS
DATASET = config.DATASET


def current_window(days: int = None) -> Window:
    """Pinned once per sweep, on whole UTC MIDNIGHTS. Never called inside a stage.

    Day-aligned deliberately: daily_feature_usage is day-grain, so a window ending mid-day makes
    the rollup and events_raw disagree about which rows are in scope -- dedup_integrity would
    then compare counts drawn from different row sets.
    """
    days = config.WINDOW_DAYS if days is None else days
    end = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return Window(end - timedelta(days=days), end)


async def run_forecast_batch(interval_minutes: int = None) -> None:
    """Stage 04, ahead of Detect. History ends where the scored window begins."""
    while True:
        try:
            ml = ClickHouseMetricLayer()
            orch = Orchestrator(ml)
            for tenant in TENANTS:
                win = current_window()
                hist = Window(win.start - timedelta(days=config.BASELINE_DAYS), win.start)
                contracts = load_all(ml, tenant, win)
                n = orch.run_forecast_batch(tenant, contracts, hist, win.start)
                logger.info("forecast batch: tenant=%s bands=%d", tenant, n)
        except Exception:
            logger.exception("forecast batch failed")
        await asyncio.sleep((interval_minutes or config.FORECAST_INTERVAL_MIN) * 60)


async def run_investigation_sweep(interval_minutes: int = None) -> None:
    """Stages 01-07 per KPI."""
    while True:
        try:
            ml = ClickHouseMetricLayer()
            orch = Orchestrator(ml)
            for tenant in TENANTS:
                results = orch.sweep(tenant, current_window(), dataset=DATASET,
                                     run_forecast=False)
                fired = sum(1 for r in results if r.get("anomaly"))
                logger.info("sweep: tenant=%s investigations=%d anomalies=%d",
                            tenant, len(results), fired)
        except Exception:
            logger.exception("investigation sweep failed")
        await asyncio.sleep((interval_minutes or config.SWEEP_INTERVAL_MIN) * 60)


async def run_batch_loaders(interval_minutes: int = None) -> None:
    """Sources 2 and 3. Idempotent, so a retry after a partial failure is safe."""
    while True:
        # One try per source. Sharing a block meant a core-banking failure aborted CRM and
        # market_ops too, and none of the three recorded that anything had gone wrong.
        for source_id, label, run in (
            ("nexabank_core", "core banking", lambda: loaders.load_core_banking()),
            ("nexabank_crm", "crm", lambda: loaders.load_crm()),
            ("market_ops", "market ops", lambda: loaders.load_market_ops(TENANTS)),
        ):
            try:
                logger.info("%s batch: %s", label, run())
            except Exception as exc:
                logger.exception("%s batch failed", label)
                loaders.mark_source_failed(source_id, TENANTS, exc)
        try:
            loaders.record_clickstream_freshness(TENANTS)
        except Exception as exc:
            logger.exception("clickstream freshness failed")
            loaders.mark_source_failed("nexabank_clickstream", TENANTS, exc)
        try:
            # Reference data is weekly, but re-seeding is a no-op, so it rides the same loop.
            loaders.seed_reference_data(TENANTS)
        except Exception as exc:
            logger.exception("reference data seed failed")
            loaders.mark_source_failed("reference_data", TENANTS, exc)
        await asyncio.sleep((interval_minutes or config.BATCH_INTERVAL_MIN) * 60)


async def main() -> None:
    logger.info("intelligence service starting: tenants=%s window=%dd dataset=%s",
                TENANTS, config.WINDOW_DAYS, DATASET)
    await asyncio.gather(
        run_batch_loaders(),
        run_forecast_batch(),
        run_investigation_sweep(),
    )


if __name__ == "__main__":
    asyncio.run(main())
