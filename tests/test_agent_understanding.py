"""Phase 1: the agent must understand a question as typed, not as spelled in a cue list.

The reported failure: "hii" produced "I cannot answer that from recorded evidence: no capability
matches this question." The cue was the literal substring `"hi "`, so a doubled letter and a
missing trailing space were enough to make the agent refuse to say hello.
"""
import pytest

from api.intelligence import loop, matching, planner, tools


# ── the matcher ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("word,target", [
    ("hii", "hi"), ("helo", "hello"), ("hiii", "hi"), ("thanks", "thank"),
    ("aproval", "approval"), ("revenu", "revenue"), ("concentrated", "concentrate"),
    ("metrics", "metric"), ("FORECAST", "forecast"),
])
def test_a_token_matches_how_people_type_it(word, target):
    assert matching.token_matches(word.lower(), target)


@pytest.mark.parametrize("word,target", [
    # A short token must not claim every word that starts with it.
    ("pro", "product"), ("fee", "feedback"), ("hi", "history"),
    # Nor should two unrelated words of similar length collapse together.
    ("cost", "cast"), ("loan", "load"),
])
def test_a_token_does_not_over_match(word, target):
    assert not matching.token_matches(word, target)


def test_matching_is_deterministic():
    q = "why did loan aproval volume fall"
    assert len({matching.score(q, ("why", "drove", "cause")) for _ in range(20)}) == 1


# ── the planner ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("greeting", ["hii", "hi", "Hi!", "helo", "hey there", "HELLO",
                                      "good morning", "thanks", "thanx"])
def test_a_greeting_however_it_is_typed_reaches_the_greet_capability(greeting):
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", greeting, "analyst", ["loan_approval_volume"])
    assert "greet" in {c.tool for c in brain.plan(ctx, [], 0).calls}, greeting


@pytest.mark.parametrize("question", ["who are you", "what are you", "introduce yourself",
                                      "what is this", "tell me about yourself"])
def test_asking_what_it_is_is_not_answered_with_a_greeting(question):
    """"hii" and "who are you" both used to sit in the greeting's cue list, so both returned the
    identical canned line. They are different questions: one is a salutation, the other asks what
    the user is talking to, and "Good to see you" is the system declining to answer it."""
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", question, "analyst", ["loan_approval_volume"])
    chosen = {c.tool for c in brain.plan(ctx, [], 0).calls}
    assert "describe_identity" in chosen, question
    assert "greet" not in chosen, question


def test_the_two_conversational_capabilities_do_not_share_cues():
    """The regression that produced one answer for two questions was a shared cue list."""
    greet = set(tools.REGISTRY["greet"].selectors)
    identity = set(tools.REGISTRY["describe_identity"].selectors)
    assert not (greet & identity), sorted(greet & identity)


def test_a_capability_is_reachable_through_its_description():
    """A cue list is never complete. What the tool SAYS it does must also route to it."""
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", "which dimension cells did the movement land in",
                          "analyst", ["loan_approval_volume"])
    assert brain._score(ctx.question, tools.REGISTRY["get_causes"]) > 0


def test_a_typo_in_a_metric_name_still_names_the_metric():
    ctx = planner.Context("nexabank", "why did loan aproval volume fall", "analyst",
                          ["loan_approval_volume", "kyc_completion_rate"])
    assert planner._mentions_metric(ctx)
    assert planner.resolve_metric(ctx.question, ctx.metric_ids,
                                  ctx.profile) == "loan_approval_volume"


def test_a_partial_word_does_not_name_a_metric():
    ctx = planner.Context("nexabank", "compare fee revenue and pro revenue", "analyst",
                          ["new_product_activations"])
    assert not planner._mentions_metric(ctx), "'pro' must not claim 'new_product_activations'"


# ── end to end ─────────────────────────────────────────────────────────────
def test_the_reported_failure_is_gone():
    res = loop.run("nexabank", "hii", "ops_manager")
    assert not res.abstained
    assert "Good to see you" in res.answer
    assert "greet" in res.tools_used


def test_loop_bookkeeping_never_reaches_the_reader():
    """"Noted while answering: nothing attempted." was internal state shown as a finding."""
    res = loop.run("nexabank", "tell me a joke", "ops_manager")
    assert "nothing attempted" not in " ".join(res.issues)
    assert "nothing attempted" not in res.answer


# ── Phase 3: persona shapes interpretation, priority and depth ──────────────
def test_depth_is_a_persona_property_not_a_constant():
    from api.intelligence import personas
    cfo, analyst = personas.get("cfo"), personas.get("analyst")
    assert cfo.max_tools_per_round < analyst.max_tools_per_round
    assert cfo.max_rounds <= analyst.max_rounds


def test_a_persona_does_not_exceed_its_declared_width():
    from api.intelligence import personas
    brain = planner.RulePlanner()
    question = "why did it drop, where is it concentrated, and what should we do"
    for pid in ("cfo", "ops_manager", "analyst"):
        ctx = planner.Context("nexabank", question, pid, ["loan_approval_volume"])
        plan = brain.plan(ctx, [], 0)
        assert len(plan.calls) <= personas.get(pid).max_tools_per_round, pid


def test_a_quiet_portfolio_answers_the_personas_priority_metric():
    """With nothing moving there is no materiality to defer to, so relevance is the persona's."""
    from api.intelligence import personas
    candidates = ["cost_per_acquisition", "fee_revenue", "loan_approval_rate"]
    assert planner.resolve_metric("why did it drop", candidates, personas.get("cfo"),
                                  moved=[]) == "fee_revenue"
    assert planner.resolve_metric("why did it drop", candidates, personas.get("ops_manager"),
                                  moved=[]) == "loan_approval_rate"


def test_a_metric_that_moved_still_outranks_a_persona_favourite():
    from api.intelligence import personas
    candidates = ["fee_revenue", "loan_approval_rate"]
    # `loan_approval_rate` moved; the CFO prefers `fee_revenue`. Materiality must win.
    assert planner.resolve_metric("why did it drop", candidates, personas.get("cfo"),
                                  moved=["loan_approval_rate"]) == ""


def test_a_greeting_is_never_paired_with_a_variance_report():
    brain = planner.RulePlanner()
    ctx = planner.Context("nexabank", "hii", "ops_manager", ["loan_approval_volume"])
    assert {c.tool for c in brain.plan(ctx, [], 0).calls} == {"greet"}


# ── Phase 4: structured synthesis, sources and confidence ──────────────────
def test_an_answer_is_structured_into_sourced_sections():
    res = loop.run("nexabank", "is the data fresh and can i trust it", "analyst")
    assert res.sections, "a multi-part answer must expose its parts"
    for section in res.sections:
        assert section["label"] and section["text"]
        assert section["tool"] in tools.REGISTRY
        assert section["source"], "every section names what it was read from"
    # The flat prose stays consistent with the parts it was assembled from.
    for section in res.sections:
        assert section["text"] in res.answer


def test_confidence_is_derived_and_explained_never_asserted():
    res = loop.run("nexabank", "why did it drop", "analyst")
    assert 0.0 <= res.confidence <= 1.0
    if res.confidence < 1.0:
        assert res.uncertainty, "a reduced confidence must say what reduced it"
    # Confidence describes the answer; it must not be smuggled in as a business figure.
    assert "%.2f" % res.confidence not in res.answer


def test_an_unverifiable_answer_has_no_confidence(monkeypatch):
    from api.intelligence import planner as pl
    obs = [pl.Observation("get_insight", {}, True, "ok", "insights", rendered="x")]
    score, reasons = loop._confidence(obs, pl.Validation(True), verifier_pass=False, claims=[])
    assert score == 0.0 and reasons


def test_a_contradiction_collapses_confidence():
    from api.intelligence import planner as pl
    obs = [pl.Observation("a", {}, True, "ok", "insights", rendered="x"),
           pl.Observation("b", {}, True, "ok", "anomalies", rendered="y")]
    clean, _ = loop._confidence(obs, pl.Validation(True, []), True, [{"claim_id": "c"}])
    conflicted, reasons = loop._confidence(
        obs, pl.Validation(True, ["two sources disagree on observed (10 vs 42)"]), True,
        [{"claim_id": "c"}])
    assert conflicted < clean
    assert any("disagree" in r for r in reasons)


# ── Phase 5a: drivers for every persona; depth is detail, not existence ────
_CAUSES = [
    {"rank": 1, "dimensions": {"channel": "mobile"}, "contribution": 0.583,
     "method": "greedy_cube"},
    {"rank": 2, "dimensions": {"channel": "web"}, "contribution": 0.291,
     "method": "greedy_cube"},
    {"rank": 3, "dimensions": {"region": "North"}, "contribution": 0.126,
     "method": "greedy_cube"},
]


def _causes_for(persona, monkeypatch):
    monkeypatch.setattr(tools.reader, "latest_insight",
                        lambda *a, **k: {"kpi_id": "fee_revenue", "causes": _CAUSES})
    res = tools.run("get_causes", {"tenant_id": "nexabank"}, persona)
    return res, tools.render("get_causes", res, persona)


@pytest.mark.parametrize("persona", ["cfo", "ops_manager", "analyst"])
def test_every_persona_receives_root_cause_analysis(persona, monkeypatch):
    """The bug this replaces: the CFO got movement summaries with no driver for anything."""
    res, text = _causes_for(persona, monkeypatch)
    assert res.ok and text
    assert "mobile" in text, "the dominant driver is named for every persona"


def test_depth_changes_how_much_of_the_finding_is_shown(monkeypatch):
    _, cfo = _causes_for("cfo", monkeypatch)
    _, ops = _causes_for("ops_manager", monkeypatch)
    _, analyst = _causes_for("analyst", monkeypatch)
    assert cfo.count("%") == 1, "a summary reader gets the dominant driver only"
    assert ops.count("%") == 3, "a standard reader gets the ranked drivers"
    # The method is named in readable form, not as the stored enum -- assert on the property
    # (only the analyst is told HOW it was localised), not on the identifier.
    assert "greedy cube" in analyst and "greedy cube" not in ops, "method is analyst detail"


def test_the_numbers_do_not_change_with_the_persona(monkeypatch):
    """Depth may drop detail. It may never restate the same driver as a different figure."""
    cfo_res, cfo_text = _causes_for("cfo", monkeypatch)
    ops_res, _ = _causes_for("ops_manager", monkeypatch)
    top_cfo = cfo_res.claims[0]["value"]
    top_ops = ops_res.claims[0]["value"]
    assert abs(top_cfo - top_ops) <= 0.5, "rounding only; the driver share is the same finding"
    # And what is shown is what is stored, so prose and evidence cannot disagree.
    assert "%.0f%%" % top_cfo in cfo_text


def test_a_summary_reader_is_not_handed_evidence_they_never_saw(monkeypatch):
    cfo_res, _ = _causes_for("cfo", monkeypatch)
    assert len(cfo_res.claims) == 1, "the evidence card must match the answer shown"


# ── Phase 5b: the tier boundary ────────────────────────────────────────────
def test_governed_is_a_contract_property_not_an_inference():
    from api.intelligence.contracts import load_declared, Contract
    for kpi_id, contract in load_declared().items():
        assert contract.governed, kpi_id
        assert contract.owner, "%s is governed but names no owner" % kpi_id
    assert not Contract(id="page.view", tier=0, raw={}).governed


def test_ranked_output_is_governed_metrics_only(monkeypatch):
    """A page-view series beside revenue makes the whole ranked list unusable."""
    seen = {}

    def _spy(tenant_id, persona="analyst", limit=5, governed_only=True):
        seen["governed_only"] = governed_only
        return []

    monkeypatch.setattr(tools.reader, "top_movements", _spy)
    tools.run("rank_movements", {"tenant_id": "nexabank"}, "analyst")
    assert seen["governed_only"] is True


def test_an_ungoverned_metric_is_not_told_there_is_nothing_to_do(monkeypatch):
    """Silence and "nothing to do" are different answers."""
    monkeypatch.setattr(tools.reader, "latest_insight",
                        lambda *a, **k: {"kpi_id": "dashboard.page.view", "anomaly_id": "a1"})
    res = tools.run("get_recommendations", {"tenant_id": "nexabank"}, "analyst")
    assert not res.ok
    assert "no governing contract" in res.reason
    # The misleading phrasing is specifically the governed one: it says a closed lever list was
    # searched. Saying an ungoverned series CARRIES no levers is the honest statement.
    assert "closed list" not in res.reason
    assert "applies" not in res.reason


def test_a_governed_metric_still_reports_a_genuinely_empty_lever_list(monkeypatch):
    monkeypatch.setattr(tools.reader, "latest_insight",
                        lambda *a, **k: {"kpi_id": "fee_revenue", "anomaly_id": "a1"})
    monkeypatch.setattr(tools.reader, "recommendations", lambda *a, **k: [])
    res = tools.run("get_recommendations", {"tenant_id": "nexabank"}, "analyst")
    assert not res.ok and "no governing contract" not in res.reason


# ── structural invariants: both directions ─────────────────────────────────
def test_every_declared_intent_is_answerable_by_some_tool():
    from api.intelligence import personas
    gated = {spec.intent for spec in tools.REGISTRY.values()}
    for pid, profile in personas.REGISTRY.items():
        assert not profile.intents - gated, "%s declares an intent no capability answers" % pid


def test_every_tool_is_reachable_through_some_declared_intent():
    """The mirror failure: a capability that exists, is entitled, and can never be invoked."""
    from api.intelligence import personas
    declared = set().union(*(p.intents for p in personas.REGISTRY.values()))
    orphans = {s.name for s in tools.REGISTRY.values() if s.intent not in declared}
    assert not orphans, "no persona can ever reach: %s" % sorted(orphans)


def test_a_persona_figure_never_contradicts_another_beyond_precision(monkeypatch):
    """The invariant depth-based rounding replaces byte-equality with."""
    by_persona = {}
    for persona in ("cfo", "ops_manager", "analyst"):
        monkeypatch.setattr(tools.reader, "latest_insight",
                            lambda *a, **k: {"kpi_id": "fee_revenue", "causes": _CAUSES})
        res = tools.run("get_causes", {"tenant_id": "nexabank"}, persona)
        by_persona[persona] = {c["claim_id"]: c["value"] for c in res.claims}

    shared = set.intersection(*(set(v) for v in by_persona.values()))
    assert shared, "the personas must share at least the dominant driver"
    for claim_id in shared:
        values = [by_persona[p][claim_id] for p in by_persona]
        assert max(values) - min(values) <= 0.5, \
            "%s differs beyond rounding: %s" % (claim_id, values)


def test_a_registry_failure_is_stated_not_rendered_as_calm(monkeypatch):
    """The lenient fallback returned ("",), and `kpi_id IN ('')` matches nothing -- so an
    unreadable contracts/ emptied the ranked list and the agent reported that nothing had moved.
    A scoping failure must never read as an analytical result."""
    import api.intelligence.contracts as contracts
    from api.intelligence import reader

    def _broken():
        raise RuntimeError("contracts/ unreadable")

    monkeypatch.setattr(contracts, "load_declared", _broken)
    with pytest.raises(reader.RegistryUnavailable):
        reader._governed_ids()

    res = tools.run("rank_movements", {"tenant_id": "nexabank"}, "analyst")
    assert not res.ok
    assert "cannot tell which metrics are governed" in res.reason
    assert "outside its expected band" not in res.reason, "that phrasing claims we checked"


def test_an_empty_registry_is_also_a_failure(monkeypatch):
    import api.intelligence.contracts as contracts
    from api.intelligence import reader
    monkeypatch.setattr(contracts, "load_declared", lambda: {})
    with pytest.raises(reader.RegistryUnavailable):
        reader._governed_ids()


def test_ordering_still_degrades_quietly(monkeypatch):
    """Ranking preference losing the governed list costs rank quality, not truth, so it may
    degrade -- the distinction is whether a failure can be mistaken for a finding."""
    import api.intelligence.contracts as contracts
    from api.intelligence import reader
    monkeypatch.setattr(contracts, "load_declared",
                        lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert reader._declared_ids() == ("",)
