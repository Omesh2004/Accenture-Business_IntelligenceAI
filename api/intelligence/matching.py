"""Lexical matching that survives how people actually type.

The planner used raw substring tests against cue words, so `"hi "` matched "hi there" and missed
"hii" -- and the agent abstained on a greeting. Substring matching also fires on fragments inside
unrelated words, which is how "what is X" reached a metric lookup.

This module scores a question against a set of terms using token comparison instead: exact match,
a repeated-letter squeeze ("hii" -> "hi"), a prefix match, and a bounded edit distance. All of it
is deterministic and dependency-free, so the same question always scores the same way.
"""
from __future__ import annotations

import re
from functools import lru_cache

_TOKEN = re.compile(r"[a-z0-9]+")
_RUN = re.compile(r"(.)\1+")

# Below this length a typo allowance is indistinguishable from a different word: "hi"/"be",
# "cost"/"cast". Short tokens must match exactly or by squeeze.
MIN_FUZZY_LEN = 5
MIN_PREFIX_LEN = 4


def normalize(text: str) -> str:
    return " ".join(_TOKEN.findall((text or "").lower()))


def squeeze(token: str) -> str:
    """Collapse repeated letters. Applied to BOTH sides so it is a normalisation, not a guess."""
    return _RUN.sub(r"\1", token)


def tokens(text: str) -> list[str]:
    return _TOKEN.findall((text or "").lower())


@lru_cache(maxsize=4096)
def _within(a: str, b: str, limit: int) -> bool:
    """Bounded Levenshtein. Returns early once the best possible distance exceeds `limit`."""
    if abs(len(a) - len(b)) > limit:
        return False
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        best = i
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            value = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            current.append(value)
            best = min(best, value)
        if best > limit:
            return False
        previous = current
    return previous[-1] <= limit


def token_matches(word: str, target: str) -> bool:
    """Does one question token mean the same as one cue token?"""
    if word == target:
        return True
    if squeeze(word) == squeeze(target):
        return True
    # BOTH sides must be long enough to prefix-match. Keying off the longer one let a 3-letter
    # question token claim any word starting with it -- "pro" matched "product".
    shortest, longest = sorted((len(word), len(target)))
    if shortest >= MIN_PREFIX_LEN and (word.startswith(target) or target.startswith(word)):
        return True
    if shortest >= MIN_FUZZY_LEN:
        return _within(word, target, 2 if longest >= 8 else 1)
    return False


def matches_term(question_tokens: list[str], normalized: str, term: str) -> bool:
    """A term is a single cue word or a phrase. Phrases must appear in order."""
    parts = tokens(term)
    if not parts:
        return False
    if len(parts) == 1:
        return any(token_matches(word, parts[0]) for word in question_tokens)
    # Multi-word cue: exact phrase, or every word present with a fuzzy match. The second form
    # catches "what metrics do you cover" against "what metrics do you".
    if " ".join(parts) in normalized:
        return True
    return all(any(token_matches(word, part) for word in question_tokens) for part in parts)


def score(question: str, terms: tuple[str, ...] | list[str]) -> int:
    """How many of `terms` this question expresses. Deterministic, order-independent."""
    if not terms:
        return 0
    question_tokens = tokens(question)
    if not question_tokens:
        return 0
    normalized = " ".join(question_tokens)
    return sum(1 for term in terms if matches_term(question_tokens, normalized, term))


def names_distinctly(question: str, ids: list[str] | tuple[str, ...]) -> str:
    """The one metric a partial name can only mean, or '' when it is ambiguous.

    `names_any` requires EVERY word of an id, so "tell me about kyc activity" did not count as
    naming a metric: the question has "kyc" and the id is `kyc_completion_rate`. The agent then
    read the whole question as being about no metric at all and abstained. People say "kyc", not
    "kyc completion rate".

    The test is uniqueness, not completeness. A token counts only if it is DISTINCTIVE -- present
    in exactly one of the candidate ids -- so "kyc" resolves while "loan" stays ambiguous between
    `loan_approval_rate` and `loan_approval_volume` and is deliberately left unresolved rather than
    guessed at.
    """
    words = tokens(question)
    if not words:
        return ""
    parts: dict[str, set[str]] = {}
    seen: dict[str, int] = {}
    for kpi_id in ids:
        bits = {p for p in re.split(r"[_.\-]", (kpi_id or "").lower()) if len(p) > 2}
        parts[kpi_id] = bits
        for bit in bits:
            seen[bit] = seen.get(bit, 0) + 1

    hits = {kpi_id for kpi_id, bits in parts.items()
            if any(seen.get(bit) == 1 and any(token_matches(w, bit) for w in words)
                   for bit in bits)}
    return next(iter(hits)) if len(hits) == 1 else ""


def names_any(question: str, phrases: list[str] | tuple[str, ...]) -> bool:
    """Does the question name any of these ids? Splits ids on the separators they use."""
    question_tokens = tokens(question)
    if not question_tokens:
        return False
    for phrase in phrases:
        parts = [p for p in re.split(r"[_.\-]", (phrase or "").lower()) if len(p) > 2]
        if parts and all(any(token_matches(w, p) for w in question_tokens) for p in parts):
            return True
    return False
