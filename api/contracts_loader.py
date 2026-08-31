"""Contract loader (moved out of `api/intelligence/` — plan Phase 4, decision D5).

Two jobs:
  1. Re-export the YAML contract loader (`load_declared` / `load_all` / `Contract`) unchanged, so
     Track C repoints one import and nothing else.
  2. Resolve a `kpi_id` to the `gold.kpi_daily` fundamentals / `silver.fact_*` table / filter it
     names, and validate that resolution against the LIVE silver+gold schema. The Metric API
     calls `resolve_kpi()`; an unknown `kpi_id` is a 404, not an empty 200.

The Round-2 KPI set is fixed here (`docs/INTERFACES/kpi_rollups.md`, D1/D2) rather than read from
`contracts/*.yaml`, because that YAML is still the Round-1 set — Track C rewrites it later, and
when it does, `resolve_kpi` can start reading the `fundamentals:` block off the contract instead.
"""
from __future__ import annotations

from dataclasses import dataclass

# Re-export the YAML loader unchanged.
from api.intelligence.contracts import (  # noqa: F401
    Contract, load_declared, load_all, discover_tier0, validate, sliceable_dimensions,
)


@dataclass(frozen=True)
class KpiSpec:
    kpi_id: str
    kind: str                       # count | rate | money
    fundamentals: tuple[str, ...]   # names in gold.kpi_daily.fundamental
    fact_table: str                 # the silver.fact_* carrier (for /metric/discover, dedup)
    dimensions: tuple[str, ...]     # measured dims the segment cube is built over
    numerator: str = ""             # rate only
    denominator: str = ""           # rate only


# kpi_id -> KpiSpec. Aligned to docs/INTERFACES/kpi_rollups.md and pipeline/transforms/gold_kpi.py.
KPI_REGISTRY: dict[str, KpiSpec] = {
    "signups": KpiSpec(
        "signups", "count", ("accounts_opened",), "silver.fact_account_openings",
        ("account_type", "branch_code", "region", "country")),
    "kyc_completion_rate": KpiSpec(
        "kyc_completion_rate", "rate", ("kyc_started", "kyc_completed"),
        "silver.fact_loan_applications",
        ("loan_type", "risk_segment", "region", "branch_code"),
        numerator="kyc_completed", denominator="kyc_started"),
    "loan_approval_volume": KpiSpec(
        "loan_approval_volume", "count", ("loans_approved", "principal_approved"),
        "silver.fact_loan_applications", ("loan_type", "risk_segment", "region")),
    "revenue": KpiSpec(
        "revenue", "money", ("fee_revenue", "interest_accrued", "pro_revenue"),
        "silver.fact_transactions",
        ("channel", "txn_type", "mcc", "region", "branch_code")),
    "transaction_failure_rate": KpiSpec(
        "transaction_failure_rate", "rate", ("txn_total", "txn_failed"),
        "silver.fact_transactions",
        ("channel", "txn_type", "mcc", "region", "branch_code"),
        numerator="txn_failed", denominator="txn_total"),
}


class UnknownKpi(KeyError):
    pass


def resolve_kpi(kpi_id: str) -> KpiSpec:
    try:
        return KPI_REGISTRY[kpi_id]
    except KeyError:
        raise UnknownKpi(kpi_id)


def all_kpi_ids() -> list[str]:
    return sorted(KPI_REGISTRY)


def validate_against_schema(client) -> list[str]:
    """Every KpiSpec's fact table must exist and carry the columns the rollups read. Returns a
    list of problems; empty = the registry matches the live schema."""
    problems: list[str] = []
    rows = client.query(
        "SELECT concat(database, '.', table) AS t, name FROM system.columns "
        "WHERE database IN ('silver', 'gold')")
    cols: dict[str, set[str]] = {}
    for r in rows:
        cols.setdefault(str(r["t"]), set()).add(str(r["name"]))
    need = {
        "silver.fact_account_openings": {"opened_at", "account_type", "branch_code", "region", "country"},
        "silver.fact_loan_applications": {"kyc_step", "status", "decided_at", "principal_amount",
                                          "interest_rate", "created_at", "loan_type", "customer_id"},
        "silver.fact_transactions": {"status", "channel", "txn_type", "mcc", "amount", "occurred_at",
                                     "region", "branch_code"},
        "gold.kpi_daily": {"kpi_id", "date", "fundamental", "value", "distinct_count", "raw_rows"},
        "gold.kpi_daily_by_dim": {"dimension", "value_key", "value"},
    }
    for table, required in need.items():
        have = cols.get(table, set())
        if not have:
            problems.append(f"missing table {table}")
            continue
        missing = required - have
        if missing:
            problems.append(f"{table} missing columns {sorted(missing)}")
    return problems
