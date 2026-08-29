"""`storage/schema.sql` must describe the database that actually exists.

There is no migration runner for ClickHouse. `schema.sql` executes ONLY on an empty volume, and
every change since has been applied by hand from `storage/migrations/`. Anything that reaches the
live database without being mirrored back is invisible until someone provisions a fresh
environment — and then a KPI reading an absent fact table reads zero without erroring, which is
the worst failure this system has.

This has now bitten three times: the Signal Store tables, the multi-source facts, and the retail
banking tables plus nine ALTER-added columns. Hence a test rather than another reminder.
"""
from __future__ import annotations

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DB = "feature_intelligence"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "storage", "schema.sql")

# Tables created by the test suite or by ad-hoc tooling rather than by the product.
EXEMPT: set[str] = set()


def schema_text() -> str:
    if not os.path.exists(SCHEMA):
        pytest.skip("storage/schema.sql not present")
    with open(SCHEMA, encoding="utf-8") as fh:
        return fh.read()


def declared_tables(src: str) -> set[str]:
    return set(re.findall(r"CREATE TABLE IF NOT EXISTS %s\.(\w+)" % DB, src))


def live_tables() -> list[str]:
    from storage.client import ch_client
    rows = ch_client.query(
        "SELECT name FROM system.tables WHERE database = %(d)s "
        "AND engine NOT LIKE '%%View%%' ORDER BY name", {"d": DB})
    return [str(r["name"]) for r in rows]


def table_block(src: str, table: str) -> str | None:
    """The whole CREATE statement, sliced to the NEXT CREATE rather than the next semicolon.

    Inline comments in schema.sql contain semicolons, so stopping at one truncated the block to
    its first two columns and reported every remaining column as drift.
    """
    m = re.search(r"CREATE TABLE IF NOT EXISTS %s\.%s\b" % (DB, re.escape(table)), src)
    if not m:
        return None
    rest = src[m.end():]
    nxt = re.search(r"\nCREATE (TABLE|MATERIALIZED VIEW|VIEW)\b", rest)
    return rest[: nxt.start()] if nxt else rest


def test_every_live_table_is_declared():
    live = live_tables()
    if not live:
        pytest.skip("database not reachable")
    missing = sorted(set(live) - declared_tables(schema_text()) - EXEMPT)
    assert not missing, (
        "these tables exist in the database but not in storage/schema.sql, so a fresh volume "
        f"comes up without them: {missing}")


def test_no_declared_table_is_missing_live_columns():
    """An ALTER applied by hand and not mirrored back leaves a fresh deployment short a column,
    and every insert naming it fails."""
    from storage.client import ch_client
    src = schema_text()
    live = live_tables()
    if not live:
        pytest.skip("database not reachable")

    drift: dict[str, list[str]] = {}
    for table in live:
        body = table_block(src, table)
        if body is None:
            continue  # covered by the test above
        rows = ch_client.query(
            "SELECT name FROM system.columns WHERE database = %(d)s AND table = %(t)s "
            "ORDER BY position", {"d": DB, "t": table})
        absent = [
            str(r["name"]) for r in rows
            # Match the column name as its own token, backticked or bare.
            if not re.search(r"(^|[`\s(,])%s([`\s]|$)" % re.escape(str(r["name"])), body, re.M)
        ]
        if absent:
            drift[table] = absent
    assert not drift, f"schema.sql is missing columns that exist live: {drift}"


def test_schema_is_replayable():
    """Every statement must be idempotent — this file is applied to running instances by hand."""
    src = schema_text()
    unguarded = [
        line.strip() for line in src.splitlines()
        if re.match(r"^\s*CREATE (TABLE|MATERIALIZED VIEW|VIEW)\b", line)
        and "IF NOT EXISTS" not in line
    ]
    assert not unguarded, f"unguarded CREATE statements cannot be replayed safely: {unguarded[:3]}"
    destructive = [
        line.strip() for line in src.splitlines()
        if re.match(r"^\s*(DROP|TRUNCATE)\b", line, re.I)
    ]
    assert not destructive, f"schema.sql must never destroy data: {destructive[:3]}"
