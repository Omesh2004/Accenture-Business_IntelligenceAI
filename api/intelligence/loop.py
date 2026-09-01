"""The agent loop: reason -> act -> observe -> validate -> re-plan -> synthesize.

No question has a fixed route through this module. The planner reads the tool catalogue and the
observations so far and decides what to call next; this loop only executes what it is given,
records what came back, and asks the critic whether that is enough. Adding a capability to
`tools.py` changes what the agent can do without changing anything here.

Where the flexibility stops:

  * `tools.validate_call` refuses an unknown tool, one this persona may not use, or an argument
    the schema does not name -- so a bad plan fails closed.
  * every figure comes from a tool result and is checked by the same numeric verifier the
    narrator uses. The model may choose the path; it may not choose the numbers.
  * the loop is bounded. It stops on the critic's verdict, or after `AGENT_MAX_ROUNDS`, and
    escalates rather than guessing when nothing came back.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from api.intelligence import (config, gates, llm_client, personas, planner, reader, tools,
                              understanding, visuals)
from api.intelligence.stages import llm_chat
from api.intelligence.stages.narrate import ClaimSet, verify
from api.middleware import hidden_kpis

MAX_ROUNDS = getattr(config, "AGENT_MAX_ROUNDS", 3)
MAX_PARALLEL = 4


def _gate_label(spec, tool: str) -> str:
    """Name the step by the STAGE it answers for, falling back to the capability's own name."""
    gate = gates.BY_ID.get(gates.for_intent(spec.intent)) if spec else None
    return "%s: %s" % (gate.label, gate.question) if gate else "Call %s" % tool


@dataclass
class Step:
    n: int
    label: str
    tool: str
    detail: str = ""
    status: str = "ok"          # ok | skipped | abstained | failed
    ms: int = 0
    kind: str = "act"           # reason | act | observe | validate | synthesize
    # Which pipeline gate this step answered for, so a reader sees the STAGE and not just a
    # function name. Empty for infrastructure steps that belong to no gate.
    gate: str = ""
    # The numbers this step actually read, each with the table it came from. This is what makes
    # the trail auditable rather than decorative: every figure in the answer appears here first.
    evidence: list[dict] = field(default_factory=list)
    citation: str = ""
    why: str = ""               # the planner's stated reason for choosing this call

    def as_dict(self) -> dict:
        return {"n": self.n, "label": self.label, "tool": self.tool, "detail": self.detail,
                "status": self.status, "ms": self.ms, "kind": self.kind, "gate": self.gate,
                "evidence": self.evidence, "citation": self.citation, "why": self.why}


class Trace:
    """Records steps and, when given an `emit`, publishes each one the moment it happens.

    Streaming is why `emit` exists: the same trace object serves the batch endpoint (drained at
    the end) and the SSE endpoint (forwarded live). A failing sink must never take down the run,
    so `emit` is called defensively.
    """

    def __init__(self, emit=None) -> None:
        self.steps: list[Step] = []
        self._mark = time.perf_counter()
        self._emit = emit

    def add(self, label: str, tool: str, detail: str = "", status: str = "ok",
            kind: str = "act", gate: str = "", evidence: list[dict] | None = None,
            citation: str = "", why: str = "") -> Step:
        now = time.perf_counter()
        step = Step(len(self.steps) + 1, label, tool, detail, status,
                    int((now - self._mark) * 1000), kind, gate, list(evidence or []),
                    citation, why)
        self._mark = now
        self.steps.append(step)
        if self._emit is not None:
            try:
                self._emit(step.as_dict())
            except Exception:                                       # noqa: BLE001
                pass
        return step

    def publish(self, kind: str, payload: dict) -> None:
        """Send a non-step event to the stream. Nothing is recorded: the final answer carries the
        same data, so a batch caller loses nothing by not seeing these."""
        if self._emit is None:
            return
        try:
            self._emit({"_event": kind, **payload})
        except Exception:                                           # noqa: BLE001
            pass

    def as_list(self) -> list[dict]:
        return [s.as_dict() for s in self.steps]


@dataclass
class Result:
    answer: str
    persona: str
    persona_label: str
    kpi_id: str = ""
    tools_used: list[str] = field(default_factory=list)
    evidence: list[dict] = field(default_factory=list)
    citations: list[dict] = field(default_factory=list)
    trace: list[dict] = field(default_factory=list)
    abstained: bool = False
    reason: str = ""
    verifier_pass: bool = True
    escalate: bool = False
    issues: list[str] = field(default_factory=list)
    engine_type: str = "rule"
    rounds: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    suggestions: list[str] = field(default_factory=list)
    # One block per capability that contributed, so a reader can see WHICH question each part of
    # the answer belongs to and what it was read from. `answer` stays the flat prose.
    sections: list[dict] = field(default_factory=list)
    # How much the answer is worth relying on, and why. Metadata about the ANSWER -- never stated
    # as prose, so it cannot be mistaken for a figure about the business.
    confidence: float = 0.0
    uncertainty: list[str] = field(default_factory=list)
    # Every pipeline gate with its outcome, including the ones that did not run and why.
    rail: list[dict] = field(default_factory=list)
    # Charts built from the observations themselves, never from a second query.
    visuals: list[dict] = field(default_factory=list)
    # The result sets behind the narrative -- the rows the prose is speaking from.
    datasets: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "answer": self.answer, "persona": self.persona, "persona_label": self.persona_label,
            "kpi_id": self.kpi_id, "tools_used": self.tools_used, "evidence": self.evidence,
            "citations": self.citations, "trace": self.trace, "abstained": int(self.abstained),
            "reason": self.reason, "verifier_pass": int(self.verifier_pass),
            "escalate": int(self.escalate), "issues": self.issues,
            "engine_type": self.engine_type, "rounds": self.rounds,
            "tokens_in": self.tokens_in, "tokens_out": self.tokens_out,
            "suggestions": self.suggestions, "sections": self.sections,
            "confidence": round(self.confidence, 3), "uncertainty": self.uncertainty,
            "rail": self.rail, "visuals": self.visuals, "datasets": self.datasets,
        }


def _build_context(tenant_id: str, question: str, persona: str, trace: Trace,
                   window_days: int = 0) -> planner.Context:
    """Memory the planner reasons over: which metrics exist and which one is in play.

    This is context assembly, not a step of a workflow -- the planner is free to ignore it, call
    `list_metrics` itself, or name a different metric.
    """
    profile = personas.get(persona)
    try:
        rows = reader.list_insights(tenant_id, persona, limit=config.MAX_KPIS_PER_SWEEP,
                                    window_days=window_days)
    except Exception as exc:                                        # noqa: BLE001
        trace.add("Load tenant context", "reader.list_insights", "unavailable: %s" % exc,
                  status="failed", kind="observe")
        rows = []
    metric_ids = sorted({r["kpi_id"] for r in rows})
    moved_ids = sorted({r["kpi_id"] for r in rows if r.get("anomaly_id")})
    ctx = planner.Context(tenant_id, question, persona, metric_ids, moved_ids=moved_ids,
                          window_days=window_days)
    ctx.focus_metric = planner.resolve_metric(question, metric_ids, profile, moved_ids)
    trace.add("Resolve what the question is about", "reader.list_insights",
              "%d metric(s) visible to %s, %d currently outside band%s"
              % (len(metric_ids), profile.label, len(moved_ids),
                 "; the question resolves to %s" % tools.pretty_name(ctx.focus_metric)
                 if ctx.focus_metric else "; no metric named, ranking by materiality"),
              status="ok" if metric_ids else "abstained", kind="observe", gate="scope",
              citation="insights",
              evidence=[{"claim_id": "visible_metrics", "label": "metrics in persona scope",
                         "value": len(metric_ids), "unit": "count", "source": "insights"},
                        {"claim_id": "moved_metrics", "label": "outside band",
                         "value": len(moved_ids), "unit": "count", "source": "anomalies"}])
    return ctx


def _execute(plan: planner.Plan, ctx: planner.Context,
             trace: Trace) -> tuple[list[planner.Observation], list[dict], dict]:
    """Run a round's calls, independent ones together. A failure is an observation, not a crash."""
    prepared: list[tuple[planner.Call, dict | None, str]] = []
    for call in plan.calls:
        try:
            args = tools.validate_call(call.tool, dict(call.args), ctx.persona)
            if "kpi_id" in tools.REGISTRY[call.tool].params and not args.get("kpi_id"):
                args["kpi_id"] = ctx.focus_metric
            prepared.append((call, args, ""))
        except tools.ToolError as exc:
            prepared.append((call, None, str(exc)))

    runnable = [(c, a) for c, a, err in prepared if a is not None]
    # Announce the calls BEFORE running them. A step is only recorded once it has finished, so a
    # 1.3s capability showed nothing at all until it returned; the panel sat on "Reasoning..." and
    # then several lines appeared at once. Publishing the intent first is what makes the run read
    # as work in progress rather than as a spinner followed by a log.
    if runnable:
        trace.publish("pending", {"tools": [
            {"tool": c.tool,
             "gate": gates.for_intent(tools.REGISTRY[c.tool].intent)
                     if c.tool in tools.REGISTRY else "",
             "label": _gate_label(tools.REGISTRY.get(c.tool), c.tool)}
            for c, _ in runnable]})

    results: dict[int, tools.ToolResult] = {}
    if runnable:
        with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(runnable))) as pool:
            futures = {pool.submit(tools.run, c.tool, a, ctx.persona, ctx.window_days): i
                       for i, (c, a) in enumerate(runnable)}
            for future, i in futures.items():
                results[i] = future.result()

    observations: list[planner.Observation] = []
    claims: list[dict] = []
    facts: dict[str, str] = {}
    run_index = 0
    for call, args, err in prepared:
        if args is None:
            trace.add("Refuse %s" % call.tool, "tools.validate_call", err, status="failed")
            observations.append(planner.Observation(call.tool, {}, False, "", "", err))
            continue
        res = results[run_index]
        run_index += 1
        rendered = tools.render(call.tool, res, ctx.persona)
        spec = tools.REGISTRY.get(call.tool)
        trace.add(_gate_label(spec, call.tool), "tools.%s" % call.tool,
                  res.summary or res.reason, status="ok" if res.ok else "abstained",
                  gate=gates.for_intent(spec.intent) if spec else "",
                  evidence=list(res.claims), citation=res.citation, why=call.why)
        obs = planner.Observation(call.tool, args, res.ok, res.summary, res.citation,
                                  res.reason, rendered, dict(res.data), list(res.claims))
        observations.append(obs)
        # Publish this observation's tables and charts NOW rather than with the final answer, so
        # the workspace fills while the agent is still reasoning instead of arriving all at once.
        if res.ok:
            trace.publish("result", {"datasets": visuals.datasets([obs]),
                                     "visuals": visuals.build([obs])})
        if res.ok:
            claims.extend(res.claims)
            facts.update(res.facts)
            if not ctx.focus_metric and res.data.get("kpi_id"):
                ctx.focus_metric = res.data["kpi_id"]
    return observations, claims, facts


def _synthesize(ctx: planner.Context, observations: list[planner.Observation],
                claims: list[dict], facts: dict, trace: Trace) -> tuple[str, bool, str, ClaimSet]:
    """Compose from tool output only, then verify. Returns (text, ok, reason, claim_set)."""
    cs = ClaimSet()
    for claim in claims:
        cs.add(claim["claim_id"], claim["value"], claim["unit"], claim["source"], claim["label"])
    cs.facts.update({k: str(v) for k, v in facts.items()})

    body = " ".join(o.rendered for o in observations if o.ok and o.rendered).strip()
    if not body:
        return "", False, "no tool produced a statement", cs

    lead = personas.lead(ctx.persona, _lead_key(observations))
    draft = ("%s %s" % (lead, body)).strip() if lead else body

    ok, unsupported = verify(draft, cs)
    trace.add("Verify: does every figure trace to a stored row?", "narrate.verify",
              "%d figure(s) in the draft checked against %d recorded claim(s)%s"
              % (len(cs.claims), len(cs.claims),
                 "; all traced" if ok else "; unsupported: " + ", ".join(unsupported[:3])),
              status="ok" if ok else "failed", kind="validate", gate="verify",
              evidence=cs.evidence())
    if not ok:
        return "", False, ("a figure in the draft did not trace to a stored row (%s)"
                           % ", ".join(unsupported[:3])), cs
    return draft, True, "", cs


# Capabilities that answer no narrative slot still need a heading of their own.
SECTION_LABEL = {
    "greeting": "Greeting", "help": "Capabilities", "catalog": "Metrics tracked",
    "definition": "Definition", "cost": "Runtime cost",
}


def _sections(observations: list[planner.Observation], facts: dict) -> list[dict]:
    """The answer as a reader wants it: what changed, when, why, and what to do about it.

    Blocks were labelled after the capability that produced them ("Position", "Attribution"),
    which named the machinery rather than the question. Several capabilities can answer one part
    of the question -- localisation and factor decomposition are both "why" -- so they merge into
    one block instead of arriving as two unrelated findings.
    """
    grouped: dict[str, dict] = {}
    extra: list[dict] = []
    for obs in observations:
        if not obs.ok or not obs.rendered:
            continue
        spec = tools.REGISTRY.get(obs.tool)
        slot = understanding.slot_for(spec.intent) if spec else ""
        if not slot:
            # `kind` decides how the client sets it. A greeting broken into five bullets under a
            # heading reads as five findings; it is one short remark and must render as prose.
            extra.append({"label": SECTION_LABEL.get(spec.intent if spec else "", "Finding"),
                          "text": obs.rendered, "tool": obs.tool, "source": obs.citation,
                          "kind": "prose"})
            continue
        block = grouped.setdefault(slot, {"label": understanding.SLOT_LABEL[slot], "text": "",
                                          "tool": obs.tool, "source": obs.citation,
                                          "slot": slot, "kind": "findings"})
        block["text"] = (block["text"] + " " + obs.rendered).strip()

    # `when` has no capability of its own: the window is a fact the insight already carries, and
    # stating it as its own line is what makes "when did this happen" answerable at a glance.
    window = facts.get("window")
    if window and understanding.WHAT_CHANGED in grouped:
        grouped[understanding.WHEN] = {
            "label": understanding.SLOT_LABEL[understanding.WHEN],
            "text": "The movement was measured over %s." % window,
            "tool": "get_insight", "source": "anomalies", "slot": understanding.WHEN,
            "kind": "prose",
        }

    ordered = [grouped[slot] for slot in understanding.SLOT_ORDER if slot in grouped]
    return ordered + extra


def _confidence(observations: list[planner.Observation], validation: planner.Validation,
                verifier_pass: bool, claims: list[dict]) -> tuple[float, list[str]]:
    """Confidence in the ANSWER, from what actually happened -- not a number the model chose.

    Starts from a full mark and deducts for every concrete reason to trust it less. Each deduction
    is named, so "0.6" is never the whole story a reader gets.
    """
    reasons: list[str] = []
    score = 1.0
    if not verifier_pass:
        return 0.0, ["a figure did not trace to a stored row"]

    ok = [o for o in observations if o.ok]
    empty = [o for o in observations if not o.ok]
    if not claims:
        score -= 0.2
        reasons.append("the answer rests on recorded text rather than on figures")
    if empty:
        score -= min(0.3, 0.1 * len(empty))
        reasons.append("%d capability(ies) returned nothing" % len(empty))
    contradictions = [i for i in validation.issues if "disagree" in i]
    if contradictions:
        score -= 0.4
        reasons.extend(contradictions)
    if len(ok) == 1:
        score -= 0.1
        reasons.append("only one capability contributed")
    return max(0.0, round(score, 3)), reasons


def _lead_key(observations: list[planner.Observation]) -> str:
    """The persona's framing follows the first analytical tool that succeeded."""
    for obs in observations:
        spec = tools.REGISTRY.get(obs.tool)
        if obs.ok and spec and spec.intent not in ("greeting", "help"):
            return spec.intent
    return ""


def _restricted(ctx: planner.Context) -> tuple[dict[str, str], str]:
    """Gates this question reaches for but the persona may not use, and a sentence saying so."""
    blocked = planner.restricted_capabilities(ctx)
    if not blocked:
        return {}, ""
    label = personas.get(ctx.persona).label
    owners = sorted({p.label for p in personas.REGISTRY.values()
                     if p.id != ctx.persona
                     and any(personas.allows(p.id, s.intent) for s in blocked)})
    note = ("%s %s outside the %s view"
            % (", ".join(gates.BY_ID[gates.for_intent(s.intent)].label for s in blocked
                         if gates.for_intent(s.intent)) or "that capability",
               "is" if len(blocked) == 1 else "are", label))
    if owners:
        note += "; the %s view owns it" % " or ".join(owners[:2])
    reason = "not available to the %s view" % label
    return {gates.for_intent(s.intent): reason for s in blocked
            if gates.for_intent(s.intent)}, note


def _rail_for(observations: list[planner.Observation], verified: bool | None,
              restricted: dict[str, str] | None = None) -> list[dict]:
    """Fold the observations back onto the pipeline rail, so gates report their own outcome."""
    engaged: dict[str, dict] = {}
    for obs in observations:
        spec = tools.REGISTRY.get(obs.tool)
        gate = gates.for_intent(spec.intent) if spec else ""
        if not gate:
            continue
        slot = engaged.setdefault(gate, {"tools": [], "claims": 0, "ok": False, "detail": ""})
        slot["tools"].append(obs.tool)
        if obs.ok:
            slot["ok"] = True
            slot["detail"] = obs.summary
        elif not slot["detail"]:
            slot["detail"] = obs.reason
    engaged["scope"] = {"tools": ["reader.list_insights"], "claims": 0, "ok": True,
                        "detail": "resolved from the persona's visible metrics"}
    if verified is not None:
        engaged["verify"] = {"tools": ["narrate.verify"], "claims": 0, "ok": verified,
                             "detail": "every figure traced to a stored row" if verified
                                       else "a figure did not trace to a stored row"}
    return gates.rail_state(engaged, reached=verified is not None, restricted=restricted)


def run(tenant_id: str, question: str, persona: str, engine: str = "auto", emit=None,
        window_days: int = 0) -> Result:
    """Answer a question. `emit`, when given, receives each trace step as it happens.

    `window_days` is the caller's standing choice, normally the dashboard's range dropdown. A
    question that names its own period overrides it for this turn.
    """
    persona = persona if persona in config.PERSONAS else config.DEFAULT_PERSONA
    profile = personas.get(persona)
    trace = Trace(emit)

    # The first real step is the ClickHouse connection, which takes seconds on a cold pool. Until
    # it returned the reader saw nothing at all, so the agent looked stalled at the exact moment it
    # was doing the most work. This costs nothing and closes that gap.
    trace.add("Open the investigation", "loop.run",
              "reading the question as %s" % profile.label, kind="reason")

    brain = planner.choose(engine)
    usable, model = llm_client.available()
    trace.add("Choose the reasoning engine", "planner.choose",
              "%s planner%s" % (brain.engine, " (%s)" % model if usable and model else
                                "; no model reachable, planning deterministically"),
              kind="reason")

    # The dropdown is the standing choice; a question that names a period wins for this turn.
    window_days = planner.resolve_window(question, window_days or config.WINDOW_DAYS,
                                         config.WINDOW_CHOICES)
    trace.add("Settle the period", "planner.resolve_window",
              "answering over the last %d days" % window_days, kind="reason")
    ctx = _build_context(tenant_id, question, persona, trace, window_days)

    # A courtesy is not a question. "nice, thank you" used to reach the greeting tool and come
    # back as the full capability spiel, which is what made the agent read as a form rather than
    # an assistant. Answer it as a person would and stop; no tool, no claim set, no numbers.
    social = llm_chat.looks_social(question)
    if social:
        profile = personas.get(persona)
        flagged = [tools.pretty_name(k) for k in ctx.moved_ids][:3]
        fallback = (profile.greeting if social in ("greeting", "help")
                    else "Happy to help. Ask whenever you want to look at something.")
        text, tin, tout = llm_chat.reply(
            social, question, profile.label, profile.remit, flagged,
            profile.examples[0] if profile.examples else "", fallback)
        trace.add("Answer conversationally", "llm_chat.reply",
                  "a %s turn: no metric was read and no figure is claimed" % social,
                  kind="synthesize")
        return Result(answer=text, persona=persona, persona_label=profile.label,
                      trace=trace.steps, engine_type="llm" if tout else "rule",
                      tokens_in=tin, tokens_out=tout, verifier_pass=True,
                      suggestions=list(profile.examples[:2]))

    # Comprehension comes BEFORE capability selection: what kind of question this is decides which
    # stages run, rather than which cue words the user happened to use.
    reading = planner.comprehend(ctx)
    trace.add("Understand the question", "understanding.read", reading.reason,
              status="ok" if reading.shape != "unmatched" else "abstained", kind="reason")

    # Entitlement is applied before planning, so say what it removed. A persona quietly answered
    # about something adjacent to what it asked is the worst outcome available here.
    restricted, restriction_note = _restricted(ctx)
    if restricted:
        trace.add("Apply entitlement", "personas.allows", restriction_note,
                  status="skipped", kind="reason")

    # A hidden KPI is refused BEFORE any tool runs, so the figure is never assembled and cannot
    # be back-computed from what comes back. Redacting it afterwards would be too late.
    hidden = hidden_kpis(persona)
    # Only what the question NAMES blocks it. Revenue merely sitting in the candidate list is
    # not a request for revenue, and refusing there made every Ops question unanswerable.
    named = set(planner.matched_metrics(ctx))
    if ctx.focus_metric:
        named.add(ctx.focus_metric)
    blocked = sorted(hidden & named)
    if blocked:
        names = ", ".join(tools.pretty_name(k) for k in blocked)
        trace.add("Apply entitlement", "personas.hidden_kpis",
                  "%s is not visible to %s" % (names, profile.label),
                  status="abstained", kind="reason")
        return Result(
            answer=("%s is not available to %s. It is owned by the finance team, who can "
                    "answer it directly." % (names, profile.label)),
            persona=persona, persona_label=profile.label, abstained=True,
            reason="entitlement", verifier_pass=True, engine_type="rule",
            trace=trace.as_list(), rounds=0)

    # Not named, but still must never surface: drop hidden KPIs from everything the agent may
    # consider, so a ranking cannot mention one.
    if hidden:
        ctx.metric_ids = [k for k in ctx.metric_ids if k not in hidden]
        ctx.moved_ids = [k for k in ctx.moved_ids if k not in hidden]
        if ctx.focus_metric in hidden:
            ctx.focus_metric = ""

    observations: list[planner.Observation] = []
    claims: list[dict] = []
    facts: dict[str, str] = {}
    # Starts insufficient with NO issue text: "nothing attempted" is loop bookkeeping, and it
    # reached the reader as "Noted while answering: nothing attempted."
    validation = planner.Validation(False, [])
    rounds = 0
    last_thought = ""

    # The bound is the tighter of the system cap and the persona's declared depth.
    rounds_allowed = min(MAX_ROUNDS, profile.max_rounds)
    for round_n in range(rounds_allowed):
        plan = brain.plan(ctx, observations, round_n)
        last_thought = plan.thought
        trace.add("Plan round %d" % (round_n + 1), "planner.%s" % plan.engine,
                  plan.thought, kind="reason")
        if plan.done or not plan.calls:
            break
        rounds += 1
        new_obs, new_claims, new_facts = _execute(plan, ctx, trace)
        observations.extend(new_obs)
        claims.extend(new_claims)
        facts.update(new_facts)

        validation = planner.validate(ctx, observations, claims)
        if not validation.sufficient:
            detail = "nothing usable came back" + (
                "; " + "; ".join(validation.issues[:2]) if validation.issues else "")
        elif not validation.complete:
            detail = ("usable, but the question also asks for %s; continuing"
                      % ", ".join(validation.uncovered[:3]))
        else:
            detail = "every capability the question asks for has been consulted"
        trace.add("Critique what came back", "planner.validate", detail,
                  status="ok" if validation.sufficient else "abstained", kind="validate")
        if validation.sufficient and validation.complete:
            break

    tokens_in = getattr(brain, "tokens_in", 0)
    tokens_out = getattr(brain, "tokens_out", 0)
    citations = [{"tool": o.tool, "source": o.citation} for o in observations
                 if o.ok and o.citation]
    used = [o.tool for o in observations if o.ok]
    if restriction_note:
        validation.issues = list(validation.issues) + [restriction_note]

    if not validation.sufficient:
        if rounds == 0:
            # Nothing was even attempted. "nothing attempted" tells the reader nothing; the
            # planner's own reason for stopping does, and a metric outside this persona's scope
            # is the most common one.
            # The reading is the honest reason, and it is a whole sentence. Falling through to the
            # planner's thought restated "Understood: ..." inside "I cannot answer that: ...".
            reason = (_out_of_scope(ctx) or (reading.reason if reading.shape == "unmatched" else "")
                      or last_thought.rstrip(".").lower()
                      or "no capability matches that question")
        else:
            reason = "; ".join(validation.issues[:2]) or (
                "no recorded evidence answers that question")
        trace.add("Abstain", "planner.validate", reason, status="abstained", kind="synthesize")
        # Report no metric when the question reached none. `resolve_metric` falls back to the
        # persona's priorities so a vague-but-real question still has something to open on, but on
        # an abstention that fallback surfaces as a metric chip beside "this names no metric" --
        # the reader sees the system name a KPI and disclaim it in the same breath.
        focus = "" if reading.shape == "unmatched" else ctx.focus_metric
        return Result(
            answer=_abstention_text(profile, reason), persona=persona,
            persona_label=profile.label, kpi_id=focus, tools_used=used,
            citations=citations, trace=trace.as_list(), abstained=True, reason=reason,
            escalate=validation.escalate, issues=validation.issues, engine_type=brain.engine,
            rounds=rounds, tokens_in=tokens_in, tokens_out=tokens_out,
            suggestions=list(profile.examples),
            rail=_rail_for(observations, None, restricted))

    text, ok, reason, cs = _synthesize(ctx, observations, claims, facts, trace)
    if not ok:
        return Result(
            answer="I cannot answer that: %s." % reason, persona=persona,
            persona_label=profile.label, kpi_id=ctx.focus_metric, tools_used=used,
            evidence=cs.evidence(), citations=citations, trace=trace.as_list(), abstained=True,
            reason=reason, verifier_pass=False, engine_type=brain.engine, rounds=rounds,
            tokens_in=tokens_in, tokens_out=tokens_out, suggestions=list(profile.examples),
            rail=_rail_for(observations, False, restricted))

    sections = _sections(observations, facts)
    confidence, uncertainty = _confidence(observations, validation, True, claims)
    trace.add("Synthesize the answer", "loop._synthesize",
              "%d section(s), %d claim(s), %d source(s), confidence %.2f"
              % (len(sections), len(cs.claims), len({c["source"] for c in citations}),
                 confidence),
              kind="synthesize")

    # Let the model write the words. Until now it chose the ROUTE and the prose came from
    # per-capability templates, so an answer read identically whether the model was running or
    # not. Each part is verified on its own, so a rewrite that states an unsupported figure is
    # discarded and that part keeps its template while the rest still improve.
    from api.intelligence.stages import llm_narrator
    written = llm_narrator.narrate_sections(cs, persona, sections)
    if written.get("texts"):
        by_label = written["texts"]
        for section in sections:
            if section["label"] in by_label:
                section["text"] = by_label[section["label"]]
        text = " ".join(s["text"] for s in sections).strip() or text
        tokens_in += written["tokens_in"]
        tokens_out += written["tokens_out"]
    if written.get("reason") != "disabled":
        trace.add("Write the answer for this reader", "llm_narrator.narrate_sections",
                  "%d of %d part(s) rewritten and verified%s"
                  % (written["rewritten"], len(sections),
                     "; %s kept the deterministic wording because a figure did not trace"
                     % ", ".join(written["rejected"]) if written["rejected"] else ""),
                  status="ok" if written["rewritten"] else "abstained", kind="synthesize")
    return Result(
        answer=text, persona=persona, persona_label=profile.label, kpi_id=ctx.focus_metric,
        tools_used=used, evidence=cs.evidence(), citations=citations, trace=trace.as_list(),
        issues=validation.issues, engine_type=brain.engine, rounds=rounds,
        tokens_in=tokens_in, tokens_out=tokens_out, suggestions=list(profile.examples),
        sections=sections, confidence=confidence, uncertainty=uncertainty,
        rail=_rail_for(observations, True, restricted), visuals=visuals.build(observations),
        datasets=visuals.datasets(observations))


def _out_of_scope(ctx: planner.Context) -> str:
    """Names a governed metric this persona may not see? Say that, rather than "no match"."""
    try:
        from api.intelligence.contracts import load_declared
        declared = load_declared()
    except Exception:
        return ""
    words = set(ctx.question.lower().replace("_", " ").split())
    hidden = sorted(
        kpi for kpi, contract in declared.items()
        if kpi not in ctx.metric_ids
        and set(kpi.replace("_", " ").split()) & words
        and ctx.persona not in (contract.visible_to or [ctx.persona])
    )
    if not hidden:
        return ""
    names = ", ".join(tools.pretty_name(k) for k in hidden)
    return ("%s %s outside the %s view" % (names, "is" if len(hidden) == 1 else "are",
                                           personas.get(ctx.persona).label))


def _abstention_text(profile, reason: str) -> str:
    text = "I cannot answer that from recorded evidence: %s" % reason
    if not text.endswith("."):
        text += "."
    if profile.examples:
        text += " As %s you can ask, for example, “%s”." % (profile.label,
                                                                     profile.examples[0])
    return text
