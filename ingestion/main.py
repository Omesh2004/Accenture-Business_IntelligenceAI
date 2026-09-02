import sys
import os
import json
import asyncio
import logging
import time
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from aiokafka import AIOKafkaProducer

# Add project root to path so we can import 'core'
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ingestion.envelope import FeatureEvent
from warehouse.config import settings
from ingestion.masking import sanitize_metadata

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

producer: AIOKafkaProducer = None

# --------------- Kafka producer: lazy, self-healing ---------------
#
# The old code tried once in the lifespan handler and gave up. Because compose declares
# `depends_on: broker` WITHOUT `condition: service_healthy`, this service reliably won the
# race and connected before Kafka was accepting connections -- so `producer` stayed None for
# the whole process lifetime and EVERY event silently took the direct-ClickHouse fallback.
# The process never crashed, so `restart: unless-stopped` never kicked in either.
#
# Observed before this fix: feature-events LOG-END-OFFSET = 0, worker had consumed nothing,
# and pipeline/worker.py -- batching, manual offset commits, at-least-once delivery -- had
# never executed at all.
_producer_lock = asyncio.Lock()
_next_producer_attempt = 0.0
PRODUCER_RETRY_COOLDOWN_S = 15.0

# `producer is not None` only means an object exists: it stays truthy after the broker dies, so
# /health reported ingest_path=kafka against a dead broker. These record real outcomes instead.
_ingest_stats = {"kafka_ok": 0, "kafka_failed": 0, "fallback_ok": 0,
                 "last_kafka_ok_at": None, "last_error": None, "last_error_at": None}


def _stamp(key: str, error: str = "") -> None:
    from datetime import datetime as _dt
    now = _dt.now(timezone.utc).isoformat()
    _ingest_stats[key] = _ingest_stats.get(key, 0) + 1
    if key == "kafka_ok":
        _ingest_stats["last_kafka_ok_at"] = now
    if error:
        _ingest_stats["last_error"] = error[:200]
        _ingest_stats["last_error_at"] = now


async def _start_producer() -> AIOKafkaProducer | None:
    """Build and start a producer, or return None if the broker is not reachable yet."""
    candidate = AIOKafkaProducer(
        bootstrap_servers=settings.KAFKA_BROKER_URL,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        request_timeout_ms=5000,
        max_batch_size=16384,
        # acks="all" + enable_idempotence=True: without these (this aiokafka version's default
        # is acks=1, idempotence off) a leader that acks and then fails before replication can
        # silently lose an event, and a client-side retry after a timeout can create a genuine
        # duplicate produce request. aiokafka requires acks to be 'all'/-1 when idempotence is
        # enabled (raises ValueError otherwise), so both are set together. This version of
        # aiokafka (0.10.0) has no `retries` or `max_in_flight_requests_per_connection`
        # constructor arg -- idempotent in-flight bookkeeping is handled internally, not
        # user-configurable -- so there is nothing to set for those.
        acks="all",
        enable_idempotence=True,
    )
    try:
        await candidate.start()
        logger.info("Kafka producer connected to %s", settings.KAFKA_BROKER_URL)
        return candidate
    except Exception as exc:
        logger.warning("Kafka producer unavailable (%s); using ClickHouse fallback", exc)
        try:
            await candidate.stop()
        except Exception:
            pass  # never leak an unclosed producer -- the old code did
        return None


async def get_producer() -> AIOKafkaProducer | None:
    """Return a live producer, retrying at most once per cooldown window.

    Retrying here rather than only at startup means a broker that comes up late -- or
    restarts -- is picked up automatically, instead of stranding the service on the fallback
    path forever.
    """
    global producer, _next_producer_attempt

    if producer is not None:
        return producer

    now = time.monotonic()
    if now < _next_producer_attempt:
        return None

    async with _producer_lock:
        if producer is not None:
            return producer
        if time.monotonic() < _next_producer_attempt:
            return None
        _next_producer_attempt = time.monotonic() + PRODUCER_RETRY_COOLDOWN_S
        producer = await _start_producer()
        return producer


async def drop_producer() -> None:
    """Discard a producer that failed mid-send so the next call rebuilds it."""
    global producer
    async with _producer_lock:
        stale, producer = producer, None
        if stale is not None:
            try:
                await stale.stop()
            except Exception:
                pass

# --------------- ClickHouse helpers ---------------
def _clickhouse_client():
    """Same timeout fix as warehouse/client.py's _get_client() (Phase G follow-up) -- this module
    builds its own separate clickhouse_connect client rather than importing warehouse.client's, so
    the fix has to be threaded through here too or this path keeps the same 300s hang-on-outage
    gap. See warehouse/client.py's docstring for the full reasoning."""
    import clickhouse_connect
    return clickhouse_connect.get_client(
        host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", "clickhouse"),
        connect_timeout=10,
        send_receive_timeout=30,
    )


# --------------- Direct ClickHouse fallback ---------------
# Phase G follow-up: this path previously made exactly one attempt -- ClickHouse was already
# unavailable enough that Kafka's own fallback triggered (or on-prem mode, which always uses
# this path), so a single transient hiccup here (as opposed to a sustained outage) meant losing
# the event outright with no second chance, unlike pipeline/worker.py's flush_batch() which
# already had retry/backoff. Small and bounded, not flush_batch()'s shape: this runs on the
# synchronous request path (the caller is waiting for an HTTP response), so it retries briefly
# and then still raises -- the existing caller-side 500 behavior is unchanged, just given a
# better chance to avoid it first.
FALLBACK_MAX_RETRIES = 3
FALLBACK_RETRY_BACKOFF_BASE_S = 0.5
FALLBACK_RETRY_BACKOFF_MAX_S = 2.0


def _insert_direct_to_clickhouse(event_dict: dict, ingest_path: str):
    """Fallback: insert directly into `bronze.events` when Kafka is unavailable.

    `ingest_path` is recorded verbatim as `_ingest_path` so the Trust Gate can tell "the KPI
    dropped" from "the forwarder broke" -- 'clickhouse_fallback' today. This function never
    touches Kafka itself, so the `_kafka_*` columns are always sentinels.
    """
    last_exc = None
    for attempt in range(1, FALLBACK_MAX_RETRIES + 1):
        try:
            _insert_direct_to_clickhouse_once(event_dict, ingest_path)
            return
        except Exception as e:
            last_exc = e
            if attempt == FALLBACK_MAX_RETRIES:
                break
            backoff = min(
                FALLBACK_RETRY_BACKOFF_BASE_S * (2 ** (attempt - 1)),
                FALLBACK_RETRY_BACKOFF_MAX_S,
            )
            logger.warning(
                "[Fallback] ClickHouse direct insert attempt %d/%d failed: %s. Retrying in %.1fs",
                attempt, FALLBACK_MAX_RETRIES, e, backoff,
            )
            time.sleep(backoff)
    logger.error(f"[Fallback] ClickHouse direct insert failed after {FALLBACK_MAX_RETRIES} attempts: {last_exc}")
    raise last_exc


def _insert_direct_to_clickhouse_once(event_dict: dict, ingest_path: str):
    """One attempt at the direct-`bronze.events` insert. Pulled out of
    _insert_direct_to_clickhouse() so the retry wrapper above doesn't duplicate the row-building
    logic, and so a single attempt is independently unit-testable.

    This path never touches Kafka, so the `_kafka_*` columns are sentinels. `_raw` is the exact
    request body, carried in on `event_dict['_raw']` by the caller.
    """
    try:
        client = _clickhouse_client()

        # Naive UTC, matching the DateTime column.
        ts = datetime.fromtimestamp(event_dict["timestamp"], timezone.utc).replace(tzinfo=None)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        row = [[
            event_dict.get("event_id", ""),
            event_dict.get("session_id") or event_dict.get("metadata", {}).get("session_id", ""),
            event_dict["tenant_id"],
            event_dict["event_name"],
            event_dict["user_id"],
            event_dict.get("channel", "web"),
            ts,
            json.dumps(event_dict.get("metadata", {})),
            str(event_dict.get("_raw", "") or ""),
            "clickstream",   # _source_id
            -1,              # _kafka_partition -- sentinel, this path never touches Kafka
            -1,              # _kafka_offset -- sentinel
            "",              # _kafka_topic -- sentinel
            ingest_path,     # _ingest_path
            now,             # _ingested_at
        ]]
        client.insert(
            "bronze.events",
            row,
            column_names=[
                "event_id", "session_id", "tenant_id", "event_name", "user_id", "channel",
                "timestamp", "metadata", "_raw", "_source_id", "_kafka_partition",
                "_kafka_offset", "_kafka_topic", "_ingest_path", "_ingested_at",
            ],
        )
        logger.info(f"[Fallback] Inserted event '{event_dict['event_name']}' into bronze.events")
    except Exception:
        # Re-raised without its own log line -- the retry wrapper above logs each attempt's
        # failure (WARNING) and the final one (ERROR); logging here too would just duplicate it.
        raise


# --------------- Pre-Kafka validation failures: dead-lettered, not just logged ---------------
#
# Phase 1 item 3 (docs/audits/clickhouse_pipeline_audit_phase1_findings.md): a payload that
# fails FeatureEvent validation never reaches Kafka or the worker, so it never reached
# events_dead_letter either -- only a log line existed, with no persisted, replayable record.
# That's an asymmetry against pipeline/worker.py's poison-row path, which properly dead-letters
# with the full payload. Reuses events_dead_letter rather than a parallel table (Phase 3 proposal
# 4c) -- same replayable-verbatim-payload property, `stage` distinguishes the two writers instead
# of a second schema that could drift from the first.
def _dead_letter_validation_failure(payload: dict, error_details: list) -> None:
    """Persist a pre-Kafka FeatureEvent validation failure. Never raises -- a lost DLQ write
    must not turn into a 500 on top of the 422 already being returned to the caller."""
    try:
        client = _clickhouse_client()
        row = [[
            str((payload or {}).get("event_id", "") or ""),
            str((payload or {}).get("tenant_id", "") or ""),
            str((payload or {}).get("event_name", "") or ""),
            json.dumps(payload, default=str),
            json.dumps(error_details, default=str)[:2000],
            "ingest_validation",
        ]]
        client.insert(
            "bronze.events_dead_letter",
            row,
            column_names=["event_id", "tenant_id", "event_name", "payload", "error", "stage"],
        )
    except Exception as exc:
        # Same philosophy as pipeline/worker.py's _dead_letter(): losing this write is bad
        # but must not block returning the 422 the caller is already waiting on.
        logger.critical("Dead-letter insert FAILED for a validation failure: %s", exc)


# --------------- Lifespan ---------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Best-effort at startup; get_producer() retries on demand, so losing the race with the
    # broker is no longer terminal for the whole process.
    await get_producer()

    yield

    await drop_producer()
    logger.info("Kafka producer shut down.")

app = FastAPI(
    title="Feature Intelligence Ingestion API",
    description="High-throughput API for ingesting feature usage events.",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------- Request size cap on /events (Phase G follow-up) ---------------
#
# Phase 1 item 12 (docs/audits/clickhouse_pipeline_audit_phase1_findings.md): no active
# protection against an oversized request or an oversized metadata blob existed anywhere in the
# ingest path -- the risk being unbounded memory use per request, not corrupted data. Checked
# real production data before picking a number rather than guessing: max metadata size observed
# live is 458 bytes (p99 437, avg 316) -- 64KB for the WHOLE request body is >100x that, so this
# rejects only genuine abuse, never real traffic.
#
# Deliberately a Content-Length check at the ASGI/middleware layer, scoped to /events only, not
# a Pydantic field constraint on ingestion/envelope.py's FeatureEvent: by the time a Pydantic validator
# runs, FastAPI has already read the full body into memory, which doesn't address "unbounded
# memory use per request" at all -- only rejecting BEFORE the body is read does. This is also why
# FeatureEvent (CLAUDE.md coupling point 1, "contract between 3 producers") doesn't need to
# change for this fix.
#
# Known limitation, stated plainly: this checks the Content-Length header. A client using
# chunked transfer encoding without that header bypasses this check entirely -- defense-in-depth
# against oversized well-behaved clients, not a hardened streaming cap against an adversarial one.
MAX_EVENT_BODY_BYTES = 64 * 1024

# Round 2 is one bank. An event for any other tenant is rejected (→ dead-letter), so the
# second-tenant data never enters bronze. `tenant_id` stays a column; it just has one value.
ALLOWED_TENANTS = {t.strip() for t in os.environ.get("ALLOWED_TENANTS", "nexabank").split(",")
                   if t.strip()}


@app.middleware("http")
async def limit_events_body_size(request: Request, call_next):
    if request.url.path == "/events" and request.method == "POST":
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_EVENT_BODY_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={
                            "detail": f"Request body exceeds the {MAX_EVENT_BODY_BYTES}-byte "
                                      f"limit for /events."
                        },
                    )
            except ValueError:
                pass  # Malformed Content-Length -- let normal request handling reject it.
    return await call_next(request)


# Custom exception handler for validation errors
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Log detailed validation errors to help debug 422 responses."""
    error_details = []
    for error in exc.errors():
        error_details.append({
            "field": ".".join(str(x) for x in error["loc"][1:]),
            "message": error["msg"],
            "type": error["type"],
        })
    
    request_body = {}
    try:
        if request.method == "POST":
            request_body = await request.json()
    except:
        request_body = {"_error": "Could not parse request body"}

    logger.error(f"[VALIDATION ERROR] Errors: {error_details}, Request body: {request_body}")

    # Scoped to /events specifically: this handler is registered app-wide, but events_dead_letter
    # exists to make telemetry payloads replayable, not to catch every possible validation error
    # this service could ever raise on any future endpoint.
    if request.url.path == "/events":
        await asyncio.to_thread(_dead_letter_validation_failure, request_body, error_details)

    return JSONResponse(
        status_code=422,
        content={"detail": error_details, "received_body": request_body},
    )

@app.post("/events", status_code=202)
async def ingest_event(event: FeatureEvent, request: Request):
    """
    Ingest a new feature event.
    Masks PII, then streams to Kafka -> bronze.events. Falls back to a direct bronze.events
    insert if Kafka is unavailable. The exact request body is preserved verbatim as
    bronze.events._raw so a taxonomy-fix replay is always possible.
    """
    # The raw body, before masking and before any envelope coercion. FastAPI has already read
    # and cached it to parse `event`, so this does not re-consume the stream.
    try:
        raw_body = (await request.body()).decode("utf-8", errors="replace")
    except Exception:
        raw_body = ""

    # 1. One bank in Round 2 — reject anything else to the dead-letter table.
    if event.tenant_id not in ALLOWED_TENANTS:
        await asyncio.to_thread(
            _dead_letter_validation_failure,
            {"event_id": event.event_id, "tenant_id": event.tenant_id,
             "event_name": event.event_name},
            [{"field": "tenant_id", "message": f"tenant {event.tenant_id!r} is not served"}])
        raise HTTPException(status_code=422, detail=f"tenant {event.tenant_id!r} is not served")

    # 2. Mask PII in metadata
    event.metadata = sanitize_metadata(event.metadata)

    # 3. Serialize; carry the raw body through to whichever write path runs.
    event_dict = event.model_dump()
    event_dict["_raw"] = raw_body

    # 3. Kafka first (durable buffer + batched worker inserts), ClickHouse as the fallback.
    kafka_success = False
    active_producer = await get_producer()
    if active_producer is not None:
        try:
            await asyncio.wait_for(
                # P3-6. key=None scatters a tenant's events across partitions the moment the
                # topic has more than one, breaking every ordering assumption. Harmless today
                # (--partitions 1) and cheap to get right before it matters.
                active_producer.send_and_wait(
                    settings.KAFKA_TOPIC_EVENTS, event_dict,
                    key=str(event_dict.get("tenant_id", "")).encode("utf-8"),
                ),
                timeout=5.0
            )
            kafka_success = True
            _stamp("kafka_ok")
        except asyncio.TimeoutError:
            logger.warning("Kafka send timed out for '%s', using ClickHouse fallback", event.event_name)
            _stamp("kafka_failed", "send timeout")
            await drop_producer()
        except Exception as e:
            logger.warning("Kafka send failed (%s), using ClickHouse fallback", e)
            _stamp("kafka_failed", str(e))
            await drop_producer()

    if not kafka_success:
        try:
            # clickhouse_connect is blocking; keep it off the event loop or one slow insert
            # stalls every concurrent request on this worker.
            await asyncio.to_thread(_insert_direct_to_clickhouse, event_dict, "clickhouse_fallback")
            _stamp("fallback_ok")
        except Exception as e:
            logger.error(f"Both Kafka and ClickHouse failed for event: {e}")
            raise HTTPException(status_code=500, detail="Failed to ingest event")

    return {"status": "Event queued successfully"}

# --------------- Fast-mode seeding: proxied to the pipeline service ---------------
#
# Fast mode moved to `pipeline/dev/seed.py` + `POST /dev/seed` (plan §3.7 / sync doc A10): after
# the bronze/silver/gold split, a seeder must write `bronze.*` and run the pipeline transforms,
# which is pipeline-service territory, not ingestion's. These two endpoints stay as a thin proxy
# so NexaBank's `?mode=fast` keeps working until it re-points to `${PIPELINE_URL}/dev/seed`
# directly — then they are deleted.
import urllib.request as _urlreq  # noqa: E402
import urllib.error as _urlerr  # noqa: E402

PIPELINE_URL = os.environ.get("PIPELINE_URL", "http://pipeline:8003")


class FastSeedRequest(BaseModel):
    tenant_id: str = "nexabank"
    users: int = 100
    days: int = 30
    seed: int | None = None
    purge_first: bool = False
    purge_tables: list[str] | None = None
    passes: int = 1
    behavior: dict | None = None
    create_accounts: bool = False


def _post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    r = _urlreq.Request(url, data=body, headers={"content-type": "application/json"}, method="POST")
    with _urlreq.urlopen(r, timeout=600.0) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def _proxy_dev_seed(path: str, req: FastSeedRequest):
    try:
        return await asyncio.to_thread(_post_json, f"{PIPELINE_URL}{path}", req.model_dump())
    except _urlerr.HTTPError as exc:
        raise HTTPException(status_code=exc.code, detail=exc.read().decode("utf-8", "replace"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"pipeline service unreachable: {exc}")


@app.post("/events/seed/fast", status_code=200)
async def seed_fast(req: FastSeedRequest):
    """DEPRECATED proxy -> pipeline `POST /dev/seed`. Re-point NexaBank's `?mode=fast` there."""
    return await _proxy_dev_seed("/dev/seed", req)


@app.post("/events/seed/fast/purge", status_code=200)
async def seed_fast_purge(req: FastSeedRequest):
    """DEPRECATED proxy -> pipeline `POST /dev/seed/purge`."""
    return await _proxy_dev_seed("/dev/seed/purge", req)


@app.get("/health")
async def health_check():
    """Honest health: probes the broker rather than trusting that a producer object exists."""
    broker_reachable = None
    if producer is not None:
        try:
            # A real round trip. cluster.brokers() returns CACHED metadata and stays truthy
            # after the broker dies, which is how this endpoint used to report a healthy Kafka
            # against a broker that had crashed.
            await asyncio.wait_for(producer.client.fetch_all_metadata(), timeout=3.0)
            broker_reachable = True
        except Exception as exc:
            broker_reachable = False
            _ingest_stats["last_error"] = f"broker probe failed: {exc}"[:200]

    healthy = producer is not None and broker_reachable is not False
    return {
        "status": "ok" if healthy else "degraded",
        "kafka_connected": bool(healthy),
        "broker_reachable": broker_reachable,
        # `clickhouse_fallback` means the worker is idle and nothing is buffering in Kafka.
        "ingest_path": "kafka" if healthy else "clickhouse_fallback",
        "ingest_stats": dict(_ingest_stats),
    }

