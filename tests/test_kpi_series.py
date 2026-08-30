"""The charted series must read through the Metric Layer, and must not draw a band off its axis.

Two failures this guards:

  * A chart that re-queries. If the line were drawn from a hand-written GROUP BY it would agree
    with the narrative only until either side changed -- and the disagreement would be invisible,
    because both look authoritative.
  * A band on the wrong scale. `kyc_completion_rate` stores a forecast fitted on the additive
    COUNT (point 12.0) while this endpoint returns the RATE (0..1). Drawing that band on a [0,1]
    axis is a picture of a metric far below expectation when it is not, and a chart has no way to
    caveat itself.
"""
from datetime import datetime

import pytest

from api.intelligence import series as series_mod


def test_window_is_bounded_at_both_ends():
    """A lower-bound-only window biases every comparison it feeds."""
    w = series_mod._window(30, end=datetime(2026, 8, 30, 13, 45))
    assert (w.end - w.start).days == 30
    assert w.start.hour == 0 and w.start.minute == 0
    assert w.end > w.start
    assert len(w.days()) == 30


def test_a_count_band_is_withheld_from_a_rate_series(monkeypatch):
    """The exact kyc_completion_rate case: band at 12.0, series in [0, 1]."""
    monkeypatch.setattr(series_mod.signal_store if hasattr(series_mod, "signal_store") else series_mod,
                        "__name__", series_mod.__name__, raising=False)

    import api.intelligence.signal_store as store
    monkeypatch.setattr(store, "read_forecast",
                        lambda *a, **k: {"point": 12.0, "lower": 6.18, "upper": 17.81,
                                         "method": "rolling_median", "horizon_days": 7})

    out = series_mod._band("nexabank", "kyc_completion_rate",
                           series_mod._window(30, end=datetime(2026, 8, 30)),
                           values=[0.6, 0.7, 0.5], scored_rate=True)
    assert "forecast" not in out
    assert "not on this axis" in out["forecast_withheld"]


def test_a_rate_band_is_kept_for_a_rate_series(monkeypatch):
    import api.intelligence.signal_store as store
    monkeypatch.setattr(store, "read_forecast",
                        lambda *a, **k: {"point": 0.68, "lower": 0.55, "upper": 0.81,
                                         "method": "rolling_median", "horizon_days": 7})

    out = series_mod._band("nexabank", "kyc_completion_rate",
                           series_mod._window(30, end=datetime(2026, 8, 30)),
                           values=[0.6, 0.7, 0.5], scored_rate=True)
    assert out["forecast"]["point"] == 0.68
    assert out["forecast"]["flat"] is True, "one stored row means one flat band, never a curve"


def test_a_wildly_off_scale_band_is_withheld_for_a_count_series(monkeypatch):
    import api.intelligence.signal_store as store
    monkeypatch.setattr(store, "read_forecast",
                        lambda *a, **k: {"point": 5_000_000.0, "lower": 0.0, "upper": 9_000_000.0,
                                         "method": "rolling_median", "horizon_days": 7})

    out = series_mod._band("nexabank", "loan_approval_volume",
                           series_mod._window(30, end=datetime(2026, 8, 30)),
                           values=[4.0, 15.0, 6.0], scored_rate=False)
    assert "forecast" not in out
    assert out["forecast_withheld"]


def test_a_missing_forecast_row_is_not_an_error(monkeypatch):
    import api.intelligence.signal_store as store
    monkeypatch.setattr(store, "read_forecast", lambda *a, **k: None)
    out = series_mod._band("nexabank", "fee_revenue",
                           series_mod._window(30, end=datetime(2026, 8, 30)),
                           values=[1.0], scored_rate=False)
    assert out == {}


def test_an_unknown_metric_refuses_rather_than_charting_nothing():
    out = series_mod.kpi_series("nexabank", "not_a_real_metric", days=30)
    assert out["points"] == []
    assert "no declared contract" in out["detail"]


def test_it_reads_through_the_metric_layer_not_raw_sql():
    """CLAUDE.md rule 4: read paths go through the Metric API, never events_raw.

    Scans the parsed module rather than the file text -- the first version of this test matched
    the word "GROUP BY" inside its own docstring explaining why there is no GROUP BY.
    """
    import ast

    tree = ast.parse(open(series_mod.__file__, encoding="utf-8").read())
    # Drop every docstring, then look at what is left: real string literals and real calls.
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if (node.body and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and isinstance(node.body[0].value.value, str)):
                node.body.pop(0)

    literals = [n.value for n in ast.walk(tree)
                if isinstance(n, ast.Constant) and isinstance(n.value, str)]
    for text in literals:
        upper = text.upper()
        assert "SELECT " not in upper and "GROUP BY" not in upper, (
            "series.py builds SQL (%r) -- it must read through the Metric Layer so the chart and "
            "the narrative are computed by the same code" % text[:60])

    names = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    names |= {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert "ch_client" not in names, "series.py must not hold a ClickHouse client of its own"


@pytest.mark.parametrize("kpi_id", ["kyc_completion_rate", "loan_approval_volume"])
def test_the_declared_contract_is_the_source_of_the_unit(kpi_id):
    """`unit` must say whether a rate or its numerator is being plotted -- never guess."""
    from api.intelligence.contracts import load_declared
    contract = load_declared().get(kpi_id)
    assert contract is not None
    # A ratio contract may still fall back to counting; a non-ratio one never reports 'ratio'.
    if not contract.is_ratio:
        out = series_mod.kpi_series("nexabank", kpi_id, days=7)
        if out.get("points"):
            assert out["unit"] == "count"
