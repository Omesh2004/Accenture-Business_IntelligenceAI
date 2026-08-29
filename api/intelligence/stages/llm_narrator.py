"""Optional LLM narrator. The model phrases; it never computes.

Model-independent by construction: no model name is assumed, guided decoding is offered but not
required, and any failure falls back to the deterministic template. A smaller model is a valid
choice because the model only writes English -- every figure is re-checked against the claim set.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from api.intelligence import config
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
        req = urllib.request.Request(f"{config.LLM_BASE_URL}/models", method="GET")
        with urllib.request.urlopen(req, timeout=config.LLM_DISCOVERY_TIMEOUT_S) as resp:
            models = (json.loads(resp.read().decode("utf-8")) or {}).get("data") or []
        _resolved_model = models[0].get("id") if models else None
    except Exception:
        _resolved_model = None
    return _resolved_model


def build_prompt(claim_set: narrate.ClaimSet, persona: str, template_body: str) -> str:
    """Compact signal cards only -- never raw query output. Also the injection surface."""
    cards = {
        "facts": claim_set.facts,
        "claims": {c.claim_id: {"value": c.value, "unit": c.unit, "label": c.label}
                   for c in claim_set.claims.values()},
    }
    return (
        f"Rewrite one short analytics narrative for a {persona}.\n\n"
        "RULES, absolute:\n"
        "1. Use ONLY numbers that appear in `claims`. Copy them exactly, digit for digit.\n"
        "2. Do NOT compute, round, sum, convert or derive any new number.\n"
        "3. Do NOT invent percentages, dates or counts.\n"
        "4. Two to four sentences. No preamble, no markdown, no lists.\n\n"
        f"SIGNAL CARDS:\n{json.dumps(cards, sort_keys=True, indent=2)}\n\n"
        f"A correct deterministic rendering:\n{template_body}\n\n"
        'Return only JSON: {"headline": "...", "narrative": "..."}'
    )


def _post(payload: dict) -> dict:
    req = urllib.request.Request(
        f"{config.LLM_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
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
