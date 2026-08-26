import sys
import os
import json
import logging
from confluent_kafka import Consumer, KafkaError, KafkaException
import time

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.config import settings
from storage.client import ch_client

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


def _dead_letter(records, error: str) -> None:
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
            ]
            for r in records
        ]
        ch_client._get_client().insert(
            "feature_intelligence.events_dead_letter",
            rows,
            column_names=["event_id", "tenant_id", "event_name", "payload", "error"],
        )
        logger.error("Dead-lettered %d unrecoverable event(s): %s", len(rows), error[:200])
    except Exception as exc:
        # Losing the DLQ write is bad but must not stall the pipeline; the payload is still
        # in Kafka until the offset commits, and the offset only commits on a clean flush.
        logger.critical("Dead-letter insert FAILED for %d event(s): %s", len(records), exc)


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
    for attempt in range(1, MAX_RETRIES_BEFORE_SPLIT + 1):
        try:
            ch_client.insert_events(batch)
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
            for record, err in poison:
                _dead_letter([record], err)
            return True
        logger.error("All %d rows failed and ClickHouse is unreachable -- holding for replay.", len(batch))
        return False

    for record, err in poison:
        _dead_letter([record], err)
    logger.info(
        "Recovered %d/%d rows; %d dead-lettered.",
        len(batch) - len(poison), len(batch), len(poison),
    )
    return True

def get_consumer():
    """Build and return a Kafka consumer."""
    conf = {
        'bootstrap.servers': settings.KAFKA_BROKER_URL,
        'group.id': 'feature-processor-group',
        'auto.offset.reset': 'earliest',
        'enable.auto.commit': False  # We commit manually after DB insert
    }
    return Consumer(conf)

def run_worker():
    """Main loop to consume from Kafka and write to ClickHouse."""
    consumer = get_consumer()
    consumer.subscribe([settings.KAFKA_TOPIC_EVENTS])
    
    logger.info("Worker started, waiting for events...")
    
    batch = []
    last_flush_time = time.time()
    
    try:
        while True:
            # Backpressure: while a batch is stuck we must not keep accumulating, or a sink
            # outage becomes an OOM. Kafka is the buffer -- that is what it is for.
            msg = None if len(batch) >= BATCH_SIZE else consumer.poll(timeout=1.0)
            if msg is None and len(batch) >= BATCH_SIZE:
                time.sleep(1.0)
            
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
                        batch.append(event_data)
                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to decode message: {e}")

            now = time.time()
            # Flush if batch limit is reached or time interval passed
            if len(batch) >= BATCH_SIZE or (now - last_flush_time >= FLUSH_INTERVAL and len(batch) > 0):
                logger.info(f"Flushing batch of {len(batch)} events to ClickHouse.")
                if flush_batch(batch):
                    # Offsets commit only after the batch is durably accounted for. Delivery
                    # stays at-least-once, which is safe because every reader counts
                    # uniqExact(event_id) rather than rows -- docs/DATABASE.md FOUNDATION-1/4.
                    consumer.commit(asynchronous=True)
                    batch.clear()
                    last_flush_time = now
                else:
                    # Sink is down. Keep the batch, do NOT commit, and stop pulling more
                    # messages until it recovers -- Kafka holds them meanwhile.
                    logger.error("Holding %d events; pausing consumption until the sink recovers.", len(batch))
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
