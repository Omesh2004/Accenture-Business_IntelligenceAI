import sys
import os
import json
import asyncio
import logging
from datetime import datetime
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

producer: AIOKafkaProducer = None

# --------------- Direct ClickHouse fallback ---------------
def _insert_direct_to_clickhouse(event_dict: dict):
    """Fallback: insert directly into ClickHouse when Kafka is unavailable."""
    try:
        import clickhouse_connect
        ch_host = os.environ.get("CLICKHOUSE_HOST", "localhost")
        ch_user = os.environ.get("CLICKHOUSE_USER", "default")
        ch_pass = os.environ.get("CLICKHOUSE_PASSWORD", "clickhouse")
        client = clickhouse_connect.get_client(host=ch_host, username=ch_user, password=ch_pass)
        
        ts = datetime.utcfromtimestamp(event_dict["timestamp"])
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
    global producer
    try:
        producer = AIOKafkaProducer(
            bootstrap_servers=settings.KAFKA_BROKER_URL,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            request_timeout_ms=5000,
            max_batch_size=16384,
        )
        await producer.start()
        logger.info("Kafka Producer started successfully.")
    except Exception as e:
        logger.error(f"Failed to start kafka producer: {e}")
        producer = None
    
    yield
    
    if producer:
        await producer.stop()
        logger.info("Kafka Producer shut down.")

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
    
    # 2. Check tracking toggles — reject if admin disabled tracking for this feature
    try:
        import clickhouse_connect
        ch_host = os.environ.get("CLICKHOUSE_HOST", "localhost")
        ch_user = os.environ.get("CLICKHOUSE_USER", "default")
        ch_pass = os.environ.get("CLICKHOUSE_PASSWORD", "clickhouse")
        client = clickhouse_connect.get_client(host=ch_host, username=ch_user, password=ch_pass)
        toggle_result = client.query(
            "SELECT is_enabled FROM feature_intelligence.tracking_toggles FINAL "
            "WHERE tenant_id = %(tenant_id)s AND feature_name = %(feature_name)s",
            parameters={"tenant_id": event.tenant_id, "feature_name": event.event_name}
        )
        if toggle_result.result_rows and toggle_result.result_rows[0][0] == 0:
            logger.info(f"Tracking disabled for feature '{event.event_name}' on tenant '{event.tenant_id}'. Rejecting event.")
            raise HTTPException(status_code=403, detail=f"Tracking disabled for feature '{event.event_name}' by admin.")
    except HTTPException:
        raise
    except Exception as e:
        # If toggle check fails (e.g. table doesn't exist yet), allow the event through
        logger.debug(f"Tracking toggle check skipped: {e}")
    
    if settings.is_on_prem:
        if event.tenant_id != settings.TENANT_ID:
            raise HTTPException(status_code=403, detail="Forbidden: Invalid tenant ID for this on-prem instance.")
        event.user_id = f"anon_{hash(event.user_id) % 1000000}"
        
        # Serialize and write directly to ClickHouse
        event_dict = event.model_dump()
        try:
            _insert_direct_to_clickhouse(event_dict)
            return {"status": "Event inserted locally (ON_PREM mode)"}
        except Exception as e:
            logger.error(f"On-prem direct insert failed: {e}")
            raise HTTPException(status_code=500, detail="Failed to ingest event")
        
    # ------------- CLOUD MODE LOGIC -------------
    # 2. Serialize
    event_dict = event.model_dump()
    
    # 3. Try Kafka with 5s timeout, fallback to ClickHouse
    kafka_success = False
    if producer:
        try:
            await asyncio.wait_for(
                producer.send_and_wait(settings.KAFKA_TOPIC_EVENTS, event_dict),
                timeout=5.0
            )
            kafka_success = True
        except asyncio.TimeoutError:
            logger.warning(f"Kafka send timed out for event '{event.event_name}', using ClickHouse fallback")
        except Exception as e:
            logger.warning(f"Kafka send failed: {e}, using ClickHouse fallback")
    
    if not kafka_success:
        try:
            _insert_direct_to_clickhouse(event_dict)
        except Exception as e:
            logger.error(f"Both Kafka and ClickHouse failed for event: {e}")
            raise HTTPException(status_code=500, detail="Failed to ingest event")

    return {"status": "Event queued successfully"}

@app.get("/health")
def health_check():
    return {"status": "ok", "deployment": settings.DEPLOYMENT_MODE, "kafka_connected": producer is not None}

