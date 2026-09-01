"""Minimal OpenAI-compatible JSON client, shared by the planner and the critic.

Separate from `stages/llm_narrator.py` on purpose: the narrator phrases a finished claim set, this
one makes control-flow decisions. Both are optional. Every caller must work when `available()` is
False -- no GPU, no server, no network -- which is why this returns None rather than raising.
"""
from __future__ import annotations

import json
import re
import urllib.request

from api.intelligence import config

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)
_probe: tuple[bool, str] | None = None


def available() -> tuple[bool, str]:
    """(usable, model). Probed once per process; a missing server is a normal state, not an error."""
    global _probe
    if _probe is not None:
        return _probe
    if not config.LLM_ENABLED:
        _probe = (False, "")
        return _probe
    try:
        req = urllib.request.Request(f"{config.LLM_BASE_URL}/models", method="GET")
        # Short on purpose. This runs on the first request of a fresh process, and a server that
        # is down should cost a moment, not the five seconds the reader sees as the agent thinking.
        probe_timeout = min(config.LLM_DISCOVERY_TIMEOUT_S, 1.5)
        with urllib.request.urlopen(req, timeout=probe_timeout) as resp:
            models = (json.loads(resp.read().decode("utf-8")) or {}).get("data") or []
        model = config.LLM_MODEL or (models[0].get("id") if models else "")
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
        "max_tokens": max_tokens or config.LLM_MAX_TOKENS,
    }
    try:
        req = urllib.request.Request(
            f"{config.LLM_BASE_URL}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        usage = body.get("usage") or {}
        return (content.strip(), int(usage.get("prompt_tokens", 0)),
                int(usage.get("completion_tokens", 0)))
    except Exception:                                               # noqa: BLE001
        return "", 0, 0


def complete_json(prompt: str, max_tokens: int | None = None) -> tuple[dict | None, int, int]:
    """Returns (parsed_object, tokens_in, tokens_out). None means "decide without me"."""
    ok, model = available()
    if not ok:
        return None, 0, 0
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        # Determinism as far as the server allows. Correctness never depends on it: every number
        # is re-checked against the claim set regardless.
        "temperature": config.LLM_TEMPERATURE,
        "seed": config.LLM_SEED,
        "max_tokens": max_tokens or config.LLM_MAX_TOKENS,
    }
    try:
        req = urllib.request.Request(
            f"{config.LLM_BASE_URL}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
        usage = body.get("usage") or {}
        match = _JSON_BLOCK.search(content or "")
        if not match:
            return None, int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))
        return (json.loads(match.group(0)),
                int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0)))
    except Exception:
        # A planner that cannot reach its model plans deterministically instead.
        return None, 0, 0
