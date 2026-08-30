"""Re-score ONE KPI on demand, instead of waiting for the scheduled sweep to reach it.

The investigation sweep walks every KPI on a 15-minute timer and takes roughly a minute each, so
after planting a movement the finding can be up to an hour away. That is fine for a running system
and useless for a demo: you change the data, ask the agent, and it answers from the finding it
recorded before your change.

This refits the band on history ENDING WHERE THE SCORED WINDOW BEGINS -- the same split
`service.run_investigation_sweep` uses -- and then investigates, so the verdict and the band it was
made against come from one read. Scoring against a band fitted over the movement itself is how a
collapse reads as normal.

    docker compose exec -T analytics-api python scripts/investigate_kpi.py loan_approval_rate

Pass several ids to do several. Exits non-zero if a named KPI has no contract.

`--clear` drops the KPI's stored findings before re-scoring. Needed whenever a metric RECOVERS,
because `insights` is ReplacingMergeTree ORDER BY (tenant_id, persona, kpi_id, anomaly_id): the
recovery writes the same `insight_id` with an empty `anomaly_id`, which is a different sort key, so
it lands BESIDE the anomalous row instead of replacing it. `reader.latest_insight` then ranks
`anomaly_id != '' DESC` ahead of recency and keeps reporting the movement that is over. Clearing
first leaves exactly one row. See docs/DATABASE.md; the sort key itself is the real fix.
"""
from __future__ import annotations

import os
import sys
from datetime import timedelta

# Python puts THIS file's directory on sys.path, not the repo root, so `api` is unimportable when
# the script is run as `python scripts/investigate_kpi.py`. Same fix api/intelligence/service.py uses.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence import config  # noqa: E402
from api.intelligence.contracts import load_all  # noqa: E402
from api.intelligence.metrics import ClickHouseMetricLayer, Window  # noqa: E402
from api.intelligence.orchestrator import Orchestrator  # noqa: E402
from api.intelligence.service import DATASET, current_window  # noqa: E402


def _clear_findings(tenant: str, kpi_id: str) -> None:
    """Drop this KPI's stored findings so the re-score leaves exactly one row.

    Scoped to one KPI and one tenant: the other metrics' findings are what the dashboard is
    showing, and rebuilding them means waiting for a full sweep.
    """
    from api.intelligence import signal_store
    client = signal_store._client() if hasattr(signal_store, "_client") else None
    if client is None:
        from storage.client import ClickHouseClient
        client = ClickHouseClient()._get_client()
    for table in ("insights", "anomalies", "root_causes", "recommendations"):
        column = "kpi_id"
        if table in ("root_causes", "recommendations"):
            # These hang off the anomaly, so clear them by the anomalies this KPI owns.
            client.command(
                f"ALTER TABLE feature_intelligence.{table} DELETE WHERE anomaly_id IN "
                f"(SELECT anomaly_id FROM feature_intelligence.anomalies "
                f"  WHERE tenant_id = %(t)s AND kpi_id = %(k)s)",
                parameters={"t": tenant, "k": kpi_id}, settings={"mutations_sync": 1})
            continue
        client.command(
            f"ALTER TABLE feature_intelligence.{table} DELETE "
            f"WHERE tenant_id = %(t)s AND {column} = %(k)s",
            parameters={"t": tenant, "k": kpi_id}, settings={"mutations_sync": 1})


def main(argv: list[str]) -> int:
    kpi_ids = [a for a in argv[1:] if not a.startswith("-")]
    tenant = next((a.split("=", 1)[1] for a in argv[1:] if a.startswith("--tenant=")), "nexabank")
    clear = "--clear" in argv[1:]
    if not kpi_ids:
        print(__doc__)
        return 2

    ml = ClickHouseMetricLayer()
    orch = Orchestrator(ml)
    window = current_window()
    history = Window(window.start - timedelta(days=config.BASELINE_DAYS), window.start)
    contracts = load_all(ml, tenant, window)

    missing = [k for k in kpi_ids if k not in contracts]
    if missing:
        print("no contract for: %s" % ", ".join(missing))
        print("available: %s" % ", ".join(sorted(contracts)))
        return 1

    print("tenant=%s  window=%s..%s  history=%s..%s"
          % (tenant, window.start.date(), window.end.date(),
             history.start.date(), history.end.date()))
    for kpi_id in kpi_ids:
        contract = contracts[kpi_id]
        if clear:
            _clear_findings(tenant, kpi_id)
            print("  %-26s cleared stored findings" % kpi_id)
        orch.run_forecast_batch(tenant, {kpi_id: contract}, history, window.start)
        result = orch.investigate(tenant, contract, window, dataset=DATASET)
        anomaly = result.get("anomaly")
        if anomaly:
            print("  %-26s ANOMALY  %-7s observed=%.4f expected=%.4f change=%.4f materiality=%.2f"
                  % (kpi_id, anomaly["severity"], anomaly["observed"], anomaly["baseline"],
                     anomaly["magnitude"], anomaly["materiality"]))
        else:
            trust = result.get("trust") or {}
            verdict = trust.get("verdict") if isinstance(trust, dict) else trust
            print("  %-26s quiet    %s"
                  % (kpi_id, "trust=%s" % verdict if verdict else "inside its expected band"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
