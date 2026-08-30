"""Fast mode writes ClickHouse directly, so nothing validates it on the way in.

`POST /events` rejects a malformed envelope; a direct insert does not. A column list that drifts
out of order writes `region` into `branch_code` and every number downstream is quietly wrong --
the same failure tests/test_loader_column_alignment.py exists to catch for the loaders.
"""
import pytest

import api.fast_seed as fast_seed
from api.intelligence import loaders


def test_event_columns_match_events_raw_order():
    """The one list fast_seed defines itself. The rest it imports from the loaders."""
    from storage.client import ch_client
    client = ch_client._get_client()
    try:
        live = [r[0] for r in client.query(
            "SELECT name FROM system.columns WHERE database = 'feature_intelligence' "
            "AND table = 'events_raw' ORDER BY position").result_rows]
    finally:
        client.close()
    if not live:
        import pytest
        pytest.skip("database not reachable")
    assert fast_seed.EVENT_COLUMNS == live, (
        "fast_seed.EVENT_COLUMNS is out of step with events_raw. Order matters: clickhouse-connect "
        "maps positionally, so a same-length wrong-order list corrupts silently.")


def test_fact_column_lists_are_imported_not_redeclared():
    """Fast mode must not grow its own copy of a loader's column list."""
    src = open(fast_seed.__file__, encoding="utf-8").read()
    for name in ("TXN_COLUMNS", "OPENING_COLUMNS", "CARD_COLUMNS", "CUSTOMER_COLUMNS",
                 "INTERACTION_COLUMNS", "APP_COLUMNS"):
        assert "%s =" % name not in src, (
            "%s is redeclared in fast_seed; import it from loaders so the two cannot drift" % name)
        assert hasattr(loaders, name)


def test_every_fabricated_dimension_is_declared():
    """Fast mode invents all of its geo and device, exactly like the live producer."""
    for dim in ("location", "city", "continent", "device_type", "channel", "response_time_ms"):
        assert dim in fast_seed.SIMULATED_DIMS


def test_contract_events_are_the_ones_fast_mode_emits():
    """A KPI whose event this generator never emits reads zero and narrates a phantom decline."""
    from api.intelligence.contracts import load_declared
    declared = load_declared()
    emitted = {fast_seed.KYC_STARTED, fast_seed.KYC_COMPLETED,
               fast_seed.LOAN_APPLIED, fast_seed.LOAN_APPROVED} | set(fast_seed.PRO_EVENTS)
    for kpi in ("kyc_completion_rate", "loan_approval_volume", "pro_revenue"):
        wanted = set()
        for f in declared[kpi].fundamentals:
            if f.get("event"):
                wanted.add(f["event"])
            wanted.update(f.get("events") or [])
        missing = sorted(wanted - emitted)
        assert not missing, "%s counts events fast mode never emits: %s" % (kpi, missing)


class _FakeClient:
    """Captures inserts instead of performing them, so generate() can run without ClickHouse."""

    def __init__(self, branches, accounts):
        self.branches, self.accounts = branches, accounts
        self.inserted: dict[str, int] = {}

    def query(self, sql, parameters=None):
        class R:
            pass
        r = R()
        if "dim_branch" in sql:
            r.result_rows = self.branches
        elif "fact_account_openings" in sql:
            r.result_rows = self.accounts
        else:                                   # dim_campaign
            r.result_rows = []
        return r

    def insert(self, table, rows, column_names=None):
        self.inserted[table.split(".")[-1]] = self.inserted.get(table.split(".")[-1], 0) + len(rows)

    def close(self):
        pass


def _install(monkeypatch, accounts):
    branches = [["BR-1", "Asia", "India", "Mumbai"]]
    client = _FakeClient(branches, accounts)
    monkeypatch.setattr(fast_seed, "_client", lambda: client)
    monkeypatch.setattr(fast_seed, "record_freshness", lambda *a, **k: None)
    return client


def test_reusing_the_bank_population_opens_no_accounts(monkeypatch):
    """The default must generate ACTIVITY, never a new cohort.

    Minting a population on every run gave each run its own customers: openings spiked every
    time, and a planted rate movement was diluted by the arrivals instead of measured against
    a stable base.
    """
    from datetime import datetime
    accounts = [["ACC-1", "cust-1", "BR-1", "Asia", "India", datetime(2026, 1, 1)],
                ["ACC-2", "cust-2", "BR-1", "Asia", "India", datetime(2026, 1, 2)]]
    client = _install(monkeypatch, accounts)

    written = fast_seed.generate("nexabank", users=2, days=5, seed=1)

    assert written["create_accounts"] is False
    assert client.inserted.get("dim_customer", 0) == 0, "reuse must not invent customers"
    assert client.inserted.get("fact_account_openings", 0) == 0, "reuse must not open accounts"
    assert client.inserted.get("events_raw", 0) > 0, "reuse still generates activity"


def test_creating_a_population_is_opt_in(monkeypatch):
    client = _install(monkeypatch, [])
    written = fast_seed.generate("nexabank", users=3, days=5, seed=1, create_accounts=True)
    assert written["create_accounts"] is True
    assert client.inserted["dim_customer"] == 3
    assert client.inserted["fact_account_openings"] == 3


def test_it_refuses_rather_than_inventing_a_population(monkeypatch):
    """No accounts and create_accounts off is a refusal, not a silent invention."""
    _install(monkeypatch, [])
    with pytest.raises(ValueError, match="no existing accounts"):
        fast_seed.generate("nexabank", users=2, days=5, seed=1)
