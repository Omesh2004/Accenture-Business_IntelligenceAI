"""Read the question before choosing tools.

The planner scored each capability's cue words against the question and ran whatever crossed a
threshold. That works for "where is it concentrated" and fails completely for "how is my business
doing" -- a question with no cue word in it shares no vocabulary with any tool, scores zero
everywhere, and the agent abstained on the most natural question a user can ask.

The missing step was comprehension. This module decides what KIND of question was asked and which
parts of an analysis it wants, and the planner selects capabilities to satisfy that reading rather
than to match its spelling.

Four shapes, and the default matters most:

  * `conversational` -- a greeting or a request for help.
  * `lookup`         -- one narrow fact: a definition, a freshness check, a runtime cost.
  * `diagnostic`     -- something about ONE named metric. Wants the full chain for that metric.
  * `briefing`       -- something about the business as a whole. Wants the same chain, ranked.

A question that is about this business but names nothing specific is a BRIEFING, not an
abstention. The guard against answering an unrelated question with a variance report stays: a
question with no metric and no business vocabulary matches no shape and is still refused.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from api.intelligence import matching

# Narrative slots, in the order a finding is told. This is the shape of a complete answer: what
# moved, over what window, what explains it, and what to do -- the four questions a reader has.
WHAT_CHANGED = "what_changed"
WHEN = "when"
WHY = "why"
WHAT_NOW = "what_now"
ASSURANCE = "assurance"

SLOT_ORDER = (WHAT_CHANGED, WHEN, WHY, WHAT_NOW, ASSURANCE)

SLOT_LABEL = {
    WHAT_CHANGED: "What changed",
    WHEN: "When it happened",
    WHY: "Why it happened",
    WHAT_NOW: "What to do now",
    ASSURANCE: "How far to trust this",
}

# Which slot each capability fills. A tool absent from this map contributes no narrative slot.
INTENT_SLOT = {
    "status": WHAT_CHANGED,
    "ranking": WHAT_CHANGED,
    "cause": WHY,
    "factor": WHY,
    "forecast": WHY,
    "action": WHAT_NOW,
    "trust": ASSURANCE,
    "freshness": ASSURANCE,
    "cost": ASSURANCE,
}

# The chain a diagnostic or briefing question wants, whatever words it used to ask.
DIAGNOSTIC_CHAIN = ("status", "cause", "factor", "action")
BRIEFING_CHAIN = ("ranking", "status", "cause", "action")

# Vocabulary that makes a question ABOUT THIS BUSINESS without naming a metric. Without this the
# briefing default would answer "what is the capital of France" with a variance report; with it,
# that question still contains no business word and is still refused.
_BUSINESS_CUES = frozenset("""
business company bank portfolio performance health status state position update briefing brief
report overview summary situation happening happened going on wrong issue issues problem problems
concern concerns worry worried risk risks trouble troubling alarming urgent attention priority
priorities metric metrics kpi kpis number numbers figure figures result results trend trends
moved moving movement change changed changes drop dropped fall fell rise rose spike anomaly
activity activities volume usage adoption completion approval conversion
anomalies week month quarter today yesterday recently lately now currently
""".split())

# Cues that mean the reader wants a NARROW fact rather than an investigation.
_LOOKUP_CUES = frozenset("""
define definition defined formula calculated computed measured mean means fresh stale sla lag
current recent load loaded cost tokens latency spend
""".split())

_ACTION_CUES = frozenset("""
do should action actions recommend recommended recommendation fix remediate mitigate next step
steps lever levers plan
""".split())

_WHY_CUES = frozenset("""
why cause caused causes reason reasons drove driving driver drivers explain explanation
concentrated concentration where segment segments breakdown split factor factors
""".split())


@dataclass
class Reading:
    """What the question is, and which parts of an analysis it asks for."""
    shape: str                                   # conversational | lookup | diagnostic | briefing
    wants: tuple[str, ...] = ()                  # narrative slots
    chain: tuple[str, ...] = ()                  # tool intents that satisfy `wants`
    reason: str = ""                             # one sentence, for the reasoning trail
    cues: list[str] = field(default_factory=list)
    metrics: tuple[str, ...] = ()                # the metrics the question's vocabulary reaches

    @property
    def is_investigation(self) -> bool:
        return self.shape in ("diagnostic", "briefing")


def _hits(question: str, vocabulary: frozenset) -> list[str]:
    """Which words of a vocabulary this question expresses. Fuzzy, so typos still land."""
    words = matching.tokens(question)
    return sorted({term for term in vocabulary
                   if any(matching.token_matches(w, term) for w in words)})


def read(question: str, names_metric: bool, conversational: bool,
         matched: tuple[str, ...] | list[str] = (), capability: str = "") -> Reading:
    """Classify the question. Deterministic, dependency-free, and explainable.

    `names_metric`, `conversational` and `matched` are passed in rather than recomputed so this
    module stays free of the tool registry -- the planner already knows all three.

    `capability` is the capability the question matched most strongly, when it matched one at
    all. It is the last resort before refusing: "what are you measuring?" names no metric and
    uses no business vocabulary, so every cue test above misses it, and it was being refused as
    unintelligible while the catalogue capability sat scoring top of the list. A question that
    plainly reaches for a capability is a question, not noise.

    `matched` is every metric whose vocabulary the question uses. More than one is NOT a failure to
    understand: "what about loan data" names two loan KPIs, and a reader who does not know the
    catalogue cannot be expected to disambiguate one they have never seen. Those questions are
    answered across the whole matched group, which names the alternatives as a side effect.
    """
    if conversational:
        return Reading("conversational", reason="read as a salutation rather than a question "
                                                "about the business")

    lookup = _hits(question, _LOOKUP_CUES)
    business = _hits(question, _BUSINESS_CUES)
    wants_why = _hits(question, _WHY_CUES)
    wants_action = _hits(question, _ACTION_CUES)

    # A narrow lookup wins only when nothing asks for an investigation: "how is the data doing and
    # why did KYC fall" is a diagnostic that happens to mention freshness.
    if lookup and not wants_why and not wants_action:
        return Reading("lookup", wants=(ASSURANCE,), chain=(),
                       reason="read as a request for one specific fact (%s)" % ", ".join(lookup),
                       cues=lookup)

    # A question that names no metric, asks neither why nor what-to-do, and plainly reaches for
    # one capability IS that request. "What are you measuring" was falling through to the
    # business-cue branch and being read as a briefing, so it was answered with the most material
    # movement instead of the catalogue it asked for.
    if capability and not names_metric and not matched and not wants_why and not wants_action:
        return Reading(
            "lookup", wants=(ASSURANCE,), chain=(),
            reason="read as a request the %s capability answers" % capability.replace("_", " "),
            cues=[capability])

    # Which parts of the chain the question explicitly reaches for. A question that asks none of
    # them but IS about the business wants all of them -- that is what a briefing is.
    wants = [WHAT_CHANGED, WHEN]
    if wants_why:
        wants.append(WHY)
    if wants_action:
        wants.append(WHAT_NOW)
    explicit = bool(wants_why or wants_action)
    if not explicit:
        wants = [WHAT_CHANGED, WHEN, WHY, WHAT_NOW]

    if names_metric:
        return Reading(
            "diagnostic", wants=tuple(wants), chain=DIAGNOSTIC_CHAIN,
            reason=("read as a diagnostic about a named metric, wanting %s"
                    % _describe(wants)),
            cues=sorted(set(wants_why + wants_action)), metrics=tuple(matched))

    # Names business vocabulary that reaches SEVERAL metrics. Answer across all of them rather
    # than refusing or picking one: the reader does not know the catalogue, so asking them to
    # disambiguate a name they have never seen is a dead end, and guessing one silently drops the
    # rest. Covering the group also shows them what the alternatives were.
    if matched:
        return Reading(
            "briefing", wants=tuple(wants), chain=BRIEFING_CHAIN,
            reason=("read as a question about %d related metrics (%s), so each is reported and "
                    "the most material movement is investigated; wanting %s"
                    % (len(matched), _listing(matched), _describe(wants))),
            cues=sorted(set(business + wants_why + wants_action)), metrics=tuple(matched))

    if business:
        return Reading(
            "briefing", wants=tuple(wants), chain=BRIEFING_CHAIN,
            reason=("read as a general question about the business, so the whole portfolio is "
                    "ranked and the most material movement is investigated; wanting %s"
                    % _describe(wants)),
            cues=business)

    # Explicitly asks why or what-to-do, but names neither a metric nor the business. Still an
    # investigation -- "why did it drop" is a perfectly ordinary follow-up.
    if explicit:
        return Reading(
            "briefing", wants=tuple(wants), chain=BRIEFING_CHAIN,
            reason="read as a follow-up about the most material movement, wanting %s"
                   % _describe(wants),
            cues=sorted(set(wants_why + wants_action)))

    return Reading("unmatched", reason="the question names no metric and uses no vocabulary "
                                       "about this business")


def _listing(metrics: tuple[str, ...] | list[str], limit: int = 6) -> str:
    """Name the group without letting a broad word turn the reasoning trail into a wall of ids."""
    metrics = list(metrics)
    if len(metrics) <= limit:
        return ", ".join(metrics)
    return "%s and %d more" % (", ".join(metrics[:limit]), len(metrics) - limit)


def _describe(wants: list[str]) -> str:
    return ", ".join(SLOT_LABEL[w].lower() for w in wants if w in SLOT_LABEL)


def slot_for(intent: str) -> str:
    return INTENT_SLOT.get(intent, "")
