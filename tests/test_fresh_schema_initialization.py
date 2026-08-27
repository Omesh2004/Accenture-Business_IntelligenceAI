"""
Verifies storage/schema.sql actually initializes a working events pipeline on a genuinely
empty ClickHouse database -- the scenario `docker compose up` on a brand-new volume hits, and
the exact scenario that was broken during the NexaBank telemetry audit (a fresh volume would
have created the pre-audit events_raw shape, immediately failing every insert the runtime code
makes, with the dead-letter fallback ALSO failing for the same reason).

Creates an ISOLATED database (never `feature_intelligence`, never the live one), applies
storage/schema.sql verbatim, then runs a real insert through the same code paths
storage/client.py and ingestion/main.py use, against that fresh database. Drops the database
when done, pass or fail.

This is a LIVE integration test, not a mock -- schema initialization is fundamentally a claim
about what CREATE TABLE actually produces, which a mock cannot exercise meaningfully (see
tests/test_item8_query_dedup.py for the same reasoning applied to a different claim).

Run inside a container with a real ClickHouse connection:

    docker compose run --rm --name fresh-schema-test <any python service> \\
        python -m unittest tests.test_fresh_schema_initialization -v
"""
import os
import re
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import clickhouse_connect  # noqa: E402

from core.config import settings  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST_DB = "fresh_schema_audit_test"


def _split_statements(sql_text: str) -> list[str]:
    """storage/schema.sql has no runner; strip every `-- ...` comment FIRST, across the whole
    text, then split what remains on top-level semicolons.

    Two comment shapes both had to be handled, not just full comment-only lines: this file also
    has INLINE trailing comments after real code on the same line (e.g.
    `investigation_id String,   -- the spine; see note above`), and both shapes occasionally
    contain a literal semicolon inside the comment's own prose. Truncating each line at its
    FIRST unquoted `--` (there are no `--` sequences inside this file's string literals) turns
    both shapes into the same case, so a comment's internal semicolon can never be mistaken for
    a statement boundary -- the earlier per-full-line-only check missed the inline case and
    still produced bogus fragment "statements" like the literal text "see note above"."""
    without_comments = "\n".join(line.split("--", 1)[0] for line in sql_text.splitlines())
    return [s.strip() for s in without_comments.split(";") if s.strip()]


class FreshSchemaInitialization(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_client = clickhouse_connect.get_client(
            host=settings.CLICKHOUSE_HOST,
            port=settings.CLICKHOUSE_PORT,
            username=settings.CLICKHOUSE_USER,
            password=settings.CLICKHOUSE_PASSWORD,
        )
        cls.admin_client.command(f"DROP DATABASE IF EXISTS {TEST_DB}")

        schema_path = os.path.join(REPO_ROOT, "storage", "schema.sql")
        with open(schema_path, "r", encoding="utf-8") as fh:
            raw_sql = fh.read()

        # Redirect every statement at the isolated test database instead of
        # feature_intelligence, so this never touches real data.
        scoped_sql = raw_sql.replace("feature_intelligence", TEST_DB)
        scoped_sql = re.sub(
            r"CREATE DATABASE IF NOT EXISTS \w+",
            f"CREATE DATABASE IF NOT EXISTS {TEST_DB}",
            scoped_sql,
        )

        for statement in _split_statements(scoped_sql):
            cls.admin_client.command(statement)

        cls.test_client = clickhouse_connect.get_client(
            host=settings.CLICKHOUSE_HOST,
            port=settings.CLICKHOUSE_PORT,
            username=settings.CLICKHOUSE_USER,
            password=settings.CLICKHOUSE_PASSWORD,
            database=TEST_DB,
        )

    @classmethod
    def tearDownClass(cls):
        try:
            cls.admin_client.command(f"DROP DATABASE IF EXISTS {TEST_DB}")
        except Exception:
            pass

    def test_events_raw_accepts_the_exact_row_shape_insert_events_writes(self):
        """Reproduces storage/client.py's insert_events() column list and row shape exactly
        (14 columns, ReplacingMergeTree version column included) against the freshly
        initialized table."""
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        row = [[
            "fresh-test-evt-1", "fresh-test-sess", "test_tenant", "dashboard.page.view",
            "test_user", "web", now, "{}",
            0, 42, "feature-events", now, "kafka", now,
        ]]
        try:
            self.test_client.insert(
                "events_raw",
                row,
                column_names=[
                    "event_id", "session_id", "tenant_id", "event_name", "user_id", "channel",
                    "timestamp", "metadata", "kafka_partition", "kafka_offset", "kafka_topic",
                    "ingested_at", "ingest_path", "_inserted_at",
                ],
            )
        except Exception as exc:
            self.fail(
                f"A fresh events_raw table (from storage/schema.sql) rejected the exact row "
                f"shape storage/client.py's insert_events() writes on every insert: {exc}"
            )

        result = self.test_client.query(
            "SELECT event_id, kafka_offset, ingest_path FROM events_raw WHERE event_id = 'fresh-test-evt-1'"
        )
        self.assertEqual(len(result.result_rows), 1)
        self.assertEqual(result.result_rows[0][1], 42)
        self.assertEqual(result.result_rows[0][2], "kafka")

    def test_events_raw_accepts_the_direct_fallback_row_shape(self):
        """Reproduces ingestion/main.py's _insert_direct_to_clickhouse_once() row shape --
        the path used when Kafka is unavailable, which must independently work on a fresh
        volume since it is often the FIRST insert path exercised (before any worker has run)."""
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        row = [[
            "fresh-test-evt-2", "fresh-test-sess", "test_tenant", "dashboard.page.view",
            "test_user", "web", now, "{}",
            -1, -1, "", now, "fallback_cloud", now,
        ]]
        try:
            self.test_client.insert(
                "events_raw",
                row,
                column_names=[
                    "event_id", "session_id", "tenant_id", "event_name", "user_id", "channel",
                    "timestamp", "metadata", "kafka_partition", "kafka_offset", "kafka_topic",
                    "ingested_at", "ingest_path", "_inserted_at",
                ],
            )
        except Exception as exc:
            self.fail(f"A fresh events_raw table rejected the direct-fallback row shape: {exc}")

    def test_events_dead_letter_accepts_the_stage_tagged_row_shape(self):
        """Both dead-letter writers (worker poison rows, ingest validation failures) pass
        `stage` unconditionally -- this is the column whose absence caused the SECONDARY,
        total-loss failure during the live audit (the primary events_raw failure's own
        dead-letter fallback failed too)."""
        row = [["fresh-test-evt-3", "test_tenant", "dashboard.page.view", "{}", "some error", "worker_poison"]]
        try:
            self.test_client.insert(
                "events_dead_letter",
                row,
                column_names=["event_id", "tenant_id", "event_name", "payload", "error", "stage"],
            )
        except Exception as exc:
            self.fail(
                f"A fresh events_dead_letter table rejected a 'stage'-tagged row -- this is "
                f"the exact secondary failure that lost a probe event with zero trace during "
                f"the live audit: {exc}"
            )

    def test_daily_feature_usage_rollup_populates_from_a_fresh_insert(self):
        """End-to-end: insert into events_raw, confirm the materialized view actually rolls it
        into daily_feature_usage on a freshly initialized schema."""
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        row = [[
            "fresh-test-evt-4", "fresh-test-sess", "test_tenant", "rollup.probe.view",
            "test_user", "web", now, "{}",
            -1, -1, "", now, "fallback_cloud", now,
        ]]
        self.test_client.insert(
            "events_raw", row,
            column_names=[
                "event_id", "session_id", "tenant_id", "event_name", "user_id", "channel",
                "timestamp", "metadata", "kafka_partition", "kafka_offset", "kafka_topic",
                "ingested_at", "ingest_path", "_inserted_at",
            ],
        )
        result = self.test_client.query(
            "SELECT uniqExactMerge(event_count) AS n FROM daily_feature_usage "
            "WHERE tenant_id = 'test_tenant' AND event_name = 'rollup.probe.view'"
        )
        self.assertEqual(result.result_rows[0][0], 1)

    def test_events_raw_engine_is_replacingmergetree_on_a_fresh_volume(self):
        result = self.test_client.query(f"SELECT engine FROM system.tables WHERE database='{TEST_DB}' AND name='events_raw'")
        self.assertEqual(result.result_rows[0][0], "ReplacingMergeTree")


if __name__ == "__main__":
    unittest.main()
