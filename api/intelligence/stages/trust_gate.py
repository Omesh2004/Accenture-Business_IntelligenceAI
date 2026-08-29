"""Stage 01 -- Trust Gate. Did reality move, or did the data lie?

A gate, not a step: `fail` terminates the business path. Writes a trust_findings row on EVERY
run including passes, because stage 08 audits the suppression rate.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from api.intelligence import config
from api.intelligence.ids import finding_id, round6
from api.intelligence.contracts import Contract


@dataclass
class TrustResult:
    verdict: str                      # pass | fail | ambiguous
    fingerprint: str = ""
    cheapest_check: str = ""
    findings: list[dict] = field(default_factory=list)

    @property
    def blocks(self) -> bool:
        return self.verdict in {"fail", "ambiguous"}


def run(ctx, metric_layer) -> TrustResult:
    contract: Contract = ctx.contract
    findings: list[dict] = []
    verdict = "pass"
    fingerprint = ""
    cheapest = ""

    def record(check_id: str, ok: bool, observed, expected, *, fp: str = "",
               blocks: bool = False, cheap: str = "", verdict_for_check: str = "pass") -> None:
        findings.append({
            "finding_id": finding_id(ctx.investigation_id, check_id),
            "investigation_id": ctx.investigation_id,
            "tenant_id": ctx.tenant_id,
            "kpi_id": ctx.kpi_id,
            "window_start": ctx.window.start,
            "window_end": ctx.window.end,
            "verdict": "pass" if ok else verdict_for_check,
            "check_id": check_id,
            "fingerprint": "" if ok else fp,
            "observed": observed,
            "expected": expected,
            "cheapest_check": "" if ok else cheap,
            "blocks_narrative": 0 if ok else int(blocks),
            "engine_type": "rule",
            "ts": ctx.started_at,
        })

    # 1. readiness -- a blocked KPI never falls through to reading zero.
    ready = contract.readiness_status
    record("readiness", ready != "blocked", {"status": ready}, {"status": "not blocked"},
           fp="not_instrumented", blocks=True, verdict_for_check="fail")
    if ready == "blocked":
        return TrustResult("fail", "not_instrumented", findings=findings)

    num = contract.numerator()
    den = contract.denominator()

    # 2. dedup_integrity (D1) -- raw_rows comes from the MV, so it survives the
    #    ReplacingMergeTree merges that erase duplicates from events_raw.
    for spec in [s for s in (num, den) if s]:
        raw, uniq = metric_layer.dedup_counts(ctx.tenant_id, spec, ctx.window)
        ok = raw <= uniq
        record(f"dedup_integrity:{spec.get('metric')}", ok,
               {"raw_rows": raw, "distinct_event_ids": uniq},
               {"rule": "raw_rows <= uniqExact(event_id)"},
               fp="duplicate_event_storm", blocks=True, verdict_for_check="fail")
        if not ok:
            verdict, fingerprint = "fail", "duplicate_event_storm"

    # 3. denominator floor -- too little data is an abstain, never a confident anomaly.
    min_den = int(contract.detection.get("min_denominator", 0))
    if den is not None:
        total = metric_layer.fundamental_total(ctx.tenant_id, den, ctx.window)
        ok = total >= min_den
        record("min_denominator", ok, {"denominator": round6(total)}, {"min": min_den},
               fp="insufficient_volume", blocks=True, cheap="widen the window or lower the floor",
               verdict_for_check="ambiguous")
        if not ok and verdict == "pass":
            verdict, fingerprint = "ambiguous", "insufficient_volume"
            cheapest = "widen the window or lower the contract's min_denominator"

    # 4a. Per-source freshness: a KPI spanning a stream and an hourly batch cannot be gated by
    #     one number, so each declared source is checked against its own SLA.
    for src in contract.sources:
        source_id = str(src.get("id", ""))
        if not source_id or not hasattr(metric_layer, "facts"):
            continue
        try:
            behind, sla = metric_layer.facts.source_freshness(
                source_id, ctx.tenant_id, ctx.window.end)
        except Exception:
            continue
        if behind is None:
            record(f"source_present:{source_id}", False, {"source": source_id},
                   {"rule": "the source has loaded at least once"}, fp="source_never_loaded",
                   blocks=True, cheap=f"run the {source_id} loader",
                   verdict_for_check="ambiguous")
            if verdict == "pass":
                verdict, fingerprint = "ambiguous", "source_never_loaded"
                cheapest = f"run the {source_id} loader and re-check"
            continue
        sla = int(src.get("freshness_sla_minutes", sla) or sla or 0)
        ok = sla <= 0 or behind <= sla
        record(f"source_freshness:{source_id}", ok,
               {"source": source_id, "minutes_behind": round6(behind),
                "cadence": src.get("cadence", "")},
               {"sla_minutes": sla}, fp="stale_source", blocks=False,
               cheap=f"check the {source_id} loader schedule", verdict_for_check="ambiguous")
        if not ok and verdict == "pass":
            verdict, fingerprint = "ambiguous", "stale_source"
            cheapest = (f"re-run the {source_id} loader -- it is {behind:.0f} min behind "
                        f"its {sla} min SLA")

    # 4b. Freshness, scaled to the grain: a daily series is at best one bucket stale, so a
    #     streaming SLA would fail every daily KPI forever.
    fresh = metric_layer.freshness_minutes(ctx.tenant_id, ctx.window)
    sla = contract.freshness_sla_minutes
    grain_time = (contract.raw.get("grain") or {}).get("time", "daily")
    if grain_time == "daily":
        sla = max(sla, config.DAILY_FRESHNESS_FLOOR_MIN + contract.provisional_window_minutes)
    if fresh is not None:
        ok = fresh <= sla
        record("freshness", ok, {"minutes_behind": round6(fresh)}, {"sla_minutes": sla},
               fp="stale_source", blocks=False, cheap="check the forwarder and the worker",
               verdict_for_check="ambiguous")
        if not ok and verdict == "pass":
            verdict, fingerprint = "ambiguous", "stale_source"
            cheapest = "check /health/forwarder and the processor-worker lag"

    # 5. soft invariants -- evidence, not proof. Violation abstains, never quarantines.
    if num is not None and den is not None:
        n = metric_layer.fundamental_total(ctx.tenant_id, num, ctx.window)
        d = metric_layer.fundamental_total(ctx.tenant_id, den, ctx.window)
        for inv in contract.soft_invariants:
            if inv.get("id") == "funnel_order":
                ok = n <= d
                record("funnel_order", ok, {"numerator": round6(n), "denominator": round6(d)},
                       {"rule": "numerator <= denominator"}, fp="funnel_inversion",
                       cheap="check for cross-session completions", verdict_for_check="ambiguous")
                if not ok and verdict == "pass":
                    verdict, fingerprint = "ambiguous", "funnel_inversion"
                    cheapest = "check whether completions are landing from earlier sessions"

    # 6. session_present -- session grain is what makes ratio localization additive.
    if contract.grain_entity == "session" and den is not None:
        inv = metric_layer.dimension_invariance(ctx.tenant_id, "device_type", ctx.window)
        record("session_grain_available", inv > 0.0, {"invariance": round6(inv)},
               {"rule": "sessions exist and carry dimensions"}, fp="no_session_grain",
               cheap="verify x-session-id reaches ingestion", verdict_for_check="ambiguous")

    return TrustResult(verdict, fingerprint, cheapest, findings)
