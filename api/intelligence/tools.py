"""The agent's capabilities: deterministic tools it may choose to call.

This is the reliability half of the hybrid. Every tool reads through the Metric API or the Signal
Store reader -- never raw SQL over `events_raw` (rule 4) -- and returns numbers already computed
and verified by a pipeline stage. The orchestrator decides WHICH tools to call and in what order;
a tool never decides anything.

Adding a capability is adding one `ToolSpec` here. The planner reads the catalogue at runtime, so
a new tool becomes available to the agent without touching the orchestration layer -- which is the
whole point of separating the two.

Each spec carries:
  * `params`   -- validated before execution. An argument the schema does not name is refused, so
                  a hallucinated tool call fails closed instead of running something unintended.
  * `intent`   -- the persona entitlement this tool sits behind. Filtering happens when the
                  catalogue is built, so a persona never even sees a tool it may not use.
  * `selectors`-- cue words the dependency-free planner scores against. The LLM planner ignores
                  these and reads `description` instead.
  * `render`   -- how this tool's result reads in prose, kept next to the numbers it phrases.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from api.intelligence import config, personas, phrasing, reader

_DISPLAY_NAMES: dict[str, str] | None = None


def pretty_name(kpi_id: str) -> str:
    """A contract's own `name` beats title-casing the id, which produced "Kyc Completion"."""
    global _DISPLAY_NAMES
    if _DISPLAY_NAMES is None:
        try:
            from api.intelligence.contracts import load_declared
            _DISPLAY_NAMES = {k: str(c.raw.get("name") or "") for k, c in load_declared().items()}
        except Exception:
            _DISPLAY_NAMES = {}
    return _DISPLAY_NAMES.get(kpi_id) or (kpi_id or "").replace("_", " ").replace(".", " ").title()


@dataclass
class ToolResult:
    """What a tool observed. `claims` are numbers; `facts` are labels; `citation` is provenance."""
    ok: bool
    summary: str = ""
    claims: list[dict] = field(default_factory=list)     # {claim_id,value,unit,source,label}
    facts: dict[str, str] = field(default_factory=dict)
    data: dict = field(default_factory=dict)             # structured payload for later steps
    citation: str = ""                                   # the table the numbers came from
    reason: str = ""                                     # why nothing was returned

    def as_dict(self) -> dict:
        return {"ok": self.ok, "summary": self.summary, "claims": self.claims,
                "facts": self.facts, "citation": self.citation, "reason": self.reason}


@dataclass
class ToolSpec:
    name: str
    description: str
    intent: str                       # persona entitlement gate
    params: dict[str, dict]
    fn: Callable[..., ToolResult]
    selectors: tuple[str, ...] = ()
    needs_metric: bool = False        # the planner must resolve a kpi_id first
    # True when the metric must be NAMED in the question. "What is X" about an unnamed metric is
    # not a question about the standing finding -- answering it from the focus metric explains
    # something nobody asked about.
    needs_named_metric: bool = False
    # Narrative order when several tools answer one question: the movement is stated before it is
    # localised, decomposed or acted on. Scoring decides WHICH tools run; this decides the telling.
    priority: int = 5
    render: Callable[[ToolResult, str], str] | None = None

    def signature(self) -> dict:
        return {"name": self.name, "description": self.description,
                "parameters": self.params, "needs_metric": self.needs_metric}


def _claim(claim_id: str, value, unit: str, source: str, label: str, dp: int = 2) -> dict:
    """Record a number AT THE PRECISION IT WILL BE SHOWN.

    Formatting a stored 57.716 as 57.72 states a number no row contains and the verifier rejects
    the whole answer -- correctly. Rounding here keeps prose and evidence identical.
    """
    return {"claim_id": claim_id, "value": round(float(value), dp), "unit": unit,
            "source": source, "label": label}


# ── capabilities ───────────────────────────────────────────────────────────────────────────────
def _list_metrics(tenant_id: str, persona: str, **_) -> ToolResult:
    rows = reader.list_insights(tenant_id, persona, limit=config.MAX_KPIS_PER_SWEEP)
    if not rows:
        return ToolResult(False, reason="no investigation has produced evidence for this tenant")
    try:
        from api.intelligence.contracts import load_declared
        governed = set(load_declared())
    except Exception:
        governed = set()
    visible = sorted({r["kpi_id"] for r in rows})
    tier1 = [k for k in visible if k in governed]
    moved = sorted({r["kpi_id"] for r in rows if r.get("anomaly_id")})
    return ToolResult(
        True,
        summary="%d metrics investigated, %d governed, %d currently outside band"
                % (len(visible), len(tier1), len(moved)),
        claims=[_claim("total_count", len(visible), "count", "insights", "metrics investigated", 0),
                _claim("governed_count", len(tier1), "count", "insights", "governed metrics", 0)],
        facts={"governed": ", ".join(pretty_name(k) for k in tier1),
               "flagged": ", ".join(pretty_name(k) for k in moved[:6])},
        data={"visible": visible, "governed": tier1, "moved": moved},
        citation="insights")


def _render_list(res: ToolResult, persona: str) -> str:
    return ("I am tracking %.0f metrics for this tenant, of which %.0f are governed contracts "
            "with an owner and a lever list: %s."
            % (res.claims[0]["value"], res.claims[1]["value"], res.facts["governed"] or "none"))


def _get_insight(tenant_id: str, persona: str, kpi_id: str = "", **_) -> ToolResult:
    row = reader.latest_insight(tenant_id, persona, kpi_id or None)
    if not row:
        return ToolResult(False, reason="no recorded insight matches that metric")
    # `magnitude` is the movement in the metric's own units. A percentage without it leaves a
    # reader unable to tell a large move in a small number from one that matters.
    claims = [c for c in (row.get("evidence") or [])
              if c["claim_id"] in ("observed", "baseline", "pct_change", "magnitude")]
    moved = bool((row.get("anomaly_id") or "").strip())
    anomaly = row.get("anomaly") or {}
    measure, cadence, proxy = phrasing.scored_measure(row["kpi_id"])
    window = phrasing.window_phrase(anomaly.get("window_start"), anomaly.get("window_end"))
    facts = {"headline": row.get("headline", "")}
    if window:
        # Recorded as a fact so the dates in it are verifiable text, not unsupported figures.
        facts["window"] = window
    return ToolResult(
        True,
        summary="%s: %s" % (row["kpi_id"], "movement recorded" if moved else "within band"),
        claims=claims, facts=facts,
        data={"insight": row, "kpi_id": row["kpi_id"], "moved": moved,
              "trust_verdict": row.get("trust_verdict", ""), "anomaly": anomaly,
              "window": window, "measure": measure, "cadence": cadence, "proxy": proxy},
        citation="insights")


_METHOD = {"forecast_band": "a stored forecast band",
           "mad": "a robust z-score against its own recent history",
           "rule": "a threshold declared in its contract"}


def _render_insight(res: ToolResult, persona: str) -> str:
    """State what moved, by how much, over which window, and in what units.

    The old rendering said "It moved to 97.00 against an expected 54.00" -- three ways to mislead
    in one clause. No window, so the figure floated in time; no unit, so 97 read as a percentage
    of a metric called a rate; no absolute change, so a reader could not tell whether 79.6% was a
    real move. All three are stated now, and the unit is the honest one: a ratio is never scored
    on itself, so the figure is the additive count underneath it.
    """
    level = personas.detail(persona)
    row = res.data["insight"]
    anomaly = res.data.get("anomaly") or {}
    name = pretty_name(row["kpi_id"])
    measure, cadence = res.data.get("measure", ""), res.data.get("cadence", "")
    by_id = {c["claim_id"]: c["value"] for c in res.claims}
    window = res.data.get("window", "")
    over = " over %s" % window if window else ""

    if not res.data["moved"]:
        text = ("%s stayed inside its expected range%s, so there is no movement to explain."
                % (name, over))
        if "observed" in by_id:
            text += " It read %s." % phrasing.quantity(by_id["observed"], measure, cadence)
        return text

    rose = int(anomaly.get("direction") or 1) >= 0
    # A percentage change against an expected zero is division guarded by an epsilon, not a
    # measurement: it rendered as "rose 19600.0%". State the move in units and say why there is
    # no percentage, rather than publishing a figure that only looks precise.
    from_nothing = "baseline" in by_id and abs(by_id["baseline"]) < 1e-9
    out = []
    if from_nothing:
        out.append("%s moved outside its expected range%s: it was expected to be absent "
                   "altogether, so there is no meaningful percentage to quote." % (name, over))
        if "observed" in by_id:
            out.append("It read %s."
                       % phrasing.quantity(by_id["observed"], measure, cadence))
    elif "pct_change" in by_id:
        out.append("%s %s %.1f%%%s." % (name, "rose" if rose else "fell",
                                        by_id["pct_change"], over))
    else:
        out.append("%s moved outside its expected range%s." % (name, over))

    if not from_nothing and "observed" in by_id and "baseline" in by_id:
        reading = ("The reading was %s against an expected %s"
                   % (phrasing.quantity(by_id["observed"], measure, cadence),
                      phrasing.quantity(by_id["baseline"], "", "")))
        if "magnitude" in by_id:
            reading += (" — %s of %s"
                        % ("a rise" if rose else "a fall",
                           phrasing.quantity(by_id["magnitude"], measure, cadence)))
        out.append(reading + ".")

    # Persona-invariant: WHICH number this is cannot depend on who is reading it. Only the length
    # of the explanation varies.
    if res.data.get("proxy") and measure:
        out.append("The figure scored is %s, not the rate itself." % measure
                   if level == "summary" else
                   "The figure scored is %s, the additive count %s is built from, not the rate "
                   "itself — a ratio does not re-aggregate across segments, so it is never "
                   "scored directly." % (measure, name))

    if level != "summary":
        clause = phrasing.severity_clause(anomaly.get("severity", ""))
        if clause:
            out.append(clause)
    if level == "full" and anomaly.get("method"):
        out.append("Detected against %s."
                   % _METHOD.get(anomaly["method"], anomaly["method"].replace("_", " ")))
    return " ".join(out)


def _get_causes(tenant_id: str, persona: str, kpi_id: str = "", **_) -> ToolResult:
    row = reader.latest_insight(tenant_id, persona, kpi_id or None)
    causes = (row or {}).get("causes") or []
    if not causes:
        return ToolResult(False, reason="no segment was localized for this movement")
    level = personas.detail(persona)
    shown = causes[:1] if level == "summary" else causes[:config.MAX_CAUSES]
    kpi_id = (row or {}).get("kpi_id", "")
    measure, _cadence, _proxy = phrasing.scored_measure(kpi_id)
    claims, facts = [], {}
    for cause in shown:
        # The readable label IS the stored label. A cell shown as `txn_type=PAYMENT` on the
        # evidence card and "payment transactions" in the prose is one row described twice, and
        # a reader has no way to tell which description is the real one.
        facts["cell_%d" % cause["rank"]] = phrasing.cell_phrase(cause["dimensions"])
        # Whole percent for a summary reader, one decimal otherwise. The claim is stored at the
        # precision it is shown, so prose and evidence cannot disagree.
        claims.append(_claim("cell_%d_share" % cause["rank"], cause["contribution"] * 100.0,
                             "percent", "root_causes", "rank %d share" % cause["rank"],
                             0 if level == "summary" else 1))
    return ToolResult(True, summary="%d driver(s) ranked" % len(causes), claims=claims,
                      facts=facts,
                      data={"causes": causes, "shown": shown, "kpi_id": kpi_id,
                            "measure": measure or (shown[0].get("fundamental") or ""),
                            "method": (shown[0] or {}).get("method", "")},
                      citation="root_causes")


_LOCALIZE_METHOD = {
    "greedy_cube": "a greedy cube search over the dimensions the contract declares",
    "groupby": "a single-dimension group-by",
}


def _render_causes(res: ToolResult, persona: str) -> str:
    """Same drivers for everyone; how much of them is shown is the persona's depth.

    Two things the flat "concentrates in: a; b; c" list got wrong at every depth. It named the KPI
    as the thing being decomposed, when Localize works on an additive FUNDAMENTAL and a rate is
    never sliced. And it listed NESTED cells side by side, which invites a reader to add shares
    that are each measured against the whole movement -- cumulative `explained_pct` reached 2.07
    on live data.
    """
    level = personas.detail(persona)
    shown = res.data["shown"]
    subject = "The movement in %s" % (res.data.get("measure") or pretty_name(res.data["kpi_id"]))

    def label(i: int) -> str:
        return res.facts["cell_%d" % shown[i]["rank"]]

    # Share stated after the segment, never as a relative clause: "payment transactions, which
    # accounts for" and "branch NE-033, which account for" are both wrong, and the subject is a
    # stored label whose number the renderer cannot know.
    if level == "summary":
        return ("%s is concentrated in %s, at %.0f%% of the total."
                % (subject, label(0), res.claims[0]["value"]))

    text = ("%s is most concentrated in %s, at %.1f%% of the total."
            % (subject, label(0), res.claims[0]["value"]))
    rest = ["%s (%.1f%%)" % (label(i), res.claims[i]["value"]) for i in range(1, len(shown))]
    if rest:
        text += " Behind it: %s." % phrasing.join(rest)
    note = phrasing.overlap_note(shown)
    if note:
        text += " " + note
    if level == "full" and res.data.get("method"):
        text += (" Localised by %s."
                 % _LOCALIZE_METHOD.get(res.data["method"],
                                        res.data["method"].replace("_", " ")))
    return text


def _get_factors(tenant_id: str, persona: str, kpi_id: str = "", **_) -> ToolResult:
    row = reader.latest_insight(tenant_id, persona, kpi_id or None)
    factors = (row or {}).get("factors") or []
    if not factors:
        return ToolResult(False, reason="this metric declares no factor identity to decompose")
    claims = [_claim("factor_%s" % f["factor"], f["contribution"] * 100.0, "percent",
                     "root_causes", "%s share" % f["factor"], 1) for f in factors]
    return ToolResult(True, summary="%d factor(s)" % len(factors), claims=claims,
                      facts={"factors": ", ".join(f["factor"] for f in factors)},
                      data={"factors": factors}, citation="root_causes")


def _render_factors(res: ToolResult, persona: str) -> str:
    lines = ["%s %.1f%%" % (c["claim_id"].replace("factor_", "").replace("_", " "), c["value"])
             for c in res.claims]
    return "By factor, the change splits as: %s." % ", ".join(lines)


def _get_forecast(tenant_id: str, persona: str, kpi_id: str = "", **_) -> ToolResult:
    row = reader.latest_insight(tenant_id, persona, kpi_id or None)
    claims = [c for c in ((row or {}).get("evidence") or [])
              if c["claim_id"] in ("forecast_point", "forecast_lower", "forecast_upper")]
    if not any(c["claim_id"] == "forecast_point" for c in claims):
        return ToolResult(False, reason="no forecast band was recorded for this metric")
    kpi_id = (row or {}).get("kpi_id", "")
    measure, cadence, _proxy = phrasing.scored_measure(kpi_id)
    return ToolResult(True, summary="forecast band on record", claims=claims,
                      data={"kpi_id": kpi_id, "measure": measure, "cadence": cadence},
                      citation="forecasts")


def _render_forecast(res: ToolResult, persona: str) -> str:
    by_id = {c["claim_id"]: c["value"] for c in res.claims}
    point = by_id["forecast_point"]
    measure, cadence = res.data.get("measure", ""), res.data.get("cadence", "")
    return ("The recorded forecast for %s is %s, within a band of %s to %s."
            % (pretty_name(res.data["kpi_id"]),
               phrasing.quantity(point, measure, cadence),
               phrasing.quantity(by_id.get("forecast_lower", point), "", ""),
               phrasing.quantity(by_id.get("forecast_upper", point), "", "")))


def _is_governed(kpi_id: str) -> bool:
    """The tier boundary, asked once. Callers never inspect contract fields to infer it."""
    if not kpi_id:
        return False
    try:
        from api.intelligence.contracts import load_declared
        contract = load_declared().get(kpi_id)
    except Exception:
        return False
    return bool(contract and contract.governed)


def _get_recommendations(tenant_id: str, persona: str, kpi_id: str = "", **_) -> ToolResult:
    row = reader.latest_insight(tenant_id, persona, kpi_id or None)
    resolved = (row or {}).get("kpi_id", "")
    if resolved and not _is_governed(resolved):
        # Silence and "nothing to do" are different answers. An auto-discovered series has no
        # decision block at all, so reporting an empty lever list as "no action applies" says we
        # looked and found nothing -- when the truth is that nobody owns this metric.
        return ToolResult(False,
                          reason="%s is an auto-discovered series with no governing contract, so "
                                 "it carries no owner and no levers" % pretty_name(resolved))
    anomaly_id = (row or {}).get("anomaly_id") or ""
    if not anomaly_id:
        # Without an anomaly the reader returns the tenant's whole lever list, which then reads as
        # advice about a metric that never moved. Say so instead.
        return ToolResult(False, reason="%s is within its expected range, so no action is proposed"
                                        % pretty_name((row or {}).get("kpi_id", "this metric")))
    recs = reader.recommendations(tenant_id, limit=config.MAX_CAUSES, anomaly_id=anomaly_id)
    if not recs:
        return ToolResult(False, reason="no lever in the contract's closed list applies here")
    mine = [r for r in recs if personas.owns(persona, r.get("owner_role", ""))]
    theirs = [r for r in recs if r not in mine]
    claims, facts = [], {}
    for rec in mine:
        claims.append(_claim("impact_%s" % rec["rec_id"],
                             (rec.get("expected_impact") or {}).get("high", 0.0),
                             "count", "recommendations", "recoverable impact"))
        facts["lever_%s" % rec["rec_id"]] = "%s (%s)" % (rec["lever"], rec["owner_role"])
    if theirs:
        claims.append(_claim("referred_actions", len(theirs), "count", "recommendations",
                             "actions owned elsewhere", 0))
    return ToolResult(True, summary="%d owned, %d referred" % (len(mine), len(theirs)),
                      claims=claims, facts=facts, data={"mine": mine, "theirs": theirs},
                      citation="recommendations")


def _render_recommendations(res: ToolResult, persona: str) -> str:
    mine, theirs = res.data["mine"], res.data["theirs"]
    by_id = {c["claim_id"]: c["value"] for c in res.claims}
    lines = ["%s -- lever %s, owner %s, worth up to %.2f if fully recovered"
             % (r["action"], r["lever"], r["owner_role"], by_id["impact_%s" % r["rec_id"]])
             for r in mine]
    text = ("Proposed, pending approval: %s. Nothing is executed automatically." % "; ".join(lines)
            if lines else "No lever here is yours to pull.")
    if theirs:
        owners = ", ".join(sorted({r.get("owner_role", "unassigned") for r in theirs}))
        text += (" %d further action%s sit%s with %s."
                 % (len(theirs), "" if len(theirs) == 1 else "s",
                    "s" if len(theirs) == 1 else "", owners))
    return text


def _get_trust(tenant_id: str, persona: str, kpi_id: str = "", **_) -> ToolResult:
    row = reader.latest_insight(tenant_id, persona, kpi_id or None)
    if not row:
        return ToolResult(False, reason="no recorded insight matches that metric")
    trust = row.get("trust") or {}
    claims = [
        _claim("checks_passed", trust.get("passed", 0), "count", "trust_findings",
               "checks passed", 0),
        _claim("checks_failed", trust.get("failed", 0), "count", "trust_findings",
               "checks failed", 0),
        _claim("confidence", (row.get("confidence") or 0.0) * 100.0, "percent", "insights",
               "confidence", 0),
    ]
    return ToolResult(True, summary="verdict %s" % row.get("trust_verdict", "ambiguous"),
                      claims=claims, facts={"verdict": row.get("trust_verdict", "ambiguous")},
                      data={"kpi_id": row["kpi_id"], "verdict": row.get("trust_verdict", "")},
                      citation="trust_findings")


def _render_trust(res: ToolResult, persona: str) -> str:
    by_id = {c["claim_id"]: c["value"] for c in res.claims}
    tail = {"pass": "The metric is safe to act on.",
            "fail": "The metric is quarantined; treat the figures as unreliable."}.get(
                res.data["verdict"], "The evidence is ambiguous; treat the figures with caution.")
    return ("Trust verdict for %s is '%s': %.0f checks passed, %.0f failed, confidence %.0f%%. %s"
            % (pretty_name(res.data["kpi_id"]), res.data["verdict"] or "ambiguous",
               by_id["checks_passed"], by_id["checks_failed"], by_id["confidence"], tail))


def _get_source_health(tenant_id: str, persona: str, **_) -> ToolResult:
    sources = reader.source_health(tenant_id)
    if not sources:
        return ToolResult(False, reason="no source has reported a load yet")
    claims, facts = [], {}
    for src in sources:
        claims.append(_claim("behind_%s" % src["source_id"], src.get("minutes_behind") or 0.0,
                             "count", "source_freshness",
                             "%s minutes behind" % src["source_id"], 0))
        facts["cadence_%s" % src["source_id"]] = src.get("cadence", "")
    breached = [s["source_id"] for s in sources if not s.get("within_sla")]
    return ToolResult(True, summary="%d source(s), %d outside SLA" % (len(sources), len(breached)),
                      claims=claims, facts=facts,
                      data={"sources": sources, "breached": breached}, citation="source_freshness")


def _render_source_health(res: ToolResult, persona: str) -> str:
    by_id = {c["claim_id"]: c["value"] for c in res.claims}
    lines = ["%s (%s) is %.0f minutes behind and is %s SLA"
             % (s["source_id"], s.get("cadence", "unknown"), by_id["behind_%s" % s["source_id"]],
                "within" if s.get("within_sla") else "outside")
             for s in res.data["sources"]]
    return "; ".join(lines) + "."


def _get_runtime_cost(tenant_id: str, persona: str, **_) -> ToolResult:
    tel = reader.runtime_telemetry(tenant_id)
    claims = [
        _claim("total_runs", tel["total_runs"], "count", "model_runs", "stage runs", 0),
        _claim("llm_share", tel["llm_share_pct"], "percent", "model_runs", "LLM share", 1),
        _claim("latency_ms", tel["total_latency_ms"], "count", "model_runs", "total latency", 0),
        _claim("tokens", tel["total_tokens"], "count", "model_runs", "total tokens", 0),
    ]
    return ToolResult(True, summary="%s stage runs" % tel["total_runs"], claims=claims,
                      data={"telemetry": tel}, citation="model_runs")


def _render_runtime_cost(res: ToolResult, persona: str) -> str:
    by_id = {c["claim_id"]: c["value"] for c in res.claims}
    return ("Across %.0f stage runs, %.1f%% were LLM calls, totalling %.0f ms and %.0f tokens."
            % (by_id["total_runs"], by_id["llm_share"], by_id["latency_ms"], by_id["tokens"]))


def _rank_movements(tenant_id: str, persona: str, **_) -> ToolResult:
    """Priority order over GOVERNED metrics only.

    Materiality on a governed KPI means "does this warrant a decision"; on an auto-discovered
    series it can only mean "is this statistically unusual". Those are not the same score, and
    ranking them together put page-view series at the top of the analyst's default view.
    Auto-discovered series stay answerable on request through `get_insight`.
    """
    try:
        rows = reader.top_movements(tenant_id, persona, limit=config.MAX_CAUSES,
                                    governed_only=True)
    except reader.RegistryUnavailable as exc:
        return ToolResult(False, reason="I cannot tell which metrics are governed right now (%s), "
                                        "so I will not present a priority order" % exc)
    if not rows:
        return ToolResult(False,
                          reason="no governed metric is currently outside its expected band")
    claims, facts = [], {}
    for i, row in enumerate(rows, start=1):
        claims.append(_claim("materiality_%d" % i, float(row.get("materiality") or 0.0) * 100.0,
                             "percent", "anomalies", "%s materiality" % row["kpi_id"], 1))
        facts["kpi_%d" % i] = pretty_name(row["kpi_id"])
        facts["severity_%d" % i] = str(row.get("severity") or "info")
    return ToolResult(True, summary="%d metric(s) outside band" % len(rows), claims=claims,
                      facts=facts, data={"rows": rows}, citation="anomalies")


def _render_rank(res: ToolResult, persona: str) -> str:
    lines = ["%s (%s, materiality %.1f%%)"
             % (res.facts["kpi_%d" % i], res.facts["severity_%d" % i], c["value"])
             for i, c in enumerate(res.claims, start=1)]
    # Naming the scope is not decoration: the reader needs to know an auto-discovered series that
    # also moved is deliberately absent, not overlooked.
    return "Among governed metrics: %s." % "; ".join(lines)


def _get_metric_contract(tenant_id: str, persona: str, kpi_id: str = "", **_) -> ToolResult:
    from api.intelligence.contracts import load_declared
    try:
        declared = load_declared()
    except Exception:
        declared = {}
    contract = declared.get(kpi_id)
    if not contract:
        return ToolResult(False, reason="that metric has no governed contract, so it carries no "
                                        "published definition")
    raw = contract.raw
    # Contract prose is quoted verbatim; recording it as a fact lets any figure inside it stand as
    # sourced text rather than an unverifiable number.
    facts = {"definition": " ".join(str(raw.get("definition") or "").split()),
             "formula": str(raw.get("formula") or ""),
             "owner": (raw.get("decision") or {}).get("owner") or "unassigned",
             "unit": str(raw.get("unit") or "n/a"),
             "grain": str((raw.get("grain") or {}).get("entity") or "event"),
             "name": str(raw.get("name") or kpi_id)}
    return ToolResult(True, summary="contract for %s" % kpi_id, facts=facts,
                      data={"kpi_id": kpi_id}, citation="contracts")


def _render_contract(res: ToolResult, persona: str) -> str:
    f = res.facts
    definition = f["definition"]
    if definition and not definition.endswith("."):
        definition += "."
    return ("%s (%s). %s Formula: %s; unit: %s; measured at %s grain. Owned by %s."
            % (f["name"], res.data["kpi_id"], definition, f["formula"] or "n/a", f["unit"],
               f["grain"], f["owner"]))


def _compare_metrics(tenant_id: str, persona: str, kpi_ids: str = "", **_) -> ToolResult:
    """Side by side, from each metric's own recorded insight. Added as a plain registry entry --
    the orchestrator needed no change to start using it."""
    ids = [k.strip() for k in (kpi_ids or "").split(",") if k.strip()][:4]
    if len(ids) < 2:
        return ToolResult(False, reason="a comparison needs at least two metrics")
    claims, facts, found = [], {}, []
    for kpi in ids:
        row = reader.latest_insight(tenant_id, persona, kpi)
        if not row:
            continue
        # A metric inside its band has no `observed` claim; that is a comparable state, not a
        # reason to drop it. Requiring one made every comparison of two quiet metrics fail.
        by_id = {c["claim_id"]: c for c in (row.get("evidence") or [])}
        found.append(kpi)
        facts["name_%s" % kpi] = pretty_name(kpi)
        facts["state_%s" % kpi] = "moved" if (row.get("anomaly_id") or "") else "within band"
        if "observed" in by_id:
            claims.append(_claim("observed_%s" % kpi, by_id["observed"]["value"], "count",
                                 "insights", "%s observed" % kpi))
        if "pct_change" in by_id:
            claims.append(_claim("change_%s" % kpi, by_id["pct_change"]["value"], "percent",
                                 "insights", "%s change" % kpi, 1))
    if len(found) < 2:
        return ToolResult(False, reason="fewer than two of those metrics have a recorded insight")
    return ToolResult(True, summary="compared %d metrics" % len(found), claims=claims, facts=facts,
                      data={"kpis": found}, citation="insights")


def _render_compare(res: ToolResult, persona: str) -> str:
    by_id = {c["claim_id"]: c["value"] for c in res.claims}
    parts = []
    for kpi in res.data["kpis"]:
        name = res.facts["name_%s" % kpi]
        if "observed_%s" % kpi in by_id:
            bit = "%s at %.2f" % (name, by_id["observed_%s" % kpi])
            if "change_%s" % kpi in by_id:
                bit += " (%.1f%% change)" % by_id["change_%s" % kpi]
        else:
            bit = "%s %s" % (name, res.facts["state_%s" % kpi])
        parts.append(bit)
    return "Side by side: %s." % "; ".join(parts)


def _greet(tenant_id: str, persona: str, **_) -> ToolResult:
    """Greeting is a capability like any other, so the planner picks it rather than the loop
    branching on the question shape."""
    profile = personas.get(persona)
    rows = reader.list_insights(tenant_id, persona, limit=config.MAX_KPIS_PER_SWEEP)
    try:
        from api.intelligence.contracts import load_declared
        governed = set(load_declared())
    except Exception:
        governed = set()
    moved = sorted({r["kpi_id"] for r in rows if r.get("anomaly_id")})
    # Governed contracts first: a page-view metric is not what anyone is greeted with.
    ordered = [k for k in moved if k in governed] + [k for k in moved if k not in governed]
    return ToolResult(True, summary="greeting context",
                      facts={"flagged": ", ".join(pretty_name(k) for k in ordered[:4]),
                             "any_flagged": "yes" if ordered else "no"},
                      data={"profile": profile}, citation="insights")


def _render_greet(res: ToolResult, persona: str) -> str:
    profile = personas.get(persona)
    parts = [profile.greeting, profile.remit]
    if res.facts.get("any_flagged") == "yes":
        parts.append("Currently flagged: %s." % res.facts["flagged"])
    else:
        parts.append("Nothing is currently outside its expected band.")
    if profile.examples:
        parts.append("Ask me anything about them — for example “%s”."
                     % profile.examples[0])
    return " ".join(parts)


def _describe_capabilities(tenant_id: str, persona: str, **_) -> ToolResult:
    profile = personas.get(persona)
    names = sorted(s.name for s in catalogue(persona)
                   if s.intent not in ("greeting", "help"))
    return ToolResult(True, summary="%d capabilities" % len(names),
                      facts={"tools": ", ".join(names)}, data={"names": names},
                      citation="tools")


def _render_capabilities(res: ToolResult, persona: str) -> str:
    profile = personas.get(persona)
    readable = res.facts["tools"].replace("_", " ")
    text = ("As %s I can: %s. I answer only from recorded investigations, so every figure traces "
            "to a stored row and I abstain rather than estimate." % (profile.label, readable))
    if profile.examples:
        text += " Try: %s." % "; ".join("“%s”" % e for e in profile.examples)
    return text


# ── registry ───────────────────────────────────────────────────────────────────────────────────
_TENANT = {"tenant_id": {"type": "string", "required": True,
                         "description": "tenant the question is scoped to"}}
_KPI = {"kpi_id": {"type": "string", "required": False,
                   "description": "metric id; omit to use the most material recorded finding"}}

REGISTRY: dict[str, ToolSpec] = {
    spec.name: spec for spec in [
        ToolSpec("greet",
                 "Greet the user and say which metrics are currently flagged. Use for a "
                 "salutation or thanks, never alongside an analytical tool.",
                 "greeting", dict(_TENANT), _greet,
                 selectors=("hello", "hi", "hii", "hey", "yo", "hiya", "greetings", "morning",
                            "afternoon", "evening", "thanks", "thank", "thanx", "cheers", "who are you",
                            "what are you", "introduce yourself"),
                 render=_render_greet, priority=0),
        ToolSpec("describe_capabilities",
                 "Explain what this persona can ask about. Use when the user asks for help or "
                 "what the agent can do.",
                 "help", dict(_TENANT), _describe_capabilities,
                 selectors=("help", "what can you", "what can i ask", "capabilit",
                            "how do i use", "what questions"),
                 render=_render_capabilities, priority=0),
        ToolSpec("list_metrics",
                 "List the metrics investigated for this tenant, marking which are governed "
                 "contracts and which are currently outside their band.",
                 "catalog", dict(_TENANT), _list_metrics,
                 selectors=("kpis", "metrics do you", "track", "cover", "list", "contracts"),
                 render=_render_list, priority=2),
        ToolSpec("get_insight",
                 "The recorded finding for a metric: whether it moved, its observed and expected "
                 "values, and the headline. Start here for any question about a specific metric.",
                 "status", {**_TENANT, **_KPI}, _get_insight,
                 selectors=("what happened", "summary", "status", "overview", "changed",
                            "why", "cause", "drove", "reason"),
                 needs_metric=True, render=_render_insight, priority=1),
        ToolSpec("get_causes",
                 "Which dimension cells the movement concentrated in, ranked by contribution. "
                 "Root-cause analysis: use it whenever the question asks why something moved.",
                 "cause", {**_TENANT, **_KPI}, _get_causes,
                 selectors=("where", "segment", "concentrat", "breakdown", "region", "device",
                            "channel", "split", "why", "drove", "cause", "reason", "explain"),
                 needs_metric=True, render=_render_causes, priority=2),
        ToolSpec("get_factors",
                 "Factor decomposition: how much of the change was price, volume, mix or "
                 "entry/exit.",
                 "factor", {**_TENANT, **_KPI}, _get_factors,
                 selectors=("price", "volume", "mix", "factor", "decompos"),
                 needs_metric=True, render=_render_factors, priority=3),
        ToolSpec("get_forecast",
                 "The forecast point and band the metric was scored against.",
                 "forecast", {**_TENANT, **_KPI}, _get_forecast,
                 selectors=("forecast", "outlook", "expect", "predict", "projection", "next week",
                            "trend"),
                 needs_metric=True, render=_render_forecast, priority=3),
        ToolSpec("get_recommendations",
                 "Proposed actions from the metric contract's closed lever list, scoped to the "
                 "levers this persona owns.",
                 "action", {**_TENANT, **_KPI}, _get_recommendations,
                 selectors=("what should", "action", "recommend", "fix", "do about", "next step",
                            "lever", "mitigat", "remediat"),
                 needs_metric=True, render=_render_recommendations, priority=6),
        ToolSpec("get_trust",
                 "Trust Gate verdict and check counts: whether the figure is safe to act on.",
                 "trust", {**_TENANT, **_KPI}, _get_trust,
                 selectors=("trust", "reliable", "confidence", "verified", "quarantine",
                            "accurate"),
                 needs_metric=True, render=_render_trust, priority=7),
        ToolSpec("get_source_health",
                 "How far behind each connected source is and whether it is within SLA.",
                 "freshness", dict(_TENANT), _get_source_health,
                 selectors=("fresh", "stale", "up to date", "last load", "source", "sla",
                            "pipeline", "lag", "how current", "how recent"),
                 render=_render_source_health, priority=8),
        ToolSpec("get_runtime_cost",
                 "Runtime telemetry: stage runs, LLM share, latency and tokens.",
                 "cost", dict(_TENANT), _get_runtime_cost,
                 selectors=("cost", "token", "latency", "spend", "llm", "how much did"),
                 render=_render_runtime_cost, priority=9),
        ToolSpec("rank_movements",
                 "The metrics currently outside their band, ordered by recorded materiality. "
                 "Use when the question asks what to look at rather than about one metric.",
                 "ranking", dict(_TENANT), _rank_movements,
                 selectors=("moved most", "biggest", "worst", "top", "most material",
                            "most severe", "look at", "priorit", "rank"),
                 render=_render_rank, priority=1),
        ToolSpec("get_metric_contract",
                 "The published definition, formula, unit, grain and owner of a governed metric.",
                 "definition", {**_TENANT, **_KPI}, _get_metric_contract,
                 selectors=("what is", "define", "definition", "formula", "calculated",
                            "computed", "measured", "mean by"),
                 needs_metric=True, render=_render_contract, priority=1, needs_named_metric=True),
        ToolSpec("compare_metrics",
                 "Compare two or more metrics side by side using their recorded insights.",
                 "status", {**_TENANT,
                            "kpi_ids": {"type": "string", "required": True,
                                        "description": "comma-separated metric ids"}},
                 _compare_metrics,
                 selectors=("compare", "versus", " vs ", "against each other", "side by side"),
                 render=_render_compare, priority=1, needs_named_metric=True),
    ]
}


def catalogue(persona: str) -> list[ToolSpec]:
    """Tools this persona may use. Entitlement is applied here, before the planner sees anything.

    A tool the persona cannot use is absent from the catalogue rather than refused at execution --
    so the model is never tempted to plan around a capability it will not be allowed to run.
    """
    return [spec for spec in REGISTRY.values() if personas.allows(persona, spec.intent)]


class ToolError(Exception):
    pass


def validate_call(name: str, args: dict, persona: str) -> dict:
    """Guardrail. Refuses an unknown tool, an unentitled one, or an argument the schema omits."""
    spec = REGISTRY.get(name)
    if spec is None:
        raise ToolError("unknown tool '%s'" % name)
    if not personas.allows(persona, spec.intent):
        raise ToolError("the %s persona may not use '%s'" % (persona, name))
    unknown = [k for k in args if k not in spec.params]
    if unknown:
        raise ToolError("unexpected argument(s) %s for '%s'" % (", ".join(sorted(unknown)), name))
    for key, meta in spec.params.items():
        if meta.get("required") and not str(args.get(key, "")).strip():
            raise ToolError("'%s' requires %s" % (name, key))
    return {k: v for k, v in args.items() if k in spec.params}


def run(name: str, args: dict, persona: str) -> ToolResult:
    """Execute one validated call. A tool that raises becomes an observation, never a 500."""
    spec = REGISTRY[name]
    try:
        return spec.fn(persona=persona, **args)
    except Exception as exc:                       # noqa: BLE001 - surfaced as an observation
        return ToolResult(False, reason="tool failed: %s" % exc, citation=name)


def render(name: str, result: ToolResult, persona: str) -> str:
    spec = REGISTRY.get(name)
    if not spec or not spec.render or not result.ok:
        return ""
    try:
        return spec.render(result, persona)
    except Exception:
        return ""
