"""LLM narrator, exercised against a scriptable OpenAI-compatible server.

A real model cannot be made to hallucinate a number, reject guided decoding, or return a code
fence on demand, so the branches that matter most are unreachable by pointing at a live server.
This fixture makes every one of them reachable and asserts the narrator degrades correctly.

What this does NOT prove: the English quality of any particular model. It proves that whatever
the model returns, an unsupported number never reaches a reader.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence import config
from api.intelligence.stages import llm_narrator, narrate

# The script the fake server follows for the next call: (status, body).
_SCRIPT: list = []
_SEEN: list = []
MODEL_ID = "some-small-model-v0"


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            self._send(200, {"data": [{"id": MODEL_ID}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        _SEEN.append(json.loads(body or b"{}"))
        status, payload = _SCRIPT.pop(0) if _SCRIPT else (200, _completion("{}"))
        self._send(status, payload)

    def _send(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def _completion(content: str, t_in: int = 10, t_out: int = 20) -> dict:
    return {"choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": t_in, "completion_tokens": t_out}}


@pytest.fixture(scope="module")
def server():
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_port}/v1"
    srv.shutdown()


@pytest.fixture(autouse=True)
def reset(monkeypatch, server):
    _SCRIPT.clear()
    _SEEN.clear()
    llm_narrator._resolved_model = None
    llm_narrator._guided_supported = True
    monkeypatch.setattr(config, "LLM_BASE_URL", server)
    monkeypatch.setattr(config, "LLM_ENABLED", True)
    monkeypatch.setattr(config, "LLM_MODEL", "")
    monkeypatch.setattr(config, "LLM_MAX_ATTEMPTS", 2)


def claims() -> narrate.ClaimSet:
    cs = narrate.ClaimSet()
    cs.add("observed", 15.0, "count", "anomalies", "observed value")
    cs.add("baseline", 24.0, "count", "anomalies", "expected value")
    cs.facts["kpi"] = "Loan Approval Volume"
    return cs


def run(headline="Loan Approval Volume fell", body="It fell to 15.00 from 24.00."):
    return llm_narrator.narrate_with_llm(claims(), "analyst", headline, body)


# ── model independence ─────────────────────────────────────────────────────
def test_model_is_discovered_not_assumed():
    """No model name is hardcoded; whatever the server serves is used."""
    assert llm_narrator.resolve_model(force=True) == MODEL_ID


def test_configured_model_overrides_discovery(monkeypatch):
    monkeypatch.setattr(config, "LLM_MODEL", "my-own-model")
    assert llm_narrator.resolve_model(force=True) == "my-own-model"


def test_no_model_available_falls_back(monkeypatch):
    monkeypatch.setattr(config, "LLM_BASE_URL", "http://127.0.0.1:1/v1")
    out = run()
    assert out["engine_type"] == "rule" and out["reason"] == "no_model_available"


# ── the happy path ─────────────────────────────────────────────────────────
def test_verified_llm_output_is_used():
    _SCRIPT.append((200, _completion(json.dumps(
        {"headline": "Approvals fell", "narrative": "Volume landed at 15.00 versus 24.00."}))))
    out = run()
    assert out["engine_type"] == "llm"
    assert out["fell_back"] is False and out["reason"] == "ok"
    assert out["model"] == MODEL_ID
    assert out["tokens_in"] == 10 and out["tokens_out"] == 20


def test_latency_is_recorded():
    _SCRIPT.append((200, _completion(json.dumps(
        {"headline": "Approvals fell", "narrative": "It reached 15.00."}))))
    assert run()["latency_ms"] >= 0


# ── the guarantee: a hallucinated number never reaches a reader ────────────
def test_invented_number_is_rejected_and_the_template_wins():
    hallucination = json.dumps(
        {"headline": "Approvals collapsed", "narrative": "Volume crashed 87.3% to 3.00."})
    _SCRIPT.extend([(200, _completion(hallucination)), (200, _completion(hallucination))])
    out = run()
    assert out["engine_type"] == "rule", "an unverified figure must not be published"
    assert out["reason"] == "unverified_number"
    assert out["narrative"] == "It fell to 15.00 from 24.00."


def test_invented_number_in_the_headline_alone_is_also_rejected():
    bad = json.dumps({"headline": "Approvals fell 99.9%", "narrative": "It reached 15.00."})
    _SCRIPT.extend([(200, _completion(bad)), (200, _completion(bad))])
    assert run()["engine_type"] == "rule"


def test_a_second_attempt_can_still_succeed():
    """One bad draft does not condemn the call; the retry is verified on its own terms."""
    _SCRIPT.append((200, _completion(json.dumps(
        {"headline": "x", "narrative": "Invented 42.00 here."}))))
    _SCRIPT.append((200, _completion(json.dumps(
        {"headline": "Approvals fell", "narrative": "It reached 15.00."}))))
    out = run()
    assert out["engine_type"] == "llm" and out["attempts"] == 2


# ── small-model tolerance ──────────────────────────────────────────────────
def test_code_fenced_json_is_parsed():
    fenced = "```json\n" + json.dumps(
        {"headline": "Approvals fell", "narrative": "It reached 15.00."}) + "\n```"
    _SCRIPT.append((200, _completion(fenced)))
    assert run()["engine_type"] == "llm"


def test_json_wrapped_in_prose_is_parsed():
    noisy = ("Sure! Here is the narrative you asked for:\n"
             + json.dumps({"headline": "Approvals fell", "narrative": "It reached 15.00."})
             + "\nLet me know if you need anything else.")
    _SCRIPT.append((200, _completion(noisy)))
    assert run()["engine_type"] == "llm"


def test_unparseable_output_falls_back():
    _SCRIPT.extend([(200, _completion("I cannot help with that.")),
                    (200, _completion("still not json"))])
    out = run()
    assert out["engine_type"] == "rule" and out["reason"] == "unparseable"


# ── server capability differences ──────────────────────────────────────────
def test_guided_decoding_rejection_retries_plainly():
    """A server without guided_json 400s. The narrator must drop it, not give up."""
    _SCRIPT.append((400, {"error": "guided_json is not supported"}))
    _SCRIPT.append((200, _completion(json.dumps(
        {"headline": "Approvals fell", "narrative": "It reached 15.00."}))))
    out = run()
    assert out["engine_type"] == "llm"
    assert "guided_json" in _SEEN[0], "first attempt should offer guided decoding"
    assert "guided_json" not in _SEEN[1], "retry must drop it"


def test_server_error_falls_back_without_raising():
    _SCRIPT.append((500, {"error": "boom"}))
    out = run()
    assert out["engine_type"] == "rule" and out["reason"] == "http_500"


def test_disabled_flag_short_circuits(monkeypatch):
    monkeypatch.setattr(config, "LLM_ENABLED", False)
    out = run()
    assert out["engine_type"] == "rule" and out["reason"] == "disabled"
    assert _SEEN == [], "nothing should be sent when the narrator is disabled"


# ── prompt hygiene ─────────────────────────────────────────────────────────
def test_prompt_carries_claims_but_no_raw_rows():
    prompt = llm_narrator.build_prompt(claims(), "analyst", "body")
    assert "observed" in prompt and "15.0" in prompt
    assert "SELECT" not in prompt.upper(), "raw query output must never enter the context"
