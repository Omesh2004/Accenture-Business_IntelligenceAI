"""Minimal OpenAI-compatible JSON client, shared by the planner and the critic.

Separate from `stages/llm_narrator.py` on purpose: the narrator phrases a finished claim set, this
one makes control-flow decisions. Both are optional. Every caller must work when `available()` is
False -- no GPU, no server, no network -- which is why this returns None rather than raising.
"""
from __future__ import annotations

import json
import logging
import re
import urllib.request

from api.intelligence import config

logger = logging.getLogger(__name__)

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)
_probe: tuple[bool, str] | None = None
#: The served context window, read from the model card. 0 until the first probe.
_context_len = 0


def _why(exc: Exception) -> str:
    """The server's own reason, when it gave one. An HTTPError carries it in the body."""
    body = ""
    try:
        body = exc.read().decode("utf-8")[:300]                     # type: ignore[attr-defined]
    except Exception:                                               # noqa: BLE001
        body = ""
    return f"{type(exc).__name__}: {body or exc}"


def _budget(prompt: str, want: int) -> int:
    """How many output tokens the server can actually give for this prompt.

    Asking for more than the context allows is not a truncated answer, it is a 400: the request
    is rejected outright and the caller falls back. That failure is silent by design -- every LLM
    path must survive an unreachable model -- so a budget set higher than the window turned the
    narrator off completely and left the deterministic template answering everything.

    Four characters per token is deliberately pessimistic for English prose, so the estimate
    errs towards asking for less rather than being refused.
    """
    # A server that does not publish its window still HAS one, and Ollama's default is 2048.
    # vLLM refuses an over-long request outright, which is loud; Ollama truncates the prompt
    # silently, which is worse -- the narrator would phrase a claim set with the middle cut out
    # and never know. Assume the conservative default rather than asking for whatever we like.
    context = _context_len or config.LLM_ASSUMED_CONTEXT
    used = len(prompt) // 4
    room = context - used - 64               # a margin for the chat template's own tokens
    return max(64, min(want, room))


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if getattr(config, "LLM_API_KEY", ""):
        h["Authorization"] = f"Bearer {config.LLM_API_KEY}"
    return h


def available() -> tuple[bool, str]:
    """(usable, model). Probed once per process; a missing server is a normal state, not an error."""
    global _probe, _context_len
    if _probe is not None:
        return _probe
    if not config.LLM_ENABLED:
        _probe = (False, "")
        return _probe
    try:
        req = urllib.request.Request(f"{config.LLM_BASE_URL}/models", headers=_headers(), method="GET")
        # Short on purpose. This runs on the first request of a fresh process, and a server that
        # is down should cost a moment, not the five seconds the reader sees as the agent thinking.
        probe_timeout = config.LLM_DISCOVERY_TIMEOUT_S
        with urllib.request.urlopen(req, timeout=probe_timeout) as resp:
            models = (json.loads(resp.read().decode("utf-8")) or {}).get("data") or []
        model = config.LLM_MODEL or (models[0].get("id") if models else "")
        # vLLM publishes the window on the model card. Knowing it is what lets every call size
        # its own request instead of guessing and being refused.
        for card in models:
            if card.get("id") == model or not _context_len:
                _context_len = int(card.get("max_model_len") or 0)
        _probe = (bool(model), model or "")
    except Exception:
        _probe = (False, "")
    return _probe


def reset_probe() -> None:
    """Tests and operators flipping the server on mid-process."""
    global _probe
    _probe = None


def complete_text(prompt: str, max_tokens: int | None = None,
                  temperature: float | None = None) -> tuple[str, int, int]:
    """Plain prose, no JSON envelope. Returns (text, tokens_in, tokens_out).

    A small instruct model asked for JSON on a conversational turn often returns an empty object
    or nothing at all, and the reply is then lost to a parse rather than to anything it said. A
    greeting needs no structure, so none is demanded.
    """
    ok, model = available()
    if not ok:
        return "", 0, 0
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "temperature": config.LLM_TEMPERATURE if temperature is None else temperature,
        "seed": config.LLM_SEED,
        "max_tokens": _budget(prompt, max_tokens or config.LLM_MAX_TOKENS),
    }
    try:
        req = urllib.request.Request(
            f"{config.LLM_BASE_URL}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=_headers(), method="POST")
        with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        usage = body.get("usage") or {}
        return (content.strip(), int(usage.get("prompt_tokens", 0)),
                int(usage.get("completion_tokens", 0)))
    except Exception as exc:                                        # noqa: BLE001
        logger.warning("llm text call failed, falling back to the template: %s", _why(exc))
        return "", 0, 0


def complete_json(prompt: str, max_tokens: int | None = None,
                  temperature: float | None = None) -> tuple[dict | None, int, int]:
    """Returns (parsed_object, tokens_in, tokens_out). None means "decide without me".

    Callers that make a DECISION pass temperature 0. Sampling a plan means the same question
    picks different capabilities on different runs -- one asking for causes and a recommendation,
    the next answering with the reading alone -- which is indefensible when the answer is
    supposed to be reproducible evidence.
    """
    ok, model = available()
    if not ok:
        return None, 0, 0
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        # Determinism as far as the server allows. Correctness never depends on it: every number
        # is re-checked against the claim set regardless.
        "temperature": config.LLM_TEMPERATURE if temperature is None else temperature,
        "seed": config.LLM_SEED,
        "max_tokens": _budget(prompt, max_tokens or config.LLM_MAX_TOKENS),
    }
    try:
        req = urllib.request.Request(
            f"{config.LLM_BASE_URL}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=_headers(), method="POST")
        with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
        usage = body.get("usage") or {}
        match = _JSON_BLOCK.search(content or "")
        if not match:
            return None, int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))
        return (json.loads(match.group(0)),
                int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0)))
    except Exception as exc:
        # A planner that cannot reach its model plans deterministically instead.
        logger.warning("llm json call failed, planning deterministically: %s", _why(exc))
        return None, 0, 0
