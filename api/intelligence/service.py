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
from api.intelligence.contracts import load_all
from api.intelligence.metrics import ClickHouseMetricLayer, Window
from api.metric_api.client import MetricAPIClient
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
            ml = MetricAPIClient()
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
            ml = MetricAPIClient()
            orch = Orchestrator(ml)
            for tenant in TENANTS:
                # Refit the band inside the sweep rather than trusting the hourly batch.
                #
                # The two loops run at different intervals (15 min against 60), so for up to
                # three quarters of an hour an investigation scored against a band fitted on
                # older data. While data was actively arriving that produced a finding which
                # contradicted itself: "it read 0.48, the band runs 0 to 0.01, there is no
                # movement to explain" -- the verdict came from one run and the band from the
                # next. A decision and the band it was made against have to come from the same
                # read, and the only way to guarantee that is to take both here.
                # One pass per offered window. The same movement looks different over a week
                # and over a quarter, and a reader who picks 90 days is owed a finding that was
                # actually scored over 90 days.
                for days in config.WINDOW_CHOICES:
                    results = orch.sweep(tenant, current_window(days), dataset=DATASET,
                                         run_forecast=True)
                    fired = sum(1 for r in results if r.get("anomaly"))
                    logger.info("sweep: tenant=%s window=%dd investigations=%d anomalies=%d",
                                tenant, days, len(results), fired)
        except Exception:
            logger.exception("investigation sweep failed")
        await asyncio.sleep((interval_minutes or config.SWEEP_INTERVAL_MIN) * 60)


# Batch extract + transforms moved to `pipeline/service.py` (plan Phase 3): the pipeline
# service owns bronze/silver/gold and runs its own scheduled extract + transform loops.


async def main() -> None:
    logger.info("intelligence service starting: tenants=%s window=%dd dataset=%s",
                TENANTS, config.WINDOW_DAYS, DATASET)
    await asyncio.gather(
        run_forecast_batch(),
        run_investigation_sweep(),
    )


if __name__ == "__main__":
    asyncio.run(main())
