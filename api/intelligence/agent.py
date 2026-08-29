"""Persona query agent: answers a natural-language question from the Signal Store.

Deliberately a ROUTER, not a text-to-SQL agent. A free-form query planner would have to be
trusted to write correct SQL against events_raw, which rule 4 forbids and which is exactly how a
system starts producing confident, meaningless numbers. Instead a question is classified into a
closed set of intents, each backed by rows a stage already computed and verified.

Guarantees, in order of application:
  1. Persona is resolved server-side by the caller; entitlement is applied BEFORE any claim is
     built, so a forbidden number is never phrased rather than phrased-then-redacted.
  2. Every number in the answer traces to a Signal Store row via the same verifier the narrator
     uses. An unverifiable draft is replaced by an abstention.
  3. Unrecognised questions abstain and say what they cannot answer -- with the list of what they
     can, so a dead end is still useful.

Every run records a TRACE: each step names the tool it called, what it passed and how long it
took. The trace is the product, not decoration -- it is how a reader checks that an answer came
from a stored row rather than from prose, and it is what the dashboard renders.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime

from api.intelligence import config, personas, reader
from api.intelligence.ids import derive_id, round6
from api.intelligence.stages.narrate import ClaimSet, verify

# Intent -> the words that select it. Ordered: the first intent with a hit wins ties by score,
# and `why` outranks `what` because "why did X drop" also contains a `what` cue.
INTENT_CUES: dict[str, tuple[str, ...]] = {
    "greeting": ("hello", "hi ", "hey", "good morning", "good afternoon", "good evening",
                 "thanks", "thank you", "who are you", "what are you"),
    "help": ("help", "what can you", "what can i ask", "capabilit", "how do i use",
             "what questions"),
    "ranking": ("moved most", "moved the most", "biggest", "largest change", "worst",
                "top issue", "most material", "most severe", "what should i look at",
                "priorit", "rank"),
    # Deliberately narrow: a bare "which metric" also opens "which metric moved most", which is a
    # ranking question, not a request for the catalogue.
    "catalog": ("which kpis", "what kpis", "which metrics do you", "what metrics do you",
                "list kpi", "list metric", "do you track", "are you tracking",
                "which contracts", "what do you cover"),
    "definition": ("what is", "what does", "define", "definition", "calculated", "computed",
                   "how do you calculate", "how is it measured", "formula", "mean by"),
    "cause": ("why", "cause", "reason", "driver", "drove", "drive", "because", "explain",
              "blame", "root"),
    "where": ("where", "which segment", "which region", "concentrat", "breakdown", "split",
              "by device", "by channel", "by location", "segment"),
    "factor": ("price", "volume", "mix", "factor", "decompos"),
    "forecast": ("forecast", "predict", "expect", "projection", "next week", "will be",
                 "outlook", "trend"),
    "action": ("what should", "action", "recommend", "fix", "do about", "next step", "lever",
               "mitigat", "remediat"),
    "freshness": ("fresh", "stale", "up to date", "last load", "source", "sla", "pipeline",
                  "data quality", "lag", "how current", "how recent", "when was the data"),
    "trust": ("trust", "reliable", "can i trust", "confidence", "verified", "quarantine"),
    "cost": ("cost", "token", "latency", "how much did", "llm", "spend on"),
    "status": ("what happened", "what changed", "summary", "overview", "status", "anything"),
}

# Derived view of the registry, kept because callers and gates read it by name. personas.py is
# the source of truth, so the two cannot drift.
PERSONA_INTENTS: dict[str, set[str]] = {p.id: set(p.intents)
                                        for p in personas.REGISTRY.values()}

# Intents answerable without selecting a KPI.
KPI_FREE_INTENTS = frozenset({"greeting", "help", "catalog", "freshness", "cost", "ranking"})

# Conversational intents skip metric selection entirely; pairing one with an analytical intent
# would answer a greeting with a variance report.
CONVERSATIONAL = frozenset({"greeting", "help"})

# A question may carry two asks, but only these read as a follow-on clause. "What is X" is a
# lookup, not half of a briefing, so it never appears as a second section.
SECONDARY_ELIGIBLE = frozenset({"cause", "where", "factor", "forecast", "action", "trust",
                                "freshness", "status", "ranking"})

# Courtesy, not a request for a briefing.
THANKS_CUES = ("thanks", "thank you")

_WORD = re.compile(r"[a-z0-9_]+")

# `what is X` reads as a definition only when X is a metric this system governs. Without that
# guard "what is the capital of France" classified as `definition` and was answered.
WEAK_DEFINITION_CUES = ("what is", "what does", "mean by")

_METRIC_WORDS: frozenset[str] | None = None


def _metric_words() -> frozenset[str]:
    """Every word appearing in a governed contract id or name. Loaded once; contracts are static."""
    global _METRIC_WORDS
    if _METRIC_WORDS is None:
        words: set[str] = set()
        try:
            from api.intelligence.contracts import load_declared
            for kpi_id, contract in load_declared().items():
                words.update(_WORD.findall(kpi_id.lower()))
                words.update(_WORD.findall(str(contract.raw.get("name", "")).lower()))
        except Exception:
            pass
        _METRIC_WORDS = frozenset(w for w in words if len(w) > 2)
    return _METRIC_WORDS


def names_a_metric(question: str) -> bool:
    return bool(set(_WORD.findall((question or "").lower())) & _metric_words())


# ── trace: what the agent did, in order, with the tool it used ─────────────────────────────────
@dataclass
class Step:
    n: int
    label: str
    tool: str
    detail: str = ""
    status: str = "ok"          # ok | skipped | abstained | failed
    ms: int = 0

    def as_dict(self) -> dict:
        return {"n": self.n, "label": self.label, "tool": self.tool, "detail": self.detail,
                "status": self.status, "ms": self.ms}


class Trace:
    """Records one step per tool call. Timing is per step, not cumulative."""

    def __init__(self) -> None:
        self.steps: list[Step] = []
        self._mark = time.perf_counter()

    def add(self, label: str, tool: str, detail: str = "", status: str = "ok") -> Step:
        now = time.perf_counter()
        step = Step(n=len(self.steps) + 1, label=label, tool=tool, detail=detail, status=status,
                    ms=int((now - self._mark) * 1000))
        self._mark = now
        self.steps.append(step)
        return step

    def as_list(self) -> list[dict]:
        return [s.as_dict() for s in self.steps]


@dataclass
class Answer:
    question: str
    persona: str
    intent: str
    kpi_id: str = ""
    answer: str = ""
    evidence: list[dict] = field(default_factory=list)
    abstained: bool = False
    reason: str = ""
    verifier_pass: bool = True
    engine_type: str = "rule"
    investigation_id: str = ""
    sources: list[dict] = field(default_factory=list)
    trace: list[dict] = field(default_factory=list)
    intents: list[str] = field(default_factory=list)
    persona_label: str = ""
    suggestions: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "question": self.question, "persona": self.persona, "intent": self.intent,
            "kpi_id": self.kpi_id, "answer": self.answer, "evidence": self.evidence,
            "abstained": int(self.abstained), "reason": self.reason,
            "verifier_pass": int(self.verifier_pass), "engine_type": self.engine_type,
            "investigation_id": self.investigation_id, "sources": self.sources,
            "trace": self.trace, "intents": self.intents,
            "persona_label": self.persona_label or personas.get(self.persona).label,
            "suggestions": self.suggestions,
        }


# ── classification ─────────────────────────────────────────────────────────────────────────────
def classify_all(question: str) -> list[tuple[str, float]]:
    """Every intent the question hits, best first. Deterministic across runs."""
    text = " %s " % (question or "").lower()
    order = list(INTENT_CUES)
    scored: list[tuple[float, int, str]] = []
    for intent, cues in INTENT_CUES.items():
        hits = sum(1 for cue in cues if cue in text)
        if hits:
            scored.append((hits, order.index(intent), intent))
    scored = [t for t in scored if t[2] != "definition"
              or _definition_is_real(text, question)]
    # A definition hit that rests only on "what is" is filler phrasing: "what is the outlook for
    # fee revenue" is a forecast question. Demote it below any intent chosen by a real cue.
    weak_definition = (len(scored) > 1
                       and not any(c in text for c in _strong_definition_cues()))
    scored.sort(key=lambda s: (s[2] == "definition" and weak_definition, -s[0], s[1]))
    return [(intent, round6(min(1.0, hits / 3.0))) for hits, _, intent in scored]


def _strong_definition_cues() -> tuple[str, ...]:
    return tuple(c for c in INTENT_CUES["definition"] if c not in WEAK_DEFINITION_CUES)


def _definition_is_real(text: str, question: str) -> bool:
    """A definition hit on a strong cue always counts; a weak one needs a metric to be named."""
    if any(c in text for c in _strong_definition_cues()):
        return True
    return names_a_metric(question)


def classify(question: str) -> tuple[str, float]:
    """(intent, confidence). Deterministic: same question always yields the same intent."""
    ranked = classify_all(question)
    return ranked[0] if ranked else ("unknown", 0.0)


def resolve_kpi(question: str, candidates: list[str]) -> str:
    """Match a KPI id by token overlap. Returns '' when nothing clearly matches."""
    tokens = set(_WORD.findall((question or "").lower()))
    if not tokens:
        return ""
    best, best_score = "", 0
    for kpi_id in sorted(candidates):
        parts = set(re.split(r"[_.\-]", kpi_id.lower()))
        score = len(parts & tokens)
        # A bare "loan" should not beat "loan_approval_rate" when both are asked for.
        if score > best_score or (score == best_score and score and len(kpi_id) < len(best)):
            best, best_score = kpi_id, score
    return best if best_score else ""


def _without_cues(question: str, intent: str) -> str:
    """Drop the words that selected the intent before matching a metric name.

    "Was it price or volume?" is a factor question, but `volume` also appears in
    `loan_approval_volume`, so the agent answered about the wrong metric.
    """
    text = (question or "").lower()
    for cue in INTENT_CUES.get(intent, ()):
        text = text.replace(cue, " ")
    return text


def _abstain(question: str, persona: str, intent: str, reason: str, kpi_id: str = "",
             trace: Trace | None = None) -> Answer:
    return Answer(question=question, persona=persona, intent=intent, kpi_id=kpi_id,
                  abstained=True, reason=reason,
                  answer=_as_sentence("I cannot answer that from recorded evidence: %s" % reason),
                  trace=trace.as_list() if trace else [],
                  intents=[intent],
                  persona_label=personas.get(persona).label,
                  suggestions=list(personas.get(persona).examples))


# ── orchestration ──────────────────────────────────────────────────────────────────────────────
def answer_question(tenant_id: str, question: str, persona: str) -> Answer:
    """Plan, retrieve, compose, verify -- recording the tool used at every step."""
    persona = persona if persona in config.PERSONAS else config.DEFAULT_PERSONA
    profile = personas.get(persona)
    trace = Trace()

    ranked = classify_all(question)
    trace.add("Understand the question", "agent.classify_all",
              "matched " + (", ".join("%s (%.2f)" % (i, c) for i, c in ranked[:3])
                            if ranked else "nothing"),
              status="ok" if ranked else "abstained")
    if not ranked:
        return _unrecognised(tenant_id, question, persona, trace)

    # Entitlement first: a persona must never see a section it cannot ask for.
    permitted = [(i, c) for i, c in ranked if personas.allows(persona, i)]
    blocked = [i for i, _ in ranked if not personas.allows(persona, i)]
    trace.add("Apply persona entitlement", "personas.allows",
              "%s may ask %s%s" % (profile.label, ", ".join(i for i, _ in permitted) or "nothing",
                                   "; withheld " + ", ".join(blocked) if blocked else ""),
              status="ok" if permitted else "abstained")
    if not permitted:
        elsewhere = sorted(p.label for p in personas.REGISTRY.values()
                           if p.id != persona and ranked[0][0] in p.intents)
        redirect = (" -- that is a question for the %s" % " or the ".join(elsewhere)
                    if elsewhere else "")
        return _abstain(question, persona, ranked[0][0],
                        "the %s view (%s) does not cover that question%s"
                        % (persona, profile.label, redirect), trace=trace)

    primary = permitted[0][0]
    if primary in CONVERSATIONAL:
        return _conversational(tenant_id, question, persona, primary, trace)

    # A question may legitimately carry two asks ("why did it drop, and what should we do?").
    # Answer at most two sections so the reply stays a briefing rather than a dump.
    wanted = [primary]
    for intent, _ in permitted[1:]:
        if intent not in CONVERSATIONAL and intent not in wanted:
            wanted.append(intent)
            break

    insight = None
    kpi_id = ""
    if any(i not in KPI_FREE_INTENTS for i in wanted):
        listed = reader.list_insights(tenant_id, persona, limit=config.MAX_KPIS_PER_SWEEP)
        trace.add("List investigated metrics", "reader.list_insights",
                  "%d insight rows visible to this persona" % len(listed),
                  status="ok" if listed else "abstained")
        if not listed:
            return _abstain(question, persona, primary,
                            "no investigation has produced evidence for this tenant yet",
                            trace=trace)

        # No KPI named -- a follow-up like "where is it concentrated?" -- leaves kpi_id empty, and
        # latest_insight then applies the same ranking the dashboard uses (anomaly first, governed
        # contract next, materiality after). Picking here instead made the agent answer about a
        # different metric than the one on screen.
        kpi_id = resolve_kpi(_without_cues(question, primary), [r["kpi_id"] for r in listed])
        trace.add("Select the metric", "agent.resolve_kpi",
                  kpi_id or "none named; ranking by materiality",
                  status="ok" if kpi_id else "skipped")

        insight = reader.latest_insight(tenant_id, persona, kpi_id or None)
        trace.add("Retrieve the recorded finding", "reader.latest_insight",
                  "%s (%s)" % (insight.get("kpi_id"),
                               "anomaly recorded" if insight.get("anomaly_id")
                               else "no anomaly") if insight else "no matching insight",
                  status="ok" if insight else "abstained")
        if not insight:
            return _abstain(question, persona, primary,
                            "no recorded insight matches that metric", kpi_id, trace=trace)

    sections = [_dispatch(i, tenant_id, question, persona, insight, trace) for i in wanted]
    return _compose(question, persona, wanted, sections, trace)


def _dispatch(intent, tenant_id, question, persona, insight, trace) -> Answer:
    if intent == "freshness":
        return _answer_freshness(tenant_id, question, persona, trace)
    if intent == "cost":
        return _answer_cost(tenant_id, question, persona, trace)
    if intent == "catalog":
        return _answer_catalog(tenant_id, question, persona, trace)
    if intent == "ranking":
        return _answer_ranking(tenant_id, question, persona, trace)
    if intent == "definition":
        return _answer_definition(tenant_id, question, persona, insight, trace)
    builders = {
        "cause": _answer_cause, "where": _answer_where, "factor": _answer_factor,
        "forecast": _answer_forecast, "action": _answer_action, "trust": _answer_trust,
        "status": _answer_status,
    }
    return builders[intent](tenant_id, question, persona, insight, trace=trace)


def _compose(question, persona, wanted, sections, trace) -> Answer:
    """Merge the answered sections. An abstention on one does not discard the other."""
    answered = [s for s in sections if not s.abstained]
    profile = personas.get(persona)
    if not answered:
        first = sections[0]
        first.trace = trace.as_list()
        first.intents = wanted
        first.persona_label = profile.label
        first.suggestions = list(profile.examples)
        return first

    lead = personas.lead(persona, wanted[0])
    body = " ".join(s.answer for s in answered)
    text = ("%s %s" % (lead, body)).strip() if lead else body

    seen: set[str] = set()
    evidence: list[dict] = []
    for s in answered:
        for claim in s.evidence:
            if claim["claim_id"] not in seen:
                seen.add(claim["claim_id"])
                evidence.append(claim)

    withheld = [s.reason for s in sections if s.abstained and s.reason]
    if withheld:
        text += " On the rest: %s." % "; ".join(withheld)

    trace.add("Compose the reply", "agent._compose",
              "%d section(s) answered, %d withheld" % (len(answered), len(withheld)))
    head = answered[0]
    return Answer(question=question, persona=persona, intent=wanted[0], kpi_id=head.kpi_id,
                  answer=text, evidence=evidence, abstained=False,
                  verifier_pass=all(s.verifier_pass for s in answered),
                  engine_type=head.engine_type, investigation_id=head.investigation_id,
                  sources=head.sources, trace=trace.as_list(), intents=wanted,
                  persona_label=profile.label, suggestions=list(profile.examples))


def _unrecognised(tenant_id, question, persona, trace) -> Answer:
    """A dead end that still helps: say what this persona CAN ask."""
    profile = personas.get(persona)
    trace.add("Offer what is answerable", "personas.get", profile.label)
    text = ("I could not map that to a metric this system investigates. As %s you can ask me "
            "why a metric moved, where it concentrated, what is recommended, how reliable a "
            "figure is, or which metrics are tracked. For example: “%s”."
            % (profile.label, profile.examples[0] if profile.examples else "What drove the change?"))
    return Answer(question=question, persona=persona, intent="unknown", answer=text,
                  abstained=True,
                  reason="the question does not map to a metric this system investigates",
                  trace=trace.as_list(), intents=["unknown"], persona_label=profile.label,
                  suggestions=list(profile.examples))


def _conversational(tenant_id, question, persona, intent, trace) -> Answer:
    """Greeting and help. No figures, so nothing to verify -- and nothing to get wrong."""
    profile = personas.get(persona)
    listed = reader.list_insights(tenant_id, persona, limit=config.MAX_KPIS_PER_SWEEP)
    trace.add("Check what has been investigated", "reader.list_insights",
              "%d insight rows visible to this persona" % len(listed))
    moved = sorted({r["kpi_id"] for r in listed if r.get("anomaly_id")})
    quiet = sorted({r["kpi_id"] for r in listed})

    if intent == "greeting":
        parts = [profile.greeting, profile.remit]
        if moved:
            parts.append("Metrics currently flagged: %s." % ", ".join(
                _pretty(k) for k in moved[:4]))
        elif quiet:
            parts.append("Nothing is currently outside its expected band.")
        parts.append("Ask me anything about them — for example “%s”."
                     % (profile.examples[0] if profile.examples else "What drove the change?"))
    else:
        parts = ["As %s you can ask about: %s." % (
            profile.label, ", ".join(sorted(profile.intents - CONVERSATIONAL)).replace("_", " "))]
        parts.append("I answer only from recorded investigations, so every figure traces to a "
                     "stored row and I abstain rather than estimate.")
        if profile.examples:
            parts.append("Try: %s." % "; ".join("“%s”" % e for e in profile.examples))

    trace.add("Compose the reply", "agent._conversational", intent)
    return Answer(question=question, persona=persona, intent=intent, answer=" ".join(parts),
                  trace=trace.as_list(), intents=[intent], persona_label=profile.label,
                  suggestions=list(profile.examples))


_DISPLAY_NAMES: dict[str, str] | None = None


def _pretty(kpi_id: str) -> str:
    """A contract's own `name` wins over title-casing the id, which produced "Kyc Completion"."""
    global _DISPLAY_NAMES
    if _DISPLAY_NAMES is None:
        try:
            from api.intelligence.contracts import load_declared
            _DISPLAY_NAMES = {k: str(c.raw.get("name") or "") for k, c in load_declared().items()}
        except Exception:
            _DISPLAY_NAMES = {}
    return _DISPLAY_NAMES.get(kpi_id) or kpi_id.replace("_", " ").replace(".", " ").title()


# ── builders: each assembles a ClaimSet from stored rows, then renders from it ──────────────
def _show(cs: ClaimSet, claim_id: str, value, unit: str, table: str, label: str,
          dp: int = 0) -> float:
    """Record a claim AT THE PRECISION IT WILL BE SHOWN, and return that value.

    Formatting a stored 57.72 as "58" states a number no row contains, and the verifier rejects
    the whole answer -- correctly. Rounding at the claim keeps what the reader sees identical to
    what the Signal Store holds.
    """
    rounded = round(float(value), dp) if dp else float(round(float(value)))
    cs.add(claim_id, rounded, unit, table, label)
    return cs.claims[claim_id].value


def _claims_from(insight: dict, keep: tuple[str, ...]) -> ClaimSet:
    """Rebuild a ClaimSet from the insight's stored evidence, keeping only what this answer uses."""
    cs = ClaimSet()
    for claim in insight.get("evidence") or []:
        if claim["claim_id"] in keep:
            cs.add(claim["claim_id"], claim["value"], claim["unit"], claim["source"],
                   claim["label"])
    return cs


def _finish(question, persona, intent, insight, cs, draft, engine="rule",
            trace: Trace | None = None) -> Answer:
    ok, unsupported = verify(draft, cs)
    if trace:
        trace.add("Verify every figure", "narrate.verify",
                  "%d claim(s) checked%s" % (len(cs.claims),
                                             "" if ok else "; unsupported: " + ", ".join(
                                                 unsupported[:3])),
                  status="ok" if ok else "failed")
    ans = Answer(question=question, persona=persona, intent=intent,
                 kpi_id=insight.get("kpi_id", ""), evidence=cs.evidence(),
                 investigation_id=insight.get("investigation_id", ""),
                 sources=insight.get("sources") or [], engine_type=engine,
                 persona_label=personas.get(persona).label)
    if not ok:
        ans.abstained = True
        ans.verifier_pass = False
        ans.reason = "a figure in the draft did not trace to a stored row (%s)" % ", ".join(
            unsupported[:3])
        ans.answer = "I cannot answer that: %s" % ans.reason
        return ans
    ans.answer = draft
    return ans


def _quarantined(insight: dict) -> bool:
    return insight.get("trust_verdict") == "fail"


def _as_sentence(text: str) -> str:
    """Headlines carry no terminator, so joining one to the next clause ran two sentences together."""
    text = (text or "").strip()
    return text + "." if text and text[-1] not in ".!?" else text


def _no_movement(insight: dict) -> bool:
    """True when the investigation found nothing to explain.

    An insight with no anomaly is a legitimate, useful answer -- but it is a DIFFERENT answer from
    "something moved and here is why". Conflating them produced sentences like "no material
    movement. No single segment explains it", which implies a movement that does not exist.
    """
    return not (insight.get("anomaly_id") or "").strip()


def _answer_cause(tenant_id, question, persona, insight, trace=None) -> Answer:
    if _quarantined(insight):
        return _abstain(question, persona, "cause",
                        "the metric is quarantined by Trust Gate, so no cause is claimed",
                        insight.get("kpi_id", ""))
    if _no_movement(insight):
        # State the finding plainly rather than assembling a cause for a non-event.
        cs = _claims_from(insight, ("observed", "baseline", "pct_change"))
        draft = ("%s stayed within its expected range for this window, so there is no movement to "
                 "explain." % _pretty(insight.get("kpi_id", "this metric")))
        if "observed" in cs.claims and "baseline" in cs.claims:
            draft += (" It read %.2f against an expected %.2f."
                      % (cs.claims["observed"].value, cs.claims["baseline"].value))
        return _finish(question, persona, "cause", insight, cs, draft, trace=trace)

    cs = _claims_from(insight, ("observed", "baseline", "pct_change", "cause_1_contribution"))
    causes = insight.get("causes") or []
    # Depth, not entitlement. Every persona gets the driver; a summary reader gets one, a deeper
    # reader gets the ranked set. Gating this on a `where` intent meant the CFO got no driver at
    # all, which is a worse answer than a shorter one.
    may_see_cells = bool(causes)
    top = ", ".join("%s=%s" % (k, v) for k, v in (causes[0]["dimensions"].items() if causes
                                                  else [])) if may_see_cells else ""
    parts = [_as_sentence(insight.get("headline", ""))]
    if "observed" in cs.claims and "baseline" in cs.claims:
        parts.append("It moved to %.2f from an expected %.2f."
                     % (cs.claims["observed"].value, cs.claims["baseline"].value))
    if top and "cause_1_contribution" in cs.claims:
        cs.facts["segment"] = top
        parts.append("The largest contributor is %s, accounting for %.1f%% of the move."
                     % (top, cs.claims["cause_1_contribution"].value))
    elif not causes:
        parts.append("No single segment explains it; the movement is spread across the cube.")
    elif not may_see_cells:
        parts.append("A segment-level breakdown is outside this view.")
    return _finish(question, persona, "cause", insight, cs, " ".join(p for p in parts if p),
                   trace=trace)


def _answer_where(tenant_id, question, persona, insight, trace=None) -> Answer:
    causes = insight.get("causes") or []
    if not causes:
        reason = ("%s did not move materially in this window, so there is nothing to localize"
                  % _pretty(insight.get("kpi_id", "this metric"))) if _no_movement(insight) else (
                  "the movement is spread across the cube; no single segment explains it")
        return _abstain(question, persona, "where", reason, insight.get("kpi_id", ""))
    cs = _claims_from(insight, ("cause_1_contribution",))
    lines = []
    for cause in causes[:config.MAX_CAUSES]:
        label = ", ".join("%s=%s" % (k, v) for k, v in cause["dimensions"].items())
        cs.facts["cell_%d" % cause["rank"]] = label
        cid = cs.add("cell_%d_share" % cause["rank"], cause["contribution"] * 100.0, "percent",
                     "root_causes", "rank %d share" % cause["rank"])
        lines.append("%s (%.1f%%)" % (label, cs.claims[cid].value))
    draft = "%s concentrates in: %s." % (_pretty(insight.get("kpi_id", "the metric")),
                                         "; ".join(lines))
    return _finish(question, persona, "where", insight, cs, draft, trace=trace)


def _answer_factor(tenant_id, question, persona, insight, trace=None) -> Answer:
    factors = insight.get("factors") or []
    if not factors:
        reason = ("%s did not move materially, so there is no change to decompose"
                  % _pretty(insight.get("kpi_id", "this metric"))) if _no_movement(insight) else (
                  "this KPI declares no factor identity to decompose")
        return _abstain(question, persona, "factor", reason, insight.get("kpi_id", ""))
    cs = ClaimSet()
    lines = []
    for f in factors:
        cid = cs.add("factor_%s" % f["factor"], f["contribution"] * 100.0, "percent",
                     "root_causes", "%s share" % f["factor"])
        lines.append("%s %.1f%%" % (f["factor"].replace("_", " "), cs.claims[cid].value))
    draft = "By factor, the change splits as: %s." % ", ".join(lines)
    return _finish(question, persona, "factor", insight, cs, draft, trace=trace)


def _answer_forecast(tenant_id, question, persona, insight, trace=None) -> Answer:
    cs = _claims_from(insight, ("forecast_point", "forecast_lower", "forecast_upper"))
    if "forecast_point" not in cs.claims:
        return _abstain(question, persona, "forecast",
                        "no forecast band was recorded for this metric",
                        insight.get("kpi_id", ""))
    draft = ("The recorded forecast for %s is %.2f, within a band of %.2f to %.2f."
             % (_pretty(insight.get("kpi_id", "this metric")), cs.claims["forecast_point"].value,
                cs.claims.get("forecast_lower", cs.claims["forecast_point"]).value,
                cs.claims.get("forecast_upper", cs.claims["forecast_point"]).value))
    return _finish(question, persona, "forecast", insight, cs, draft, trace=trace)


def _answer_action(tenant_id, question, persona, insight, trace=None) -> Answer:
    recs = reader.recommendations(tenant_id, limit=config.MAX_CAUSES,
                                  anomaly_id=insight.get("anomaly_id"))
    if trace:
        trace.add("Read proposed levers", "reader.recommendations",
                  "%d recommendation(s) for this anomaly" % len(recs),
                  status="ok" if recs else "skipped")
    if not recs:
        reason = ("%s is within its expected range, so no action is proposed"
                  % _pretty(insight.get("kpi_id", "this metric"))) if _no_movement(insight) else (
                  "no lever in the contract's closed list applies to this movement")
        return _abstain(question, persona, "action", reason, insight.get("kpi_id", ""))

    # Persona scoping: levers this persona owns are stated in full; the rest are named with their
    # owner so nobody is told a movement has no action when it has one someone else owns.
    mine = [r for r in recs if personas.owns(persona, r.get("owner_role", ""))]
    theirs = [r for r in recs if r not in mine]
    if trace and theirs:
        trace.add("Scope levers to the persona", "personas.owns",
                  "%d owned by %s, %d referred" % (len(mine), personas.get(persona).label,
                                                   len(theirs)))
    cs = ClaimSet()
    lines = []
    for rec in mine:
        cid = cs.add("impact_%s" % rec["rec_id"], (rec.get("expected_impact") or {}).get(
            "high", 0.0), "count", "recommendations", "recoverable impact")
        cs.facts["lever_%s" % rec["rec_id"]] = "%s (%s)" % (rec["lever"], rec["owner_role"])
        lines.append("%s -- lever %s, owner %s, worth up to %.2f if fully recovered"
                     % (rec["action"], rec["lever"], rec["owner_role"], cs.claims[cid].value))

    if lines:
        draft = ("Proposed, pending approval: %s. Nothing is executed automatically."
                 % "; ".join(lines))
    else:
        draft = "No lever here is yours to pull."
    if theirs:
        owners = ", ".join(sorted({r.get("owner_role", "unassigned") for r in theirs}))
        draft += (" %d further action%s sit%s with %s."
                  % (len(theirs), "" if len(theirs) == 1 else "s",
                     "s" if len(theirs) == 1 else "", owners))
        cs.add("referred_actions", float(len(theirs)), "count", "recommendations",
               "actions owned elsewhere")
    return _finish(question, persona, "action", insight, cs, draft, trace=trace)


def _answer_trust(tenant_id, question, persona, insight, trace=None) -> Answer:
    trust = insight.get("trust") or {}
    cs = ClaimSet()
    _show(cs, "checks_passed", trust.get("passed", 0), "count", "trust_findings", "checks passed")
    _show(cs, "checks_failed", trust.get("failed", 0), "count", "trust_findings", "checks failed")
    _show(cs, "confidence", (insight.get("confidence") or 0.0) * 100.0, "percent", "insights",
          "confidence")
    verdict = insight.get("trust_verdict", "ambiguous")
    tail = {"pass": "The metric is safe to act on.",
            "fail": "The metric is quarantined; treat the figures as unreliable.",
            }.get(verdict, "The evidence is ambiguous; treat the figures with caution.")
    draft = ("Trust verdict for %s is '%s': %.0f checks passed, %.0f failed, confidence %.0f%%. %s"
             % (_pretty(insight.get("kpi_id", "this metric")), verdict,
                cs.claims["checks_passed"].value, cs.claims["checks_failed"].value,
                cs.claims["confidence"].value, tail))
    return _finish(question, persona, "trust", insight, cs, draft, trace=trace)


def _answer_status(tenant_id, question, persona, insight, trace=None) -> Answer:
    cs = _claims_from(insight, ("observed", "baseline", "pct_change"))
    draft = _as_sentence(insight.get("headline", ""))
    if "pct_change" in cs.claims:
        draft += " A change of %.1f%% against the expected band." % cs.claims["pct_change"].value
    return _finish(question, persona, "status", insight, cs, draft or "No movement recorded.",
                   trace=trace)


def _answer_definition(tenant_id, question, persona, insight, trace=None) -> Answer:
    """What a metric IS -- read from its contract, not from the data."""
    from api.intelligence.contracts import load_declared
    try:
        declared = load_declared()
    except Exception:
        declared = {}
    if trace:
        trace.add("Read the metric contract", "contracts.load_declared",
                  "%d governed contracts" % len(declared),
                  status="ok" if declared else "failed")
    kpi_id = resolve_kpi(_without_cues(question, "definition"), list(declared)) or \
        (insight or {}).get("kpi_id", "")
    contract = declared.get(kpi_id)
    if not contract:
        return _abstain(question, persona, "definition",
                        "that metric has no governed contract, so it carries no published "
                        "definition", kpi_id)
    raw = contract.raw
    cs = ClaimSet()
    # Contract prose is quoted verbatim; recording it as a fact lets any figure inside it stand
    # as sourced text rather than as an unverifiable number the agent invented.
    definition = " ".join(str(raw.get("definition") or "").split())
    cs.facts["definition"] = definition
    cs.facts["formula"] = str(raw.get("formula") or "")
    owner = ((raw.get("decision") or {}).get("owner") or "unassigned")
    cs.facts["owner"] = owner
    draft = ("%s (%s). %s Formula: %s; unit: %s; measured at %s grain. Owned by %s."
             % (raw.get("name", kpi_id), kpi_id, _as_sentence(definition),
                raw.get("formula", "n/a"), raw.get("unit", "n/a"),
                (raw.get("grain") or {}).get("entity", "event"), owner))
    return _finish(question, persona, "definition", {"kpi_id": kpi_id}, cs, draft, trace=trace)


def _answer_catalog(tenant_id, question, persona, trace=None) -> Answer:
    """Which metrics this persona may ask about. Entitlement is already baked into the rows."""
    listed = reader.list_insights(tenant_id, persona, limit=config.MAX_KPIS_PER_SWEEP)
    if trace:
        trace.add("List investigated metrics", "reader.list_insights",
                  "%d insight rows visible to this persona" % len(listed),
                  status="ok" if listed else "abstained")
    if not listed:
        return _abstain(question, persona, "catalog",
                        "no investigation has produced evidence for this tenant yet")
    try:
        from api.intelligence.contracts import load_declared
        governed = set(load_declared())
    except Exception:
        governed = set()
    visible = sorted({r["kpi_id"] for r in listed})
    tier1 = [k for k in visible if k in governed]
    cs = ClaimSet()
    _show(cs, "governed_count", len(tier1), "count", "insights", "governed metrics")
    _show(cs, "total_count", len(visible), "count", "insights", "metrics investigated")
    draft = ("I am tracking %.0f metrics for this tenant, of which %.0f are governed contracts "
             "with an owner and a lever list: %s."
             % (cs.claims["total_count"].value, cs.claims["governed_count"].value,
                ", ".join(_pretty(k) for k in tier1) or "none"))
    return _finish(question, persona, "catalog", {"kpi_id": ""}, cs, draft, trace=trace)


def _answer_ranking(tenant_id, question, persona, trace=None) -> Answer:
    """What to look at first, ordered by recorded materiality."""
    rows = reader.top_movements(tenant_id, persona, limit=config.MAX_CAUSES)
    if trace:
        trace.add("Rank recorded movements", "reader.top_movements",
                  "%d metric(s) outside their band" % len(rows),
                  status="ok" if rows else "abstained")
    if not rows:
        return _abstain(question, persona, "ranking",
                        "no metric is currently outside its expected band")
    cs = ClaimSet()
    lines = []
    for i, row in enumerate(rows, start=1):
        cid = cs.add("materiality_%d" % i, float(row.get("materiality") or 0.0) * 100.0,
                     "percent", "anomalies", "%s materiality" % row["kpi_id"])
        cs.facts["kpi_%d" % i] = _pretty(row["kpi_id"])
        cs.facts["severity_%d" % i] = str(row.get("severity") or "info")
        lines.append("%s (%s, materiality %.1f%%)"
                     % (_pretty(row["kpi_id"]), row.get("severity") or "info",
                        cs.claims[cid].value))
    draft = "%s." % "; ".join(lines)
    return _finish(question, persona, "ranking", {"kpi_id": rows[0]["kpi_id"]}, cs, draft,
                   trace=trace)


def _answer_freshness(tenant_id, question, persona, trace=None) -> Answer:
    sources = reader.source_health(tenant_id)
    if trace:
        trace.add("Read source freshness", "reader.source_health",
                  "%d source(s) registered" % len(sources),
                  status="ok" if sources else "abstained")
    if not sources:
        return _abstain(question, persona, "freshness", "no source has reported a load yet")
    cs = ClaimSet()
    lines = []
    for src in sources:
        # Round the CLAIM, not just the rendering: a figure shown to the reader that differs from
        # the figure on record is exactly what the verifier exists to catch.
        cid = "behind_%s" % src["source_id"]
        _show(cs, cid, src.get("minutes_behind") or 0.0, "count", "source_freshness",
              "%s minutes behind" % src["source_id"])
        cs.facts["cadence_%s" % src["source_id"]] = src.get("cadence", "")
        lines.append("%s (%s) is %.0f minutes behind and is %s SLA"
                     % (src["source_id"], src.get("cadence", "unknown"), cs.claims[cid].value,
                        "within" if src.get("within_sla") else "outside"))
    draft = "; ".join(lines) + "."
    return _finish(question, persona, "freshness", {"kpi_id": "", "sources": sources}, cs, draft,
                   trace=trace)


def _answer_cost(tenant_id, question, persona, trace=None) -> Answer:
    tel = reader.runtime_telemetry(tenant_id)
    if trace:
        trace.add("Read runtime telemetry", "reader.runtime_telemetry",
                  "%s stage runs" % tel.get("total_runs", 0))
    cs = ClaimSet()
    _show(cs, "total_runs", tel["total_runs"], "count", "model_runs", "stage runs")
    _show(cs, "llm_share", tel["llm_share_pct"], "percent", "model_runs", "LLM share", dp=1)
    _show(cs, "latency_ms", tel["total_latency_ms"], "count", "model_runs", "total latency")
    _show(cs, "tokens", tel["total_tokens"], "count", "model_runs", "total tokens")
    draft = ("Across %.0f stage runs, %.1f%% were LLM calls, totalling %.0f ms and %.0f tokens."
             % (cs.claims["total_runs"].value, cs.claims["llm_share"].value,
                cs.claims["latency_ms"].value, cs.claims["tokens"].value))
    return _finish(question, persona, "cost", {"kpi_id": ""}, cs, draft, trace=trace)


def ask(tenant_id: str, question: str, persona: str, engine: str = "auto") -> dict:
    """Entry point. Runs the orchestration loop, then records the call as a model_run.

    The loop owns the decision of which capabilities to use; `answer_question` below remains as
    the single-shot router and is what the loop degrades to if the loop itself cannot run.
    """
    started = time.time()
    from api.intelligence import loop, tools as tool_registry

    try:
        res = loop.run(tenant_id, question, persona, engine=engine)
        payload = res.as_dict()
        seen: list[str] = []
        for name in res.tools_used:
            spec = tool_registry.REGISTRY.get(name)
            if spec and spec.intent not in seen:
                seen.append(spec.intent)
        payload.update(question=question, intent=seen[0] if seen else "unknown", intents=seen,
                       sources=[], investigation_id="")
        verifier_pass = bool(res.verifier_pass)
        engine_type = res.engine_type
        tokens_in, tokens_out = res.tokens_in, res.tokens_out
    except Exception:                                            # noqa: BLE001
        # An orchestration failure must not lose the question: fall back to the single-shot router.
        result = answer_question(tenant_id, question, persona)
        payload = result.as_dict()
        payload.update(citations=[], tools_used=[], issues=[], escalate=0, rounds=0)
        verifier_pass, engine_type = result.verifier_pass, result.engine_type
        tokens_in = tokens_out = 0

    payload["query_id"] = derive_id(tenant_id, persona, question or "")
    try:
        from api.intelligence import signal_store
        signal_store.write_model_run({
            "run_id": derive_id(payload["query_id"], "ask"),
            "investigation_id": payload.get("investigation_id") or payload["query_id"],
            "tenant_id": tenant_id, "stage": "ask", "engine_type": engine_type,
            "inputs_hash": payload["query_id"],
            "latency_ms": int((time.time() - started) * 1000),
            "tokens_in": tokens_in, "tokens_out": tokens_out, "cost_est_usd": 0.0,
            "verifier_pass": int(verifier_pass),
            "ts": datetime.utcnow().replace(microsecond=0),
        })
    except Exception:
        # Telemetry must never take down an answer.
        pass
    return payload
