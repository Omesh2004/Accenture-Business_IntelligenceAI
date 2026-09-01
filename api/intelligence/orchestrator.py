"""Agent orchestrator: deterministic control flow over the nine stages.

Build order is not execution order. Forecast runs beforehand as a batch; Trust Gate is a gate,
not a step -- a fail terminates the business path and routes an incident note instead.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from api.intelligence import config
from api.intelligence import signal_store as store
from api.intelligence.contracts import Contract, load_all, sliceable_dimensions
from api.intelligence.ids import investigation_id, run_id, inputs_hash
from api.intelligence.metrics import ClickHouseMetricLayer, MetricSource, Window, ratio_series
from api.metric_api.client import MetricAPIClient
from api.intelligence.stages import (causal_decide, decompose, detect, forecast,
                                     llm_narrator, localize, narrate, trust_gate)

logger = logging.getLogger(__name__)


@dataclass
class Ctx:
    """Everything a stage needs. The window is pinned here and never recomputed."""
    investigation_id: str
    tenant_id: str
    kpi_id: str
    contract: Contract
    window: Window
    started_at: datetime
    dataset: str = "seeded"
    trigger: str = "scheduled"
    watermark: datetime | None = None
    stage_runs: list[dict] = field(default_factory=list)
    # True when Detect scored the contract's own rate rather than an additive fundamental.
    rate_scored: bool = False


class Orchestrator:
    def __init__(self, metric_layer: MetricSource | None = None, personas=None):
        self.metrics = metric_layer or MetricAPIClient()
        self.personas = tuple(personas or config.PERSONAS)

    # -- telemetry -----------------------------------------------------------
    def _record_run(self, ctx: Ctx, stage: str, engine: str, started: float,
                    inputs=None, verifier_pass: bool = True, model: str = "",
                    tokens_in: int = 0, tokens_out: int = 0) -> None:
        row = {
            "run_id": run_id(ctx.investigation_id, stage),
            "investigation_id": ctx.investigation_id,
            "tenant_id": ctx.tenant_id,
            "stage": stage,
            "engine_type": engine,
            "model": model,
            "inputs_hash": inputs_hash(inputs) if inputs is not None else "",
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "verifier_pass": int(verifier_pass),
            "ts": ctx.started_at,
        }
        ctx.stage_runs.append(row)
        store.write_model_run(row)

    # -- stage 04, scheduled batch ------------------------------------------
    def run_forecast_batch(self, tenant_id: str, contracts: dict[str, Contract],
                           window: Window, as_of: datetime) -> int:
        written = 0
        for kpi_id, contract in sorted(contracts.items()):
            if not contract.forecast_cfg.get("enabled", True):
                continue
            spec = contract.scored_fundamental or None
            if spec is None:
                continue
            # A ratio is banded on the rate, because that is what Detect now scores against it.
            series = (ratio_series(self.metrics, tenant_id, contract, window)
                      if contract.is_ratio else None)
            if series is None:
                series = self.metrics.fundamental_series(tenant_id, spec, window)
            result = forecast.run(kpi_id, series.values(), contract, as_of, tenant_id)
            store.write_forecast(forecast.to_row(
                result, tenant_id, kpi_id, as_of,
                int(contract.forecast_cfg.get("horizon_days", 7))))
            written += 1
        return written

    # -- one investigation ---------------------------------------------------
    def investigate(self, tenant_id: str, contract: Contract, window: Window,
                    *, dataset: str = "seeded", trigger: str = "scheduled",
                    started_at: datetime | None = None,
                    upstream_anomaly: dict | None = None) -> dict:
        started_at = started_at or window.end
        inv_id = investigation_id(tenant_id, contract.id, window.start, trigger)
        ctx = Ctx(inv_id, tenant_id, contract.id, contract, window, started_at,
                  dataset=dataset, trigger=trigger)
        try:
            ctx.watermark = self.metrics.watermark(tenant_id)
        except Exception:
            ctx.watermark = None

        result = {"investigation_id": inv_id, "kpi_id": contract.id, "tenant_id": tenant_id,
                  "status": "running", "termination_reason": "", "terminal_stage": "",
                  "anomaly": None, "causes": [], "insights": []}

        def finish(status: str, reason: str, stage: str) -> dict:
            result.update(status=status, termination_reason=reason, terminal_stage=stage)
            store.write_investigation(
                investigation_id=inv_id, tenant_id=tenant_id, kpi_id=contract.id,
                window_start=window.start, window_end=window.end, trigger=trigger,
                status=status, dataset=dataset, started_at=started_at,
                terminal_stage=stage, termination_reason=reason, ended_at=started_at,
                watermark=ctx.watermark)
            return result

        # ---- 01 Trust Gate ------------------------------------------------
        t0 = time.perf_counter()
        trust = trust_gate.run(ctx, self.metrics)
        store.write_trust_findings(trust.findings)
        self._record_run(ctx, "trust_gate", "rule", t0, inputs=contract.id)
        result["trust"] = trust.verdict

        if trust.verdict == "fail":
            self._narrate(ctx, trust, None, [], None, None, None, abstained=False,
                          result=result)
            reason = "not_instrumented" if trust.fingerprint == "not_instrumented" else "defect"
            return finish("terminated", reason, "trust_gate")

        if trust.verdict == "ambiguous":
            self._narrate(ctx, trust, None, [], None, None, None, abstained=True, result=result)
            return finish("terminated", "ambiguous", "trust_gate")

        # ---- 02 Detect (reads the stored band from stage 04) ---------------
        spec = contract.scored_fundamental
        den_spec = contract.denominator()
        t0 = time.perf_counter()
        # A ratio KPI is scored on its own rate. Scoring the numerator instead let a conversion
        # rate halve while volume grew and be reported as an urgent RISE -- the movement the
        # contract names was never scored by anything. Localize still uses the fundamentals.
        series = (ratio_series(self.metrics, tenant_id, contract, window)
                  if contract.is_ratio else None)
        ctx.rate_scored = series is not None
        if series is None:
            series = self.metrics.fundamental_series(tenant_id, spec, window)
        band = store.read_forecast(tenant_id, contract.id, window.start)
        # Detect scores the whole window, so the movement covers the KPI's entire population and
        # reach is 1.0 by construction; partial coverage is Localize's finding, not Detect's.
        # Passing the tenant's raw event volume as the total made reach a page-view share, which
        # pinned every business KPI below the materiality floor however far it moved. Triviality
        # is guarded by an absolute volume floor instead.
        kpi_volume = (self.metrics.fundamental_total(tenant_id, den_spec, window)
                      if den_spec else self.metrics.fundamental_total(tenant_id, spec, window))
        # The robust baseline needs history from BEFORE the window. series_values[:-n] is all
        # inside it, so on a sustained shift the movement was compared against itself.
        hist_window = Window(window.start - timedelta(days=config.BASELINE_DAYS), window.start)
        try:
            hist_series = (ratio_series(self.metrics, tenant_id, contract, hist_window)
                           if contract.is_ratio
                           else self.metrics.fundamental_series(tenant_id, spec, hist_window))
            baseline_values = list(hist_series.values()) if hist_series else []
        except Exception:
            baseline_values = []
        det = detect.run(ctx, series.values(), band, kpi_volume, 0.0,
                         baseline_values=baseline_values)
        self._record_run(ctx, "detect", "stats", t0, inputs=series.values())

        if not det.fired:
            reason = "immaterial" if det.reason == "immaterial" else "no_anomaly"
            self._narrate(ctx, trust, None, [], band, None, None, abstained=False, result=result)
            return finish("completed", reason, "detect")

        anomaly = det.anomaly
        store.write_anomaly(anomaly)
        result["anomaly"] = anomaly

        # ---- 03 Localize ---------------------------------------------------
        t0 = time.perf_counter()
        dims = sliceable_dimensions(contract, self.metrics, tenant_id, window, dataset)
        span = window.end - window.start
        baseline_window = Window(window.start - span, window.start)
        loc = localize.run(ctx, self.metrics, anomaly, dims, baseline_window)
        if loc.causes:
            store.write_root_causes(loc.causes)
        self._record_run(ctx, "localize", "stats", t0, inputs=dims)
        result["causes"] = loc.causes

        # ---- 02a Decompose: which FACTOR moved, as distinct from which cell ----
        dec_result = None
        if ctx.contract.decomposition.get("enabled") and hasattr(self.metrics, "facts"):
            t0 = time.perf_counter()
            dec_result = decompose.run(ctx, self.metrics.facts, anomaly, baseline_window)
            rows = decompose.to_rows(ctx, anomaly, dec_result)
            if rows:
                store.write_root_causes(rows)
            self._record_run(ctx, "decompose", "stats", t0,
                             inputs=ctx.contract.decomposition.get("mix_dimensions"))
            result["factors"] = dec_result.factors
            if not dec_result.ok and dec_result.factors:
                logger.warning("decomposition residual %.6f for %s -- identity does not close",
                               dec_result.residual, ctx.kpi_id)

        # ---- 05 Causal -----------------------------------------------------
        t0 = time.perf_counter()
        cau = causal_decide.run_causal(ctx, anomaly, loc.causes, upstream_anomaly, self.metrics)
        store.write_causal_effect(causal_decide.to_effect_row(ctx, anomaly, cau))
        self._record_run(ctx, "causal", "stats" if cau.method != "rule" else "rule", t0,
                         inputs=cau.rung)

        # ---- 06 Decide -----------------------------------------------------
        t0 = time.perf_counter()
        dec = causal_decide.run_decide(ctx, anomaly, loc.causes, cau)
        store.write_recommendation(causal_decide.to_rec_row(ctx, anomaly, dec))
        self._record_run(ctx, "decide", "rule", t0, inputs=dec.lever)
        result["recommendation"] = {"action": dec.action, "lever": dec.lever}

        # ---- 07 Narrate + Verify -------------------------------------------
        self._narrate(ctx, trust, anomaly, loc.causes, band, cau, dec,
                      abstained=loc.inconclusive, result=result, factors=dec_result)
        return finish("completed", "completed", "narrate")

    # -- stage 07 ------------------------------------------------------------
    def _narrate(self, ctx: Ctx, trust, anomaly, causes, band, causal, decision,
                 *, abstained: bool, result: dict, factors=None) -> None:
        t0 = time.perf_counter()
        full = narrate.build_claim_set(ctx, trust, anomaly, causes, band, causal, decision,
                                       factors=factors)
        self._record_run(ctx, "narrate", "rule", t0, inputs=sorted(full.claims))
        breakdown = store.engine_breakdown(ctx.investigation_id)

        for persona in self.personas:
            # Entitlement is applied BEFORE the narrator, so a restricted number is
            # structurally absent rather than redacted afterwards.
            claims, restricted = narrate.apply_entitlement(full, ctx.contract, persona)
            if restricted:
                continue
            headline, body = narrate.render_template(ctx, claims, persona, trust, abstained)
            ok, unsupported = narrate.verify(body, claims)
            if not ok:
                # Deterministic fallback: strip to the headline rather than emit an
                # unverifiable figure. An unverified number never reaches a reader.
                body = headline
                ok, _ = narrate.verify(body, claims)

            # Optional LLM pass: rephrase only. The verifier re-checks every figure.
            llm = llm_narrator.narrate_with_llm(claims, persona, headline, body)
            headline, body = llm["headline"], llm["narrative"]
            ok = ok and llm["verifier_pass"]
            if llm["engine_type"] == "llm":
                store.write_model_run({
                    "run_id": run_id(ctx.investigation_id, f"narrate_llm:{persona}"),
                    "investigation_id": ctx.investigation_id,
                    "tenant_id": ctx.tenant_id, "stage": "narrate",
                    "engine_type": "llm", "model": llm["model"],
                    "inputs_hash": inputs_hash(sorted(claims.claims)),
                    "tokens_in": llm["tokens_in"], "tokens_out": llm["tokens_out"],
                    "latency_ms": llm["latency_ms"], "verifier_pass": int(ok),
                    "ts": ctx.started_at,
                })

            row = narrate.to_insight_row(ctx, persona, headline, body, claims, trust,
                                         anomaly, breakdown, abstained, ok)
            row["window_days"] = max(1, (ctx.window.end - ctx.window.start).days)
            store.write_insight(row)
            result["insights"].append({"persona": persona, "headline": headline,
                                       "narrative": body, "verifier_pass": ok})

    # -- sweep ---------------------------------------------------------------
    def sweep(self, tenant_id: str, window: Window, *, dataset: str = "seeded",
              kpi_ids: list[str] | None = None, run_forecast: bool = True) -> list[dict]:
        contracts = load_all(self.metrics, tenant_id, window)
        if kpi_ids:
            contracts = {k: v for k, v in contracts.items() if k in kpi_ids}

        if run_forecast:
            # History must END where the scored window BEGINS, or the band centres on the
            # movement it is meant to detect.
            hist = Window(window.start - timedelta(days=config.BASELINE_DAYS), window.start)
            self.run_forecast_batch(tenant_id, contracts, hist, window.start)

        # Upstream KPIs first, so propagation can explain their dependents for free.
        ordered = sorted(contracts.values(), key=lambda c: (c.driven_by is not None, c.id))
        if len(ordered) > config.MAX_KPIS_PER_SWEEP:
            skipped = len(ordered) - config.MAX_KPIS_PER_SWEEP
            ordered = ordered[:config.MAX_KPIS_PER_SWEEP]
            logger.warning("sweep capped at %d KPIs; %d not examined this run",
                           config.MAX_KPIS_PER_SWEEP, skipped)
        opened: dict[str, dict] = {}
        results = []
        for contract in ordered:
            upstream = opened.get(contract.driven_by) if contract.driven_by else None
            try:
                res = self.investigate(tenant_id, contract, window, dataset=dataset,
                                       upstream_anomaly=upstream)
            except Exception as exc:
                # One KPI must not take the sweep down. Previously an exception here aborted the
                # loop, so every remaining KPI went uninvestigated -- and the scheduler's
                # catch-all logged a single line, so the only visible symptom was "fewer insights
                # than expected". Record it as a result so the failure is countable.
                logger.exception("investigation failed for %s/%s", tenant_id, contract.id)
                results.append({
                    "tenant_id": tenant_id,
                    "kpi_id": contract.id,
                    "investigation_id": "",
                    "status": "error",
                    "terminal_stage": "investigate",
                    "termination_reason": "exception: %s" % type(exc).__name__,
                    "trust": None,
                    "anomaly": None,
                    "causes": [],
                    "insights": [],
                })
                continue
            if res.get("anomaly"):
                opened[contract.id] = res["anomaly"]
            results.append(res)

        self._apply_fdr(results)
        return results

    @staticmethod
    def _apply_fdr(results: list[dict]) -> None:
        """Benjamini-Hochberg across the KPIs tested together.

        Testing five series at once manufactures alarms; a KPI that only looks unlikely because
        several were tried is marked suppressed_fdr rather than surfaced.
        """
        found = [r for r in results if r.get("anomaly")]
        if len(found) < 2:
            return
        keep = detect.benjamini_hochberg([float(r["anomaly"].get("p_value", 1.0)) for r in found])
        for r, survives in zip(found, keep):
            if survives:
                continue
            r["anomaly"]["status"] = "suppressed_fdr"
            try:
                store.write_anomaly(r["anomaly"])
            except Exception:
                logger.exception("could not record FDR suppression for %s", r.get("kpi_id"))
