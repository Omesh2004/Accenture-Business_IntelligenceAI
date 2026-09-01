"""Conversational turns, phrased by the model rather than by a fixed template.

A greeting, a thank-you or an off-topic aside carries no claim set, so there is nothing for the
verifier to check and nothing the narrator can do with it. That is exactly why these turns used to
be answered by a canned string: the same capability spiel arrived whether the user said "hello" or
"nice, thank you", which is what made the agent read as a form rather than an assistant.

Nothing here may state an analytic number. The only facts it is given are the metric NAMES already
flagged, which the reader can see on the page anyway. Any figure belongs to the tool path, and if
the user asks for one this is not the code that answers.
"""
from __future__ import annotations

import json
import re

from api.intelligence import config, llm_client

# Long enough to be warm and useful, short enough that small talk cannot become an essay.
MAX_TOKENS = 320


def _prompt(kind: str, question: str, persona_label: str, remit: str,
            flagged: list[str], example: str) -> str:
    # On a courtesy the model is told nothing about what moved. Given the list it would say the
    # rate "has dropped recently" -- a finding it never computed, in a turn that ran no tool.
    if kind == "thanks":
        context = "You have not looked at anything this turn."
    elif flagged:
        context = (f"Metrics you could be asked about: {', '.join(flagged)}. You have NOT looked "
                   "at them this turn, so say nothing about what they did.")
    else:
        context = "You have not looked at anything this turn."
    guidance = {
        "greeting": "Greet them back in one line and say what you can help with. Offer the "
                    "example question naturally, not as a menu.",
        "thanks": "Acknowledge it briefly and warmly, in one or two sentences, and offer to keep "
                  "going. This is a courtesy, not a new request: do NOT re-list your "
                  "capabilities, do NOT promise to go and investigate anything now, and do NOT "
                  "say you are looking into a metric. You are not running anything this turn.",
        "help": "Say what you can do, in prose. Ground it in the metrics you are actually "
                "watching. Do not write a bulleted menu.",
        "smalltalk": "Answer briefly and naturally, then steer back to what you can help with. "
                     "One short paragraph.",
    }.get(kind, "Answer briefly and naturally in one short paragraph.")
    return (
        "You are the conversational voice of a KPI intelligence assistant. Reply to the user.\n\n"
        f"YOU ARE SPEAKING AS: {persona_label}\n"
        f"YOUR REMIT: {remit}\n"
        f"WHAT IS ON THE BOARD: {context}\n"
        f"AN EXAMPLE OF A QUESTION YOU ANSWER WELL: {example}\n\n"
        f"THE USER SAID: {question}\n\n"
        "RULES, absolute:\n"
        "1. Do NOT state any statistic, percentage, count, amount or date. You have none, and "
        "inventing one is the single thing you must never do. Metric NAMES are fine.\n"
        "2. Do NOT claim to have done any analysis in this turn.\n"
        "3. No markdown, no bullet lists, no headings. Plain sentences.\n"
        "4. Do not open with a restatement of what they said.\n"
        f"5. {guidance}\n\n"
        "Reply with the message itself and nothing else. No JSON, no quotes around it, no label."
    )


def _clean(text: str) -> str:
    """Strip the wrappers a small model adds around a reply it was asked to give bare."""
    t = (text or "").strip()
    if t.startswith("{") and '"reply"' in t:
        try:
            t = (json.loads(t) or {}).get("reply", "") or ""
        except Exception:                                           # noqa: BLE001
            pass
    t = t.strip().strip("`").strip()
    for lead in ("Reply:", "Response:", "Message:", "Assistant:"):
        if t.startswith(lead):
            t = t[len(lead):].strip()
    if len(t) > 1 and t[0] == t[-1] == '"':
        t = t[1:-1].strip()
    return t


def reply(kind: str, question: str, persona_label: str, remit: str,
          flagged: list[str], example: str, fallback: str) -> tuple[str, int, int]:
    """(text, tokens_in, tokens_out). Falls back to the deterministic string on any doubt."""
    ok, _model = llm_client.available()
    if not ok or not config.LLM_ENABLED:
        return fallback, 0, 0
    try:
        text, tin, tout = llm_client.complete_text(
            _prompt(kind, question, persona_label, remit, flagged, example), MAX_TOKENS)
    except Exception:                                               # noqa: BLE001
        return fallback, 0, 0
    text = _clean(text)
    if not text or len(text) > 1200 or _states_a_figure(text):
        return fallback, tin, tout
    return text, tin, tout


# A statistic, not any digit at all. Rejecting every digit threw away good replies over the "5"
# in a metric name or an ordinary "24/7", and sent back the canned line instead.
_FIGURE = re.compile(r"\d+(?:[.,]\d+)?\s*(?:%|percent|per cent)|\d{2,}|\d+\.\d+")


def _states_a_figure(text: str) -> bool:
    """Whether the reply claims a number it was never given."""
    return bool(_FIGURE.search(text))


_CLASSIFY = """Classify the user's LATEST message to an analytics assistant. Answer with ONE word.

analysis   they want a number, a cause, a trend, a forecast, a recommendation, or anything about
           a business metric.
greeting   they are opening the conversation and have not asked anything yet.
thanks     a courtesy, an acknowledgement, or a sign-off, asking for nothing new.
help       they are asking about YOU: what you can do, who you are, how you work.

Read it IN CONTEXT. A short follow-up that only makes sense against what was just said is
analysis: "what about the others?", "and last month?", "why?", "the second one", "show me more".
A courtesy with a real question attached is analysis. When unsure, answer analysis.
{context}
LATEST MESSAGE: {q}

One word:"""

_KINDS = {"analysis", "greeting", "thanks", "help", "other"}


def _context_block(history) -> str:
    """The recent turns, trimmed, as plain text the model can read."""
    if not history:
        return ""
    lines = []
    for turn in list(history)[-6:]:
        role = "USER" if str(getattr(turn, "role", "")) == "user" else "ASSISTANT"
        text = str(getattr(turn, "text", "") or "").strip().replace(chr(10), " ")
        if not text:
            continue
        kpi = str(getattr(turn, "kpi_id", "") or "")
        tag = f" [about {kpi}]" if kpi and role == "ASSISTANT" else ""
        lines.append(f"{role}{tag}: {text[:300]}")
    if not lines:
        return ""
    return chr(10) + "CONVERSATION SO FAR:" + chr(10) + chr(10).join(lines) + chr(10)


def _fallback_kind(question: str, history=None) -> str:
    """Used only when no model is reachable.

    Deliberately thin. It exists so the assistant still behaves when the GPU is down, not as the
    way turns are normally understood.
    """
    words = re.findall(r"[a-z']+", (question or "").lower())
    if not words:
        return "other"
    # Mid-conversation, a short follow-up is a question about the data, not small talk.
    if history and len(words) <= 6:
        return "analysis"
    if len(words) > 6:
        return "analysis"
    if any(w in {"why", "what", "which", "where", "when", "how", "show", "explain", "compare",
                 "revenue", "signups", "loan", "kyc", "transaction", "rate", "metric",
                 "forecast", "cause", "days", "week", "month", "others", "rest", "more"}
           for w in words):
        return "analysis"
    return "other"


def classify(question: str, history=None) -> str:
    """What kind of turn this is, read in the context of the conversation.

    The model decides. A follow-up carries almost none of its meaning in its own words -- "what
    about the others?" is a complete question to anyone who heard the last answer and gibberish
    to anyone who did not -- so the transcript goes in with it.
    """
    ok, _model = llm_client.available()
    if not ok:
        return _fallback_kind(question, history)
    try:
        text, _tin, _tout = llm_client.complete_text(
            _CLASSIFY.format(q=(question or "").strip()[:400],
                             context=_context_block(history)), 8, temperature=0.0)
    except Exception:                                               # noqa: BLE001
        return _fallback_kind(question, history)
    first = (text or "").strip().lower().split()
    word = re.sub(r"[^a-z]", "", first[0]) if first else ""
    return word if word in _KINDS else _fallback_kind(question, history)


_REST = ("other", "others", "the rest", "what else", "anything else", "remaining",
         "everything else")


def _discussed(history, metric_ids: list[str]) -> list[str]:
    """Metric ids this conversation has already been about, oldest first."""
    seen = []
    for turn in list(history or []):
        kpi = str(getattr(turn, "kpi_id", "") or "")
        if kpi in metric_ids and kpi not in seen:
            seen.append(kpi)
    return seen


def _complement_if_referring(question: str, discussed: list[str],
                             metric_ids: list[str]) -> list[str]:
    """Everything not yet discussed, when the message plainly asks for the rest.

    The model resolves the reference; this catches the plain cases it misses. A small model reads
    "what about the others?" as referring to nothing often enough to matter, and the complement of
    what has already been discussed is not a judgement call.
    """
    q = (question or "").lower()
    if not any(word in q for word in _REST):
        return []
    rest = [m for m in metric_ids if m not in discussed]
    return rest or list(metric_ids)


#: Words that point back at the conversation instead of naming anything.
_REST = ("other", "others", "the rest", "what else", "anything else", "remaining",
         "everything else", "all of them", "the others")
_ANAPHOR = ("it", "that", "this", "those", "these", "one", "same", "there")


def resolve_references(question: str, history, metric_ids: list[str],
                       named: list[str] | None = None) -> list[str]:
    """What a follow-up refers to, when its own words name nothing.

    Precedence matters more than cleverness here. A message that names a metric means that
    metric, always -- asking the model to choose let "why did revenue fall?" come back as three
    unrelated ids. Only when nothing is named does the conversation get a say, and then the
    reference is either "the ones we have not covered" or "the one we were just on". Both are
    determined by what was said, not guessed.
    """
    if not metric_ids or named:
        return []

    discussed = _discussed(history, metric_ids)
    if not discussed:
        return []

    words = set(re.findall(r"[a-z]+", (question or "").lower()))
    lowered = (question or "").lower()

    # "the others", "what else": everything this conversation has not covered yet.
    if any(phrase in lowered for phrase in _REST):
        return [m for m in metric_ids if m not in discussed] or list(metric_ids)

    # "it", "that one", "why?": the metric we were just on.
    if words & set(_ANAPHOR) or len(words) <= 3:
        return [discussed[-1]]

    return []


def _discussed(history, metric_ids: list[str]) -> list[str]:
    """Metric ids this conversation has already been about, oldest first."""
    seen = []
    for turn in list(history or []):
        kpi = str(getattr(turn, "kpi_id", "") or "")
        if kpi in metric_ids and kpi not in seen:
            seen.append(kpi)
    return seen


def looks_social(question: str, history=None) -> str:
    """The conversational kind, or empty when this turn belongs to the tools."""
    kind = classify(question, history)
    return "" if kind in ("analysis", "other") else kind
