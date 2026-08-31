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
from warehouse.config import settings, DeploymentMode
from ingestion.masking import sanitize_metadata
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
    """Fallback: insert directly into ClickHouse when Kafka is unavailable.

    `ingest_path` distinguishes the two callers of this function (Phase 3 proposal 3,
    docs/audits/clickhouse_pipeline_audit_phase3_proposals.md) -- 'fallback_cloud' when cloud
    mode's Kafka send failed/timed out, 'fallback_onprem' when on-prem mode never attempts Kafka
    at all. This function never touches Kafka itself, so kafka_partition/kafka_offset/kafka_topic
    are always the sentinel values (Phase 3 proposal 2) -- there is no real Kafka metadata to
    report here, unlike the worker's Kafka-consumed path.

    DEPLOYMENT WARNING: `_inserted_at` (added below for Phase 3 proposal 1 Option A) does not
    exist on events_raw until the Phase C rename-swap actually runs
    (docs/audits/clickhouse_pipeline_implementation_phase_c_report.md). Deploying this function
    to a live service before that swap completes will break every insert through this path with
    an unknown-column error -- this happened once already in this implementation sequence, for
    the Phase B columns immediately above, before their DDL had been approved. Do not hot-reload
    this change into a running container ahead of the swap.
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
    """One attempt at the direct-ClickHouse insert. Pulled out of
    _insert_direct_to_clickhouse() so the retry wrapper above doesn't duplicate the row-building
    logic, and so a single attempt is independently unit-testable."""
    try:
        client = _clickhouse_client()

        # Naive UTC, matching the DateTime column. datetime.utcfromtimestamp is deprecated
        # (removed in a future Python) and returns a naive value with no tzinfo attached;
        # this is the same instant, spelled explicitly.
        ts = datetime.fromtimestamp(event_dict["timestamp"], timezone.utc).replace(tzinfo=None)
        # ingested_at/_inserted_at are insert time, not event time -- "now", not derived from
        # the payload. They coexist deliberately, not a duplicate of one another: `ingested_at`
        # is a plain audit column, `_inserted_at` is specifically the ReplacingMergeTree version
        # column merges use for deterministic "latest wins" semantics.
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
            -1,       # kafka_partition -- sentinel, this path never touches Kafka
            -1,       # kafka_offset -- sentinel
            "",       # kafka_topic -- sentinel
            now,      # ingested_at
            ingest_path,
            now,      # _inserted_at
            canonicalize_event_name(event_dict["event_name"]) or event_dict["event_name"],
        ]]
        client.insert(
            "feature_intelligence.events_raw",
            row,
            column_names=[
                "event_id", "session_id", "tenant_id", "event_name", "user_id", "channel",
                "timestamp", "metadata", "kafka_partition", "kafka_offset", "kafka_topic",
                "ingested_at", "ingest_path", "_inserted_at", "event_name_canonical",
            ],
        )
        logger.info(f"[Fallback] Inserted event '{event_dict['event_name']}' directly into ClickHouse")
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
            "feature_intelligence.events_dead_letter",
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
            await asyncio.to_thread(_insert_direct_to_clickhouse, event_dict, "fallback_onprem")
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
            await asyncio.to_thread(_insert_direct_to_clickhouse, event_dict, "fallback_cloud")
            _stamp("fallback_ok")
        except Exception as e:
            logger.error(f"Both Kafka and ClickHouse failed for event: {e}")
            raise HTTPException(status_code=500, detail="Failed to ingest event")

    return {"status": "Event queued successfully"}

class FastSeedRequest(BaseModel):
    """Operator-triggered mock data. Never a real customer record -- see api/fast_seed.py."""
    tenant_id: str = "nexabank"
    users: int = 100
    days: int = 30
    seed: int | None = None
    purge_first: bool = False
    # Which tables the purge clears. None means all of them. A single-KPI reset must not take the
    # other metrics' history with it: rebuilding the loan series cleared 30k mock transactions too.
    purge_tables: list[str] | None = None
    # How many generation passes to run, each on `seed + i`.
    #
    # One pass gives a user 1-12 active days out of `days`, and only ~15% of those reach a loan
    # application, so a 30-day run leaves 3-6 applications a day -- under the loan contract's
    # min_denominator of 5, with daily rates swinging 0.33 to 1.00 on counts that small. That noise
    # widens the forecast band until only a total collapse can leave it. Extra passes sample more
    # customer-days at the SAME rates, so density rises while the distribution does not move.
    passes: int = 1
    # A planted movement is echoed back to the caller, never persisted -- see api/fast_seed.py.
    behavior: dict | None = None
    # Off by default: a run generates activity for customers the bank already has. Minting a
    # population every time gave each run its own cohort and made openings spike on every run.
    create_accounts: bool = False


@app.post("/events/seed/fast", status_code=200)
async def seed_fast(req: FastSeedRequest):
    """Fast mode for the simulate console: write mock data straight to ClickHouse.

    It lives HERE rather than in NexaBank because NexaBank has no ClickHouse client and must not
    grow one (`docs/ARCHITECTURE.md`: every read goes through the analytics API, and the bank
    never touches the warehouse). This service already owns writing `events_raw` on the fallback
    path, so it is the one place where a direct write is already an established responsibility.

    Bypassing validation, the taxonomy and Kafka is safe for exactly one reason: this is mock data
    an admin asked for. `POST /events` remains the only door for anything real.
    """
    from api import fast_seed
    try:
        removed = (fast_seed.purge(req.tenant_id, req.purge_tables)
                   if req.purge_first else {})
        passes = max(1, min(int(req.passes or 1), 10))
        written: dict = {}
        for i in range(passes):
            # Each pass gets its own seed so it samples DIFFERENT customer-days. Derived from the
            # base rather than random, so a paired before/after demo re-running the same base seed
            # regenerates the same set and the second run replaces the first run's outcomes.
            seed = None if req.seed is None else req.seed + i
            one = await asyncio.to_thread(
                fast_seed.generate, req.tenant_id, req.users, req.days, seed, req.behavior,
                req.create_accounts)
            for key, value in one.items():
                # Row counts accumulate; everything else (`users`, `days`, the echoed movement)
                # describes the run and is taken as-is. Summing `users` across passes reported
                # 484 customers on a bank that has 121.
                if key in fast_seed._PURGE_PREDICATE and isinstance(value, int):
                    written[key] = written.get(key, 0) + value
                else:
                    written[key] = value
        return {"mode": "fast", "tenant_id": req.tenant_id, "written": written,
                "purged": removed, "passes": passes}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("fast seed failed")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/events/seed/fast/purge", status_code=200)
async def seed_fast_purge(req: FastSeedRequest):
    """Remove what fast mode wrote for a tenant. Mock data has to be reversible.

    `purge_tables` narrows it to one metric's history; omitting it clears everything.
    """
    from api import fast_seed
    try:
        removed = await asyncio.to_thread(fast_seed.purge, req.tenant_id, req.purge_tables)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"tenant_id": req.tenant_id, "purged": removed}


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
        "deployment": settings.DEPLOYMENT_MODE,
        "kafka_connected": bool(healthy),
        "broker_reachable": broker_reachable,
        # `clickhouse_fallback` means the worker is idle and nothing is buffering in Kafka.
        "ingest_path": "kafka" if healthy else "clickhouse_fallback",
        "ingest_stats": dict(_ingest_stats),
    }

