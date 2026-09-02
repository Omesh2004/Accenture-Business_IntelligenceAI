"""`MetricAPIClient` — an in-process HTTP client for the Metric API that satisfies the
`MetricSource` Protocol, so Track C's stages swap `ClickHouseMetricLayer()` → `MetricAPIClient()`
(plan Phase 4, decision D5). `StubMetricLayer` is unchanged and stays for tests.

**Spec shape.** Post-D1/D2, every KPI number comes from `gold.kpi_daily`, so a fundamental spec
is `{"kpi_id": <one of the 5>, "fundamental": <name>}` (+ optional `dims`). Track C's rewritten
`contracts/*.yaml` produce that shape. The old clickstream `{"event": ...}` / `{"events": [...]}`
form is not supported here — those KPIs no longer exist.

Methods that were clickstream-session concepts (`resolve_event_names`, `dimension_invariance`,
`tenant_volume`, `simulated_keys`) are not meaningful for snapshot-sourced KPIs; they return
inert values so a stage that still calls them does not crash.
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime

from api.intelligence.metrics import Series, Window

BASE_URL = os.environ.get("METRIC_API_URL", "http://analytics-api:8001")
TIMEOUT_S = int(os.environ.get("METRIC_API_TIMEOUT_S", "30"))


def _get(path: str, params: dict) -> dict:
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(f"{BASE_URL}{path}?{qs}", method="GET")
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _win(window: Window) -> dict:
    return {"start": window.start.date().isoformat(), "end": window.end.date().isoformat()}


class MetricAPIClient:
    """Implements `MetricSource` by calling the Metric API HTTP endpoints."""

    # -- name resolution (clickstream concept — inert for snapshot KPIs) ----
    def resolve_event_names(self, tenant_id, canonical, window):
        return [canonical]

    # -- fundamentals -----------------------------------------------------------
    def fundamental_total(self, tenant_id, spec, window) -> float:
        d = _get("/metric/kpi/total", {"tenant": tenant_id, "kpi_id": spec["kpi_id"], **_win(window)})
        return float(d["fundamentals"].get(spec["fundamental"], 0.0))

    def fundamental_series(self, tenant_id, spec, window) -> Series:
        d = _get("/metric/kpi/series", {"tenant": tenant_id, "kpi_id": spec["kpi_id"], **_win(window)})
        vals = d["fundamentals"].get(spec["fundamental"], [])
        return Series(kpi_id=spec.get("metric", spec["fundamental"]),
                      points={day: float(v) for day, v in zip(d["dates"], vals)})

    def fundamental_by_cell(self, tenant_id, spec, dims, window, min_volume=0) -> dict:
        d = _get("/metric/kpi/by_dim", {
            "tenant": tenant_id, "kpi_id": spec["kpi_id"], "fundamental": spec["fundamental"],
            "dims": ",".join(dims), "min_volume": min_volume, **_win(window)})
        out: dict[tuple, float] = {}
        for dim, block in d.get("by_dim", {}).items():
            for value_key, v in block.get("cells", {}).items():
                out[(value_key,)] = float(v)
        return out

    def leaf_cells(self, tenant_id, spec, window, baseline, min_volume=0):
        """Multi-dimensional leaves: (dims, {cell_tuple: (value, baseline)}). For PSqueeze."""
        d = _get("/metric/kpi/cells", {
            "tenant": tenant_id, "kpi_id": spec["kpi_id"], "fundamental": spec["fundamental"],
            "baseline_start": baseline.start.date().isoformat(),
            "baseline_end": baseline.end.date().isoformat(),
            "min_volume": min_volume, **_win(window)})
        rows = d.get("cells", [])
        if not rows:
            return [], {}
        dims = list(rows[0].get("dims") or [])
        out = {}
        for r in rows:
            if list(r.get("dims") or []) != dims:
                continue
            out[tuple(r.get("vals") or [])] = (float(r["value"]), float(r["baseline"]))
        return dims, out

    def cell_deltas(self, tenant_id, spec, dims, window, baseline, min_volume=0) -> dict:
        d = _get("/metric/kpi/cell_deltas", {
            "tenant": tenant_id, "kpi_id": spec["kpi_id"], "fundamental": spec["fundamental"],
            "dims": ",".join(dims), "min_volume": min_volume,
            "start": window.start.date().isoformat(), "end": window.end.date().isoformat(),
            "baseline_start": baseline.start.date().isoformat(),
            "baseline_end": baseline.end.date().isoformat()})
        out: dict[tuple, tuple[float, float]] = {}
        for dim, block in d.get("cell_deltas", {}).items():
            for value_key, (cur, base) in block.items():
                out[(value_key,)] = (float(cur), float(base))
        return out

    def dedup_counts(self, tenant_id, spec, window) -> tuple[int, int]:
        d = _get("/metric/dedup_counts", {"tenant": tenant_id, "kpi_id": spec["kpi_id"], **_win(window)})
        return int(d["rows_as_inserted"]), int(d["distinct_ids"])

    def freshness_minutes(self, tenant_id, window, source_ids=None) -> float | None:
        # The oldest common data time across the KPI's OWN sources. Taking the max over every
        # source in the tenant let one never-loaded feed mark every KPI stale.
        d = _get("/metric/freshness", {"tenant": tenant_id})
        rows = d.get("sources", [])
        if source_ids:
            wanted = set(source_ids)
            rows = [s for s in rows if s.get("source_id") in wanted]
        behinds = [s["minutes_behind"] for s in rows if s.get("minutes_behind") is not None]
        return max(behinds) if behinds else None

    def dimension_invariance(self, tenant_id, key, window) -> float:
        return 1.0  # fact columns are measured, not session-rolled — invariance is 1.0 by construction

    def dimension_cardinality(self, tenant_id, key, window, spec=None) -> int:
        if not spec or "kpi_id" not in spec:
            return 2
        d = _get("/metric/dimensions", {"tenant": tenant_id, "kpi_id": spec["kpi_id"], **_win(window)})
        return int(d.get("dimensions", {}).get(key, {}).get("cardinality", 0))

    def tenant_volume(self, tenant_id, window) -> float:
        return 0.0

    def simulated_keys(self, tenant_id, window) -> set[str]:
        return set()

    def watermark(self, tenant_id) -> datetime | None:
        d = _get("/metric/watermark", {"tenant": tenant_id})
        stamps = [datetime.fromisoformat(v) for v in d.get("watermarks", {}).values() if v]
        return max(stamps) if stamps else None
