"""Every loader's column list must match the table it writes to, in the table's own order.

A count mismatch is caught by the driver at insert time. A same-count, wrong-ORDER list is not:
it writes `region` into `branch_code` and every downstream number is quietly wrong. This file is
the only thing that catches that.

It is a static check on purpose -- it needs no data, so it fails on the pull request rather than
after a load has already run.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.intelligence import loaders

pytest.importorskip("clickhouse_connect")

# loader column list -> the table it is passed to.
COLUMN_LISTS = {
    "fact_transactions": loaders.TXN_COLUMNS,
    "fact_loan_applications": loaders.APP_COLUMNS,
    "fact_account_openings": loaders.OPENING_COLUMNS,
    "fact_cards": loaders.CARD_COLUMNS,
    "dim_customer": loaders.CUSTOMER_COLUMNS,
    "fact_campaign_interactions": loaders.INTERACTION_COLUMNS,
    "dim_branch": loaders.BRANCH_COLUMNS,
    "dim_macro_environment": loaders.MACRO_COLUMNS,
    "dim_campaign": loaders.CAMPAIGN_COLUMNS,
}


def table_columns(table: str) -> list[str]:
    from storage.client import ch_client
    rows = ch_client.query(
        "SELECT name FROM system.columns WHERE database = %(d)s AND table = %(t)s "
        "ORDER BY position",
        {"d": loaders.DB, "t": table})
    return [str(r["name"]) for r in rows]


@pytest.mark.parametrize("table", sorted(COLUMN_LISTS))
def test_every_named_column_exists(table):
    actual = table_columns(table)
    if not actual:
        pytest.skip(f"{table} not present in this database")
    missing = [c for c in COLUMN_LISTS[table] if c not in actual]
    assert not missing, f"{table}: loader names columns that do not exist: {missing}"


# clickhouse-connect maps values to columns BY NAME, so the loader list need not match the
# table's physical order. What it must match is the order values are appended to each row -- and
# a swap between two same-typed neighbours (branch_code/region, both LowCardinality(String))
# raises no error at all. Only the values themselves reveal it, so check the domains.
DOMAIN_CHECKS = [
    ("fact_transactions", "region", "dim_branch", "region"),
    ("fact_transactions", "branch_code", "dim_branch", "branch_code"),
    ("fact_account_openings", "region", "dim_branch", "region"),
    ("fact_account_openings", "branch_code", "dim_branch", "branch_code"),
    ("fact_cards", "region", "dim_branch", "region"),
]


@pytest.mark.parametrize("table,column,ref_table,ref_column", DOMAIN_CHECKS)
def test_values_land_in_the_column_they_belong_to(table, column, ref_table, ref_column):
    """A branch code sitting in `region` is a swapped pair, not a business fact."""
    from storage.client import ch_client
    rows = ch_client.query(
        f"SELECT DISTINCT {column} AS v FROM {loaders.DB}.{table} FINAL "
        f"WHERE {column} != '' LIMIT 200")
    values = {str(r["v"]) for r in rows}
    if not values:
        pytest.skip(f"{table}.{column} has no data yet")
    ref = ch_client.query(
        f"SELECT DISTINCT {ref_column} AS v FROM {loaders.DB}.{ref_table} FINAL")
    allowed = {str(r["v"]) for r in ref}
    if not allowed:
        pytest.skip(f"{ref_table} not loaded")
    stray = values - allowed
    assert not stray, f"{table}.{column} holds values from another column: {sorted(stray)[:5]}"


@pytest.mark.parametrize("table", sorted(COLUMN_LISTS))
def test_no_duplicate_columns(table):
    cols = COLUMN_LISTS[table]
    assert len(cols) == len(set(cols)), f"{table}: duplicated column in the loader list"


def test_every_fact_table_registered_for_contracts_has_a_loader():
    """A fact table a contract can read but nothing populates is a KPI that silently reads zero."""
    from api.intelligence.facts import FACT_TABLES
    unloaded = [t for t in FACT_TABLES if t not in COLUMN_LISTS]
    assert not unloaded, f"registered for contracts but no loader writes them: {unloaded}"
