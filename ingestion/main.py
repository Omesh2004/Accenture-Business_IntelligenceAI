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
from aiokafka import AIOKafkaProducer

# Add project root to path so we can import 'core'
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.models import FeatureEvent
from core.config import settings, DeploymentMode
from core.security import sanitize_metadata
from api.page_map import canonicalize_event_name

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
# and processing/worker.py -- batching, manual offset commits, at-least-once delivery -- had
# never executed at all.
_producer_lock = asyncio.Lock()
_next_producer_attempt = 0.0
PRODUCER_RETRY_COOLDOWN_S = 15.0


async def _start_producer() -> AIOKafkaProducer | None:
    """Build and start a producer, or return None if the broker is not reachable yet."""
    candidate = AIOKafkaProducer(
        bootstrap_servers=settings.KAFKA_BROKER_URL,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        request_timeout_ms=5000,
        max_batch_size=16384,
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
    import clickhouse_connect
    return clickhouse_connect.get_client(
        host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", "clickhouse"),
    )


# --------------- Tracking toggles: cached, and keyed on BOTH vocabularies ---------------
#
# Two bugs lived here. First, the check built a brand-new ClickHouse client and ran a FINAL
# scan over a ReplacingMergeTree FOR EVERY EVENT -- that dominated ingest latency.
#
# Second, and worse, it never matched. The dashboard writes toggles keyed on the CANONICAL
# name (`normalize_tracking_feature_key(canonicalize_event_name(...))`, api/main.py), e.g.
# `loan.kyc_started.success`. Ingest looked up `event.event_name`, the RAW post-validate name
# the producer actually sends, e.g. `loan.kyc_started.action`. Those never coincide, so
# disabling a feature in the admin UI did nothing at all -- verified: 202 Accepted with the
# feature disabled, 403 only when the stored key happened to be the raw name.
#
# That also silently disabled a documented Trust Gate signal: pro_revenue's `tracking_disabled`
# defect fingerprint is "ingestion 403 rate > 0 for this tenant/feature", which could never fire.
#
# Both keys are honoured here rather than picking one, because the toggles table already holds
# rows written under the canonical vocabulary and re-keying them would silently re-enable
# whatever an admin had switched off.
TOGGLE_CACHE_TTL_S = 20.0
_toggle_cache: dict[tuple[str, str], int] = {}
_toggle_cache_expires_at = 0.0


def _refresh_toggle_cache() -> dict[tuple[str, str], int]:
    global _toggle_cache, _toggle_cache_expires_at

    now = time.monotonic()
    if now < _toggle_cache_expires_at:
        return _toggle_cache

    try:
        client = _clickhouse_client()
        result = client.query(
            "SELECT tenant_id, feature_name, is_enabled "
            "FROM feature_intelligence.tracking_toggles FINAL"
        )
        _toggle_cache = {
            (str(row[0]), str(row[1])): int(row[2]) for row in result.result_rows
        }
        _toggle_cache_expires_at = now + TOGGLE_CACHE_TTL_S
    except Exception as exc:
        # Table may not exist yet on a fresh volume. Fail OPEN -- never drop telemetry
        # because the toggle lookup broke.
        logger.debug("Tracking toggle refresh skipped: %s", exc)
        _toggle_cache_expires_at = now + TOGGLE_CACHE_TTL_S
    return _toggle_cache


def is_tracking_disabled(tenant_id: str, event_name: str) -> bool:
    toggles = _refresh_toggle_cache()
    if not toggles:
        return False
    candidates = {event_name, canonicalize_event_name(event_name)}
    return any(toggles.get((tenant_id, key)) == 0 for key in candidates if key)


# --------------- Direct ClickHouse fallback ---------------
def _insert_direct_to_clickhouse(event_dict: dict):
    """Fallback: insert directly into ClickHouse when Kafka is unavailable."""
    try:
        client = _clickhouse_client()

        # Naive UTC, matching the DateTime column. datetime.utcfromtimestamp is deprecated
        # (removed in a future Python) and returns a naive value with no tzinfo attached;
        # this is the same instant, spelled explicitly.
        ts = datetime.fromtimestamp(event_dict["timestamp"], timezone.utc).replace(tzinfo=None)
        row = [[
            event_dict.get("event_id", ""),
            event_dict.get("session_id") or event_dict.get("metadata", {}).get("session_id", ""),
            event_dict["tenant_id"],
            event_dict["event_name"],
            event_dict["user_id"],
            event_dict.get("channel", "web"),
            ts,
            json.dumps(event_dict.get("metadata", {})),
        ]]
        client.insert(
            "feature_intelligence.events_raw",
            row,
            column_names=["event_id", "session_id", "tenant_id", "event_name", "user_id", "channel", "timestamp", "metadata"],
        )
        logger.info(f"[Fallback] Inserted event '{event_dict['event_name']}' directly into ClickHouse")
    except Exception as e:
        logger.error(f"[Fallback] ClickHouse direct insert failed: {e}")
        raise

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
    
    return JSONResponse(
        status_code=422,
        content={"detail": error_details, "received_body": request_body},
    )

@app.post("/events", status_code=202)
async def ingest_event(event: FeatureEvent):
    """
    Ingest a new feature event.
    Validates schema, strips PII, streams to Kafka.
    Falls back to direct ClickHouse insert if Kafka is unavailable.
    """
    # 1. Mask PII in metadata
    event.metadata = sanitize_metadata(event.metadata)
    
    # 2. Check tracking toggles — reject if admin disabled tracking for this feature.
    # Cached with a short TTL and matched against both the raw and canonical name; see the
    # note on is_tracking_disabled. Runs off the event loop because clickhouse_connect blocks.
    if await asyncio.to_thread(is_tracking_disabled, event.tenant_id, event.event_name):
        logger.info(
            "Tracking disabled for feature '%s' on tenant '%s'. Rejecting event.",
            event.event_name, event.tenant_id,
        )
        raise HTTPException(
            status_code=403,
            detail=f"Tracking disabled for feature '{event.event_name}' by admin.",
        )
    
    if settings.is_on_prem:
        if event.tenant_id != settings.TENANT_ID:
            raise HTTPException(status_code=403, detail="Forbidden: Invalid tenant ID for this on-prem instance.")
        event.user_id = f"anon_{hash(event.user_id) % 1000000}"
        
        # Serialize and write directly to ClickHouse
        event_dict = event.model_dump()
        try:
            await asyncio.to_thread(_insert_direct_to_clickhouse, event_dict)
            return {"status": "Event inserted locally (ON_PREM mode)"}
        except Exception as e:
            logger.error(f"On-prem direct insert failed: {e}")
            raise HTTPException(status_code=500, detail="Failed to ingest event")
        
    # ------------- CLOUD MODE LOGIC -------------
    # 2. Serialize
    event_dict = event.model_dump()
    
    # 3. Kafka first (durable buffer + batched worker inserts), ClickHouse as the fallback.
    kafka_success = False
    active_producer = await get_producer()
    if active_producer is not None:
        try:
            await asyncio.wait_for(
                active_producer.send_and_wait(settings.KAFKA_TOPIC_EVENTS, event_dict),
                timeout=5.0
            )
            kafka_success = True
        except asyncio.TimeoutError:
            logger.warning("Kafka send timed out for '%s', using ClickHouse fallback", event.event_name)
            await drop_producer()
        except Exception as e:
            logger.warning("Kafka send failed (%s), using ClickHouse fallback", e)
            await drop_producer()

    if not kafka_success:
        try:
            # clickhouse_connect is blocking; keep it off the event loop or one slow insert
            # stalls every concurrent request on this worker.
            await asyncio.to_thread(_insert_direct_to_clickhouse, event_dict)
        except Exception as e:
            logger.error(f"Both Kafka and ClickHouse failed for event: {e}")
            raise HTTPException(status_code=500, detail="Failed to ingest event")

    return {"status": "Event queued successfully"}

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "deployment": settings.DEPLOYMENT_MODE,
        "kafka_connected": producer is not None,
        # Which path events are actually taking. `clickhouse_fallback` here means the worker
        # is idle and nothing is buffering in Kafka.
        "ingest_path": "kafka" if producer is not None else "clickhouse_fallback",
    }

