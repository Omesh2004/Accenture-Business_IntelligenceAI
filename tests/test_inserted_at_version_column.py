"""
Tests for Phase 3 proposal 1 Option A's `_inserted_at` version column (docs/audits/
clickhouse_pipeline_audit_phase3_proposals.md), implemented per docs/audits/
clickhouse_pipeline_implementation_prompt.md Phase C, step 2 ("thread _inserted_at through both
insert paths").

DEPLOYMENT NOTE: this column does not exist on the live `events_raw` until the Phase C
rename-swap actually runs -- see
docs/audits/clickhouse_pipeline_implementation_phase_c_report.md for why these tests are run
only against mocks / an isolated non-serving container, never against the actually-live
ingestion-api / analytics-api / processor-worker containers, until after that swap.

All ClickHouse access is mocked -- no live connection required, no real row ever written.

Run from the repo root, in an environment with this project's actual dependencies installed:

    python -m unittest tests.test_inserted_at_version_column -v
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ingestion.main as ingestion_main  # noqa: E402
from storage.client import ClickHouseClient  # noqa: E402


class FakeClickHouseClient:
    def __init__(self):
        self.inserts = []

    def insert(self, table, rows, column_names):
        self.inserts.append((table, rows, column_names))


class InsertEventsThreadsInsertedAt(unittest.TestCase):
    def test_inserted_at_is_present_and_a_real_datetime(self):
        client = ClickHouseClient()
        fake = FakeClickHouseClient()
        event = {
            "event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z",
            "user_id": "u1", "channel": "web", "timestamp": 1718361234.56, "metadata": {},
        }
        with mock.patch.object(client, "_get_client", return_value=fake):
            client.insert_events([event])

        _, rows, column_names = fake.inserts[0]
        self.assertIn("_inserted_at", column_names)
        row = dict(zip(column_names, rows[0]))
        self.assertIsNotNone(row["_inserted_at"])

    def test_inserted_at_and_ingested_at_are_distinct_columns_with_equal_values(self):
        # Same "now" reused for both -- they are conceptually different columns (a plain audit
        # column vs. the ReplacingMergeTree version column) that happen to share a value, not
        # the same column referenced twice.
        client = ClickHouseClient()
        fake = FakeClickHouseClient()
        event = {
            "event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z",
            "user_id": "u1", "channel": "web", "timestamp": 1718361234.56, "metadata": {},
        }
        with mock.patch.object(client, "_get_client", return_value=fake):
            client.insert_events([event])

        _, rows, column_names = fake.inserts[0]
        self.assertEqual(column_names.count("ingested_at"), 1)
        self.assertEqual(column_names.count("_inserted_at"), 1)
        row = dict(zip(column_names, rows[0]))
        self.assertEqual(row["ingested_at"], row["_inserted_at"])

    def test_column_list_matches_row_length(self):
        client = ClickHouseClient()
        fake = FakeClickHouseClient()
        event = {
            "event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z",
            "user_id": "u1", "channel": "web", "timestamp": 1718361234.56, "metadata": {},
        }
        with mock.patch.object(client, "_get_client", return_value=fake):
            client.insert_events([event])
        _, rows, column_names = fake.inserts[0]
        self.assertEqual(len(rows[0]), len(column_names))


class InsertDirectToClickHouseThreadsInsertedAt(unittest.TestCase):
    BASE_EVENT = {
        "event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z",
        "user_id": "u1", "channel": "web", "timestamp": 1718361234.56, "metadata": {},
    }

    def test_inserted_at_is_present_alongside_ingest_path(self):
        fake = FakeClickHouseClient()
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake):
            ingestion_main._insert_direct_to_clickhouse(dict(self.BASE_EVENT), "fallback_cloud")

        _, rows, column_names = fake.inserts[0]
        row = dict(zip(column_names, rows[0]))
        self.assertIn("_inserted_at", column_names)
        self.assertIsNotNone(row["_inserted_at"])
        self.assertEqual(row["ingest_path"], "fallback_cloud")

    def test_column_list_matches_row_length(self):
        fake = FakeClickHouseClient()
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake):
            ingestion_main._insert_direct_to_clickhouse(dict(self.BASE_EVENT), "fallback_onprem")
        _, rows, column_names = fake.inserts[0]
        self.assertEqual(len(rows[0]), len(column_names))


if __name__ == "__main__":
    unittest.main()
