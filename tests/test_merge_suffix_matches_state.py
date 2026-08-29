"""Every `<fn>Merge(col)` must name the same function the column's state was built with.

ClickHouse refuses a mismatch at query time with ILLEGAL_TYPE_OF_ARGUMENT -- a hard 500, not a
wrong number. It surfaced when a migration changed `daily_feature_usage.unique_users` from
`AggregateFunction(uniq, String)` to `uniqExact` (so the figure would be reproducible) and four
readers kept calling `uniqMerge` on it. Every dashboard page touching the rollup broke at once.

This is CLAUDE.md coupling point 5: analytics SQL names columns by literal string, there is no
compile step, and a changed column type is a runtime failure. This file is the compile step.
"""
from __future__ import annotations

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DB = "feature_intelligence"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = ["api/main.py", "api/data_layer.py", "api/insights.py", "api/intelligence/metrics.py"]

# <fn>Merge(col) and <fn>MergeIf(col, ...) -- the If variant is just as capable of mismatching.
MERGE_CALL = re.compile(r"\b(\w+?)Merge(?:If)?\s*\(\s*(\w+)")


def state_functions() -> dict[str, str]:
    """column -> the aggregate function its AggregateFunction state was built with."""
    from storage.client import ch_client
    rows = ch_client.query(
        "SELECT table, name, type FROM system.columns "
        "WHERE database = %(d)s AND type LIKE 'AggregateFunction(%%'", {"d": DB})
    out: dict[str, str] = {}
    for r in rows:
        fn = str(r["type"]).split("(", 1)[1].split(",", 1)[0].strip()
        # Columns are uniquely named across the rollup tables; a collision would itself be a smell.
        out[str(r["name"])] = fn
    return out


def merge_calls():
    for rel in SOURCES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                stripped = line.lstrip()
                if stripped.startswith("#"):
                    continue
                for fn, col in MERGE_CALL.findall(line):
                    yield rel, lineno, fn, col


def test_every_merge_matches_its_state():
    states = state_functions()
    if not states:
        pytest.skip("no AggregateFunction columns present")
    wrong = []
    for rel, lineno, fn, col in merge_calls():
        expected = states.get(col)
        if expected and fn != expected:
            wrong.append(f"{rel}:{lineno} {fn}Merge({col}) but state is {expected}")
    assert not wrong, "merge suffix does not match the stored state:\n  " + "\n  ".join(wrong)


def test_the_rollup_columns_are_exact_not_approximate():
    """A KPI that has to be reproducible cannot be read off a HyperLogLog sketch."""
    states = state_functions()
    for col in ("event_count", "unique_users"):
        if col in states:
            assert states[col] == "uniqExact", (
                f"{col} is {states[col]}; an approximate state makes the number non-reproducible")


def test_the_regex_actually_finds_calls():
    """A guard that silently matches nothing would pass forever."""
    assert list(merge_calls()), "no Merge calls found -- the scan is broken, not the code clean"
