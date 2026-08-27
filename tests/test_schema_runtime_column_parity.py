"""
Regression guard for the NexaBank telemetry audit's most severe live finding: a fresh
ClickHouse volume's `events_raw`/`events_dead_letter` (from storage/schema.sql) silently did
NOT match the columns storage/client.py and ingestion/main.py unconditionally write on every
insert. Reproduced live: a probe event failed with "Unrecognized column 'kafka_partition'",
and its dead-letter fallback ALSO failed with "Unrecognized column 'stage'" -- the event was
lost with zero trace anywhere. Both gaps existed because a migration was written and (per
tests/test_item8_query_dedup.py's own account) verified against SOME running ClickHouse
instance, but never applied to this one, and storage/schema.sql -- the fresh-volume
initializer -- was never brought in line either.

This test needs no live database: it parses storage/schema.sql's CREATE TABLE column lists and
compares them, statically, against the column_names lists the runtime writers actually pass to
clickhouse_connect's insert(). If either side changes without the other, this fails before any
container ever starts.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _schema_sql_columns(table_name: str) -> set[str]:
    """Column names declared for `table_name` in storage/schema.sql's CREATE TABLE block."""
    schema_path = os.path.join(REPO_ROOT, "storage", "schema.sql")
    with open(schema_path, "r", encoding="utf-8") as fh:
        text = fh.read()

    pattern = re.compile(
        rf"CREATE TABLE IF NOT EXISTS feature_intelligence\.{re.escape(table_name)} \((.*?)\n\)",
        re.DOTALL,
    )
    match = pattern.search(text)
    assert match, f"Could not find CREATE TABLE for {table_name} in storage/schema.sql"
    body = match.group(1)

    columns = set()
    for line in body.splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith("--"):
            continue
        name_match = re.match(r"`?(\w+)`?\s+\w", line)
        if name_match:
            columns.add(name_match.group(1))
    return columns


def _python_column_names_lists(file_path: str) -> list[set[str]]:
    """Every `column_names=[...]` literal list passed to a ClickHouse insert() call in a
    Python source file -- there is more than one insert site per file in general."""
    full_path = os.path.join(REPO_ROOT, file_path)
    with open(full_path, "r", encoding="utf-8") as fh:
        text = fh.read()

    results = []
    for match in re.finditer(r"column_names\s*=\s*\[(.*?)\]", text, re.DOTALL):
        names = re.findall(r"['\"](\w+)['\"]", match.group(1))
        if names:
            results.append(set(names))
    return results


class EventsRawColumnParity(unittest.TestCase):
    """storage/client.py's insert_events() and ingestion/main.py's direct-fallback path both
    write to events_raw. Every column either writes must exist in schema.sql's declaration --
    otherwise a fresh volume 500s on the very first insert, exactly as reproduced live."""

    def setUp(self):
        self.schema_columns = _schema_sql_columns("events_raw")

    def test_schema_declares_the_kafka_metadata_columns(self):
        # The specific columns whose absence caused the live incident.
        for col in ("kafka_partition", "kafka_offset", "kafka_topic", "ingested_at", "ingest_path"):
            self.assertIn(col, self.schema_columns, f"schema.sql events_raw is missing '{col}'")

    def test_schema_declares_inserted_at_as_the_replacingmergetree_version_column(self):
        self.assertIn(
            "_inserted_at", self.schema_columns,
            "schema.sql events_raw is missing '_inserted_at' -- both storage/client.py's "
            "insert_events() and ingestion/main.py's direct-fallback path write it "
            "unconditionally on every insert; its absence is the exact live failure this test "
            "guards against.",
        )

    def test_storage_client_insert_events_columns_are_all_declared_in_schema(self):
        lists = _python_column_names_lists("storage/client.py")
        # insert_events() writes events_raw specifically; find the list containing 'event_id'
        # AND '_inserted_at' together (its signature column pair) rather than assuming index 0.
        target = next((s for s in lists if "event_id" in s and "_inserted_at" in s), None)
        self.assertIsNotNone(target, "Could not locate insert_events()'s column_names list")
        missing = target - self.schema_columns
        self.assertFalse(
            missing,
            f"storage/client.py writes columns {missing} that storage/schema.sql does not "
            f"declare for events_raw -- a fresh volume will reject every insert.",
        )

    def test_ingestion_direct_fallback_columns_are_all_declared_in_schema(self):
        lists = _python_column_names_lists("ingestion/main.py")
        target = next((s for s in lists if "event_id" in s and "_inserted_at" in s), None)
        self.assertIsNotNone(
            target, "Could not locate the direct-ClickHouse fallback's column_names list"
        )
        missing = target - self.schema_columns
        self.assertFalse(
            missing,
            f"ingestion/main.py's direct-fallback insert writes columns {missing} that "
            f"storage/schema.sql does not declare for events_raw.",
        )

    def test_schema_column_set_is_a_superset_of_every_writer_not_the_other_way_only(self):
        # Guards the inverse mistake too: a schema column no writer ever populates is a smell
        # (dead column), not this test's concern to fail on, but every WRITER column must be a
        # schema column -- checked directly above. This test documents the asymmetry is
        # intentional: schema.sql may legitimately have columns (e.g. future-reserved ones) no
        # current writer sets.
        self.assertTrue(len(self.schema_columns) >= 8, "events_raw lost its base columns")


class EventsDeadLetterColumnParity(unittest.TestCase):
    """processing/worker.py's _dead_letter() and ingestion/main.py's
    _dead_letter_validation_failure() both write to events_dead_letter, both passing `stage`.
    A CREATE TABLE IF NOT EXISTS in a migration is a no-op against an already-existing table in
    the old (pre-`stage`) shape -- reproduced live: a probe event's dead-letter write failed
    with "Unrecognized column 'stage'", losing the event's replayable record entirely, layered
    on top of the events_raw failure above."""

    def setUp(self):
        self.schema_columns = _schema_sql_columns("events_dead_letter")

    def test_schema_declares_stage_column(self):
        self.assertIn(
            "stage", self.schema_columns,
            "schema.sql events_dead_letter is missing 'stage' -- both dead-letter writers pass "
            "it unconditionally; its absence is the exact live failure this test guards against.",
        )

    def test_worker_dead_letter_columns_are_all_declared_in_schema(self):
        lists = _python_column_names_lists("processing/worker.py")
        target = next((s for s in lists if "event_id" in s and "stage" in s), None)
        self.assertIsNotNone(target, "Could not locate worker _dead_letter()'s column_names list")
        missing = target - self.schema_columns
        self.assertFalse(missing, f"processing/worker.py's dead-letter write uses undeclared columns {missing}")

    def test_ingestion_dead_letter_columns_are_all_declared_in_schema(self):
        lists = _python_column_names_lists("ingestion/main.py")
        target = next((s for s in lists if "event_id" in s and "stage" in s), None)
        self.assertIsNotNone(
            target, "Could not locate ingestion's _dead_letter_validation_failure() column_names list"
        )
        missing = target - self.schema_columns
        self.assertFalse(missing, f"ingestion/main.py's dead-letter write uses undeclared columns {missing}")


class EventsRawEngineDeclaration(unittest.TestCase):
    """The engine itself, not just the columns: storage/client.py's docstring states plainly
    that _inserted_at is meaningless without ReplacingMergeTree (a plain MergeTree never
    deduplicates on it). Guards against the columns being added correctly while the engine
    silently regresses to MergeTree in a future edit."""

    def test_schema_declares_replacingmergetree_with_inserted_at_as_version_column(self):
        schema_path = os.path.join(REPO_ROOT, "storage", "schema.sql")
        with open(schema_path, "r", encoding="utf-8") as fh:
            text = fh.read()
        match = re.search(
            r"CREATE TABLE IF NOT EXISTS feature_intelligence\.events_raw \(.*?\n\)\s*\n?(ENGINE = [^\n]+)",
            text, re.DOTALL,
        )
        self.assertIsNotNone(match, "Could not find events_raw's ENGINE clause")
        engine_clause = match.group(1)
        self.assertIn("ReplacingMergeTree", engine_clause)
        self.assertIn("_inserted_at", engine_clause)


if __name__ == "__main__":
    unittest.main()
