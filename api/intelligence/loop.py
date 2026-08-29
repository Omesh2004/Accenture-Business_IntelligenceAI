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

from api.intelligence import config, llm_client, personas, planner, reader, tools
from api.intelligence.stages.narrate import ClaimSet, verify

MAX_ROUNDS = getattr(config, "AGENT_MAX_ROUNDS", 3)
MAX_PARALLEL = 4


@dataclass
class Step:
    n: int
    label: str
    tool: str
    detail: str = ""
    status: str = "ok"          # ok | skipped | abstained | failed
    ms: int = 0
    kind: str = "act"           # reason | act | observe | validate | synthesize

    def as_dict(self) -> dict:
        return {"n": self.n, "label": self.label, "tool": self.tool, "detail": self.detail,
                "status": self.status, "ms": self.ms, "kind": self.kind}


class Trace:
    def __init__(self) -> None:
        self.steps: list[Step] = []
        self._mark = time.perf_counter()

    def add(self, label: str, tool: str, detail: str = "", status: str = "ok",
            kind: str = "act") -> Step:
        now = time.perf_counter()
        step = Step(len(self.steps) + 1, label, tool, detail, status,
                    int((now - self._mark) * 1000), kind)
        self._mark = now
        self.steps.append(step)
        return step

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
        }


def _build_context(tenant_id: str, question: str, persona: str, trace: Trace) -> planner.Context:
    """Memory the planner reasons over: which metrics exist and which one is in play.

    This is context assembly, not a step of a workflow -- the planner is free to ignore it, call
    `list_metrics` itself, or name a different metric.
    """
    profile = personas.get(persona)
    try:
        rows = reader.list_insights(tenant_id, persona, limit=config.MAX_KPIS_PER_SWEEP)
    except Exception as exc:                                        # noqa: BLE001
        trace.add("Load tenant context", "reader.list_insights", "unavailable: %s" % exc,
                  status="failed", kind="observe")
        rows = []
    metric_ids = sorted({r["kpi_id"] for r in rows})
    moved_ids = sorted({r["kpi_id"] for r in rows if r.get("anomaly_id")})
    ctx = planner.Context(tenant_id, question, persona, metric_ids, moved_ids=moved_ids)
    ctx.focus_metric = planner.resolve_metric(question, metric_ids, profile, moved_ids)
    trace.add("Load context for %s" % profile.label, "reader.list_insights",
              "%d metrics in scope%s" % (len(metric_ids),
                                         "; question points at %s" % ctx.focus_metric
                                         if ctx.focus_metric else "; no metric named"),
              status="ok" if metric_ids else "abstained", kind="observe")
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
    results: dict[int, tools.ToolResult] = {}
    if runnable:
        with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(runnable))) as pool:
            futures = {pool.submit(tools.run, c.tool, a, ctx.persona): i
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
        trace.add("Call %s" % call.tool, "tools.%s" % call.tool,
                  (res.summary or res.reason) + (" [%s]" % res.citation if res.citation else ""),
                  status="ok" if res.ok else "abstained")
        observations.append(planner.Observation(call.tool, args, res.ok,
                                                res.summary, res.citation, res.reason, rendered))
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
    trace.add("Verify every figure", "narrate.verify",
              "%d claim(s) checked%s" % (len(cs.claims),
                                         "" if ok else "; unsupported: " + ", ".join(
                                             unsupported[:3])),
              status="ok" if ok else "failed", kind="validate")
    if not ok:
        return "", False, ("a figure in the draft did not trace to a stored row (%s)"
                           % ", ".join(unsupported[:3])), cs
    return draft, True, "", cs


SECTION_LABEL = {
    "greeting": "Greeting", "help": "Capabilities", "catalog": "Metrics tracked",
    "status": "Position", "cause": "Attribution", "where": "Concentration",
    "factor": "Factor decomposition", "forecast": "Outlook", "action": "Recommended action",
    "trust": "Assurance", "freshness": "Data freshness", "cost": "Runtime cost",
    "ranking": "Priority order", "definition": "Definition",
}


def _sections(observations: list[planner.Observation]) -> list[dict]:
    """One block per contributing capability, in the order it is told."""
    out = []
    for obs in observations:
        if not obs.ok or not obs.rendered:
            continue
        spec = tools.REGISTRY.get(obs.tool)
        out.append({
            "label": SECTION_LABEL.get(spec.intent if spec else "", "Finding"),
            "text": obs.rendered,
            "tool": obs.tool,
            "source": obs.citation,
        })
    return out


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


def run(tenant_id: str, question: str, persona: str, engine: str = "auto") -> Result:
    persona = persona if persona in config.PERSONAS else config.DEFAULT_PERSONA
    profile = personas.get(persona)
    trace = Trace()

    brain = planner.choose(engine)
    usable, model = llm_client.available()
    trace.add("Choose the reasoning engine", "planner.choose",
              "%s planner%s" % (brain.engine, " (%s)" % model if usable and model else
                                "; no model reachable, planning deterministically"),
              kind="reason")

    ctx = _build_context(tenant_id, question, persona, trace)

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
        trace.add("Validate observations", "planner.validate",
                  "sufficient" if validation.sufficient else "insufficient"
                  + ("; " + "; ".join(validation.issues[:2]) if validation.issues else ""),
                  status="ok" if validation.sufficient else "abstained", kind="validate")
        if validation.sufficient:
            break

    tokens_in = getattr(brain, "tokens_in", 0)
    tokens_out = getattr(brain, "tokens_out", 0)
    citations = [{"tool": o.tool, "source": o.citation} for o in observations
                 if o.ok and o.citation]
    used = [o.tool for o in observations if o.ok]

    if not validation.sufficient:
        if rounds == 0:
            # Nothing was even attempted. "nothing attempted" tells the reader nothing; the
            # planner's own reason for stopping does, and a metric outside this persona's scope
            # is the most common one.
            reason = _out_of_scope(ctx) or last_thought.rstrip(".").lower() or (
                "no capability matches that question")
        else:
            reason = "; ".join(validation.issues[:2]) or (
                "no recorded evidence answers that question")
        trace.add("Abstain", "planner.validate", reason, status="abstained", kind="synthesize")
        return Result(
            answer=_abstention_text(profile, reason), persona=persona,
            persona_label=profile.label, kpi_id=ctx.focus_metric, tools_used=used,
            citations=citations, trace=trace.as_list(), abstained=True, reason=reason,
            escalate=validation.escalate, issues=validation.issues, engine_type=brain.engine,
            rounds=rounds, tokens_in=tokens_in, tokens_out=tokens_out,
            suggestions=list(profile.examples))

    text, ok, reason, cs = _synthesize(ctx, observations, claims, facts, trace)
    if not ok:
        return Result(
            answer="I cannot answer that: %s." % reason, persona=persona,
            persona_label=profile.label, kpi_id=ctx.focus_metric, tools_used=used,
            evidence=cs.evidence(), citations=citations, trace=trace.as_list(), abstained=True,
            reason=reason, verifier_pass=False, engine_type=brain.engine, rounds=rounds,
            tokens_in=tokens_in, tokens_out=tokens_out, suggestions=list(profile.examples))

    sections = _sections(observations)
    confidence, uncertainty = _confidence(observations, validation, True, claims)
    trace.add("Synthesize the answer", "loop._synthesize",
              "%d section(s), %d claim(s), %d source(s), confidence %.2f"
              % (len(sections), len(cs.claims), len({c["source"] for c in citations}),
                 confidence),
              kind="synthesize")
    return Result(
        answer=text, persona=persona, persona_label=profile.label, kpi_id=ctx.focus_metric,
        tools_used=used, evidence=cs.evidence(), citations=citations, trace=trace.as_list(),
        issues=validation.issues, engine_type=brain.engine, rounds=rounds,
        tokens_in=tokens_in, tokens_out=tokens_out, suggestions=list(profile.examples),
        sections=sections, confidence=confidence, uncertainty=uncertainty)


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
