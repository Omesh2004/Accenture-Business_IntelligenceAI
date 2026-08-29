"""A dimension that does not vary must never be localized on.

One distinct value means one cell, and that cell necessarily carries 100% of the movement. The
output ranks, states a confident share, and explains nothing -- the same failure as localizing on
a fabricated dimension, reached by a different road.

This is also how an unpopulated schema field becomes an analytics claim: `lifecycleStatus` sat at
ACTIVE for every account, so `active_accounts_opened <= accounts_opened` held trivially and a
`lifecycle_status` breakdown would have reported "ACTIVE explains 100% of the drop".
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence.contracts import Contract, sliceable_dimensions, validate
from api.intelligence.metrics import StubMetricLayer, Window


def contract(dims, **extra) -> Contract:
    raw = {
        "id": "k", "grain": {"entity": "transaction"},
        "fundamentals": [{"metric": "v", "table": "fact_transactions", "measure": "amount",
                          "aggregation": "sum"}],
        "dimensions": {"allowed": list(dims)},
    }
    raw.update(extra)
    return Contract(id="k", tier=1, raw=raw)


def layer(cardinality: dict) -> StubMetricLayer:
    ml = StubMetricLayer()
    ml.cardinality = cardinality
    return ml


WINDOW = Window.__new__(Window)


def test_a_constant_dimension_is_not_sliceable():
    ml = layer({"region": 4, "lifecycle_status": 1})
    dims = sliceable_dimensions(contract(["region", "lifecycle_status"]), ml, "t", WINDOW)
    assert "region" in dims
    assert "lifecycle_status" not in dims, "a single-valued dimension explains nothing"


def test_a_varying_dimension_survives():
    ml = layer({"region": 2})
    assert sliceable_dimensions(contract(["region"]), ml, "t", WINDOW) == ["region"]


def test_zero_cardinality_is_also_rejected():
    """No rows at all is not a reason to report a breakdown either."""
    ml = layer({"region": 0})
    assert sliceable_dimensions(contract(["region"]), ml, "t", WINDOW) == []


def test_validate_reports_degenerate_dimensions():
    ml = layer({"region": 3, "status": 1})
    problems = validate(contract(["region", "status"]), ml, "t", WINDOW)
    assert any("degenerate" in p for p in problems)
    assert any("status" in p for p in problems)


def test_validate_is_quiet_when_every_dimension_varies():
    ml = layer({"region": 3, "channel": 4})
    problems = validate(contract(["region", "channel"]), ml, "t", WINDOW)
    assert not any("degenerate" in p for p in problems)


def test_measurement_failure_does_not_drop_the_dimension():
    """Best-effort: an unreadable dimension is Localize's problem, not a reason to lose the KPI."""
    class Broken(StubMetricLayer):
        def dimension_cardinality(self, *a, **k):
            raise RuntimeError("clickhouse down")

    assert sliceable_dimensions(contract(["region"]), Broken(), "t", WINDOW) == ["region"]


def test_measurement_failure_does_not_fabricate_a_validation_error():
    class Broken(StubMetricLayer):
        def dimension_cardinality(self, *a, **k):
            raise RuntimeError("clickhouse down")

    assert not any("degenerate" in p for p in validate(contract(["region"]), Broken(), "t", WINDOW))
