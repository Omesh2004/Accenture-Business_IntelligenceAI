"""Stage-level tests against StubMetricLayer -- no ClickHouse, no LLM, fully deterministic."""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence import ids
from api.intelligence.contracts import Contract
from api.intelligence.metrics import StubMetricLayer, Window
from api.intelligence.stages import causal_decide, detect, forecast, localize, narrate, trust_gate

W_START = datetime(2026, 8, 1)
W_END = datetime(2026, 8, 8)


def make_contract(**over):
    raw = {
        "id": "kyc_completion_rate", "name": "KYC Completion Rate", "unit": "ratio",
        "grain": {"time": "daily", "entity": "session"},
        "readiness": {"status": "ready"},
        "fundamentals": [
            {"metric": "num", "event": "loan.kyc_completed.success",
             "aggregation": "uniqExact(session_id)"},
            {"metric": "den", "event": "loan.kyc_started.success",
             "aggregation": "uniqExact(session_id)"},
        ],
        "dimensions": {"allowed": ["location", "device_type"], "max_depth": 2,
                       "min_segment_volume": 1},
        "quality": {"freshness_sla_minutes": 60,
                    "soft_invariants": [{"id": "funnel_order"}]},
        "detection": {"min_denominator": 10, "min_persistence_windows": 2,
                      "critical_pct_change": 20, "warn_pct_change": 8, "direction": "down"},
        "forecast": {"enabled": True, "baseline": "seasonal_naive", "min_history_days": 14,
                     "horizon_days": 7},
        "decision": {"owner": "growth_analytics",
                     "allowed_levers": ["fix_kyc_step", "investigate"]},
        "causal": {"enabled": True, "evidence_rungs": ["association", "attribution"],
                   "degrade_to": "attribution"},
        "access_restriction": {"visible_to": ["cfo", "ops_manager", "analyst"]},
    }
    raw.update(over)
    return Contract(id=raw["id"], tier=1, raw=raw)


class Ctx:
    def __init__(self, contract, dedup=(100, 100)):
        self.investigation_id = "inv001"
        self.tenant_id = "nexabank"
        self.kpi_id = contract.id
        self.contract = contract
        self.window = Window(W_START, W_END)
        self.started_at = W_END
        self.dataset = "seeded"


# --------------------------------------------------------------------------- ids
def test_ids_are_derived_not_generated():
    a = ids.investigation_id("t", "k", W_START, "scheduled")
    b = ids.investigation_id("t", "k", W_START, "scheduled")
    assert a == b and len(a) == 16


def test_ids_change_with_inputs():
    assert ids.anomaly_id("t", "k", W_START, "mad") != ids.anomaly_id("t", "k", W_START, "band")


def test_round6_is_write_boundary():
    assert ids.round6(1 / 3) == 0.333333
    assert ids.round6(None) == 0.0


# --------------------------------------------------------------------------- trust gate
def test_blocked_contract_fails_not_instrumented():
    c = make_contract(readiness={"status": "blocked"})
    res = trust_gate.run(Ctx(c), StubMetricLayer())
    assert res.verdict == "fail" and res.fingerprint == "not_instrumented"


def test_duplicate_storm_detected_via_raw_rows():
    """D1: raw_rows > distinct ids means a replay the source table may already have merged."""
    stub = StubMetricLayer(dedup=(150, 100), series={"den": {"d": 500}})
    res = trust_gate.run(Ctx(make_contract()), stub)
    assert res.verdict == "fail"
    assert res.fingerprint == "duplicate_event_storm"
    assert any(f["check_id"].startswith("dedup_integrity") and f["verdict"] == "fail"
               for f in res.findings)


def test_clean_data_passes_and_still_writes_findings():
    stub = StubMetricLayer(dedup=(100, 100), series={"num": {"d": 40}, "den": {"d": 100}})
    res = trust_gate.run(Ctx(make_contract()), stub)
    assert res.verdict == "pass"
    assert res.findings, "a pass must still leave rows -- stage 08 audits the suppression rate"
    assert all(f["blocks_narrative"] == 0 for f in res.findings)


def test_thin_denominator_abstains_rather_than_fails():
    stub = StubMetricLayer(dedup=(10, 10), series={"num": {"d": 2}, "den": {"d": 3}})
    res = trust_gate.run(Ctx(make_contract()), stub)
    assert res.verdict == "ambiguous"
    assert res.cheapest_check


def test_soft_invariant_violation_abstains_not_quarantines():
    """completed <= started can break legitimately across sessions."""
    stub = StubMetricLayer(dedup=(100, 100), series={"num": {"d": 90}, "den": {"d": 50}})
    res = trust_gate.run(Ctx(make_contract()), stub)
    assert res.verdict == "ambiguous", "a soft invariant must never quarantine"


# --------------------------------------------------------------------------- forecast
def test_forecast_cold_start_widens_and_caveats():
    res = forecast.run("k", [10.0, 11.0, 9.0], make_contract(), W_END, "t")
    assert res.caveat == "insufficient_history"
    assert res.upper > res.lower
    assert res.backtest_mase == 0.0


def test_forecast_produces_interval_with_history():
    values = [100.0 + (i % 7) for i in range(30)]
    res = forecast.run("k", values, make_contract(), W_END, "t")
    assert res.caveat == ""
    assert res.lower <= res.point <= res.upper
    assert res.method in {"seasonal_naive", "rolling_median"}


def test_forecast_is_deterministic():
    values = [100.0 + (i % 7) for i in range(30)]
    a = forecast.run("k", values, make_contract(), W_END, "t")
    b = forecast.run("k", values, make_contract(), W_END, "t")
    assert a == b


# --------------------------------------------------------------------------- detect
def _band(point, lower, upper):
    return {"point": point, "lower": lower, "upper": upper, "forecast_id": "f1"}


def test_detect_silent_inside_band():
    res = detect.run(Ctx(make_contract()), [100.0] * 20, _band(100, 80, 120), 500, 500)
    assert not res.fired and res.reason == "within_band"


def test_detect_fires_on_persistent_material_drop():
    values = [100.0] * 18 + [40.0, 38.0]
    res = detect.run(Ctx(make_contract()), values, _band(100, 80, 120), 500, 500)
    assert res.fired
    assert res.anomaly["direction"] == -1
    assert res.anomaly["severity"] in {"info", "warn", "urgent"}


def test_detect_requires_persistence():
    values = [100.0] * 19 + [30.0]      # one window only
    res = detect.run(Ctx(make_contract()), values, _band(100, 80, 120), 500, 500)
    assert not res.fired and res.reason == "not_persistent"


def test_detect_respects_contract_direction():
    values = [100.0] * 18 + [300.0, 310.0]
    res = detect.run(Ctx(make_contract()), values, _band(100, 80, 120), 500, 500)
    assert not res.fired and res.reason == "wrong_direction"


def test_detect_falls_back_to_mad_without_band():
    values = [100.0] * 18 + [20.0, 21.0]
    res = detect.run(Ctx(make_contract()), values, None, 500, 500)
    assert res.fired and res.anomaly["method"] == "mad"


def test_benjamini_hochberg_controls_discoveries():
    assert detect.benjamini_hochberg([0.001, 0.9, 0.8]) == [True, False, False]
    assert detect.benjamini_hochberg([]) == []
    assert not any(detect.benjamini_hochberg([0.9, 0.8, 0.7]))


def test_materiality_bounded_and_multiplicative():
    score = detect.materiality(50, 100, 20, 100, 100, 2, 2)
    assert 0.0 <= score <= 1.0


# --------------------------------------------------------------------------- localize
def test_localize_ranks_planted_segment_first():
    cells_now = {("India",): 40.0, ("USA",): 95.0}
    cells_before = {("India",): 90.0, ("USA",): 100.0}
    stub = StubMetricLayer()
    stub.fundamental_by_cell = lambda t, s, d, w, m=0: (
        cells_now if w.start == W_START else cells_before)
    anomaly = {"anomaly_id": "a1", "direction": -1, "magnitude": -55.0}
    res = localize.run(Ctx(make_contract()), stub, anomaly, ["location"],
                       Window(W_START - timedelta(days=7), W_START))
    assert res.causes
    assert res.causes[0]["dimensions"] == {"location": "India"}
    assert res.causes[0]["rank"] == 1


def test_localize_contributions_sum_to_about_one():
    """A partition's cells must account for the fundamental's whole movement."""
    cells_now = {("India",): 40.0, ("USA",): 60.0}      # total 100
    cells_before = {("India",): 90.0, ("USA",): 100.0}  # total 190, so the move is 90
    stub = StubMetricLayer()
    stub.fundamental_by_cell = lambda t, s, d, w, m=0: (
        cells_now if w.start == W_START else cells_before)
    stub.fundamental_total = lambda t, s, w: (
        sum(cells_now.values()) if w.start == W_START else sum(cells_before.values()))
    res = localize.run(Ctx(make_contract()), stub, {"anomaly_id": "a1", "direction": -1,
                                                    "magnitude": -90.0},
                       ["location"], Window(W_START - timedelta(days=7), W_START))
    assert abs(res.explained_pct - 1.0) < 0.01
    assert res.causes[0]["dimensions"] == {"location": "India"}, "biggest mover ranks first"


def test_localize_reports_when_dimensions_cannot_explain():
    stub = StubMetricLayer()
    res = localize.run(Ctx(make_contract()), stub, {"anomaly_id": "a1", "direction": -1,
                                                    "magnitude": -10.0},
                       [], Window(W_START - timedelta(days=7), W_START))
    assert res.inconclusive and "no admissible dimensions" in res.note


# --------------------------------------------------------------------------- causal / decide
def test_causal_ceiling_is_attribution_without_intervention():
    res = causal_decide.run_causal(Ctx(make_contract()),
                                   {"magnitude": -50.0, "baseline": 100.0},
                                   [{"contribution": 0.8, "dimensions": {"location": "India"}}])
    assert res.rung == "attribution"
    assert not res.assumptions_met
    assert res.lower <= res.point <= res.upper


def test_causal_climbs_with_upstream_anomaly():
    c = make_contract(causal={"enabled": True,
                              "evidence_rungs": ["association", "attribution",
                                                 "corroborated_cause"],
                              "degrade_to": "attribution"})
    res = causal_decide.run_causal(Ctx(c),
                                   {"magnitude": -50.0, "baseline": 100.0},
                                   [{"contribution": 0.8, "dimensions": {}}],
                                   upstream_anomaly={"kpi_id": "kyc_completion_rate"})
    assert res.rung == "corroborated_cause"


def test_causal_respects_contract_rung_ceiling():
    """A contract that does not allow corroborated_cause must degrade, not climb."""
    c = make_contract(causal={"enabled": True,
                              "evidence_rungs": ["association", "attribution"],
                              "degrade_to": "attribution"})
    res = causal_decide.run_causal(Ctx(c), {"magnitude": -50.0, "baseline": 100.0},
                                   [{"contribution": 0.8, "dimensions": {}}],
                                   upstream_anomaly={"kpi_id": "kyc_completion_rate"})
    assert res.rung == "attribution"


def test_decide_only_uses_contract_levers():
    c = make_contract()
    dec = causal_decide.run_decide(
        Ctx(c), {"magnitude": -50.0},
        [{"contribution": 0.8, "dimensions": {"location": "India"}}],
        causal_decide.CausalResult("attribution", "none", -50, -60, -40, "rule", False))
    assert dec.lever in c.allowed_levers
    assert dec.impact_low <= dec.impact_high


# --------------------------------------------------------------------------- narrate / verify
def _claims():
    cs = narrate.ClaimSet()
    cs.add("observed", 40.0, "count", "anomalies", "observed")
    cs.add("baseline", 100.0, "count", "anomalies", "baseline")
    return cs


def test_verifier_accepts_supported_numbers():
    ok, bad = narrate.verify("It fell to 40.00 from 100.00.", _claims())
    assert ok and not bad


def test_verifier_rejects_invented_number():
    ok, bad = narrate.verify("It fell to 40.00 from 100.00, a 73.50% drop.", _claims())
    assert not ok and "73.50" in bad


def test_entitlement_no_longer_removes_a_kpi_from_a_persona():
    """Persona shapes the answer and the levers, never whether a movement is disclosed."""
    c = make_contract(access_restriction={"visible_to": ["cfo", "analyst"]})
    claims, restricted = narrate.apply_entitlement(_claims(), c, "ops_manager")
    assert not restricted and claims.claims


def test_entitlement_allows_permitted_persona():
    c = make_contract(access_restriction={"visible_to": ["cfo"]})
    claims, restricted = narrate.apply_entitlement(_claims(), c, "cfo")
    assert not restricted and claims.claims


def test_template_narrative_passes_its_own_verifier():
    """Every number the template emits must trace to a claim -- for all three personas."""
    c = make_contract()
    ctx = Ctx(c)
    anomaly = {"observed": 40.0, "baseline": 100.0, "magnitude": -60.0, "materiality": 0.6,
               "direction": -1, "severity": "warn", "anomaly_id": "a1"}
    causes = [{"contribution": 0.8, "dimensions": {"location": "India"},
               "cause_id": "c1", "rank": 1}]
    band = {"point": 95.0, "lower": 80.0, "upper": 110.0, "method": "seasonal_naive",
            "caveat": ""}
    cau = causal_decide.CausalResult("attribution", "none", -60, -72, -48, "rule", False)
    dec = causal_decide.DecideResult("fix kyc step for location=India", "fix_kyc_step",
                                     "growth_analytics", 0.0, 48.0)
    trust = trust_gate.TrustResult("pass")
    cs = narrate.build_claim_set(ctx, trust, anomaly, causes, band, cau, dec)
    for persona in ("cfo", "ops_manager", "analyst"):
        _, body = narrate.render_template(ctx, cs, persona, trust, False)
        ok, bad = narrate.verify(body, cs)
        assert ok, f"{persona} narrative has unsupported numbers: {bad}"


def test_defect_narrative_is_an_incident_note_not_a_growth_story():
    trust = trust_gate.TrustResult("fail", "duplicate_event_storm")
    ctx = Ctx(make_contract())
    cs = narrate.build_claim_set(ctx, trust, None, [], None, None, None)
    headline, body = narrate.render_template(ctx, cs, "cfo", trust, False)
    assert "quarantined" in body
    assert "grew" not in body.lower() and "growth" not in headline.lower()
    ok, _ = narrate.verify(body, cs)
    assert ok


def test_personas_share_identical_numbers():
    """Persona is a render config; the numbers cannot differ between them."""
    c = make_contract()
    ctx = Ctx(c)
    anomaly = {"observed": 40.0, "baseline": 100.0, "magnitude": -60.0, "materiality": 0.6,
               "direction": -1, "severity": "warn", "anomaly_id": "a1"}
    trust = trust_gate.TrustResult("pass")
    cs = narrate.build_claim_set(ctx, trust, anomaly, [], None, None, None)
    seen = {}
    for persona in ("cfo", "ops_manager", "analyst"):
        claims, _ = narrate.apply_entitlement(cs, c, persona)
        seen[persona] = sorted((k, v.value) for k, v in claims.claims.items())
    assert seen["cfo"] == seen["ops_manager"] == seen["analyst"]


# ── reach must not be a share of the event firehose ──────────────────────────

def test_a_business_kpi_is_not_suppressed_by_page_view_volume():
    """A 37% collapse in a few-hundred-event KPI is material however large the clickstream is.

    Reach was scored against the tenant's whole event volume, so every business KPI sat far below
    the materiality floor and Detect returned `immaterial` no matter how far the metric moved.
    """
    values = [72.0] * 18 + [45.0, 45.0]
    res = detect.run(Ctx(make_contract()), values, _band(72, 69, 75), 320, 0.0)
    assert res.fired and res.reason == ""
    assert res.materiality >= 0.15


def test_a_trivial_kpi_is_still_refused():
    values = [72.0] * 18 + [45.0, 45.0]
    res = detect.run(Ctx(make_contract()), values, _band(72, 69, 75), 4, 0.0)
    assert not res.fired and res.reason == "low_volume"
