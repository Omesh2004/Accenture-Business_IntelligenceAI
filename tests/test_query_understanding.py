"""The agent must read the question, not spell-check it against cue words.

Four of six ordinary questions -- "how is my business doing?", "what is going on?", "give me a
full briefing", "anything I should worry about?" -- abstained completely, because none of them
contains a word any tool declared as a selector. They are now read as briefings.

The opposite guard matters just as much and is easy to lose while fixing the first: a question
that is not about this business at all must still be refused, not answered with whichever metric
moved most. Both directions are asserted here.
"""
import pytest

from api.intelligence import understanding as u


def _read(question: str, names_metric: bool = False, conversational: bool = False):
    return u.read(question, names_metric, conversational)


@pytest.mark.parametrize("question", [
    "how is my business doing?",
    "what is going on?",
    "give me a full briefing",
    "anything I should worry about?",
    "explain the biggest problem right now",
    "what happened this week",
    "any issues I should know about",
    "give me an update",
])
def test_a_general_business_question_is_a_briefing(question):
    """These named no metric and matched no selector; each one used to abstain."""
    reading = _read(question)
    assert reading.shape == "briefing", "%r read as %s" % (question, reading.shape)
    assert reading.is_investigation
    assert reading.reason


@pytest.mark.parametrize("question", [
    "what is the capital of France",
    "tell me a joke",
    "who won the cricket match",
    "translate this into German",
])
def test_an_unrelated_question_is_still_refused(question):
    """The briefing default must not become a way to answer anything with a variance report."""
    assert _read(question).shape == "unmatched"
    assert not _read(question).is_investigation


def test_a_named_metric_is_a_diagnostic_not_a_briefing():
    reading = _read("why did kyc completion rate fall", names_metric=True)
    assert reading.shape == "diagnostic"
    assert reading.chain == u.DIAGNOSTIC_CHAIN


def test_a_salutation_is_never_an_investigation():
    reading = _read("hello there", conversational=True)
    assert reading.shape == "conversational"
    assert not reading.is_investigation


def test_a_question_with_no_stated_parts_wants_the_whole_chain():
    """"How is my business doing" asks for everything: what moved, when, why, and what to do."""
    reading = _read("how is my business doing?")
    assert set(reading.wants) == {u.WHAT_CHANGED, u.WHEN, u.WHY, u.WHAT_NOW}


def test_an_explicit_question_asks_only_for_what_it_named():
    """"Where is it concentrated" wants the why, not a recommendation nobody asked for."""
    reading = _read("where is the drop concentrated?")
    assert u.WHY in reading.wants
    assert u.WHAT_NOW not in reading.wants


def test_a_narrow_lookup_is_not_promoted_to_an_investigation():
    reading = _read("how fresh is the data")
    assert reading.shape == "lookup"
    assert not reading.is_investigation


def test_a_lookup_word_inside_a_diagnostic_does_not_win():
    """"...and why did it fall" makes it an investigation regardless of the freshness word."""
    reading = _read("how fresh is the data and why did revenue fall")
    assert reading.is_investigation


def test_every_chain_intent_maps_to_a_narrative_slot():
    """A chain entry with no slot would be selected and then never told."""
    for intent in set(u.DIAGNOSTIC_CHAIN) | set(u.BRIEFING_CHAIN):
        assert u.slot_for(intent), "%s fills no narrative slot" % intent


def test_slot_order_is_the_order_a_finding_is_told():
    assert u.SLOT_ORDER.index(u.WHAT_CHANGED) < u.SLOT_ORDER.index(u.WHEN)
    assert u.SLOT_ORDER.index(u.WHEN) < u.SLOT_ORDER.index(u.WHY)
    assert u.SLOT_ORDER.index(u.WHY) < u.SLOT_ORDER.index(u.WHAT_NOW)
    for slot in u.SLOT_ORDER:
        assert slot in u.SLOT_LABEL
