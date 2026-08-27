"""
Tests for Phase 3 proposals 2 + 3 (docs/audits/clickhouse_pipeline_audit_phase3_proposals.md),
implemented per docs/audits/clickhouse_pipeline_implementation_prompt.md Phase B:

  - processing/worker.py's _attach_kafka_metadata() -- kafka_partition/kafka_offset/kafka_topic/
    ingest_path='kafka' attached to every consumed message.
  - storage/client.py's insert_events() -- writes the five new columns, defaulting safely (never
    guessing 'kafka') for a caller that doesn't set them, since it's shared with
    api/seed_safexbank.py, a third insert site that bypasses Kafka and the ingestion API
    entirely.
  - ingestion/main.py's _insert_direct_to_clickhouse() -- always writes the Kafka-metadata
    sentinels plus the ingest_path the caller passed in ('fallback_cloud' / 'fallback_onprem').
  - scripts/reconcile_kafka_offsets.py's compute_gap() -- the reconciliation arithmetic, in
    isolation.
  - scripts/find_dual_path_duplicates.py's build_query() -- the dual-path detection query shape.

All ClickHouse access is mocked -- no test here requires a live broker or ClickHouse connection,
and no test writes a real row.

Run from the repo root, in an environment with this project's actual dependencies installed
(e.g. inside the ingestion-api / analytics-api / processor-worker container):

    python -m unittest tests.test_kafka_metadata_columns -v
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ingestion.main as ingestion_main  # noqa: E402
import processing.worker as worker  # noqa: E402
from scripts import find_dual_path_duplicates  # noqa: E402
from scripts import reconcile_kafka_offsets  # noqa: E402
from storage.client import ClickHouseClient  # noqa: E402


class FakeMessage:
    """Stands in for a confluent_kafka.Message."""

    def __init__(self, partition=3, offset=42, topic="feature-events"):
        self._partition = partition
        self._offset = offset
        self._topic = topic

    def partition(self):
        return self._partition

    def offset(self):
        return self._offset

    def topic(self):
        return self._topic


class FakeClickHouseClient:
    def __init__(self):
        self.inserts = []

    def insert(self, table, rows, column_names):
        self.inserts.append((table, rows, column_names))


class AttachKafkaMetadata(unittest.TestCase):
    def test_attaches_partition_offset_topic_and_kafka_path(self):
        event_data = {"event_id": "evt_1", "event_name": "x.y.z"}
        msg = FakeMessage(partition=3, offset=42, topic="feature-events")

        result = worker._attach_kafka_metadata(event_data, msg)

        self.assertIs(result, event_data)  # mutates and returns the same dict
        self.assertEqual(event_data["kafka_partition"], 3)
        self.assertEqual(event_data["kafka_offset"], 42)
        self.assertEqual(event_data["kafka_topic"], "feature-events")
        self.assertEqual(event_data["ingest_path"], "kafka")
        # The original fields must survive untouched.
        self.assertEqual(event_data["event_id"], "evt_1")


class InsertEventsColumnHandling(unittest.TestCase):
    """storage/client.py's insert_events() -- shared by processing/worker.py (sets all five
    fields) and api/seed_safexbank.py (sets none of them)."""

    def test_worker_style_event_writes_real_kafka_metadata(self):
        client = ClickHouseClient()
        fake = FakeClickHouseClient()
        event = {
            "event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z",
            "user_id": "u1", "channel": "web", "timestamp": 1718361234.56,
            "metadata": {}, "kafka_partition": 2, "kafka_offset": 99,
            "kafka_topic": "feature-events", "ingest_path": "kafka",
        }
        with mock.patch.object(client, "_get_client", return_value=fake):
            client.insert_events([event])

        _, rows, column_names = fake.inserts[0]
        # Exact list, deliberately -- an unintended reorder would silently corrupt every row.
        # '_inserted_at' appended for Phase C (Phase 3 proposal 1 Option A); see
        # tests/test_inserted_at_version_column.py for that column's own dedicated coverage.
        self.assertEqual(
            column_names,
            ["event_id", "session_id", "tenant_id", "event_name", "user_id", "channel",
             "timestamp", "metadata", "kafka_partition", "kafka_offset", "kafka_topic",
             "ingested_at", "ingest_path", "_inserted_at"],
        )
        row = rows[0]
        # kafka_partition, kafka_offset, kafka_topic, ingest_path are found by index (not
        # position) below so this part of the test doesn't also need editing on every column
        # addition -- only the exact-list assertion above is meant to catch reordering.
        self.assertEqual(row[column_names.index("kafka_partition")], 2)
        self.assertEqual(row[column_names.index("kafka_offset")], 99)
        self.assertEqual(row[column_names.index("kafka_topic")], "feature-events")
        self.assertEqual(row[column_names.index("ingest_path")], "kafka")

    def test_seed_script_style_event_defaults_safely_not_to_kafka(self):
        # api/seed_safexbank.py never sets any of the five new fields -- insert_events() must
        # not guess 'kafka' for it.
        client = ClickHouseClient()
        fake = FakeClickHouseClient()
        event = {
            "event_id": "evt_seed", "tenant_id": "safexbank", "event_name": "x.y.z",
            "user_id": "u1", "channel": "web", "timestamp": 1718361234.56, "metadata": {},
        }
        with mock.patch.object(client, "_get_client", return_value=fake):
            client.insert_events([event])

        _, rows, column_names = fake.inserts[0]
        row = rows[0]
        self.assertEqual(row[column_names.index("kafka_partition")], -1)
        self.assertEqual(row[column_names.index("kafka_offset")], -1)
        self.assertEqual(row[column_names.index("kafka_topic")], "")
        self.assertEqual(row[column_names.index("ingest_path")], "")  # NOT 'kafka'

    def test_empty_events_list_is_a_no_op(self):
        client = ClickHouseClient()
        fake = FakeClickHouseClient()
        with mock.patch.object(client, "_get_client", return_value=fake):
            client.insert_events([])
        self.assertEqual(fake.inserts, [])


class InsertDirectToClickHouseIngestPath(unittest.TestCase):
    """ingestion/main.py's _insert_direct_to_clickhouse() -- always sentinel Kafka metadata,
    ingest_path set by the caller."""

    BASE_EVENT = {
        "event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z",
        "user_id": "u1", "channel": "web", "timestamp": 1718361234.56, "metadata": {},
    }

    def _insert_and_capture(self, ingest_path: str):
        fake = FakeClickHouseClient()
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake):
            ingestion_main._insert_direct_to_clickhouse(dict(self.BASE_EVENT), ingest_path)
        _, rows, column_names = fake.inserts[0]
        return dict(zip(column_names, rows[0]))

    def test_fallback_cloud_path_is_recorded(self):
        row = self._insert_and_capture("fallback_cloud")
        self.assertEqual(row["ingest_path"], "fallback_cloud")
        self.assertEqual(row["kafka_partition"], -1)
        self.assertEqual(row["kafka_offset"], -1)
        self.assertEqual(row["kafka_topic"], "")

    def test_fallback_onprem_path_is_recorded(self):
        row = self._insert_and_capture("fallback_onprem")
        self.assertEqual(row["ingest_path"], "fallback_onprem")
        self.assertEqual(row["kafka_partition"], -1)
        self.assertEqual(row["kafka_offset"], -1)
        self.assertEqual(row["kafka_topic"], "")

    def test_column_list_matches_row_length(self):
        fake = FakeClickHouseClient()
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake):
            ingestion_main._insert_direct_to_clickhouse(dict(self.BASE_EVENT), "fallback_cloud")
        _, rows, column_names = fake.inserts[0]
        self.assertEqual(len(rows[0]), len(column_names))


class ReconcileGapArithmetic(unittest.TestCase):
    """scripts/reconcile_kafka_offsets.py's compute_gap()."""

    def test_no_gap_when_committed_matches_max_ch_plus_one(self):
        # committed offset is the NEXT offset to read, so committed=43 with max_ch=42 means the
        # last processed message (42) is exactly what's in ClickHouse -- gap 0.
        self.assertEqual(reconcile_kafka_offsets.compute_gap(committed_offset=43, max_ch_offset=42), 0)

    def test_positive_gap_when_clickhouse_is_behind(self):
        self.assertEqual(reconcile_kafka_offsets.compute_gap(committed_offset=50, max_ch_offset=42), 7)

    def test_negative_gap_is_not_clamped(self):
        # ClickHouse ahead of the committed offset (e.g. an async commit lagging behind an
        # already-flushed insert) is a different, non-lossy condition -- must not be reported as
        # a positive gap.
        self.assertLess(reconcile_kafka_offsets.compute_gap(committed_offset=40, max_ch_offset=42), 0)

    def test_no_rows_in_clickhouse_at_all(self):
        self.assertEqual(reconcile_kafka_offsets.compute_gap(committed_offset=10, max_ch_offset=None), 10)


class DualPathQueryShape(unittest.TestCase):
    """scripts/find_dual_path_duplicates.py's build_query()."""

    def test_query_filters_on_kafka_and_a_fallback_path(self):
        sql, params = find_dual_path_duplicates.build_query(hours=24, tenants=None)
        self.assertIn("ingest_path", sql)
        self.assertIn("'kafka'", sql)
        self.assertIn("fallback_cloud", sql)
        self.assertIn("fallback_onprem", sql)
        self.assertEqual(params["hours"], 24)
        self.assertNotIn("tenants", params)

    def test_tenant_filter_is_applied_when_given(self):
        sql, params = find_dual_path_duplicates.build_query(hours=6, tenants=["nexabank"])
        self.assertIn("tenant_id IN %(tenants)s", sql)
        self.assertEqual(params["tenants"], ("nexabank",))


if __name__ == "__main__":
    unittest.main()
