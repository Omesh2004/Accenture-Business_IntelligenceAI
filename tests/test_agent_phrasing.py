"""The readable form of a stored figure.

These assert the properties that make an answer usable rather than merely present: a cell reads
as English, a nested ranking says so, a percentage is not quoted against an expected zero, and the
unit named is the unit the figure was actually measured in.

The last one is the reason this module exists. Detect scores an additive fundamental, never a
rate, so `digital_adoption_rate` is scored on `digital_transactions` -- and the old rendering
published "It moved to 97.00 against an expected 54.00" under a metric named a rate. On live data
the real adoption rate was 1.000 on every day of that window.
"""
from __future__ import annotations

import pytest

from api.intelligence import phrasing


class TestCellPhrase:
    def test_enum_value_becomes_a_noun_phrase(self):
        assert phrasing.cell_phrase({"txn_type": "PAYMENT"}) == "payment transactions"

    def test_place_keys_read_as_places(self):
        assert phrasing.cell_phrase({"region": "Northeast"}) == "the Northeast region"
        assert phrasing.cell_phrase({"branch_code": "NE-033"}) == "branch NE-033"

    def test_a_mixed_cell_puts_the_what_before_the_where(self):
        assert (phrasing.cell_phrase({"region": "Northeast", "txn_type": "PAYMENT"})
                == "payment transactions in the Northeast region")

    def test_an_unlisted_type_key_pluralises(self):
        assert phrasing.cell_phrase({"account_type": "SAVINGS"}) == "savings accounts"

    def test_an_unknown_key_reads_plainly_rather_than_wrongly(self):
        assert phrasing.cell_phrase({"partner_id": "X9"}) == "partner id X9"

    def test_an_empty_cell_is_named_not_blank(self):
        assert phrasing.cell_phrase({}) == "the tenant as a whole"


class TestOverlapNote:
    """Nested cells were listed side by side, inviting an addition that is wrong."""

    def test_nesting_is_disclosed(self):
        note = phrasing.overlap_note([
            {"dimensions": {"txn_type": "PAYMENT"}},
            {"dimensions": {"region": "Northeast", "txn_type": "PAYMENT"}},
        ])
        assert "overlap" in note and "not meant to sum" in note

    def test_disjoint_cells_get_no_warning(self):
        assert phrasing.overlap_note([
            {"dimensions": {"txn_type": "PAYMENT"}},
            {"dimensions": {"txn_type": "TRANSFER"}},
        ]) == ""

    def test_the_note_carries_no_numeral(self):
        """The numeric verifier rejects any figure with no stored row behind it.

        A literal "100%" in a caveat about arithmetic is exactly such a figure, and it failed the
        whole answer closed -- correctly -- when this sentence first carried one.
        """
        note = phrasing.overlap_note([
            {"dimensions": {"txn_type": "PAYMENT"}},
            {"dimensions": {"region": "Northeast", "txn_type": "PAYMENT"}},
        ])
        assert not any(ch.isdigit() for ch in note)


class TestWindowPhrase:
    def test_the_exclusive_end_is_reported_as_the_last_day_included(self):
        assert phrasing.window_phrase("2026-08-22 00:00:00", "2026-08-29 00:00:00") \
            == "the 7 days to 28 August 2026"

    def test_a_missing_window_is_empty_not_invented(self):
        assert phrasing.window_phrase(None, None) == ""


class TestQuantity:
    def test_a_figure_is_given_back_its_noun_and_cadence(self):
        assert phrasing.quantity(97, "digital transactions", "daily") \
            == "97 digital transactions per day"

    def test_trailing_zeros_are_dropped(self):
        assert phrasing.quantity(54.0, "", "") == "54"

    def test_an_unknown_cadence_is_omitted_rather_than_guessed(self):
        assert phrasing.quantity(5, "loans", "fortnightly") == "5 loans"


class TestScoredMeasure:
    def test_a_ratio_with_a_denominator_is_scored_on_the_rate_itself(self):
        """Detect scores the rate, so there is no proxy count to declare and no per-day noun.

        This asserted the opposite while Detect scored the numerator: a rate that fell was
        published as "Digital Adoption Rate rose 3463.6%" of a count.
        """
        measure, cadence, proxy = phrasing.scored_measure("digital_adoption_rate")
        assert (measure, cadence) == ("", "")
        assert proxy is False

    def test_a_count_contract_is_not_a_proxy(self):
        _measure, _cadence, proxy = phrasing.scored_measure("new_account_openings")
        assert proxy is False

    def test_an_unknown_metric_degrades_rather_than_raising(self):
        assert phrasing.scored_measure("not_a_metric") == ("", "", False)


class TestScoredFundamentalMatchesDetect:
    """Prose and scorer must read the same field, or the answer names the wrong number."""

    def test_the_contract_exposes_what_the_orchestrator_scores(self):
        from api.intelligence.contracts import load_declared
        contract = load_declared().get("digital_adoption_rate")
        if contract is None:
            pytest.skip("contract registry unavailable")
        expected = contract.numerator() or contract.fundamentals[0]
        assert contract.scored_fundamental == expected
