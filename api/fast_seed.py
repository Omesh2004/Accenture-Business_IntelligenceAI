"""Fast mode for the simulate console: mock data written straight to ClickHouse.

WHY THIS EXISTS
---------------
The normal generator (`NexaBank/.../eventRoutes.ts`) writes every row to Postgres first, and
Postgres is remote: ~350ms per round trip against everything else in this stack being a local
container. Even after batching and concurrency a large run is minutes, because the work is
fundamentally "wait on a network". Measured here instead: ~21,000 rows/sec.

Fast mode therefore skips Postgres AND the ingestion/Kafka path, and writes the analytics tables
directly. That is safe for exactly one reason -- this is operator-triggered mock data, never a
real customer record -- and it is the only reason. Nothing else in this repo may write
`events_raw` without going through `POST /events`.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
- No Postgres rows, so these customers do not exist in the NexaBank UI and the extract API has
  nothing to ship for them. Fast mode is for exercising the intelligence layer on volume, not for
  demoing the bank.
- No taxonomy pass. It writes canonical names directly, because there is no producer dialect to
  normalise -- see `canonical_events()` for the names it is allowed to use.
- No ground truth, same as the console: nothing records that a movement was planted. The applied
  behaviour is echoed back to the caller and persisted nowhere, so the engine has to infer the
  movement the way it would for a real incident.

WHAT KEEPS IT HONEST
--------------------
Geography is read from `dim_branch`, not redefined here. That is the whole reason fast mode cannot
drift from slow mode: there is one branch vocabulary and both paths read it. Every fabricated
dimension is declared in `metadata._simulated`, exactly as the live producer declares it, so
Localize refuses to slice them unless the dataset says seeded.
"""
from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from storage.client import ch_client
from api.intelligence.loaders import (OPENING_COLUMNS, CARD_COLUMNS, CUSTOMER_COLUMNS,
                                      INTERACTION_COLUMNS, TXN_COLUMNS, APP_COLUMNS,
                                      record_freshness)

DB = "feature_intelligence"

# The canonical names the KPI contracts count. Written directly: fast mode has no producer
# dialect to normalise, so `event_name` and `event_name_canonical` are the same string.
KYC_STARTED = "loan.kyc_started.success"
KYC_COMPLETED = "loan.kyc_completed.success"
LOAN_APPLIED = "loan.applied.success"
LOAN_APPROVED = "loan.approved.success"
PRO_EVENTS = [
    "crypto-trading.trade_execution.success",
    "wealth-management-pro.rebalance.success",
    "bulk-payroll-processing.batch.success",
    "ai-insights.book.success",
]

# Dimensions this generator invents. Same list the live producer declares, for the same reason:
# a value nobody measured must never reach a cube search unmarked (CLAUDE.md rule 13).
# `country` carries the same dice roll as `location` and must be declared with it.
SIMULATED_DIMS = ["location", "country", "city", "continent", "device_type", "channel",
                  "response_time_ms"]

# events_raw's own column order. clickhouse-connect maps POSITIONALLY, so a same-length list in
# the wrong order writes each value into its neighbour's column and corrupts silently.
# tests/test_fast_seed.py asserts this against the live table.
EVENT_COLUMNS = ["event_id", "session_id", "tenant_id", "event_name", "user_id", "channel",
                 "timestamp", "metadata", "kafka_partition", "kafka_offset", "kafka_topic",
                 "ingested_at", "ingest_path", "_inserted_at", "event_name_canonical"]

# The generator's baseline. A run with no `behavior` produces exactly this distribution, and a
# planted movement is expressed as an override of these inside a window and (optionally) a segment.
# Two properties make a movement RECOVERABLE, and both are exposed: a window, so earlier days run at
# baseline and there is something to measure against; and a segment, so the movement concentrates in
# a cell Localize can actually find. See docs/SCENARIOS.md.
BASELINE_RATES = {
    "kyc_start": 0.45,          # chance an active day starts KYC
    "kyc_completion": 0.68,     # of starts, the share that complete -> kyc_completion_rate
    "loan_application": 0.50,   # of completions, the share that apply
    "loan_approval": 0.62,      # of applications, the share approved -> loan_approval_rate
    "pro_conversion": 0.12,     # chance an active day fires a pro event -> pro_revenue
    "card_activation": 0.18,    # chance of the launch product -> new_product_activations
    "campaign_reach": 0.50,     # chance of a campaign interaction -> cost_per_acquisition
    "digital_share": 1.00,      # share of transactions on WEB/MOBILE -> digital_adoption_rate
    "withdrawal_weight": 20,    # weight of WITHDRAWAL in the mix -> net_deposit_growth
    "txn_max_per_day": 4,
}

# Non-digital channels exist so digital_adoption_rate can MOVE. With every transaction on WEB or
# MOBILE the rate is pinned at 1.000 and the KPI is undetectable by construction -- which is exactly
# the state this generator was in before, and why that KPI could only ever look flat.
DIGITAL_CHANNELS = ["WEB", "MOBILE"]
NON_DIGITAL_CHANNELS = ["ATM", "POS"]

DEVICES = ["desktop", "mobile", "tablet"]
CHANNELS = ["WEB", "MOBILE"]
TXN_TYPES = ["DEPOSIT", "WITHDRAWAL", "PAYMENT", "TRANSFER"]
CATEGORIES = ["Salary Credit", "Groceries", "Utilities", "Dining", "Travel", "Retail"]
LOAN_TYPES = ["HOME", "AUTO", "PERSONAL", "STUDENT"]
AGE = ["UNDER_25", "AGE_25_34", "AGE_35_49", "AGE_50_64", "AGE_65_PLUS"]
INCOME = ["UNDER_30K", "INC_30K_60K", "INC_60K_100K", "INC_100K_200K", "INC_200K_PLUS"]
EMPLOYMENT = ["SALARIED", "SELF_EMPLOYED", "STUDENT", "RETIRED", "UNEMPLOYED"]
RISK = ["LOW", "MEDIUM", "HIGH"]


def _client():
    return ch_client._get_client()


def _branches(tenant_id: str) -> list[dict]:
    """Geography comes from dim_branch, never from a table defined in this file.

    One vocabulary, read by both paths. Redefining it here is how the bank ended up with two
    disjoint geographies once already.
    """
    client = _client()
    try:
        rows = client.query(
            f"SELECT branch_code, region, country, city FROM {DB}.dim_branch FINAL "
            "WHERE tenant_id = %(t)s", parameters={"t": tenant_id}).result_rows
        return [{"branch_code": r[0], "region": r[1], "country": r[2], "city": r[3]}
                for r in rows]
    finally:
        try:
            client.close()
        except Exception:
            pass


def _campaigns(tenant_id: str) -> list[dict]:
    client = _client()
    try:
        rows = client.query(
            f"SELECT campaign_id, name, channel FROM {DB}.dim_campaign FINAL "
            "WHERE tenant_id = %(t)s", parameters={"t": tenant_id}).result_rows
        return [{"id": r[0], "name": r[1], "channel": r[2]} for r in rows]
    finally:
        try:
            client.close()
        except Exception:
            pass


def _existing_accounts(tenant_id: str) -> list[dict]:
    """The bank's own customers, read from the warehouse rather than invented.

    Fast mode used to mint a customer per run, so every run added a disjoint cohort: 17,995
    synthetic customers against 6 real ones, `new_account_openings` firing on every run, and a
    planted rate movement diluted by the new arrivals instead of measured against them. The
    `fast_` prefix is excluded so an earlier mock population cannot pass for the bank's own --
    these rows reach ClickHouse from Postgres through the extract API, never from here.

    Ordered, because a sample of it decides who generates and that must not vary between runs.
    """
    client = _client()
    try:
        rows = client.query(
            f"SELECT account_no, customer_id, branch_code, region, country, opened_at "
            f"FROM {DB}.fact_account_openings FINAL "
            "WHERE tenant_id = %(t)s AND NOT startsWith(customer_id, 'fast_') "
            "ORDER BY account_no", parameters={"t": tenant_id}).result_rows
        return [{"account_no": r[0], "customer_id": r[1], "branch_code": r[2],
                 "region": r[3], "country": r[4], "opened_at": r[5]} for r in rows]
    finally:
        try:
            client.close()
        except Exception:
            pass


def _meta(branch: dict, session_id: str, device: str, channel: str, extra=None) -> str:
    m = {
        "session_id": session_id,
        "location": branch["country"],
        "country": branch["country"],
        "city": branch["city"],
        "continent": branch["region"],
        "device_type": device,
        "channel": channel,
        "response_time_ms": int(random.lognormvariate(4.0, 0.7)),
        # Every key above is invented. Declaring it is what stops Localize ranking cells over it.
        "_simulated": SIMULATED_DIMS,
    }
    if extra:
        m.update(extra)
    return json.dumps(m)


def resolve_behavior(behavior: dict | None) -> tuple[dict, int, dict]:
    """(rates_inside_the_movement, window_days, segment). Unknown keys are dropped, not coerced.

    `behavior` is the same idea as the slow console's block, reduced to what this generator can
    actually express:

        {"window_days": 7,
         "segment": {"country": "India", "device_type": "mobile"},
         "rates": {"kyc_completion": 0.35}}

    Outside the window -- and outside the segment when one is given -- every rate stays at
    BASELINE_RATES. That is what gives Detect a baseline to score against and Localize a cell to
    find; a run whose movement covers every day and every user is a level shift with nothing to
    compare it to.
    """
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


# The console's templates speak the SLOW generator's vocabulary: an event id and a traffic
# multiplier. This generator speaks in rates. Each template names the step it thins, so the two
# vocabularies do line up -- they were simply never connected, and `resolve_behavior` drops what it
# does not recognise. Every template therefore ran as a no-op in fast mode: data was written, no
# movement was planted, and the run reported success.
_EVENT_TO_RATE = {
    "loan.kyc_started.success": "kyc_start",
    "loan.kyc_completed.success": "kyc_completion",
    "loan.kyc.failure": "kyc_completion",        # more rejections == fewer completions
    "loan.applied.success": "loan_application",
    "loan.approved.success": "loan_approval",
    "features.unlock.success": "pro_conversion",
    "features.unlock.failed": "pro_conversion",  # more failures == fewer conversions
    "card.activation.success": "card_activation",
    "campaign.interaction.success": "campaign_reach",
    "transaction.pay_now.success": "digital_share",
}

# Rates that are not a probability in [0, 1]. Clamping a weight to 1 would silently turn a
# "withdrawals triple" template into a no-op.
_UNBOUNDED_RATES = {"withdrawal_weight", "txn_max_per_day"}


def _translate_console_behavior(behavior: dict) -> dict:
    """Accept the console's template shape as well as this generator's own.

    The console speaks the SLOW generator's vocabulary -- a list of `targets`, each an event id
    with a traffic or failure multiplier -- while this one speaks in rates. Every template names
    the step it thins, so the two do line up; they were simply never connected, and
    `resolve_behavior` drops what it does not recognise. The result was that every template ran as
    a no-op in fast mode: data was written, no movement was planted, and the run reported success.
    """
    if "rates" in behavior or "window_days" in behavior:
        return behavior                                   # already native

    out: dict = {"window_days": int(behavior.get("windowDays") or 0)}

    segment = dict(behavior.get("segment") or {})
    # The console says `location` where the metadata key is `country`; both name the same thing.
    if "location" in segment and "country" not in segment:
        segment["country"] = segment.pop("location")
    out["segment"] = segment

    # `targets` is a LIST. Reading it as a flat object silently matched nothing, which is the same
    # failure this function exists to fix, one level down.
    targets = behavior.get("targets")
    if isinstance(behavior.get("id"), str):
        targets = [behavior]                              # tolerate a single flat target too
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
            # A failure multiplier is the same movement seen from the other side: 4x the failures
            # leaves roughly a quarter of the successes.
            value = base / float(target["failure"])
        else:
            continue
        rates[key] = max(0.0, value if key in _UNBOUNDED_RATES else min(1.0, value))
    if rates:
        out["rates"] = rates

    # A population-mix template moves WHO is active rather than any rate, so it carries no rate
    # change and is expressed as the segment it concentrates on.
    mix = behavior.get("mix") or {}
    if mix and not out.get("segment"):
        weights = mix.get("countryWeights") or mix.get("deviceWeights") or {}
        top = max(weights, key=weights.get) if weights else ""
        if top:
            out["segment"] = {"country" if mix.get("countryWeights") else "device_type": top}
    return out


def _in_segment(segment: dict, country: str, device: str) -> bool:
    if not segment:
        return True
    if "country" in segment and segment["country"].lower() != country.lower():
        return False
    if "device_type" in segment and segment["device_type"].lower() != device.lower():
        return False
    return True


def generate(tenant_id: str = "nexabank", users: int = 100, days: int = 30,
             seed: int | None = None, behavior: dict | None = None,
             create_accounts: bool = False) -> dict:
    """Build and insert a coherent dataset for every KPI. Returns per-table row counts.

    With `behavior`, a movement is planted inside a trailing window and an optional segment; every
    other day and cell generates at baseline, so the movement is measurable rather than merely
    present.

    By default this generates ACTIVITY FOR CUSTOMERS THE BANK ALREADY HAS. Creating a population
    is a separate decision (`create_accounts`), because doing it on every run gave each run its own
    disjoint cohort: openings spiked every time, and a planted rate change was diluted by arrivals
    rather than measured against a stable base.
    """
    if seed is not None:
        random.seed(seed)
    users = max(1, min(int(users), 5000))
    days = max(1, min(int(days), 365))
    moved, window_days, segment = resolve_behavior(behavior)
    base = dict(BASELINE_RATES)

    branches = _branches(tenant_id)
    if not branches:
        raise ValueError(
            "no branches in dim_branch for %r -- run seedReferenceData.ts and the market_ops "
            "loader first; fast mode reads its geography from there rather than inventing one"
            % tenant_id)
    by_code = {b["branch_code"]: b for b in branches}
    campaigns = _campaigns(tenant_id)

    # Refusing is the correct answer to "generate for customers that do not exist": silently
    # inventing them is the behaviour this parameter was added to stop.
    population: list[dict] = [] if create_accounts else _existing_accounts(tenant_id)
    if not create_accounts:
        if not population:
            raise ValueError(
                "no existing accounts for %r -- fast mode generates activity for the bank's own "
                "customers. Create them first (slow simulate, or this endpoint with "
                "create_accounts=true), then run load_core_banking() so the extract carries them "
                "into ClickHouse" % tenant_id)
        users = min(users, len(population))

    now = datetime.utcnow().replace(microsecond=0)
    start = now - timedelta(days=days)
    # Day indices at or above this are "recent" and carry the movement.
    window_from = days - window_days if window_days else days

    # Every run gets its own id namespace. Without it a second call reuses `fast_<tenant>_0000`
    # and the ReplacingMergeTree dims silently overwrite the first run's customers and accounts --
    # which breaks the intended workflow of seeding a wide baseline and then a narrow conditioned
    # window as two separate calls. Events survived (they carry their own uuid) so the damage was
    # invisible in row counts.
    run = uuid.uuid4().hex[:6]

    events, txns, openings, cards, customers, interactions, apps = [], [], [], [], [], [], []
    moved_days = 0

    for u in range(users):
        device = random.choice(DEVICES)
        risk = random.choice(RISK)

        if create_accounts:
            cid = "fast_%s_%s_%04d" % (tenant_id, run, u)
            branch = random.choice(branches)
            opened = start + timedelta(days=random.randint(0, max(0, days - 1)),
                                       seconds=random.randint(0, 86399))
            acc_no = "FAST%s%06d" % (run.upper(), u)
        else:
            # An existing account keeps its own identity, branch and open date, so the geography
            # and the account age the sparse-product KPI reads are the bank's, not this file's.
            account = population[u]
            cid, acc_no = account["customer_id"], account["account_no"]
            branch = by_code.get(account["branch_code"]) or random.choice(branches)
            opened = account["opened_at"]

        in_seg = _in_segment(segment, branch["country"], device)

        if create_accounts:
            customers.append([cid, tenant_id, random.choice(AGE), random.choice(INCOME),
                              random.choice(EMPLOYMENT), risk,
                              Decimal(str(round(random.uniform(200, 30000), 2))), "VERIFIED",
                              branch["branch_code"], branch["region"], branch["country"],
                              now, now])
            openings.append([acc_no, tenant_id, cid, "SAVINGS", "ACTIVE",
                             Decimal(str(round(random.uniform(2.5, 4.5), 4))),
                             branch["branch_code"], branch["region"], branch["country"],
                             opened, now, opened])
            # The debit card is issued AT opening, so it belongs to account creation and not to
            # a run that only generates activity.
            cards.append(["fastcard_%s_d" % cid, tenant_id, cid, acc_no, "Classic Debit", "DEBIT",
                          "VISA", "ACTIVE", Decimal("0"), branch["region"], branch["country"],
                          opened, now, opened])

        # The launch product is deliberately rare -- the sparse-history KPI -- and is an activation
        # on an existing account, so it is generated either way. On the create path the account-age
        # gate keeps it tied to new accounts. An existing population is mostly older than that, so
        # there the gate is the launch itself and the activation is dated inside the run window;
        # the run id keeps two activations by one customer from colliding on a ReplacingMergeTree.
        card_rate = moved["card_activation"] if in_seg else base["card_activation"]
        recent_enough = (now - opened).days < 12 if create_accounts else True
        if random.random() < card_rate and recent_enough:
            issued = (opened if create_accounts
                      else start + timedelta(days=random.randint(0, max(0, days - 1)),
                                             seconds=random.randint(0, 86399)))
            cards.append(["fastcard_%s_%s_t" % (cid, run), tenant_id, cid, acc_no,
                          "Student Travel Credit Card", "CREDIT", "VISA", "ACTIVE",
                          Decimal("50000"), branch["region"], branch["country"],
                          issued, now, issued])

        if campaigns and random.random() < (moved["campaign_reach"] if in_seg
                                            else base["campaign_reach"]):
            c = random.choice(campaigns)
            # A campaign touch happens during the run window. Dating it from the account's opening
            # would put an existing customer's interaction years before the campaign it belongs to,
            # and outside every window cost_per_acquisition reads.
            touched = (opened + timedelta(hours=2) if create_accounts
                       else start + timedelta(days=random.randint(0, max(0, days - 1)),
                                              seconds=random.randint(0, 86399)))
            interactions.append(["fastint_%s" % uuid.uuid4().hex[:12], tenant_id, c["id"],
                                 c["name"], c["channel"], cid,
                                 random.choice(["IMPRESSION", "CLICK", "CONVERSION"]), risk,
                                 branch["region"], branch["country"],
                                 touched, now, touched])

        active_days = sorted(random.sample(range(days), k=min(days, random.randint(1, 12))))
        for d in active_days:
            # The movement applies only inside the trailing window AND, when one is given, only to
            # sessions in the segment. Everything else stays at baseline.
            hot = in_seg and d >= window_from
            r = moved if hot else base
            if hot:
                moved_days += 1

            day = start + timedelta(days=d, hours=random.randint(6, 21))
            # Keyed on the DATE, not the day index. `d` is an offset into `days`, so a 7-day run
            # produced ids _0.._6 that collided with a 30-day run's ids for dates a month earlier;
            # fact_loan_applications is ReplacingMergeTree ORDER BY (tenant_id, application_id), so
            # the new rows silently replaced that older history and moved it into the recent window.
            # Row counts looked right, which is what made it invisible. A date key makes a re-run
            # for the same customer-day idempotent and leaves every other day alone.
            stamp = day.strftime("%Y%m%d")
            session = "fastsess_%s_%s" % (cid, stamp)
            channel = random.choice(DIGITAL_CHANNELS)
            meta = _meta(branch, session, device, channel)

            def ev(name: str, when: datetime, m: str = meta):
                events.append([str(uuid.uuid4()), session, tenant_id, name, cid,
                               channel.lower(), when, m, -1, -1, "", now, "fast_seed", now, name])

            ev("login.auth.success", day)
            ev("dashboard.page.view", day + timedelta(seconds=20))

            # KYC funnel -- the ratio KPI. Completion is a real, varying rate.
            if random.random() < r["kyc_start"]:
                ev(KYC_STARTED, day + timedelta(seconds=60))
                if random.random() < r["kyc_completion"]:
                    ev(KYC_COMPLETED, day + timedelta(seconds=180))
                    # The loan funnel sits downstream of KYC, as the contract graph declares.
                    if random.random() < r["loan_application"]:
                        ev(LOAN_APPLIED, day + timedelta(seconds=300))
                        app_id = "fastapp_%s_%s" % (cid, stamp)
                        approved = random.random() < r["loan_approval"]
                        apps.append([app_id, tenant_id, cid, random.choice(LOAN_TYPES),
                                     "APPROVED" if approved else "REJECTED",
                                     Decimal(str(random.randrange(50000, 2000000))),
                                     Decimal(str(round(random.uniform(7, 14), 4))),
                                     random.choice([12, 24, 36, 48, 60]), 3,
                                     day, day + timedelta(hours=6), now, day])
                        if approved:
                            ev(LOAN_APPROVED, day + timedelta(seconds=420))

            if random.random() < r["pro_conversion"]:
                ev(random.choice(PRO_EVENTS), day + timedelta(seconds=500))

            # Transactions. `digital_share` is what lets digital_adoption_rate move at all, and
            # `withdrawal_weight` is what lets net_deposit_growth swing without touching deposits.
            for _ in range(random.randint(0, int(r["txn_max_per_day"]))):
                ttype = random.choices(
                    TXN_TYPES, weights=[30, r["withdrawal_weight"], 35, 15])[0]
                txn_channel = (random.choice(DIGITAL_CHANNELS)
                               if random.random() < r["digital_share"]
                               else random.choice(NON_DIGITAL_CHANNELS))
                amount = Decimal(str(round(random.uniform(200, 25000), 2)))
                when = day + timedelta(seconds=random.randint(600, 30000))
                txns.append(["fasttxn_%s" % uuid.uuid4().hex[:14], tenant_id, cid, acc_no,
                             "EXTERNAL-BANK", "in" if ttype == "DEPOSIT" else "out",
                             branch["branch_code"], branch["region"], branch["country"],
                             ttype, random.choice(CATEGORIES), "5411", "FastMart",
                             uuid.uuid4().hex[:12].upper(), txn_channel, "SUCCESS", amount,
                             when, now, when])

    written = {}
    client = _client()
    try:
        for table, cols, rows in (
            ("events_raw", EVENT_COLUMNS, events),
            ("fact_transactions", TXN_COLUMNS, txns),
            ("fact_account_openings", OPENING_COLUMNS, openings),
            ("fact_cards", CARD_COLUMNS, cards),
            ("dim_customer", CUSTOMER_COLUMNS, customers),
            ("fact_campaign_interactions", INTERACTION_COLUMNS, interactions),
            ("fact_loan_applications", APP_COLUMNS, apps),
        ):
            if rows:
                client.insert("%s.%s" % (DB, table), rows, column_names=cols)
            written[table] = len(rows)
    finally:
        try:
            client.close()
        except Exception:
            pass

    # Fast mode writes the batch facts directly, so nothing else marks those sources loaded and
    # Trust Gate gates every retail KPI on `source_present`. Bookkeeping: never fail the seed.
    try:
        if txns:
            occurred_at = TXN_COLUMNS.index("occurred_at")
            record_freshness("nexabank_core", tenant_id,
                             max(t[occurred_at] for t in txns), len(txns))
        if interactions:
            record_freshness("nexabank_crm", tenant_id, now, len(interactions))
    except Exception:
        pass

    written["users"] = users
    written["days"] = days
    written["run"] = run
    # Which population this run acted on. Without it a reuse run and a create run are
    # indistinguishable on the operator's screen, which is how a growing synthetic cohort went
    # unnoticed for so long.
    written["create_accounts"] = create_accounts
    written["population"] = ("created" if create_accounts
                             else "existing (%d accounts available)" % len(population))
    # Echoed for the operator's screen, exactly like the slow console: persisted nowhere, so the
    # engine still has to infer the movement rather than look it up.
    written["applied"] = {
        "window_days": window_days,
        "segment": segment or None,
        "changed_rates": {k: v for k, v in moved.items() if v != BASELINE_RATES[k]} or None,
        "user_days_in_movement": moved_days,
    }
    return written


# How each table's mock rows are recognised. `events_raw` is matched on `ingest_path`, NOT on an
# id prefix: fast mode generates activity for the bank's OWN customers, so `user_id` holds a real
# customer id and the old `startsWith(user_id, 'fast_')` test matched nothing at all. Every event
# fast mode ever wrote survived a purge that reported success, which is why a "reset" left the
# clickstream KPIs exactly where they were. Only a `create_accounts` run ever minted `fast_` users.
_PURGE_PREDICATE = {
    "events_raw": "ingest_path = 'fast_seed'",
    "fact_transactions": "startsWith(txn_id, 'fasttxn_')",
    "fact_account_openings": "startsWith(customer_id, 'fast_')",
    "fact_cards": "startsWith(card_id, 'fastcard_')",
    "dim_customer": "startsWith(customer_id, 'fast_')",
    "fact_campaign_interactions": "startsWith(interaction_id, 'fastint_')",
    "fact_loan_applications": "startsWith(application_id, 'fastapp_')",
}


def purge(tenant_id: str = "nexabank", tables: list[str] | None = None) -> dict:
    """Remove what fast mode wrote. Mock data must be reversible.

    `tables` limits the reset to a subset. Resetting one KPI's history used to mean clearing every
    table, so rebuilding the loan series also deleted 30k mock transactions and took the revenue
    and deposit movements with it. A demo needs to rebuild one metric without collateral damage.
    """
    wanted = list(tables) if tables else list(_PURGE_PREDICATE)
    unknown = [t for t in wanted if t not in _PURGE_PREDICATE]
    if unknown:
        raise ValueError("not tables fast mode writes: %s" % ", ".join(sorted(unknown)))
    removed = {}
    client = _client()
    try:
        for table in wanted:
            predicate = _PURGE_PREDICATE[table]
            n = client.query(
                f"SELECT count() FROM {DB}.{table} WHERE tenant_id = %(t)s AND {predicate}",
                parameters={"t": tenant_id}).result_rows[0][0]
            if n:
                client.command(
                    f"ALTER TABLE {DB}.{table} DELETE WHERE tenant_id = %(t)s AND {predicate}",
                    parameters={"t": tenant_id}, settings={"mutations_sync": 1})
            removed[table] = int(n)
    finally:
        try:
            client.close()
        except Exception:
            pass
    return removed
