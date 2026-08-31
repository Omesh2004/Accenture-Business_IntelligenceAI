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
from api.page_map import canonicalize_event_name  # noqa: E402

DB = "feature_intelligence"

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
    def freshness_minutes(self, tenant_id: str, window: Window) -> float | None: ...
    def dimension_invariance(self, tenant_id: str, key: str, window: Window) -> float: ...
    def dimension_cardinality(self, tenant_id: str, key: str, window: Window,
                             spec: dict | None = None) -> int: ...
    def tenant_volume(self, tenant_id: str, window: Window) -> float: ...
    def simulated_keys(self, tenant_id: str, window: Window) -> set[str]: ...
    def watermark(self, tenant_id: str) -> datetime | None: ...


class ClickHouseMetricLayer:
    def __init__(self, client=None):
        # Lazy import so the stub -- and every stage test built on it -- needs no driver.
        if client is None:
            from warehouse.client import ch_client
            client = ch_client
        self.client = client
        self._name_cache: dict[tuple[str, str], list[str]] = {}
        from api.intelligence.facts import FactReader
        self.facts = FactReader(client)

    # -- name resolution ----------------------------------------------------
    def resolve_event_names(self, tenant_id: str, canonical: str, window: Window) -> list[str]:
        """Stored raw names that canonicalize to `canonical`.

        Contracts name canonical events; events_raw stores the ingest-dialect name. Resolving
        here keeps the layer precise without renaming the platform's vocabulary (decision D2).
        """
        key = (tenant_id, f"{window.start}|{window.end}")
        if key not in self._name_cache:
            if len(self._name_cache) >= _NAME_CACHE_MAX:
                self._name_cache.clear()
            rows = self.client.query(
                f"SELECT DISTINCT event_name FROM {DB}.events_raw WHERE tenant_id = %(tenant_id)s "
                "AND timestamp >= %(w_start)s AND timestamp < %(w_end)s",
                {"tenant_id": tenant_id, **window.params()},
            )
            self._name_cache[key] = [str(r["event_name"]) for r in rows]
        target = (canonical or "").strip().lower()
        matches = {n for n in self._name_cache[key] if canonicalize_event_name(n) == target}
        matches.add(canonical)
        return sorted(matches)

    def _event_filter(self, tenant_id: str, spec: dict, window: Window) -> tuple[str, dict]:
        names: set[str] = set()
        for ev in _events_of(spec):
            names.update(self.resolve_event_names(tenant_id, ev, window))
        params = {"tenant_id": tenant_id, "names": tuple(sorted(names)) or ("",),
                  **window.params()}
        return ("tenant_id = %(tenant_id)s AND event_name IN %(names)s "
                "AND timestamp >= %(w_start)s AND timestamp < %(w_end)s"), params

    @staticmethod
    def _agg(spec: dict) -> str:
        agg = str(spec.get("aggregation", "uniqExact(event_id)"))
        return "uniqExact(session_id)" if "session_id" in agg else "uniqExact(event_id)"

    # -- reads --------------------------------------------------------------
    def fundamental_total(self, tenant_id: str, spec: dict, window: Window) -> float:
        if spec.get("table"):
            return self.facts.total(tenant_id, spec, window)
        where, params = self._event_filter(tenant_id, spec, window)
        rows = self.client.query(
            f"SELECT {self._agg(spec)} AS v FROM {DB}.events_raw WHERE {where}", params)
        return float(rows[0]["v"]) if rows else 0.0

    def fundamental_series(self, tenant_id: str, spec: dict, window: Window) -> Series:
        if spec.get("table"):
            return self.facts.series(tenant_id, spec, window)
        where, params = self._event_filter(tenant_id, spec, window)
        rows = self.client.query(
            f"SELECT toDate(timestamp) AS d, {self._agg(spec)} AS v "
            f"FROM {DB}.events_raw WHERE {where} GROUP BY d ORDER BY d", params)
        found = {str(r["d"]): float(r["v"]) for r in rows}
        # Gap-fill: a day with no events is a real zero, not an absent point.
        points = {d.isoformat(): found.get(d.isoformat(), 0.0) for d in window.days()}
        return Series(kpi_id=str(spec.get("metric", "")), points=points)

    def fundamental_by_cell(self, tenant_id: str, spec: dict, dims: list[str], window: Window,
                            min_volume: int = 0) -> dict[tuple, float]:
        if not dims:
            return {}
        if spec.get("table"):
            return self.facts.by_cell(tenant_id, spec, dims, window, min_volume)
        where, params = self._event_filter(tenant_id, spec, window)
        selects = ", ".join(f"{dimension_expr(d)} AS d{i}" for i, d in enumerate(dims))
        groups = ", ".join(f"d{i}" for i in range(len(dims)))
        rows = self.client.query(
            f"SELECT {selects}, {self._agg(spec)} AS v FROM {DB}.events_raw WHERE {where} "
            f"GROUP BY {groups} HAVING v >= {int(min_volume)} ORDER BY v DESC, {groups} ASC",
            params)
        out: dict[tuple, float] = {}
        for r in rows:
            cell = tuple(str(r[f"d{i}"]) for i in range(len(dims)))
            # A missing metadata key reads as '' -- never a legitimate cell.
            if any(c == "" for c in cell):
                continue
            out[cell] = float(r["v"])
        return out

    def cell_deltas(self, tenant_id: str, spec: dict, dims: list[str], window: Window,
                    baseline: Window, min_volume: int = 0) -> dict[tuple, tuple[float, float]]:
        """{cell: (current, baseline)} in ONE query.

        Localize used two queries per dimension combination; at depth 2 over five dimensions
        that is thirty round trips per anomaly. Conditional aggregation over the union of both
        windows halves them, and stays exact for uniqExact because each side aggregates
        independently rather than being rolled up.
        """
        if not dims:
            return {}
        if spec.get("table"):
            return self.facts.cell_deltas(tenant_id, spec, dims, window, baseline, min_volume)

        span = Window(min(window.start, baseline.start), max(window.end, baseline.end))
        names: set[str] = set()
        for ev in _events_of(spec):
            names.update(self.resolve_event_names(tenant_id, ev, span))
        params = {"tenant_id": tenant_id, "names": tuple(sorted(names)) or ("",),
                  "c_start": window.start, "c_end": window.end,
                  "b_start": baseline.start, "b_end": baseline.end,
                  "s_start": span.start, "s_end": span.end}
        agg = self._agg(spec)
        inner = agg[agg.index("(") + 1:-1]
        selects = ", ".join(f"{dimension_expr(d)} AS d{i}" for i, d in enumerate(dims))
        groups = ", ".join(f"d{i}" for i in range(len(dims)))
        rows = self.client.query(
            f"SELECT {selects}, "
            f"uniqExactIf({inner}, timestamp >= %(c_start)s AND timestamp < %(c_end)s) AS cur, "
            f"uniqExactIf({inner}, timestamp >= %(b_start)s AND timestamp < %(b_end)s) AS base "
            f"FROM {DB}.events_raw WHERE tenant_id = %(tenant_id)s AND event_name IN %(names)s "
            "AND timestamp >= %(s_start)s AND timestamp < %(s_end)s "
            f"GROUP BY {groups} HAVING cur >= {int(min_volume)} OR base >= {int(min_volume)} "
            f"ORDER BY {groups} ASC", params)
        out: dict[tuple, tuple[float, float]] = {}
        for r in rows:
            cell = tuple(str(r[f"d{i}"]) for i in range(len(dims)))
            if any(c == "" for c in cell):
                continue
            out[cell] = (float(r["cur"] or 0), float(r["base"] or 0))
        return out

    def dedup_counts(self, tenant_id: str, spec: dict, window: Window) -> tuple[int, int]:
        """(raw_rows, distinct_event_ids) from the rollup.

        The MV fires on the inserted block, so raw_rows survives the ReplacingMergeTree merges
        that erase duplicates from events_raw -- which is what makes a replay detectable (D1).
        The rollup is day-grain, so this is only exact for day-aligned windows.

        Fact tables dedupe at the storage layer instead, so the replay signal does not apply.
        """
        if spec.get("table"):
            return 0, 0
        params = {"tenant_id": tenant_id,
                  "names": tuple(sorted(_events_of(spec))) or ("",),
                  "d_start": window.start.date(),
                  "d_end": (window.end - timedelta(microseconds=1)).date()}
        rows = self.client.query(
            f"SELECT sumMerge(raw_rows) AS raw, uniqExactMerge(event_count) AS uniq "
            f"FROM {DB}.daily_feature_usage WHERE tenant_id = %(tenant_id)s "
            "AND event_name IN %(names)s AND date >= %(d_start)s AND date <= %(d_end)s", params)
        if not rows:
            return 0, 0
        return int(rows[0]["raw"] or 0), int(rows[0]["uniq"] or 0)

    def freshness_minutes(self, tenant_id: str, window: Window) -> float | None:
        """Minutes between the newest event in the window and the window end.

        Event time, not ingest time: ingest time is 'just now' for a backdated fixture and
        'never' for a stalled forwarder. The question is whether the window reaches its own end.
        """
        rows = self.client.query(
            f"SELECT max(timestamp) AS m FROM {DB}.events_raw WHERE tenant_id = %(tenant_id)s "
            "AND timestamp >= %(w_start)s AND timestamp < %(w_end)s",
            {"tenant_id": tenant_id, **window.params()})
        if not rows or not rows[0]["m"]:
            return None
        return max(0.0, (window.end - rows[0]["m"]).total_seconds() / 60.0)

    def dimension_invariance(self, tenant_id: str, key: str, window: Window) -> float:
        """Share of sessions seeing exactly one value of `key`. 1.0 == fully invariant."""
        rows = self.client.query(
            f"SELECT countIf(vals = 1) AS ok, count() AS total FROM ("
            f"  SELECT session_id, uniqExact({dimension_expr(key)}) AS vals FROM {DB}.events_raw "
            "   WHERE tenant_id = %(tenant_id)s AND session_id != '' "
            "     AND timestamp >= %(w_start)s AND timestamp < %(w_end)s GROUP BY session_id)",
            {"tenant_id": tenant_id, **window.params()})
        if not rows or not rows[0]["total"]:
            return 0.0
        return float(rows[0]["ok"]) / float(rows[0]["total"])

    def dimension_cardinality(self, tenant_id: str, key: str, window: Window,
                              spec: dict | None = None) -> int:
        """Distinct values of `key` in the window. Fewer than two means it cannot explain
        anything: every cell would be the whole total."""
        if spec and spec.get("table"):
            return self.facts.dimension_cardinality(tenant_id, key, window, spec)
        rows = self.client.query(
            f"SELECT uniqExact({dimension_expr(key)}) AS n FROM {DB}.events_raw "
            "WHERE tenant_id = %(tenant_id)s AND timestamp >= %(w_start)s "
            "AND timestamp < %(w_end)s", {"tenant_id": tenant_id, **window.params()})
        return int(rows[0]["n"]) if rows else 0

    def tenant_volume(self, tenant_id: str, window: Window) -> float:
        """All events for the tenant in the window -- the denominator for Detect's reach."""
        rows = self.client.query(
            f"SELECT uniqExact(event_id) AS v FROM {DB}.events_raw "
            "WHERE tenant_id = %(tenant_id)s AND timestamp >= %(w_start)s "
            "AND timestamp < %(w_end)s", {"tenant_id": tenant_id, **window.params()})
        return float(rows[0]["v"]) if rows else 0.0

    def watermark(self, tenant_id: str) -> datetime | None:
        """Newest ingest time for a tenant.

        Bounded to recent partitions. events_raw is PARTITIONed by month and ORDERed by
        (tenant_id, event_name, timestamp, event_id), so `max(ingested_at)` with only a tenant
        filter prunes nothing and reads the tenant's entire history to answer a question about
        the last few minutes. The bound is on `timestamp` because that is the partition key;
        ingested_at is not, so filtering on it alone would still scan everything.

        Widening fallback rather than a fixed window: a genuinely stale tenant must still report
        its real watermark, since that staleness is exactly what Trust Gate needs to see.
        """
        for days in (2, 32, 400):
            rows = self.client.query(
                f"SELECT max(ingested_at) AS m FROM {DB}.events_raw "
                "WHERE tenant_id = %(tenant_id)s "
                "AND timestamp >= now('UTC') - toIntervalDay(%(days)s)",
                {"tenant_id": tenant_id, "days": days})
            if rows and rows[0]["m"]:
                return rows[0]["m"]
        rows = self.client.query(
            f"SELECT max(ingested_at) AS m FROM {DB}.events_raw WHERE tenant_id = %(tenant_id)s",
            {"tenant_id": tenant_id})
        return rows[0]["m"] if rows and rows[0]["m"] else None

    # -- discovery (Tier 0) -------------------------------------------------
    def discover_events(self, tenant_id: str, window: Window) -> dict[str, int]:
        rows = self.client.query(
            f"SELECT if(length(event_name_canonical) > 0, event_name_canonical, event_name) AS n, "
            f"uniqExact(event_id) AS v FROM {DB}.events_raw WHERE tenant_id = %(tenant_id)s "
            "AND timestamp >= %(w_start)s AND timestamp < %(w_end)s GROUP BY n",
            {"tenant_id": tenant_id, **window.params()})
        out: dict[str, int] = {}
        for r in rows:
            canonical = canonicalize_event_name(str(r["n"])) or str(r["n"])
            out[canonical] = out.get(canonical, 0) + int(r["v"])
        return out

    def discover_metadata_keys(self, tenant_id: str, window: Window,
                               limit: int | None = None) -> list[str]:
        limit = limit or config.TIER0_MAX_METADATA_KEYS
        rows = self.client.query(
            f"SELECT arrayJoin(JSONExtractKeys(metadata)) AS k, count() AS n FROM {DB}.events_raw "
            "WHERE tenant_id = %(tenant_id)s AND timestamp >= %(w_start)s AND timestamp < %(w_end)s "
            f"GROUP BY k ORDER BY n DESC, k ASC LIMIT {int(limit)}",
            {"tenant_id": tenant_id, **window.params()})
        return [str(r["k"]) for r in rows]

    def simulated_keys(self, tenant_id: str, window: Window) -> set[str]:
        """Keys any event declared fabricated via metadata._simulated."""
        rows = self.client.query(
            f"SELECT DISTINCT arrayJoin(JSONExtractArrayRaw(metadata, '_simulated')) AS k "
            f"FROM {DB}.events_raw WHERE tenant_id = %(tenant_id)s "
            "AND JSONHas(metadata, '_simulated') AND timestamp >= %(w_start)s "
            "AND timestamp < %(w_end)s", {"tenant_id": tenant_id, **window.params()})
        return {str(r["k"]).strip('"') for r in rows}


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

    def freshness_minutes(self, tenant_id, window):
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
