import sys
import os
import json
import logging
import hashlib
from confluent_kafka import Consumer, KafkaError, KafkaException
import time

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from warehouse.config import settings
from warehouse.client import ch_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Config
BATCH_SIZE = 500
FLUSH_INTERVAL = 2.0  # seconds

# Retry/backpressure limits.
#
# The old loop, on insert failure, did `continue` -- skipping both batch.clear() and the
# last_flush_time update. So it retried on every poll with no delay AND kept appending newly
# polled messages to the same failing batch. A ClickHouse outage was therefore an unbounded
# memory leak plus a hot spin loop. Stop consuming while a flush is failing instead: Kafka is
# the buffer, which is the entire reason it is in the pipeline.
MAX_RETRIES_BEFORE_SPLIT = 3   # after this many whole-batch failures, isolate the bad rows
RETRY_BACKOFF_BASE_S = 1.0
RETRY_BACKOFF_MAX_S = 30.0


def _dead_letter(records, error: str) -> bool:
    """Park rows that fail on their own so one bad event cannot block every good one."""
    if not records:
        return
    try:
        rows = [
            [
                str(r.get("event_id", "") or ""),
                str(r.get("tenant_id", "") or ""),
                str(r.get("event_name", "") or ""),
                json.dumps(r, default=str),
                error[:2000],
                # Distinguishes this writer from ingestion/main.py's pre-Kafka validation-failure
                # writer (stage='ingest_validation') now that both insert into this table --
                # Phase 3 proposal 4c (docs/audits/clickhouse_pipeline_audit_phase3_proposals.md).
                "worker_poison",
            ]
            for r in records
        ]
        ch_client._get_client().insert(
            "feature_intelligence.events_dead_letter",
            rows,
            column_names=["event_id", "tenant_id", "event_name", "payload", "error", "stage"],
        )
        logger.error("Dead-lettered %d unrecoverable event(s): %s", len(rows), error[:200])
        return True
    except Exception as exc:
        # Return False so the caller can hold the offset. Previously this swallowed the failure
        # and flush_batch still returned True, so the offset committed and the payload was lost
        # permanently -- the opposite of what the comment claimed.
        logger.critical("Dead-letter insert FAILED for %d event(s): %s", len(records), exc)
        return False


def _dead_letter_undecodable(msg, error: str) -> bool:
    """Dead-letter a Kafka message that failed to become JSON at all (Phase G follow-up).

    Previously this case was only logged and the message silently dropped from the batch --
    the one asymmetry against _dead_letter() below, which properly persists a replayable record
    for every OTHER poison-row case. A message that never became a dict has no event_id/
    tenant_id/event_name to report, so those are empty; the raw bytes (decoded with
    errors='replace' so a second decode failure can't happen here) go into the payload instead,
    alongside the Kafka delivery coordinates, so this is still cross-referenceable by
    scripts/reconcile_kafka_offsets.py the same way every other worker_poison row is.
    """
    try:
        raw = msg.value()
        raw_text = raw.decode("utf-8", errors="replace") if raw is not None else ""
    except Exception:
        raw_text = repr(msg.value())
    record = {
        "event_id": "",
        "tenant_id": "",
        "event_name": "",
        "raw_payload": raw_text,
        "kafka_partition": msg.partition(),
        "kafka_offset": msg.offset(),
        "kafka_topic": msg.topic(),
    }
    return _dead_letter([record], error)


def _attach_kafka_metadata(event_data: dict, msg) -> dict:
    """Attach Kafka's own delivery metadata to a consumed message before it enters the batch.

    Phase 3 proposal 2 (docs/audits/clickhouse_pipeline_audit_phase3_proposals.md). Attaching it
    to `event_data` itself (rather than tracking it out-of-band) means it rides along into
    events_dead_letter's `payload` too if this row is later isolated as a poison row -- the
    reconciliation job (scripts/reconcile_kafka_offsets.py) can then cross-reference a DLQ entry
    against a specific partition/offset directly. Pulled out as its own function so it's
    unit-testable against a fake message object without a live broker.
    """
    event_data["kafka_partition"] = msg.partition()
    event_data["kafka_offset"] = msg.offset()
    event_data["kafka_topic"] = msg.topic()
    event_data["ingest_path"] = "kafka"
    return event_data


def _compute_deduplication_token(event_ids: list) -> str:
    """Deterministic token for a batch's exact ordered event_id sequence.

    Phase F item 6 bullet 2 (docs/audits/clickhouse_pipeline_implementation_phases_defg_prompt.md).
    Passed as ClickHouse's `insert_deduplication_token` insert setting so a retried insert of the
    *same* logical batch (the network ack was lost but the insert actually landed) is caught by
    ClickHouse's own insert-level dedup -- a backstop behind (not a substitute for) the
    batch-identity fix in run_worker()/flush_batch() below, per this item's own framing: the
    token only helps once the batch it describes is guaranteed stable across retries. Hashing the
    ordered event_ids (not full row content) is cheap and keys on the same identity the rest of
    this pipeline already uses everywhere (DEDUP_EVENT_KEY in api/main.py,
    mv_daily_feature_usage's rollup key).

    LOAD-BEARING CAVEAT, confirmed live against the actual installed ClickHouse (24.3.18.7), not
    assumed: this token is currently a NO-OP on events_raw. `insert_deduplicate=1` is
    ClickHouse's session default, but the mechanism it gates for a table that is NOT a
    Replicated*MergeTree (events_raw is a plain ReplacingMergeTree here) is controlled by the
    table-level `non_replicated_deduplication_window` MergeTree setting -- confirmed via
    `SELECT * FROM system.merge_tree_settings WHERE name = 'non_replicated_deduplication_window'`
    to be 0 (disabled) on the live table. With that window at 0, ClickHouse accepts and discards
    this token without checking it against anything; no hash is retained to compare a retry
    against. Enabling it is `ALTER TABLE events_raw MODIFY SETTING
    non_replicated_deduplication_window = N` -- DDL, and explicitly out of scope for this
    (code-only) phase. Implemented now so the only remaining step, once that DDL is proposed and
    approved separately, is the ALTER itself, not another code deploy.
    """
    return hashlib.sha256("|".join(event_ids).encode("utf-8")).hexdigest()


def _log_commit_result(err, partitions) -> bool:
    """Log an offset-commit outcome; return True if it failed (and should be retried).

    Phase F item 5 (docs/audits/clickhouse_pipeline_implementation_phases_defg_prompt.md): the
    main loop's `consumer.commit(asynchronous=True)` previously had no `on_commit` callback, so
    a failed async commit was swallowed silently -- the confluent-kafka client reports it only
    through this callback, never as an exception on the `commit()` call itself. Pulled out as a
    pure function (rather than inlined in the closure below) so the logging/decision logic is
    unit-testable without a live broker or a real Consumer object.

    A failed commit is not a lost-data event: the rows are already durably in ClickHouse by the
    time commit() is called (flush_batch() only reaches this point after a successful insert),
    so the only consequence of a stuck offset is redelivery on the next rebalance/restart, which
    every reader already absorbs via uniqExact(event_id)/DEDUP_EVENT_KEY (docs/DATABASE.md
    FOUNDATION-1/4). This must still never be silent, though -- an offset that never commits
    means unbounded reprocessing and a Kafka consumer group that never advances, which is worth
    knowing about even though it isn't a correctness emergency.
    """
    if err is not None:
        logger.error(
            "Async offset commit failed (partitions=%s): %s. Rows for this batch are already "
            "durably in ClickHouse -- only the commit acknowledgment failed. Retrying "
            "synchronously on the next resolved flush rather than leaving this unresolved.",
            partitions, err,
        )
        return True
    return False


def _should_poll(batch_len: int, batch_stuck: bool) -> bool:
    """Whether the main loop should pull a new message from Kafka this iteration.

    False when the batch is already at capacity (pre-existing backpressure) OR when the current
    batch already failed to flush and is awaiting retry -- Phase F item 6 bullet 1's fix. Without
    the second condition, a batch that failed via the *time*-based flush trigger (small batch,
    well under BATCH_SIZE) kept accepting newly polled messages while its own retry was still
    pending, so the batch retried was never byte-identical to the one that failed -- defeating
    both this worker's own retry-identity guarantee and any block-level dedup token keyed on it.
    Kafka already holds every message this consumer hasn't committed; pausing consumption here
    costs nothing; it is exactly what "Kafka is the buffer" (see module-level comment above)
    was already supposed to mean.
    """
    return batch_len < BATCH_SIZE and not batch_stuck


def _sink_is_reachable() -> bool:
    """Cheapest possible liveness probe, to tell a poison batch from a sink outage."""
    try:
        ch_client._get_client().query("SELECT 1")
        return True
    except Exception:
        return False


def flush_batch(batch: list) -> bool:
    """Insert a batch, isolating poison rows if it repeatedly fails.

    Returns True when the batch is fully accounted for (inserted or dead-lettered) and the
    Kafka offset may be committed.
    """
    # Computed once per call, not per attempt: `batch` itself never mutates across this
    # function's own internal retries (they're synchronous, single-threaded, no poll() runs
    # between them) -- the same token is therefore correct for every attempt inside this call,
    # and (once item 6 bullet 1's outer-loop freeze is in effect) for every separate call this
    # same stuck batch triggers too, since its content is unchanged until it resolves.
    dedup_token = _compute_deduplication_token(
        [str(r.get("event_id", "") or "") for r in batch]
    )
    for attempt in range(1, MAX_RETRIES_BEFORE_SPLIT + 1):
        try:
            ch_client.insert_events(batch, insert_deduplication_token=dedup_token)
            return True
        except Exception as exc:
            backoff = min(RETRY_BACKOFF_BASE_S * (2 ** (attempt - 1)), RETRY_BACKOFF_MAX_S)
            logger.error(
                "Batch insert failed (attempt %d/%d): %s. Retrying in %.1fs",
                attempt, MAX_RETRIES_BEFORE_SPLIT, exc, backoff,
            )
            time.sleep(backoff)

    # Still failing as a batch. Distinguish "ClickHouse is down" (retry forever, do not lose
    # data) from "one row is poison" (isolate it) by inserting rows individually.
    logger.warning("Batch still failing after %d attempts; isolating rows.", MAX_RETRIES_BEFORE_SPLIT)
    poison = []
    for record in batch:
        try:
            ch_client.insert_events([record])
        except Exception as exc:
            poison.append((record, str(exc)))

    if len(poison) == len(batch):
        # Every row failed. Two very different causes look identical here: the sink is down
        # (hold and replay -- never lose data), or every row in this batch is genuinely
        # malformed (dead-letter them, or a single poison message at the head of an idle
        # partition blocks the pipeline until unrelated traffic happens to arrive). Ask
        # ClickHouse directly instead of guessing.
        if _sink_is_reachable():
            logger.error(
                "All %d rows failed but ClickHouse is reachable -- dead-lettering the batch.",
                len(batch),
            )
            dlq_ok = all(_dead_letter([record], err) for record, err in list(poison))
            if not dlq_ok:
                logger.error("Dead-letter write failed -- holding the offset for replay.")
            return dlq_ok
        logger.error("All %d rows failed and ClickHouse is unreachable -- holding for replay.", len(batch))
        return False

    dlq_ok = all(_dead_letter([record], err) for record, err in list(poison))
    logger.info(
        "Recovered %d/%d rows; %d dead-lettered.",
        len(batch) - len(poison), len(batch), len(poison),
    )
    if not dlq_ok:
        # The good rows are already in ClickHouse and are idempotent under replay
        # (ReplacingMergeTree on event_id), so replaying the batch is safe; losing the poison
        # record is not.
        logger.error("Dead-letter write failed -- holding the offset for replay.")
    return dlq_ok

def get_consumer(on_commit=None):
    """Build and return a Kafka consumer.

    `on_commit` (Phase F item 5): registered at construction time -- confluent-kafka only
    accepts this as a consumer config callback, not as a per-call `commit()` argument (confirmed
    against the installed confluent-kafka 2.4.0's actual `Consumer.commit()` signature, which
    takes no callback parameter). It fires for offset-commit completions dispatched while
    servicing the consumer's event queue (poll()/commit()/close()), for both the main loop's
    async commits and (as an unavoidable side effect of registering one callback for the whole
    consumer) possibly also on_revoke's synchronous one -- see run_worker()'s own comment on why
    that overlap is harmless rather than something actively relied on.
    """
    conf = {
        'bootstrap.servers': settings.KAFKA_BROKER_URL,
        'group.id': 'feature-processor-group',
        'auto.offset.reset': 'earliest',
        'enable.auto.commit': False,  # We commit manually after DB insert
        # P3-4. While batch_stuck we used to stop calling poll() entirely. librdkafka enforces
        # max.poll.interval.ms (default 300000), so a sink outage over ~5 minutes got the
        # consumer evicted from the group -- and because on_revoke is dispatched FROM poll(),
        # the handler could not run cleanly either. We now keep polling and use pause()/resume()
        # instead, which is what they are for. Stated explicitly rather than inherited.
        'max.poll.interval.ms': 600000,
        'session.timeout.ms': 45000,
        'heartbeat.interval.ms': 15000,
    }
    if on_commit is not None:
        conf['on_commit'] = on_commit
    return Consumer(conf)

def run_worker():
    """Main loop to consume from Kafka and write to ClickHouse."""
    # `commit_retry_needed` is set by on_commit (Phase F item 5) when an async commit fails, and
    # consumed by the main loop below -- deliberately NOT retried from inside on_commit itself.
    # on_commit is dispatched synchronously from within whatever consumer call is currently
    # servicing the event queue (poll()/commit()/close()); calling consumer.commit() again from
    # inside that same callback would be a reentrant call into the same librdkafka client while
    # it's mid-dispatch. Routing the retry through a flag the main loop checks on its own next
    # turn avoids that risk entirely for one extra flush cycle of latency, which is immaterial
    # given a failed commit is an acknowledgment problem, not a data-loss one (see
    # _log_commit_result's docstring).
    commit_retry_needed = False

    def on_commit(err, partitions):
        nonlocal commit_retry_needed
        if _log_commit_result(err, partitions):
            commit_retry_needed = True

    consumer = get_consumer(on_commit=on_commit)

    batch = []
    # P3-5: set by a dead-letter as well as by a successful insert, so an offset is never stranded.
    dirty = False
    # P3-4: tracks whether the assignment is currently resumed, so we only toggle on change.
    polling_active = True
    last_flush_time = time.time()
    # True while `batch` failed to flush and is awaiting retry -- Phase F item 6 bullet 1.
    # Gates both new-message polling (_should_poll) and forces an immediate retry attempt below,
    # so a stuck batch is retried as exactly the set of messages it failed with, never a superset
    # that grew while it waited.
    batch_stuck = False

    # Partition-rebalance handlers.
    #
    # Without these, a rebalance mid-batch has no way to flush or discard the in-flight batch
    # before this consumer loses the partitions it was buffering for: the flat `batch` list has
    # no per-partition/offset attribution, so the safe move on a revoke is to account for
    # everything currently held -- not just the revoked partitions' share -- before the
    # assignment changes underneath it. `on_revoke` runs synchronously as part of the rebalance
    # protocol, so this flush must complete (or be abandoned) before returning.
    def on_revoke(consumer, partitions):
        nonlocal last_flush_time, batch_stuck
        logger.warning("Partitions revoked (%s); flushing in-flight batch before rebalance.", partitions)
        if batch:
            if flush_batch(batch):
                # Commit synchronously here, not asynchronously like the main loop: the
                # rebalance is about to hand these partitions to someone else (maybe this
                # consumer on reassignment, maybe another), so the commit must land before
                # control returns to the group coordinator or the newly-inserted rows can be
                # redelivered and reprocessed unnecessarily. Kept fully independent of
                # commit_retry_needed/on_commit's retry path above -- Phase F item 5 bullet 3 --
                # this is its own try/except with its own, already-synchronous, fallback.
                try:
                    consumer.commit(asynchronous=False)
                except Exception as exc:
                    logger.error("Commit during partition revoke failed: %s", exc)
            else:
                # Sink is down. Do NOT commit -- these messages stay uncommitted in Kafka and
                # will be redelivered (to this consumer on reassignment, or to whichever
                # instance picks up the partitions next), which is safe because reads dedup on
                # event_id. Dropping them from the local Python list here does not lose data;
                # Kafka is still holding them at their un-committed offsets.
                logger.error(
                    "Sink unavailable during partition revoke; %d event(s) remain uncommitted "
                    "in Kafka and will be redelivered to whichever consumer receives these "
                    "partitions next.",
                    len(batch),
                )
            batch.clear()
            batch_stuck = False
            last_flush_time = time.time()

    def on_assign(consumer, partitions):
        logger.info("Partitions assigned: %s", partitions)

    consumer.subscribe([settings.KAFKA_TOPIC_EVENTS], on_assign=on_assign, on_revoke=on_revoke)

    logger.info("Worker started, waiting for events...")

    try:
        while True:
            # Backpressure: while a batch is at capacity OR stuck retrying a failed flush, we
            # must not keep polling -- either would let newly polled messages queue behind a
            # batch that hasn't resolved yet (item 6), or turn a sink outage into unbounded
            # growth (the pre-existing size-based case). Kafka is the buffer -- that is what it
            # is for.
            # P3-4. Always poll -- that is what keeps the consumer in the group and lets
            # on_revoke be dispatched. Backpressure is applied by pausing the ASSIGNMENT, not
            # by skipping poll(), which used to get us evicted after max.poll.interval.ms.
            want_messages = _should_poll(len(batch), batch_stuck)
            if want_messages != polling_active:
                try:
                    assignment = consumer.assignment()
                    if assignment:
                        if want_messages:
                            consumer.resume(assignment)
                        else:
                            consumer.pause(assignment)
                    polling_active = want_messages
                except Exception as exc:
                    logger.warning("pause/resume failed: %s", exc)
            msg = consumer.poll(timeout=1.0)

            if msg is not None:
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        # End of partition event
                        pass
                    else:
                        raise KafkaException(msg.error())
                else:
                    try:
                        event_data = json.loads(msg.value().decode('utf-8'))
                        event_data = _attach_kafka_metadata(event_data, msg)
                        batch.append(event_data)
                    except (json.JSONDecodeError, UnicodeDecodeError,
                            AttributeError, TypeError) as e:
                        # NOT just JSONDecodeError. `.decode()` raises UnicodeDecodeError on
                        # invalid bytes, and `msg.value()` is None for a tombstone, which makes
                        # `.decode` an AttributeError. Neither is a JSONDecodeError, and neither
                        # is caught by run_worker -- so one bad byte killed the process, and
                        # because the offset had not committed, restart replayed the same
                        # message forever.
                        logger.error(f"Failed to decode message: {type(e).__name__}: {e}")
                        # P3-5. The offset for an undecodable message must still commit. It is
                        # not appended to `batch`, and the flush condition requires len(batch)>0,
                        # so on an otherwise idle partition nothing committed -- and on restart
                        # the same message was redelivered and dead-lettered again, forever.
                        # Phase G follow-up: previously dropped silently. Dead-letter it first
                        # so "handled" is actually true.
                        #
                        # Only mark the offset committable if that write SUCCEEDED. P3-5 is why
                        # a decodable-but-poison message must still commit (else one bad message
                        # on an idle partition blocks the partition forever) -- but that argument
                        # holds only when the payload is safely in the DLQ. If the DLQ write
                        # failed, committing would destroy the only remaining copy, so hold and
                        # let the redelivery retry once ClickHouse is back.
                        if _dead_letter_undecodable(msg, str(e)):
                            dirty = True
                        else:
                            logger.error(
                                "Undecodable message could not be dead-lettered; holding "
                                "offset (partition=%s offset=%s).",
                                msg.partition(), msg.offset())

            now = time.time()
            # Flush if batch limit is reached, time interval passed, or a previous flush of this
            # exact batch is still owed a retry (batch_stuck) -- retried every loop pass while
            # stuck since polling is paused, so this doesn't wait out a stale FLUSH_INTERVAL
            # window; flush_batch()'s own internal backoff (up to ~7s per call) is what actually
            # paces the retries.
            if dirty and not batch and (now - last_flush_time >= FLUSH_INTERVAL):
                # Nothing to insert, but an offset is owed a commit (see P3-5 above).
                try:
                    consumer.commit(asynchronous=False)
                    logger.info("Committed offsets for dead-lettered message(s) with empty batch.")
                except Exception as exc:
                    logger.error("Commit after dead-letter failed: %s", exc)
                dirty = False
                last_flush_time = now

            if len(batch) >= BATCH_SIZE or batch_stuck or (now - last_flush_time >= FLUSH_INTERVAL and len(batch) > 0):
                logger.info(f"Flushing batch of {len(batch)} events to ClickHouse.")
                if flush_batch(batch):
                    batch_stuck = False
                    dirty = False
                    # Offsets commit only after the batch is durably accounted for. Delivery
                    # stays at-least-once, which is safe because every reader counts
                    # uniqExact(event_id) rather than rows -- docs/DATABASE.md FOUNDATION-1/4.
                    try:
                        if commit_retry_needed:
                            # A prior async commit failed silently upstream; get a definitive
                            # resolution now instead of firing another async commit into the
                            # same uncertainty.
                            consumer.commit(asynchronous=False)
                            logger.info("Synchronous retry of a previously failed commit succeeded.")
                            commit_retry_needed = False
                        else:
                            consumer.commit(asynchronous=True)
                    except Exception as exc:
                        logger.critical(
                            "Synchronous retry of a failed commit ALSO failed: %s. Offsets "
                            "remain uncommitted -- rows are already safe in ClickHouse and will "
                            "be redelivered (absorbed by event_id dedup) on the next successful "
                            "commit, rebalance, or restart.",
                            exc,
                        )
                        commit_retry_needed = True
                    batch.clear()
                    last_flush_time = now
                else:
                    # Sink is down. Keep the batch, do NOT commit, and stop pulling more
                    # messages until it recovers -- Kafka holds them meanwhile. batch_stuck=True
                    # is what makes the *next* iteration retry this exact batch instead of
                    # accepting more messages into it (item 6 bullet 1).
                    batch_stuck = True
                    logger.error(
                        "Holding %d events; batch frozen and consumption paused until the sink recovers.",
                        len(batch),
                    )
                    last_flush_time = now

    except KeyboardInterrupt:
        logger.info("Worker gracefully shutting down...")
    except KafkaException as e:
        logger.critical(f"Kafka exception: {e}")
    finally:
        # Commit any stragglers if needed, though they aren't inserted. Best to let them be reprocessed.
        consumer.close()
        logger.info("Kafka consumer closed.")

if __name__ == "__main__":
    run_worker()
