import argparse
import json
import random
import time
import uuid
import os
from datetime import datetime, timedelta, timezone
from typing import Dict, List

import requests

INGEST_URL = "http://localhost:8000/events"
ANALYTICS_URL = "http://localhost:8001/metrics/realtime_users"

ACQ_CHANNELS = ["direct", "organic", "referral", "social", "email", "paid_search"]
ACQ_WEIGHTS = [0.30, 0.22, 0.16, 0.14, 0.10, 0.08]

DEVICES = ["desktop", "mobile", "tablet"]
DEVICE_WEIGHTS = [0.50, 0.42, 0.08]

WORLD_PROFILES = [
    {"city": "Mumbai", "country": "India", "continent": "Asia", "tz": 5.5, "weight": 0.11},
    {"city": "Bengaluru", "country": "India", "continent": "Asia", "tz": 5.5, "weight": 0.09},
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
    {"city": "Sao Paulo", "country": "Brazil", "continent": "South America", "tz": -3, "weight": 0.05},
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

    def seed_scenarios(self, tenant: str, scenario: str, truth_path: str) -> tuple[int, int]:
        """Emit deterministic Phase 1 source-data fixtures without running the intelligence layer."""
        random.seed(1337)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        sent = 0
        attempted = 0
        truth: List[dict] = []

        def emit(event_name: str, offset_minutes: int, metadata: dict, user_id: str, event_id: str | None = None) -> None:
            nonlocal sent, attempted
            attempted += 1
            if self._emit(tenant, user_id, event_name, now - timedelta(minutes=offset_minutes), metadata, event_id):
                sent += 1

        def fixed_meta(session_id: str, device: str = "mobile", location: str = "India", channel: str = "mobile") -> dict:
            city = "Mumbai" if location == "India" else "New York"
            continent = "Asia" if location == "India" else "North America"
            return self._metadata(session_id, channel, device, city, location, continent)

        def should_emit(name: str) -> bool:
            return scenario == "all" or scenario == name

        if should_emit("duplicate_event_storm"):
            duplicate_ids = []
            for i in range(20):
                meta = fixed_meta(f"scenario_dup_{i:03d}")
                user_id = f"{tenant}_scenario_dup_{i:03d}"
                emit("loan.kyc_started.success", 240 - i, meta, user_id)
                event_id = f"evt_duplicate_storm_{i:03d}"
                duplicate_ids.append(event_id)
                emit("loan.kyc_completed.success", 230 - i, meta, user_id, event_id)
                emit("loan.kyc_completed.success", 229 - i, meta, user_id, event_id)
            truth.append({
                "scenario": "duplicate_event_storm",
                "tenant_id": tenant,
                "kpi_id": "kyc_completion_rate",
                "expected_fingerprint": "duplicate_event_storm",
                "duplicate_event_ids": duplicate_ids,
            })

        if should_emit("real_kyc_drop_mobile_india"):
            for i in range(60):
                meta = fixed_meta(f"scenario_kyc_drop_{i:03d}")
                user_id = f"{tenant}_scenario_kyc_{i:03d}"
                emit("loan.kyc_started.success", 180 - i, meta, user_id)
                if i % 5 != 0:
                    emit("loan.kyc_completed.success", 178 - i, meta, user_id)
                if i % 6 != 0:
                    emit("loan.applied.success", 176 - i, meta, user_id)
            truth.append({
                "scenario": "real_kyc_drop_mobile_india",
                "tenant_id": tenant,
                "kpi_id": "kyc_completion_rate",
                "planted_segment": {"device_type": "mobile", "location": "India"},
                "expected_direction": "down",
                "expected_magnitude_pct": 18,
            })

        if should_emit("sparse_new_feature"):
            for i in range(6):
                meta = fixed_meta(f"scenario_sparse_{i:03d}", device="desktop", location="USA", channel="web")
                emit("pro.new_feature.view", 120 - i * 10, meta, f"{tenant}_scenario_sparse_{i:03d}")
            truth.append({
                "scenario": "sparse_new_feature",
                "tenant_id": tenant,
                "event_name": "pro.new_feature.view",
                "expected_caveat": "insufficient_history",
            })

        if should_emit("ambiguous_duplicate_campaign"):
            for i in range(16):
                meta = fixed_meta(f"scenario_ambiguous_{i:03d}")
                meta["campaign"] = "kyc_reactivation"
                user_id = f"{tenant}_scenario_ambiguous_{i:03d}"
                emit("loan.kyc_started.success", 90 - i, meta, user_id)
                completion_id = f"evt_ambiguous_completion_{i:03d}"
                emit("loan.kyc_completed.success", 89 - i, meta, user_id, completion_id)
                if i % 4 == 0:
                    emit("loan.kyc_completed.success", 88 - i, meta, user_id, completion_id)
            truth.append({
                "scenario": "ambiguous_duplicate_campaign",
                "tenant_id": tenant,
                "kpi_id": "kyc_completion_rate",
                "campaign": "kyc_reactivation",
                "expected_cheapest_check": "confirm whether the spike survives event_id de-duplication",
            })

        if should_emit("entitlement_and_role_violation"):
            for i in range(18):
                meta = fixed_meta(f"scenario_entitlement_{i:03d}", device="desktop", location="USA", channel="web")
                meta["tier"] = "enterprise"
                emit("crypto_trading.trade_execution.success", 60 - i, meta, f"{tenant}_scenario_pro_{i:03d}")
                if i % 3 == 0:
                    emit("wealth_management_pro.rebalance.success", 58 - i, meta, f"{tenant}_scenario_pro_{i:03d}")
                if i % 4 == 0:
                    emit("bulk_payroll_processing.batch.success", 57 - i, meta, f"{tenant}_scenario_pro_{i:03d}")
                if i % 5 == 0:
                    emit("ai_insights.book.success", 55 - i, meta, f"{tenant}_scenario_pro_{i:03d}")
                violation_meta = dict(meta)
                violation_meta["role"] = "user"
                violation_meta["attempted_action"] = "admin_feature_toggle"
                emit("auth.role.violation", 56 - i, violation_meta, f"{tenant}_scenario_violation_{i:03d}")
            truth.append({
                "scenario": "entitlement_and_role_violation",
                "tenant_id": tenant,
                "hidden_kpi": "pro_revenue",
                "violation_event": "auth.role.violation",
                "expected_severity": "urgent",
            })

        os.makedirs(os.path.dirname(os.path.abspath(truth_path)), exist_ok=True)
        with open(truth_path, "w", encoding="utf-8") as fh:
            json.dump(truth, fh, indent=2)

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
        s_sent, s_attempted = simulator.seed_scenarios(args.realtime_tenant, args.scenario, args.truth_path)
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
