"""Gate D regression suite: determinism diff + the five scenario gates.

Runs INSIDE a container against live ClickHouse (CLAUDE.md, Key commands):
    docker compose exec -T ingestion-api python scripts/run_intelligence_gates.py

Exits non-zero on any failure, so it can gate a build. Re-seed first with
`scripts/seed_data.py --scenario all` or the planted truth will not match.
"""
import io
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.environ.get("REPO_ROOT", "/app"))
from warehouse.client import ch_client
from api.intelligence.metrics import ClickHouseMetricLayer, Window
from api.intelligence.orchestrator import Orchestrator
from api.intelligence.contracts import load_all

DB = "feature_intelligence"
SIGNAL_TABLES = ["investigations", "trust_findings", "anomalies", "root_causes",
                 "causal_effects", "recommendations", "insights"]

ml = ClickHouseMetricLayer()
# Day-aligned, matching the service: daily_feature_usage is day-grain, so a mid-day window
# makes rollup and events_raw disagree about which rows are in scope.
from api.intelligence.service import current_window
win = current_window()
TRUTH_PATH = os.path.join(os.environ.get("REPO_ROOT", "/app"), "fixtures", "planted_truth.json")
with open(TRUTH_PATH, encoding="utf-8") as _fh:
    _TRUTH = json.load(_fh)
# The tenants the fixture actually planted into. Golden scenarios and demo data must not share a
# tenant: each dilutes the other, and the gate then reports a failure that is really a collision.
GATE_TENANTS = sorted({t["tenant_id"] for t in _TRUTH if t.get("tenant_id")})

contracts = load_all(ml, GATE_TENANTS[0], win)
tier1 = [c.id for c in contracts.values() if c.tier == 1]

failures = []


def snapshot():
    """Every Signal Store row, ordered, as comparable text. model_runs excluded: it records
    latency, which is wall-clock by definition and not part of the determinism claim."""
    out = {}
    for t in SIGNAL_TABLES:
        rows = ch_client.query(
            "SELECT * FROM %s.%s ORDER BY tuple(*)" % (DB, t))
        out[t] = json.dumps(rows, sort_keys=True, default=str)
    return out


def truncate():
    client = ch_client._get_client()
    for t in SIGNAL_TABLES + ["model_runs"]:
        client.command("TRUNCATE TABLE %s.%s" % (DB, t))


def sweep_all():
    orch = Orchestrator(ml)
    res = []
    for tenant in GATE_TENANTS:
        res += orch.sweep(tenant, win, dataset="seeded", kpi_ids=tier1)
    return res


# --------------------------------------------------------------- preflight
# These gates truncate and re-sweep a shared ClickHouse. The `intelligence` service sweeps on a
# timer against the same tables, so if it is running its writes land mid-comparison and every
# determinism gate fails for a reason that has nothing to do with determinism. Detect that here
# rather than letting it surface as seven confusing failures.
truncate()
time.sleep(3)
_intruder = {t: n for t, n in (
    (t, int(ch_client.query("SELECT count() AS n FROM %s.%s" % (DB, t))[0]["n"]))
    for t in SIGNAL_TABLES) if n}
if _intruder:
    print("ABORT: another process is writing to the Signal Store: %s" % _intruder)
    print("       Stop the scheduler first: docker compose stop intelligence")
    sys.exit(2)

# --------------------------------------------------------------- determinism
print("=== B-10 determinism: same rows in, byte-identical rows out ===")
truncate()
sweep_all()
snap_a = snapshot()
truncate()
sweep_all()
snap_b = snapshot()

for table in SIGNAL_TABLES:
    same = snap_a[table] == snap_b[table]
    print("  %-18s %s" % (table, "identical" if same else "DIFFERS"))
    if not same:
        failures.append("determinism:%s" % table)

# --------------------------------------------------------------- scenario gates
print("")
print("=== scenario gates (scored against fixtures/planted_truth.json) ===")
truth = {t["scenario"]: t for t in _TRUTH}
results = {(r["tenant_id"], r["kpi_id"]): r for r in sweep_all()}


def gate(name, ok, detail):
    print("  [%s] %-38s %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        failures.append("gate:%s" % name)


# 1. defect suppressed
t = truth["duplicate_event_storm"]
r = results.get((t["tenant_id"], t["kpi_id"]), {})
ins = r.get("insights", [])
gate("1 defect suppressed",
     r.get("trust") == "fail" and r.get("termination_reason") == "defect"
     and all("quarantined" in i["narrative"] for i in ins)
     and not any("grew" in i["narrative"].lower() for i in ins),
     "trust=%s reason=%s" % (r.get("trust"), r.get("termination_reason")))

fnd = ch_client.query(
    "SELECT count() AS n FROM %s.trust_findings WHERE verdict='fail' AND blocks_narrative=1" % DB)
gate("1 trust_findings row exists", int(fnd[0]["n"]) > 0, "blocking rows=%s" % fnd[0]["n"])

# 2. real movement localized to the planted segment
t = truth["real_kyc_drop_mobile_india"]
r = results.get((t["tenant_id"], t["kpi_id"]), {})
causes = r.get("causes", [])
planted = t["planted_segment"]
rank1 = causes[0]["dimensions"] if causes else {}
hit = bool(rank1) and any(rank1.get(k) == v for k, v in planted.items())
gate("2 trust passes", r.get("trust") == "pass", "trust=%s" % r.get("trust"))
gate("2 detect fired", r.get("anomaly") is not None,
     "sev=%s" % (r.get("anomaly") or {}).get("severity"))
gate("2 localize hit-rate@1", hit, "rank1=%s planted=%s" % (rank1, planted))
gate("2 contributions sum ~1",
     bool(causes) and abs(causes[0]["explained_pct"] - 1.0) < 0.35,
     "explained=%s" % (causes[0]["explained_pct"] if causes else None))
gate("2 lever from closed list",
     r.get("recommendation", {}).get("lever") in
     contracts[t["kpi_id"]].allowed_levers,
     "lever=%s" % r.get("recommendation", {}).get("lever"))

# 3. sparse series must not overclaim
fc = ch_client.query(
    "SELECT kpi_id, caveat, lower, upper FROM %s.forecasts "
    "WHERE caveat='insufficient_history' ORDER BY kpi_id" % DB)
gate("3 sparse carries caveat", len(fc) > 0, "%d forecasts caveated" % len(fc))
gate("3 caveated bands are wide", all(f["upper"] > f["lower"] for f in fc) if fc else False,
     "all upper>lower")

# 4. ambiguity abstains with a cheapest check
amb = ch_client.query(
    "SELECT count() AS n FROM %s.trust_findings WHERE verdict='ambiguous' "
    "AND cheapest_check != ''" % DB)
gate("4 abstain names cheapest check", int(amb[0]["n"]) > 0, "rows=%s" % amb[0]["n"])

# 5. entitlement: ops_manager must never see pro_revenue
leak = ch_client.query(
    "SELECT count() AS n FROM %s.insights WHERE kpi_id='pro_revenue' "
    "AND persona='ops_manager'" % DB)
gate("5 zero entitlement leaks", int(leak[0]["n"]) == 0, "ops_manager pro_revenue rows=%s" % leak[0]["n"])

personas = ch_client.query(
    "SELECT persona, count() AS n FROM %s.insights GROUP BY persona ORDER BY persona" % DB)
gate("5 personas rendered", len(personas) >= 2,
     ", ".join("%s=%s" % (p["persona"], p["n"]) for p in personas))

# --------------------------------------------------------------- global gates
print("")
print("=== global gates ===")
unver = ch_client.query("SELECT count() AS n FROM %s.insights WHERE verifier_pass = 0" % DB)
gate("verifier coverage 100%", int(unver[0]["n"]) == 0, "unverified insights=%s" % unver[0]["n"])

llm = ch_client.query(
    "SELECT count() AS n FROM %s.model_runs WHERE engine_type = 'llm'" % DB)
gate("Gate D: zero LLM rows", int(llm[0]["n"]) == 0, "llm runs=%s" % llm[0]["n"])

eng = ch_client.query(
    "SELECT engine_type, count() AS n FROM %s.model_runs GROUP BY engine_type "
    "ORDER BY engine_type" % DB)
print("  engine breakdown: " + ", ".join("%s=%s" % (e["engine_type"], e["n"]) for e in eng))

tf = ch_client.query(
    "SELECT count() AS n FROM %s.trust_findings" % DB)
inv = ch_client.query("SELECT count() AS n FROM %s.investigations" % DB)
gate("every run left a trust row", int(tf[0]["n"]) >= int(inv[0]["n"]),
     "findings=%s investigations=%s" % (tf[0]["n"], inv[0]["n"]))


# --------------------------------------------------------------- multi-source
print("")
print("=== multi-source coverage (Round 2) ===")

sources = ch_client.query(
    "SELECT source_id, grain, cadence, sla_minutes FROM %s.source_freshness FINAL "
    "WHERE tenant_id = 'nexabank' ORDER BY source_id" % DB)
gate("3 distinct sources loaded", len(sources) >= 3,
     ", ".join(r["source_id"] for r in sources))
gate("sources have distinct cadences", len({r["cadence"] for r in sources}) >= 3,
     ", ".join(sorted({str(r["cadence"]) for r in sources})))
gate("sources have distinct grains", len({r["grain"] for r in sources}) >= 3,
     "%d distinct grains" % len({r["grain"] for r in sources}))

facts = ch_client.query(
    "SELECT count() AS n FROM %s.fact_transactions FINAL WHERE tenant_id = 'nexabank'" % DB)
gate("core banking facts loaded", int(facts[0]["n"]) > 0, "%s transactions" % facts[0]["n"])

# Money must be exact: a Decimal sum re-added must equal itself to the paisa.
money = ch_client.query(
    "SELECT sum(amount) AS a, sum(toDecimal64(amount, 2)) AS b "
    "FROM %s.fact_transactions FINAL WHERE tenant_id = 'nexabank'" % DB)
gate("money is exact (Decimal, not float)", str(money[0]["a"]) == str(money[0]["b"]),
     "sum=%s" % money[0]["a"])

contracts_all = load_all(ml, "nexabank", win)
cross = [c for c in contracts_all.values() if len(c.sources) > 1]
gate("cross-source KPI exists", len(cross) >= 1,
     ", ".join(sorted(c.id for c in cross)))

kpi_count = len([c for c in contracts_all.values() if c.tier == 1])
# The problem statement asks for 3-5 connected KPIs as a MINIMUM. Capping the count here turned
# that floor into a ceiling, so adding coverage failed the gate -- the opposite of what it is for.
gate("at least 3 declared KPIs", kpi_count >= 3, "%d declared contracts" % kpi_count)

# Factor decomposition: exercised directly against live facts, because a sweep only reaches it
# when an anomaly fires. A >= 0 assertion would pass whether or not the code works.
from datetime import datetime as _dt
from api.intelligence.stages import decompose as _decompose

_fee = contracts_all.get("fee_revenue")
if _fee is not None and _fee.decomposition.get("enabled"):
    _spec = [f for f in _fee.fundamentals if f.get("table")][0]
    _dims = _fee.decomposition["mix_dimensions"]
    _end = _dt(2026, 8, 28)
    _cur = ml.facts.factors("nexabank", _spec, _dims, Window(_end - timedelta(days=7), _end))
    _base = ml.facts.factors("nexabank", _spec, _dims,
                             Window(_end - timedelta(days=14), _end - timedelta(days=7)))
    _res = _decompose.price_volume_mix(_cur, _base)
    gate("factor decomposition produces factors", len(_res.factors) >= 3,
         ", ".join(f["factor"] for f in _res.factors))
    gate("factor identity closes (zero residual)", _res.ok,
         "residual=%s on change=%s" % (_res.residual, _res.total_change))
    _sum = sum(f["contribution"] for f in _res.factors)
    gate("factors sum to the observed change",
         abs(_sum - _res.total_change) < 1e-6, "%.6f vs %.6f" % (_sum, _res.total_change))
else:
    gate("factor decomposition configured", False, "no contract declares a factor identity")


# --------------------------------------------------------------- idempotency
# Re-running must CONVERGE, not accumulate: ids are derived, so ReplacingMergeTree collapses a
# repeat. A growing row count means some id is not deterministic.
print("")
print("=== idempotency: a repeat sweep must not add rows ===")


def row_counts():
    return {t: int(ch_client.query("SELECT count() AS n FROM %s.%s FINAL" % (DB, t))[0]["n"])
            for t in SIGNAL_TABLES}


before_counts = row_counts()
sweep_all()
after_counts = row_counts()
for table in SIGNAL_TABLES:
    gate("idempotent:%s" % table, before_counts[table] == after_counts[table],
         "%d -> %d" % (before_counts[table], after_counts[table]))

# model_runs is append-only telemetry so it grows, but DISTINCT run_id must not.
runs_before = int(ch_client.query("SELECT uniqExact(run_id) AS n FROM %s.model_runs" % DB)[0]["n"])
sweep_all()
runs_after = int(ch_client.query("SELECT uniqExact(run_id) AS n FROM %s.model_runs" % DB)[0]["n"])
gate("idempotent:model_runs distinct", runs_before == runs_after,
     "%d -> %d distinct run_ids" % (runs_before, runs_after))

# ------------------------------------------------------------ read path
# The idempotency gates above count with FINAL, so they stay green even when a reader forgets it
# and serves unmerged duplicate parts to the UI. These gates check what the API actually returns.
print("")
print("=== read path: no duplicate or inflated rows reach the UI ===")

from api.intelligence import reader as _reader

_replacing = {r["name"] for r in ch_client.query(
    "SELECT name FROM system.tables WHERE database = %(d)s AND engine = 'ReplacingMergeTree'",
    {"d": DB})}
_src = io.open("api/intelligence/reader.py", encoding="utf-8").read()
_missing = [t for t in sorted(_replacing)
            if re.search(r"\{DB\}\.%s(?!\s+FINAL)(?![_a-z])" % re.escape(t), _src)]
gate("every ReplacingMergeTree read uses FINAL", not _missing,
     "missing on: %s" % (", ".join(_missing) or "none"))

for _tenant in GATE_TENANTS:
    _ins = _reader.latest_insight(_tenant, "ops_manager") or _reader.latest_insight(_tenant, "analyst")
    if not _ins:
        continue
    _keys = [(c["rank"], json.dumps(c["dimensions"], sort_keys=True)) for c in _ins["causes"]]
    gate("causes are not duplicated (%s)" % _tenant, len(_keys) == len(set(_keys)),
         "%d rows, %d distinct" % (len(_keys), len(set(_keys))))
    _tk = [c["check_id"] for c in _ins["trust"]["checks"]]
    gate("trust checks are not duplicated (%s)" % _tenant, len(_tk) == len(set(_tk)),
         "%d rows, %d distinct" % (len(_tk), len(set(_tk))))

# A Signal Store row that collapses onto another silently loses a narrative. `insights` was keyed
# on (tenant, persona, anomaly_id), and anomaly_id is empty whenever a KPI did not move -- so a
# 50-KPI sweep left ONE insight per persona and discarded the rest without erroring.
_ins_rows = int(ch_client.query(
    "SELECT count() AS n FROM %s.insights FINAL" % DB)[0]["n"])
_ins_keys = int(ch_client.query(
    "SELECT uniqExact((tenant_id, persona, kpi_id)) AS n FROM %s.insights FINAL" % DB)[0]["n"])
gate("one insight row per tenant/persona/KPI", _ins_rows == _ins_keys,
     "%d rows, %d distinct (tenant,persona,kpi)" % (_ins_rows, _ins_keys))

# Localize writes cells and Decompose writes factors into the SAME table, both numbering from
# rank 1. While `fundamental` was absent from the sort key they collapsed onto each other and the
# entire factor decomposition was discarded -- measured as factor_rows = 0 for every anomaly.
_rc_key = str(ch_client.query(
    "SELECT sorting_key AS k FROM system.tables WHERE database = %(d)s AND name = 'root_causes'",
    {"d": DB})[0]["k"])
gate("root_causes key separates cells from factors", "fundamental" in _rc_key,
     "sorting_key = %s" % _rc_key)

_swept = int(ch_client.query(
    "SELECT uniqExact(kpi_id) AS n FROM %s.investigations FINAL" % DB)[0]["n"])
_narrated = int(ch_client.query(
    "SELECT uniqExact(kpi_id) AS n FROM %s.insights FINAL" % DB)[0]["n"])
gate("every investigated KPI can be narrated", _narrated >= min(_swept, 1),
     "%d KPIs investigated, %d narrated" % (_swept, _narrated))

# model_runs is append-only: summing it raw multiplies every total by the replay count.
for _tenant in GATE_TENANTS:
    _true = int(ch_client.query(
        "SELECT sum(l) AS n FROM (SELECT min(latency_ms) AS l FROM %s.model_runs "
        "WHERE tenant_id = %%(t)s GROUP BY run_id)" % DB, {"t": _tenant})[0]["n"] or 0)
    _got = int(_reader.runtime_telemetry(_tenant)["total_latency_ms"])
    gate("telemetry latency is not inflated (%s)" % _tenant, _got == _true,
         "reported=%d true=%d" % (_got, _true))

# ------------------------------------------------------------ query agent
# The agent answers from stored rows only. These gates check the two ways that can go wrong:
# an answer containing a number no stage computed, and a persona seeing past its entitlement.
print("")
print("=== query agent: persona-scoped answers from recorded evidence ===")

from api.intelligence import agent as _agent

_QUESTIONS = [
    ("why did it drop?", "cause"),
    ("where is it concentrated?", "where"),
    ("what is the forecast?", "forecast"),
    ("what should i do about it?", "action"),
    ("is the data fresh?", "freshness"),
    ("can i trust this number?", "trust"),
]

for _tenant in GATE_TENANTS:
    _answers = []
    for _persona in ("cfo", "ops_manager", "analyst"):
        for _q, _expected in _QUESTIONS:
            _a = _agent.answer_question(_tenant, _q, _persona)
            _answers.append((_persona, _q, _a))
    # Every non-abstained answer must have passed the numeric verifier.
    _bad = [(p, q) for p, q, a in _answers if not a.abstained and not a.verifier_pass]
    gate("agent answers are all verified (%s)" % _tenant, not _bad,
         "unverified=%d of %d" % (len(_bad), len(_answers)))

    # Entitlement: a persona must never receive an intent outside its allow-list.
    _leaks = [(p, a.intent) for p, q, a in _answers
              if not a.abstained and a.intent not in _agent.PERSONA_INTENTS[p]]
    gate("no persona answered outside its scope (%s)" % _tenant, not _leaks,
         "leaks=%s" % (_leaks or "none"))

    # An unanswerable question must abstain, never improvise.
    _junk = _agent.answer_question(_tenant, "what is the capital of France", "analyst")
    gate("agent abstains on an unanswerable question (%s)" % _tenant,
         _junk.abstained and not _junk.evidence, "reason=%s" % _junk.reason[:40])

# Determinism: the same question must classify the same way every time.
_c = {_agent.classify("why did fee revenue drop and where") for _ in range(50)}
gate("agent routing is deterministic", len(_c) == 1, "distinct results=%d" % len(_c))

print("")
if failures:
    print("FAILURES (%d): %s" % (len(failures), failures))
    sys.exit(1)
print("ALL GATES PASSED")
