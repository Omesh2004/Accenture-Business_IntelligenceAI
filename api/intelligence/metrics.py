"""Metric Layer -- the only doorway the intelligence layer reads data through.

Stages never touch events_raw (CLAUDE.md rule 4). They ask for fundamentals at a declared grain.
Every aggregate is exact: uniqExact, sum, min -- never uniq, quantile, topK or any (rule 12).
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Protocol

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from api.intelligence import config  # noqa: E402
from pipeline.taxonomy import canonicalize as canonicalize_event_name  # noqa: E402


# `channel` is a top-level events_raw column; reading it from metadata returns '' on every row.
COLUMN_DIMENSIONS = {"channel", "event_name", "user_id", "session_id", "tenant_id"}

# Bounds the per-instance name cache so a long-lived service cannot grow without limit.
_NAME_CACHE_MAX = 64


def dimension_expr(key: str) -> str:
    """SQL for a dimension. Column if it is one, JSON extraction otherwise."""
    return key if key in COLUMN_DIMENSIONS else f"JSONExtractString(metadata, '{key}')"


@dataclass(frozen=True)
class Window:
    """Half-open [start, end). Pinned once by the orchestrator, never recomputed in a stage."""
    start: datetime
    end: datetime

    def params(self) -> dict:
        return {"w_start": self.start, "w_end": self.end}

    def days(self) -> list[date]:
        """Every UTC day the window touches, so a series can be gap-filled."""
        out, cur = [], self.start.date()
        last = (self.end - timedelta(microseconds=1)).date()
        while cur <= last:
            out.append(cur)
            cur += timedelta(days=1)
        return out


@dataclass
class Series:
    """Daily values, gap-filled. Missing days MUST be zeros: a compacted list silently shifts
    seasonal_naive's lag and makes the forecast compare the wrong weekday."""
    kpi_id: str
    points: dict[str, float] = field(default_factory=dict)

    def values(self) -> list[float]:
        return [self.points[d] for d in sorted(self.points)]

    def dates(self) -> list[str]:
        return sorted(self.points)


def ratio_series(metric_layer, tenant_id: str, contract, window: Window) -> Series | None:
    """Daily rate for a ratio contract, or None when it has no usable denominator.

    Detect scored the NUMERATOR for every ratio KPI, so a conversion rate that halved while
    volume grew read as an urgent rise. The rate is the quantity the contract names, so it is
    the quantity scored. Localize still works on the additive fundamentals -- a rate cannot be
    decomposed across cells (docs/KPI_CONTRACT.md).

    A module function rather than a MetricSource method so the stub layer needs no change.
    """
    num_spec, den_spec = contract.numerator(), contract.denominator()
    if not num_spec or not den_spec:
        return None
    num = metric_layer.fundamental_series(tenant_id, num_spec, window)
    den = metric_layer.fundamental_series(tenant_id, den_spec, window)
    known = {d: num.points.get(d, 0.0) / den.points[d]
             for d in den.points if den.points[d] > 0}
    if not known:
        return None
    # A day with no denominator has an UNDEFINED rate, not a zero one. Filling it with zero
    # manufactures the collapse this function exists to detect, so it takes the median of the
    # days that do have one -- neutral, and it keeps seasonal_naive's lag aligned.
    filler = sorted(known.values())[len(known) // 2]
    points = {d: round(known.get(d, filler), config.ROUND_DP) for d in sorted(den.points)}
    return Series(kpi_id=str(contract.id), points=points)


class MetricSource(Protocol):
    """Implemented by ClickHouseMetricLayer (live) and StubMetricLayer (tests)."""

    def resolve_event_names(self, tenant_id: str, canonical: str, window: Window) -> list[str]: ...
    def fundamental_total(self, tenant_id: str, spec: dict, window: Window) -> float: ...
    def fundamental_series(self, tenant_id: str, spec: dict, window: Window) -> Series: ...
    def fundamental_by_cell(self, tenant_id: str, spec: dict, dims: list[str],
                            window: Window, min_volume: int) -> dict[tuple, float]: ...
    def dedup_counts(self, tenant_id: str, spec: dict, window: Window) -> tuple[int, int]: ...
    def freshness_minutes(self, tenant_id: str, window: Window,
                          source_ids: list[str] | None = None) -> float | None: ...
    def dimension_invariance(self, tenant_id: str, key: str, window: Window) -> float: ...
    def dimension_cardinality(self, tenant_id: str, key: str, window: Window,
                             spec: dict | None = None) -> int: ...
    def tenant_volume(self, tenant_id: str, window: Window) -> float: ...
    def simulated_keys(self, tenant_id: str, window: Window) -> set[str]: ...
    def watermark(self, tenant_id: str) -> datetime | None: ...


from api.metric_api.client import MetricAPIClient  # noqa: E402

# ClickHouseMetricLayer's dead-table SQL (events_raw / feature_intelligence) was removed in the
# Round-2 rebuild. Every KPI number now comes from gold.kpi_daily via the Metric API. The name
# is kept as an alias so Track C call sites keep importing it until they repoint to
# MetricAPIClient directly.
ClickHouseMetricLayer = MetricAPIClient


def _events_of(spec: dict) -> list[str]:
    return list(spec.get("events") or ([spec["event"]] if spec.get("event") else []))


class StubMetricLayer:
    """Known numbers, no ClickHouse. Every stage is built and tested against this first."""

    def __init__(self, series=None, cells=None, dedup=(100, 100), freshness=1.0,
                 invariance=None, volume=1000.0, simulated=None):
        self.series = series or {}
        self.cells = cells or {}
        self.dedup = dedup
        self.freshness = freshness
        self.invariance = invariance or {}
        self.volume = volume
        self.simulated = simulated or set()

    @staticmethod
    def _key(spec: dict) -> str:
        return str(spec.get("metric", ""))

    def resolve_event_names(self, tenant_id, canonical, window):
        return [canonical]

    def fundamental_total(self, tenant_id, spec, window):
        return float(sum(self.series.get(self._key(spec), {}).values()))

    def fundamental_series(self, tenant_id, spec, window):
        return Series(kpi_id=self._key(spec), points=dict(self.series.get(self._key(spec), {})))

    def fundamental_by_cell(self, tenant_id, spec, dims, window, min_volume=0):
        return {k: v for k, v in self.cells.get(self._key(spec), {}).items() if v >= min_volume}

    def cell_deltas(self, tenant_id, spec, dims, window, baseline, min_volume=0):
        # Composed from fundamental_by_cell so a test that stubs that method still drives this.
        cur = self.fundamental_by_cell(tenant_id, spec, dims, window, min_volume)
        base = self.fundamental_by_cell(tenant_id, spec, dims, baseline, min_volume)
        return {k: (cur.get(k, 0.0), base.get(k, 0.0)) for k in set(cur) | set(base)}

    def dedup_counts(self, tenant_id, spec, window):
        return self.dedup

    def freshness_minutes(self, tenant_id, window, source_ids=None):
        return self.freshness

    def dimension_invariance(self, tenant_id, key, window):
        return self.invariance.get(key, 1.0)

    def dimension_cardinality(self, tenant_id, key, window, spec=None):
        return getattr(self, "cardinality", {}).get(key, 2)

    def tenant_volume(self, tenant_id, window):
        return self.volume

    def watermark(self, tenant_id):
        return None

    def simulated_keys(self, tenant_id, window):
        return set(self.simulated)
