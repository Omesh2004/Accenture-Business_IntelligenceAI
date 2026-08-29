"""
Tests for the Phase G follow-up work (closing the "known remaining work" list from
docs/audits/clickhouse_pipeline_implementation_phase_g_report.md), authorized explicitly
including the one DDL item:

  - storage/client.py + ingestion/main.py: both ClickHouse clients now set connect_timeout/
    send_receive_timeout, so a real outage raises instead of hanging (discovered live in Phase G
    -- see the report for the full ~45s ClickHouse-pause investigation).
  - ingestion/main.py's _insert_direct_to_clickhouse(): now retries a bounded number of times
    with backoff instead of making exactly one attempt.
  - processing/worker.py's _dead_letter_undecodable(): a Kafka message that fails to even
    become JSON is now dead-lettered instead of silently dropped.
  - ingestion/main.py's limit_events_body_size middleware: rejects an oversized /events request
    body based on Content-Length, checked before FastAPI would otherwise buffer it.

All ClickHouse/Kafka access is mocked -- no live connection required, no real row written.

Run from the repo root, in an environment with this project's actual dependencies installed:

    python -m unittest tests.test_phase_g_followup -v
"""
import asyncio
import time as _time

# Time-relative: a fixed past literal now fails FeatureEvent's timestamp bounds (P0-4).
_NOW_TS = _time.time()

import inspect
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ingestion.main as ingestion_main  # noqa: E402
import processing.worker as worker  # noqa: E402
import storage.client as storage_client  # noqa: E402


class FakeClickHouseClient:
    """Records insert() calls; can be made to fail N times before succeeding."""

    def __init__(self, fail_times=0, exc=None):
        self.inserts = []
        self._fail_times = fail_times
        self._calls = 0
        self._exc = exc or ConnectionError("ClickHouse unreachable")

    def insert(self, table, rows, column_names):
        self._calls += 1
        if self._calls <= self._fail_times:
            raise self._exc
        self.inserts.append((table, rows, column_names))


class FakeMessage:
    def __init__(self, partition=3, offset=42, topic="feature-events", value=b"not json{{{"):
        self._partition = partition
        self._offset = offset
        self._topic = topic
        self._value = value

    def partition(self):
        return self._partition

    def offset(self):
        return self._offset

    def topic(self):
        return self._topic

    def value(self):
        return self._value


class ClientTimeoutsConfigured(unittest.TestCase):
    """Both ClickHouse client constructors must set a bounded connect/read timeout."""

    def test_storage_client_get_client_passes_timeouts(self):
        captured = {}

        def fake_get_client(**kwargs):
            captured.update(kwargs)
            return mock.Mock()

        with mock.patch.object(storage_client.clickhouse_connect, "get_client", fake_get_client):
            storage_client.ClickHouseClient()._get_client()

        self.assertIn("connect_timeout", captured)
        self.assertIn("send_receive_timeout", captured)
        self.assertGreater(captured["connect_timeout"], 0)
        # The whole point of this fix: must be well under clickhouse_connect's own 300s default.
        self.assertLess(captured["send_receive_timeout"], 300)
        self.assertGreater(captured["send_receive_timeout"], 0)

    def test_ingestion_clickhouse_client_passes_timeouts(self):
        source = inspect.getsource(ingestion_main._clickhouse_client)
        self.assertIn("connect_timeout", source)
        self.assertIn("send_receive_timeout", source)


class InsertDirectToClickHouseRetry(unittest.TestCase):
    """ingestion/main.py's _insert_direct_to_clickhouse() -- now retries before giving up."""

    BASE_EVENT = {
        "event_id": "evt_1", "tenant_id": "nexabank", "event_name": "x.y.z",
        "user_id": "u1", "channel": "web", "timestamp": _NOW_TS, "metadata": {},
    }

    def test_succeeds_immediately_when_clickhouse_is_healthy(self):
        fake = FakeClickHouseClient(fail_times=0)
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake), \
             mock.patch.object(ingestion_main.time, "sleep") as fake_sleep:
            ingestion_main._insert_direct_to_clickhouse(dict(self.BASE_EVENT), "fallback_cloud")
        self.assertEqual(len(fake.inserts), 1)
        fake_sleep.assert_not_called()

    def test_recovers_after_transient_failures_within_the_retry_budget(self):
        fake = FakeClickHouseClient(fail_times=2)  # fails twice, succeeds on the 3rd (final) try
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake), \
             mock.patch.object(ingestion_main.time, "sleep") as fake_sleep:
            ingestion_main._insert_direct_to_clickhouse(dict(self.BASE_EVENT), "fallback_cloud")
        self.assertEqual(len(fake.inserts), 1)
        self.assertEqual(fake_sleep.call_count, 2)  # backoff before attempt 2 and attempt 3

    def test_still_raises_after_exhausting_the_retry_budget(self):
        fake = FakeClickHouseClient(fail_times=999)  # never succeeds
        with mock.patch.object(ingestion_main, "_clickhouse_client", return_value=fake), \
             mock.patch.object(ingestion_main.time, "sleep"):
            with self.assertRaises(ConnectionError):
                ingestion_main._insert_direct_to_clickhouse(dict(self.BASE_EVENT), "fallback_cloud")
        self.assertEqual(fake.inserts, [])

    def test_retry_budget_is_bounded_not_unbounded(self):
        # Regression guard against re-introducing an infinite retry loop on this synchronous,
        # caller-is-waiting request path.
        self.assertLessEqual(ingestion_main.FALLBACK_MAX_RETRIES, 5)
        self.assertGreaterEqual(ingestion_main.FALLBACK_MAX_RETRIES, 1)


class DeadLetterUndecodable(unittest.TestCase):
    """processing/worker.py's _dead_letter_undecodable() -- previously silently dropped."""

    def test_writes_a_replayable_row_with_empty_identity_fields(self):
        fake_client = FakeClickHouseClient()
        msg = FakeMessage(partition=2, offset=17, value=b'{"broken": tru')

        with mock.patch.object(worker.ch_client, "_get_client", return_value=fake_client):
            worker._dead_letter_undecodable(msg, "Expecting value: line 1 column 12")

        self.assertEqual(len(fake_client.inserts), 1)
        table, rows, column_names = fake_client.inserts[0]
        self.assertEqual(table, "feature_intelligence.events_dead_letter")
        row = dict(zip(column_names, rows[0]))
        self.assertEqual(row["event_id"], "")
        self.assertEqual(row["tenant_id"], "")
        self.assertEqual(row["event_name"], "")
        self.assertEqual(row["stage"], "worker_poison")
        self.assertIn("Expecting value", row["error"])
        # The raw payload and Kafka coordinates must be recoverable from the persisted record.
        self.assertIn('"kafka_partition": 2', row["payload"])
        self.assertIn('"kafka_offset": 17', row["payload"])

    def test_survives_a_message_whose_bytes_cannot_be_decoded_at_all(self):
        fake_client = FakeClickHouseClient()
        # Invalid UTF-8 that errors='replace' must not choke on.
        msg = FakeMessage(value=b"\xff\xfe\x00broken")

        with mock.patch.object(worker.ch_client, "_get_client", return_value=fake_client):
            worker._dead_letter_undecodable(msg, "some decode error")

        self.assertEqual(len(fake_client.inserts), 1)  # must not raise

    def test_worker_calls_dead_letter_instead_of_only_logging(self):
        source = inspect.getsource(worker.run_worker)
        self.assertIn("_dead_letter_undecodable", source)


class EventsBodySizeLimit(unittest.TestCase):
    """ingestion/main.py's limit_events_body_size middleware."""

    class FakeURL:
        def __init__(self, path):
            self.path = path

    class FakeRequest:
        def __init__(self, path, method, content_length):
            self.url = EventsBodySizeLimit.FakeURL(path)
            self.method = method
            self._headers = {}
            if content_length is not None:
                self._headers["content-length"] = str(content_length)
            self.headers = self._Headers(self._headers)

        class _Headers:
            def __init__(self, d):
                self._d = d

            def get(self, key):
                return self._d.get(key)

    def _run(self, path, method, content_length):
        request = self.FakeRequest(path, method, content_length)
        call_next_called = {"v": False}

        async def call_next(_req):
            call_next_called["v"] = True
            return "downstream-response"

        response = asyncio.run(ingestion_main.limit_events_body_size(request, call_next))
        return response, call_next_called["v"]

    def test_rejects_oversized_events_body(self):
        response, called = self._run("/events", "POST", ingestion_main.MAX_EVENT_BODY_BYTES + 1)
        self.assertEqual(response.status_code, 413)
        self.assertFalse(called)

    def test_allows_body_within_the_limit(self):
        response, called = self._run("/events", "POST", ingestion_main.MAX_EVENT_BODY_BYTES)
        self.assertEqual(response, "downstream-response")
        self.assertTrue(called)

    def test_ignores_other_paths_regardless_of_size(self):
        response, called = self._run("/health", "POST", ingestion_main.MAX_EVENT_BODY_BYTES * 10)
        self.assertEqual(response, "downstream-response")
        self.assertTrue(called)

    def test_missing_content_length_is_not_rejected_here(self):
        # Documented limitation: a client without Content-Length bypasses this specific check.
        response, called = self._run("/events", "POST", None)
        self.assertEqual(response, "downstream-response")
        self.assertTrue(called)

    def test_malformed_content_length_does_not_crash_the_middleware(self):
        response, called = self._run("/events", "POST", "not-a-number")
        self.assertEqual(response, "downstream-response")
        self.assertTrue(called)


if __name__ == "__main__":
    unittest.main()
