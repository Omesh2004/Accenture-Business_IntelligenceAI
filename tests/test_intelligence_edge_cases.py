"""Edge cases and integrity invariants. Everything hostile the stages must survive.

No ClickHouse, no LLM. Failures here mean the layer would emit a false or unstable result.
"""
from __future__ import annotations

import math
import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence import config, ids
from api.intelligence.contracts import Contract, sliceable_dimensions, validate
from api.intelligence.metrics import StubMetricLayer, Window, dimension_expr
from api.intelligence.stages import causal_decide, detect, forecast, llm_narrator, localize
from api.intelligence.stages import narrate, trust_gate

W = Window(datetime(2026, 8, 1), datetime(2026, 8, 8))


def contract(**over) -> Contract:
    raw = {
        "id": "kpi", "name": "KPI", "unit": "ratio",
        "grain": {"time": "daily", "entity": "session"},
        "readiness": {"status": "ready"},
        "fundamentals": [
            {"metric": "num", "event": "a.b.success", "aggregation": "uniqExact(session_id)"},
            {"metric": "den", "event": "a.c.success", "aggregation": "uniqExact(session_id)"},
        ],
        "dimensions": {"allowed": ["location", "device_type"], "max_depth": 2,
                       "min_segment_volume": 1},
        "quality": {"freshness_sla_minutes": 60, "soft_invariants": [{"id": "funnel_order"}]},
        "detection": {"min_denominator": 10, "min_persistence_windows": 2,
                      "critical_pct_change": 20, "warn_pct_change": 8, "direction": "down"},
        "forecast": {"enabled": True, "baseline": "seasonal_naive", "min_history_days": 14,
                     "horizon_days": 7},
        "decision": {"owner": "ops", "allowed_levers": ["investigate"]},
        "causal": {"enabled": True, "evidence_rungs": ["association", "attribution"],
                   "degrade_to": "attribution"},
        "access_restriction": {"visible_to": ["cfo", "ops_manager", "analyst"]},
    }
    raw.update(over)
    return Contract(id=raw["id"], tier=1, raw=raw)


class Ctx:
    def __init__(self, c=None, window=W):
        self.investigation_id = "inv"
        self.tenant_id = "t"
        self.kpi_id = "kpi"
        self.contract = c or contract()
        self.window = window
        self.started_at = window.end
        self.dataset = "seeded"


# ===========================================================================
# Window / series integrity
# ===========================================================================
def test_window_days_are_half_open():
    """[start, end) -- the end day must not be included, or day-grain reads double-count it."""
    days = Window(datetime(2026, 8, 1), datetime(2026, 8, 4)).days()
    assert [d.isoformat() for d in days] == ["2026-08-01", "2026-08-02", "2026-08-03"]


def test_window_single_day():
    assert len(Window(datetime(2026, 8, 1), datetime(2026, 8, 2)).days()) == 1


def test_window_zero_length_is_empty():
    assert Window(datetime(2026, 8, 1), datetime(2026, 8, 1)).days() == []


def test_series_gap_would_shift_seasonality():
    """A compacted series makes seasonal_naive read the wrong weekday.

    This is why fundamental_series gap-fills: dropping a zero-volume day silently shifts every
    lag by one, so the forecast compares Monday against Sunday.
    """
    complete = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 99.0]   # same weekday 7 back = 2.0
    gapped = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 99.0]          # one day silently missing
    assert forecast.seasonal_naive(complete, 7) == 2.0
    assert forecast.seasonal_naive(gapped, 7) == 1.0, "the lag shifted -- wrong weekday"


def test_gap_filled_series_preserves_lag():
    """With the zero present, the lag is correct again."""
    filled = [1.0, 2.0, 3.0, 4.0, 5.0, 0.0, 6.0, 99.0]
    assert forecast.seasonal_naive(filled, 7) == 2.0


# ===========================================================================
# Detect
# ===========================================================================
def test_materiality_reach_is_not_pinned_to_one():
    """affected == total pins reach at 1.0 and silently drops it from the product."""
    narrow = detect.materiality(50, 100, 20, 10, 1000, 2, 2)
    wide = detect.materiality(50, 100, 20, 900, 1000, 2, 2)
    assert narrow < wide, "a KPI covering more of the tenant must be more material"


def test_materiality_bounded_in_unit_interval():
    for args in [(0, 100, 20, 1, 1, 0, 2), (1e9, 1, 1, 1, 1, 99, 1), (-5, -100, 20, 5, 10, 2, 2)]:
        assert 0.0 <= detect.materiality(*args) <= 1.0


def test_materiality_zero_baseline_does_not_divide_by_zero():
    assert 0.0 <= detect.materiality(10, 0, 20, 1, 10, 2, 2) <= 1.0


def test_materiality_zero_total_does_not_divide_by_zero():
    assert 0.0 <= detect.materiality(50, 100, 20, 0, 0, 2, 2) <= 1.0


def test_robust_z_flat_history_is_finite():
    """A perfectly flat history has zero spread; the score must not be inf or nan."""
    z = detect.robust_z(50.0, [10.0] * 10)
    assert math.isfinite(z)
    assert detect.robust_z(10.0, [10.0] * 10) == 0.0


def test_robust_z_empty_history():
    assert detect.robust_z(1.0, []) == 0.0


def test_detect_empty_series():
    assert not detect.run(Ctx(), [], None, 10, 100).fired


def test_detect_all_zero_series():
    assert not detect.run(Ctx(), [0.0] * 20, None, 0, 100).fired


def test_detect_single_point():
    assert not detect.run(Ctx(), [5.0], None, 10, 100).fired


def test_detect_negative_values_do_not_crash():
    res = detect.run(Ctx(), [-10.0] * 18 + [-90.0, -95.0], None, 10, 100)
    assert isinstance(res.fired, bool)


def test_benjamini_hochberg_edge_cases():
    assert detect.benjamini_hochberg([]) == []
    assert detect.benjamini_hochberg([0.0]) == [True]
    assert detect.benjamini_hochberg([1.0]) == [False]
    # Monotonic: a kept hypothesis implies every smaller p-value is kept.
    keep = detect.benjamini_hochberg([0.001, 0.002, 0.9])
    assert keep[0] and keep[1] and not keep[2]


def test_severity_thresholds_are_ordered():
    assert detect.severity_for(0.0) == "info"
    assert detect.severity_for(config.SEVERITY_WARN) == "warn"
    assert detect.severity_for(config.SEVERITY_URGENT + 0.01) == "urgent"


# ===========================================================================
# Forecast
# ===========================================================================
def test_forecast_empty_series():
    r = forecast.run("k", [], contract(), W.end, "t")
    assert r.caveat == "insufficient_history"
    assert r.lower <= r.point <= r.upper


def test_forecast_all_zeros_gives_non_degenerate_band():
    r = forecast.run("k", [0.0] * 30, contract(), W.end, "t")
    assert r.upper > r.lower, "a flat series must still produce a usable band"


def test_forecast_constant_series_band_contains_point():
    r = forecast.run("k", [42.0] * 40, contract(), W.end, "t")
    assert r.lower <= r.point <= r.upper


def test_forecast_lower_bound_never_negative_for_counts():
    r = forecast.run("k", [1.0] * 30, contract(), W.end, "t")
    assert r.lower >= 0.0


def test_forecast_unknown_baseline_falls_back():
    c = contract(forecast={"enabled": True, "baseline": "prophet", "min_history_days": 14,
                           "horizon_days": 7})
    r = forecast.run("k", [10.0 + (i % 7) for i in range(30)], c, W.end, "t")
    assert r.method in forecast.METHODS


def test_forecast_is_deterministic_across_repeats():
    values = [100.0 + (i % 7) * 3 for i in range(40)]
    runs = {tuple(vars(forecast.run("k", values, contract(), W.end, "t")).items())
            for _ in range(5)}
    assert len(runs) == 1


def test_backtest_short_series_returns_zero():
    assert forecast.backtest([1.0, 2.0], forecast.seasonal_naive) == 0.0


def test_mad_of_empty_and_single():
    assert forecast.mad([]) == 0.0
    assert forecast.mad([5.0]) == 0.0


# ===========================================================================
# Trust Gate
# ===========================================================================
def test_dedup_equal_counts_pass():
    res = trust_gate.run(Ctx(), StubMetricLayer(dedup=(100, 100), series={"den": {"d": 500}}))
    assert res.verdict == "pass"


def test_dedup_one_extra_row_fails():
    """Off-by-one must fail: a storm of one is still a storm."""
    res = trust_gate.run(Ctx(), StubMetricLayer(dedup=(101, 100), series={"den": {"d": 500}}))
    assert res.verdict == "fail"


def test_dedup_zero_rows_does_not_false_positive():
    res = trust_gate.run(Ctx(), StubMetricLayer(dedup=(0, 0), series={"den": {"d": 500}}))
    assert res.verdict != "fail"


def test_trust_writes_a_row_for_every_check_even_on_pass():
    res = trust_gate.run(Ctx(), StubMetricLayer(dedup=(1, 1), series={"num": {"d": 5},
                                                                     "den": {"d": 500}}))
    assert len(res.findings) >= 4
    assert all(f["investigation_id"] == "inv" for f in res.findings)


def test_trust_finding_ids_are_unique_within_a_run():
    res = trust_gate.run(Ctx(), StubMetricLayer(dedup=(1, 1), series={"den": {"d": 500}}))
    ids_seen = [f["finding_id"] for f in res.findings]
    assert len(ids_seen) == len(set(ids_seen)), "a duplicate id would overwrite a finding"


def test_daily_grain_freshness_floor_prevents_permanent_failure():
    """A 15-minute SLA can never be met by a daily series; the grain sets the floor."""
    c = contract(quality={"freshness_sla_minutes": 15})
    res = trust_gate.run(Ctx(c), StubMetricLayer(dedup=(1, 1), series={"den": {"d": 500}},
                                                 freshness=600.0))
    assert res.verdict == "pass"


def test_hourly_grain_still_honours_a_tight_sla():
    c = contract(grain={"time": "hourly", "entity": "session"},
                 quality={"freshness_sla_minutes": 15})
    res = trust_gate.run(Ctx(c), StubMetricLayer(dedup=(1, 1), series={"den": {"d": 500}},
                                                 freshness=600.0))
    assert res.verdict == "ambiguous"


def test_missing_freshness_data_is_not_a_failure():
    res = trust_gate.run(Ctx(), StubMetricLayer(dedup=(1, 1), series={"den": {"d": 500}},
                                                freshness=None))
    assert res.verdict == "pass"


def test_blocked_contract_short_circuits_before_any_query():
    class Exploding(StubMetricLayer):
        def dedup_counts(self, *a):
            raise AssertionError("must not query a blocked KPI")

    res = trust_gate.run(Ctx(contract(readiness={"status": "blocked"})), Exploding())
    assert res.verdict == "fail" and res.fingerprint == "not_instrumented"


# ===========================================================================
# Localize
# ===========================================================================
def _cells(now, before, totals=None):
    stub = StubMetricLayer()
    stub.fundamental_by_cell = lambda t, s, d, w, m=0: (now if w.start == W.start else before)
    if totals:
        stub.fundamental_total = lambda t, s, w: (totals[0] if w.start == W.start else totals[1])
    return stub


def test_localize_ignores_cells_moving_the_wrong_way():
    stub = _cells({("A",): 200.0, ("B",): 10.0}, {("A",): 100.0, ("B",): 100.0}, (210.0, 200.0))
    res = localize.run(Ctx(), stub, {"anomaly_id": "a", "direction": -1, "magnitude": -90.0},
                       ["location"], Window(W.start - timedelta(days=7), W.start))
    assert all(c["dimensions"] != {"location": "A"} for c in res.causes), \
        "a cell that ROSE cannot explain a fall"


def test_localize_no_movement_is_inconclusive():
    stub = _cells({("A",): 100.0}, {("A",): 100.0}, (100.0, 100.0))
    res = localize.run(Ctx(), stub, {"anomaly_id": "a", "direction": -1, "magnitude": 0.0},
                       ["location"], Window(W.start - timedelta(days=7), W.start))
    assert res.inconclusive


def test_localize_contribution_never_negative():
    stub = _cells({("A",): 10.0}, {("A",): 100.0}, (10.0, 100.0))
    res = localize.run(Ctx(), stub, {"anomaly_id": "a", "direction": -1, "magnitude": -90.0},
                       ["location"], Window(W.start - timedelta(days=7), W.start))
    assert all(c["contribution"] >= 0 for c in res.causes)


def test_localize_ranks_are_dense_and_start_at_one():
    stub = _cells({("A",): 10.0, ("B",): 20.0}, {("A",): 100.0, ("B",): 60.0}, (30.0, 160.0))
    res = localize.run(Ctx(), stub, {"anomaly_id": "a", "direction": -1, "magnitude": -130.0},
                       ["location"], Window(W.start - timedelta(days=7), W.start))
    assert [c["rank"] for c in res.causes] == list(range(1, len(res.causes) + 1))


def test_localize_is_stable_across_repeats():
    """Rank-1 is the most visible output in the system; it must not flip between runs."""
    stub = _cells({("A",): 10.0, ("B",): 10.0}, {("A",): 50.0, ("B",): 50.0}, (20.0, 100.0))
    firsts = set()
    for _ in range(5):
        res = localize.run(Ctx(), stub, {"anomaly_id": "a", "direction": -1, "magnitude": -80.0},
                           ["location"], Window(W.start - timedelta(days=7), W.start))
        firsts.add(tuple(sorted(res.causes[0]["dimensions"].items())) if res.causes else None)
    assert len(firsts) == 1


def test_localize_cause_ids_unique():
    stub = _cells({("A",): 10.0, ("B",): 20.0}, {("A",): 100.0, ("B",): 60.0}, (30.0, 160.0))
    res = localize.run(Ctx(), stub, {"anomaly_id": "a", "direction": -1, "magnitude": -130.0},
                       ["location"], Window(W.start - timedelta(days=7), W.start))
    got = [c["cause_id"] for c in res.causes]
    assert len(got) == len(set(got))


def test_localize_respects_max_causes():
    now = {(f"c{i}",): 1.0 for i in range(20)}
    before = {(f"c{i}",): 100.0 + i for i in range(20)}
    stub = _cells(now, before, (20.0, 2000.0))
    res = localize.run(Ctx(), stub, {"anomaly_id": "a", "direction": -1, "magnitude": -1980.0},
                       ["location"], Window(W.start - timedelta(days=7), W.start))
    assert len(res.causes) <= config.MAX_CAUSES


# ===========================================================================
# Verifier -- the guarantee
# ===========================================================================
def claims(**kv):
    cs = narrate.ClaimSet()
    for k, v in kv.items():
        cs.add(k, v, "count", "anomalies", k)
    return cs


def test_verifier_rejects_derived_arithmetic():
    """The model must not compute. 40 and 100 are claims; their difference is not."""
    ok, bad = narrate.verify("It fell by 60.00 from 100.00 to 40.00.",
                             claims(observed=40.0, baseline=100.0))
    assert not ok and "60.00" in bad


def test_verifier_allows_iso_dates():
    cs = claims(observed=40.0)
    cs.facts["window_start"] = "2026-08-01"
    assert narrate.verify("Between 2026-08-01 and 2026-08-08 it hit 40.00.", cs)[0]


def test_verifier_allows_numbers_inside_facts():
    cs = claims(observed=40.0)
    cs.facts["segment"] = "tier=2, region=7"
    assert narrate.verify("Segment tier=2, region=7 moved to 40.00.", cs)[0]


def test_verifier_does_not_mask_a_real_claim_digit():
    """A fact must not blank out digits belonging to a claim -- that would pass an invention."""
    cs = claims(observed=2026.0)
    cs.facts["window_start"] = "2026-08-01"
    assert narrate.verify("The value was 2026.00.", cs)[0]
    assert not narrate.verify("The value was 9999.00.", cs)[0]


def test_verifier_handles_negative_and_zero():
    assert narrate.verify("Change of -5.00 and 0.00.", claims(a=-5.0, b=0.0))[0]


def test_verifier_empty_draft_passes():
    assert narrate.verify("", claims(a=1.0))[0]


def test_verifier_no_claims_rejects_any_number():
    ok, bad = narrate.verify("Revenue was 12345.00.", narrate.ClaimSet())
    assert not ok and "12345.00" in bad


def test_verifier_tolerance_is_bounded():
    cs = claims(v=100.0)
    assert narrate.verify("100.00", cs)[0]
    assert not narrate.verify("100.50", cs)[0]


# ===========================================================================
# Entitlement
# ===========================================================================
def test_entitlement_denies_unknown_persona_when_restricted():
    c = contract(access_restriction={"visible_to": ["cfo"]})
    _, restricted = narrate.apply_entitlement(claims(a=1.0), c, "intruder")
    assert restricted


def test_entitlement_open_contract_allows_everyone():
    c = contract(access_restriction={})
    for persona in ("cfo", "ops_manager", "analyst", "anything"):
        _, restricted = narrate.apply_entitlement(claims(a=1.0), c, persona)
        assert not restricted


def test_restricted_claim_set_is_structurally_empty():
    """Absent, not redacted -- a restricted number must not be back-computable."""
    c = contract(access_restriction={"visible_to": ["cfo"]})
    cs, restricted = narrate.apply_entitlement(claims(secret=999.0), c, "ops_manager")
    assert restricted and not cs.claims and not cs.facts


# ===========================================================================
# Determinism of ids
# ===========================================================================
def test_ids_stable_across_dict_ordering():
    a = ids.derive_id({"x": 1, "y": 2})
    b = ids.derive_id({"y": 2, "x": 1})
    assert a == b


def test_ids_stable_across_float_noise():
    assert ids.derive_id(0.1 + 0.2) == ids.derive_id(0.3)


def test_ids_distinguish_different_windows():
    assert ids.investigation_id("t", "k", datetime(2026, 8, 1), "s") != \
           ids.investigation_id("t", "k", datetime(2026, 8, 2), "s")


def test_round6_handles_non_numeric():
    assert ids.round6("nonsense") == 0.0
    assert ids.round6(None) == 0.0


# ===========================================================================
# Contract safety
# ===========================================================================
def test_validate_rejects_fabricated_dimension_in_allowed():
    c = contract(dimensions={"allowed": ["location"], "max_depth": 1,
                             "availability": {"location": {"live_fabricated": True}}})
    assert any("fabricated" in p for p in validate(c))


def test_sliceable_excludes_simulated_keys_on_every_dataset():
    c = contract()
    stub = StubMetricLayer(simulated={"location"})
    for dataset in ("seeded", "live"):
        assert "location" not in sliceable_dimensions(c, stub, "t", W, dataset)


def test_sliceable_excludes_session_varying_dimension():
    c = contract()
    stub = StubMetricLayer(invariance={"location": 0.5})
    assert "location" not in sliceable_dimensions(c, stub, "t", W, "seeded")


def test_contract_missing_blocks_degrade_not_crash():
    c = Contract(id="bare", tier=0, raw={"id": "bare"})
    assert c.detection["min_persistence_windows"] >= 1
    assert c.allowed_levers == ["investigate"]
    assert c.visible_to == []
    assert validate(c), "a contract with no fundamentals must be reported as invalid"


def test_dimension_expr_uses_column_for_channel():
    assert dimension_expr("channel") == "channel"
    assert "JSONExtractString" in dimension_expr("location")


# ===========================================================================
# Causal / Decide guardrails
# ===========================================================================
def test_decide_never_invents_a_lever():
    c = contract(decision={"owner": "ops", "allowed_levers": ["only_this"]})
    res = causal_decide.run_decide(
        Ctx(c), {"magnitude": -10.0},
        [{"contribution": 1.0, "dimensions": {"location": "X"}}],
        causal_decide.CausalResult("attribution", "n", -10, -12, -8, "rule", False))
    assert res.lever == "only_this"


def test_decide_impact_interval_is_ordered():
    res = causal_decide.run_decide(Ctx(), {"magnitude": -10.0}, [],
                                   causal_decide.CausalResult("association", "n", 0, 0, 0,
                                                              "rule", False))
    assert res.impact_low <= res.impact_high


def test_causal_interval_contains_point():
    res = causal_decide.run_causal(Ctx(), {"magnitude": -50.0, "baseline": 100.0},
                                   [{"contribution": 0.5, "dimensions": {}}])
    assert res.lower <= res.point <= res.upper


def test_causal_without_causes_is_association():
    res = causal_decide.run_causal(Ctx(), {"magnitude": -50.0, "baseline": 100.0}, [])
    assert res.rung == "association"


# ===========================================================================
# LLM narrator -- model independence
# ===========================================================================
def test_llm_disabled_returns_template_untouched():
    cs = claims(observed=40.0)
    out = llm_narrator.narrate_with_llm(cs, "cfo", "H", "Body 40.00")
    assert out["engine_type"] == "rule" and out["narrative"] == "Body 40.00"
    assert out["fell_back"] and out["reason"] == "disabled"


def test_llm_assumes_no_model_name(monkeypatch):
    """No hardcoded model: with nothing configured and no server, resolution yields None."""
    monkeypatch.setattr(config, "LLM_MODEL", "")
    monkeypatch.setattr(config, "LLM_BASE_URL", "http://127.0.0.1:9")
    llm_narrator._resolved_model = None
    assert llm_narrator.resolve_model(force=True) is None


def test_llm_uses_configured_model_without_calling_server(monkeypatch):
    monkeypatch.setattr(config, "LLM_MODEL", "any/small-model")
    assert llm_narrator.resolve_model(force=True) == "any/small-model"


def test_llm_unreachable_server_falls_back(monkeypatch):
    monkeypatch.setattr(config, "LLM_ENABLED", True)
    monkeypatch.setattr(config, "LLM_MODEL", "any/small-model")
    monkeypatch.setattr(config, "LLM_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(config, "LLM_TIMEOUT_S", 1)
    out = llm_narrator.narrate_with_llm(claims(v=1.0), "cfo", "H", "Body 1.00")
    assert out["engine_type"] == "rule" and out["narrative"] == "Body 1.00"


@pytest.mark.parametrize("payload,expect", [
    ('{"headline":"H","narrative":"N"}', ("H", "N")),
    ('```json\n{"headline":"H","narrative":"N"}\n```', ("H", "N")),
    ('Sure!\n{"headline":"H","narrative":"N"}', ("H", "N")),
    ("not json at all", ("", "")),
    ("", ("", "")),
])
def test_llm_parse_tolerates_small_model_formatting(payload, expect):
    """Smaller models wrap JSON in fences or prose; that must not cost a fallback."""
    assert llm_narrator._parse(payload) == expect


def test_llm_output_with_invented_number_is_rejected(monkeypatch):
    monkeypatch.setattr(config, "LLM_ENABLED", True)
    monkeypatch.setattr(config, "LLM_MODEL", "m")
    monkeypatch.setattr(llm_narrator, "_call",
                        lambda p, m, g: ('{"headline":"H 77.00","narrative":"N 77.00"}', 1, 1))
    out = llm_narrator.narrate_with_llm(claims(v=1.0), "cfo", "H", "Body 1.00")
    assert out["engine_type"] == "rule", "an unverified figure must never be published"
    assert out["reason"] == "unverified_number"


def test_llm_output_with_supported_numbers_is_used(monkeypatch):
    monkeypatch.setattr(config, "LLM_ENABLED", True)
    monkeypatch.setattr(config, "LLM_MODEL", "m")
    monkeypatch.setattr(llm_narrator, "_call",
                        lambda p, m, g: ('{"headline":"Fell to 1.00","narrative":"It hit 1.00."}',
                                         3, 4))
    out = llm_narrator.narrate_with_llm(claims(v=1.0), "cfo", "H", "Body 1.00")
    assert out["engine_type"] == "llm" and out["tokens_out"] == 4
