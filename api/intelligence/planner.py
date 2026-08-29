"""The reasoning layer: decides which capabilities to use, in what order, and when to stop.

Two planners implement one interface, and the loop treats them identically:

  * `LLMPlanner`   -- reads the tool catalogue and the observations so far and emits the next
                      action set as JSON. Free-form: nothing constrains which tools it picks or
                      how many rounds it takes, beyond the guardrails in `tools.validate_call`.
  * `RulePlanner`  -- the dependency-free path. Still dynamic: it scores every tool in the
                      catalogue against the question and the persona's priorities and re-plans
                      from what came back. It is not a fixed sequence -- there is no if-chain
                      mapping a question shape to a tool order.

Neither planner ever produces a number. They choose capabilities; the capabilities produce the
numbers; the verifier checks them. That separation is what makes an LLM safe to put in charge of
control flow.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from api.intelligence import config, llm_client, matching, personas, tools

_WORD = re.compile(r"[a-z0-9_]+")
MAX_CALLS_PER_ROUND = 4

# A selector hit scores 1.0; a description word 0.25. This floor means ONE incidental description
# word cannot select a tool: "what did this analysis cost" matched `get_causes` because its
# description contains the word "analysis", and an operations manager -- who may not ask about
# cost at all -- was answered with a variance report instead of being told so.
MIN_SELECT_SCORE = 0.5


@dataclass
class Call:
    tool: str
    args: dict = field(default_factory=dict)
    why: str = ""


@dataclass
class Plan:
    thought: str
    calls: list[Call] = field(default_factory=list)
    done: bool = False
    engine: str = "rule"


@dataclass
class Observation:
    tool: str
    args: dict
    ok: bool
    summary: str
    citation: str
    reason: str = ""
    rendered: str = ""


# ── shared context ─────────────────────────────────────────────────────────────────────────────
@dataclass
class Context:
    tenant_id: str
    question: str
    persona: str
    metric_ids: list[str] = field(default_factory=list)
    focus_metric: str = ""
    # Metrics with a recorded anomaly. A persona preference may order these; it may not promote a
    # quiet metric over one that moved.
    moved_ids: list[str] = field(default_factory=list)

    @property
    def profile(self):
        return personas.get(self.persona)


def resolve_metric(question: str, candidates: list[str], profile,
                   moved: list[str] | None = None) -> str:
    """Which metric the question is about: named first, then the persona's own priorities.

    The preference list only ranks metrics that ACTUALLY MOVED. Applied to every candidate it
    pinned each persona to its favourite metric whatever the state of the portfolio -- a CFO
    asking "why did it drop" was answered about a quiet revenue line while an urgent lending
    anomaly sat unread.

    Returns '' when nothing matches, which lets a tool fall back to the most material finding --
    the same one the dashboard is showing.
    """
    words = matching.tokens(question)
    best, best_score = "", 0
    for kpi_id in sorted(candidates):
        parts = [p for p in re.split(r"[_.\-]", kpi_id.lower()) if len(p) > 2]
        score = sum(1 for part in parts
                    if any(matching.token_matches(w, part) for w in words))
        if score > best_score or (score == best_score and score and len(kpi_id) < len(best)):
            best, best_score = kpi_id, score
    if best_score:
        return best
    # A metric that MOVED outranks a persona preference -- materiality is the signal, and letting
    # a favourite metric win over an urgent one is how a CFO was answered about a quiet revenue
    # line while a lending anomaly sat unread.
    for preferred in profile.kpi_preference:
        if preferred in (moved or []):
            return preferred
    if moved:
        return ""            # something moved but not this persona's; rank by materiality
    # Nothing moved anywhere. With no material signal to defer to, the persona's own priorities
    # are the most relevant thing left -- better than whichever metric sorts first.
    for preferred in profile.kpi_preference:
        if preferred in candidates:
            return preferred
    return ""


def resolve_metrics(question: str, candidates: list[str], limit: int = 4) -> list[str]:
    """Every metric the question names, best match first -- what a comparison needs.

    `resolve_metric` returns one; asking to compare two metrics and being handed the first two in
    the tenant is not a comparison, it is a coincidence.
    """
    words = matching.tokens(question)
    scored = []
    for kpi_id in sorted(candidates):
        parts = [p for p in re.split(r"[_.\-]", kpi_id.lower()) if len(p) > 2]
        overlap = sum(1 for part in parts
                      if any(matching.token_matches(w, part) for w in words))
        if overlap:
            scored.append((overlap, -len(kpi_id), kpi_id))
    if not scored:
        return []
    # Only the metrics the question names as strongly as its best match. A partial hit on one
    # shared word ("pro") otherwise dragged unrelated metrics into a two-way comparison.
    scored.sort(reverse=True)
    best = scored[0][0]
    return [kpi for overlap, _, kpi in scored[:limit] if overlap == best]


_STOP = frozenset("""a an and are as at be by for from how in is it its of on or that the
their this to use used using what when where which who why with your you""".split())


def _description_terms(spec: tools.ToolSpec) -> tuple[str, ...]:
    """Content words from a tool's description -- what it says it does, minus the glue."""
    return tuple(sorted({w for w in matching.tokens(spec.description)
                         if len(w) > 3 and w not in _STOP}))


def _mentions_metric(ctx: Context) -> bool:
    """Does the question name a metric this tenant actually has?

    Every word of the id must be present, so "loan" alone does not claim `loan_approval_volume`
    while "loan approval volume" -- or "loan aproval volume" -- does.
    """
    return matching.names_any(ctx.question, ctx.metric_ids)


# ── deterministic planner ──────────────────────────────────────────────────────────────────────
class RulePlanner:
    """Scores the catalogue against the question. Dynamic selection, no model required."""

    engine = "rule"

    def plan(self, ctx: Context, observations: list[Observation], round_n: int) -> Plan:
        catalogue = tools.catalogue(ctx.persona)
        if round_n == 0:
            return self._first(ctx, catalogue)
        return self._replan(ctx, catalogue, observations)

    def _score(self, question: str, spec: tools.ToolSpec) -> float:
        """Relevance of one capability to this question.

        Selectors carry full weight; words from the tool's own description carry a fraction, so a
        capability nobody wrote a cue for is still reachable by what it says it does. Substring
        tests are gone: they missed "hii" and fired on fragments inside unrelated words.
        """
        direct = matching.score(question, spec.selectors)
        described = matching.score(question, _description_terms(spec))
        return direct + 0.25 * described

    def _candidates(self, ctx: Context,
                    catalogue: list[tools.ToolSpec]) -> list[tuple[float, tools.ToolSpec]]:
        """Every capability this question expresses, best first. The planner's search space."""
        named = _mentions_metric(ctx)
        usable = [s for s in catalogue if named or not s.needs_named_metric]
        scored = [(score, spec) for score, spec in
                  ((self._score(ctx.question, spec), spec) for spec in usable)
                  if score >= MIN_SELECT_SCORE]
        scored.sort(key=lambda t: (-t[0], t[1].priority, t[1].name))
        # A salutation is a whole intent. Pairing it with a variance report answers a question
        # nobody asked and buries the greeting.
        conversational = [t for t in scored if t[1].intent in ("greeting", "help")]
        if conversational and conversational[0][0] >= scored[0][0]:
            return conversational[:1]
        return [t for t in scored if t[1].intent not in ("greeting", "help")]

    def _first(self, ctx: Context, catalogue: list[tools.ToolSpec]) -> Plan:
        # A tool that explains ONE metric is only a candidate when the question names one.
        # Without this, "what is the capital of France" reached the contract lookup, which
        # answered about whichever metric the persona happens to prioritise.
        named = _mentions_metric(ctx)
        candidates = self._candidates(ctx, catalogue)
        # Relevance decides WHICH tools run; `priority` decides the order they are told in, so a
        # briefing still opens with the movement before the lever that answers it.
        width = min(MAX_CALLS_PER_ROUND, ctx.profile.max_tools_per_round)
        chosen = sorted((spec for _, spec in candidates[:width]),
                        key=lambda spec: (spec.priority, spec.name))
        if not chosen:
            # Nothing matched. Reading the standing finding is a reasonable default for a question
            # that IS about the business ("give me the position") and a bad one for a question
            # that is not -- answering an unrelated question with a variance report is worse than
            # saying no.
            if not named:
                return Plan(thought="No capability matches this question.", done=True,
                            engine=self.engine)
            chosen = [tools.REGISTRY["get_insight"]] if personas.allows(ctx.persona, "status") \
                else catalogue[:1]
        calls = [Call(s.name, self._args(ctx, s), "matched the question") for s in chosen]
        return Plan(thought="Selected %d capability(ies) by relevance to the question: %s."
                            % (len(calls), ", ".join(c.tool for c in calls)),
                    calls=calls, engine=self.engine)

    def _replan(self, ctx: Context, catalogue: list[tools.ToolSpec],
                observations: list[Observation]) -> Plan:
        """Re-plan from what came back, not from the question shape.

        Two distinct situations, and conflating them is why the agent used to stop after one
        batch: something came back but the question is only PARTLY answered, versus nothing came
        back at all. The first calls for pursuing the gap; the second for widening or stopping.
        """
        tried = {o.tool for o in observations}
        useful = [o for o in observations if o.ok]

        if useful:
            # Relevant capabilities the first round did not get to -- the round cap, or a tool
            # that returned nothing and whose ground another capability still covers.
            gap = [spec for _, spec in self._candidates(ctx, catalogue) if spec.name not in tried]
            if gap:
                width = min(MAX_CALLS_PER_ROUND, ctx.profile.max_tools_per_round)
                chosen = sorted(gap[:width], key=lambda spec: (spec.priority, spec.name))
                return Plan(
                    thought="Answered so far by %s; %s still bears on the question."
                            % (", ".join(sorted(o.tool for o in useful)),
                               ", ".join(s.name for s in chosen)),
                    calls=[Call(s.name, self._args(ctx, s), "unanswered part of the question")
                           for s in chosen],
                    engine=self.engine)
            return Plan(thought="Observations answer the question; no further tool is needed.",
                        done=True, engine=self.engine)

        # Everything failed. Widen only if the question is plausibly ABOUT a metric -- otherwise
        # the fallback answers a question nobody asked. "What is the capital of France?" hit the
        # contract lookup, found nothing, and was then answered with the standing loan-approval
        # finding: confident, sourced, and completely irrelevant.
        about_a_metric = bool(ctx.focus_metric) or _mentions_metric(ctx)
        if about_a_metric:
            for name in ("get_insight", "rank_movements", "list_metrics"):
                spec = tools.REGISTRY.get(name)
                if spec and spec in catalogue and name not in tried:
                    return Plan(thought="Nothing returned yet; widening to %s." % name,
                                calls=[Call(name, self._args(ctx, spec),
                                            "fallback after empty result")],
                                engine=self.engine)
        return Plan(thought="No remaining capability can answer this.", done=True,
                    engine=self.engine)

    def _args(self, ctx: Context, spec: tools.ToolSpec) -> dict:
        args = {"tenant_id": ctx.tenant_id}
        if "kpi_id" in spec.params and ctx.focus_metric:
            args["kpi_id"] = ctx.focus_metric
        if "kpi_ids" in spec.params:
            named = resolve_metrics(ctx.question, ctx.metric_ids)
            args["kpi_ids"] = ",".join(named or ctx.metric_ids[:2])
        return args


# ── model planner ──────────────────────────────────────────────────────────────────────────────
PLAN_SCHEMA_HINT = (
    '{"thought": "one sentence on what you still need", '
    '"done": false, '
    '"calls": [{"tool": "<name>", "args": {"tenant_id": "<tenant>"}, "why": "<short>"}]}'
)


class LLMPlanner:
    """Free-form planning over the catalogue. Falls back to RulePlanner on any failure."""

    engine = "llm"

    def __init__(self) -> None:
        self._fallback = RulePlanner()
        self.tokens_in = 0
        self.tokens_out = 0

    def plan(self, ctx: Context, observations: list[Observation], round_n: int) -> Plan:
        prompt = self._prompt(ctx, observations, round_n)
        obj, t_in, t_out = llm_client.complete_json(prompt)
        self.tokens_in += t_in
        self.tokens_out += t_out
        if not isinstance(obj, dict):
            return self._fallback.plan(ctx, observations, round_n)
        calls = []
        for raw in (obj.get("calls") or [])[:MAX_CALLS_PER_ROUND]:
            if not isinstance(raw, dict) or not raw.get("tool"):
                continue
            args = raw.get("args") if isinstance(raw.get("args"), dict) else {}
            args.setdefault("tenant_id", ctx.tenant_id)
            calls.append(Call(str(raw["tool"]), args, str(raw.get("why") or "")))
        thought = str(obj.get("thought") or "").strip() or "Planning the next step."
        done = bool(obj.get("done")) or not calls
        if not calls and not observations:
            # A model that plans nothing on the first round is not usable here.
            return self._fallback.plan(ctx, observations, round_n)
        return Plan(thought=thought, calls=calls, done=done, engine=self.engine)

    def _prompt(self, ctx: Context, observations: list[Observation], round_n: int) -> str:
        profile = ctx.profile
        catalogue = [s.signature() for s in tools.catalogue(ctx.persona)]
        seen = [{"tool": o.tool, "ok": o.ok, "summary": o.summary or o.reason,
                 "source": o.citation} for o in observations]
        return (
            "You are the orchestration layer of a financial analytics agent. You choose which "
            "deterministic tools to call. You NEVER state or invent a number: the tools produce "
            "every figure and a verifier checks them afterwards.\n\n"
            f"PERSONA: {profile.label}. Remit: {profile.remit}\n"
            f"This persona prioritises these metrics when none is named: "
            f"{', '.join(profile.kpi_preference) or 'no preference'}\n\n"
            f"TENANT: {ctx.tenant_id}\n"
            f"METRICS AVAILABLE: {', '.join(ctx.metric_ids[:40]) or 'none'}\n"
            f"METRIC THE QUESTION APPEARS TO BE ABOUT: {ctx.focus_metric or 'not identified'}\n\n"
            f"QUESTION: {ctx.question}\n\n"
            f"TOOLS YOU MAY CALL:\n{json.dumps(catalogue, indent=1)}\n\n"
            f"OBSERVATIONS SO FAR (round {round_n}):\n{json.dumps(seen, indent=1) or '[]'}\n\n"
            "Decide the NEXT step. Call several tools at once when they are independent. Set "
            "done=true when the observations already answer the question, or when no remaining "
            "tool would help. Use only tool names from the list. Reply with JSON only:\n"
            + PLAN_SCHEMA_HINT
        )


def choose(engine: str = "auto"):
    """`auto` prefers the model when one is reachable, and degrades silently when it is not."""
    if engine == "rule":
        return RulePlanner()
    if engine == "llm" or (engine == "auto" and llm_client.available()[0]):
        return LLMPlanner()
    return RulePlanner()


# ── critic ─────────────────────────────────────────────────────────────────────────────────────
@dataclass
class Validation:
    sufficient: bool
    issues: list[str] = field(default_factory=list)
    escalate: bool = False


def validate(ctx: Context, observations: list[Observation],
             claims: list[dict]) -> Validation:
    """Inspect results before answering: empty, contradictory, or good enough.

    This is the observe/validate half of the loop. It runs on tool OUTPUT, so it works the same
    whether the plan came from a model or from the scorer.
    """
    issues: list[str] = []
    useful = [o for o in observations if o.ok]
    if not useful:
        reasons = sorted({o.reason for o in observations if o.reason})
        return Validation(False, issues=reasons or ["no tool returned a result"],
                          escalate=bool(observations) and len(observations) >= 2)

    # Contradiction: two tools reporting different values for the same claim.
    by_id: dict[str, float] = {}
    for claim in claims:
        prior = by_id.get(claim["claim_id"])
        if prior is not None and abs(prior - float(claim["value"])) > config.VERIFIER_TOLERANCE:
            issues.append("two sources disagree on %s (%.4f vs %.4f)"
                          % (claim["claim_id"], prior, float(claim["value"])))
        by_id[claim["claim_id"]] = float(claim["value"])

    # A sibling tool returning nothing is not a caveat on the answer that DID come back. Reporting
    # every empty result surfaced "no metric is currently outside its expected band" under a
    # greeting. Only an empty result for the same metric the answer is about is worth saying.
    focus = ctx.focus_metric
    relevant = [o.reason for o in observations
                if not o.ok and o.reason and focus and focus.replace("_", " ") in
                o.reason.lower().replace("_", " ")]
    issues.extend(sorted(set(relevant)))
    return Validation(True, issues=issues, escalate=False)
