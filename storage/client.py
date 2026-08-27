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

from core.config import settings

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
        5 minutes on its FIRST attempt, never reaching `processing/worker.py`'s
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
        """Bulk insert raw events into ClickHouse.

        Callers: processing/worker.py (the Kafka-consumed path -- attaches real
        kafka_partition/kafka_offset/kafka_topic and ingest_path='kafka' per event, see
        run_worker()) and api/seed_safexbank.py (a direct-to-ClickHouse seeding script that
        bypasses Kafka and the ingestion API entirely, and sets none of these fields).

        `insert_deduplication_token` (Phase F item 6 bullet 2,
        docs/audits/clickhouse_pipeline_implementation_phases_defg_prompt.md): an optional,
        caller-supplied deterministic token for ClickHouse's own insert-level block dedup, so a
        retried insert of the exact same logical batch (network ack lost, insert already
        landed) is caught by ClickHouse itself, not just by the caller's own retry-identity
        discipline. Only processing/worker.py's flush_batch() passes one today (see its own
        docstring for a load-bearing caveat: this token is currently a NO-OP on the live
        events_raw table). Left unset (None) for every other caller -- api/seed_safexbank.py's
        writes are not part of any retry loop this token would help with, so no token shape was
        invented for it.

        This function deliberately does NOT assume 'kafka' for a caller that doesn't say so --
        Phase 1's own audit documented a real incident where the ingestion API silently ran on
        the direct-ClickHouse fallback for its entire process lifetime with no crash and no
        signal (docs/audits/clickhouse_pipeline_audit_phase1_findings.md), so guessing the
        common case here would have been actively wrong for that period, and is wrong today for
        api/seed_safexbank.py's writes. An unset ingest_path is written as '' -- honestly
        "not reported by this caller" -- rather than mislabeled.

        `_inserted_at` (Phase 3 proposal 1 Option A) is the ReplacingMergeTree version column on
        the post-Phase-C events_raw schema, set explicitly for the same self-documenting reason
        every other column here is explicit rather than relying on the column's own DEFAULT.

        DEPLOYMENT WARNING: `_inserted_at` does not exist on events_raw until the Phase C
        rename-swap actually runs (docs/audits/clickhouse_pipeline_implementation_phase_c_report.md).
        Deploying this function to a live service before that swap completes will break every
        insert through this path with an unknown-column error -- this happened once already in
        this implementation sequence, for the Phase B columns immediately above, before their
        DDL had been approved. Do not hot-reload this change into a running container ahead of
        the swap.
        """
        client = self._get_client()

        if not events:
            return

        # ingested_at/_inserted_at are insert time, not event time -- one "now" for this batch,
        # not derived from each event's own (possibly backdated, see scripts/seed_data.py)
        # timestamp. Both columns currently coexist deliberately: `ingested_at` (Phase 3
        # proposal 2) is a plain audit column; `_inserted_at` (Phase 3 proposal 1 Option A) is
        # specifically the ReplacingMergeTree version column and must be present for merges to
        # have deterministic "latest wins" semantics -- they are not the same column reused
        # twice, even though they hold the same value.
        now = datetime.now(timezone.utc).replace(tzinfo=None)

        # Prepare column data
        data = [
            [
                e.get('event_id', ''),
                e.get('session_id') or e.get('metadata', {}).get('session_id', ''),
                e['tenant_id'],
                e['event_name'],
                e['user_id'],
                e['channel'],
                # Naive UTC to match the DateTime column. utcfromtimestamp is deprecated
                # and returns a naive value anyway; this is the same instant, spelled out.
                datetime.fromtimestamp(e['timestamp'], timezone.utc).replace(tzinfo=None),
                json.dumps(e.get('metadata', {}), ensure_ascii=True), # Encode as valid JSON
                int(e.get('kafka_partition', -1)),
                int(e.get('kafka_offset', -1)),
                str(e.get('kafka_topic', '') or ''),
                now,        # ingested_at
                str(e.get('ingest_path', '') or ''),
                now,        # _inserted_at
            ]
            for e in events
        ]

        insert_kwargs = {}
        if insert_deduplication_token:
            insert_kwargs["settings"] = {"insert_deduplication_token": insert_deduplication_token}

        client.insert(
            'feature_intelligence.events_raw',
            data,
            column_names=[
                'event_id', 'session_id', 'tenant_id', 'event_name', 'user_id', 'channel',
                'timestamp', 'metadata', 'kafka_partition', 'kafka_offset', 'kafka_topic',
                'ingested_at', 'ingest_path', '_inserted_at',
            ],
            **insert_kwargs,
        )
        logger.debug(f"Inserted {len(events)} events into ClickHouse.")

    def query(self, sql: str, parameters: dict = None) -> List[Dict[str, Any]]:
        """Execute a custom SQL query and return dicts. Creates a fresh client per call for thread safety."""
        client = self._get_client()
            
        result = client.query(sql, parameters=parameters if parameters else {})
        
        # Zip column names with row values
        columns = result.column_names
        rows = result.result_rows
        
        return [dict(zip(columns, row)) for row in rows]

# Singleton instance
ch_client = ClickHouseClient()
