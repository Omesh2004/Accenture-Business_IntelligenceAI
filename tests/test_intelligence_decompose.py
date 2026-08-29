"""Factor decomposition. The zero residual is the whole reason LMDI-I was chosen, so it is
tested as a property rather than on one example.
"""
from __future__ import annotations

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence.stages import decompose


def cells(spec):
    """{cell: {volume, value, price}} from {cell: (volume, price)}."""
    return {k: {"volume": v, "value": v * p, "price": p} for k, (v, p) in spec.items()}


def total_of(c):
    return sum(x["value"] for x in c.values())


# ── the property that justifies the method ─────────────────────────────────
def test_factors_sum_exactly_to_the_change():
    cur = cells({("A",): (100, 10.0), ("B",): (50, 20.0)})
    base = cells({("A",): (80, 9.0), ("B",): (70, 21.0)})
    res = decompose.price_volume_mix(cur, base)
    assert abs(sum(f["contribution"] for f in res.factors) - res.total_change) < 1e-6
    assert res.ok, "a non-zero residual means the identity does not close"


def test_zero_residual_holds_across_random_shapes():
    """Property test: whatever the cells, the residual must vanish."""
    rng = random.Random(1337)
    for _ in range(200):
        keys = [(f"c{i}",) for i in range(rng.randint(1, 6))]
        cur = cells({k: (rng.randint(1, 500), rng.uniform(0.5, 50)) for k in keys})
        base = cells({k: (rng.randint(1, 500), rng.uniform(0.5, 50)) for k in keys})
        res = decompose.price_volume_mix(cur, base)
        assert res.ok, f"residual {res.residual} on {keys}"


def test_entering_and_exiting_cells_do_not_leak_into_the_residual():
    """A segment present in only one period is a real explanation, not a rounding error."""
    cur = cells({("A",): (100, 10.0), ("NEW",): (40, 5.0)})
    base = cells({("A",): (100, 10.0), ("GONE",): (30, 8.0)})
    res = decompose.price_volume_mix(cur, base)
    assert res.ok
    entry = [f for f in res.factors if f["factor"] == "entry_exit"][0]
    assert abs(entry["contribution"] - (40 * 5.0 - 30 * 8.0)) < 1e-6


# ── each factor is isolated when only it moves ─────────────────────────────
def test_pure_price_move_is_attributed_to_price():
    cur = cells({("A",): (100, 12.0)})
    base = cells({("A",): (100, 10.0)})
    res = decompose.price_volume_mix(cur, base)
    by = {f["factor"]: f["contribution"] for f in res.factors}
    assert by["price"] > 0
    assert abs(by["volume"]) < 1e-6 and abs(by["mix"]) < 1e-6


def test_pure_volume_move_is_attributed_to_volume():
    cur = cells({("A",): (200, 10.0)})
    base = cells({("A",): (100, 10.0)})
    res = decompose.price_volume_mix(cur, base)
    by = {f["factor"]: f["contribution"] for f in res.factors}
    assert by["volume"] > 0
    assert abs(by["price"]) < 1e-6 and abs(by["mix"]) < 1e-6


def test_pure_mix_shift_at_constant_volume_and_price():
    """Same total volume and same prices, weight moved between cells -> mix only."""
    cur = cells({("A",): (150, 10.0), ("B",): (50, 20.0)})
    base = cells({("A",): (50, 10.0), ("B",): (150, 20.0)})
    res = decompose.price_volume_mix(cur, base)
    by = {f["factor"]: f["contribution"] for f in res.factors}
    assert abs(by["volume"]) < 1e-6, "total volume did not change"
    assert abs(by["price"]) < 1e-6, "no price changed"
    assert by["mix"] != 0


def test_offsetting_factors_are_both_reported():
    """When drivers cancel, the reader must see both, not a small net number."""
    cur = cells({("A",): (200, 5.0)})
    base = cells({("A",): (100, 10.0)})
    res = decompose.price_volume_mix(cur, base)
    by = {f["factor"]: f["contribution"] for f in res.factors}
    assert by["volume"] > 0 and by["price"] < 0
    assert abs(res.total_change) < 1e-6, "value is unchanged overall"


def test_factors_are_ranked_by_magnitude():
    cur = cells({("A",): (300, 10.0), ("B",): (10, 11.0)})
    base = cells({("A",): (100, 10.5), ("B",): (10, 10.0)})
    res = decompose.price_volume_mix(cur, base)
    magnitudes = [abs(f["contribution"]) for f in res.factors]
    assert magnitudes == sorted(magnitudes, reverse=True)


# ── degradation, never nonsense ────────────────────────────────────────────
def test_no_movement_gives_zero_factors():
    same = cells({("A",): (100, 10.0)})
    res = decompose.price_volume_mix(same, same)
    assert abs(res.total_change) < 1e-9
    assert all(abs(f["contribution"]) < 1e-9 for f in res.factors)


def test_empty_baseline_degrades_with_a_note():
    res = decompose.price_volume_mix(cells({("A",): (100, 10.0)}), {})
    assert res.factors == [] and res.note


def test_empty_current_degrades_with_a_note():
    res = decompose.price_volume_mix({}, cells({("A",): (100, 10.0)}))
    assert res.factors == [] and res.note


def test_both_empty_is_safe():
    res = decompose.price_volume_mix({}, {})
    assert res.factors == [] and res.total_change == 0.0


def test_zero_price_cell_does_not_divide_by_zero():
    cur = cells({("A",): (100, 0.0), ("B",): (50, 10.0)})
    base = cells({("A",): (100, 5.0), ("B",): (50, 10.0)})
    res = decompose.price_volume_mix(cur, base)
    assert res.ok, "a free segment must not break the identity"


# ── log_mean, the weight LMDI depends on ───────────────────────────────────
def test_log_mean_equal_inputs_is_the_value():
    assert abs(decompose.log_mean(5.0, 5.0) - 5.0) < 1e-9


def test_log_mean_is_between_its_inputs():
    lm = decompose.log_mean(2.0, 8.0)
    assert 2.0 < lm < 8.0


def test_log_mean_is_symmetric():
    assert abs(decompose.log_mean(3.0, 7.0) - decompose.log_mean(7.0, 3.0)) < 1e-9


def test_log_mean_non_positive_returns_zero():
    assert decompose.log_mean(0.0, 5.0) == 0.0
    assert decompose.log_mean(-1.0, 5.0) == 0.0


# ── generic multiplicative identity ────────────────────────────────────────
def test_lmdi_generic_identity_has_zero_residual():
    contributions, residual = decompose.lmdi(
        {"a": 12.0, "b": 3.0, "c": 2.0}, {"a": 10.0, "b": 4.0, "c": 1.5})
    assert abs(residual) < 1e-9
    assert set(contributions) == {"a", "b", "c"}


def test_lmdi_through_zero_is_reported_not_guessed():
    contributions, residual = decompose.lmdi({"a": 0.0}, {"a": 10.0})
    assert contributions == {}
    assert residual == -10.0
