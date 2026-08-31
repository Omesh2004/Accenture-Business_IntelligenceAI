"""
Reconciliation job: committed Kafka consumer-group offsets vs what actually landed in ClickHouse.

Phase 3 proposal 2 (docs/audits/clickhouse_pipeline_audit_phase3_proposals.md), implemented per
docs/audits/clickhouse_pipeline_implementation_prompt.md Phase B.

Not a new always-on service (CLAUDE.md rule 2 -- "do not add infrastructure"): a standalone
script, run periodically or on demand, reusing the confluent-kafka client and
warehouse/client.py's ClickHouseClient -- the same two things pipeline/worker.py already
depends on, not a new dependency.

What it checks, per partition of the topic, for the given consumer group:

  committed offset       the offset the group has actually committed (i.e. "durably accounted
                          for", per pipeline/worker.py's commit-after-insert design)
  log-end-offset          the newest offset the broker currently holds (committed lag = log-end -
                          committed; a growing lag on its own is backlog, not loss)
  max ClickHouse offset   MAX(kafka_offset) actually present in events_raw for that partition,
                          restricted to ingest_path='kafka' rows -- the direct-ClickHouse fallback
                          path never carries a real partition/offset (Phase 3 proposal 3) and must
                          not be compared against Kafka's own numbering

A partition whose committed offset outruns its max-observed-in-ClickHouse offset by more than
--tolerance is a candidate for "something between consume and commit didn't land". Before
concluding loss, this script cross-references events_dead_letter (stage='worker_poison') for
that partition, best-effort: pipeline/worker.py now attaches kafka_partition/kafka_offset to
every consumed message (Phase B), so a row dead-lettered after this change carries them in its
payload; a poison row from before this change won't be found this way.

Per the audit's own edge-case guidance (docs/audits/clickhouse_pipeline_audit_phase1_findings.md):
offsets are not guaranteed perfectly sequential even in a healthy system. This script treats a
gap beyond tolerance as an anomaly WORTH INVESTIGATING, not a proven defect -- the same hard-
invariant/soft-invariant distinction this repo already applies elsewhere (e.g. `completed <=
started` is an abstain case, not an automatic quarantine).

Usage:
    python scripts/reconcile_kafka_offsets.py
    python scripts/reconcile_kafka_offsets.py --topic feature-events --group feature-processor-group
    python scripts/reconcile_kafka_offsets.py --tolerance 10 --tenant nexabank,safexbank

Run inside a container with confluent-kafka and clickhouse-connect available (both already in
requirements.txt) and network access to both the broker and ClickHouse, e.g.:

    docker compose exec processor-worker python scripts/reconcile_kafka_offsets.py

Exit code: 0 if every partition is within tolerance, 1 if any partition exceeds it, 2 if Kafka
offsets could not be read at all (e.g. the broker is unreachable).
"""
import argparse
import json
import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from confluent_kafka import Consumer, TopicPartition  # noqa: E402

from warehouse.config import settings  # noqa: E402
from warehouse.client import ch_client  # noqa: E402

GREEN, RED, YELLOW, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"


def compute_gap(committed_offset: int, max_ch_offset: Optional[int]) -> int:
    """How many offsets the consumer group has committed past what's visible in ClickHouse.

    `committed_offset` is the NEXT offset to read (Kafka's own convention), so the last message
    actually processed is `committed_offset - 1`. A gap of 0 means ClickHouse's highest offset
    for this partition matches the last committed one exactly. Pulled out as its own function so
    the arithmetic is unit-testable without a live broker or ClickHouse connection.
    """
    if max_ch_offset is None:
        return committed_offset
    return (committed_offset - 1) - max_ch_offset


def get_partition_offsets(topic: str, group_id: str) -> dict:
    """Committed offset + log-end-offset (watermark) per partition, for `group_id` on `topic`."""
    consumer = Consumer({
        "bootstrap.servers": settings.KAFKA_BROKER_URL,
        "group.id": group_id,
        "enable.auto.commit": False,
    })
    try:
        metadata = consumer.list_topics(topic, timeout=10)
        if topic not in metadata.topics or metadata.topics[topic].error is not None:
            raise RuntimeError(f"Topic '{topic}' not found on the broker.")
        partitions = sorted(metadata.topics[topic].partitions.keys())

        tps = [TopicPartition(topic, p) for p in partitions]
        committed = consumer.committed(tps, timeout=10)

        result = {}
        for tp in committed:
            low, high = consumer.get_watermark_offsets(
                TopicPartition(topic, tp.partition), timeout=10, cached=False,
            )
            committed_offset = tp.offset if tp.offset is not None and tp.offset >= 0 else None
            result[tp.partition] = {
                "committed_offset": committed_offset,
                "log_end_offset": high,
                "low_watermark": low,
            }
        return result
    finally:
        consumer.close()


def get_max_clickhouse_offset(topic: str, tenants: Optional[list]) -> dict:
    """MAX(kafka_offset) and row count actually landed in ClickHouse per partition, restricted
    to rows genuinely consumed via Kafka. Fallback-path rows (ingest_path != 'kafka') never
    carry a real offset and would corrupt the comparison if included."""
    tenant_clause = ""
    params = {"topic": topic}
    if tenants:
        tenant_clause = "AND tenant_id IN %(tenants)s"
        params["tenants"] = tuple(tenants)

    sql = f"""
        SELECT kafka_partition, max(kafka_offset) AS max_offset, count() AS row_count
        FROM feature_intelligence.events_raw
        WHERE kafka_topic = %(topic)s AND ingest_path = 'kafka' {tenant_clause}
        GROUP BY kafka_partition
    """
    rows = ch_client.query(sql, params)
    return {
        int(r["kafka_partition"]): {"max_offset": int(r["max_offset"]), "row_count": int(r["row_count"])}
        for r in rows
    }


def find_dead_lettered_offsets(partition: int, topic: str) -> list:
    """Best-effort: offsets for this partition visible in events_dead_letter's payload, for rows
    dead-lettered after pipeline/worker.py started attaching kafka_partition/kafka_offset."""
    sql = "SELECT payload FROM feature_intelligence.events_dead_letter WHERE stage = 'worker_poison'"
    try:
        rows = ch_client.query(sql)
    except Exception:
        # events_dead_letter may not exist yet on this volume (see the Phase A report) -- do not
        # fail the whole reconciliation run over a table this job only uses as a cross-reference.
        return []
    offsets = []
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except Exception:
            continue
        if payload.get("kafka_partition") == partition and payload.get("kafka_topic") == topic:
            offset = payload.get("kafka_offset")
            if isinstance(offset, int):
                offsets.append(offset)
    return offsets


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--topic", default="feature-events")
    parser.add_argument("--group", default="feature-processor-group")
    parser.add_argument(
        "--tolerance", type=int, default=5,
        help="Gap size (offsets) below which a mismatch is not flagged (default: 5)",
    )
    parser.add_argument(
        "--tenant", default="",
        help="Comma-separated tenant filter for the ClickHouse side (default: all tenants)",
    )
    args = parser.parse_args()

    tenants = [t.strip() for t in args.tenant.split(",") if t.strip()] or None

    print(f"Reconciling '{args.group}' against topic '{args.topic}'\n")

    try:
        kafka_side = get_partition_offsets(args.topic, args.group)
    except Exception as exc:
        print(f"{RED}FAIL{RESET} could not read Kafka offsets: {exc}")
        return 2

    ch_side = get_max_clickhouse_offset(args.topic, tenants)

    all_partitions = sorted(set(kafka_side) | set(ch_side))
    if not all_partitions:
        print(f"{YELLOW}WARN{RESET} no partitions found on either side -- nothing to reconcile.")
        return 0

    anomalies = 0
    for p in all_partitions:
        k = kafka_side.get(p, {})
        c = ch_side.get(p, {})
        committed = k.get("committed_offset")
        log_end = k.get("log_end_offset")
        max_ch = c.get("max_offset")
        row_count = c.get("row_count", 0)

        if committed is None:
            print(f"  [{YELLOW}WARN{RESET}] partition {p}: no committed offset for this group yet (rows in CH: {row_count})")
            continue

        gap = compute_gap(committed, max_ch)
        lag = (log_end - committed) if log_end is not None else None

        if gap > args.tolerance:
            anomalies += 1
            dl_offsets = find_dead_lettered_offsets(p, args.topic)
            covered = [
                o for o in dl_offsets
                if (max_ch is None or o > max_ch) and o < committed
            ]
            print(
                f"  [{RED}ANOMALY{RESET}] partition {p}: committed={committed} max_in_ch={max_ch} "
                f"gap={gap} (> tolerance {args.tolerance}); consumer lag={lag}; "
                f"{len(covered)} of the gap's offsets found dead-lettered as worker_poison "
                f"({covered[:10]}{'...' if len(covered) > 10 else ''})"
            )
        else:
            print(
                f"  [{GREEN}OK{RESET}] partition {p}: committed={committed} max_in_ch={max_ch} "
                f"gap={gap} lag={lag} rows_in_ch={row_count}"
            )

    print()
    if anomalies:
        print(
            f"{RED}{anomalies} partition(s) show a gap beyond tolerance{RESET} -- worth "
            "investigating, not a proven defect (see module docstring)."
        )
        return 1
    print(f"{GREEN}No partition exceeds tolerance.{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
