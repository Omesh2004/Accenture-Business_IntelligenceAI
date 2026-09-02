import clickhouse_connect
import logging
import time
import json
from typing import List, Dict, Any, Optional
import os
import sys
from datetime import datetime, timezone

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from warehouse.config import settings

logger = logging.getLogger(__name__)

class ClickHouseClient:
    def __init__(self):
        self.client = None

    def _get_client(self):
        """Get a fresh ClickHouse client for thread-safe concurrent queries.

        `connect_timeout`/`send_receive_timeout` (Phase G follow-up, discovered live during
        Phase G's real ClickHouse-outage simulation): previously unset, which meant
        `clickhouse_connect`'s own default `send_receive_timeout=300` applied -- a real network
        stall (as opposed to a fast connection-refused) left `insert_events()` blocked for up to
        5 minutes on its FIRST attempt, never reaching `pipeline/worker.py`'s
        retry/backoff/`batch_stuck` logic at all (that logic is correct, per Phase F -- it just
        never got a chance to run). `connect_timeout=10` matches clickhouse_connect's own
        default, stated explicitly rather than relied on implicitly, consistent with this
        codebase's style elsewhere. `send_receive_timeout=30` is the actual fix: long enough to
        tolerate real ClickHouse latency under load, short enough that a genuine outage surfaces
        well within flush_batch()'s own per-attempt backoff instead of blocking the whole
        pipeline behind one hung call.
        """
        return clickhouse_connect.get_client(
            host=settings.CLICKHOUSE_HOST,
            port=settings.CLICKHOUSE_PORT,
            username=settings.CLICKHOUSE_USER,
            password=settings.CLICKHOUSE_PASSWORD,
            database=settings.CLICKHOUSE_DATABASE,
            connect_timeout=10,
            send_receive_timeout=30,
        )

    def connect(self, retries=5):
        """Establish connection to ClickHouse, retrying if necessary."""
        for i in range(retries):
            try:
                self.client = self._get_client()
                logger.info("Connected to ClickHouse successfully.")
                return
            except Exception as e:
                logger.warning(f"Failed to connect to ClickHouse (Attempt {i+1}/{retries}): {e}")
                time.sleep(2)
        
        raise ConnectionError("Could not connect to ClickHouse after retries.")

    def insert_events(
        self,
        events: List[Dict[str, Any]],
        insert_deduplication_token: Optional[str] = None,
    ):
        """Bulk insert raw events into `bronze.events` -- verbatim, uncanonicalised.

        `bronze.events` is a plain MergeTree (never Replacing): a duplicate arriving twice is
        the evidence the Trust Gate reads. Silver deduplicates by event_id and canonicalises the
        name; this writer does neither.

        Per-event keys read from the wire dict:
          - `_raw`            the exact request body ingestion received, verbatim JSON. '' if a
                              caller genuinely had no body.
          - `kafka_partition` / `kafka_offset` / `kafka_topic` / `ingest_path`
                              set by pipeline/worker.py's _attach_kafka_metadata for the
                              Kafka-consumed path; sentinels (-1 / '' ) otherwise. This function
                              never assumes 'kafka' for a caller that did not say so.

        `insert_deduplication_token`: an optional deterministic token for ClickHouse's own
        insert-level block dedup, so a retried insert of the same logical batch (network ack
        lost, insert already landed) is caught by ClickHouse. Only pipeline/worker.py passes one.
        """
        client = self._get_client()

        if not events:
            return

        # _ingested_at is insert time, not event time -- one "now" for this batch, not derived
        # from each event's own (possibly backdated) timestamp.
        now = datetime.now(timezone.utc).replace(tzinfo=None)

        data = [
            [
                e.get('event_id', ''),
                e.get('session_id') or e.get('metadata', {}).get('session_id', ''),
                e['tenant_id'],
                e['event_name'],
                e['user_id'],
                e['channel'],
                # Naive UTC to match the DateTime column.
                datetime.fromtimestamp(e['timestamp'], timezone.utc).replace(tzinfo=None),
                json.dumps(e.get('metadata', {}), ensure_ascii=True),
                str(e.get('_raw', '') or ''),
                str(e.get('_source_id', 'clickstream') or 'clickstream'),
                int(e.get('kafka_partition', -1)),
                int(e.get('kafka_offset', -1)),
                str(e.get('kafka_topic', '') or ''),
                str(e.get('ingest_path', '') or ''),
                now,        # _ingested_at
            ]
            for e in events
        ]

        insert_kwargs = {}
        if insert_deduplication_token:
            insert_kwargs["settings"] = {"insert_deduplication_token": insert_deduplication_token}

        client.insert(
            'bronze.events',
            data,
            column_names=[
                'event_id', 'session_id', 'tenant_id', 'event_name', 'user_id', 'channel',
                'timestamp', 'metadata', '_raw', '_source_id', '_kafka_partition',
                '_kafka_offset', '_kafka_topic', '_ingest_path', '_ingested_at',
            ],
            **insert_kwargs,
        )
        logger.debug(f"Inserted {len(events)} events into bronze.events.")

    def query(self, sql: str, parameters: dict = None) -> List[Dict[str, Any]]:
        """Execute a query and return dicts. Fresh client per call for thread safety.

        P3-7: the client is now CLOSED afterwards. "Fresh per call" and "never closed" are
        separable, and only the first is required -- /metrics/kpi alone fires six queries, so an
        unclosed client per query leaked file descriptors and ClickHouse sessions over hours of
        dashboard polling.
        """
        client = self._get_client()
        try:
            result = client.query(sql, parameters=parameters if parameters else {})
            columns = result.column_names
            rows = result.result_rows
            return [dict(zip(columns, row)) for row in rows]
        finally:
            try:
                client.close()
            except Exception:
                pass

# Singleton instance
ch_client = ClickHouseClient()
