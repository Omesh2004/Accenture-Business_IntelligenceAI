"""
Verifies that the telemetry reaching ClickHouse is fit for the intelligence layer.

This asserts the Foundation guarantees the pipeline is built on. It does NOT test the
intelligence layer -- that does not exist yet. It answers one question: if a stage read
this data tomorrow, would it read the truth?

    python scripts/verify_data_quality.py

Run it from the repo root on the host, with the stack up. It needs `node` (to execute the
real Node taxonomy dialect), `requests` and `PyYAML` -- no ClickHouse driver.

Checks, each independently pass/fail:

  TAXONOMY   every event a KPI contract names is reachable from BOTH producer paths,
             verified by running the three real dialects, not by reading them.
  IDENTITY   event_id and session_id populated on every row.
  SESSIONS   sessions look like sessions -- events per session well above 1. A ratio at
             1.0 means the producer is minting a fresh id per event, which silently
             destroys ratio localization (docs/DATABASE.md FOUNDATION-2).
  DUPES      no identical (event_name, user_id, timestamp) pairs. These carry distinct
             event_ids, so uniqExact cannot collapse them -- they are a real 2x.
  DIMS       contract dimensions are actually populated, and session-invariant where the
             contract localizes on them.
  LANDED     rows carrying each contract fundamental actually exist, canonicalized the way a
             reader sees them -- reachable in theory is not the same as present in the data.
  ROLLUP     daily_feature_usage agrees with events_raw.

Exit code is 0 only when every check passes.
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

from api.page_map import canonicalize_event_name  # noqa: E402
from core.event_names import normalize_ingest_event_name  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TENANT = os.environ.get("VERIFY_TENANT", "nexabank")

# Rows written before a producer fix landed cannot retroactively satisfy it. Set VERIFY_SINCE
# to a 'YYYY-MM-DD HH:MM:SS' cutoff to assert only over telemetry produced after that point --
# useful for showing that a fix holds without deleting the history that predates it.
#
# CAVEAT: this filters on events_raw.timestamp, which is EVENT time, not write time. The
# simulation console backdates events across its history window, so a wall-clock cutoff will
# also sweep in simulated events whose event-time happens to fall after it. Treat VERIFY_SINCE
# as "events dated after X", not "rows written after X"; for a clean read on a producer fix,
# generate traffic through the live path and scope to that.
VERIFY_SINCE = os.environ.get("VERIFY_SINCE", "").strip()

# ClickHouse over its HTTP interface rather than clickhouse_connect: this script must run on
# the host, where `node` is available for the Node taxonomy dialect but the driver is not
# installed. Nothing here is a request path, so the fresh-client-per-call rule in CLAUDE.md
# (which exists for thread-safety inside FastAPI handlers) does not apply.
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123")
CLICKHOUSE_USER = os.environ.get("CLICKHOUSE_USER", "default")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "clickhouse")

GREEN, RED, YELLOW, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"
results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  [{mark}] {name}" + (f" -- {detail}" if detail else ""))


def through_ingest(name: str) -> str:
    """What POST /events stores for this name (the dialect coerces, it never rejects)."""
    try:
        return normalize_ingest_event_name(name)
    except Exception:
        return "INVALID"


def canonical(name: str) -> str:
    return canonicalize_event_name(through_ingest(name)) or "DROPPED"


# ─────────────────────────── TAXONOMY ───────────────────────────

def collect_emitted_names() -> tuple[set[str], set[str]]:
    """Names the live NexaBank path and the seeded path can produce, as canonical forms."""
    import glob
    import re

    backend = os.path.join(REPO, "NexaBank", "backend", "src")
    raw: set[str] = set()
    for path in glob.glob(os.path.join(backend, "**", "*.ts"), recursive=True):
        text = open(path, encoding="utf-8").read()
        raw.update(re.findall(r'trackEvent\(\s*"([^"]+)"', text))
        # names inside ternaries and other expressions
        raw.update(re.findall(r'"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"', text))

    # Run the names through the REAL enforceTaxonomy before the ingest dialect.
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        fh.write("\n".join(sorted(raw)))
        names_file = fh.name
    try:
        out = subprocess.run(
            ["node", os.path.join(REPO, "scripts", "taxonomy_probe.js"),
             os.path.join(backend, "middleware", "eventTracker.ts"), names_file],
            capture_output=True, text=True, check=True,
        ).stdout
    finally:
        os.unlink(names_file)

    live = {canonical(line.split("\t")[1]) for line in out.splitlines() if "\t" in line}

    # The browser tracker posts straight to ingestion, skipping enforceTaxonomy.
    frontend = os.path.join(REPO, "NexaBank", "frontend")
    for path in glob.glob(os.path.join(frontend, "**", "*.ts*"), recursive=True):
        if "node_modules" in path or ".next" in path:
            continue
        text = open(path, encoding="utf-8").read()
        for name in re.findall(r"track\(\s*['\"]([a-z][a-z0-9_.\-]+)['\"]", text):
            live.add(canonical(name))

    seed = open(os.path.join(REPO, "scripts", "seed_data.py"), encoding="utf-8").read()
    seeded = {canonical(n) for n in re.findall(r'"([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)"', seed)}
    return live, seeded


def check_taxonomy() -> None:
    import glob

    import yaml

    live, seeded = collect_emitted_names()
    for path in sorted(glob.glob(os.path.join(REPO, "contracts", "*.yaml"))):
        contract = yaml.safe_load(open(path, encoding="utf-8"))
        wanted: set[str] = set()
        for fundamental in contract.get("fundamentals") or []:
            if fundamental.get("event"):
                wanted.add(fundamental["event"])
            wanted.update(fundamental.get("events") or [])
        wanted.update((contract.get("lineage") or {}).get("events") or [])
        wanted.update((contract.get("quality") or {}).get("corroboration") or [])

        missing = [
            f"{event} (seeded={'y' if event in seeded else 'N'} live={'y' if event in live else 'N'})"
            for event in sorted(wanted)
            if event not in seeded or event not in live
        ]
        record(
            f"TAXONOMY {contract['id']}: {len(wanted)} contract events reachable on both paths",
            not missing,
            "; ".join(missing),
        )


# ─────────────────────────── DATA ───────────────────────────

def query(sql: str, params: dict | None = None, time_column: str | None = "timestamp") -> list[dict]:
    """Run SQL through the ClickHouse HTTP interface.

    Values go over as ClickHouse query parameters ({name:String}), never interpolated.
    `time_column` names this table's event-time column so a VERIFY_SINCE cutoff can be
    appended -- events_raw keys on `timestamp`, daily_feature_usage on `date`.
    """
    # time_column=None opts a query out of the cutoff entirely.
    since_clause = f" AND {time_column} >= {{since:DateTime}}" if (VERIFY_SINCE and time_column) else ""
    body = sql.replace("%(tenant)s", "{tenant:String}" + since_clause)
    if VERIFY_SINCE and time_column:
        params = {**(params or {}), "since": VERIFY_SINCE}
    response = requests.post(
        CLICKHOUSE_URL,
        params={
            "default_format": "JSON",
            **{f"param_{k}": v for k, v in (params or {}).items()},
        },
        data=body.encode("utf-8"),
        auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD),
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("data", [])


def one(sql: str, params: dict | None = None, time_column: str | None = "timestamp") -> dict:
    rows = query(sql, params, time_column)
    return rows[0] if rows else {}


def check_identity() -> None:
    row = one(
        """
        SELECT count() AS total,
               countIf(event_id = '') AS no_event_id,
               countIf(session_id = '') AS no_session_id
        FROM feature_intelligence.events_raw
        WHERE tenant_id = %(tenant)s
        """,
        {"tenant": TENANT},
    )
    total = int(row.get("total", 0))
    if not total:
        record("IDENTITY event_id/session_id populated", False, "no rows for tenant " + TENANT)
        return
    record(
        "IDENTITY event_id populated on every row",
        int(row["no_event_id"]) == 0,
        f"{row['no_event_id']}/{total} missing",
    )
    record(
        "IDENTITY session_id populated on every row",
        int(row["no_session_id"]) == 0,
        f"{row['no_session_id']}/{total} missing",
    )


def check_sessions() -> None:
    row = one(
        """
        SELECT count() AS events,
               uniqExact(session_id) AS sessions,
               countIf(session_id LIKE 'server-%') AS server_minted
        FROM feature_intelligence.events_raw
        WHERE tenant_id = %(tenant)s
        """,
        {"tenant": TENANT},
    )
    events, sessions = int(row.get("events", 0)), int(row.get("sessions", 0)) or 1
    ratio = events / sessions
    record(
        "SESSIONS no server-minted fallback ids",
        int(row.get("server_minted", 0)) == 0,
        f"{row.get('server_minted')} rows fell back to server-<uuid>; the x-session-id header "
        f"is not reaching eventTracker.ts",
    )
    record(
        "SESSIONS events per session > 1.5",
        ratio > 1.5,
        f"{ratio:.2f} events/session ({events} events, {sessions} sessions)",
    )


def check_duplicates() -> None:
    rows = query(
        """
        SELECT event_name, timestamp, user_id, count() AS n
        FROM feature_intelligence.events_raw
        WHERE tenant_id = %(tenant)s
        GROUP BY event_name, timestamp, user_id
        HAVING n > 1
        ORDER BY n DESC
        LIMIT 5
        """,
        {"tenant": TENANT},
    )
    sample = ", ".join(f"{r['event_name']}x{r['n']}" for r in rows)
    record(
        "DUPES no same-event/user/second repeats",
        not rows,
        f"{len(rows)} colliding groups: {sample}" if rows else "",
    )


# `channel` is a top-level events_raw COLUMN, not a metadata key -- but every contract lists
# it under dimensions.allowed, which CLAUDE.md describes as "physical metadata keys". Reading
# it out of the JSON returns empty on every row. Anything localizing on channel must read the
# column; the contracts carry a note saying so.
COLUMN_DIMENSIONS = {"channel"}


def dimension_expr(key: str) -> str:
    """SQL for a contract dimension, whether it lives in a column or in the metadata JSON."""
    if key in COLUMN_DIMENSIONS:
        return key
    return f"JSONExtractString(metadata, '{key}')"


def check_dimensions() -> None:
    import glob

    import yaml

    for path in sorted(glob.glob(os.path.join(REPO, "contracts", "*.yaml"))):
        contract = yaml.safe_load(open(path, encoding="utf-8"))
        # A fact-based contract's dimensions are COLUMNS on a fact table, not metadata keys in
        # events_raw -- `region`, `branch_code`, `txn_type` are not in the clickstream at all, so
        # looking for them here fails by construction. This check predates fact-based contracts;
        # without the skip it reported seven permanent failures and the script could never exit 0,
        # which is how a gate teaches people to ignore it.
        if any(f.get("table") for f in (contract.get("fundamentals") or [])):
            continue
        allowed = (contract.get("dimensions") or {}).get("allowed") or []
        keys = [k for k in allowed if k != "event_name"]
        if not keys:
            continue
        selects = ", ".join(
            f"countIf({dimension_expr(k)} = '') AS missing_{k}" for k in keys
        )
        row = one(
            f"SELECT count() AS total, {selects} "
            "FROM feature_intelligence.events_raw WHERE tenant_id = %(tenant)s",
            {"tenant": TENANT},
        )
        total = int(row.get("total", 0)) or 1
        gaps = [
            f"{k} empty on {row[f'missing_{k}']}/{total}"
            for k in keys
            if int(row[f"missing_{k}"]) > 0
        ]
        record(f"DIMS {contract['id']}: declared dimensions populated", not gaps, "; ".join(gaps))

        # A session-grain contract may only localize attributes that do not vary inside a
        # session; otherwise sum(cells) != total and contribution shares are meaningless.
        if (contract.get("grain") or {}).get("entity") == "session":
            for key in keys:
                bad = one(
                    f"""
                    SELECT countIf(variants > 1) AS bad FROM (
                        SELECT session_id, uniqExact({dimension_expr(key)}) AS variants
                        FROM feature_intelligence.events_raw
                        WHERE tenant_id = %(tenant)s AND session_id != ''
                        GROUP BY session_id
                    )
                    """,
                    {"tenant": TENANT},
                ).get("bad", 0)
                record(
                    f"DIMS {contract['id']}: '{key}' is session-invariant",
                    int(bad) == 0,
                    f"{bad} sessions carry more than one value for {key}",
                )


def check_geo_consistency() -> None:
    """One country must sit in exactly one continent, on every path.

    The producers derive city/country/continent from a single table each, so a mismatch means one
    of them patched a field without its siblings. That happened: forcing a country on the simulate
    console rewrote `location` and left `city`/`continent` describing the country it replaced, so
    events claimed India from Berlin, Austin and Sydney. `continent` is a declared contract
    dimension -- that cell was not merely generated, it was wrong, and no existing check looked.
    """
    rows = query(
        """
        SELECT JSONExtractString(metadata, 'location')  AS country,
               JSONExtractString(metadata, 'continent') AS continent,
               count() AS n
        FROM feature_intelligence.events_raw
        WHERE tenant_id = %(tenant)s AND country != '' AND continent != ''
        GROUP BY country, continent
        """,
        {"tenant": TENANT},
    )
    by_country: dict[str, set] = {}
    for r in rows:
        by_country.setdefault(r["country"], set()).add(r["continent"])
    split = {c: sorted(v) for c, v in by_country.items() if len(v) > 1}
    record(
        "GEO each country sits in exactly one continent",
        not split,
        "; ".join(f"{c} in {v}" for c, v in sorted(split.items())),
    )


def check_contract_events_land() -> None:
    """Reachable in theory is not the same as present in the data.

    TAXONOMY proves a contract event CAN be produced. This proves rows actually carrying it
    exist, canonicalized the way a reader would see them. It catches the "reads zero
    silently" failure: /funnels was expanding step aliases from the hand-maintained alias
    dict only, so it searched for names no producer writes and returned 0 while events_raw
    held thousands of matching rows.

    A fundamental with no rows is only flagged when a SIBLING fundamental in the same
    contract does have rows -- otherwise the KPI simply has no traffic yet, which is not a
    defect.
    """
    import glob

    import yaml

    rows = query(
        "SELECT DISTINCT event_name FROM feature_intelligence.events_raw "
        "WHERE tenant_id = %(tenant)s",
        {"tenant": TENANT},
    )
    counts: dict[str, int] = {}
    for row in rows:
        name = str(row["event_name"])
        canon = canonicalize_event_name(name)
        if canon:
            counts[canon] = counts.get(canon, 0) + 1

    for path in sorted(glob.glob(os.path.join(REPO, "contracts", "*.yaml"))):
        contract = yaml.safe_load(open(path, encoding="utf-8"))
        fundamentals: set[str] = set()
        for fundamental in contract.get("fundamentals") or []:
            if fundamental.get("event"):
                fundamentals.add(fundamental["event"])
            fundamentals.update(fundamental.get("events") or [])
        if not fundamentals:
            continue

        present = [e for e in sorted(fundamentals) if counts.get(e)]
        absent = [e for e in sorted(fundamentals) if not counts.get(e)]

        if not present:
            record(
                f"LANDED {contract['id']}: fundamentals present in events_raw",
                True,
                "no traffic for this KPI yet -- not a defect",
            )
            continue
        record(
            f"LANDED {contract['id']}: fundamentals present in events_raw",
            not absent,
            f"present: {', '.join(present)}; MISSING while siblings have data: {', '.join(absent)}"
            if absent else f"{len(present)}/{len(fundamentals)} with data",
        )


def check_rollup() -> None:
    """Whole-table invariant, so it deliberately ignores VERIFY_SINCE.

    daily_feature_usage is day-grained; a sub-day cutoff cannot be expressed against it
    without comparing different windows on the two sides and reporting a false mismatch.
    """
    raw = one(
        "SELECT uniqExact(event_id) AS n FROM feature_intelligence.events_raw "
        "WHERE tenant_id = %(tenant)s",
        {"tenant": TENANT},
        time_column=None,
    ).get("n", 0)
    rolled = one(
        "SELECT uniqExactMerge(event_count) AS n FROM feature_intelligence.daily_feature_usage "
        "WHERE tenant_id = %(tenant)s",
        {"tenant": TENANT},
        time_column=None,
    ).get("n", 0)
    record(
        "ROLLUP daily_feature_usage agrees with events_raw (all rows, cutoff not applicable)",
        int(raw) == int(rolled),
        f"events_raw={raw} rollup={rolled}",
    )


def main() -> int:
    print(f"\nVerifying telemetry quality for tenant '{TENANT}'\n")
    for label, fn in [
        ("Taxonomy reachability", check_taxonomy),
        ("Event identity", check_identity),
        ("Session grain", check_sessions),
        ("Duplicate emission", check_duplicates),
        ("Dimension coverage", check_dimensions),
        ("Geo consistency", check_geo_consistency),
        ("Contract events landed", check_contract_events_land),
        ("Rollup consistency", check_rollup),
    ]:
        print(f"{label}:")
        try:
            fn()
        except Exception as exc:  # a broken check must not look like a passing one
            record(label, False, f"check raised: {exc}")
        print()

    failed = [name for name, ok, _ in results if not ok]
    if failed:
        print(f"{RED}{len(failed)} of {len(results)} checks FAILED{RESET}")
        for name in failed:
            print(f"  - {name}")
        return 1
    print(f"{GREEN}all {len(results)} checks passed{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
