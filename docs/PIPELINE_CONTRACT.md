# PIPELINE_CONTRACT.md

The buildable interfaces. `docs/PHASE_1.md` says what each stage must achieve and why;
this file says what each stage **receives, returns, and writes**, so two people can build
adjacent stages without agreeing on anything else first.

Everything here is deterministic Python plus ClickHouse. No new dependency except `PyYAML`.

---

## 1. Run lifecycle

An **investigation** is one (tenant, kpi_id, window) run through the pipeline. Its
`investigation_id` is minted before any stage executes and written to every Signal Store row —
see `docs/DATABASE.md`, "The investigation spine".

```
investigation_id = sha1(f"{tenant_id}|{kpi_id}|{window_start.isoformat()}|{trigger}")[:16]
```

Deterministic, so re-running the same window converges on `ReplacingMergeTree` instead of
duplicating. Every stage is idempotent by the same principle: derive the row id from its inputs,
never from `uuid4()` or `now()`.

| id | derived from |
|---|---|
| `investigation_id` | tenant, kpi, window_start, trigger |
| `finding_id` | investigation_id, check_id |
| `anomaly_id` | tenant, kpi, window_start, method |
| `cause_id` | anomaly_id, rank |
| `forecast_id` | tenant, kpi, as_of, method |
| `insight_id` | investigation_id, persona |
| `run_id` | investigation_id, stage, attempt |

Terminal states, all of which write an `investigations` row with `status='terminated'` and a
`termination_reason`:

| Reason | Set by | Produces |
|---|---|---|
| `not_instrumented` | Trust Gate (readiness) | nothing user-facing |
| `defect` | Trust Gate (hard invariant) | an **incident-note** insight, no anomaly |
| `ambiguous` | Trust Gate (soft invariant) | an **abstain** insight, `abstained=1` |
| `no_anomaly` | Detect | nothing user-facing |
| `immaterial` | Detect (materiality floor) | nothing user-facing |
| `completed` | Narrate | a full insight per persona |

## 2. Scheduling — no new infrastructure

`api/main.py:306-309` already runs `@app.on_event("startup")` →
`asyncio.create_task(start_data_layer_refresh(interval_minutes=30))`, and
`api/websocket_manager.py:125-126` starts two more background tasks. Reuse that pattern; do not
add a scheduler service (CLAUDE.md rule 2).

```python
@app.on_event("startup")
async def startup_event():
    asyncio.create_task(run_forecast_batch(interval_minutes=60))     # stage 04, ahead of Detect
    asyncio.create_task(run_investigation_sweep(interval_minutes=15)) # stages 01-07 per KPI
```

Both loops must catch and log every exception per iteration — an unhandled exception kills an
`asyncio` task silently and the pipeline simply stops with no error surface.

Forecast writes bands for **every** contract KPI regardless of readiness (a band is cheap and
Detect needs it). The investigation sweep skips KPIs whose contract `readiness.status` is
`blocked`.

## 3. Stage I/O contracts

Every stage takes a `ctx` (investigation_id, tenant_id, kpi_id, window, the loaded contract) and
returns a typed result. Every stage writes exactly one `model_runs` row per invocation, whether or
not it produced a finding.

```python
@dataclass
class StageResult:
    ok: bool
    terminate: bool              # stop the pipeline here
    reason: str = ""             # a termination_reason when terminate=True
    rows_written: int = 0
    engine_type: str = "stats"   # llm|sql|stats|ml|rule
```

| Stage | Reads | Returns | Writes |
|---|---|---|---|
| 01 Trust Gate | contract, `events_raw` via metric fns | `TrustResult(verdict, fingerprint, cheapest_check)` | `trust_findings` (always, incl. passes) |
| 02 Detect | contract, metric series, `forecasts` | `DetectResult(anomaly \| None, materiality)` | `anomalies` |
| 03 Localize | contract, anomaly, fundamentals per cell | `LocalizeResult(ranked_causes, explained_pct)` | `root_causes` |
| 04 Forecast | contract, metric history | `ForecastResult(point, lower, upper, method, mase, caveat)` | `forecasts` |
| 05 Causal | contract, anomaly, control segments | `CausalResult(rung, effect_interval, degraded_reason)` | `causal_effects` |
| 06 Decide | contract, anomaly, causes | `DecideResult(action, lever, owner_role, impact_interval)` | `recommendations` |
| 07 Narrate | the claim set (§5) | `NarrateResult(per_persona_insights)` | `insights` |
| 08 Observe | all of the above | — | `model_runs`, `investigations` |

**Localize must not receive raw rows.** It receives a `dict[cell_tuple, (numerator, denominator)]`
already aggregated by the metric layer, so it never touches `events_raw` (CLAUDE.md rule 4).

## 4. Materiality — the formula, not a vibe

`anomalies.materiality` is referenced by the Detect floor and by severity, so it needs one
definition. All three factors are in `[0, 1]`; the product is too.

```
materiality = effect × reach × persistence

effect      = min(1, |observed - baseline| / max(|baseline|, epsilon) / critical_pct_change)
reach       = affected_denominator / total_denominator_in_window
persistence = min(1, consecutive_breaching_windows / min_persistence_windows)
```

`critical_pct_change` and `min_persistence_windows` come from the contract's `detection` block, so
each KPI sets its own scale. Severity thresholds:

| materiality | severity | behaviour |
|---|---|---|
| `< 0.15` | — | terminate with `immaterial`; nothing surfaces |
| `0.15 – 0.40` | `info` | recorded, not pushed |
| `0.40 – 0.75` | `warn` | surfaced in the dashboard |
| `> 0.75` | `urgent` | surfaced and pinged over the WebSocket |

A categorical anomaly (e.g. the `auth.role.violation` burst in scenario 5) has no meaningful
`baseline`, so it sets `effect = 1.0` and relies on reach and persistence.

## 5. The claim set — how "no invented numbers" is actually enforced

The guarantee is not "trace each number back afterwards". It is **closed-world**: before narration,
build the exhaustive set of values the narrator is permitted to state. Verification is then set
membership, which is decidable, rather than free-form tracing, which is not.

```python
@dataclass(frozen=True)
class Claim:
    key: str          # "anomaly.observed", "cause.1.contribution", "forecast.upper"
    value: float
    display: str      # "18.4%", "1,240" -- exactly how it may appear in prose
    unit: str         # 'ratio'|'count'|'currency'|'pct_change'
    engine_type: str  # sql|stats|ml|rule
    source_table: str # the Signal Store row it came from
    simulated: bool = False
```

The claim set is assembled from Signal Store rows **only** — never from a live query — and is
filtered by persona entitlement (§7) *before* the narrator sees it. Anything not in the set cannot
legally appear in the output.

### Signal card

What the LLM actually receives. Compact, entitlement-filtered, no raw rows, no metadata.

```json
{
  "investigation_id": "a1b2c3d4e5f6",
  "kpi": {"id": "kyc_completion_rate", "name": "KYC Completion Rate",
          "definition": "<the contract's sanctioned sentence, verbatim>"},
  "trust": {"verdict": "pass", "fingerprint": null, "cheapest_check": null},
  "anomaly": {"direction": -1, "severity": "warn",
              "claims": ["anomaly.observed", "anomaly.baseline", "anomaly.magnitude"]},
  "causes": [{"rank": 1, "dimensions": {"device_type": "mobile", "location": "India"},
              "claims": ["cause.1.contribution"]}],
  "forecast": {"method": "seasonal_naive", "caveat": "",
               "claims": ["forecast.point", "forecast.lower", "forecast.upper"]},
  "causal": {"rung": "attribution", "degraded_reason": "no clean pre-period"},
  "recommendation": {"lever": "fix_kyc_step", "owner_role": "growth_analytics",
                     "claims": ["rec.impact_low", "rec.impact_high"]},
  "claim_set": {"anomaly.observed": {"display": "62.1%", "simulated": false}, "...": {}},
  "qualifiers": ["modelled at a fixed $49 per conversion"]
}
```

Cards reference claims **by key**; the narrator must render `display` verbatim. That is what makes
two personas numerically identical by construction.

## 6. Numeric verifier — the algorithm

Runs on the LLM draft before anything is stored or shown.

1. **Extract** every numeric span:
   `[-+]?\d[\d,_]*(\.\d+)?\s*(%|bps)?` plus currency-prefixed forms.
2. **Normalize** to a float: strip separators and symbols; `18%` and `18.0%` → `0.18` when the
   claim's unit is `ratio` or `pct_change`. Keep the raw span for the redaction step.
3. **Match** against the claim set:
   - `unit = count` → exact integer equality. A count is never "about".
   - `unit = ratio | pct_change | currency` → relative tolerance `1e-3`, or absolute `0.05`
     percentage points, whichever is looser.
   - Year-like integers (`1900–2100`) and small ordinals in list markers are ignored.
4. **Verify named entities.** Every dimension value in the prose (`mobile`, `India`) must appear in
   a `root_causes.dimensions` JSON for this investigation. A correct number attached to the wrong
   segment is still wrong.
5. **Verify hedging against the rung.** Causal language (`caused`, `drove`, `because of`,
   `responsible for`) is permitted only when `causal_effects.rung` is `estimated_effect` or
   `experiment`. On `association` or `attribution`, causal phrasing is a **verification failure**
   even when every digit is right.
6. **Verify qualifiers.** If any matched claim has `simulated = true`, the contract's
   `narrative_qualifier` must be present verbatim.
7. **On failure**, in order: regenerate (max 2 attempts, feeding back which span failed) → redact
   the offending spans and mark `verifier_pass = 0` → fall back to the deterministic template.

`verifier_pass = 1` requires **zero** unmatched spans. Partial credit does not exist; the Phase 1
gate is 100% coverage.

The deterministic template is not a degraded afterthought — it is the correctness floor, so build
it **first** and make the LLM path optional. If the template cannot express a scenario, the
scenario is not ready to narrate.

## 7. Personas and entitlement

`cfo`, `ops_manager` and `analyst` appear in every contract's `access_restriction`, but **no such
vocabulary exists anywhere in the codebase today.** `rbac.json` has only `super_admins` and
`app_admins`, keyed by email. That gap has to be closed before scenario 5 is implementable.

Additive change to `rbac.json` (coupling point 3 — additive only, do not restructure):

```json
{
  "super_admins": ["..."],
  "app_admins": { "nexabank": ["..."] },
  "personas": {
    "abhishekkumawat1008@gmail.com": "cfo",
    "default": "analyst"
  }
}
```

Rules:

- The persona is resolved **server-side** from the authenticated identity. A persona passed as a
  query parameter is a demo convenience for switching views and must never widen access — if a
  requested persona exceeds the caller's resolved persona, serve the resolved one.
- Entitlement is applied when the **claim set is built**, not when the narrative is rendered. A
  restricted claim is structurally absent from the LLM context.
- `suppress_for_others` is not optional. Removing `pro_revenue` while leaving
  `pro_conversion_events` lets the reader multiply by the published $49 constant and recover it.
- The two personas must agree on every shared claim. Assert this in the golden run: for each key
  present in both persona claim sets, the values must be identical.

## 8. Dashboard API surface

New reads, all Signal-Store-only and all **outside** the 15s `useDashboard` batch
(`skills/analytics-endpoint`). Fetch on insight open or on the new-insight WebSocket ping.

| Endpoint | Returns |
|---|---|
| `GET /intelligence/insights?tenants=&persona=` | latest insight per KPI, UI-shaped |
| `GET /intelligence/insight/{investigation_id}?persona=` | narrative + evidence card + qualifiers |
| `GET /intelligence/evidence/{investigation_id}` | trust finding, anomaly, ranked causes, forecast, causal rung, recommendation |
| `GET /intelligence/telemetry/{investigation_id}` | LLM-vs-non-LLM breakdown from `model_runs` |
| `POST /intelligence/outcome` | writes an `outcomes` row (useful / root-cause-correct / action-taken) |

`/ai_report` keeps its existing response shape and becomes a thin reader over `insights`
(`docs/DATABASE.md`). Do not change it.

The telemetry endpoint computes the breakdown as a `GROUP BY engine_type` over `model_runs` for
that `investigation_id` — never from anything the model said about itself.

## 9. Build order for implementers

Each step is independently verifiable, which matters because there is no CI.

1. Signal Store DDL + `investigations`; contract loader (`PyYAML`) + the §1 id helpers.
2. FOUNDATION-1..4 (`docs/DATABASE.md`), then re-verify every contract event resolves.
3. Trust Gate + `trust_findings`. **Scenario 1 is now demonstrable end to end** with no LLM at all.
4. Forecast batch + `forecasts`. Detect reads its band.
5. Detect + materiality (§4) + `anomalies`.
6. Localize + `root_causes`. Assert contributions sum to ~1 on the golden run.
7. Claim set + deterministic template narrator. **Every scenario now works without the LLM** —
   this is the point at which the "remove the LLM and it still works" claim becomes testable.
8. Causal, Decide.
9. LLM narrator + verifier (§6), behind the template fallback.
10. Personas + entitlement (§7); assert cross-persona agreement.
11. Dashboard endpoints (§8); `/ai_report` becomes a reader.
12. Golden scenario harness + gates.

Steps 1-7 contain no LLM. That ordering is deliberate: it forces the system to be correct before it
is articulate, and it means a demo exists from step 3 onward.
