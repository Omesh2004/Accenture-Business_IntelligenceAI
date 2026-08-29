"""P1-2: idempotent migration runner.

`storage/schema.sql` runs ONLY on an empty ClickHouse volume, and nothing applied
`storage/migrations/*.sql` at all. That gap already destroyed data once: a fresh volume created
an 8-column events_raw while the running code required 14, every insert failed with
"Unrecognized column", and the dead-letter fallback failed too because it had the same gap --
events were lost with no trace.

Usage:
    docker compose exec -T ingestion-api python storage/migrate.py          # apply pending
    docker compose exec -T ingestion-api python storage/migrate.py --status # list only

Applied files are recorded in feature_intelligence.schema_migrations by name and content hash,
so re-running is a no-op and an EDITED migration is reported rather than silently skipped.
"""
from __future__ import annotations

import glob
import hashlib
import os
import sys
from datetime import datetime, timezone

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from storage.client import ch_client  # noqa: E402

DB = "feature_intelligence"
MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")

LEDGER_DDL = f"""
CREATE TABLE IF NOT EXISTS {DB}.schema_migrations (
    name        String,
    checksum    String,
    applied_at  DateTime DEFAULT now(),
    ok          UInt8 DEFAULT 1,
    error       String DEFAULT ''
) ENGINE = ReplacingMergeTree(applied_at)
ORDER BY name
"""


def _checksum(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _statements(sql: str) -> list[str]:
    """Split on `;` at end of line, ignoring comment-only fragments."""
    out, buf = [], []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--") and not buf:
            continue
        buf.append(line)
        if stripped.endswith(";"):
            stmt = "\n".join(buf).strip().rstrip(";").strip()
            if stmt and not all(l.strip().startswith("--") or not l.strip()
                                for l in stmt.splitlines()):
                out.append(stmt)
            buf = []
    tail = "\n".join(buf).strip()
    if tail and not all(l.strip().startswith("--") or not l.strip() for l in tail.splitlines()):
        out.append(tail)
    return out


def applied() -> dict[str, str]:
    client = ch_client._get_client()
    client.command(LEDGER_DDL)
    rows = ch_client.query(
        f"SELECT name, checksum FROM {DB}.schema_migrations FINAL WHERE ok = 1")
    return {str(r["name"]): str(r["checksum"]) for r in rows}


def pending() -> list[tuple[str, str, str]]:
    """(name, checksum, sql) for every migration not yet recorded as applied."""
    done = applied()
    out = []
    for path in sorted(glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql"))):
        name = os.path.basename(path)
        sql = open(path, encoding="utf-8").read()
        checksum = _checksum(sql)
        if name in done:
            if done[name] != checksum:
                print(f"  ! {name} was applied then EDITED "
                      f"(recorded {done[name]}, on disk {checksum}) -- not re-run")
            continue
        out.append((name, checksum, sql))
    return out


def record(name: str, checksum: str, ok: bool, error: str = "") -> None:
    ch_client._get_client().insert(
        f"{DB}.schema_migrations",
        [[name, checksum, datetime.now(timezone.utc).replace(tzinfo=None), int(ok), error[:500]]],
        column_names=["name", "checksum", "applied_at", "ok", "error"],
    )


def apply_all(dry_run: bool = False) -> int:
    todo = pending()
    if not todo:
        print("no pending migrations")
        return 0
    client = ch_client._get_client()
    failures = 0
    for name, checksum, sql in todo:
        if dry_run:
            print(f"  pending: {name}")
            continue
        print(f"  applying {name} ...", end=" ")
        try:
            for stmt in _statements(sql):
                client.command(stmt)
            record(name, checksum, True)
            print("ok")
        except Exception as exc:
            # Recorded as failed, not silently skipped -- the whole point of the ledger.
            record(name, checksum, False, str(exc))
            print(f"FAILED: {exc}")
            failures += 1
    return failures


def baseline() -> int:
    """Record every migration as applied WITHOUT running it.

    For a database already in the target state -- which this one is, because migrations were
    hand-applied before the ledger existed. Running them again fails on TABLE_ALREADY_EXISTS,
    and those failures say nothing about whether the schema is correct. Verify the schema
    first (`DESCRIBE` the tables), then baseline, then use apply for everything after.
    """
    todo = pending()
    for name, checksum, _ in todo:
        record(name, checksum, True, "baselined: pre-existing schema, not executed")
        print(f"  baselined {name}")
    return len(todo)


def _looks_migrated() -> bool:
    """True if the schema is already past the initial state but the ledger is empty."""
    rows = ch_client.query(
        "SELECT count() AS n FROM system.columns "
        f"WHERE database = '{DB}' AND table = 'events_raw' AND name = '_inserted_at'")
    return bool(rows and int(rows[0]["n"]))


if __name__ == "__main__":
    print(f"migrations dir: {MIGRATIONS_DIR}")
    done = applied()
    print(f"already applied: {len(done)}")

    # Applying historic migrations to a database that is ALREADY in the target state is
    # destructive, not merely noisy: a repoint migration drops the live materialized view and
    # then fails to recreate it, leaving the rollup silently unfed. Baseline first.
    if not done and _looks_migrated() and "--baseline" not in sys.argv and "--status" not in sys.argv:
        print("\nREFUSING TO APPLY: the schema is already migrated but the ledger is empty.")
        print("Verify the schema, then run:  python storage/migrate.py --baseline")
        sys.exit(2)

    if "--baseline" in sys.argv:
        n = baseline()
        print(f"baselined {n} migration(s)")
        sys.exit(0)

    rc = apply_all(dry_run="--status" in sys.argv)
    sys.exit(1 if rc else 0)
