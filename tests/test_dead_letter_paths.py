"""
Tests for Phase 3 proposal 4c (docs/audits/clickhouse_pipeline_audit_phase3_proposals.md),
implemented per docs/audits/clickhouse_pipeline_implementation_prompt.md Phase A:

  - ingestion/main.py's new _dead_letter_validation_failure() (pre-Kafka validation failures,
    stage='ingest_validation') -- previously only a log line, per Phase 1 item 3
    (docs/audits/clickhouse_pipeline_audit_phase1_findings.md).
  - processing/worker.py's existing _dead_letter() (stage='worker_poison'), updated to carry the
    same new `stage` column so both writers into events_dead_letter agree on its shape (CLAUDE.md
    coupling point 5).

Both are tested by mocking the ClickHouse client -- no live ClickHouse connection is required,
and no row is ever actually written to a real events_dead_letter table by these tests.

Run from the repo root, in an environment with this project's actual dependencies installed
(fastapi, pydantic, aiokafka, confluent-kafka, clickhouse-connect -- e.g. inside the
ingestion-api / analytics-api / processor-worker container, which all share requirements.txt):

    python -m unittest tests.test_dead_letter_paths -v
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ingestion.main as ingestion_main  # noqa: E402
import processing.worker as worker  # noqa: E402


class FakeClickHouseClient:
    """Records insert() calls instead of touching a real ClickHouse instance."""

    def __init__(self, raise_on_insert: Exception | None = None):
        self.inserts: list[tuple[str, list, list]] = []
        self._raise_on_insert = raise_on_insert

    def insert(self, table, rows, column_names):
        if self._raise_on_insert is not None:
            raise self._raise_on_insert
        self.inserts.append((table, rows, column_names))


class IngestValidationDeadLetter(unittest.TestCase):
    """ingestion/main.py's _dead_letter_validation_failure -- the new writer for 4c."""

    def test_writes_expected_row_shape_with_ingest_validation_stage(self):
        fake_client = FakeClickHouseClient()
        payload = {"event_name": "login.auth.success", "tenant_id": "nexabank"}  # missing event_id
        errors = [{"field": "event_id", "message": "Field required", "type": "missing"}]

        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake_client):
            ingestion_main._dead_letter_validation_failure(payload, errors)

        self.assertEqual(len(fake_client.inserts), 1)
        table, rows, column_names = fake_client.inserts[0]
        self.assertEqual(table, "feature_intelligence.events_dead_letter")
        self.assertEqual(
            column_names,
            ["event_id", "tenant_id", "event_name", "payload", "error", "stage"],
        )
        self.assertEqual(len(rows), 1)
        event_id, tenant_id, event_name, payload_json, error_json, stage = rows[0]
        self.assertEqual(event_id, "")  # payload never had one -- that's WHY it failed validation
        self.assertEqual(tenant_id, "nexabank")
        self.assertEqual(event_name, "login.auth.success")
        self.assertEqual(json.loads(payload_json), payload)
        self.assertEqual(stage, "ingest_validation")
        self.assertIn("Field required", error_json)

    def test_handles_completely_unparseable_payload(self):
        # ingestion/main.py's exception handler passes {"_error": "..."} when the body wasn't
        # even valid JSON -- must not crash on a payload with none of the usual keys.
        fake_client = FakeClickHouseClient()
        payload = {"_error": "Could not parse request body"}

        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake_client):
            ingestion_main._dead_letter_validation_failure(payload, [])

        _, rows, _ = fake_client.inserts[0]
        event_id, tenant_id, event_name, payload_json, _, stage = rows[0]
        self.assertEqual(event_id, "")
        self.assertEqual(tenant_id, "")
        self.assertEqual(event_name, "")
        self.assertEqual(json.loads(payload_json), payload)
        self.assertEqual(stage, "ingest_validation")

    def test_insert_failure_is_swallowed_not_raised(self):
        # A lost DLQ write must never turn into an unhandled exception on top of the 422 the
        # caller is already receiving.
        fake_client = FakeClickHouseClient(raise_on_insert=ConnectionError("ClickHouse is down"))
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake_client):
            try:
                ingestion_main._dead_letter_validation_failure({"event_name": "x"}, [])
            except Exception as exc:  # pragma: no cover - failure path
                self.fail(f"_dead_letter_validation_failure must not raise, raised: {exc!r}")


class WorkerPoisonDeadLetter(unittest.TestCase):
    """processing/worker.py's existing _dead_letter(), now threading the `stage` column too."""

    def test_writes_worker_poison_stage(self):
        fake_client = FakeClickHouseClient()
        records = [{"event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z"}]

        with mock.patch.object(worker.ch_client, "_get_client", return_value=fake_client):
            worker._dead_letter(records, "insert failed: bad type")

        table, rows, column_names = fake_client.inserts[0]
        self.assertEqual(table, "feature_intelligence.events_dead_letter")
        self.assertEqual(
            column_names,
            ["event_id", "tenant_id", "event_name", "payload", "error", "stage"],
        )
        *_, stage = rows[0]
        self.assertEqual(stage, "worker_poison")

    def test_empty_records_is_a_no_op(self):
        fake_client = FakeClickHouseClient()
        with mock.patch.object(worker.ch_client, "_get_client", return_value=fake_client):
            worker._dead_letter([], "unused")
        self.assertEqual(fake_client.inserts, [])


if __name__ == "__main__":
    unittest.main()
