"""
Tests for Phase F (docs/audits/clickhouse_pipeline_implementation_phases_defg_prompt.md):

  - Item 5: processing/worker.py's on_commit callback / _log_commit_result -- a failed async
    offset commit must be logged loudly (partition, offset, error) and flagged for retry, never
    swallowed silently.
  - Item 6: processing/worker.py's batch-mutation bug -- a batch that failed to flush must be
    retried as exactly the set of messages it failed with, not a superset that grew while it was
    stuck. Covers both the pure gating predicate (_should_poll) and an end-to-end simulation of
    flush_batch() across a multi-call sink outage, confirming the batch and its
    insert_deduplication_token stay byte-identical/stable across every retry.

All tests mock ch_client / time.sleep -- no live ClickHouse or Kafka connection required.

Run from the repo root, in an environment with this project's actual dependencies installed
(confluent-kafka, clickhouse-connect -- e.g. inside the processor-worker container):

    python -m unittest tests.test_worker_commit_and_retry -v
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import processing.worker as worker  # noqa: E402


class DeduplicationToken(unittest.TestCase):
    """_compute_deduplication_token -- item 6 bullet 2."""

    def test_same_ordered_ids_hash_identically(self):
        a = worker._compute_deduplication_token(["evt_1", "evt_2", "evt_3"])
        b = worker._compute_deduplication_token(["evt_1", "evt_2", "evt_3"])
        self.assertEqual(a, b)

    def test_order_changes_the_token(self):
        # Deliberate per the task's own wording ("the batch's OWN CONTENT", and item 6's framing
        # that a retried batch must be the same set *and* the same batch -- order is part of
        # what "the same insert" means here, not incidental).
        a = worker._compute_deduplication_token(["evt_1", "evt_2"])
        b = worker._compute_deduplication_token(["evt_2", "evt_1"])
        self.assertNotEqual(a, b)

    def test_content_changes_the_token(self):
        a = worker._compute_deduplication_token(["evt_1", "evt_2"])
        b = worker._compute_deduplication_token(["evt_1", "evt_3"])
        self.assertNotEqual(a, b)

    def test_deterministic_across_repeated_calls(self):
        ids = ["evt_%d" % i for i in range(50)]
        tokens = {worker._compute_deduplication_token(list(ids)) for _ in range(5)}
        self.assertEqual(len(tokens), 1)


class ShouldPoll(unittest.TestCase):
    """_should_poll -- the actual gate that fixes item 6 bullet 1's batch-mutation bug."""

    def test_polls_when_batch_has_room_and_not_stuck(self):
        self.assertTrue(worker._should_poll(0, False))
        self.assertTrue(worker._should_poll(worker.BATCH_SIZE - 1, False))

    def test_does_not_poll_when_batch_is_full(self):
        self.assertFalse(worker._should_poll(worker.BATCH_SIZE, False))

    def test_does_not_poll_when_batch_is_stuck_regardless_of_size(self):
        # This is the crux of the bug: a batch that failed via the *time*-based trigger is small
        # (well under BATCH_SIZE), so the old size-only gate let new messages keep merging into
        # it while it was awaiting retry.
        self.assertFalse(worker._should_poll(0, True))
        self.assertFalse(worker._should_poll(1, True))
        self.assertFalse(worker._should_poll(worker.BATCH_SIZE - 1, True))


class CommitResultLogging(unittest.TestCase):
    """_log_commit_result -- item 5's on_commit callback logic."""

    def test_success_is_not_flagged(self):
        self.assertFalse(worker._log_commit_result(None, []))

    def test_failure_is_flagged_and_logged_with_context(self):
        class FakeKafkaError:
            def __str__(self):
                return "Broker: Not coordinator"

        with self.assertLogs(worker.logger, level="ERROR") as cm:
            result = worker._log_commit_result(FakeKafkaError(), ["nexabank-events[3]@1042"])

        self.assertTrue(result)
        self.assertIn("Not coordinator", cm.output[0])
        self.assertIn("nexabank-events[3]@1042", cm.output[0])


class GetConsumerRegistersOnCommit(unittest.TestCase):
    """get_consumer -- confluent-kafka only accepts on_commit as a construction-time config
    callback (confirmed against the installed confluent-kafka 2.4.0's Consumer.commit()
    signature, which takes no callback parameter), so this must be threaded through conf, not
    passed to commit() itself."""

    def test_on_commit_reaches_the_consumer_config(self):
        captured_conf = {}

        class FakeConsumer:
            def __init__(self, conf):
                captured_conf.update(conf)

        def sentinel_callback(err, partitions):
            pass

        with mock.patch.object(worker, "Consumer", FakeConsumer):
            worker.get_consumer(on_commit=sentinel_callback)

        self.assertIs(captured_conf.get("on_commit"), sentinel_callback)

    def test_omitting_on_commit_does_not_add_the_key(self):
        captured_conf = {}

        class FakeConsumer:
            def __init__(self, conf):
                captured_conf.update(conf)

        with mock.patch.object(worker, "Consumer", FakeConsumer):
            worker.get_consumer()

        self.assertNotIn("on_commit", captured_conf)


class FlushBatchRetryDeterminism(unittest.TestCase):
    """End-to-end simulation of item 6: a genuine sink outage spanning multiple flush_batch()
    calls (the real shape of run_worker()'s retry loop), asserting the batch and its dedup
    token are stable throughout, then resolve cleanly on recovery."""

    def test_batch_and_token_are_stable_across_a_multi_call_outage_then_recover(self):
        sink_down = {"v": True}
        calls = []  # (event_ids, token) per ch_client.insert_events call

        def fake_insert_events(batch, insert_deduplication_token=None):
            calls.append(([r["event_id"] for r in batch], insert_deduplication_token))
            if sink_down["v"]:
                raise ConnectionError("sink down")

        def fake_sink_is_reachable():
            return not sink_down["v"]

        with mock.patch.object(worker.ch_client, "insert_events", side_effect=fake_insert_events), \
             mock.patch.object(worker, "_sink_is_reachable", side_effect=fake_sink_is_reachable), \
             mock.patch.object(worker.time, "sleep", return_value=None):
            batch = [{"event_id": "evt_1"}, {"event_id": "evt_2"}, {"event_id": "evt_3"}]

            # Call 1: sink down -> held for replay, not dead-lettered, not lost.
            self.assertFalse(worker.flush_batch(batch))
            # The real run_worker loop must not poll while this is true (asserted separately in
            # ShouldPoll above) -- here we assert the consequence: nothing mutates `batch`.
            snapshot = list(batch)

            # Call 2: still down, retried with the identical batch.
            self.assertFalse(worker.flush_batch(batch))
            self.assertEqual(batch, snapshot)

            # Sink recovers.
            sink_down["v"] = False
            self.assertTrue(worker.flush_batch(batch))
            self.assertEqual(batch, snapshot)  # still nothing merged in, even on success

        # Every whole-batch attempt (3 event_ids) must carry the SAME token throughout the
        # entire outage and into the successful call -- the token is a pure function of
        # content, and content never changed.
        whole_batch_tokens = {t for ids, t in calls if len(ids) == 3}
        self.assertEqual(len(whole_batch_tokens), 1)
        self.assertNotIn(None, whole_batch_tokens)

        expected_token = worker._compute_deduplication_token(["evt_1", "evt_2", "evt_3"])
        self.assertEqual(list(whole_batch_tokens)[0], expected_token)

    def test_isolation_fallback_still_recovers_good_rows_when_only_some_are_poison(self):
        # Regression guard: item 6/5's changes must not disturb the pre-existing poison-row
        # isolation behavior (Phase 3 proposal). One malformed row must not block the rest.
        def fake_insert_events(batch, insert_deduplication_token=None):
            if len(batch) > 1:
                raise ValueError("bad row in batch")
            if batch[0]["event_id"] == "evt_bad":
                raise ValueError("malformed")

        with mock.patch.object(worker.ch_client, "insert_events", side_effect=fake_insert_events), \
             mock.patch.object(worker.time, "sleep", return_value=None), \
             mock.patch.object(worker, "_dead_letter") as fake_dead_letter:
            batch = [{"event_id": "evt_good"}, {"event_id": "evt_bad"}]
            result = worker.flush_batch(batch)

        self.assertTrue(result)
        fake_dead_letter.assert_called_once()
        (dead_records, _err), _ = fake_dead_letter.call_args
        self.assertEqual(dead_records[0]["event_id"], "evt_bad")


if __name__ == "__main__":
    unittest.main()
