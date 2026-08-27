"""
Dual-path duplicate query: the same event_id landing via BOTH the Kafka path and a direct-
ClickHouse fallback path, in the same window.

Phase 1 item 10 (docs/audits/clickhouse_pipeline_audit_phase1_findings.md) found this
theoretically possible: a Kafka send can time out client-side (ingestion/main.py's 5s
asyncio.wait_for) while the broker actually received it and will still deliver it to the worker,
so the ingestion API falls back to a direct insert for the same event_id the worker later also
inserts via Kafka. Phase 3 proposal 3 turns this from "provably possible in the code" into
something directly queryable, now that `ingest_path` is populated on every insert (Phase B).

A duplicate found here is expected to still collapse correctly under this repo's existing
dedup-safe read pattern (uniqExact(event_id) -- docs/audits/clickhouse_pipeline_audit_phase1_findings.md
item 8) -- this script is a detector for how often the race actually happens, not a correctness
fix in itself, and does not touch the naive-count() endpoints item 8 flagged (out of scope for
this phase).

Usage:
    python scripts/find_dual_path_duplicates.py
    python scripts/find_dual_path_duplicates.py --hours 6 --tenant nexabank

Run inside a container with clickhouse-connect available (already in requirements.txt) and
network access to ClickHouse, e.g.:

    docker compose exec ingestion-api python scripts/find_dual_path_duplicates.py

Exit code: 0 if no dual-path event_id is found, 1 if at least one is.
"""
import argparse
import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from storage.client import ch_client  # noqa: E402

RED, GREEN, RESET = "\033[31m", "\033[32m", "\033[0m"

FALLBACK_PATHS = ("fallback_cloud", "fallback_onprem")


def build_query(hours: int, tenants: Optional[list]) -> tuple:
    tenant_clause = "AND tenant_id IN %(tenants)s" if tenants else ""
    params = {"hours": hours}
    if tenants:
        params["tenants"] = tuple(tenants)

    sql = f"""
        SELECT
            event_id,
            tenant_id,
            groupUniqArray(ingest_path) AS paths,
            count() AS row_count,
            min(timestamp) AS first_seen,
            max(timestamp) AS last_seen
        FROM feature_intelligence.events_raw
        WHERE length(event_id) > 0
          AND timestamp >= now() - INTERVAL %(hours)s HOUR
          {tenant_clause}
        GROUP BY event_id, tenant_id
        HAVING has(paths, 'kafka') AND arrayExists(p -> p IN {FALLBACK_PATHS}, paths)
        ORDER BY last_seen DESC
    """
    return sql, params


def find_dual_path_duplicates(hours: int, tenants: Optional[list]) -> list:
    sql, params = build_query(hours, tenants)
    return ch_client.query(sql, params)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--tenant", default="", help="Comma-separated tenant filter (default: all)")
    args = parser.parse_args()
    tenants = [t.strip() for t in args.tenant.split(",") if t.strip()] or None

    rows = find_dual_path_duplicates(args.hours, tenants)
    if not rows:
        print(f"{GREEN}No dual-path duplicates found in the last {args.hours}h.{RESET}")
        return 0

    print(f"{RED}{len(rows)} event_id(s) landed via BOTH kafka and a fallback path in the last {args.hours}h:{RESET}\n")
    for r in rows:
        print(
            f"  event_id={r['event_id']} tenant={r['tenant_id']} paths={r['paths']} "
            f"rows={r['row_count']} first={r['first_seen']} last={r['last_seen']}"
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
