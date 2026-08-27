"""
Generates mock telemetry for SafexBank (and a matching NexaBank slice) by posting through
POST /events, exactly like scripts/seed_data.py already does.

E9 fix (docs/FinInsights_Bug_Audit.md): this used to write directly through
ch_client.insert_events() -- no event_id, no session_id, no taxonomy normalisation, and a fresh
random timestamp/event set on every run, so running it twice doubled the data and running it at
all injected untaxonomised names (e.g. "login", "transfer_funds") straight into events_raw,
bypassing both the Node and Python taxonomy dialects entirely.

Posting through /events fixes the taxonomy bypass: FeatureEvent.validate_event_name normalises
whatever is sent, the same single ingest dialect every other producer goes through.
Determinism (fixed random seed + event_id derived from the tuple that produced it, not uuid4())
fixes the double-insert problem: a re-run generates the IDENTICAL sequence of events with the
IDENTICAL event_ids, so uniqExact(event_id) absorbs the replay instead of doubling the count.
"""
import sys
import os
import hashlib
import random
from datetime import datetime, timedelta, timezone

import requests

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

INGEST_URL = os.environ.get("INGESTION_API_URL", "http://localhost:8000/events")

TENANTS = ["safexbank", "nexabank"]
USERS_PER_TENANT = 50
EVENTS_PER_TENANT = 300
SEED_DAYS = 7
DETERMINISTIC_SEED = 42  # fixed, not time-based -- this is what makes a re-run a no-op

# This script posts straight to /events, bypassing NexaBank's eventTracker.ts entirely -- so
# unlike live traffic, nothing fills in device_type/location/continent for it. Found live: the
# first version of this fix landed with bare metadata and verify_data_quality.py's DIMS check
# immediately caught 600 rows (every event this script produced) with those dimensions empty,
# which every KPI contract declares and needs populated to localize on at all. Assigning one
# profile per (tenant, user) here, held constant across that user's events, mirrors
# eventTracker.ts's session-invariant geo/device assignment (FOUNDATION-2) and A1/A2's
# `_simulated` tagging -- same reasoning, same honesty requirement, different language.
GEO_PROFILES = [
    ("India", "Asia", "Mumbai", "mobile"),
    ("USA", "North America", "New York", "desktop"),
    ("Germany", "Europe", "Berlin", "desktop"),
    ("Brazil", "South America", "Sao Paulo", "mobile"),
    ("Australia", "Oceania", "Sydney", "tablet"),
]

# A7-adjacent: these are now real, resolvable canonical event names (matching the taxonomy
# scripts/seed_data.py's FREE_EVENTS/PRO_EVENTS already use), not the bare/legacy strings
# ("login", "transfer_funds", "pro-feature?id=crypto-trading") the old version wrote, which
# canonicalize_event_name could not resolve to anything a KPI contract or the license catalog
# reads.
FEATURES = [
    "login.auth.success",
    "accounts.transfer_money.success",
    "dashboard.page.view",
    "crypto-trading.page.view",
    "wealth-management-pro.rebalance.success",
    "bulk-payroll-processing.page.view",
    "ai-insights.book.success",
]


def get_channel(rng: random.Random) -> str:
    return rng.choices(["web", "mobile", "api"], weights=[0.6, 0.3, 0.1])[0]


def deterministic_event_id(tenant: str, user: str, feature: str, index: int) -> str:
    """Stable across runs: same (tenant, user, feature, index) always yields the same id, so a
    re-run's uniqExact(event_id) dedup collapses it instead of doubling the count."""
    digest = hashlib.sha256(f"seed_safexbank:{tenant}:{user}:{feature}:{index}".encode()).hexdigest()
    return f"evt_seedsafex_{digest[:24]}"


def generate_events() -> list[dict]:
    rng = random.Random(DETERMINISTIC_SEED)
    events_to_send = []
    end_date = datetime.now(timezone.utc).replace(tzinfo=None)
    start_date = end_date - timedelta(days=SEED_DAYS)
    delta_seconds = int((end_date - start_date).total_seconds())

    for tenant in TENANTS:
        users = [f"seedsafex_user_{i}" for i in range(USERS_PER_TENANT)]
        session_ids = {u: f"sess_seedsafex_{tenant}_{u}" for u in users}
        # One profile per user, not per event -- session-invariant, same reasoning as
        # eventTracker.ts's getSessionProfile (FOUNDATION-2 / CLAUDE.md coupling point 6).
        # Deliberately NOT drawn from `rng`: this must stay stable even if EVENTS_PER_TENANT or
        # anything else upstream ever changes how many rng.* calls happen before it, and it must
        # not perturb the (user, feature, timestamp, channel) sequence below, which is what makes
        # deterministic_event_id's inputs reproducible run to run. Also deliberately not Python's
        # hash() -- that is exactly C3's per-process-randomized-hash bug applied to a new place.
        def profile_for(u: str) -> tuple:
            idx = int(hashlib.sha256(f"{tenant}:{u}".encode()).hexdigest(), 16) % len(GEO_PROFILES)
            return GEO_PROFILES[idx]
        profiles = {u: profile_for(u) for u in users}

        for i in range(EVENTS_PER_TENANT):
            user = rng.choice(users)
            feature = rng.choice(FEATURES)
            random_seconds = rng.randint(0, delta_seconds)
            event_time = start_date + timedelta(seconds=random_seconds)
            country, continent, city, device_type = profiles[user]

            events_to_send.append({
                "event_id": deterministic_event_id(tenant, user, feature, i),
                "session_id": session_ids[user],
                "event_name": feature,
                "tenant_id": tenant,
                "user_id": user,
                "timestamp": event_time.timestamp(),
                "channel": get_channel(rng),
                "metadata": {
                    "session_id": session_ids[user],
                    "device_type": device_type,
                    "location": country,
                    "continent": continent,
                    "city": city,
                    # A1/A2/A4 fix, applied here too: these dimensions are fabricated (this
                    # script has no real device/geo to report), so say so rather than let a
                    # reader mistake them for measurements.
                    "_simulated": ["device_type", "location", "continent", "city"],
                },
            })

    events_to_send.sort(key=lambda x: x["timestamp"])
    return events_to_send


def main():
    print("Generating mock events for SafexBank and NexaBank (deterministic, idempotent)...")
    events = generate_events()
    print(f"Generated {len(events)} events. Posting to {INGEST_URL} ...")

    sent, failed = 0, 0
    for event in events:
        try:
            resp = requests.post(INGEST_URL, json=event, timeout=4)
            if resp.status_code < 300:
                sent += 1
            else:
                failed += 1
                print(f"  rejected ({resp.status_code}): {event['event_name']} -- {resp.text[:200]}")
        except requests.RequestException as e:
            failed += 1
            print(f"  request failed: {e}")

    print(f"Done. {sent} accepted, {failed} failed/rejected.")


if __name__ == "__main__":
    main()
