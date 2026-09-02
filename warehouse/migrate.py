"""Idempotent migration runner for the bronze / silver / gold warehouse.

The layered DDL under `warehouse/clickhouse/{bronze,silver,gold}/*.sql` is the
authoritative schema. This runner applies it in LAYER ORDER (bronze → silver →
gold), records each file in `gold.schema_migrations` by name and content hash,
and then applies any post-baseline numbered migrations under
`warehouse/clickhouse/migrations/*.sql`.

Re-running is a no-op. An EDITED file that was already applied is reported, not
silently re-run (mirror the edit into a new numbered migration instead).

Usage:
    docker compose run --rm migrate                                   # apply pending
    docker compose exec -T ingestion-api python warehouse/migrate.py --status
    docker compose exec -T ingestion-api python warehouse/migrate.py --baseline
"""
from __future__ import annotations

import glob
import hashlib
import os
import sys
from datetime import datetime, timezone

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from warehouse.client import ch_client  # noqa: E402

CH_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clickhouse")
LAYERS = ("bronze", "silver", "gold")
DATABASES = ("bronze", "silver", "gold")
LEDGER_DB = "gold"

LEDGER_DDL = f"""
CREATE TABLE IF NOT EXISTS {LEDGER_DB}.schema_migrations (
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


def _bootstrap_client():
    """A client bound to no database in particular.

    The shared client connects to `settings.CLICKHOUSE_DATABASE`, and clickhouse_connect verifies
    that database exists while constructing. On a fresh warehouse it does not, so the very call
    meant to CREATE the databases could not open a connection to make them -- migrate failed on
    an empty ClickHouse and only on an empty one, which is exactly the path a rebuild takes.
    """
    import clickhouse_connect
    from warehouse.config import settings
    return clickhouse_connect.get_client(
        host=settings.CLICKHOUSE_HOST, port=settings.CLICKHOUSE_PORT,
        username=settings.CLICKHOUSE_USER, password=settings.CLICKHOUSE_PASSWORD,
        database="default", connect_timeout=10, send_receive_timeout=30)


def _ensure_databases() -> None:
    client = _bootstrap_client()
    try:
        for db in DATABASES:
            client.command(f"CREATE DATABASE IF NOT EXISTS {db}")
        # The legacy single-database name is still what the shared client connects to, so it has
        # to exist before anything else opens a connection.
        from warehouse.config import settings
        if settings.CLICKHOUSE_DATABASE:
            client.command(
                f"CREATE DATABASE IF NOT EXISTS {settings.CLICKHOUSE_DATABASE}")
        client.command(LEDGER_DDL)
    finally:
        try:
            client.close()
        except Exception:                                           # noqa: BLE001
            pass


def _migration_files() -> list[tuple[str, str]]:
    """(relative-name, absolute-path) for every DDL file, in apply order.

    Layer DDL first, bronze → silver → gold, sorted within each layer; then
    post-baseline numbered migrations under clickhouse/migrations/.
    """
    files: list[tuple[str, str]] = []
    for layer in LAYERS:
        for path in sorted(glob.glob(os.path.join(CH_DIR, layer, "*.sql"))):
            files.append((f"{layer}/{os.path.basename(path)}", path))
    for path in sorted(glob.glob(os.path.join(CH_DIR, "migrations", "*.sql"))):
        files.append((f"migrations/{os.path.basename(path)}", path))
    return files


def applied() -> dict[str, str]:
    _ensure_databases()
    rows = ch_client.query(
        f"SELECT name, checksum FROM {LEDGER_DB}.schema_migrations FINAL WHERE ok = 1")
    return {str(r["name"]): str(r["checksum"]) for r in rows}


def pending() -> list[tuple[str, str, str]]:
    """(name, checksum, sql) for every DDL file not yet recorded as applied."""
    done = applied()
    out = []
    for name, path in _migration_files():
        sql = open(path, encoding="utf-8").read()
        checksum = _checksum(sql)
        if name in done:
            if done[name] != checksum:
                print(f"  ! {name} was applied then EDITED "
                      f"(recorded {done[name]}, on disk {checksum}) -- not re-run. "
                      f"Mirror the change into a new migrations/*.sql instead.")
            continue
        out.append((name, checksum, sql))
    return out


def record(name: str, checksum: str, ok: bool, error: str = "") -> None:
    ch_client._get_client().insert(
        f"{LEDGER_DB}.schema_migrations",
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
            record(name, checksum, False, str(exc))
            print(f"FAILED: {exc}")
            failures += 1
    return failures


def baseline() -> int:
    """Record every pending file as applied WITHOUT running it.

    For a database already in the target state (schema hand-applied before the
    ledger existed). Verify the schema first (`DESCRIBE` the tables), then
    baseline, then use apply for everything after.
    """
    todo = pending()
    for name, checksum, _ in todo:
        record(name, checksum, True, "baselined: pre-existing schema, not executed")
        print(f"  baselined {name}")
    return len(todo)


def _looks_migrated() -> bool:
    """True if the layered schema already exists but the ledger is empty."""
    rows = ch_client.query(
        "SELECT count() AS n FROM system.tables "
        "WHERE database = 'bronze' AND name = 'events'")
    return bool(rows and int(rows[0]["n"]))


if __name__ == "__main__":
    print(f"clickhouse DDL dir: {CH_DIR}")
    done = applied()
    print(f"already applied: {len(done)}")

    # Applying DDL to a database already in the target state is destructive when
    # a file is a repoint/rename dance, not merely noisy. Baseline first.
    if not done and _looks_migrated() and "--baseline" not in sys.argv and "--status" not in sys.argv:
        print("\nREFUSING TO APPLY: the bronze/silver/gold schema already exists "
              "but the ledger is empty.")
        print("Verify the schema, then run:  python warehouse/migrate.py --baseline")
        sys.exit(2)

    if "--baseline" in sys.argv:
        n = baseline()
        print(f"baselined {n} file(s)")
        sys.exit(0)

    rc = apply_all(dry_run="--status" in sys.argv)
    sys.exit(1 if rc else 0)
