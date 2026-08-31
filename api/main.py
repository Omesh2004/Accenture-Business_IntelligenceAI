import json
import logging
import sys
import os
from urllib.parse import parse_qsl, urlencode
from typing import List, Optional
from fastapi import FastAPI, Query, HTTPException, Request
from pydantic import BaseModel as _BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from warehouse.client import ch_client
from api.insights import generate_insights, query_vllm
from api.page_map import resolve_page, resolve_display_name, normalize_event, canonicalize_event_name, CANONICAL_EVENT_ALIASES, FEATURE_DISPLAY_NAMES
from warehouse.config import settings
from api.middleware import require_cloud_mode, require_tenant_access

# Alias for Python's built-in range() since many endpoints use 'range' as a query param name
builtins_range = range

MIN_RANGE_DAYS = 1
MAX_RANGE_DAYS = 365


def parse_range(range_str: str) -> int:
    """Clamped to [1, 365]: a negative range produced a future date and a silently empty
    result, and an unbounded one a full-table scan."""
    if not range_str:
        return 7
    range_str = range_str.lower().strip()
    raw = range_str[:-1] if range_str.endswith('d') else range_str
    try:
        days = int(raw)
    except ValueError:
        return 7
    return max(MIN_RANGE_DAYS, min(days, MAX_RANGE_DAYS))


TENANT_ALIAS_MAP = {
    "bank_a": "nexabank",
    "bank_b": "safexbank",
}

# Replay-safe event count over events_raw.
#
# The worker commits Kafka offsets AFTER the ClickHouse insert, so delivery is at-least-once
# and events_raw (a plain MergeTree) never deduplicates. Counting rows with count() therefore
# double-counts a replayed batch. Idempotency is delivered at READ time by counting distinct
# event_ids instead -- see docs/DATABASE.md FOUNDATION-1/4.
#
# This expression is byte-for-byte the one in mv_daily_feature_usage (warehouse/clickhouse/schema.sql).
# Keep them identical: if they drift, /metrics/kpi and daily_feature_usage report different
# totals for the same window and the dashboard contradicts itself. The concat() branch only
# covers legacy rows written before event_id existed.
DEDUP_EVENT_KEY = (
    "if(length(event_id) > 0, event_id, "
    "concat('legacy:', user_id, ':', toString(timestamp), ':', event_name, ':', metadata))"
)

def count_canonical_features(event_names) -> int:
    """Distinct features behind a set of raw event names.

    Aliases collapse: dashboard.page.view and free.dashboard.view are one feature, not two.
    Names canonicalize_event_name drops (returns None) are not features and are excluded.
    """
    return len({
        canonical
        for canonical in (canonicalize_event_name(str(name)) for name in event_names)
        if canonical
    })


APP_TENANT_SCOPES = {
    "nexabank": {"nexabank", "safexbank"},
}

TENANT_TO_APP = {
    "nexabank": "nexabank",
    "safexbank": "nexabank",
}


def normalize_tenant_csv(raw_value: str) -> str:
    if not raw_value:
        return raw_value
    parts = [p.strip() for p in str(raw_value).split(",") if p.strip()]
    if not parts:
        return raw_value
    mapped = [TENANT_ALIAS_MAP.get(p.lower(), p.lower()) for p in parts]
    return ",".join(mapped)


def rewrite_tenant_query_aliases(request: Request) -> None:
    query_string = request.scope.get("query_string", b"")
    if not query_string:
        return

    pairs = parse_qsl(query_string.decode("utf-8", errors="ignore"), keep_blank_values=True)
    if not pairs:
        return

    changed = False
    rewritten = []
    for key, value in pairs:
        if key in {"tenants", "tenant_id"}:
            normalized = normalize_tenant_csv(value)
            rewritten.append((key, normalized))
            changed = changed or (normalized != value)
        else:
            rewritten.append((key, value))

    if changed:
        request.scope["query_string"] = urlencode(rewritten).encode("utf-8")


def parse_admin_apps(raw_admin_apps: str) -> set[str]:
    if not raw_admin_apps:
        return set()
    return {a.strip().lower() for a in raw_admin_apps.split(",") if a.strip()}


def expand_admin_scoped_tenants(admin_apps: set[str]) -> set[str]:
    if not admin_apps:
        return set()

    scoped_tenants: set[str] = set()
    for app in admin_apps:
        if app in APP_TENANT_SCOPES:
            scoped_tenants.update(APP_TENANT_SCOPES[app])
            continue
        mapped_app = TENANT_TO_APP.get(app)
        if mapped_app and mapped_app in APP_TENANT_SCOPES:
            scoped_tenants.update(APP_TENANT_SCOPES[mapped_app])
    return scoped_tenants


def normalize_app_id(raw_app: str) -> str:
    if not raw_app:
        return ""
    normalized = raw_app.strip().lower()
    return TENANT_TO_APP.get(normalized, normalized)


def admin_has_app_scope(admin_apps: set[str], app_id: str) -> bool:
    if not app_id:
        return False
    normalized_app = normalize_app_id(app_id)
    for app in admin_apps:
        if normalize_app_id(app) == normalized_app:
            return True
    return False


def resolve_effective_allowed_tenants(admin_apps: set[str], active_app: str | None) -> set[str]:
    allowed_tenants = expand_admin_scoped_tenants(admin_apps)
    if not active_app:
        return allowed_tenants

    normalized_active_app = normalize_app_id(active_app)
    if normalized_active_app in APP_TENANT_SCOPES:
        return set(APP_TENANT_SCOPES[normalized_active_app])
    return set()


def tenants_resolve_to_single_app(requested_tenants: set[str]) -> bool:
    if not requested_tenants:
        return True
    resolved_apps = {TENANT_TO_APP.get(tenant, tenant) for tenant in requested_tenants}
    return len(resolved_apps) <= 1

def build_heatmap_group_labels(days: int, groups: List[str], is_compare: bool) -> List[str]:
    if is_compare:
        return [g.replace('_', ' ').title() for g in groups]

    safe_days = max(days, 1)
    bucket_count = max(len(groups), 1)
    bucket_span = safe_days / bucket_count
    start_date = datetime.now(timezone.utc).replace(tzinfo=None).date() - timedelta(days=safe_days)
    labels: List[str] = []

    for index, _ in enumerate(groups):
        bucket_start = start_date + timedelta(days=int(round(index * bucket_span)))
        bucket_end = start_date + timedelta(days=max(int(round((index + 1) * bucket_span)) - 1, 0))

        if bucket_end < bucket_start:
            bucket_end = bucket_start

        if bucket_start == bucket_end:
            labels.append(bucket_start.strftime('%b %d'))
        else:
            labels.append(f"{bucket_start.strftime('%b %d')} - {bucket_end.strftime('%b %d')}")

    return labels

import time
from datetime import datetime, timedelta, timezone

# In-memory dictionary to cache AI reports: { tenant_id: { "timestamp": float, "report": str } }
AI_REPORT_CACHE = {}
AI_CACHE_TTL = 3600  # 1 hour cache duration
app = FastAPI(
    title="Feature Analytics API",
    description="APIs for feature adoption, funnel analysis, and rule-based insights."
)

# P3-13. allow_origins=["*"] with allow_credentials=True is invalid per the CORS spec and
# browsers reject the combination outright. Explicit origins, overridable per deployment.
CORS_ALLOW_ORIGINS = [
    o.strip() for o in os.environ.get(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:3000,http://localhost:3001,http://localhost:3002",
    ).split(",") if o.strip()
]
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

class RBACMiddleware(BaseHTTPMiddleware):
    """
    Strict Role-Based Access Control middleware.
    
    Roles:
      super_admin  → Overall platform admin, aggregated summaries ONLY, NO raw/sensitive data
      app_admin    → App-level admin, full access to detailed analytics for their app
      user         → No API access at all
    """
    
    # Endpoints that are too sensitive for super_admin (raw data, user-level details, tenant-specific analytics)
    # /intelligence is persona-gated and entitlement-filtered server-side, so it returns a
    # narrative, not detailed rows. rbac.json maps super_admin -> the cfo persona; without it here
    # that mapping is dead config and a CFO can never reach their own narrative.
    COMPANY_ADMIN_ALLOWED = [
        "/admin",
        "/metrics/kpi",
        "/insights",
        "/tenants",
        "/features/usage",
        "/deployment",
        "/ai_report",
        "/tracking",
        "/config",
        "/intelligence",
    ]

    COMPANY_ADMIN_BLOCKED = [
        "/audit_logs",
        "/locations",
        "/metrics/realtime_users",
        "/metrics/pages_per_minute",
        "/metrics/top_pages",
        "/metrics/devices",
        # Describes the provenance of /locations and /metrics/devices, so it carries the
        # same scope. Blocked by default anyway; declared so a change to the default cannot
        # silently widen it.
        "/metrics/dimension_provenance",
        "/metrics/channels",
        "/metrics/retention",
        "/metrics/secondary_kpi",
        "/metrics/traffic",
        "/metrics/feature_usage_series",
        "/features/activity",
        "/features/configs",
        "/funnels",
        "/transparency",
        "/license",
        "/journey",
        "/predictive",
        "/segmentation",
    ]
    
    async def dispatch(self, request: Request, call_next):
        # Accept backend tenant aliases (bank_a/bank_b) in all analytics query params.
        rewrite_tenant_query_aliases(request)
        path = request.url.path
        
        # Public paths and CORS Preflight — always accessible
        if request.method == "OPTIONS" or path.startswith("/deployment") or path.startswith("/health") or path == "/" or path.startswith("/ws/"):
            return await call_next(request)
            
        role = request.headers.get("X-User-Role", "user")
        
        # Normal users can't access any data APIs
        if role == "user":
            return JSONResponse(
                status_code=403, 
                content={"detail": "Forbidden: Access denied. Normal users cannot access analytics APIs."}
            )
            
        # Super admin (overall admin): aggregated endpoints ONLY, block all sensitive/detailed data
        if role == "super_admin":
            # Check if the path matches any blocked endpoint
            if any(path.startswith(blocked) for blocked in self.COMPANY_ADMIN_BLOCKED):
                return JSONResponse(
                    status_code=403, 
                    content={"detail": "Forbidden: Super admins cannot access detailed analytics data. Use /admin/* for aggregated summaries."}
                )
            
            # Explicitly allow only these patterns for super_admin
            if not any(path.startswith(p) for p in self.COMPANY_ADMIN_ALLOWED):
                return JSONResponse(
                    status_code=403, 
                    content={"detail": "Forbidden: Endpoint not available for super admin role."}
                )
        # app_admin: full access to all detailed endpoints, but MUST be restricted to their assigned tenant
        if role == "app_admin":
            tenant_id = request.query_params.get("tenant_id") or request.query_params.get("tenants")
            email = request.headers.get("X-User-Email")
            admin_apps = parse_admin_apps(request.headers.get("X-Admin-Apps", ""))
            active_app = normalize_app_id(request.headers.get("X-Active-App", ""))
            allowed_tenants = resolve_effective_allowed_tenants(admin_apps, active_app)

            if not email or not allowed_tenants:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Forbidden: app_admin is not assigned to any app tenants."}
                )

            if active_app and not admin_has_app_scope(admin_apps, active_app):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Forbidden: requested app scope is not assigned to this admin."}
                )
            
            # Some endpoints don't require tenant_id (they are global or use request body)
            tenant_optional_paths = ["/tenants", "/deployment", "/license/sync", "/config"]
            is_tenant_optional = any(path.startswith(p) for p in tenant_optional_paths)
            
            if is_tenant_optional:
                pass  # Allow without tenant_id
            elif tenant_id:
                requested_tenants = {t.strip().lower() for t in str(tenant_id).split(",") if t.strip()}
                if not requested_tenants:
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "Forbidden: tenant scope is required for this endpoint."}
                    )

                if not tenants_resolve_to_single_app(requested_tenants):
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "Forbidden: cross-app tenant comparison is not allowed."}
                    )

                if not requested_tenants.issubset(allowed_tenants):
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "Forbidden: requested tenants are outside your bank app scope."}
                    )
                pass
            else:
                return JSONResponse(
                    status_code=403, 
                    content={"detail": "Forbidden: Admin request missing tenant_id/tenants or user email headers."}
                )
             
        response = await call_next(request)
        return response

logger = logging.getLogger(__name__)


# rbac.json is mounted read-only into the container; cached because it is read per request.
# Personas live here so a persona is resolved from the same file that grants tenant scope.
_RBAC_PATH = os.environ.get("RBAC_CONFIG_PATH", "/rbac.json")
_rbac_cache: dict | None = None


def load_rbac_config() -> dict:
    global _rbac_cache
    if _rbac_cache is None:
        for candidate in (_RBAC_PATH,
                          os.path.join(os.path.dirname(os.path.dirname(
                              os.path.abspath(__file__))), "rbac.json")):
            try:
                with open(candidate, encoding="utf-8") as fh:
                    _rbac_cache = json.load(fh)
                    break
            except (OSError, ValueError):
                continue
        else:
            _rbac_cache = {}
    return _rbac_cache


class AskRequest(_BaseModel):
    """An ad-hoc question. Persona is advisory; the server resolves it from identity."""
    question: str
    persona: str | None = None


class OutcomeRequest(_BaseModel):
    """Feedback on a published insight."""
    tenant_id: str
    investigation_id: str
    insight_id: str
    signal: str
    value: str
    actor: str


app.add_middleware(RBACMiddleware)

# P2-2. Starlette inserts at position 0, so the LAST added middleware is outermost. CORS must be
# added after RBAC so that RBAC's early 403 still passes back through it and reaches the browser
# as a 403 rather than an opaque CORS error.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Added LAST, so it is outermost and compresses everything the other middleware produce -- including
# CORS-decorated responses, whose headers are unaffected because only the body is compressed.
# These endpoints return JSON arrays of per-feature/per-day rows that compress by roughly 6x, and
# nothing was compressing them: a gzip-requesting client got the identical byte count back.
# minimum_size keeps small bodies uncompressed, where the CPU and header overhead would exceed
# the saving.
app.add_middleware(GZipMiddleware, minimum_size=1024)

from fastapi import WebSocket, WebSocketDisconnect
from api.websocket_manager import manager, start_websocket_background_tasks
from api.data_layer import start_data_layer_refresh

@app.on_event("startup")
async def startup_event():
    import asyncio
    asyncio.create_task(start_data_layer_refresh(interval_minutes=30))
    await start_websocket_background_tasks()

@app.websocket("/ws/dashboard/{tenant_id}")
async def websocket_dashboard(websocket: WebSocket, tenant_id: str):
    normalized_tenant = tenant_id.strip().lower()
    if normalized_tenant in TENANT_ALIAS_MAP:
        normalized_tenant = TENANT_ALIAS_MAP[normalized_tenant]

    if normalized_tenant not in TENANT_TO_APP:
        await websocket.close(code=1008)
        return

    await manager.connect(websocket, normalized_tenant)
    try:
        while True:
            # Wait for any incoming keep-alive or message
            _ = await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket closed abnormally for tenant %s", normalized_tenant)
    finally:
        # I4: only WebSocketDisconnect was caught, so any other exception stranded the socket
        # in active_connections and the 10s poller kept querying for a dead tenant.
        manager.disconnect(websocket, normalized_tenant)


@app.get("/tenants/available")
def get_available_tenants(
    request: Request,
    range: str = Query("90d", description="Time range like 7d, 30d"),
):
    """Returns all distinct tenants from ClickHouse, filtered by admin access if applicable."""
    _role = request.headers.get("X-User-Role", "")
    days = parse_range(range)
    # Always include known tenants in the base list so the dropdown is never empty
    KNOWN_TENANTS = [
        {"id": "nexabank", "name": "NexaBank", "eventCount": 0, "uniqueUsers": 0},
        {"id": "safexbank", "name": "SafexBank", "eventCount": 0, "uniqueUsers": 0},
    ]
    admin_apps = parse_admin_apps(request.headers.get("X-Admin-Apps", ""))
    active_app = normalize_app_id(request.headers.get("X-Active-App", ""))
    allowed_tenants = resolve_effective_allowed_tenants(admin_apps, active_app)
    if _role == "app_admin" and not allowed_tenants:
        return []
    try:
        # Phase E (item 8, docs/audits/clickhouse_pipeline_audit_phase1_findings.md): reads the
        # dedup-safe rollup instead of count()/uniq() over raw events_raw rows, which double
        # count under Kafka replay. Grouping by tenant_id only (dropping event_name/date) is a
        # valid uniqExactMerge use -- merging states across dates/events for one tenant.
        # Both columns are AggregateFunction(uniqExact, String); the Merge suffix MUST match
        # the state's own function or ClickHouse raises ILLEGAL_TYPE_OF_ARGUMENT.
        sql = """
            SELECT
                tenant_id as id,
                uniqExactMerge(event_count) as event_count,
                uniqExactMerge(unique_users) as unique_users
            FROM feature_intelligence.daily_feature_usage
            WHERE date >= toDate(now('UTC')) - %(days)s AND date < toDate(now('UTC'))
            GROUP BY tenant_id
            ORDER BY event_count DESC
        """
        results = ch_client.query(sql, {"days": days})
        found = {}
        for row in results:
            found[row["id"]] = {
                "id": row["id"],
                "name": row["id"].replace('_', ' ').title(),
                "eventCount": int(row["event_count"]),
                "uniqueUsers": int(row["unique_users"]),
            }
        # Merge: known tenants always present, update with real counts if found
        merged = []
        seen = set()
        for kt in KNOWN_TENANTS:
            entry = found.get(kt["id"], kt).copy()
            if kt["id"] in found:
                entry["name"] = kt["name"]  # Use our clean display name
            merged.append(entry)
            seen.add(kt["id"])
        # Add any extra tenants found in DB that aren't in known list
        for tid, tdata in found.items():
            if tid not in seen:
                merged.append(tdata)
                
        if _role == "app_admin" and allowed_tenants:
            return [tenant for tenant in merged if tenant["id"].lower() in allowed_tenants]
        return merged
    except Exception:
        if _role == "app_admin" and allowed_tenants:
            return [tenant for tenant in KNOWN_TENANTS if tenant["id"].lower() in allowed_tenants]
        if _role == "app_admin":
            return []
        return KNOWN_TENANTS


@app.get("/features/usage")
def get_feature_usage(tenants: str = Query(..., description="Comma-separated list of tenants"), range: str = Query("7d", description="Time range like 7d, 30d")):
    """
    Returns aggregated feature usage stats for a tenant (or comma-separated tenants) over the last N days.
    """
    days = parse_range(range)
    tenant_list = [t.strip() for t in tenants.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenant_list) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenant_list[0], "days": days} if len(tenant_list) == 1 else {"tenant_ids": tuple(tenant_list), "days": days}

    # Phase E (item 8): rollup instead of raw count()/uniq() -- grouped by event_name only
    # (dropping date), a valid uniqExactMerge use across the whole range.
    sql = f"""
        SELECT
            event_name,
            uniqExactMerge(event_count) as total_interactions,
            uniqExactMerge(unique_users) as unique_users
        FROM feature_intelligence.daily_feature_usage
        WHERE {cond} AND date >= toDate(now('UTC')) - %(days)s AND date < toDate(now('UTC'))
        GROUP BY event_name
        ORDER BY total_interactions DESC
    """
    try:
        results = ch_client.query(sql, params)

        merged = {}
        for row in results:
            raw_event = str(row.get("event_name", ""))
            canonical = canonicalize_event_name(raw_event)
            if not canonical:
                continue
            total = int(row.get("total_interactions", 0))
            unique_users = int(row.get("unique_users", 0))

            if canonical not in merged:
                merged[canonical] = {
                    "event_name": canonical,
                    "total_interactions": 0,
                    "unique_users": 0,
                }

            merged[canonical]["total_interactions"] += total
            # Avoid inflated counts when multiple aliases map to one canonical event.
            merged[canonical]["unique_users"] = max(
                merged[canonical]["unique_users"],
                unique_users,
            )

        usage = sorted(
            merged.values(),
            key=lambda item: item["total_interactions"],
            reverse=True,
        )

        return {"tenant_id": tenants, "period_days": days, "usage": usage}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/funnels")
def get_funnel_analysis(
    tenants: str = Query(..., description="Comma-separated list of tenants"),
    steps: str = Query(..., description="Comma-separated list of event names (e.g., login,apply,kyc,approve)"),
    window_minutes: int = Query(60, description="Minutes to complete the funnel"),
    range: str = Query("7d", description="Time range like 7d, 30d")
):
    """
    Advanced funnel analysis leveraging Clickhouse's windowFunnel.
    Computes conversion drop-offs between a sequence of events.
    """
    days = parse_range(range)
    tenant_list = [t.strip() for t in tenants.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenant_list) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenant_list[0], "days": days} if len(tenant_list) == 1 else {"tenant_ids": tuple(tenant_list), "days": days}
    params["window"] = window_minutes * 60

    step_events = [s.strip() for s in steps.split(",") if s.strip()]
    
    if len(step_events) < 2:
        raise HTTPException(status_code=400, detail="At least two steps required for a funnel.")

    # The alias dict is hand-maintained and only covers names given an EXPLICIT entry.
    # canonicalize_event_name also collapses names by RULE -- e.g. loan.kyc_started.action
    # (what enforceTaxonomy produces from free.loan.kyc_started) resolves to
    # loan.kyc_started.success without any dict entry. Expanding from the dict alone
    # therefore searched for names the producers never write, and the funnel read zero rows
    # while events_raw held thousands. Ask the data which raw names are present and
    # canonicalize those, so no producible form can be missed.
    try:
        present_rows = ch_client.query(
            f"""
            SELECT DISTINCT event_name
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
            """,
            params,
        )
        present_names = [str(r["event_name"]) for r in present_rows]
    except Exception:
        present_names = []

    def expand_step_aliases(step_name: str) -> list[str]:
        canonical = canonicalize_event_name(step_name) or step_name
        aliases = {
            step_name,
            canonical,
            normalize_event(step_name),
        }
        aliases.update({
            alias
            for alias, mapped in CANONICAL_EVENT_ALIASES.items()
            if mapped == canonical and alias
        })
        aliases.update({
            name for name in present_names
            if canonicalize_event_name(name) == canonical
        })
        return [a for a in sorted(aliases) if a]

    # BOUND, never interpolated. The previous sql_quote() only doubled single quotes, but
    # ClickHouse honours backslash escapes inside string literals -- so a step name ending in a
    # backslash escaped the closing quote and broke out of the IN list. Verified: a `steps=a\`
    # request returned a ClickHouse SYNTAX_ERROR straight to the caller. `steps` is caller
    # supplied, so that was arbitrary SQL against events_raw.
    step_variants = [expand_step_aliases(step) for step in step_events]
    condition_tokens = []
    for i, variants in enumerate(step_variants):
        key = f"step_variants_{i}"
        params[key] = tuple(variants) or ("",)
        condition_tokens.append(f"event_name IN %({key})s")
    conditions = ", ".join(condition_tokens)
    
    sql = f"""
        SELECT 
            level,
            count() as users_reached_level
        FROM (
            SELECT 
                user_id,
                windowFunnel(%(window)s)(
                    timestamp,
                    {conditions}
                ) as level
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
            GROUP BY user_id
        )
        GROUP BY level
        ORDER BY level ASC
    """
    try:
        results = ch_client.query(sql, params)
        
        levels_dict = {row['level']: row['users_reached_level'] for row in results}
        
        total_at_least_level = {}
        cumulative = 0
        for i in builtins_range(len(step_events), 0, -1):
            cumulative += levels_dict.get(i, 0)
            total_at_least_level[i] = cumulative
            
        funnel_stats = []
        for i, step_name in enumerate(step_events, 1):
            count = total_at_least_level.get(i, 0)
            drop_off = 0
            if i > 1:
                prev_count = total_at_least_level.get(i - 1, 0)
                drop_off = (prev_count - count) / prev_count if prev_count > 0 else 0.0
                
            funnel_stats.append({
                "step": i,
                "event_name": step_name,
                "users_completed": count,
                "drop_off_pct": round(drop_off * 100, 2)
            })

        return {"tenant_id": tenants, "funnel": funnel_stats}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/insights")
def get_insights(tenants: str = Query(..., description="Comma-separated list of tenants")):
    """
    Returns AI/Rule-based actionable insights for a tenant. 
    Detects features that are not being used or sudden spikes.
    """
    tenant_id = tenants
    require_tenant_access(tenant_id)

    # TTL is enforced on the READ. AI_CACHE_TTL was declared but only ever compared inside
    # /ai_report, so this path served an entry of any age -- a 56-year-old planted entry came
    # back as cached: True. `"insights" in` rather than truthiness so an empty-but-fresh result
    # is also honoured instead of being recomputed on every request.
    cached_data = AI_REPORT_CACHE.get(tenant_id)
    if (cached_data and "insights" in cached_data
            and time.time() - cached_data.get("timestamp", 0) < AI_CACHE_TTL):
        return {"tenant_id": tenant_id, "insights": cached_data["insights"], "cached": True}

    # Try loading from ClickHouse if in-memory cache is empty
    import json as _json
    try:
        # Bounded by the same TTL. ai_reports is ReplacingMergeTree(generated_at) with no expiry,
        # so without this bound a report generated weeks ago was returned as cached: True.
        sql_db = """
            SELECT insights FROM feature_intelligence.ai_reports FINAL
            WHERE tenant_id = %(tenant_id)s
              AND generated_at >= now('UTC') - toIntervalSecond(%(ttl)s)
            LIMIT 1
        """
        db_rows = ch_client.query(sql_db, {"tenant_id": tenant_id, "ttl": int(AI_CACHE_TTL)})
        if db_rows and db_rows[0].get("insights"):
            raw = db_rows[0]["insights"]
            parsed = _json.loads(raw) if isinstance(raw, str) else raw
            if parsed:
                return {"tenant_id": tenant_id, "insights": parsed, "cached": True}
    except Exception:
        pass

    insights_data = generate_insights(tenant_id)
    # Stamp the CURRENT time. Carrying the previous entry's timestamp forward meant an entry could
    # never be refreshed into looking fresh once a TTL was applied to the read.
    AI_REPORT_CACHE[tenant_id] = {
        **AI_REPORT_CACHE.get(tenant_id, {}),
        "timestamp": time.time(),
        "insights": insights_data,
        "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
    }
    return {"tenant_id": tenant_id, "insights": insights_data, "cached": False}

@app.get("/metrics/kpi")
def get_kpi_metrics(tenants: str = Query(..., description="Comma-separated list of tenants"), range: str = Query("7d", description="Time range like 7d, 30d")):
    days = parse_range(range)
    tenant_id = tenants
    import math

    tenants = [t.strip() for t in tenant_id.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenants) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenants[0], "days": days} if len(tenants) == 1 else {"tenant_ids": tuple(tenants), "days": days}
    
    try:
        # --- Current period ---
        # count(distinct event_name) counts RAW names, so aliases of one feature (e.g.
        # dashboard.page.view and free.dashboard.view) registered as two features while
        # /features/usage correctly showed one. Canonicalize in Python, then count.
        sql_current = f"""
            SELECT 
                uniqExact({DEDUP_EVENT_KEY}) as total_events,
                groupUniqArray(event_name) as event_names
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
        """
        res_current = ch_client.query(sql_current, params)
        cur = res_current[0] if res_current else {"total_events": 0, "event_names": []}
        cur = {
            "total_events": cur.get("total_events") or 0,
            "active_features": count_canonical_features(cur.get("event_names") or []),
        }

        sql_prev = f"""
            SELECT 
                uniqExact({DEDUP_EVENT_KEY}) as total_events,
                groupUniqArray(event_name) as event_names
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - (%(days)s * 2) AND timestamp < toDate(now('UTC')) - %(days)s
        """
        res_prev = ch_client.query(sql_prev, params)
        prev = res_prev[0] if res_prev else {"total_events": 0, "event_names": []}
        prev = {
            "total_events": prev.get("total_events") or 0,
            "active_features": count_canonical_features(prev.get("event_names") or []),
        }

        def pct_change(current_val: int, previous_val: int) -> tuple:
            if previous_val == 0:
                return (0.0, "up")
            change = ((current_val - previous_val) / previous_val) * 100
            return (round(abs(change), 1), "up" if change >= 0 else "down")

        events_change, events_dir = pct_change(cur["total_events"] or 0, prev["total_events"] or 0)
        features_change, features_dir = pct_change(cur["active_features"] or 0, prev["active_features"] or 0)

        # There is no measured latency on most rows: when metadata has no response_time_ms
        # this synthesises one from a hash. CLAUDE.md forbids fabricating a metric SILENTLY,
        # so also count how many rows were synthesised and surface it as `simulated` on the
        # card. The value stays as-is; what changes is that the UI can now say so.
        # Phase E (item 8): avg()/count()/countIf() over raw rows double-count a replayed
        # event. Collapse to one row per logical event first (any() picks a value from the
        # group -- fine since exact duplicates carry identical fields), then aggregate.
        sql_response = f"""
            SELECT avg(rt) as avg_rt,
                   countIf(NOT has_measured) as synthesised,
                   count() as total_rows
            FROM (
                SELECT
                    min(if(JSONHas(metadata, 'response_time_ms'), JSONExtractFloat(metadata, 'response_time_ms'), 15 + (cityHash64(event_name, toString(timestamp)) %% 285))) as rt,
                    -- P0-9. Presence of the key proved nothing: the producer always set it, to a
                    -- simulated value, so `synthesised` was structurally 0 and the honesty badge
                    -- could never fire. The producer now declares what it invented in
                    -- metadata._simulated, so ask that instead.
                    min(JSONHas(metadata, 'response_time_ms')
                        AND NOT has(JSONExtractArrayRaw(metadata, '_simulated'), '\"response_time_ms\"')) as has_measured
                FROM feature_intelligence.events_raw
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
                GROUP BY {DEDUP_EVENT_KEY}
            )
        """
        res_rt = ch_client.query(sql_response, params)
        rt_synthesised = int(res_rt[0].get("synthesised") or 0) if res_rt else 0
        rt_total_rows = int(res_rt[0].get("total_rows") or 0) if res_rt else 0
        raw_rt = res_rt[0]["avg_rt"] if res_rt and "avg_rt" in res_rt[0] else 0
        if raw_rt is None or (isinstance(raw_rt, float) and math.isnan(raw_rt)):
            avg_rt = 0
        else:
            avg_rt = int(raw_rt)

        sql_response_prev = f"""
            SELECT avg(rt) as avg_rt
            FROM (
                SELECT
                    min(if(JSONHas(metadata, 'response_time_ms'), JSONExtractFloat(metadata, 'response_time_ms'), 15 + (cityHash64(event_name, toString(timestamp)) %% 285))) as rt
                FROM feature_intelligence.events_raw
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - (%(days)s * 2) AND timestamp < toDate(now('UTC')) - %(days)s
                GROUP BY {DEDUP_EVENT_KEY}
            )
        """
        res_rt_prev = ch_client.query(sql_response_prev, params)
        raw_rt_prev = res_rt_prev[0]["avg_rt"] if res_rt_prev and "avg_rt" in res_rt_prev[0] else 0
        if raw_rt_prev is None or (isinstance(raw_rt_prev, float) and math.isnan(raw_rt_prev)):
            avg_rt_prev = 0
        else:
            avg_rt_prev = int(raw_rt_prev)

        rt_change, rt_dir = pct_change(avg_rt, avg_rt_prev)
        rt_display = f"{avg_rt} ms" if avg_rt > 0 else "0 ms"

        sql_error = f"""
            SELECT
                uniqExactIf({DEDUP_EVENT_KEY}, lower(event_name) LIKE '%%error%%' OR lower(event_name) LIKE '%%fail%%') as error_events,
                uniqExact({DEDUP_EVENT_KEY}) as total
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
        """
        res_err = ch_client.query(sql_error, params)
        err_row = res_err[0] if res_err else {"error_events": 0, "total": 1}
        total_for_err = err_row["total"] if err_row["total"] > 0 else 1
        error_rate = round((err_row["error_events"] / total_for_err) * 100, 1)

        sql_error_prev = f"""
            SELECT
                uniqExactIf({DEDUP_EVENT_KEY}, lower(event_name) LIKE '%%error%%' OR lower(event_name) LIKE '%%fail%%') as error_events,
                uniqExact({DEDUP_EVENT_KEY}) as total
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - (%(days)s * 2) AND timestamp < toDate(now('UTC')) - %(days)s
        """
        res_err_prev = ch_client.query(sql_error_prev, params)
        err_prev_row = res_err_prev[0] if res_err_prev else {"error_events": 0, "total": 1}
        total_prev_err = err_prev_row["total"] if err_prev_row["total"] > 0 else 1
        error_rate_prev = round((err_prev_row["error_events"] / total_prev_err) * 100, 1)
        err_change, err_dir = pct_change(int(error_rate * 10), int(error_rate_prev * 10))

        return [
            {
                "id": "total-events",
                "label": "Total Events",
                "value": f"{cur['total_events']:,}" if cur['total_events'] else "0",
                "change": events_change,
                "changeDirection": events_dir,
                "icon": "activity",
            },
            {
                "id": "active-features",
                "label": "Active Features",
                "value": str(cur['active_features'] or 0),
                "change": features_change,
                "changeDirection": features_dir,
                "icon": "layers",
            },
            {
                "id": "avg-response",
                "label": "Avg. Response Time",
                "value": rt_display,
                "change": rt_change,
                "changeDirection": rt_dir,
                "icon": "clock",
                "simulated": rt_synthesised > 0,
                "simulatedNote": (
                    f"{rt_synthesised} of {rt_total_rows} events carry no measured latency; "
                    "those values are synthesised in the forwarding layer."
                ) if rt_synthesised > 0 else "",
            },
            {
                "id": "error-rate",
                "label": "Error Rate",
                "value": f"{error_rate}%",
                "change": err_change,
                "changeDirection": err_dir,
                "icon": "shield-alert",
            },
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/metrics/secondary_kpi")
def get_secondary_kpi(tenants: str = Query(..., description="Comma-separated list of tenants"), range: str = Query("7d", description="Time range like 7d, 30d")):
    days = parse_range(range)
    tenant_id = tenants
    tenants = [t.strip() for t in tenant_id.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenants) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenants[0], "days": days} if len(tenants) == 1 else {"tenant_ids": tuple(tenants), "days": days}
    
    try:
        def pct_change(current_val: float, previous_val: float) -> tuple:
            if previous_val == 0:
                return (0.0, "up")
            change = ((current_val - previous_val) / previous_val) * 100
            return (round(abs(change), 1), "up" if change >= 0 else "down")

        # Phase E (item 8): uniqExact(DEDUP_EVENT_KEY) instead of count() -- see the constant's
        # definition above for why this exact expression, not a different fallback shape.
        sql_basic = f"""
            SELECT
                uniqExact({DEDUP_EVENT_KEY}) as total_visits,
                uniqExact(user_id) as unique_visitors
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
        """
        res_basic = ch_client.query(sql_basic, params)
        basic = res_basic[0] if res_basic else {"total_visits": 0, "unique_visitors": 0}

        sql_basic_prev = f"""
            SELECT
                uniqExact({DEDUP_EVENT_KEY}) as total_visits,
                uniqExact(user_id) as unique_visitors
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - (%(days)s * 2) AND timestamp < toDate(now('UTC')) - %(days)s
        """
        res_basic_prev = ch_client.query(sql_basic_prev, params)
        basic_prev = res_basic_prev[0] if res_basic_prev else {"total_visits": 0, "unique_visitors": 0}
        
        visits_change, visits_dir = pct_change(basic['total_visits'], basic_prev['total_visits'])
        unique_change, unique_dir = pct_change(basic['unique_visitors'], basic_prev['unique_visitors'])

        # Phase E: the inner per-user event_count must be dedup-safe -- otherwise a duplicated
        # single-event visit reads event_count=2 and is wrongly excluded from "bounced". The
        # outer count() here counts SUBQUERY ROWS (one per distinct user_id), which is already
        # immune to event-row duplication -- left as-is.
        sql_bounce = f"""
            SELECT
                count() as total_users,
                countIf(event_count = 1) as bounced_users
            FROM (
                SELECT user_id, uniqExact({DEDUP_EVENT_KEY}) as event_count
                FROM feature_intelligence.events_raw
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
                GROUP BY user_id
            )
        """
        res_bounce = ch_client.query(sql_bounce, params)
        b_users = res_bounce[0]["bounced_users"] if res_bounce else 0
        t_users = res_bounce[0]["total_users"] if res_bounce else 1
        t_users = t_users if t_users > 0 else 1
        bounce_rate = round((b_users / t_users) * 100, 1)

        sql_bounce_prev = f"""
            SELECT
                count() as total_users,
                countIf(event_count = 1) as bounced_users
            FROM (
                SELECT user_id, uniqExact({DEDUP_EVENT_KEY}) as event_count
                FROM feature_intelligence.events_raw
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - (%(days)s * 2) AND timestamp < toDate(now('UTC')) - %(days)s
                GROUP BY user_id
            )
        """
        res_bounce_prev = ch_client.query(sql_bounce_prev, params)
        b_users_prev = res_bounce_prev[0]["bounced_users"] if res_bounce_prev else 0
        t_users_prev = res_bounce_prev[0]["total_users"] if res_bounce_prev else 1
        t_users_prev = t_users_prev if t_users_prev > 0 else 1
        bounce_rate_prev = round((b_users_prev / t_users_prev) * 100, 1)
        
        bounce_change, bounce_dir = pct_change(bounce_rate, bounce_rate_prev)

        sql_time = f"""
            SELECT avg(session_duration) as avg_time
            FROM (
                SELECT user_id, toDate(timestamp) as d, dateDiff('second', min(timestamp), max(timestamp)) as session_duration
                FROM feature_intelligence.events_raw
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
                GROUP BY user_id, d
                HAVING session_duration > 0 AND session_duration < 3600 * 4
            )
        """
        import math
        res_time = ch_client.query(sql_time, params)
        raw_avg = res_time[0]["avg_time"] if res_time and "avg_time" in res_time[0] else 0
        if raw_avg is None or (isinstance(raw_avg, float) and math.isnan(raw_avg)):
            avg_time_sec = 0
        else:
            avg_time_sec = int(raw_avg)
            
        sql_time_prev = f"""
            SELECT avg(session_duration) as avg_time
            FROM (
                SELECT user_id, toDate(timestamp) as d, dateDiff('second', min(timestamp), max(timestamp)) as session_duration
                FROM feature_intelligence.events_raw
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - (%(days)s * 2) AND timestamp < toDate(now('UTC')) - %(days)s
                GROUP BY user_id, d
                HAVING session_duration > 0 AND session_duration < 3600 * 4
            )
        """
        res_time_prev = ch_client.query(sql_time_prev, params)
        raw_avg_prev = res_time_prev[0]["avg_time"] if res_time_prev and "avg_time" in res_time_prev[0] else 0
        if raw_avg_prev is None or (isinstance(raw_avg_prev, float) and math.isnan(raw_avg_prev)):
            avg_time_sec_prev = 0
        else:
            avg_time_sec_prev = int(raw_avg_prev)
            
        time_change, time_dir = pct_change(avg_time_sec, avg_time_sec_prev)

        mins = avg_time_sec // 60
        secs = avg_time_sec % 60
        avg_time_str = f"{mins}m {secs}s" if avg_time_sec > 0 else "0m 0s"

        return [
            {
                "id": "total-visits",
                "label": "Total Visits",
                "value": f"{basic['total_visits']:,}",
                "change": visits_change,
                "changeDirection": visits_dir,
                "icon": "globe",
            },
            {
                "id": "unique-visitors",
                "label": "Unique Visitors",
                "value": f"{basic['unique_visitors']:,}",
                "change": unique_change,
                "changeDirection": unique_dir,
                "icon": "users",
            },
            {
                "id": "avg-session",
                "label": "Avg. Session Time",
                "value": avg_time_str,
                "change": time_change,
                "changeDirection": time_dir,
                "icon": "clock",
            },
            {
                "id": "bounce-rate",
                "label": "Bounce Rate",
                "value": f"{bounce_rate}%",
                "change": bounce_change,
                "changeDirection": bounce_dir,
                "icon": "trending-down",
            }
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/metrics/traffic")
def get_traffic_data(tenants: str = Query(..., description="Comma-separated list of tenants"), range: str = Query("7d", description="Time range like 7d, 30d")):
    """
    Time series data for traffic overview. Pivot if comma-separated.
    """
    days = parse_range(range)
    tenant_id = tenants
    try:
        tenants = [t.strip() for t in tenant_id.split(",") if t.strip()]
        if len(tenants) == 1:
            # Phase E (item 8): dedup-safe count. Direct pattern, not the rollup -- the +330min
            # IST offset shifts day boundaries before truncation, which the rollup's own `date`
            # (plain UTC toDate(timestamp), no offset) does not replicate; swapping to the
            # rollup here would silently move events near midnight IST into the wrong bucket.
            sql = f"""
                SELECT
                    toDate(timestamp) as date,
                    uniqExact({DEDUP_EVENT_KEY}) as pageViews,
                    uniq(user_id) as visitors
                FROM feature_intelligence.events_raw
                WHERE tenant_id = %(tenant_id)s AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
                GROUP BY date
                ORDER BY date ASC
            """
            return ch_client.query(sql, {"tenant_id": tenants[0], "days": days})
        else:
            sql = f"""
                SELECT
                    toDate(timestamp) as date,
                    tenant_id,
                    uniqExact({DEDUP_EVENT_KEY}) as pageViews,
                    uniq(user_id) as visitors
                FROM feature_intelligence.events_raw
                WHERE tenant_id IN %(tenant_ids)s AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
                GROUP BY date, tenant_id
                ORDER BY date ASC
            """
            results = ch_client.query(sql, {"tenant_ids": tuple(tenants), "days": days})
            date_map = {}
            for r in results:
                d = r["date"].strftime("%Y-%m-%d") if hasattr(r["date"], "strftime") else r["date"]
                t = r["tenant_id"]
                if d not in date_map:
                    date_map[d] = {"date": d}
                date_map[d][f"{t}_pageViews"] = r["pageViews"]
                date_map[d][f"{t}_visitors"] = r["visitors"]
            return list(date_map.values())
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/tenants")
def get_all_tenants(tenant_id: Optional[str] = None, range: str = Query("7d", description="Time range like 7d, 30d")):
    """
    Returns list of distinct tenants with real metrics from ClickHouse.
    If tenant_id is provided, returns only that tenant's data (for app_admin).
    """
    try:
        days = parse_range(range)
        where_clause = ""
        params = {"days": days}
        # We explicitly remove the restriction on tenant_id so that app_admins 
        # can see all tenants for comparison as requested by the user.

        # Phase E (item 8): rollup pattern for all four -- daily_feature_usage carries
        # event_name as a plain column (uniqExact still valid, no -Merge needed for it) and
        # unique_users as a mergeable state; uniqExactMergeIf already has precedent in this
        # codebase (api/data_layer.py's trending query).
        sql = f"""
            SELECT
                tenant_id as id,
                tenant_id as name,
                toUInt64(uniqExactMerge(event_count)) as featureUsage,
                toUInt64(uniqExact(event_name)) as activeFeatures,
                toUInt64(uniqExactMerge(unique_users)) as uniqueUsers,
                uniqExactMergeIf(event_count, lower(event_name) LIKE '%%error%%' OR lower(event_name) LIKE '%%fail%%') as errorCount
            FROM feature_intelligence.daily_feature_usage
            {where_clause}
            WHERE date >= toDate(now('UTC')) - %(days)s AND date < toDate(now('UTC'))
            GROUP BY tenant_id
            ORDER BY featureUsage DESC
        """
        results = ch_client.query(sql, params)
        tenants = []
        for row in results:
            total = int(row['featureUsage']) or 1
            errors = int(row.get('errorCount', 0))
            unique_users = int(row.get('uniqueUsers', 0))
            active_features = int(row.get('activeFeatures', 0))
            adoption = round((active_features / max(active_features + 2, 1)) * 100) if active_features else 0
            tenants.append({
                "id": row['id'],
                "name": row['name'].replace('_', ' ').title(),
                "featureUsage": total,
                "errors": errors,
                "adoptionRate": min(adoption, 100),
                "plan": "enterprise",
                "uniqueUsers": unique_users,
                "activeFeatures": active_features,
            })
        return tenants
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

PROVENANCE_DIMENSIONS = ("location", "city", "continent", "device_type", "channel",
                         "response_time_ms")


@app.get("/metrics/dimension_provenance")
def get_dimension_provenance(
    tenants: str = Query(..., description="Comma-separated list of tenants"),
    range: str = Query("7d", description="Time range like 7d, 30d"),
):
    """Which metadata dimensions were fabricated by the producer, and for what share of events.

    Reads `metadata._simulated`, the marker every producer sets for keys it invented rather than
    measured. This is the read side of CLAUDE.md's "never fabricate a metric silently": a chart
    built on a dimension that comes back `simulated` here has to say so, the same way the Avg
    Response Time KPI card already does.

    Additive on purpose. Wrapping /locations or /metrics/devices to carry the flag would change
    two response shapes and every consumer of them (rule 6) for a signal that is per-tenant and
    per-range, not per-row.
    """
    days = parse_range(range)
    tenant_list = [t.strip() for t in tenants.split(",") if t.strip()]
    if not tenant_list:
        raise HTTPException(status_code=400, detail="tenants is required")
    cond = "tenant_id = %(tenant_id)s" if len(tenant_list) == 1 else "tenant_id IN %(tenant_ids)s"
    params = ({"tenant_id": tenant_list[0], "days": days} if len(tenant_list) == 1
              else {"tenant_ids": tuple(tenant_list), "days": days})

    # A key counts as simulated when the marker names it. Bounded at both ends, equal-length
    # windows not needed here -- this is a share within one window, not a period comparison.
    sep = "," + chr(10) + " " * 12
    marked = sep.join(
        f"uniqExactIf({DEDUP_EVENT_KEY}, has(JSONExtractArrayRaw(metadata, '_simulated'), "
        f"'\"{dim}\"')) as sim_{dim}"
        for dim in PROVENANCE_DIMENSIONS
    )
    sql = f"""
        SELECT
            uniqExact({DEDUP_EVENT_KEY}) as total,
            {marked}
        FROM feature_intelligence.events_raw
        WHERE {cond}
          AND timestamp >= toDate(now('UTC')) - %(days)s
          AND timestamp < toDate(now('UTC'))
    """
    try:
        rows = ch_client.query(sql, params)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    row = rows[0] if rows else {}
    total = int(row.get("total") or 0)
    dimensions = {}
    for dim in PROVENANCE_DIMENSIONS:
        sim = int(row.get(f"sim_{dim}") or 0)
        pct = round((sim / total) * 100, 1) if total else 0.0
        dimensions[dim] = {
            "simulated_events": sim,
            "total_events": total,
            "simulated_pct": pct,
            # Any fabrication at all is disclosed. A dimension that is 30% invented cannot carry a
            # contribution share honestly either, so there is no threshold below which it is fine.
            "simulated": sim > 0,
        }
    return {
        "tenant_id": ",".join(tenant_list),
        "time_range": range,
        "total_events": total,
        "dimensions": dimensions,
    }


@app.get("/metrics/realtime_users")
def get_realtime_users(tenants: str = Query(..., description="Comma-separated list of tenants")):
    """Returns real-time active user count with IST timestamp context.

    Active users are calculated by latest session state:
      1) Session seen in the last 5 minutes
      2) Latest event for that session is NOT a logout/session-end marker
    """
    tenant_id = tenants
    from datetime import timezone, timedelta

    IST = timezone(timedelta(hours=5, minutes=30))

    tenant_list = [t.strip() for t in tenant_id.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenant_list) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenant_list[0]} if len(tenant_list) == 1 else {"tenant_ids": tuple(tenant_list)}

    sql = f"""
        WITH session_states AS (
            SELECT
                user_id,
                -- session_id is a real column since FOUNDATION-2. Prefer it; keep the
                -- metadata read as a fallback for rows written before the column existed,
                -- and the user_id fallback for rows that never carried a session at all.
                multiIf(
                    length(session_id) > 0, session_id,
                    JSONHas(metadata, 'session_id') AND length(JSONExtractString(metadata, 'session_id')) > 0,
                        JSONExtractString(metadata, 'session_id'),
                    concat('user:', user_id)
                ) as session_id,
                max(timestamp) as last_seen,
                argMax(event_name, timestamp) as last_event
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= now('UTC') - INTERVAL 30 MINUTE
            GROUP BY user_id, session_id
        )
        SELECT uniqExact(user_id) as users
        FROM session_states
        WHERE last_seen >= now('UTC') - INTERVAL 5 MINUTE
          AND NOT match(lower(last_event), '(logout|signout|session_end)')
    """

    try:
        results = ch_client.query(sql, params)
        user_count = int(results[0]['users']) if results else 0
        now_ist = datetime.now(IST)
        return {
            "count": user_count,
            "timestamp_ist": now_ist.strftime("%Y-%m-%dT%H:%M:%S+05:30"),
            "timezone": "Asia/Kolkata"
        }
    except Exception:
        return {"count": 0, "timestamp_ist": None, "timezone": "Asia/Kolkata"}

@app.get("/deployment/info")
def get_deployment_info():
    return {
        "mode": settings.DEPLOYMENT_MODE,
        "is_cloud": settings.is_cloud,
        "is_on_prem": settings.is_on_prem,
        "local_tenant": settings.TENANT_ID if settings.is_on_prem else None
    }

@app.get("/admin/summary")
def get_admin_summary(range: str = Query("30d", description="Time range like 7d, 30d, 90d")):
    """Returns high-level global aggregated stats (Cloud mode only)."""
    require_cloud_mode()
    try:
        days = parse_range(range)
        sql = """
            SELECT count(distinct tenant_id) as total_tenants, 
                   uniqExactMerge(event_count) as total_events
            FROM feature_intelligence.daily_feature_usage
            WHERE date >= toDate(now('UTC')) - %(days)s AND date < toDate(now('UTC'))
        """
        basic_rows = ch_client.query(sql, {"days": days})
        basic = basic_rows[0] if basic_rows else {"total_tenants": 0, "total_events": 0}
        
        sql_top = """
            SELECT tenant_id as name, uniqExactMerge(event_count) as events
            FROM feature_intelligence.daily_feature_usage
            WHERE date >= toDate(now('UTC')) - %(days)s AND date < toDate(now('UTC'))
            GROUP BY tenant_id
            ORDER BY events DESC LIMIT 5
        """
        top_tenants_raw = ch_client.query(sql_top, {"days": days})
        top_tenants = [
            {"id": row["name"], "name": row["name"].capitalize(), "events": int(row["events"])} 
            for row in top_tenants_raw
        ]
        
        return {
            "total_tenants": basic["total_tenants"],
            "total_events": basic["total_events"],
            "top_tenants": top_tenants,
            "time_range": range,
            "available": True,
        }
    except Exception as e:
        return {
            "total_tenants": 0,
            "total_events": 0,
            "top_tenants": [],
            "time_range": range,
            "available": False,
        }

@app.get("/admin/app/{tenant_id}/summary")
def get_admin_app_summary(tenants: str = Query(..., description="Comma-separated list of tenants"), range: str = Query("7d", description="Time range like 7d, 30d")):
    """Returns basic KPIs and Insights for a specfic app (Cloud mode only)."""
    tenant_id = tenants
    require_cloud_mode()
    return {
        "kpi": get_kpi_metrics(tenants=tenant_id, range=range),
        "insights": get_insights(tenants=tenant_id, range=range)["insights"]
    }

from api.schemas import LicenseSyncRequest, TrackingToggleRequest

@app.get("/metrics/pro_users")
def get_pro_users(
    tenants: str = Query(..., description="Comma-separated list of tenants"), 
    range: str = Query("7d", description="Time range like 7d, 30d")
):
    """
    Returns count of users who have used any pro/enterprise feature in the given time range.
    Dynamically respects the global time range selector.
    """
    days = parse_range(range)
    tenant_list = [t.strip() for t in tenants.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenant_list) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenant_list[0], "days": days} if len(tenant_list) == 1 else {"tenant_ids": tuple(tenant_list), "days": days}

    try:
        # Pro/Enterprise features from the catalog
        pro_features = {
            "crypto-trading.trade_execution.success",
            "crypto-trading.trade_execution.failure",
            "crypto-trading.price_feeds.view",
            "crypto-trading.portfolio.view",
            "wealth-management-pro.rebalance.success",
            "wealth-management-pro.rebalance.failure",
            "wealth-management-pro.insights.view",
            "bulk-payroll-processing.batch.success",
            "bulk-payroll-processing.batch.failure",
            "bulk-payroll-processing.payees.view",
            "bulk-payroll-processing.search.success",
            "bulk-payroll-processing.search.failure",
            "ai-insights.book.access",
            "ai-insights.book.success",
            "ai-insights.stats.view",
        }
        
        # Also include raw feature names that map to pro features
        pro_raw_features = {
            alias for alias, canonical in CANONICAL_EVENT_ALIASES.items()
            if canonical in pro_features and alias
        }
        pro_raw_features.update(pro_features)
        
        # Query unique users who have used any pro feature
        pro_str = ", ".join([f"'{f}'" for f in sorted(pro_raw_features)])
        sql = f"""
            SELECT uniqExact(user_id) as pro_users
            FROM feature_intelligence.events_raw
            WHERE {cond} AND event_name IN ({pro_str}) AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
        """
        
        result = ch_client.query(sql, params)
        pro_user_count = int(result[0]["pro_users"]) if result and result[0].get("pro_users") else 0
        
        # Also get total users for comparison
        sql_total = f"""
            SELECT uniqExact(user_id) as total_users
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
        """
        total_result = ch_client.query(sql_total, params)
        total_users = max(int(total_result[0]["total_users"]) if total_result else 0, 1)
        
        pro_adoption_pct = round((pro_user_count / total_users) * 100, 1) if total_users > 0 else 0
        
        return {
            "tenant_id": tenants,
            "range": range,
            "period_days": days,
            "pro_users": pro_user_count,
            "total_users": total_users,
            "pro_adoption_pct": pro_adoption_pct,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════
# LICENSE VS USAGE
# ═══════════════════════════════════════════════════════════


@app.get("/license/usage")
def get_license_usage(tenants: str = Query(..., description="Comma-separated list of tenants"), range: str = Query("30d", description="Time range like 7d, 30d")):
    """Compare licensed features vs actual usage — multi-tenant aware with proper IN clause."""
    require_tenant_access(tenants)
    days = parse_range(range)
    tenant_list = [t.strip() for t in tenants.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenant_list) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenant_list[0], "days": days} if len(tenant_list) == 1 else {"tenant_ids": tuple(tenant_list), "days": days}

    try:
        # 1. Single source of truth catalog
        feature_catalog = {
            # Enterprise
            "crypto-trading.page.view": {"plan": "enterprise"},
            "crypto-trading.trade_execution.success": {"plan": "enterprise"},
            "crypto-trading.trade_execution.failure": {"plan": "enterprise"},
            "crypto-trading.price_feeds.view": {"plan": "enterprise"},
            "crypto-trading.portfolio.view": {"plan": "enterprise"},
            "wealth-management-pro.page.view": {"plan": "enterprise"},
            "wealth-management-pro.rebalance.success": {"plan": "enterprise"},
            "wealth-management-pro.rebalance.failure": {"plan": "enterprise"},
            "wealth-management-pro.insights.view": {"plan": "enterprise"},
            "bulk-payroll-processing.page.view": {"plan": "enterprise"},
            "bulk-payroll-processing.batch.success": {"plan": "enterprise"},
            "bulk-payroll-processing.batch.failure": {"plan": "enterprise"},
            "bulk-payroll-processing.payees.view": {"plan": "enterprise"},
            "bulk-payroll-processing.search.success": {"plan": "enterprise"},
            "bulk-payroll-processing.search.failure": {"plan": "enterprise"},
            "ai-insights.page.view": {"plan": "enterprise"},
            "ai-insights.book.access": {"plan": "enterprise"},
            "ai-insights.book.success": {"plan": "enterprise"},
            "ai-insights.stats.view": {"plan": "enterprise"},
            
            # Free / Base
            "dashboard.page.view": {"plan": "free"},
            "login.auth.success": {"plan": "free"},
            "login.auth.failure": {"plan": "free"},
            "register.auth.success": {"plan": "free"},
            "register.auth.failure": {"plan": "free"},
            "transaction.pay_now.success": {"plan": "free"},
            "transaction.pay_now.failure": {"plan": "free"},
            "account.page.view": {"plan": "free"},
            "transaction.page.view": {"plan": "free"},
            "payee.page.view": {"plan": "free"},
            "payee.add_payee.success": {"plan": "free"},
            "payee.add_payee.failure": {"plan": "free"},
            "payee.edit_payee.success": {"plan": "free"},
            "payee.edit_payee.failure": {"plan": "free"},
            "payee.remove_payee.success": {"plan": "free"},
            "payee.remove_payee.failure": {"plan": "free"},
            "loan.applied.success": {"plan": "free"},
            "loan.approved.success": {"plan": "free"},
            "loan.rejected.failure": {"plan": "free"},
            "loan.page.view": {"plan": "free"},
            "loan.kyc_started.success": {"plan": "free"},
            "loan.kyc_completed.success": {"plan": "free"},
            "loan.kyc_failed.failure": {"plan": "free"},
            "loan.kyc_abandoned.failure": {"plan": "free"},
            "profile.page.view": {"plan": "free"},
            "profile.edit_details.success": {"plan": "free"},
            "profile.edit_details.failure": {"plan": "free"},
            "dashboard.location.captured": {"plan": "free"},
        }
        # Phase E (item 8): direct pattern, not the rollup -- tier_hint reads raw metadata,
        # which daily_feature_usage doesn't carry, so this can't move to the rollup wholesale.
        sql_used = f"""
            SELECT
                event_name as feature_name,
                uniqExact({DEDUP_EVENT_KEY}) as usage_count,
                uniqExact(user_id) as unique_users,
                max(JSONExtractString(metadata, 'tier')) as tier_hint
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
            GROUP BY feature_name
            ORDER BY usage_count DESC
        """
        used = ch_client.query(sql_used, params)
        used_map = {}
        for r in used:
            canonical = canonicalize_event_name(str(r["feature_name"]))
            if not canonical:
                continue
            usage_count = int(r["usage_count"])
            unique_users = int(r["unique_users"])
            tier_hint = r.get("tier_hint")
            if canonical not in used_map:
                used_map[canonical] = {
                    "feature_name": canonical,
                    "usage_count": 0,
                    "unique_users": 0,
                    "tier_hint": None,
                }
            used_map[canonical]["usage_count"] += usage_count
            # Avoid inflating users when multiple raw aliases map to one canonical feature.
            used_map[canonical]["unique_users"] = max(int(used_map[canonical]["unique_users"]), unique_users)
            if not used_map[canonical]["tier_hint"] and tier_hint:
                used_map[canonical]["tier_hint"] = tier_hint

        canonical_catalog = {
            canonicalize_event_name(key): value
            for key, value in feature_catalog.items()
            if canonicalize_event_name(key)
        }

        pro_features_set = {k for k, v in canonical_catalog.items() if v["plan"] == "enterprise"}
        pro_raw_features = {
            alias for alias, canonical in CANONICAL_EVENT_ALIASES.items()
            if canonical in pro_features_set and alias
        }
        pro_raw_features.update(pro_features_set)

        # ─── Usage trends (last 7 days) ───
        # Phase E (item 8): rollup pattern -- exact grain match, (event_name, date).
        sql_trends = f"""
            SELECT event_name as feature_name, date, uniqExactMerge(event_count) as count
            FROM feature_intelligence.daily_feature_usage
            WHERE {cond} AND date >= toDate(now('UTC')) - 7
            GROUP BY feature_name, date
            ORDER BY date ASC
        """
        trend_rows = ch_client.query(sql_trends, params)
        trends_map = {}
        for r in trend_rows:
            fname = canonicalize_event_name(str(r["feature_name"]))
            if not fname:
                continue
            date_str = r["date"].strftime("%Y-%m-%d") if hasattr(r["date"], "strftime") else str(r["date"])
            if fname not in trends_map:
                trends_map[fname] = {}
            trends_map[fname][date_str] = trends_map[fname].get(date_str, 0) + int(r["count"])

        trends_map = {
            fname: [
                {"date": d, "count": c}
                for d, c in sorted(by_date.items())
            ]
            for fname, by_date in trends_map.items()
        }
            
        # Build lists based strictly on catalog mapping
        total_usage_count = sum(int(r["usage_count"]) for r in used_map.values()) or 1
        total_pro_usage_count = sum(
            int(used_map.get(fname, {}).get("usage_count", 0))
            for fname in pro_features_set
        ) or 1
        
        licensed_list = []
        unused_licensed = []
        unlicensed_used = []
        
        # Populate pro/licensed from STRICT catalog
        for fname in pro_features_set:
            uc = int(used_map.get(fname, {}).get("usage_count", 0))
            item = {
                "feature_name": fname,
                "display_name": FEATURE_DISPLAY_NAMES.get(fname, fname),
                "plan_tier": canonical_catalog[fname]["plan"],
                "is_used": fname in used_map,
                "usage_count": uc,
                "unique_users": int(used_map.get(fname, {}).get("unique_users", 0)),
                "usage_pct": round((uc / total_pro_usage_count) * 100, 1),
                "trend": trends_map.get(fname, []),
            }
            if item["is_used"]:
                licensed_list.append(item)
            else:
                unused_licensed.append(item)
                
        # Populate free/unlicensed ONLY from known catalog + what's not Pro
        for fname, r in used_map.items():
            if fname not in pro_features_set:
                uc = int(r["usage_count"])
                unlicensed_used.append({
                    "feature_name": fname,
                    "display_name": FEATURE_DISPLAY_NAMES.get(fname, fname),
                    "usage_count": uc,
                    "unique_users": int(r["unique_users"]),
                    "usage_pct": round((uc / total_usage_count) * 100, 1),
                })
                
        unlicensed_used.sort(key=lambda x: x["usage_count"], reverse=True)

        # ─── Summaries ───
        pro_user_count = 0
        total_user_count = 1
        wow_change = 0.0

        if pro_features_set:
            pro_str = ", ".join([f"'{f}'" for f in sorted(pro_raw_features)])
            sql_pro_users = f"""
                SELECT uniqExact(user_id) as pro_users
                FROM feature_intelligence.events_raw
                WHERE {cond} AND event_name IN ({pro_str}) AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
            """
            pro_res = ch_client.query(sql_pro_users, params)
            pro_user_count = int(pro_res[0]["pro_users"]) if pro_res else 0

            sql_total = f"""
                SELECT uniqExact(user_id) as total_users 
                FROM feature_intelligence.events_raw 
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
            """
            total_user_count = max(int((ch_client.query(sql_total, params) or [{"total_users": 1}])[0]["total_users"]), 1)

            # Phase E (item 8): rollup pattern -- filtered by event_name IN (...), a plain
            # column on daily_feature_usage; uniqExactMergeIf already has precedent in this
            # codebase (api/data_layer.py's trending query, and /tenants above).
            sql_wow = f"""
                SELECT
                    uniqExactMergeIf(event_count, date >= toDate(now('UTC')) - 7) as current_week,
                    uniqExactMergeIf(event_count, date >= toDate(now('UTC')) - 14 AND date < toDate(now('UTC')) - 7) as prev_week
                FROM feature_intelligence.daily_feature_usage
                WHERE {cond} AND event_name IN ({pro_str})
            """
            wow_res = ch_client.query(sql_wow, params)
            cw = int(wow_res[0]["current_week"]) if wow_res else 0
            pw = int(wow_res[0]["prev_week"]) if wow_res else 0
            wow_change = round(((cw - pw) / max(pw, 1)) * 100, 1)

        total_licensed = len(pro_features_set)
        total_used_licensed = len(licensed_list)
        waste_pct = round(((total_licensed - total_used_licensed) / max(total_licensed, 1)) * 100, 1)

        return {
            "tenant_id": tenants,
            "summary": {
                "total_licensed": total_licensed,
                "total_used": len(used_map),
                "total_used_licensed": total_used_licensed,
                "waste_pct": waste_pct,
                "pro_users": pro_user_count,
                "total_users": total_user_count,
                "pro_adoption_pct": round((pro_user_count / total_user_count) * 100, 1),
                "estimated_revenue": pro_user_count * 2000,
                "wow_change": wow_change,
            },
            "licensed": licensed_list,
            "unused_licensed": unused_licensed,
            "unlicensed_used": unlicensed_used,
            "nexabank_context": {}
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/license/sync")
def sync_licenses(req: LicenseSyncRequest):
    """Upsert license records for a tenant."""
    require_tenant_access(req.tenant_id)
    try:
        from datetime import datetime
        rows = []
        for f in req.features:
            rows.append([req.tenant_id, f.feature_name, 1 if f.is_licensed else 0, f.plan_tier, datetime.now(timezone.utc).replace(tzinfo=None)])
        
        client = ch_client._get_client()
        client.insert(
            'feature_intelligence.tenant_licenses',
            rows,
            column_names=['tenant_id', 'feature_name', 'is_licensed', 'plan_tier', 'updated_at']
        )
        return {"status": "ok", "synced": len(rows)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════
# TRACKING TOGGLES
# ═══════════════════════════════════════════════════════════

def _persona_config() -> dict:
    return (load_rbac_config() or {}).get("personas") or {}


def selectable_personas(request: Request) -> list[str]:
    """Personas this caller's ROLE may switch to, from rbac.json -- never from the request.

    An empty or missing allowlist collapses to the resolved persona alone, so a config mistake
    narrows the view rather than opening it.
    """
    cfg = _persona_config()
    allowed = cfg.get("allowed") or ["analyst"]
    role = (request.headers.get("X-User-Role") or "user").strip()
    choices = (cfg.get("selectable_by_role") or {}).get(role) or []
    resolved = resolve_persona(request)
    out = [p for p in choices if p in allowed]
    return out or [resolved]


def resolve_persona(request: Request, requested: str | None = None) -> str:
    """Role -> persona from rbac.json.

    A requested persona is honoured only when the caller's ROLE lists it in
    `personas.selectable_by_role`. That allowlist is server-side config, so switching persona can
    never widen what a role may read -- the requirement in CLAUDE.md rule 11. Previously a request
    was honoured only when it already equalled the resolved persona, which made the parameter
    inert and left every role locked to one narrative shape.
    """
    cfg = _persona_config()
    allowed = cfg.get("allowed") or ["analyst"]
    by_email = cfg.get("by_email") or {}
    by_role = cfg.get("by_role") or {}
    email = (request.headers.get("X-User-Email") or "").strip().lower()
    role = (request.headers.get("X-User-Role") or "user").strip()
    resolved = by_email.get(email) or by_role.get(role) or cfg.get("default", "analyst")
    resolved = resolved if resolved in allowed else "analyst"
    if not requested or requested == resolved:
        return resolved
    choices = (cfg.get("selectable_by_role") or {}).get(role) or []
    return requested if requested in choices and requested in allowed else resolved


@app.get("/intelligence/personas")
def list_intelligence_personas(
    request: Request,
    tenants: str = Query(None, description="Tenant scope; required for an app_admin caller"),
):
    """Which persona views this caller may switch between, and what each one covers.

    The list comes from the caller's ROLE via rbac.json, never from the request, so the dashboard
    can offer a switcher without it becoming a way to widen access.

    `tenants` is unused here but must be accepted: RBACMiddleware scopes an app_admin from the
    query string and refuses the request without it, so omitting it 403s for exactly the role the
    switcher exists for -- and the switcher then silently does not render.
    """
    from api.intelligence import personas as persona_registry
    resolved = resolve_persona(request)
    return {
        "resolved": resolved,
        "personas": [persona_registry.as_dict(p) for p in selectable_personas(request)],
    }


@app.get("/intelligence/insight")
def get_intelligence_insight(
    request: Request,
    tenants: str = Query(..., description="Tenant id"),
    kpi_id: str = Query(None, description="Optional KPI filter"),
    persona: str = Query(None, description="Advisory only; the server resolves the persona"),
):
    """Latest insight with its evidence card, trust verdict and engine breakdown."""
    from api.intelligence import reader
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    row = reader.latest_insight(tenant_id, resolve_persona(request, persona), kpi_id)
    if not row:
        return {"tenant_id": tenant_id, "insight": None,
                "detail": "no investigation has produced an insight for this persona yet"}
    return {"tenant_id": tenant_id, "insight": row}


@app.get("/intelligence/insights")
def list_intelligence_insights(
    request: Request,
    tenants: str = Query(..., description="Tenant id"),
    limit: int = Query(20, ge=1, le=100),
):
    from api.intelligence import reader
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    return {"tenant_id": tenant_id,
            "insights": reader.list_insights(tenant_id, resolve_persona(request), limit)}


@app.get("/intelligence/sources")
def get_intelligence_sources(tenants: str = Query(..., description="Tenant id")):
    """Per-source freshness: grain, cadence, SLA and how far behind each source is."""
    from api.intelligence import reader
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    return {"tenant_id": tenant_id, "sources": reader.source_health(tenant_id)}


@app.get("/intelligence/telemetry")
def get_intelligence_telemetry(tenants: str = Query(..., description="Tenant id")):
    """Runtime telemetry: latency, model calls, tokens, cost, LLM vs non-LLM."""
    from api.intelligence import reader
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    return {"tenant_id": tenant_id, "telemetry": reader.runtime_telemetry(tenant_id)}


@app.get("/intelligence/recommendations")
def get_intelligence_recommendations(
    tenants: str = Query(..., description="Tenant id"),
    limit: int = Query(20, ge=1, le=100),
):
    """Proposals only. Phase 1 executes nothing; every action needs a human signature."""
    from api.intelligence import reader
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    return {"tenant_id": tenant_id, "recommendations": reader.recommendations(tenant_id, limit)}


@app.post("/intelligence/ask")
def ask_intelligence(
    request: Request,
    req: AskRequest,
    tenants: str = Query(..., description="Tenant id"),
):
    """Answer a question from recorded evidence only.

    Routes to a closed set of intents over the Signal Store rather than generating a query, so no
    answer can contain a number no stage computed. Abstains when the question does not map.

    The tenant is a QUERY parameter, not a body field: RBACMiddleware scopes an app_admin from
    query params, so a body-only tenant would bypass the check it is meant to pass.
    """
    from api.intelligence import agent
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    if len(question) > 500:
        raise HTTPException(status_code=400, detail="question is too long")
    return agent.ask(tenant_id, question, resolve_persona(request, req.persona))


@app.post("/intelligence/ask/stream")
def ask_intelligence_stream(
    request: Request,
    req: AskRequest,
    tenants: str = Query(..., description="Tenant id"),
):
    """The same answer as `/intelligence/ask`, streamed step by step as Server-Sent Events.

    Event kinds: `rail` (the pipeline gates, before anything runs), `step` (one reasoning step,
    with the numbers it read and the table they came from), `answer` (the identical payload the
    batch endpoint returns) and `end`. A client that only wants the answer should keep using the
    batch route; nothing here changes what the agent decides.
    """
    from fastapi.responses import StreamingResponse
    from api.intelligence import agent
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    if len(question) > 500:
        raise HTTPException(status_code=400, detail="question is too long")
    return StreamingResponse(
        agent.ask_stream(tenant_id, question, resolve_persona(request, req.persona)),
        media_type="text/event-stream",
        # Buffering a stream defeats it: nginx and some dev proxies hold SSE until the response
        # closes, which would deliver every step at once and look identical to the batch route.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"},
    )


@app.get("/intelligence/series")
def get_intelligence_series(
    tenants: str = Query(..., description="Tenant id"),
    kpi_id: str = Query(..., description="Governed metric to chart"),
    days: int = Query(30, ge=7, le=120),
):
    """The real day-by-day path for one governed KPI, with its stored forecast band.

    Read through the Metric Layer, so the chart and the narrative are computed by the same code.
    A hand-written GROUP BY here would be the same query and the same cost, and would drift from
    the narrative the first time either side changed.
    """
    from api.intelligence import series as series_reader
    tenant_id = [t.strip() for t in tenants.split(",") if t.strip()][0]
    return series_reader.kpi_series(tenant_id, kpi_id, days)


@app.get("/intelligence/rail")
def get_intelligence_rail():
    """The pipeline gates a question travels, so a UI can render the rail before asking."""
    from api.intelligence import gates
    return {"gates": gates.catalogue()}


@app.post("/intelligence/outcome")
def record_intelligence_outcome(req: OutcomeRequest):
    """Human feedback. Closes the loop stage 08 needs; never trains anything automatically."""
    from api.intelligence import signal_store
    from api.intelligence.ids import outcome_id
    from datetime import datetime as _dt
    now = _dt.now(timezone.utc).replace(tzinfo=None)
    signal_store.write_outcome({
        "outcome_id": outcome_id(req.insight_id, req.signal, req.actor),
        "investigation_id": req.investigation_id, "insight_id": req.insight_id,
        "tenant_id": req.tenant_id, "signal": req.signal, "value": req.value,
        "actor": req.actor, "ts": now,
    })
    return {"status": "recorded"}


@app.get("/ai_report")
def get_ai_report(
    tenants: str = Query(..., description="Comma-separated list of tenants"),
    range: str = Query("30d", description="Time range like 7d, 30d, 90d"),
    force_refresh: bool = Query(False, description="Bypass the cache and generate a new report")
):
    """Generates a comprehensive AI-powered summarization report for the dashboard.
    Reports are persisted in ClickHouse (ai_reports table). Old reports are auto-replaced."""
    tenant_id = tenants  # Alias for backwards compatibility within this function
    cache_key = f"{tenant_id}:{range}"
    require_tenant_access(tenant_id)
    import json as _json

    def _load_report_from_db(tid: str, expected_range: str):
        """Load the latest stored report from ClickHouse."""
        sql = """
            SELECT report, insights, generated_by, generated_at
            FROM feature_intelligence.ai_reports FINAL
            WHERE tenant_id = %(tenant_id)s
            LIMIT 1
        """
        try:
            rows = ch_client.query(sql, {"tenant_id": tid})
        except Exception:
            # If storage is unavailable, continue with on-demand generation.
            return None
        if not rows:
            return None
        row = rows[0]
        insights_raw = row.get("insights", "[]")
        try:
            insights_parsed = _json.loads(insights_raw) if isinstance(insights_raw, str) else insights_raw
        except Exception:
            insights_parsed = []
        generated_at = row.get("generated_at")
        generated_at_str = generated_at.isoformat() if hasattr(generated_at, "isoformat") else str(generated_at)
        generated_by = row.get("generated_by", "")
        stored_range = None
        if isinstance(generated_by, str) and generated_by.startswith("range:"):
            stored_range = generated_by.split(":", 1)[1].strip()

        if stored_range and stored_range != expected_range:
            return None

        return {
            "report": row.get("report", ""),
            "insights": insights_parsed,
            "generated_by": generated_by,
            "generated_at": generated_at_str,
            "time_range": stored_range or expected_range,
        }

    def _save_report_to_db(tid: str, report: str, insights_list: list, generated_by: str = ""):
        """Insert a new report into ClickHouse. ReplacingMergeTree will replace the old one."""
        try:
            client = ch_client._get_client()
            client.insert(
                'feature_intelligence.ai_reports',
                [[tid, generated_by, report, _json.dumps(insights_list), datetime.now(timezone.utc).replace(tzinfo=None)]],
                column_names=['tenant_id', 'generated_by', 'report', 'insights', 'generated_at']
            )
        except Exception:
            # Don't fail the report response if persistence is temporarily unavailable.
            return

    try:
        # --- If NOT force refreshing, try to return stored report ---
        if not force_refresh:
            # Fast path: in-memory cache
            now = time.time()
            if cache_key in AI_REPORT_CACHE:
                cached_data = AI_REPORT_CACHE[cache_key]
                if now - cached_data["timestamp"] < AI_CACHE_TTL:
                    return {
                        "tenant_id": tenant_id,
                        "report": cached_data.get("report", ""),
                        "cached": True,
                        "generated_at": cached_data.get("generated_at"),
                        "time_range": cached_data.get("time_range", range),
                        "insights": cached_data.get("insights", []),
                    }

            # Slow path: load from ClickHouse
            db_report = _load_report_from_db(tenant_id, range)
            if db_report and db_report["report"]:
                # Populate in-memory cache for fast subsequent reads
                AI_REPORT_CACHE[cache_key] = {
                    "timestamp": time.time(),
                    "report": db_report["report"],
                    "insights": db_report["insights"],
                    "generated_at": db_report["generated_at"],
                    "time_range": db_report.get("time_range", range),
                }
                return {
                    "tenant_id": tenant_id,
                    "report": db_report["report"],
                    "cached": True,
                    "generated_at": db_report["generated_at"],
                    "time_range": db_report.get("time_range", range),
                    "insights": db_report["insights"],
                }

        # --- Generate a fresh report ---
        kpi = get_kpi_metrics(tenants=tenant_id, range=range)
        secondary = get_secondary_kpi(tenants=tenant_id, range=range)
        locations = get_locations(tenants=tenant_id, range=range)[:5]
        activities = get_feature_activity(tenants=tenant_id, range=range)

        try:
            funnels = get_funnel_analysis(tenants=tenant_id, steps="login,dashboard_view,loan_applied,kyc_started,kyc_completed", window_minutes=60, range=range)
        except Exception:
            funnels = "No funnel data available."
            
        try:
            retention = get_retention(tenants=tenant_id, range=range)
        except Exception:
            retention = "No retention data available."
            
        try:
            pred_adoption = get_predictive_adoption(tenants=tenant_id, range=range)
        except Exception:
            pred_adoption = "No predictive adoption data available."
            


        # Build HTML visualization payload
        kpi_cards_html = f'''
        <section style="margin-bottom: 20px; font-family: inherit; line-height: 1.35;">
            <h3 style="font-size: 24px; font-weight: 800; color: #0f172a; margin: 0 0 14px;">Platform Health & Activity Metrics</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px;">
        '''

        for k in kpi:
            val = k.get('value', '0')
            label = k.get('label', '')
            kpi_cards_html += f'''
                <div style="padding: 16px; background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%); border: 1px solid #dbe5f1; border-radius: 12px; box-shadow: 0 2px 10px rgba(2, 6, 23, 0.05);">
                    <p style="margin: 0; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em;">{label}</p>
                    <p style="margin: 10px 0 0; font-size: 34px; font-weight: 800; color: #0b1f44;">{val}</p>
                </div>
            '''
        kpi_cards_html += '</div></section>'

        activity_html = f'''
        <section style="margin-bottom: 20px; padding: 18px; background: #ffffff; border-radius: 12px; border: 1px solid #dbe5f1; box-shadow: 0 2px 10px rgba(2, 6, 23, 0.05); line-height: 1.3;">
            <h4 style="margin: 0 0 12px; font-size: 19px; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 8px;">
                <span style="display: inline-block; width: 4px; height: 16px; background: #3b82f6; border-radius: 2px;"></span>
                Feature Adoption Matrix
            </h4>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px;">
        '''

        for act in activities[:6]:
            feat_name = act.get('feature', 'Unknown')
            hash_val = sum(ord(c) for c in feat_name) % 60 + 20
            segments = act.get('segments', [])
            color = segments[0].get('color', '#3b82f6') if segments else '#3b82f6'
            activity_html += f'''
                <div style="padding: 12px; background: #f8fafc; border-radius: 10px; border: 1px solid #e6edf5;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; color: #1f2937; font-weight: 700;">
                        <span>{feat_name}</span>
                        <span style="color: {color}; font-weight: 800;">{hash_val}%</span>
                    </div>
                    <div style="height: 8px; width: 100%; background: #dbe4ef; border-radius: 99px; overflow: hidden;">
                        <div style="height: 100%; width: {hash_val}%; background: linear-gradient(90deg, {color}99, {color}); border-radius: 99px;"></div>
                    </div>
                </div>
            '''
        activity_html += '</div></section>'

        continent_map = {
            "USA": "North America", "Canada": "North America",
            "United Kingdom": "Europe", "Germany": "Europe", "France": "Europe",
            "India": "Asia", "Japan": "Asia",
            "Australia": "Oceania", "Brazil": "South America"
        }

        continent_data = {}
        total_visits = 0
        for loc in locations:
            c = loc.get("country", "Unknown")
            v = loc.get("visits", 0)
            cont = continent_map.get(c, "Other Regions")
            continent_data[cont] = continent_data.get(cont, 0) + v
            total_visits += v
        if total_visits == 0: total_visits = 1

        geo_html = f'''
        <section style="margin-bottom: 24px; padding: 18px; background: #ffffff; border-radius: 12px; border: 1px solid #dbe5f1; box-shadow: 0 2px 10px rgba(2, 6, 23, 0.05); line-height: 1.3;">
            <h4 style="margin: 0 0 12px; font-size: 19px; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 8px;">
                <span style="display: inline-block; width: 4px; height: 16px; background: #10b981; border-radius: 2px;"></span>
                Global Footprint (Continent-wise Traffic)
            </h4>
            <div style="display: flex; flex-direction: column; gap: 10px;">
        '''

        colors = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444']
        for i, (cont, visits) in enumerate(sorted(continent_data.items(), key=lambda x: x[1], reverse=True)):
            pct = int((visits / total_visits) * 100)
            c_color = colors[i % len(colors)]
            geo_html += f'''
                <div style="display: grid; grid-template-columns: minmax(120px, 160px) 1fr 60px 80px; gap: 10px; align-items: center;">
                    <div style="font-size: 13px; font-weight: 700; color: #334155;">{cont}</div>
                    <div style="height: 8px; background: #dbe4ef; border-radius: 99px; overflow: hidden;">
                        <div style="height: 100%; width: {pct}%; background: linear-gradient(90deg, {c_color}99, {c_color}); border-radius: 99px;"></div>
                    </div>
                    <div style="text-align: right; font-size: 13px; font-weight: 800; color: #0f172a;">{pct}%</div>
                    <div style="text-align: right; font-size: 12px; font-weight: 600; color: #64748b;">{visits} visits</div>
                </div>
            '''
        geo_html += '</div></section>'



        divider = '<hr style="border: 0; height: 1px; background: #e2e8f0; margin: 40px 0;" />'

        def _as_dict_row(value):
            return value if isinstance(value, dict) else {}

        kpi_compact = [
            {
                "label": _as_dict_row(item).get("label"),
                "value": _as_dict_row(item).get("value"),
                "change": _as_dict_row(item).get("change"),
            }
            for item in (kpi or [])[:8]
        ]
        secondary_compact = [
            {
                "label": _as_dict_row(item).get("label"),
                "value": _as_dict_row(item).get("value"),
            }
            for item in (secondary or [])[:8]
        ]
        locations_compact = [
            {
                "country": _as_dict_row(loc).get("country"),
                "visits": _as_dict_row(loc).get("visits"),
            }
            for loc in (locations or [])[:5]
        ]
        activities_compact = [
            {
                "feature": _as_dict_row(act).get("feature"),
                "level": _as_dict_row(act).get("level"),
            }
            for act in (activities or [])[:8]
        ]
        funnel_compact = funnels if isinstance(funnels, str) else {
            "funnel": [
                {
                    "step": _as_dict_row(step).get("step"),
                    "event_name": _as_dict_row(step).get("event_name"),
                    "users_completed": _as_dict_row(step).get("users_completed"),
                    "drop_off_pct": _as_dict_row(step).get("drop_off_pct"),
                }
                for step in (funnels or {}).get("funnel", [])[:8]
            ]
        }
        retention_compact = retention if isinstance(retention, str) else {
            "cohorts": retention[:6] if isinstance(retention, list) else [],
        }
        predictive_compact = pred_adoption if isinstance(pred_adoption, str) else {
            "total_users": (pred_adoption or {}).get("total_users", 0),
            "predictions": [
                {
                    "feature_name": _as_dict_row(p).get("feature_name"),
                    "score": _as_dict_row(p).get("score"),
                    "status": _as_dict_row(p).get("status"),
                    "growth_rate": _as_dict_row(p).get("growth_rate"),
                }
                for p in (pred_adoption or {}).get("predictions", [])[:8]
            ],
        }

        context_str = (
            f"KPI Metrics: {kpi_compact}\n\nSecondary Metrics: {secondary_compact}\n\n"
            f"Top Locations: {locations_compact}\n\nFeature Activities: {activities_compact}\n\n"
            f"Funnel Step Drop-offs: {funnel_compact}\n\nRetention Loop Metrics: {retention_compact}\n\n"
            f"Predictive Adoption Scores: {predictive_compact}"
        )

        prompt = f"""
You are a **Senior Product Analytics Strategist** writing a premium executive briefing for the banking platform tenant: **{tenant_id}**.
The time range being analyzed is: **{range}**.

You have access to the following raw telemetry data:
{context_str}

CRITICAL FORMATTING RULES:
- Use rich Markdown: **bold**, `code highlights`, blockquotes, bullet lists, numbered lists, and horizontal rules.
- Use Markdown tables where numerical comparisons are helpful.
- Use emoji icons (📊 📉 📈 🚨 ✅ ⚠️ 💡 🎯 🔥 🧪) at section headers and key callouts to make the report visually engaging.
- Use GitHub-style alert blocks for critical findings: `> [!WARNING]`, `> [!NOTE]`, `> [!TIP]`.
- Write in a professional but direct tone. Avoid filler. Every sentence must add analytical value.
- Reference specific numbers from the data (e.g., "drop-off of 43% at KYC step", "only 12 events recorded for AI Advisor").

Structure the report in these 6 sections:

---

## 📊 1. Executive Health Scorecard
Provide a high-level snapshot of platform health. Summarize the most important KPIs (total events, active users, bounce rate, session duration) in a **Markdown table**. Comment on whether the platform is in a growth, plateau, or decline phase. Cite specific numbers.

## 📉 2. Conversion Funnel & Drop-off Analysis
Deep-dive into the funnel data. Identify the **exact step** where the largest user attrition occurs. Calculate and present the drop-off percentages between each step. Use a table or numbered list. Explain the likely UX causes (e.g., form complexity, unclear CTAs, trust barriers). Highlight the most critical drop-off with a `> [!WARNING]` block.

## 🔥 3. Feature Engagement & Stickiness Map
Analyze which features drive repeat usage versus which are underperforming. Reference predictive adoption scores and activity data. Categorize features into:
- 🟢 **High-stickiness** (strong engagement, growing)
- 🟡 **At-risk** (declining or stagnant)
- 🔴 **Low adoption** (underused despite strategic importance)

## 🌍 4. Geographic & Demographic Intelligence
Analyze the location data to identify which regions contribute most traffic. Comment on expansion opportunities or regions where engagement is disproportionately low. Present a brief table of top regions.

## 🧪 5. Retention & Cohort Patterns
Evaluate the retention cohort data. Identify whether early-stage retention (Week 1-2) or late-stage retention (Week 4+) is the bigger problem. Suggest specific interventions (onboarding improvements, re-engagement campaigns, feature nudges).

## 🎯 6. Strategic Action Plan (Next 30 Days)
Provide **5 concrete, prioritized actions** the product team should execute in the next 30 days. Each action should:
- Reference a specific metric or finding from the sections above
- Describe the expected impact
- Be implementable within a sprint cycle

Format each action as a numbered item with a bold title and 1-2 sentence description.

---

Do not include raw JSON. Do not add disclaimers or meta-commentary outside the report. Output ONLY the markdown report.
        """
        from api.insights import query_vllm
        llm_response = query_vllm(prompt, timeout_seconds=180, max_tokens=1200)

        if not llm_response:
            # Graceful fallback when the model is unavailable.
            total_events = 0
            active_users = 0
            bounce_rate = None
            session_duration = None
            kpi_lookup = {str(item.get("label", "")).lower(): item.get("value") for item in kpi}

            if "total events" in kpi_lookup:
                total_events = kpi_lookup.get("total events") or 0
            if "active users" in kpi_lookup:
                active_users = kpi_lookup.get("active users") or 0
            if "bounce rate" in kpi_lookup:
                bounce_rate = kpi_lookup.get("bounce rate")
            if "avg session duration" in kpi_lookup:
                session_duration = kpi_lookup.get("avg session duration")

            llm_response = f"""
## 📊 1. Executive Health Scorecard
The AI model is temporarily unavailable. This report is generated from live telemetry summaries for **{tenant_id}** over **{range}**.

| Metric | Value |
|--------|-------|
| Total Events | **{total_events}** |
| Active Users | **{active_users}** |
| Bounce Rate | **{bounce_rate if bounce_rate is not None else 'n/a'}** |
| Avg Session Duration | **{session_duration if session_duration is not None else 'n/a'}** |

## 📉 2. Conversion Funnel & Drop-off Analysis
Current funnel metrics indicate where users stall. Prioritize screens with the steepest conversion drops and validate form complexity, field count, and error messaging.

## 🔥 3. Feature Engagement & Stickiness Map
Feature activity suggests where engagement is concentrated. Promote high-utility features earlier in journeys and simplify access to underused but strategic actions.

## 🌍 4. Geographic & Demographic Intelligence
Location distribution data is available for regional analysis once AI model reconnects.

## 🧪 5. Retention & Cohort Patterns
Retention metrics are being tracked. A full cohort analysis will be available when the AI model is restored.

## 🎯 6. Strategic Action Plan (Next 30 Days)
1. **Streamline top drop-off step** — Reduce required inputs and add clearer progress indicators.
2. **Add contextual nudges** — Deploy tooltips on low-adoption but high-value features.
3. **Enable saved-state recovery** — Allow users to resume interrupted critical flows.
4. **Optimize geographic targeting** — Tailor onboarding flows for top-traffic regions.
5. **Implement re-engagement triggers** — Target users who drop off at Week 2 with personalized nudges.
""".strip()

        final_report = f"{kpi_cards_html}\n{activity_html}\n{geo_html}\n{divider}\n{llm_response}"
        try:
            insights_payload = generate_insights(tenant_id)
        except Exception:
            insights_payload = []

        # Get the user who triggered generation (from request headers)
        generated_by = ""
        try:
            from starlette.requests import Request as _Req
            # Use the request context if available
        except Exception:
            pass

        # Persist to ClickHouse (old report is auto-replaced by ReplacingMergeTree)
        generated_by = f"range:{range}"
        _save_report_to_db(tenant_id, final_report, insights_payload, generated_by)

        # Update in-memory cache
        gen_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        AI_REPORT_CACHE[cache_key] = {
            "timestamp": time.time(),
            "report": final_report,
            "insights": insights_payload,
            "generated_at": gen_at,
            "time_range": range,
        }

        return {
            "tenant_id": tenant_id,
            "report": final_report,
            "cached": False,
            "generated_at": gen_at,
            "time_range": range,
            "insights": insights_payload,
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()

        # Last-resort safety: never return a hard 500 for AI report rendering.
        # Prefer latest stored snapshot; otherwise return a compact deterministic fallback.
        try:
            db_report = _load_report_from_db(tenant_id, range)
            if db_report and db_report.get("report"):
                return {
                    "tenant_id": tenant_id,
                    "report": db_report["report"],
                    "cached": True,
                    "generated_at": db_report.get("generated_at"),
                    "time_range": db_report.get("time_range", range),
                    "insights": db_report.get("insights", []),
                    "fallback_reason": str(e),
                }
        except Exception:
            pass

        fallback_report = f"""
## 📊 1. Executive Health Scorecard
AI report generation is temporarily degraded for **{tenant_id}** over **{range}**. Core telemetry endpoints are available, but narrative synthesis could not complete.

## 📉 2. Conversion Funnel & Drop-off Analysis
Review the funnel stages with the highest drop-off and prioritize form simplification and clearer progression cues.

## 🔥 3. Feature Engagement & Stickiness Map
Prioritize high-frequency features in primary navigation and improve discoverability for strategic low-adoption features.

## 🌍 4. Geographic & Demographic Intelligence
Regional data is being collected. Full geographic analysis will resume when the AI model recovers.

## 🧪 5. Retention & Cohort Patterns
Cohort retention data is available for review. Focus on Week 1-2 retention to identify early churn patterns.

## 🎯 6. Strategic Action Plan (Next 30 Days)
1. **Reduce steps on the top drop-off flow** — Simplify the most abandoned conversion step.
2. **Add contextual guidance at abandonment points** — Deploy inline help where users disengage.
3. **Track post-change conversion** — Measure impact of recent UX updates.
4. **Optimize onboarding for top regions** — Tailor flows for highest-traffic geographies.
5. **Deploy re-engagement campaigns** — Target users who churned in the first 2 weeks.
""".strip()

        return {
            "tenant_id": tenant_id,
            "report": fallback_report,
            "cached": False,
            "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
            "time_range": range,
            "insights": [],
            "fallback_reason": str(e),
        }

@app.get("/insights")
def get_insights(tenants: str = Query(..., description="Comma-separated list of tenants"), range: str = Query("7d", description="Time range like 7d, 30d")):
    days = parse_range(range)
    tenant_id = tenants
    tenants = [t.strip() for t in tenant_id.split(",") if t.strip()]
    cond = "tenant_id = %(tenant_id)s" if len(tenants) == 1 else "tenant_id IN %(tenant_ids)s"
    params = {"tenant_id": tenants[0], "days": days} if len(tenants) == 1 else {"tenant_ids": tuple(tenants), "days": days}
    
    try:
        insights = []
        
        # 1. High Bounce Rate insight
        # Phase E (item 8): direct pattern for the inner per-user event_count. The outer
        # count() counts subquery rows (one per distinct user_id) -- already immune.
        bounce_sql = f"""
            SELECT
                count() as total_users,
                countIf(event_count = 1) as bounced_users
            FROM (
                SELECT user_id, uniqExact({DEDUP_EVENT_KEY}) as event_count
                FROM feature_intelligence.events_raw
                WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
                GROUP BY user_id
            )
        """
        b_res = ch_client.query(bounce_sql, params)
        if b_res and b_res[0]["total_users"] > 0:
            rate = (b_res[0]["bounced_users"] / b_res[0]["total_users"]) * 100
            if rate > 60:
                insights.append({
                    "id": "insight-bounce",
                    "type": "High Bounce Rate Detected",
                    "message": f"Bounce rate is currently {rate:.1f}%. Consider optimizing the landing experience.",
                    "severity": "high"
                })
            elif rate > 40:
                insights.append({
                    "id": "insight-bounce",
                    "type": "Elevated Bounce Rate",
                    "message": f"Bounce rate is {rate:.1f}%. Minor optimizations might improve retention.",
                    "severity": "medium"
                })
                
        # 2. Top feature usage
        # Phase E (item 8): rollup pattern -- grouped by event_name only.
        feat_sql = f"""
            SELECT event_name as feature, uniqExactMerge(event_count) as cnt
            FROM feature_intelligence.daily_feature_usage
            WHERE {cond} AND date >= toDate(now('UTC')) - %(days)s AND date < toDate(now('UTC'))
            GROUP BY event_name ORDER BY cnt DESC LIMIT 1
        """
        f_res = ch_client.query(feat_sql, params)
        if f_res:
            f_name = f_res[0]["feature"]
            f_count = f_res[0]["cnt"]
            insights.append({
                "id": "insight-feat",
                "type": "Dominant Feature Activity",
                "message": f"'{f_name}' is your most used feature with {f_count} events in the selected period.",
                "severity": "low"
            })
            
        # 3. Peak traffic time
        # Phase E (item 8): direct pattern -- per-hour grouping is finer than the daily grain.
        time_sql = f"""
            SELECT toHour(timestamp) as hr, uniqExact({DEDUP_EVENT_KEY}) as cnt
            FROM feature_intelligence.events_raw
            WHERE {cond} AND timestamp >= toDate(now('UTC')) - %(days)s AND timestamp < toDate(now('UTC')) AND timestamp < toDate(now('UTC'))
            GROUP BY hr ORDER BY cnt DESC LIMIT 1
        """
        t_res = ch_client.query(time_sql, params)
        if t_res:
            peak_hr = t_res[0]["hr"]
            insights.append({
                "id": "insight-time",
                "type": "Peak Usage Window",
                "message": f"User activity consistently peaks around {peak_hr}:00. Ideal time for maintenance is outside this window.",
                "severity": "medium"
            })

        if not insights:
            insights.append({
                "id": "insight-fallback",
                "type": "Stable Analytics",
                "message": "All system metrics are operating within normal parameters.",
                "severity": "low"
            })
            
        return {"insights": insights}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════
# TENANT COMPARISON
# ═══════════════════════════════════════════════════════════
