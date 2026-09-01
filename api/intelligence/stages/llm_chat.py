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


def looks_social(question: str) -> str:
    """Which kind of conversational turn this is, if any.

    Matched on the WHOLE utterance, not on a contained word: "thanks, now why did revenue fall"
    is a question with a courtesy attached, and must reach the tools.
    """
    q = (question or "").strip().lower().strip(".!?,")
    if not q or len(q.split()) > 6:
        return ""
    if any(q.startswith(w) for w in ("thank", "thanks", "thx", "nice", "great", "good job",
                                     "well done", "perfect", "awesome", "cool", "ok thanks")):
        return "thanks"
    if q in {"hi", "hello", "hey", "yo", "good morning", "good afternoon", "good evening",
             "hi there", "hello there"} or q.startswith(("hi ", "hello ", "hey ")):
        return "greeting"
    if q in {"bye", "goodbye", "see you", "that's all", "thats all", "nothing else"}:
        return "thanks"
    if q.startswith(("who are you", "what are you", "what can you do", "how do you work",
                     "help", "what do you do")):
        return "help"
    return ""
