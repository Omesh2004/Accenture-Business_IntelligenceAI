import argparse
import json
import random
import time
import uuid
import os
from datetime import datetime, timedelta, timezone
from typing import Dict, List

import requests

# Defaults suit a host shell; inside a container `localhost` is the container itself, so the
# script silently posted 0 of 7556 events and the golden scenarios never landed. Env overrides
# let the same script run from either side of the network boundary.
INGEST_URL = os.environ.get("INGEST_URL", "http://localhost:8000/events")
ANALYTICS_URL = os.environ.get(
    "ANALYTICS_URL", "http://localhost:8001/metrics/realtime_users")

ACQ_CHANNELS = ["direct", "organic", "referral", "social", "email", "paid_search"]
ACQ_WEIGHTS = [0.30, 0.22, 0.16, 0.14, 0.10, 0.08]

DEVICES = ["desktop", "mobile", "tablet"]
DEVICE_WEIGHTS = [0.50, 0.42, 0.08]

WORLD_PROFILES = [
    {"city": "Mumbai", "country": "India", "continent": "Asia", "tz": 5.5, "weight": 0.11},
    {"city": "Bangalore", "country": "India", "continent": "Asia", "tz": 5.5, "weight": 0.09},
    {"city": "Delhi", "country": "India", "continent": "Asia", "tz": 5.5, "weight": 0.08},
    {"city": "Singapore", "country": "Singapore", "continent": "Asia", "tz": 8, "weight": 0.05},
    {"city": "Tokyo", "country": "Japan", "continent": "Asia", "tz": 9, "weight": 0.04},
    {"city": "Dubai", "country": "UAE", "continent": "Asia", "tz": 4, "weight": 0.05},
    {"city": "London", "country": "United Kingdom", "continent": "Europe", "tz": 0, "weight": 0.08},
    {"city": "Berlin", "country": "Germany", "continent": "Europe", "tz": 1, "weight": 0.04},
    {"city": "Paris", "country": "France", "continent": "Europe", "tz": 1, "weight": 0.04},
    {"city": "Stockholm", "country": "Sweden", "continent": "Europe", "tz": 1, "weight": 0.03},
    {"city": "New York", "country": "USA", "continent": "North America", "tz": -5, "weight": 0.09},
    {"city": "San Francisco", "country": "USA", "continent": "North America", "tz": -8, "weight": 0.07},
    {"city": "Toronto", "country": "Canada", "continent": "North America", "tz": -5, "weight": 0.04},
    {"city": "Mexico City", "country": "Mexico", "continent": "North America", "tz": -6, "weight": 0.03},
    {"city": "São Paulo", "country": "Brazil", "continent": "South America", "tz": -3, "weight": 0.05},
    {"city": "Buenos Aires", "country": "Argentina", "continent": "South America", "tz": -3, "weight": 0.02},
    {"city": "Sydney", "country": "Australia", "continent": "Oceania", "tz": 10, "weight": 0.03},
    {"city": "Melbourne", "country": "Australia", "continent": "Oceania", "tz": 10, "weight": 0.02},
    {"city": "Lagos", "country": "Nigeria", "continent": "Africa", "tz": 1, "weight": 0.03},
    {"city": "Nairobi", "country": "Kenya", "continent": "Africa", "tz": 3, "weight": 0.02},
]

FREE_EVENTS = [
    "dashboard.page.view",
    "account.page.view",
    "transaction.page.view",
    "payee.page.view",
    "payee.add_payee.success",
    "payee.add_payee.failure",
    "transaction.pay_now.success",
    "transaction.pay_now.failure",
    "loan.page.view",
    "loan.applied.success",
    "loan.approved.success",
    "loan.kyc_started.success",
    "loan.kyc_completed.success",
    "loan.kyc_failed.failure",
    "profile.page.view",
    "profile.edit_details.success",
]

PRO_EVENTS = [
    "crypto_trading.page.view",
    "crypto_trading.trade_execution.success",
    "crypto_trading.trade_execution.failure",
    "crypto_trading.price_feeds.view",
    "crypto_trading.portfolio.view",
    "wealth_management_pro.rebalance.success",
    "wealth_management_pro.rebalance.failure",
    "wealth_management_pro.insights.view",
    "bulk_payroll_processing.batch.success",
    "bulk_payroll_processing.batch.failure",
    "bulk_payroll_processing.payees.view",
    "ai_insights.stats.view",
    "ai_insights.book.success",
    "pro.new_feature.view",
]

ENTRY_EVENTS = [
    "login.auth.success",
    "register.auth.success",
]

EXIT_EVENT = "logout.auth.success"


class Simulator:
    def __init__(self, ingest_url: str, tenant_ids: List[str], users_per_tenant: int, include_pro_ratio: float):
        self.ingest_url = ingest_url
        self.tenant_ids = tenant_ids
        self.users_per_tenant = users_per_tenant
        self.include_pro_ratio = include_pro_ratio
        self.user_pool: Dict[str, List[str]] = {
            tenant: [f"{tenant}_user_{i:03d}" for i in range(1, users_per_tenant + 1)]
            for tenant in tenant_ids
        }

    def _choice_weighted(self, choices: List[str], weights: List[float]) -> str:
        return random.choices(choices, weights=weights, k=1)[0]

    def _random_ip(self) -> str:
        return f"{random.randint(20, 223)}.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"

    def _pick_world_profile(self) -> dict:
        return random.choices(WORLD_PROFILES, weights=[p["weight"] for p in WORLD_PROFILES], k=1)[0]

    def _pick_channel_for_profile(self, profile: dict) -> str:
        # Model region-informed acquisition tendencies.
        continent = profile.get("continent", "")
        if continent == "Asia":
            weights = [0.26, 0.24, 0.14, 0.20, 0.08, 0.08]
        elif continent == "Europe":
            weights = [0.31, 0.28, 0.17, 0.10, 0.08, 0.06]
        elif continent == "North America":
            weights = [0.35, 0.18, 0.18, 0.12, 0.07, 0.10]
        elif continent == "South America":
            weights = [0.29, 0.20, 0.16, 0.24, 0.06, 0.05]
        elif continent == "Africa":
            weights = [0.33, 0.19, 0.15, 0.20, 0.08, 0.05]
        else:
            weights = ACQ_WEIGHTS
        return self._choice_weighted(ACQ_CHANNELS, weights)

    def _pick_device_for_profile(self, profile: dict) -> str:
        continent = profile.get("continent", "")
        if continent in {"Asia", "Africa", "South America"}:
            weights = [0.40, 0.54, 0.06]
        else:
            weights = DEVICE_WEIGHTS
        return self._choice_weighted(DEVICES, weights)

    def _seconds_between_actions(self, profile: dict) -> int:
        # Slightly faster interactions during work hours in each locale.
        tz_offset = float(profile.get("tz", 0))
        local_now = datetime.now(timezone.utc) + timedelta(hours=tz_offset)
        business_hour = 8 <= local_now.hour <= 20
        return random.randint(5, 28) if business_hour else random.randint(12, 55)

    def _metadata(self, session_id: str, channel: str, device_type: str, city: str, country: str, continent: str) -> dict:
        return {
            "session_id": session_id,
            "channel": channel,
            "device_type": device_type,
            "device": device_type,
            "platform": "web" if device_type in ["desktop", "tablet"] else "app",
            "city": city,
            "location": country,
            "continent": continent,
            "referrer": f"{channel}.campaign" if channel != "direct" else "direct",
            "campaign": f"global_{channel}",
            "ip": self._random_ip(),
            "response_time_ms": random.randint(40, 600),
        }

    def _emit(self, tenant_id: str, user_id: str, event_name: str, ts: datetime, base_meta: dict, event_id: str | None = None) -> bool:
        session_id = str(base_meta.get("session_id", ""))
        payload = {
            "event_id": event_id or f"evt_{uuid.uuid4().hex}",
            "session_id": session_id,
            "event_name": event_name,
            "tenant_id": tenant_id,
            "user_id": user_id,
            "timestamp": ts.timestamp(),
            "channel": "web" if base_meta.get("device_type") in ["desktop", "tablet"] else "mobile",
            "metadata": base_meta,
        }
        try:
            response = requests.post(self.ingest_url, json=payload, timeout=4)
            return response.status_code == 202
        except requests.RequestException:
            return False

    def generate_session_events(self, tenant_id: str, user_id: str, session_start: datetime, force_logout: bool = True) -> List[dict]:
        session_id = f"sess_{uuid.uuid4().hex[:12]}"
        profile = self._pick_world_profile()
        channel = self._pick_channel_for_profile(profile)
        device = self._pick_device_for_profile(profile)
        city = profile["city"]
        country = profile["country"]
        continent = profile["continent"]
        base_meta = self._metadata(session_id, channel, device, city, country, continent)

        timeline = []
        cursor = session_start

        first_event = self._choice_weighted(ENTRY_EVENTS, [0.85, 0.15])
        timeline.append((first_event, cursor))
        cursor += timedelta(seconds=self._seconds_between_actions(profile))

        timeline.append(("dashboard.page.view", cursor))
        cursor += timedelta(seconds=self._seconds_between_actions(profile))

        actions_count = random.randint(3, 8)
        for _ in range(actions_count):
            if random.random() < self.include_pro_ratio:
                event = random.choice(PRO_EVENTS)
            else:
                event = random.choice(FREE_EVENTS)
            timeline.append((event, cursor))
            cursor += timedelta(seconds=self._seconds_between_actions(profile))

        if force_logout:
            timeline.append((EXIT_EVENT, cursor + timedelta(seconds=random.randint(6, 40))))

        return [
            {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "event_name": event_name,
                "event_id": f"evt_{uuid.uuid4().hex}",
                "timestamp": ts,
                "metadata": base_meta,
            }
            for event_name, ts in timeline
        ]

    def seed_historical(self, days: int, sessions_per_tenant: int, end_buffer_minutes: int = 15) -> tuple[int, int]:
        now = datetime.now(timezone.utc)
        end = now - timedelta(minutes=max(1, end_buffer_minutes))
        start = end - timedelta(days=days)
        sent = 0
        attempted = 0

        events: List[dict] = []
        for tenant in self.tenant_ids:
            for _ in range(sessions_per_tenant):
                user = random.choice(self.user_pool[tenant])
                ts = start + timedelta(seconds=random.randint(0, int((end - start).total_seconds())))
                events.extend(self.generate_session_events(tenant, user, ts, force_logout=True))

        events.sort(key=lambda e: e["timestamp"])

        for ev in events:
            attempted += 1
            if self._emit(ev["tenant_id"], ev["user_id"], ev["event_name"], ev["timestamp"], ev["metadata"], ev.get("event_id")):
                sent += 1

        return sent, attempted

    def run_realtime_burst(self, tenant: str, active_users: int, hold_seconds: int) -> tuple[int, int]:
        now = datetime.now(timezone.utc)
        users = random.sample(self.user_pool[tenant], k=min(active_users, len(self.user_pool[tenant])))

        sent = 0
        attempted = 0
        active_sessions = []

        # Phase 1: login + activity (active users should rise)
        for user in users:
            session_events = self.generate_session_events(
                tenant_id=tenant,
                user_id=user,
                session_start=now - timedelta(seconds=random.randint(5, 55)),
                force_logout=False,
            )
            # send only first 3-4 events to keep session currently active
            for ev in session_events[: random.randint(3, 4)]:
                attempted += 1
                if self._emit(ev["tenant_id"], ev["user_id"], ev["event_name"], ev["timestamp"], ev["metadata"], ev.get("event_id")):
                    sent += 1
            active_sessions.append(session_events[0])

        print(f"[Realtime] Active phase started with {len(active_sessions)} users. Holding for {hold_seconds}s...")
        time.sleep(hold_seconds)

        # Phase 2: explicit logout (active users should drop)
        logout_ts = datetime.now(timezone.utc)
        for sess in active_sessions:
            attempted += 1
            if self._emit(
                tenant_id=sess["tenant_id"],
                user_id=sess["user_id"],
                event_name=EXIT_EVENT,
                ts=logout_ts,
                base_meta=sess["metadata"],
                event_id=f"evt_{uuid.uuid4().hex}",
            ):
                sent += 1

        return sent, attempted

    def close_recent_sessions(self, tenant: str, lookback_minutes: int = 5) -> tuple[int, int]:
        """Force-close sessions active in the lookback window by emitting logout events."""
        try:
            from storage.client import ch_client
            import ast
            import json
        except Exception:
            return (0, 0)

        sql = """
            SELECT user_id, event_name, timestamp, metadata
            FROM feature_intelligence.events_raw
            WHERE tenant_id = %(tenant_id)s
                            AND timestamp >= now('UTC') - INTERVAL %(mins)s MINUTE
            ORDER BY timestamp DESC
        """

        rows = ch_client.query(sql, {"tenant_id": tenant, "mins": int(max(1, lookback_minutes))})
        latest_by_session: Dict[str, dict] = {}

        for row in rows:
            user_id = str(row.get("user_id", ""))
            if not user_id:
                continue

            metadata_raw = row.get("metadata", "")
            metadata = {}
            if isinstance(metadata_raw, str) and metadata_raw:
                try:
                    metadata = json.loads(metadata_raw)
                except Exception:
                    try:
                        metadata = ast.literal_eval(metadata_raw)
                    except Exception:
                        metadata = {}

            session_id = str(metadata.get("session_id", f"user:{user_id}"))
            key = f"{user_id}::{session_id}"
            if key not in latest_by_session:
                latest_by_session[key] = {
                    "user_id": user_id,
                    "event_name": str(row.get("event_name", "")),
                    "metadata": metadata,
                }

        sent = 0
        attempted = 0
        ts = datetime.now(timezone.utc)

        for session in latest_by_session.values():
            latest_event = session["event_name"].lower()
            if any(token in latest_event for token in ["logout", "signout", "session_end"]):
                continue

            meta = session["metadata"]
            if "session_id" not in meta:
                meta["session_id"] = f"user:{session['user_id']}"

            attempted += 1
            if self._emit(tenant, session["user_id"], EXIT_EVENT, ts, meta):
                sent += 1

        return sent, attempted

    # Scenarios 1, 2 and 4 all move loan.kyc_*. Sharing a tenant makes the duplicate storm
    # quarantine the KPI that scenario 2 needs to pass, so the defect cases get their own.
    #
    # Indices into the caller's --tenants list, NOT tenant names: hardcoding names sent the
    # planted movements to the demo tenants while the baseline went where the caller asked, and
    # every scenario gate then scored a tenant the movement was never written to.
    SCENARIO_TENANT_INDEX = {
        "duplicate_event_storm": 1,
        "ambiguous_duplicate_campaign": 1,
        "real_kyc_drop_mobile_india": 0,
        "sparse_new_feature": 0,
        "entitlement_and_role_violation": 0,
    }

    def scenario_tenant(self, scenario: str, fallback: str) -> str:
        index = self.SCENARIO_TENANT_INDEX.get(scenario)
        if index is None or not self.tenant_ids:
            return fallback
        return self.tenant_ids[index % len(self.tenant_ids)]

    def seed_scenarios(self, tenant: str, scenario: str, truth_path: str,
                       baseline_days: int = 21, anomaly_days: int = 7,
                       sessions_per_day: int = 120) -> tuple[int, int]:
        """Deterministic Phase 1 fixtures, spread across DAILY buckets.

        The contracts declare grain.time daily, min_history_days 14 and
        min_persistence_windows 2, so a fixture confined to one day can never fire Detect.
        Layout: baseline_days at a stable rate, then anomaly_days carrying the planted move.
        """
        random.seed(1337)
        today = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
        total_days = baseline_days + anomaly_days
        sent = 0
        attempted = 0
        truth: List[dict] = []

        def day_ts(days_ago: int, seq: int = 0) -> datetime:
            # Deterministic spread inside the day; never crosses a UTC midnight boundary.
            return today - timedelta(days=days_ago) + timedelta(minutes=(seq * 7) % 600)

        active = {"name": scenario}

        def emit(event_name: str, ts: datetime, metadata: dict, user_id: str,
                 event_id=None) -> None:
            nonlocal sent, attempted
            attempted += 1
            target = self.scenario_tenant(active["name"], tenant)
            if self._emit(target, user_id, event_name, ts, metadata, event_id):
                sent += 1

        def fixed_meta(session_id: str, device: str = "mobile", location: str = "India",
                       channel: str = "mobile") -> dict:
            city = "Mumbai" if location == "India" else "New York"
            continent = "Asia" if location == "India" else "North America"
            meta = self._metadata(session_id, channel, device, city, location, continent)
            # Planted dimensions are the signal under test, so they are NOT marked. Only the
            # fields that stay uninformative even in a fixture are.
            meta["_simulated"] = ["ip", "response_time_ms"]
            return meta

        def should_emit(name: str) -> bool:
            active["name"] = name
            return scenario == "all" or scenario == name

        # -- 1. duplicate event storm ------------------------------------------------
        # Duplicates share event_id AND timestamp, so ReplacingMergeTree collapses them in
        # events_raw. Only the MV raw_rows survives -- that is exactly what D1 detects.
        if should_emit("duplicate_event_storm"):
            for d in range(total_days, 0, -1):
                storm = d <= anomaly_days
                for i in range(sessions_per_day):
                    sid = "dup_%02d_%03d" % (d, i)
                    meta = fixed_meta(sid)
                    uid = "%s_dup_%02d_%03d" % (tenant, d, i)
                    emit("loan.kyc_started.success", day_ts(d, i), meta, uid)
                    if i % 4 != 0:
                        eid = "evt_dup_%02d_%03d" % (d, i)
                        ts = day_ts(d, i) + timedelta(seconds=30)
                        emit("loan.kyc_completed.success", ts, meta, uid, eid)
                        if storm and i % 2 == 0:
                            emit("loan.kyc_completed.success", ts, meta, uid, eid)
            truth.append({
                "scenario": "duplicate_event_storm",
                "tenant_id": self.scenario_tenant("duplicate_event_storm", tenant),
                "kpi_id": "kyc_completion_rate", "expected_fingerprint": "duplicate_event_storm",
                "expected_verdict": "fail", "anomaly_days": anomaly_days,
            })

        # -- 2. real movement, concentrated in mobile/India ---------------------------
        if should_emit("real_kyc_drop_mobile_india"):
            for d in range(total_days, 0, -1):
                dropped = d <= anomaly_days
                for i in range(sessions_per_day):
                    planted = i % 2 == 0
                    loc = "India" if planted else "USA"
                    dev = "mobile" if planted else "desktop"
                    sid = "kyc_%02d_%03d" % (d, i)
                    meta = fixed_meta(sid, device=dev, location=loc,
                                      channel="mobile" if planted else "web")
                    uid = "%s_kyc_%02d_%03d" % (tenant, d, i)
                    emit("loan.kyc_started.success", day_ts(d, i), meta, uid)
                    rate = 0.45 if (dropped and planted) else 0.85
                    if ((i * 7919) % 100) / 100.0 < rate:
                        emit("loan.kyc_completed.success",
                             day_ts(d, i) + timedelta(seconds=45), meta, uid)
                        if ((i * 6151) % 100) / 100.0 < 0.8:
                            emit("loan.applied.success",
                                 day_ts(d, i) + timedelta(seconds=90), meta, uid)
                            approve = 0.40 if (dropped and planted) else 0.75
                            if ((i * 5237) % 100) / 100.0 < approve:
                                emit("loan.approved.success",
                                     day_ts(d, i) + timedelta(seconds=150), meta, uid)
            truth.append({
                "scenario": "real_kyc_drop_mobile_india",
                "tenant_id": self.scenario_tenant("real_kyc_drop_mobile_india", tenant),
                "kpi_id": "kyc_completion_rate",
                "planted_segment": {"device_type": "mobile", "location": "India"},
                "expected_direction": "down", "expected_rank1_dimension": "location",
                "expected_verdict": "pass", "anomaly_days": anomaly_days,
            })

        # -- 3. sparse / cold start ---------------------------------------------------
        if should_emit("sparse_new_feature"):
            for d in range(4, 0, -1):
                for i in range(6):
                    meta = fixed_meta("sparse_%d_%d" % (d, i), device="desktop",
                                      location="USA", channel="web")
                    emit("pro.new_feature.view", day_ts(d, i), meta,
                         "%s_sparse_%d_%d" % (tenant, d, i))
            truth.append({
                "scenario": "sparse_new_feature", "tenant_id": tenant,
                "event_name": "pro.new_feature.view",
                "expected_caveat": "insufficient_history",
            })

        # -- 4. ambiguous: a campaign and a partial duplicate at once ------------------
        if should_emit("ambiguous_duplicate_campaign"):
            for d in range(total_days, 0, -1):
                for i in range(20):
                    sid = "amb_%02d_%03d" % (d, i)
                    meta = fixed_meta(sid)
                    meta["campaign"] = "kyc_reactivation"
                    uid = "%s_amb_%02d_%03d" % (tenant, d, i)
                    emit("loan.kyc_started.success", day_ts(d, i), meta, uid)
                    eid = "evt_amb_%02d_%03d" % (d, i)
                    ts = day_ts(d, i) + timedelta(seconds=30)
                    emit("loan.kyc_completed.success", ts, meta, uid, eid)
                    if d <= anomaly_days and i % 5 == 0:
                        emit("loan.kyc_completed.success", ts, meta, uid, eid)
            truth.append({
                "scenario": "ambiguous_duplicate_campaign",
                "tenant_id": self.scenario_tenant("ambiguous_duplicate_campaign", tenant),
                "kpi_id": "kyc_completion_rate", "campaign": "kyc_reactivation",
                "expected_cheapest_check":
                    "confirm whether the spike survives event_id de-duplication",
            })

        # -- 5. entitlement + role violation -------------------------------------------
        if should_emit("entitlement_and_role_violation"):
            for d in range(total_days, 0, -1):
                for i in range(18):
                    meta = fixed_meta("ent_%02d_%03d" % (d, i), device="desktop",
                                      location="USA", channel="web")
                    meta["tier"] = "enterprise"
                    uid = "%s_pro_%02d_%03d" % (tenant, d, i)
                    emit("crypto_trading.trade_execution.success", day_ts(d, i), meta, uid)
                    if i % 3 == 0:
                        emit("wealth_management_pro.rebalance.success",
                             day_ts(d, i + 1), meta, uid)
                    if i % 4 == 0:
                        emit("bulk_payroll_processing.batch.success",
                             day_ts(d, i + 2), meta, uid)
                    if i % 5 == 0:
                        emit("ai_insights.book.success", day_ts(d, i + 3), meta, uid)
                    if d <= anomaly_days and i % 6 == 0:
                        vmeta = dict(meta)
                        vmeta["role"] = "user"
                        vmeta["attempted_action"] = "admin_feature_toggle"
                        emit("auth.role.violation", day_ts(d, i + 4), vmeta,
                             "%s_viol_%02d_%03d" % (tenant, d, i))
            truth.append({
                "scenario": "entitlement_and_role_violation", "tenant_id": tenant,
                "hidden_kpi": "pro_revenue", "violation_event": "auth.role.violation",
                "restricted_from": "ops_manager", "expected_severity": "urgent",
            })

        os.makedirs(os.path.dirname(os.path.abspath(truth_path)), exist_ok=True)
        with open(truth_path, "w", encoding="utf-8") as fh:
            json.dump(truth, fh, indent=2, sort_keys=True)

        return sent, attempted

    def enforce_zero_active_users(self, tenant: str, max_rounds: int = 5) -> int:
        """Try to drain active users to near-zero by repeatedly closing recent sessions."""
        for _ in range(max_rounds):
            active = query_realtime_users(tenant)
            if active <= 0:
                return active
            self.close_recent_sessions(tenant, lookback_minutes=10)
            time.sleep(3)
        return query_realtime_users(tenant)


def query_realtime_users(tenant: str) -> int:
    try:
        response = requests.get(
            ANALYTICS_URL,
            params={"tenants": tenant},
            headers={"X-User-Role": "app_admin", "X-User-Email": "simulator@example.com"},
            timeout=5,
        )
        response.raise_for_status()
        body = response.json()
        return int(body.get("count", 0))
    except Exception:
        return -1


def main() -> None:
    parser = argparse.ArgumentParser(description="Realistic telemetry simulator for ingestion + realtime session lifecycle")
    parser.add_argument("--ingest-url", default=INGEST_URL)
    parser.add_argument("--tenants", default="nexabank,safexbank")
    parser.add_argument("--users-per-tenant", type=int, default=120)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--sessions-per-tenant", type=int, default=220)
    parser.add_argument("--include-pro-ratio", type=float, default=0.22)
    parser.add_argument("--realtime-tenant", default="nexabank")
    parser.add_argument("--realtime-users", type=int, default=30)
    parser.add_argument("--hold-seconds", type=int, default=12)
    # Must outweigh the historical generator in the same tenant, or the planted
    # movement is averaged away and Detect correctly refuses to call it.
    parser.add_argument("--scenario-sessions-per-day", type=int, default=120)
    parser.add_argument("--history-end-buffer-minutes", type=int, default=15)
    parser.add_argument("--force-close-recent", action="store_true", help="Emit logout events for all users active in the last 5 minutes")
    parser.add_argument(
        "--scenario",
        choices=[
            "none",
            "all",
            "duplicate_event_storm",
            "real_kyc_drop_mobile_india",
            "sparse_new_feature",
            "ambiguous_duplicate_campaign",
            "entitlement_and_role_violation",
        ],
        default="none",
        help="Emit deterministic Phase 1 scenario source data after normal history",
    )
    parser.add_argument("--truth-path", default="fixtures/planted_truth.json")
    args = parser.parse_args()

    random.seed(int(time.time()))

    tenant_ids = [t.strip() for t in args.tenants.split(",") if t.strip()]
    simulator = Simulator(
        ingest_url=args.ingest_url,
        tenant_ids=tenant_ids,
        users_per_tenant=args.users_per_tenant,
        include_pro_ratio=max(0.0, min(args.include_pro_ratio, 1.0)),
    )

    print("[1/3] Seeding realistic historical sessions...")
    sent, attempted = simulator.seed_historical(
        days=args.days,
        sessions_per_tenant=args.sessions_per_tenant,
        end_buffer_minutes=args.history_end_buffer_minutes,
    )
    print(f"Historical events sent: {sent}/{attempted}")

    if args.scenario != "none":
        print(f"[Scenario] Emitting {args.scenario} source-data fixture...")
        s_sent, s_attempted = simulator.seed_scenarios(
            args.realtime_tenant, args.scenario, args.truth_path,
            sessions_per_day=args.scenario_sessions_per_day)
        print(f"Scenario events sent: {s_sent}/{s_attempted}; truth written to {args.truth_path}")

    print("[2/3] Running realtime activity burst...")
    before = query_realtime_users(args.realtime_tenant)
    print(f"Realtime users before burst ({args.realtime_tenant}): {before}")

    r_sent, r_attempted = simulator.run_realtime_burst(
        tenant=args.realtime_tenant,
        active_users=args.realtime_users,
        hold_seconds=args.hold_seconds,
    )
    print(f"Realtime burst events sent: {r_sent}/{r_attempted}")

    if args.force_close_recent:
        c_sent, c_attempted = simulator.close_recent_sessions(args.realtime_tenant, lookback_minutes=5)
        print(f"Forced session closure events sent: {c_sent}/{c_attempted}")
        final_active = simulator.enforce_zero_active_users(args.realtime_tenant, max_rounds=5)
        print(f"Active users after drain attempt ({args.realtime_tenant}): {final_active}")
        time.sleep(2)

    mid = query_realtime_users(args.realtime_tenant)
    print(f"Realtime users after logout phase ({args.realtime_tenant}): {mid}")

    print("[3/3] Done. If count remains >0, wait ~10-20s for polling refresh and query /metrics/realtime_users again.")


if __name__ == "__main__":
    main()
