"""KPI contract loader: Tier 1 declared YAML, Tier 0 discovered. docs/KPI_CONTRACT.md."""
from __future__ import annotations

import glob
import os
from dataclasses import dataclass, field
from typing import Any

import yaml

from api.intelligence import config

CONTRACT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "contracts"
)

PLATFORM_DETECTION_DEFAULTS = {
    "direction": "both",
    "band_source": "forecast",
    "warn_pct_change": 10,
    "critical_pct_change": 20,
    "min_persistence_windows": 2,
    "min_denominator": 30,
    "robust_scorer": "mad",
    "multiple_testing": "benjamini_hochberg",
    "sparse_history_policy": "abstain_with_interval",
}


@dataclass
class Contract:
    id: str
    tier: int
    raw: dict[str, Any] = field(default_factory=dict)

    # -- shape helpers ------------------------------------------------------
    @property
    def name(self) -> str:
        return self.raw.get("name", self.id)

    @property
    def grain_entity(self) -> str:
        return (self.raw.get("grain") or {}).get("entity", "event")

    @property
    def readiness_status(self) -> str:
        return (self.raw.get("readiness") or {}).get("status", "ready")

    @property
    def fundamentals(self) -> list[dict]:
        return self.raw.get("fundamentals") or []

    @property
    def is_ratio(self) -> bool:
        return len([f for f in self.fundamentals if f.get("event") or f.get("events")]) >= 2 \
            and (self.raw.get("unit") == "ratio")

    def numerator(self) -> dict | None:
        f = [x for x in self.fundamentals if x.get("event") or x.get("events")]
        return f[0] if f else None

    def denominator(self) -> dict | None:
        f = [x for x in self.fundamentals if x.get("event") or x.get("events")]
        return f[1] if len(f) > 1 else None

    @property
    def scored_fundamental(self) -> dict:
        """The fundamental Detect actually scores -- a rate is never scored on itself.

        Read by the orchestrator AND by the phrasing layer, so what the prose calls the number is
        the same thing the number was measured from. They drifted: a numerator count was narrated
        as the ratio, so 97 digital transactions a day read as a 97% adoption rate.
        """
        return self.numerator() or (self.fundamentals[0] if self.fundamentals else {})

    @property
    def detection(self) -> dict:
        return {**PLATFORM_DETECTION_DEFAULTS, **(self.raw.get("detection") or {})}

    @property
    def forecast_cfg(self) -> dict:
        return self.raw.get("forecast") or {"enabled": True, "baseline": "seasonal_naive",
                                            "fallback": "rolling_median", "min_history_days": 14,
                                            "horizon_days": 7}

    @property
    def dimensions(self) -> list[str]:
        return list((self.raw.get("dimensions") or {}).get("allowed") or [])

    @property
    def max_depth(self) -> int:
        return int((self.raw.get("dimensions") or {}).get("max_depth", 2))

    @property
    def min_segment_volume(self) -> int:
        return int((self.raw.get("dimensions") or {}).get("min_segment_volume", 10))

    @property
    def hard_invariants(self) -> list[dict]:
        return (self.raw.get("quality") or {}).get("hard_invariants") or []

    @property
    def soft_invariants(self) -> list[dict]:
        return (self.raw.get("quality") or {}).get("soft_invariants") or []

    @property
    def defect_fingerprints(self) -> list[dict]:
        return (self.raw.get("quality") or {}).get("defect_fingerprints") or []

    @property
    def freshness_sla_minutes(self) -> int:
        return int((self.raw.get("quality") or {}).get("freshness_sla_minutes", 60))

    @property
    def provisional_window_minutes(self) -> int:
        return int((self.raw.get("quality") or {}).get("provisional_window_minutes", 0))

    @property
    def allowed_levers(self) -> list[str]:
        return list((self.raw.get("decision") or {}).get("allowed_levers") or ["investigate"])

    @property
    def owner_role(self) -> str:
        return (self.raw.get("decision") or {}).get("owner", "analytics")

    @property
    def causal_cfg(self) -> dict:
        return self.raw.get("causal") or {"enabled": False, "degrade_to": "association"}

    @property
    def governed(self) -> bool:
        """Tier 1 or Tier 0 -- and they are different KINDS of object, not one with fields missing.

        A governed metric has an owner, a closed lever list and a causal model, so "material" can
        mean "warrants a decision". An auto-discovered series has none of those, so the strongest
        thing that can be said about it is "statistically unusual". Scoring the two on one scale
        put `dashboard.page.view` beside `fee_revenue` in a ranked list, which makes the whole
        list unusable. Callers branch on this once, at the boundary -- never per metric.
        """
        return self.tier >= 1

    @property
    def owner(self) -> str:
        return (self.raw.get("decision") or {}).get("owner") or ""

    @property
    def visible_to(self) -> list[str]:
        return list((self.raw.get("access_restriction") or {}).get("visible_to") or [])

    @property
    def simulated(self) -> dict | None:
        return self.raw.get("simulated")

    @property
    def drives(self) -> str | None:
        return (self.raw.get("interconnection") or {}).get("drives")

    @property
    def driven_by(self) -> str | None:
        return (self.raw.get("interconnection") or {}).get("driven_by")

    @property
    def sources(self) -> list[dict]:
        """Declared sources with their own cadence and SLA. Empty means the legacy single
        clickstream source."""
        return list(self.raw.get("sources") or [])

    @property
    def primary_source(self) -> str:
        for src in self.sources:
            if src.get("role") != "corroboration":
                return str(src.get("id", ""))
        return "nexabank_clickstream"

    @property
    def decomposition(self) -> dict:
        return self.raw.get("decomposition") or {}

    @property
    def is_fact_based(self) -> bool:
        return any(f.get("table") for f in self.fundamentals)

    def fabricated_dimensions(self) -> set[str]:
        """Dimensions the contract itself flags as generated on the live path (P0-8)."""
        avail = (self.raw.get("dimensions") or {}).get("availability") or {}
        return {k for k, v in avail.items() if isinstance(v, dict) and v.get("live_fabricated")}


def load_declared(directory: str = CONTRACT_DIR) -> dict[str, Contract]:
    out: dict[str, Contract] = {}
    for path in sorted(glob.glob(os.path.join(directory, "*.yaml"))):
        with open(path, encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
        if not raw.get("id"):
            continue
        out[raw["id"]] = Contract(id=raw["id"], tier=1, raw=raw)
    return out


def discover_tier0(metric_layer, tenant_id: str, window, min_events: int | None = None) -> dict[str, Contract]:
    """Synthesise a conservative contract per canonical event with data.

    Dimensions are admitted only by measurement: a key must be invariant within the grain entity
    AND not declared fabricated. Nothing is guessed; causal and decision are absent by design.
    """
    min_events = config.TIER0_MIN_EVENTS if min_events is None else min_events
    events = metric_layer.discover_events(tenant_id, window)
    keys = metric_layer.discover_metadata_keys(tenant_id, window)
    simulated = metric_layer.simulated_keys(tenant_id, window)

    sliceable: list[str] = []
    for key in keys:
        if key.startswith("_") or key in simulated:
            continue
        if key in config.NON_DIMENSION_KEYS:
            continue
        if metric_layer.dimension_invariance(tenant_id, key, window) >= config.INVARIANCE_FLOOR:
            sliceable.append(key)

    out: dict[str, Contract] = {}
    for event, count in sorted(events.items()):
        if count < min_events:
            continue
        out[event] = Contract(
            id=event,
            tier=0,
            raw={
                "id": event,
                "name": event,
                "unit": "count",
                "additivity": "additive",
                "grain": {"time": "daily", "entity": "event"},
                "readiness": {"status": "ready" if count > 0 else "blocked"},
                "fundamentals": [{
                    "metric": event, "event": event,
                    "aggregation": "uniqExact(event_id)",
                    "additivity": "additive", "engine_type": "sql",
                }],
                "dimensions": {
                    "allowed": sorted(sliceable),
                    "max_depth": 2,
                    "min_segment_volume": 10,
                },
                "quality": {
                    "freshness_sla_minutes": 60,
                    "hard_invariants": [
                        {"id": "dedup_integrity", "expr": "raw_rows == uniqExact(event_id)",
                         "on_fail": "quarantine"}
                    ],
                    "soft_invariants": [],
                },
                "detection": dict(PLATFORM_DETECTION_DEFAULTS),
                "forecast": {"enabled": True, "baseline": "seasonal_naive",
                             "fallback": "rolling_median", "min_history_days": 14,
                             "horizon_days": 7, "interval_required": True},
                # Tier 0 gets the most restrictive access and no causal/decision config.
                "access_restriction": {"visible_to": ["analyst"]},
                "observability": {"verifier_required": True, "engine_type": "sql"},
            },
        )
    return out


def load_all(metric_layer=None, tenant_id: str | None = None, window=None) -> dict[str, Contract]:
    """Tier 0 discovered, then Tier 1 declared overriding by id."""
    contracts: dict[str, Contract] = {}
    if metric_layer is not None and tenant_id and window is not None:
        try:
            contracts.update(discover_tier0(metric_layer, tenant_id, window))
        except Exception:  # discovery must never block a declared contract
            pass
    contracts.update(load_declared())
    return contracts


def validate(contract: Contract, metric_layer=None, tenant_id: str | None = None,
             window=None) -> list[str]:
    """Return a list of problems. Empty means the contract is safe to run."""
    problems: list[str] = []
    if not contract.fundamentals:
        problems.append("no fundamentals declared")
    if contract.is_ratio and contract.denominator() is None:
        problems.append("ratio contract has no denominator")

    fabricated = contract.fabricated_dimensions()
    live_fab = [d for d in contract.dimensions if d in fabricated]
    if live_fab:
        problems.append(f"fabricated dimensions in allowed: {sorted(live_fab)}")

    if metric_layer is not None and tenant_id and window is not None:
        sim = metric_layer.simulated_keys(tenant_id, window)
        leaked = [d for d in contract.dimensions if d in sim]
        if leaked:
            problems.append(f"_simulated dimensions in allowed: {sorted(leaked)}")

        spec = contract.fundamentals[0] if contract.fundamentals else None
        degenerate = []
        for dim in contract.dimensions:
            try:
                if metric_layer.dimension_cardinality(tenant_id, dim, window, spec) < 2:
                    degenerate.append(dim)
            except Exception:
                continue
        if degenerate:
            problems.append(
                f"degenerate dimensions (one distinct value, cannot explain anything): "
                f"{sorted(degenerate)}")
    return problems


def sliceable_dimensions(contract: Contract, metric_layer, tenant_id: str, window,
                         dataset: str = "seeded") -> list[str]:
    """Dimensions Localize may actually search: declared, not fabricated, measurably invariant."""
    fabricated = contract.fabricated_dimensions()
    simulated = metric_layer.simulated_keys(tenant_id, window)
    out = []
    for dim in contract.dimensions:
        if dim in simulated:
            continue
        # A contract-declared fabricated dimension is only admissible on the seeded path,
        # where the value is planted rather than rolled per session.
        if dim in fabricated and dataset != "seeded":
            continue
        # Fact dimensions are physical columns on a fact table: invariance within a session is
        # meaningless for them, and every value is measured rather than synthesised.
        if contract.grain_entity == "session" and not contract.is_fact_based:
            if metric_layer.dimension_invariance(tenant_id, dim, window) < config.INVARIANCE_FLOOR:
                continue
        # A dimension with one value yields one cell at 100% of the movement -- a tautology, not
        # a cause. Skip it rather than publish a confident explanation of nothing.
        try:
            spec = contract.fundamentals[0] if contract.fundamentals else None
            if metric_layer.dimension_cardinality(tenant_id, dim, window, spec) < 2:
                continue
        except Exception:
            # Measurement is best-effort: an unreadable dimension is handled downstream by
            # Localize, and must not take the whole contract out.
            pass
        out.append(dim)
    return out
