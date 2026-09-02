"""Optional LLM narrator. The model phrases; it never computes.

Model-independent by construction: no model name is assumed, guided decoding is offered but not
required, and any failure falls back to the deterministic template. A smaller model is a valid
choice because the model only writes English -- every figure is re-checked against the claim set.
"""
from __future__ import annotations

import collections
import json
import re
import time
import urllib.error
import urllib.request

from api.intelligence import config, personas
from api.intelligence.stages import narrate

SCHEMA = {
    "type": "object",
    "properties": {"headline": {"type": "string"}, "narrative": {"type": "string"}},
    "required": ["headline", "narrative"],
}

_resolved_model: str | None = None
_guided_supported = True


def resolve_model(force: bool = False) -> str | None:
    """Configured name, else whatever the server reports. Never a hardcoded default."""
    global _resolved_model
    if config.LLM_MODEL:
        return config.LLM_MODEL
    if _resolved_model and not force:
        return _resolved_model
    try:
        headers = {}
        if getattr(config, "LLM_API_KEY", ""):
            headers["Authorization"] = f"Bearer {config.LLM_API_KEY}"
        req = urllib.request.Request(f"{config.LLM_BASE_URL}/models", headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=config.LLM_DISCOVERY_TIMEOUT_S) as resp:
            models = (json.loads(resp.read().decode("utf-8")) or {}).get("data") or []
        _resolved_model = models[0].get("id") if models else None
    except Exception:
        _resolved_model = None
    return _resolved_model


# How much of the method to keep, per persona depth. The model decides WORDING; it does not get
# to decide how much method a reader is shown, because that is the persona contract.
# (Restored during the ollama merge — build_prompt below still references these.)
_DEPTH_BRIEF = {
    "summary": "Lead with the financial consequence. State the movement and what it is worth. "
               "Do not name statistical method.",
    "standard": "Lead with the operational position. State the movement, where it concentrated, "
                "and what can be done about it.",
    "full": "Keep the method visible: name the detection basis and the localisation method where "
            "the deterministic rendering does.",
}

# Sentence budget follows depth. A CFO reading four sentences of method is being served the
# analyst's answer.
_LENGTH = {"summary": "Two sentences.", "standard": "Two to three sentences.",
           "full": "Three to four sentences."}


def build_prompt(claim_set: narrate.ClaimSet, persona: str, template_body: str) -> str:
    profile = personas.get(persona)
    depth = profile.detail
    cards = {
        "facts": claim_set.facts,
        "claims": {c.claim_id: {"value": c.value, "unit": c.unit, "label": c.label}
                   for c in claim_set.claims.values()},
    }
    return (
        f"Explain this analytics finding to the reader below, in their language.\n\n"
        f"READER: {profile.label}\n"
        f"THEIR REMIT: {profile.remit}\n"
        f"WHAT THEY NEED: {_DEPTH_BRIEF.get(depth, _DEPTH_BRIEF['standard'])}\n\n"
        "RULES, absolute:\n"
        "1. Use ONLY numbers that appear in `claims`. Copy them exactly, digit for digit.\n"
        "2. Do NOT compute, round, sum, convert or derive any new number.\n"
        "3. Do NOT invent percentages, dates or counts.\n"
        "4. Do NOT add a finding, a cause or a recommendation that is not already in the "
        "deterministic rendering. You may not extend WHAT WAS FOUND.\n"
        "5. You SHOULD explain what the finding means: what the metric measures, why a "
        "movement of this shape matters, what a named segment implies, what the method "
        "establishes and what it leaves open. Explanation is not a new finding, and it is "
        "what the reader is asking for. Where the rendering abstains or calls the evidence "
        "thin, explain WHY rather than glossing over it.\n"
        "6. Write as a careful analyst talking to a colleague: plain sentences, no jargon "
        "left undefined, no filler, no restating the question back.\n"
        f"7. {_LENGTH.get(depth, _LENGTH['standard'])} No markdown, no bullet lists and no "
        "headings; plain paragraphs separated by a blank line.\n\n"
        f"SIGNAL CARDS:\n{json.dumps(cards, sort_keys=True, indent=2)}\n\n"
        f"A correct deterministic rendering:\n{template_body}\n\n"
        'Return only JSON: {"headline": "...", "narrative": "..."}'
    )


def _post(payload: dict) -> dict:
    headers = {"Content-Type": "application/json"}
    if getattr(config, "LLM_API_KEY", ""):
        headers["Authorization"] = f"Bearer {config.LLM_API_KEY}"
    req = urllib.request.Request(
        f"{config.LLM_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _call(prompt: str, model: str, guided: bool) -> tuple[str, int, int]:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        # Determinism as far as the server allows. Correctness never depends on it: the verifier
        # rejects anything the claim set does not support.
        "temperature": config.LLM_TEMPERATURE,
        "seed": config.LLM_SEED,
        "max_tokens": config.LLM_MAX_TOKENS,
    }
    if guided:
        payload["response_format"] = {"type": "json_object"}
        payload["guided_json"] = SCHEMA
    data = _post(payload)
    usage = data.get("usage") or {}
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    return content, int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))


def _parse(content: str) -> tuple[str, str]:
    """Tolerant of a model that wraps JSON in prose or a code fence -- smaller models often do."""
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        text = text[4:].strip() if text.lower().startswith("json") else text.strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return "", ""
    try:
        parsed = json.loads(text[start:end + 1])
    except ValueError:
        return "", ""
    return str(parsed.get("headline", "")).strip(), str(parsed.get("narrative", "")).strip()


def _key(label: str) -> str:
    """Letters and digits only, so 'What changed', 'What Changed' and 'what_changed' all match."""
    return re.sub(r"[^a-z0-9]", "", str(label).lower())


# The percent sign is part of the figure, not decoration around it. Captured so "22.8%" and
# "22.8" are different tokens: a rewrite that returned "the North America region (22.8)" inside a
# list where every other share carried a % passed a number-only check while quietly restating a
# percentage as a bare count. CLAUDE.md's rule is that a figure is never stated without the unit
# it was measured in, and this is where that rule is cheap to enforce.
_NUMBER = re.compile(r"\d[\d,]*\.?\d*\s*%?")


def _figures(text: str) -> collections.Counter:
    """Every figure in a sentence, as a multiset. Separators stripped so 4,620 == 4620."""
    return collections.Counter(
        m.group(0).replace(",", "").replace(" ", "").rstrip(".")
        for m in _NUMBER.finditer(text or ""))


def narrate_sections(claim_set: narrate.ClaimSet, persona: str,
                     sections: list[dict]) -> dict:
    """Rewrite each part of an answer for this reader, keeping the parts.

    The ask path composed its prose from per-capability templates, so with the model running the
    agent chose the ROUTE but never wrote the words. This gives it the words while keeping
    everything that makes them safe:

      * The four labels are scaffolding and are not up for negotiation. The model fills them; it
        cannot merge, drop or invent one, because the result is matched back by label.
      * Each rewritten part is verified INDEPENDENTLY against the claim set. One part that states
        an unsupported figure falls back to its own template, and the other three still improve.
        An all-or-nothing rewrite would throw away three good sections to punish one.
      * One call for the whole answer, not one per section: four round trips to a local 1.5B model
        is several seconds a reader spends watching a spinner.

    Returns {label: text} for the parts that were rewritten AND verified. A label absent from the
    result keeps its deterministic text.
    """
    out: dict = {"texts": {}, "engine_type": "rule", "tokens_in": 0, "tokens_out": 0,
                 "rewritten": 0, "rejected": [], "reason": "disabled"}
    if not config.LLM_ENABLED or not config.LLM_NARRATE_SECTIONS or not sections:
        return out
    model = resolve_model()
    if not model:
        out["reason"] = "no_model_available"
        return out

    profile = personas.get(persona)
    parts = {s["label"]: s["text"] for s in sections if s.get("text")}
    if not parts:
        return out

    cards = {
        "facts": claim_set.facts,
        "claims": {c.claim_id: {"value": c.value, "unit": c.unit, "label": c.label}
                   for c in claim_set.claims.values()},
    }
    prompt = (
        "Rewrite each part of this analytics answer for one reader. Keep the parts separate.\n\n"
        f"READER: {profile.label}\n"
        f"THEIR REMIT: {profile.remit}\n"
        f"WHAT THEY NEED: {_DEPTH_BRIEF.get(profile.detail, _DEPTH_BRIEF['standard'])}\n\n"
        "RULES, absolute:\n"
        "1. Return exactly the same keys you are given. Do not add, drop, merge or rename a key.\n"
        "2. Use ONLY numbers that appear in `claims`. Copy them exactly, digit for digit.\n"
        "3. Do NOT compute, round, sum, convert or derive any new number.\n"
        "4. Do NOT add a finding, cause or recommendation that is not already in that part. You "
        "may re-word and re-order within a part; you may not extend it.\n"
        "5. One to three sentences per part. Plain prose. No markdown, no lists, no preamble.\n\n"
        f"SIGNAL CARDS:\n{json.dumps(cards, sort_keys=True, indent=2)}\n\n"
        f"PARTS TO REWRITE:\n{json.dumps(parts, indent=2)}\n\n"
        "Return only a JSON object with the same keys and rewritten string values."
    )

    try:
        content, t_in, t_out = _call(prompt, model, False)
        out["tokens_in"], out["tokens_out"] = t_in, t_out
    except Exception as exc:                                        # noqa: BLE001
        out["reason"] = type(exc).__name__
        return out

    text = (content or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        out["reason"] = "unparseable"
        return out
    try:
        parsed = json.loads(text[start:end + 1])
    except ValueError:
        out["reason"] = "unparseable"
        return out

    # Small models rewrite the keys they were handed: "What changed" comes back as "What Changed"
    # and as "what_changed". Both are the same key to a reader and neither matched, so every
    # rewrite was discarded as a non-answer. Compare on letters and digits only.
    returned = {_key(k): v for k, v in parsed.items()}

    for label, original in parts.items():
        candidate = returned.get(_key(label))
        if not isinstance(candidate, str) or not candidate.strip():
            continue
        candidate = candidate.strip()
        if candidate == original:
            continue
        if not _figures(original):
            # BOTH guards are vacuous on a part that states no figure: the verifier has nothing to
            # check and the figure-set comparison is empty against empty, so the model is free to
            # write whatever it likes. That is how "stayed inside its expected range" became "thus
            # there is no need to explain such a change" -- an editorial judgement the pipeline
            # never made, added where nothing could contradict it. No numbers, no rewrite.
            out["rejected"].append(label)
            continue
        if not narrate.verify(candidate, claim_set)[0]:
            out["rejected"].append(label)
            continue
        if _figures(candidate) != _figures(original):
            # The numeric verifier asks whether a figure traces to a stored row. It cannot ask
            # whether the SENTENCE means anything: a 1.5B model produced "the rate increased from
            # 236 to 29 August 2026", in which every number is real and the claim is gibberish.
            # Requiring the same figures, no more and no fewer, catches a rewrite that has quietly
            # dropped one or dragged a date into an arithmetic clause, without constraining how it
            # words the sentence around them.
            out["rejected"].append(label)
            continue
        out["texts"][label] = candidate
        out["rewritten"] += 1

    out["engine_type"] = "llm" if out["rewritten"] else "rule"
    out["reason"] = "ok" if out["rewritten"] else (
        "every rewrite stated a figure the claim set does not support"
        if out["rejected"] else "model returned nothing usable")
    return out


def narrate_with_llm(claim_set: narrate.ClaimSet, persona: str, template_headline: str,
                     template_body: str) -> dict:
    """Returns the chosen narrative plus telemetry. Falls back to the template on any doubt."""
    global _guided_supported
    out = {"headline": template_headline, "narrative": template_body, "engine_type": "rule",
           "model": "", "tokens_in": 0, "tokens_out": 0, "verifier_pass": True,
           "attempts": 0, "fell_back": True, "latency_ms": 0, "reason": "disabled"}
    if not config.LLM_ENABLED:
        return out

    model = resolve_model()
    if not model:
        out["reason"] = "no_model_available"
        return out

    prompt = build_prompt(claim_set, persona, template_body)
    started = time.perf_counter()
    for attempt in range(1, config.LLM_MAX_ATTEMPTS + 1):
        out["attempts"] = attempt
        try:
            content, t_in, t_out = _call(prompt, model, _guided_supported)
            out["tokens_in"] += t_in
            out["tokens_out"] += t_out
        except urllib.error.HTTPError as exc:
            # A server without guided decoding rejects the extra fields; retry plainly once.
            if _guided_supported and exc.code in (400, 422):
                _guided_supported = False
                continue
            out["reason"] = f"http_{exc.code}"
            break
        except Exception as exc:
            out["reason"] = type(exc).__name__
            break

        headline, body = _parse(content)
        if not headline or not body:
            out["reason"] = "unparseable"
            continue
        if narrate.verify(body, claim_set)[0] and narrate.verify(headline, claim_set)[0]:
            out.update(headline=headline, narrative=body, engine_type="llm", model=model,
                       fell_back=False, reason="ok")
            break
        out["reason"] = "unverified_number"

    out["latency_ms"] = int((time.perf_counter() - started) * 1000)
    return out
