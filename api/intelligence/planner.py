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

from api.intelligence import config, llm_client, matching, personas, tools, understanding

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
    # The structured payload and figures this observation produced. Charts are built from these
    # rather than from a fresh query, so a panel and the sentence beside it cannot disagree.
    data: dict = field(default_factory=dict)
    claims: list[dict] = field(default_factory=list)


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
    # How the question was read. Cached so comprehension happens once per run.
    reading: "understanding.Reading | None" = None
    #: The window this answer is scored over, in days. The caller's default until the question
    #: names one of its own.
    window_days: int = 7
    #: How the turn was read: analysis, greeting, thanks, help or other. Set once, before
    #: planning, so tool selection cannot contradict it.
    turn_kind: str = "analysis"
    #: Metrics the conversation resolved a follow-up to, when the words alone name none.
    matched_from_history: list[str] = field(default_factory=list)

    @property
    def profile(self):
        return personas.get(self.persona)


_WINDOW_WORDS = {
    "today": 1, "yesterday": 1, "this week": 7, "last week": 7, "past week": 7,
    "this month": 30, "last month": 30, "past month": 30, "this quarter": 90,
    "last quarter": 90, "past quarter": 90, "this year": 90,
}

_WINDOW_RE = re.compile(r"(?:last|past|previous|over the last|in the last)?\s*"
                        r"(\d{1,3})\s*(day|days|week|weeks|month|months)", re.I)


def resolve_window(question: str, default_days: int, choices) -> int:
    """The window the question asks for, else the caller's default.

    The dropdown is the standing instruction and the question overrides it for that turn only,
    which is how a person reads it: "and over the last 90 days?" changes this answer, not the page.
    A window nobody swept cannot be answered honestly, so the request is snapped to the nearest
    one that was.
    """
    q = (question or "").lower()
    wanted = None
    for phrase, days in _WINDOW_WORDS.items():
        if phrase in q:
            wanted = days
            break
    m = _WINDOW_RE.search(q)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        wanted = n * (7 if unit.startswith("week") else 30 if unit.startswith("month") else 1)
    if wanted is None:
        wanted = default_days
    opts = list(choices) or [default_days]
    return min(opts, key=lambda c: (abs(c - wanted), c))


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
    # A declared alias settles it outright. Without this the singular resolver matched only on
    # the id, so "new account opening" set no focus and the answer fell back to whatever moved
    # most -- a different KPI from the one the question named.
    aliased = resolve_metrics(question, list(candidates), limit=1)
    if aliased:
        return aliased[0]

    words = matching.tokens(question)
    best, best_score = "", 0
    for kpi_id in sorted(candidates):
        parts = [p for p in re.split(r"[_.\-]", kpi_id.lower()) if len(p) > 2]
        score = sum(1 for part in parts
                    if any(matching.token_matches(w, part) for w in words))
        if score > best_score or (score == best_score and score and len(kpi_id) < len(best)):
            best, best_score = kpi_id, score
    if best_score:
        # When the question reaches several metrics, the shortest id is an arbitrary winner: "kyc"
        # led on `loan.kyc.failure` while `kyc_completion_rate` sat outside its band, urgent, one
        # line below. Prefer a governed metric, and among those prefer one that actually moved --
        # the same materiality-over-alphabet rule the preference list below already follows.
        reach = matching.metrics_named(question, list(candidates))
        preferred = governed(reach) or reach
        if best not in preferred and preferred:
            moved_first = [k for k in preferred if k in (moved or [])]
            return sorted(moved_first or preferred, key=len)[0]
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


def _alias_phrases(kpi_id: str) -> list[str]:
    """Phrases that name this KPI: its id, its display name and its declared aliases."""
    try:
        from api.intelligence.contracts import load_declared
        c = load_declared().get(kpi_id)
    except Exception:
        c = None
    out = [kpi_id.replace("_", " ")]
    if c is not None:
        if c.name:
            out.append(str(c.name).lower())
        out.extend(c.aliases)
    return [p for p in {x.strip().lower() for x in out} if p]


def resolve_metrics(question: str, candidates: list[str], limit: int = 4) -> list[str]:
    """Every metric the question names, best match first -- what a comparison needs.

    `resolve_metric` returns one; asking to compare two metrics and being handed the first two in
    the tenant is not a comparison, it is a coincidence.
    """
    words = matching.tokens(question)
    q = " " + " ".join(words) + " "
    scored = []
    for kpi_id in sorted(candidates):
        best = 0
        # A declared alias wins outright, and a longer phrase beats a shorter one, so
        # "new account opening" resolves to signups rather than to whatever shares one word.
        for phrase in _alias_phrases(kpi_id):
            ptoks = [t for t in matching.tokens(phrase) if len(t) > 2]
            if ptoks and all(f" {t} " in q for t in ptoks):
                best = max(best, 10 + len(ptoks))
        parts = [p for p in re.split(r"[_.\-]", kpi_id.lower()) if len(p) > 2]
        overlap = sum(1 for part in parts
                      if any(matching.token_matches(w, part) for w in words))
        best = max(best, overlap)
        if best:
            scored.append((best, -len(kpi_id), kpi_id))
    if not scored:
        return []
    # Only the metrics the question names as strongly as its best match. A partial hit on one
    # shared word ("pro") otherwise dragged unrelated metrics into a two-way comparison.
    scored.sort(reverse=True)
    best = scored[0][0]
    return [kpi for overlap, _, kpi in scored[:limit] if overlap == best]


def restricted_capabilities(ctx: Context) -> list[tools.ToolSpec]:
    """Capabilities this question asks for that the persona may not use.

    Entitlement was applied silently: a CFO asking "what should I do" got a ranking and no word
    about the lever, because `get_recommendations` was filtered out of the catalogue before the
    planner ever saw it. Being refused is an answer; being quietly given a different one is not.
    """
    allowed = {spec.name for spec in tools.catalogue(ctx.persona)}
    named = _mentions_metric(ctx)
    out = []
    for spec in tools.REGISTRY.values():
        if spec.name in allowed or spec.intent in ("greeting", "help"):
            continue
        if spec.needs_named_metric and not named:
            continue
        if score_tool(ctx.question, spec) >= MIN_SELECT_SCORE:
            out.append(spec)
    return sorted(out, key=lambda s: s.name)


_STOP = frozenset("""a an and are as at be by for from how in is it its of on or that the
their this to use used using what when where which who why with your you""".split())


def _description_terms(spec: tools.ToolSpec) -> tuple[str, ...]:
    """Content words from a tool's description -- what it says it does, minus the glue."""
    return tuple(sorted({w for w in matching.tokens(spec.description)
                         if len(w) > 3 and w not in _STOP}))


def _mentions_metric(ctx: Context) -> bool:
    """Does the question name a metric this tenant actually has?

    Either every word of the id is present ("loan approval volume", or "loan aproval volume"), or
    one DISTINCTIVE word identifies a single metric unambiguously ("kyc"). The second case is what
    people actually type; requiring the full id meant "tell me about kyc activity" was read as
    naming no metric at all and the whole question was abstained on.

    A word shared by several ids -- "loan", "rate" -- still resolves nothing, so an ambiguous
    question is never silently answered about whichever metric sorted first.
    """
    # Aliases count as naming it. Without this "new account opening" named nothing, the
    # question was read as general, and the answer came back about a different KPI entirely.
    if resolve_metrics(ctx.question, list(ctx.metric_ids)):
        return True
    return (matching.names_any(ctx.question, ctx.metric_ids)
            or bool(matching.names_distinctly(ctx.question, ctx.metric_ids)))


def score_tool(question: str, spec: tools.ToolSpec) -> float:
    """Relevance of one capability to this question.

    Selectors carry full weight; words from the tool's own description carry a fraction, so a
    capability nobody wrote a cue for is still reachable by what it says it does. Substring
    tests are gone: they missed "hii" and fired on fragments inside unrelated words.
    """
    direct = matching.score(question, spec.selectors)
    described = matching.score(question, _description_terms(spec))
    return direct + 0.25 * described


def comprehend(ctx: Context) -> understanding.Reading:
    """What kind of question this is. Computed once and cached on the context."""
    if ctx.reading is None:
        catalogue = tools.catalogue(ctx.persona)
        scored = sorted(((score_tool(ctx.question, s), s) for s in catalogue),
                        key=lambda t: -t[0])
        top = scored[0] if scored else (0.0, None)
        # The turn has already been read once, in context, before planning began. Letting word
        # scoring reach a second, contradictory verdict is what produced "read as a salutation
        # rather than a question about the business. no capability answers it" in reply to
        # "what are you measuring?" -- a real question, refused because two parts of the
        # planner disagreed about what kind of question it was.
        conversational = (ctx.turn_kind != "analysis"
                          and bool(top[1]) and top[1].intent in ("greeting", "help")
                          and top[0] >= MIN_SELECT_SCORE)
        # The capability the words reach for, when they reach for one clearly. Passed in so a
        # question that matches a capability but no metric is answered rather than refused.
        # The best REAL capability, not the best of everything: `describe_identity` ties with the
        # catalogue on "what are you measuring", and taking the absolute top then discarded the
        # match because that tool is conversational, leaving the question unreadable.
        wanted = next((spec.name for value, spec in scored
                       if value >= MIN_SELECT_SCORE
                       and spec.intent not in ("greeting", "help")), "")
        ctx.reading = understanding.read(
            ctx.question, _mentions_metric(ctx), conversational,
            matched=matched_metrics(ctx), capability=wanted)
    return ctx.reading


def governed(ids: list[str] | tuple[str, ...]) -> list[str]:
    """The subset carrying a Tier 1 contract. Empty when the registry cannot be read."""
    try:
        from api.intelligence.contracts import load_declared
        declared = set(load_declared())
    except Exception:                                               # noqa: BLE001
        return []
    return [k for k in ids if k in declared]


def matched_metrics(ctx: Context) -> tuple[str, ...]:
    """Metrics this turn is about. The conversation wins when it resolved a reference."""
    if ctx.matched_from_history:
        return tuple(ctx.matched_from_history)
    return _matched_by_words(ctx)


def _matched_by_words(ctx: Context) -> tuple[str, ...]:
    """Metrics the question's vocabulary reaches, GOVERNED ones preferred.

    "loan" reaches both loan contracts and eight auto-discovered event series (`loan.page.view`,
    `loan.kyc.failure`). Ranked together, a page-view counter led the answer while an urgent KYC
    contract sat below it. The tier boundary is the same one `rank_movements` already draws:
    a governed KPI is a thing the business decided to manage, a discovered series is not.

    Tier 0 stays reachable -- when nothing governed matches, the discovered series are the answer.
    """
    # A declared alias is the strongest signal there is, so it leads.
    aliased = resolve_metrics(ctx.question, list(ctx.metric_ids))
    hits = matching.metrics_named(ctx.question, ctx.metric_ids)
    merged = list(dict.fromkeys([*aliased, *hits]))
    return tuple(governed(merged) or merged)


def candidates(ctx: Context,
               catalogue: list[tools.ToolSpec]) -> list[tuple[float, tools.ToolSpec]]:
    """Every capability this question needs, best first. The planner's search space.

    Selection follows the READING of the question, not its spelling. An investigation asks for the
    whole chain -- what moved, what explains it, what to do -- whether or not the user happened to
    use a cue word for each stage, which is why "how is my business doing" now returns a briefing
    instead of an abstention.

    Module-level because the critic needs the same view: sufficiency is "has every capability the
    question ASKED FOR been attempted", and answering that from a different scorer than the one
    that chose the calls would let the two disagree.
    """
    named = _mentions_metric(ctx)
    usable = [s for s in catalogue if named or not s.needs_named_metric]
    scored = [(value, spec) for value, spec in
              ((score_tool(ctx.question, spec), spec) for spec in usable)
              if value >= MIN_SELECT_SCORE]
    scored.sort(key=lambda t: (-t[0], t[1].priority, t[1].name))
    # A salutation is a whole intent. Pairing it with a variance report answers a question
    # nobody asked and buries the greeting.
    #
    # But the turn has already been read, and a turn read as ANALYSIS is never a salutation
    # however politely it opens. Scoring on words alone sent "thanks, now why did revenue fall
    # over the last 30 days" to the greeting tool, because "thanks" outscored everything else in
    # a sentence that was plainly a question.
    conversational = [t for t in scored if t[1].intent in ("greeting", "help")]
    keyword = [t for t in scored if t[1].intent not in ("greeting", "help")]
    if ctx.turn_kind == "analysis":
        conversational = []
    if conversational and scored and conversational[0][0] >= scored[0][0]:
        return conversational[:1]

    reading = comprehend(ctx)
    if not reading.is_investigation:
        return keyword

    # The chain the reading asks for, in narrative order, plus anything the wording additionally
    # matched. Entitlement still applies: `usable` is already the persona's catalogue.
    by_intent: dict[str, tools.ToolSpec] = {}
    for spec in usable:
        by_intent.setdefault(spec.intent, spec)
    wanted = [understanding.slot_for(i) for i in reading.chain]
    chain = [by_intent[intent] for intent, slot in zip(reading.chain, wanted)
             if intent in by_intent and (not slot or slot in reading.wants)]

    ordered: list[tuple[float, tools.ToolSpec]] = []
    seen: set[str] = set()
    for spec in chain:
        ordered.append((1.0, spec))
        seen.add(spec.name)
    # Capabilities that describe the PLATFORM rather than the movement. They are real answers to
    # their own questions and pure noise inside an investigation: "why are signups increasing"
    # was coming back with the finding, then the full metric catalogue, then "I am the analytics
    # agent for this platform" -- three answers to two questions nobody asked.
    for value, spec in keyword:
        if spec.name in seen or spec.intent in _META_INTENTS:
            continue
        ordered.append((value, spec))
        seen.add(spec.name)
    return ordered


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
        return score_tool(question, spec)

    def _candidates(self, ctx: Context,
                    catalogue: list[tools.ToolSpec]) -> list[tuple[float, tools.ToolSpec]]:
        return candidates(ctx, catalogue)

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
        reading = comprehend(ctx)
        # A question this system has no business answering is refused rather than answered about
        # the persona's favourite metric: "what about transaction record data" matched a capability
        # on one word of its DESCRIPTION, named no metric, fell back to the preference list, and
        # reported loan approval rate with full confidence.
        #
        # A direct SELECTOR hit still wins. Cue words are what a capability declares it answers to,
        # so a question that names one is asking for it however little else it says -- and refusing
        # those made a newly registered capability unreachable by its own cue.
        if reading.shape == "unmatched":
            named_cue = any(matching.score(ctx.question, spec.selectors) >= 1
                            for _, spec in candidates)
            if not named_cue:
                return Plan(thought="Understood: %s. No capability answers it." % reading.reason,
                            done=True, engine=self.engine)
        if not chosen:
            # Nothing matched. Reading the standing finding is a reasonable default for a question
            # that IS about the business ("give me the position") and a bad one for a question
            # that is not -- answering an unrelated question with a variance report is worse than
            # saying no.
            if not named:
                return Plan(thought="Understood: %s. No capability answers it." % reading.reason,
                            done=True, engine=self.engine)
            chosen = [tools.REGISTRY["get_insight"]] if personas.allows(ctx.persona, "status") \
                else catalogue[:1]
        calls = [Call(s.name, self._args(ctx, s), "%s stage of the reading" % s.intent)
                 for s in chosen]
        return Plan(thought="Understood: %s. Running %s."
                            % (reading.reason, ", ".join(c.tool for c in calls)),
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
        # An ambiguous mention narrows the ranking instead of being discarded: "what about loan
        # data" reached two loan KPIs, and ranking the whole portfolio would answer about neither.
        if "scope" in spec.params:
            reading = comprehend(ctx)
            if len(reading.metrics) > 1:
                args["scope"] = ",".join(reading.metrics)
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
        # The refusal lived only in the rule planner, so turning the model on quietly removed it:
        # "what is the capital of France" and "tell me a joke" were handed to the model, which
        # dutifully planned a metric lookup and answered them with a variance report. A question
        # this system has no business answering is refused BEFORE the model is asked, which is also
        # the cheaper order.
        reading = comprehend(ctx)
        if round_n == 0 and reading.shape == "unmatched":
            return Plan(thought="Understood: %s. No capability answers it." % reading.reason,
                        done=True, engine=self.engine)
                        
        if reading.shape == "conversational":
            return self._fallback.plan(ctx, observations, round_n)

        prompt = self._prompt(ctx, observations, round_n)
        # A plan is a decision, not prose. Sampled at temperature the same question
        # picked different capabilities on different runs.
        obj, t_in, t_out = llm_client.complete_json(prompt, temperature=0.0)
        self.tokens_in += t_in
        self.tokens_out += t_out
        if not isinstance(obj, dict):
            return self._fallback.plan(ctx, observations, round_n)
        # A capability that already returned must not be called again. A small model re-proposes
        # its last action rather than moving on: asked one question it planned `get_causes` three
        # rounds running, never reached `get_insight`, and the answer lost its "what changed"
        # section entirely while spending three rounds of tokens. The rule planner has always
        # excluded what it has tried; this holds the model to the same rule rather than trusting
        # it to notice.
        already = {o.tool for o in observations if o.ok}
        calls, repeats = [], []
        for raw in (obj.get("calls") or [])[:MAX_CALLS_PER_ROUND]:
            if not isinstance(raw, dict) or not raw.get("tool"):
                continue
            name = str(raw["tool"])
            if name in already:
                repeats.append(name)
                continue
            args = raw.get("args") if isinstance(raw.get("args"), dict) else {}
            args.setdefault("tenant_id", ctx.tenant_id)
            calls.append(Call(name, args, str(raw.get("why") or "")))

        # An investigation establishes WHAT moved before asking where it concentrated. The model
        # planned `get_causes` on round 0 for "why did KYC fall"; Localize refused because it had
        # no movement to decompose, the round was wasted, and only the fallback then reached
        # `get_insight`. Ordering is not the model's to choose: you cannot localise a movement you
        # have not established.
        if round_n == 0 and comprehend(ctx).is_investigation and calls:
            status = next((s for s in tools.catalogue(ctx.persona)
                           if s.intent == "status" and not s.needs_named_metric), None)
            named = {c.tool for c in calls}
            if status and status.name not in named:
                calls.insert(0, Call(status.name, self._fallback._args(ctx, status),
                                     "establish the movement before explaining it"))
            else:
                calls.sort(key=lambda c: tools.REGISTRY[c.tool].priority
                           if c.tool in tools.REGISTRY else 99)

        thought = str(obj.get("thought") or "").strip() or "Planning the next step."
        if repeats and not calls:
            # The model had nothing new to propose. Stopping here would end the run early and lose
            # the parts of the question it never got to, so the deterministic planner takes over
            # and fills the gap it can already see. The model chooses while it is contributing;
            # it does not get to end an investigation by repeating itself.
            gap = self._fallback.plan(ctx, observations, round_n)
            if gap.calls:
                gap.thought = ("%s already consulted; continuing with %s."
                               % (", ".join(sorted(set(repeats))),
                                  ", ".join(c.tool for c in gap.calls)))
                return gap
            return Plan(thought="%s already answered; nothing further bears on the question."
                                % ", ".join(sorted(set(repeats))),
                        calls=[], done=True, engine=self.engine)
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
            # The reading is computed deterministically and given to the model as context. Without
            # it a small model answers only the first clause of a compound question: asked "why
            # did X change AND where is it concentrated" it planned the cause tool alone and the
            # answer never said what changed.
            f"HOW THE QUESTION READS: {comprehend(ctx).reason}\n"
            f"Plan for ALL of that, not only the first part. Do not call a tool that already "
            f"appears in OBSERVATIONS SO FAR.\n\n"
            f"TOOLS YOU MAY CALL:\n{json.dumps(catalogue, indent=1)}\n\n"
            f"OBSERVATIONS SO FAR (round {round_n}):\n{json.dumps(seen, indent=1) or '[]'}\n\n"
            "Decide the NEXT step. Call several tools at once when they are independent. Set "
            "done=true when the observations already answer the question, or when no remaining "
            "tool would help. Use only tool names from the list. Reply with JSON only:\n"
            + PLAN_SCHEMA_HINT
        )


def ensure_chain(plan, ctx, observations):
    """Add any capability the READING asked for that the plan left out.

    Comprehension decides what a question wants; the planner decides how to get it. When the two
    disagree the reading wins, because it is the part that read the question. "What should we do
    about transaction failures" was coming back with the finding and its causes and no
    recommendation at all -- the planner simply did not pick the capability, and the one thing
    the reader actually asked for was the one thing missing.

    Only capabilities the persona may use, and only ones not already run.
    """
    reading = comprehend(ctx)
    if not reading.is_investigation or plan.done:
        return plan
    ran = {o.tool for o in observations} | {c.tool for c in plan.calls}
    by_intent: dict[str, tools.ToolSpec] = {}
    for spec in tools.catalogue(ctx.persona):
        by_intent.setdefault(spec.intent, spec)
    # What the question asked for, plus what this reader always wants. The bias is what makes
    # one question produce a different answer per persona: same verified numbers, a different
    # account of them.
    wanted_intents = list(reading.chain)
    for intent in ctx.profile.chain_bias:
        if intent not in wanted_intents:
            wanted_intents.append(intent)

    for intent in wanted_intents:
        slot = understanding.slot_for(intent)
        # A biased capability is wanted whether or not the question named its slot; that is the
        # whole point of a persona having standing interests.
        if slot and slot not in reading.wants and intent in reading.chain:
            continue
        spec = by_intent.get(intent)
        if spec is None or spec.name in ran:
            continue
        args = {"tenant_id": ctx.tenant_id}
        if "kpi_id" in spec.params and ctx.focus_metric:
            args["kpi_id"] = ctx.focus_metric
        plan.calls.append(Call(tool=spec.name, args=args,
                               why="%s stage the question asked for" % intent))
        ran.add(spec.name)
    return plan


def drop_meta_calls(plan, ctx):
    """Strip platform-describing calls from an investigation, whichever planner proposed them.

    `catalog`, `identity` and `capabilities` answer questions about the assistant. Inside an
    answer about a metric they are noise, and they read as findings because they arrive in the
    same paragraph. A turn that IS about the platform keeps them: the reading decides, not the
    tool.
    """
    reading = comprehend(ctx)
    if not reading.is_investigation:
        return plan
    # Anything the reading itself asked for stays. A portfolio ranking is a real answer to "what
    # moved"; appended to "why did it move" it is a list of other metrics between the reader and
    # the cause they asked about.
    asked_for = set(reading.chain) | set(ctx.profile.chain_bias)
    kept = []
    for call in plan.calls:
        intent = getattr(tools.REGISTRY.get(call.tool), "intent", "")
        if intent in _META_INTENTS and intent not in asked_for:
            continue
        kept.append(call)
    if len(kept) == len(plan.calls):
        return plan
    plan.calls = kept
    return plan


#: Capabilities about the platform itself. Answers to their own questions, noise inside an
#: investigation about a metric.
_META_INTENTS = frozenset({"catalog", "greeting", "help", "cost", "ranking"})


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
    sufficient: bool                                    # is there anything worth saying at all?
    issues: list[str] = field(default_factory=list)
    escalate: bool = False
    # Has every capability the question asked for been attempted? Drives another round; never a
    # reason to withhold an answer that is already usable.
    complete: bool = True
    uncovered: list[str] = field(default_factory=list)


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

    # A compound question is not fully answered because ITS FIRST PART was. "Which metric moved
    # most and what should I do?" stopped as soon as the ranking came back and the CFO was never
    # told the lever -- Decide never ran. `complete` is coverage of what the question asked for and
    # is what drives another round; `sufficient` stays "there is something worth saying", so an
    # exhausted round budget still publishes the partial answer instead of abstaining on it.
    tried = {o.tool for o in observations}
    uncovered = sorted(spec.name for _, spec in candidates(ctx, tools.catalogue(ctx.persona))
                       if spec.name not in tried)
    return Validation(True, issues=issues, escalate=False, complete=not uncovered,
                      uncovered=uncovered)
