"""Fast-mode seeding — volume for the intelligence layer, skipping only the transport.

Moved from `api/fast_seed.py` (plan §3.7, decision D7). What changed:
  - writes **`bronze.core_banking`** (+ a `bronze.events` sample) with `_raw` in the exact
    extract-record shape, then runs the real silver/gold transforms — so a fast-seeded dataset
    is downstream-identical to a slow-seeded one. Only Kafka + the remote-Postgres round trips
    are skipped.
  - drops `fact_cards` / `fact_campaign_interactions` (not in the 5-KPI chain).
  - no import from `api/intelligence/`.

Geography is read from `silver.dim_branch`, never redefined here — one vocabulary, both paths.
Every fabricated dimension is declared in `metadata._simulated`, exactly as the live producer
does, so Localize refuses to slice them unless `dataset='seeded'`.
"""
from __future__ import annotations

import json
import logging
import random
import uuid
from datetime import datetime, timedelta, timezone

from warehouse.client import ch_client
from pipeline.extract.freshness import record_freshness
from pipeline.transforms import silver_facts, gold_kpi, silver_events, silver_sessions, gold_funnel

logger = logging.getLogger(__name__)
BRONZE = "bronze"
SILVER = "silver"

KYC_STARTED = "loan.kyc_started.success"
KYC_COMPLETED = "loan.kyc_completed.success"
LOAN_APPLIED = "loan.applied.success"
LOAN_APPROVED = "loan.approved.success"
PRO_EVENTS = ["crypto-trading.trade_execution.success",
              "wealth-management-pro.rebalance.success",
              "bulk-payroll-processing.batch.success", "ai-insights.book.success"]

SIMULATED_DIMS = ["location", "country", "city", "continent", "device_type", "channel",
                  "response_time_ms"]

BASELINE_RATES = {
    "kyc_start": 0.45, "kyc_completion": 0.68, "loan_application": 0.50, "loan_approval": 0.62,
    "pro_conversion": 0.12, "digital_share": 1.00, "withdrawal_weight": 20, "txn_max_per_day": 4,
    # share of transactions that fail -> transaction_failure_rate
    "txn_failure": 0.015,
}
_UNBOUNDED_RATES = {"withdrawal_weight", "txn_max_per_day"}

DIGITAL_CHANNELS = ["WEB", "MOBILE"]
NON_DIGITAL_CHANNELS = ["ATM", "POS"]
DEVICES = ["desktop", "mobile", "tablet"]
TXN_TYPES = ["DEPOSIT", "WITHDRAWAL", "PAYMENT", "TRANSFER"]
CATEGORIES = ["Salary Credit", "Groceries", "Utilities", "Dining", "Travel", "Retail"]
LOAN_TYPES = ["HOME", "AUTO", "PERSONAL", "STUDENT"]
AGE = ["UNDER_25", "AGE_25_34", "AGE_35_49", "AGE_50_64", "AGE_65_PLUS"]
INCOME = ["UNDER_30K", "INC_30K_60K", "INC_60K_100K", "INC_100K_200K", "INC_200K_PLUS"]
EMPLOYMENT = ["SALARIED", "SELF_EMPLOYED", "STUDENT", "RETIRED", "UNEMPLOYED"]
RISK = ["LOW", "MEDIUM", "HIGH"]

_EVENT_TO_RATE = {
    "loan.kyc_started.success": "kyc_start", "loan.kyc_completed.success": "kyc_completion",
    "loan.kyc.failure": "kyc_completion", "loan.applied.success": "loan_application",
    "loan.approved.success": "loan_approval", "features.unlock.success": "pro_conversion",
    "features.unlock.failed": "pro_conversion", "transaction.pay_now.success": "digital_share",
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None)


def _client():
    return ch_client._get_client()


def _branches(tenant_id: str) -> list[dict]:
    rows = ch_client.query(
        f"SELECT branch_code, region, country, city FROM {SILVER}.dim_branch FINAL "
        "WHERE tenant_id = %(t)s", {"t": tenant_id})
    return [{"branch_code": r["branch_code"], "region": r["region"], "country": r["country"],
             "city": r["city"]} for r in rows]


def _existing_accounts(tenant_id: str) -> list[dict]:
    rows = ch_client.query(
        f"SELECT account_no, customer_id, branch_code, region, country, opened_at "
        f"FROM {SILVER}.fact_account_openings FINAL "
        "WHERE tenant_id = %(t)s AND NOT startsWith(customer_id, 'fast_') "
        "ORDER BY account_no", {"t": tenant_id})
    return [dict(r) for r in rows]


def _translate_console_behavior(behavior: dict) -> dict:
    if "rates" in behavior or "window_days" in behavior:
        return behavior
    out: dict = {"window_days": int(behavior.get("windowDays") or 0)}
    segment = dict(behavior.get("segment") or {})
    if "location" in segment and "country" not in segment:
        segment["country"] = segment.pop("location")
    out["segment"] = segment
    targets = behavior.get("targets")
    if isinstance(behavior.get("id"), str):
        targets = [behavior]
    rates: dict = {}
    for target in targets or []:
        if not isinstance(target, dict) or str(target.get("kind") or "event") != "event":
            continue
        key = _EVENT_TO_RATE.get(str(target.get("id") or ""))
        if not key:
            continue
        base = BASELINE_RATES[key]
        if isinstance(target.get("traffic"), (int, float)):
            value = base * float(target["traffic"])
        elif isinstance(target.get("failure"), (int, float)) and target["failure"] > 0:
            value = base / float(target["failure"])
        else:
            continue
        rates[key] = max(0.0, value if key in _UNBOUNDED_RATES else min(1.0, value))
    if rates:
        out["rates"] = rates
    mix = behavior.get("mix") or {}
    if mix and not out.get("segment"):
        weights = mix.get("countryWeights") or mix.get("deviceWeights") or {}
        top = max(weights, key=weights.get) if weights else ""
        if top:
            out["segment"] = {"country" if mix.get("countryWeights") else "device_type": top}
    return out


def resolve_behavior(behavior: dict | None) -> tuple[dict, int, dict]:
    if not isinstance(behavior, dict):
        return dict(BASELINE_RATES), 0, {}
    behavior = _translate_console_behavior(behavior)
    rates = dict(BASELINE_RATES)
    for key, value in (behavior.get("rates") or {}).items():
        if key in BASELINE_RATES and isinstance(value, (int, float)):
            rates[key] = value
    window = int(behavior.get("window_days") or 0)
    segment = {k: str(v) for k, v in (behavior.get("segment") or {}).items()
               if k in ("country", "device_type", "channel") and v}
    return rates, max(0, window), segment


def _in_segment(segment: dict, country: str, device: str) -> bool:
    if not segment:
        return True
    if "country" in segment and segment["country"].lower() != country.lower():
        return False
    if "device_type" in segment and segment["device_type"].lower() != device.lower():
        return False
    return True


def _meta(branch: dict, session_id: str, device: str, channel: str) -> dict:
    return {
        "session_id": session_id, "location": branch["country"], "country": branch["country"],
        "city": branch["city"], "continent": branch["region"], "device_type": device,
        "channel": channel, "response_time_ms": int(random.lognormvariate(4.0, 0.7)),
        "_simulated": SIMULATED_DIMS,
    }


def generate(tenant_id: str = "nexabank", users: int = 100, days: int = 30,
             seed: int | None = None, behavior: dict | None = None,
             create_accounts: bool = False) -> dict:
    if seed is not None:
        random.seed(seed)
    users = max(1, min(int(users), 5000))
    days = max(1, min(int(days), 365))
    moved, window_days, segment = resolve_behavior(behavior)
    base = dict(BASELINE_RATES)

    branches = _branches(tenant_id)
    if not branches:
        raise ValueError(f"no branches in silver.dim_branch for {tenant_id!r} -- run the "
                         "core-banking extract + silver_facts first")
    by_code = {b["branch_code"]: b for b in branches}
    population = [] if create_accounts else _existing_accounts(tenant_id)
    if not create_accounts and not population:
        raise ValueError(f"no existing accounts for {tenant_id!r} -- seed with create_accounts=true "
                         "or run the extract first")
    if not create_accounts:
        users = min(users, len(population))

    # Anchor to midnight UTC today, not the wall clock: a re-seed with the same params on the
    # same day must be byte-identical downstream (paired before/after demo; Phase 7 determinism).
    # Intra-day times come from the seeded RNG below.
    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    start = now - timedelta(days=days)
    window_from = days - window_days if window_days else days
    # `run` namespaces this call's ids. Derived from the seed (not uuid4, not the salted built-in
    # hash) so a fixed seed regenerates the same customers/accounts and a purge-then-reseed is
    # idempotent.
    import hashlib as _hl
    run = _hl.md5(repr((seed, users, days, behavior, create_accounts)).encode()).hexdigest()[:6]

    core: list[list] = []           # bronze.core_banking rows
    events: list[list] = []         # bronze.events rows
    moved_days = 0

    def _core(record_id, entity, source_id, payload, ver: datetime):
        core.append([str(record_id), entity, tenant_id, source_id, now, ver,
                     datetime(1970, 1, 1), "", json.dumps(payload, default=str), now])

    for u in range(users):
        device = random.choice(DEVICES)
        risk = random.choice(RISK)
        if create_accounts:
            cid = "fast_%s_%s_%04d" % (tenant_id, run, u)
            branch = random.choice(branches)
            opened = start + timedelta(days=random.randint(0, max(0, days - 1)),
                                       seconds=random.randint(0, 86399))
            acc_no = "FAST%s%06d" % (run.upper(), u)
            _core(cid, "customers", "nexabank_crm", {
                "customer_id": cid, "tenant_id": tenant_id, "age_bracket": random.choice(AGE),
                "income_bracket": random.choice(INCOME),
                "employment_status": random.choice(EMPLOYMENT), "risk_segment": risk,
                "lifetime_value": round(random.uniform(200, 30000), 2), "kyc_status": "VERIFIED",
                "branch_code": branch["branch_code"], "region": branch["region"],
                "country": branch["country"]}, now)
            _core(acc_no, "accounts", "nexabank_core", {
                "account_no": acc_no, "tenant_id": tenant_id, "customer_id": cid,
                "account_type": "SAVINGS", "lifecycle_status": "ACTIVE",
                "interest_rate": round(random.uniform(2.5, 4.5), 4),
                "branch_code": branch["branch_code"], "region": branch["region"],
                "country": branch["country"], "opened_at": opened.isoformat()}, opened)
        else:
            account = population[u]
            cid, acc_no = account["customer_id"], account["account_no"]
            branch = by_code.get(account["branch_code"]) or random.choice(branches)
            opened = account["opened_at"]

        in_seg = _in_segment(segment, branch["country"], device)
        active_days = sorted(random.sample(range(days), k=min(days, random.randint(1, 12))))
        for d in active_days:
            hot = in_seg and d >= window_from
            r = moved if hot else base
            if hot:
                moved_days += 1
            day = start + timedelta(days=d, hours=random.randint(6, 21))
            stamp = day.strftime("%Y%m%d")
            session = "fastsess_%s_%s" % (cid, stamp)
            channel = random.choice(DIGITAL_CHANNELS)
            meta = _meta(branch, session, device, channel)

            def ev(name: str, when: datetime):
                body = {"event_id": str(uuid.uuid4()), "session_id": session,
                        "event_name": name, "tenant_id": tenant_id, "user_id": cid,
                        "timestamp": when.timestamp(), "channel": channel.lower(), "metadata": meta}
                events.append([body["event_id"], session, tenant_id, name, cid, channel.lower(),
                               when, json.dumps(body), "clickstream", -1, -1, "", "dev_seed", now])

            ev("login.auth.success", day)
            ev("dashboard.page.view", day + timedelta(seconds=20))
            if random.random() < r["kyc_start"]:
                ev(KYC_STARTED, day + timedelta(seconds=60))
                completes = random.random() < r["kyc_completion"]
                kyc_step = 3 if completes else random.choice([1, 2])
                if completes:
                    ev(KYC_COMPLETED, day + timedelta(seconds=180))
                applied = completes and random.random() < r["loan_application"]
                if applied:
                    ev(LOAN_APPLIED, day + timedelta(seconds=300))
                approved = applied and random.random() < r["loan_approval"]
                app_id = "fastapp_%s_%s" % (cid, stamp)
                _core(app_id, "loan_applications", "nexabank_core", {
                    "application_id": app_id, "tenant_id": tenant_id, "customer_id": cid,
                    "loan_type": random.choice(LOAN_TYPES),
                    "status": "APPROVED" if approved else ("REJECTED" if applied else "PENDING"),
                    "principal_amount": random.randrange(50000, 2000000),
                    "interest_rate": round(random.uniform(7, 14), 4),
                    "term_months": random.choice([12, 24, 36, 48, 60]), "kyc_step": kyc_step,
                    "created_at": day.isoformat(),
                    "decided_at": (day + timedelta(hours=6)).isoformat() if applied else None,
                    "updated_at": (day + timedelta(hours=6)).isoformat()},
                    day + timedelta(hours=6))
                if approved:
                    ev(LOAN_APPROVED, day + timedelta(seconds=420))
            if random.random() < r["pro_conversion"]:
                ev(random.choice(PRO_EVENTS), day + timedelta(seconds=500))
                # a PRO_LICENSE_FEE transaction backs pro_revenue
                _core("fasttxn_%s" % uuid.uuid4().hex[:14], "transactions", "nexabank_core", {
                    "txn_id": "fasttxn_%s" % uuid.uuid4().hex[:14], "tenant_id": tenant_id,
                    "customer_id": cid, "account_no": acc_no, "counterparty_acc": "EXTERNAL-BANK",
                    "direction": "out", "branch_code": branch["branch_code"],
                    "region": branch["region"], "country": branch["country"],
                    "txn_type": "PRO_LICENSE_FEE", "category": "Subscription", "mcc": "",
                    "merchant_name": "NexaBank Pro", "reference_number": uuid.uuid4().hex[:10].upper(),
                    "channel": channel, "status": "SUCCESS", "amount": random.choice([499, 999, 1999]),
                    "occurred_at": (day + timedelta(seconds=520)).isoformat()},
                    day + timedelta(seconds=520))
            for _ in range(random.randint(0, int(r["txn_max_per_day"]))):
                ttype = random.choices(TXN_TYPES, weights=[30, r["withdrawal_weight"], 35, 15])[0]
                txn_channel = (random.choice(DIGITAL_CHANNELS) if random.random() < r["digital_share"]
                               else random.choice(NON_DIGITAL_CHANNELS))
                when = day + timedelta(seconds=random.randint(600, 30000))
                txid = "fasttxn_%s" % uuid.uuid4().hex[:14]
                _core(txid, "transactions", "nexabank_core", {
                    "txn_id": txid, "tenant_id": tenant_id, "customer_id": cid, "account_no": acc_no,
                    "counterparty_acc": "EXTERNAL-BANK", "direction": "in" if ttype == "DEPOSIT" else "out",
                    "branch_code": branch["branch_code"], "region": branch["region"],
                    "country": branch["country"], "txn_type": ttype,
                    "category": random.choice(CATEGORIES), "mcc": "5411", "merchant_name": "FastMart",
                    "reference_number": uuid.uuid4().hex[:10].upper(), "channel": txn_channel,
                    "status": "FAILED" if random.random() < r["txn_failure"] else "SUCCESS",
                    "amount": round(random.uniform(200, 25000), 2),
                    "occurred_at": when.isoformat()}, when)

    written: dict = {}
    client = _client()
    try:
        if core:
            client.insert(f"{BRONZE}.core_banking", core,
                          column_names=["record_id", "entity", "tenant_id", "_source_id",
                                        "_extracted_at", "_source_updated_at", "_page_watermark",
                                        "_page_cursor_id", "_raw", "_ingested_at"])
        if events:
            client.insert(f"{BRONZE}.events", events,
                          column_names=["event_id", "session_id", "tenant_id", "event_name",
                                        "user_id", "channel", "timestamp", "_raw", "_source_id",
                                        "_kafka_partition", "_kafka_offset", "_kafka_topic",
                                        "_ingest_path", "_ingested_at"])
        written["bronze_core_banking"] = len(core)
        written["bronze_events"] = len(events)
    finally:
        try:
            client.close()
        except Exception:
            pass
    try:
        record_freshness("nexabank_core", tenant_id, now, len(core))
    except Exception:
        pass

    written["users"] = users
    written["days"] = days
    written["run"] = run
    written["create_accounts"] = create_accounts
    written["applied"] = {
        "window_days": window_days, "segment": segment or None,
        "changed_rates": {k: v for k, v in moved.items() if v != BASELINE_RATES[k]} or None,
        "user_days_in_movement": moved_days,
    }
    return written


def run_transforms_for_seed(gold_days: int = 120) -> dict:
    # reconcile=False: the seed batch is the newest bronze batch, so reconciling would delete
    # every real customer/branch that a genuine extract landed earlier.
    out = {"silver_facts": silver_facts.run(reconcile=False),
           "gold_kpi": gold_kpi.run(days=gold_days)}
    try:
        out["silver_events"] = silver_events.run()
        out["silver_sessions"] = silver_sessions.run()
        out["gold_funnel"] = gold_funnel.run(days=gold_days)
    except Exception:
        logger.exception("context transforms failed during seed")
    return out


# ── purge ───────────────────────────────────────────────────────────────────
_PURGE = {
    # case-insensitive: account record_ids are 'FAST…', the rest are 'fast…'
    "bronze.core_banking": "startsWith(lower(record_id), 'fast')",
    "bronze.events": "_ingest_path = 'dev_seed'",
}


def purge(tenant_id: str = "nexabank", tables: list[str] | None = None) -> dict:
    wanted = list(tables) if tables else list(_PURGE)
    unknown = [t for t in wanted if t not in _PURGE]
    if unknown:
        raise ValueError("not tables dev-seed writes: %s" % ", ".join(sorted(unknown)))
    removed = {}
    client = _client()
    try:
        for table in wanted:
            pred = _PURGE[table]
            n = client.query(
                f"SELECT count() FROM {table} WHERE tenant_id = %(t)s AND {pred}",
                parameters={"t": tenant_id}).result_rows[0][0]
            if n:
                client.command(
                    f"ALTER TABLE {table} DELETE WHERE tenant_id = %(t)s AND {pred}",
                    parameters={"t": tenant_id}, settings={"mutations_sync": 1})
            removed[table] = int(n)
    finally:
        try:
            client.close()
        except Exception:
            pass
    # rebuild silver/gold from what's left
    removed["transforms"] = run_transforms_for_seed()
    return removed
