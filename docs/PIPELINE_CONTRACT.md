# PIPELINE_CONTRACT.md

The buildable interfaces. `docs/PHASE_1.md` says what each stage must achieve and why;
this file says what each stage **receives, returns, and writes**, so two people can build
adjacent stages without agreeing on anything else first.

Everything here is deterministic Python plus ClickHouse.

**Dependencies:** an earlier version of this line read *"no new dependency except `PyYAML`"*. That
was superseded by the 2026-08-27 decision recorded in `CLAUDE.md` rule 2 — `numpy`/`scipy` are
approved and declared, and `PSqueeze`, a time-series foundation model and `statsmodels` are
approved as optional tiers. The constraint that survives is stricter than a dependency list: every
method writes the same row shape, carries an `engine_type`, degrades to a dependency-free fallback,
and needs zero training data. A library implements a stage; it never becomes a source of truth.

---

## 0. Determinism rules — read before writing any stage

The layer must produce byte-identical Signal Store rows for identical input. Full rationale in
`docs/INTELLIGENCE_LAYER_PROPOSAL.md` §1; these are the rules you break by accident.

1. **Derive ids, never generate them.** No `uuid4()`, no `now()` in an id. See §1 below.
2. **Pin the window once.** `now()` must not appear inside a stage — read `window_start`/
   `window_end` from the `investigations` row.
3. **Exact aggregates only.** ClickHouse's defaults are approximate and two are *randomised*:

   | Never | Always | Why |
   |---|---|---|
   | `uniq()` | `uniqExact()` | HyperLogLog, ~0.5% error |
   | `quantile()` / `median()` | `quantileExact()` / `medianExact()` | reservoir sampling with an RNG — ClickHouse's own docs state the result is non-deterministic |
   | `topK()` | exact `GROUP BY … ORDER BY` | approximate |
   | `any()` | `min()` / `argMin()` | returns whichever row arrived first |

   This bites hardest in Detect, where reaching for `quantile()` to compute a median/MAD is the
   natural reflex.
4. **Total ordering.** Every ranking ends with a unique tiebreaker
   (`ORDER BY contribution DESC, dimensions ASC`). Without it the rank-1 root cause — the most
   visible output in the system — can differ between identical runs.
5. **Round floats at the write boundary** (6 dp) and compare with tolerance, never `==`.
6. **Model stages persist, then re-read.** Forecast writes its band; Detect reads the stored row
   and never regenerates one. Determinism is enforced at the storage boundary, so GPU or threading
   jitter cannot reach an investigation.
7. **Prove it.** Run any investigation twice over a frozen window and diff every Signal Store row.
   Any difference is a build failure. This belongs in the Gate D suite (§8d).

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
| `low_volume` | Detect (absolute volume floor) | nothing user-facing |
| `completed` | Narrate | a full insight per persona |

## 2. Scheduling — own container, no new orchestrator

Decision **D3**: the layer runs as the `intelligence` compose service — same image, different
`command` (`python api/intelligence/service.py`). No second Dockerfile, and it can be stopped
without touching the API. `api/main.py:424-427` and `api/websocket_manager.py:139-140` keep their
own background tasks; the pipeline does not ride them.

`api/intelligence/service.py` runs three loops:

```python
await asyncio.gather(
    run_batch_loaders(),        # sources A/B/C, INTELLIGENCE_BATCH_INTERVAL_MIN (60)
    run_forecast_batch(),       # stage 04, ahead of Detect, INTELLIGENCE_FORECAST_INTERVAL_MIN (60)
    run_investigation_sweep(),  # stages 01-07 per KPI, INTELLIGENCE_SWEEP_INTERVAL_MIN (15)
)
```

Every loop catches and logs per iteration — an unhandled exception kills an `asyncio` task silently
and the pipeline simply stops with no error surface. `run_batch_loaders` guards each source
separately, so a core-banking failure cannot abort CRM and market_ops with it.

Tier 0 discovery is **not** a fourth loop. `contracts.load_all` calls `discover_tier0` inline at the
top of every sweep: it enumerates canonical events with data, runs the session-invariance test over
their metadata keys, drops anything named in `metadata._simulated`, and materialises a Tier 0
contract per metric (see `docs/KPI_CONTRACT.md`, "Two tiers of contract"). Declared
`contracts/*.yaml` files override by `id`. Discovery failure is swallowed so it can never block a
declared contract.

Forecast writes bands for **every** contract KPI regardless of readiness (a band is cheap and
Detect needs it). The investigation sweep skips KPIs whose contract `readiness.status` is
`blocked`.

**Sweep budget.** With thousands of series, a sweep must be bounded: rank candidates by the prior
window's materiality and the KPI graph position (upstream KPIs first, since propagation may explain
their dependents for free), then cap per-sweep investigations. Record what was skipped — a silent
cap reads as "nothing was wrong" when it means "we did not look".

## 3. Stage I/O contracts

Every stage takes a `ctx` (`Ctx`: investigation_id, tenant_id, kpi_id, contract, window,
started_at, dataset, trigger, watermark) and returns its own typed result. There is no shared
`StageResult` base: each stage's dataclass carries what that stage actually decides. Every stage
writes exactly one `model_runs` row per invocation, whether or not it produced a finding.

| Stage | Reads | Returns | Writes |
|---|---|---|---|
| 01 Trust Gate | contract, `events_raw` via the Metric Layer | `TrustResult(verdict, fingerprint, cheapest_check, findings)` | `trust_findings` (always, incl. passes) |
| 02 Detect | contract, metric series, `forecasts` | `DetectResult(fired, reason, anomaly, materiality)` | `anomalies` |
| 03 Localize | contract, anomaly, fundamentals per cell | `LocalizeResult(causes, explained_pct, inconclusive, search_truncated, note)` | `root_causes` |
| 02a Decompose | contract `decomposition`, fact cells via `FactReader` | `DecomposeResult(factors, residual, total_change, method, note)` | `root_causes` |
| 04 Forecast | contract, metric history | `ForecastResult(point, lower, upper, method, confidence, backtest_mase, caveat, engine_type)` | `forecasts` |
| 05 Causal | contract, anomaly, causes, upstream anomaly | `CausalResult(rung, intervention, point, lower, upper, method, assumptions_met, degraded_reason)` | `causal_effects` |
| 06 Decide | contract, anomaly, causes, causal result | `DecideResult(action, lever, owner_role, impact_low, impact_high)` | `recommendations` |
| 07 Narrate | the claim set (§5) | one `insights` row per entitled persona | `insights` |
| 08 Observe | all of the above | — | `model_runs`, `investigations` |

**02a Decompose answers a different question from 03 Localize.** Localize says *which cell* moved;
Decompose says *which factor* — volume, mix or price — using LMDI-I over a fact table, with a
residual that must close to zero or the identity does not hold. It runs only when the contract
declares `decomposition.enabled` and the Metric Layer exposes `.facts`, writes its factors as
`root_causes` rows, and is surfaced by the `get_factors` tool. Causal and Decide share one module
(`stages/causal_decide.py`); Observe is `Orchestrator._record_run`, not a stage file.

**Localize must not receive raw rows.** It receives a `dict[cell_tuple, (numerator, denominator)]`
already aggregated by the metric layer, so it never touches `events_raw` (CLAUDE.md rule 4).

**This overrides `skills/intelligence-pipeline/SKILL.md` rule 1**, which reads *"read only through
the Metric API / metric functions (existing `/metrics`, `/funnels`, `/journey`...)"*. Those two are
not compatible, and this file wins: `/funnels` returns **user-grain** counts via `windowFunnel
GROUP BY user_id`, which `contracts/kyc_completion_rate.yaml`'s own lineage note calls display-only
and explicitly not the localizable fundamental. It is also the endpoint where every logged-out
visitor collapses into a single `user_id` of `"anonymous"`, so its conversion figures are a
definitional artefact. Do not build Localize against it (decision **D6**, `docs/PROPOSAL.md` §3).

## 3b. Propagation — turning N alerts into one story

Every contract already declares its edges:

```yaml
interconnection:
  driven_by: kyc_completion_rate
  drives: pro_revenue
```

**Nothing currently reads them.** That is fine with three KPIs and untenable with thirty: a single
upstream cause surfaces as N independent alerts, and the reader does the correlation the engine
should have done.

**Partly built.** `Orchestrator.sweep` orders upstream KPIs first and threads the upstream anomaly
into Causal, which is what lets a declared edge reach `corroborated_cause`. The suppression half is
not built: nothing sets `status = 'explained'`, and `anomalies` has no `explained_by` column. Cycle
detection at load time is also absent.

After Localize and before Causal, run a propagation pass over the anomalies opened in this sweep:

1. For each anomaly, follow its contract's `driven_by` edge upward.
2. If the upstream KPI also has an open anomaly in this sweep, **and** its window starts at or
   before the downstream one, **and** the directions are consistent with the declared
   relationship, then set the downstream anomaly's `status = 'explained'` and
   `explained_by = <upstream anomaly_id>`.
3. Narrate once, rooted at the anomaly that nothing else explains, listing the downstream effects
   it accounts for. Explained anomalies still exist as rows — they are suppressed from the feed,
   not deleted.

**Constraints that keep this honest:**

- **Only declared edges.** Never infer a link from correlation. The contract is the authority;
  an undeclared relationship is not a relationship.
- **The ceiling is `corroborated_cause`.** A declared edge plus temporal precedence plus
  independent agreement earns that rung and no more. `estimated_effect` requires an intervention
  and a counterfactual, which propagation does not have. See stage 05.
- **Cycles are a contract bug.** Detect them at load time and refuse the contract set rather than
  looping at runtime.
- **A tie is not a link.** If windows start in the same bucket, the direction is undetermined —
  leave both open and let the narrative present them together rather than inventing precedence.

This is also the honest answer to alert fatigue at scale, alongside the Benjamini-Hochberg pass in
Detect: FDR control limits how many anomalies are *opened*, propagation limits how many are
*reported*.

## 3c. Localize at scale — search strategy

**Design, not built.** `stages/localize.py` runs one greedy `combinations()` search at every cube
size; there is no strategy branch and PSqueeze is not installed. `LocalizeResult.search_truncated`
is set when a cell query raises, but `root_causes` has no column for it, so a truncated search is
not visible at rest.

Cube search cost is multiplicative in dimension cardinality and depth, and now runs across every
discovered KPI rather than three. Localize therefore picks a strategy per invocation:

| Cells in the cube | Strategy | Engine |
|---|---|---|
| under ~10k | exact greedy top-down `GROUP BY` with min-volume pruning | `stats` |
| ~10k and above, or depth > 2 | **PSqueeze** (MIT) | `stats` |
| PSqueeze unavailable | greedy, with `search_truncated` recorded on the finding | `stats` |

**Why PSqueeze specifically.** It handles multiple simultaneous causes rather than assuming one,
degrades gracefully as forecast-residual error grows — which matters because our band now comes
from a model, not a constant — and generalizes to derived/ratio measures *through their
fundamental components*, which is exactly the decomposition this design already mandates. It is
the closest published match to the contract Localize was written against.

**What does not change, and must not.** PSqueeze still receives pre-aggregated additive
fundamentals at the contract's `grain.entity` — never raw rows, never a rate. It still may only
search `dimensions.allowed`, which the invariance test has already filtered. It still writes the
same `root_causes` rows with contributions summing to ~1, and that sum is still a correctness
alarm rather than a formatting detail. Swapping the search algorithm must not quietly widen what
the search is allowed to look at.

**Never silently truncate.** If a cube is capped, pruned below a depth, or the library is missing,
say so on the finding. A localization that examined half the space and does not admit it is worse
than one that refuses.

## 4. Materiality — the formula, not a vibe

`anomalies.materiality` is referenced by the Detect floor and by severity, so it needs one
definition. All three factors are in `[0, 1]`; the product is too.

```
materiality = effect × reach × persistence

effect      = min(1, |observed - baseline| / max(|baseline|, epsilon) / critical_pct_change)
reach       = affected_population / total_population   (1.0 when total is 0)
persistence = min(1, consecutive_breaching_windows / min_persistence_windows)
```

**`reach` is measured against the KPI's own population, never against the tenant's raw event
volume.** Detect scores the whole window, so the movement covers the entire population and reach
is 1.0 there; partial coverage is Localize's finding. Scoring reach against total telemetry made
every business KPI structurally immaterial — loan approvals are a few hundred events beside tens
of thousands of page views, so a 37% collapse scored `0.05`, fell under the `0.15` floor, and was
suppressed with `immaterial` while the dashboard reported "no material movement".

Triviality is guarded instead by an absolute floor: a KPI carrying fewer than
`INTEL_MIN_KPI_VOLUME` (default 20) events in the window terminates with `low_volume`. A handful
of events cannot support a claim about the business, whatever the percentage.

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

### Which insight the read path surfaces

`generated_at` is pinned to the window end so a re-run is byte-identical, which means every
insight in a sweep shares it — ordering by time alone tiebreaks on `insight_id` and surfaces an
arbitrary quiet KPI while an urgent anomaly sits unread. `reader.latest_insight` ranks instead by
anomaly raised, then Tier 1 contract (those carry an owner and a lever list), then materiality,
then recency and `insight_id`. The query agent resolves the same way when the question names no
metric, so the answer and the page always concern the same KPI.

## 4b. Forecast method registry — how a better model earns its place

Forecast is load-bearing: its band is what Detect scores residuals against, so a weak forecast
weakens detection directly. That makes "should we use ARIMA / ETS / Prophet?" a real question —
and one the system should answer per series with evidence, not one anyone should win by argument.

**Design, not built.** `stages/forecast.py` offers `METHODS = {seasonal_naive, rolling_median}`
and no registry; `ets`, `sarima` and `chronos_bolt` are not wired and their libraries are commented
out in `requirements.txt`. The promotion rule below **is** implemented, in `backtest()`.

Methods live in a registry. Each declares its own history floor and dependencies:

```python
FORECAST_METHODS = {
    "rolling_median":  Method(min_history_days=7,  deps=(),              engine="stats"),
    "seasonal_naive":  Method(min_history_days=14, deps=(),              engine="stats"),
    "ets":             Method(min_history_days=56, deps=("statsmodels",), engine="ml"),
    "sarima":          Method(min_history_days=56, deps=("statsmodels",), engine="ml"),
    "chronos_bolt":    Method(min_history_days=14, deps=("chronos",),     engine="ml", batch=True),
}
```

**Why a time-series foundation model is the right default at this scale.** With thousands of
series, per-series model selection and tuning is the failure mode, not the solution — it is
precisely why Datadog built Toto and Amazon built Chronos. A zero-shot TSFM covers every series
with one model, needs **no training data and no per-series fitting**, and produces the
probabilistic interval Detect needs. Note its history floor is *lower* than SARIMA's, not higher:
these models transfer across series, so they tolerate short context far better than a classical
model fitting seasonal terms from scratch.

Operational notes: run it as a batch over all series at once, never in the request path. The stack
already has a GPU serving vLLM on :8002, so pin a small variant (Chronos-Bolt Small is ~48M
parameters) and watch memory contention with the LLM — or run it on CPU, where a small variant is
still workable for a nightly batch. **The promotion rule applies unchanged:** the TSFM must beat
seasonal-naive on rolling-origin MASE for a given series or that series falls back. A foundation
model is not exempt from having to prove itself.

**Promotion rule.** For each series, a method is used only if all three hold:

1. available history >= its `min_history_days`;
2. its declared dependencies are importable (a missing dep is a skip, never a crash);
3. its rolling-origin MASE beats `seasonal_naive` on **that series** by at least 5%.

Otherwise fall back to the contract's `baseline`, then its `fallback`. The winning method and its
score are written to `forecasts.method` and `forecasts.backtest_mase`, so the choice is auditable
per row and a regression is visible rather than silent.

**Why the floors are set where they are.** Weekly seasonality means a seasonal model needs several
full cycles before its seasonal terms are anything but noise — roughly eight, hence 56 days.
`scripts/seed_data.py` defaults to `--days 30`, about four cycles. **So today no series qualifies
for `ets` or `sarima`, and that is the correct answer, not a disappointing one.** The registry
makes that a measured outcome instead of an assertion, and it flips automatically once the history
is there.

**Still deliberately excluded:** any method requiring per-series *training* (LSTM, GRU, and
friends). A pretrained zero-shot forecaster is a different thing and is now in the registry above —
it ships with its weights and learns nothing from us. Phase
1's claim is that zero models need training data, and a trained-per-stream fleet is the maintenance
burden that motivated purpose-built foundation models in the first place. If a learned model is
ever wanted, it belongs in the `ml` engine class as a pretrained zero-shot forecaster — the same
registry slot, no training step. See `docs/RESEARCH.md`.

Adding a method is a registry entry plus a dependency. It is not a redesign, because every method
writes the same row shape: point, lower, upper, method, confidence, `backtest_mase`, caveat.

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

Cards reference claims **by key**; the narrator must render `display` verbatim.

**The invariant is consistency within stated precision, not byte-equality.** A persona whose depth
is `summary` is shown the dominant driver at whole percent and its claim is STORED at whole
percent, so `58.0` for a CFO and `58.3` for an analyst are the same finding at two precisions.
That is correct: each stored figure matches the prose that cited it. What must never happen is two
personas disagreeing beyond precision -- `58.0` against `61.2` is a bug, and so is storing `58.3`
while showing `58`.

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

`cfo`, `ops_manager` and `analyst` appear in every contract's `access_restriction` and, since P2-3,
in `rbac.json` as an additive `personas` block (coupling point 3 — additive only, do not
restructure):

```json
{
  "super_admins": ["..."],
  "app_admins": { "nexabank": ["..."] },
  "personas": {
    "default": "analyst",
    "by_role":  { "super_admin": "cfo", "app_admin": "ops_manager", "user": "analyst" },
    "by_email": {},
    "allowed":  ["cfo", "ops_manager", "analyst"],
    "selectable_by_role": {
      "super_admin": ["cfo", "ops_manager", "analyst"],
      "app_admin":   ["ops_manager", "analyst"],
      "user":        ["analyst"]
    }
  }
}
```

Rules:

- The persona is resolved **server-side** from the authenticated identity. A requested persona is
  honoured only when the caller's ROLE lists it in `personas.selectable_by_role` — a server-side
  allowlist, so switching views can never widen access. Honouring a request only when it already
  equalled the resolved persona (the earlier rule) made the parameter inert and locked every role
  to one narrative shape, which is why no persona difference was visible in the product.
- The persona registry lives in `api/intelligence/personas.py` and is the single source for a
  persona's label, remit, intents, the recommendation **owner roles** it acts on, and its metric
  priorities. `agent.PERSONA_INTENTS` is a derived view so the two cannot drift.
- A lever owned by another role is **named with its owner**, never hidden. Telling an operations
  manager that a movement has no action, when revenue operations owns one, is a worse failure
  than showing a lever they cannot pull.
- Entitlement is applied when the **claim set is built**, not when the narrative is rendered. A
  restricted claim is structurally absent from the LLM context.
- `suppress_for_others` is not optional. Removing `pro_revenue` while leaving
  `pro_conversion_events` lets the reader multiply by the published $49 constant and recover it.
- The two personas must agree on every shared claim **within stated precision**. Assert this in
  the golden run: for each key present in both persona claim sets, the values must round to the
  same figure at the coarser of the two precisions. Byte-equality is the wrong test once depth
  changes display precision -- it fails on a correct rounding and passes on a stored figure that
  contradicts the prose citing it.

## 8. Dashboard API surface

New reads, all Signal-Store-only and all **outside** the 15s `useDashboard` batch
(`skills/analytics-endpoint`). Fetch on insight open or on the new-insight WebSocket ping.

Every route is tenant-scoped through `tenants`, never through a path parameter, because
`RBACMiddleware` scopes an app_admin from the query string. `persona` is advisory everywhere: the
server resolves it from the caller's ROLE.

| Endpoint | Returns |
|---|---|
| `GET /intelligence/insights?tenants=&limit=` | latest insight per KPI, UI-shaped |
| `GET /intelligence/insight?tenants=&kpi_id=&persona=` | narrative, evidence card, trust verdict, engine breakdown, qualifiers |
| `GET /intelligence/sources?tenants=` | per-source freshness: grain, cadence, SLA, minutes behind |
| `GET /intelligence/telemetry?tenants=` | LLM-vs-non-LLM breakdown from `model_runs`, plus latency, tokens, cost |
| `GET /intelligence/recommendations?tenants=&limit=` | proposals only; Phase 1 executes nothing |
| `GET /intelligence/personas?tenants=` | persona views this ROLE may switch between, with remit and examples |
| `POST /intelligence/ask?tenants=` | one agent run: answer, reasoning trail, citations, evidence |
| `POST /intelligence/outcome` | writes an `outcomes` row (useful / root-cause-correct / action-taken) |

There is no separate `/intelligence/evidence` route — the evidence card is returned inside
`/intelligence/insight`.

## 8a. Tier 1 and Tier 0 are different kinds of object

A governed (Tier 1) contract has an owner, a closed lever list and a causal model. An
auto-discovered (Tier 0) contract is an observed series with none of those. They are not one type
with fields missing, and treating them as one produced two defects:

- `rank_movements` scored both on materiality and put `dashboard.page.view` beside `fee_revenue`
  in the analyst's default view. Materiality on a governed KPI means "warrants a decision"; on an
  observed series the strongest available reading is "statistically unusual". Those are not
  comparable scores.
- `get_recommendations` reported an empty lever list as "no action applies", which states that we
  looked and found nothing when the truth is that nobody owns the metric.

`Contract.governed` carries the distinction and callers branch on it **once, at the boundary** --
never per metric. Ranked output is Tier 1 only; Tier 0 stays answerable on request through
`get_insight`. **Proactive alerting is Tier 1 only** for the same reason: a Tier 0 alert can state
that something moved but never why or what to do about it, which is a notification, not an alert.

## 8b. The query agent is an orchestrator, not a workflow

`POST /intelligence/ask` runs a bounded **reason → act → observe → validate → re-plan** loop
(`api/intelligence/loop.py`). Nothing about a question selects a fixed route:

| Layer | File | Owns |
|---|---|---|
| Entry point | `api/intelligence/agent.py` | `ask()` — runs the loop, records the call as a `model_runs` row with `stage='ask'`, mints `query_id = derive_id(tenant, persona, question)` |
| Capabilities | `api/intelligence/tools.py` | 14 deterministic tools, each with a JSON parameter schema, a persona entitlement gate, a source citation and its own renderer |
| Reasoning | `api/intelligence/planner.py` | which tools to call, in what order, in parallel or not, and when to stop |
| Execution | `api/intelligence/loop.py` | validation, parallel execution, observation recording, synthesis, the numeric verifier |
| Fallback | `api/intelligence/agent.py` | `answer_question()` — a single-shot intent router over the same Signal Store reads, used when the loop itself raises |

Two planners implement one interface and the loop cannot tell them apart. `LLMPlanner` reads the
catalogue and the observations so far and emits the next action set as JSON. `RulePlanner` scores
the same catalogue against the question and re-plans from what came back; it is the
dependency-free path, and it is what runs when no model is reachable. **Adding a tool is adding
one `ToolSpec`** — the planner discovers it from the catalogue at runtime.

Where the flexibility stops, and why the answer is still trustworthy:

- `tools.validate_call` refuses an unknown tool, one the persona may not use, or an argument the
  schema does not name. A hallucinated call fails closed rather than running something unintended.
- The model never supplies a number. Every figure comes from a tool result and is re-checked by
  the same verifier the narrator uses; an unverifiable draft becomes an abstention.
- The critic (`planner.validate`) inspects results before they are phrased: it detects empty
  results, flags two sources disagreeing on the same claim, and escalates rather than guessing.
- The loop is bounded by `INTEL_AGENT_MAX_ROUNDS` (default 3).
- A tool that explains ONE metric (`get_metric_contract`, `compare_metrics`) is only a candidate
  when the question names a metric, and the empty-result fallback will not widen onto the standing
  finding otherwise. Answering an unrelated question with a sourced variance report is the worst
  failure this surface has, because it looks correct.

Every run returns its `trace` — one step per tool call, each carrying the phase (`reason`, `act`,
`observe`, `validate`, `synthesize`), the tool, what it passed and how long it took — plus
`citations` naming the table behind each figure. The dashboard renders both.

`/ai_report` keeps its existing response shape and becomes a thin reader over `insights`
(`docs/DATABASE.md`). Do not change it.

The telemetry endpoint computes the breakdown as a `GROUP BY engine_type` over `model_runs` for
that `investigation_id` — never from anything the model said about itself.

## 8c. Phrasing — one place that decides how a stored figure reads

`api/intelligence/phrasing.py`. It computes nothing. It receives values a stage produced and a
claim records, and decides how they are said. It exists because the readable form of a figure has
to be decided once: a cell shown as `txn_type=PAYMENT` on the evidence card and as "payment
transactions" in the prose is one row described twice, and a reader cannot tell which is real.

Three properties it enforces, each of which was violated by the flat rendering it replaced:

1. **A figure is stated in the unit it was measured in.** Detect never scores a rate — a ratio does
   not re-aggregate — so it scores the contract's `scored_fundamental`. `97` is therefore 97 digital
   transactions a day, not 97 percent, and the substitution is stated in the answer rather than
   left for the reader to infer from a metric named "rate". See Bug Audit A4: the underlying KPI
   is still not measured, and phrasing only makes the answer honest about that.
2. **Nested localisation cells are disclosed as nested.** A greedy cube emits `{txn_type=PAYMENT}`
   and `{region=Northeast, txn_type=PAYMENT}` as separate ranks; the second is a subset of the
   first and its rows are counted in both. Cumulative `explained_pct` reached **2.07** on live
   data. Listing the ranks side by side invites an addition that is wrong, so `overlap_note`
   detects the containment structurally and says so. It carries no numeral, deliberately — see §6.
3. **A percentage is not quoted against an expected zero.** `pct_change` divides by an epsilon-
   guarded baseline; against a baseline of 0 it rendered "rose 19600.0%". The move is stated in
   units instead, with the reason there is no percentage.

Depth still belongs to the persona (§7): `personas.detail` decides how much of a finding is shown.
It never decides **which** number that finding is. Rule 1 above is stated at every depth — a CFO
reading a shorter sentence is not reading a different quantity.

## 8d. Two acceptance gates — deterministic first, then language

Decision (2026-08-27): **build and prove the deterministic layer before any LLM code exists.**
The build order in §9 already sequences this; these are the gates that make it enforceable rather
than aspirational.

### Gate D — the engine works with no language model at all

Everything below must pass with **zero** LLM involvement, narrating from the deterministic
template only. The decisive assertion is machine-checkable:

```sql
-- must return 0 for every investigation in the Gate D suite
SELECT count() FROM model_runs WHERE engine_type = 'llm';
```

| Check | Passes when |
|---|---|
| Terminal states | Each of the five `docs/SCENARIOS.md` runs reaches its expected `termination_reason` |
| Trust Gate | Scenario 1's duplicate storm is suppressed, `trust_findings` row written, no business narrative |
| Localize | Planted segment at rank 1; contributions sum to ~1 (a sum that does not is a **failure**, not a rounding note) |
| Forecast | Every forecast carries an interval and either a backtest score or an explicit caveat |
| Abstention | Scenario 4 sets `abstained = 1` and names exactly one cheapest check |
| Idempotency | Re-running an investigation produces identical row ids and no duplicate rows |
| Edge cases | Every entry in `docs/EDGE_CASES.md` has a test or a written waiver |
| Entitlement | Per-persona claim sets are built and filtered correctly — see below |

Note the edge-case suite is **not** a generic list (empty inputs, boundary values, ties). Those are
covered incidentally. The suite is the 49 repo-specific failure modes in `docs/EDGE_CASES.md`:
missing metadata keys reading as `''` rather than null, provisional windows, the dual write path,
soft-versus-hard invariants, contaminated controls, cross-session funnel order. Generic testing
would pass while every one of those shipped broken.

### Personas belong to Gate D, not to narration

Persona is **not** a tone parameter applied at the end. Splitting it correctly matters, because
getting it wrong is an entitlement leak rather than a cosmetic bug:

| Layer | Persona-dependent? |
|---|---|
| Specialist computation (stages 01–06) | **No.** Computed once, identically. Persona never changes a number. |
| Claim-set construction | **Yes.** Entitlement filters here, so a restricted value is structurally absent from what the narrator can see. |
| Narration | Tone and vocabulary only. |

One investigation produces one set of findings, then N entitlement-filtered claim sets, then N
narratives. If persona were only a narration-time parameter, the restricted number would sit in the
model's context and be suppressed by phrasing — which is precisely the leak §7 forbids.

Gate D therefore asserts, with no LLM present: restricted claims are **absent** from the
ops-manager claim set (not merely unmentioned), `suppress_for_others` keys are absent too, and
every key present in both persona claim sets holds an identical value.

### Gate L — adding language changes no number

With the LLM enabled, every Gate D assertion must still pass, plus:

| Check | Passes when |
|---|---|
| **Numbers unchanged** | Claim sets are byte-identical to the Gate D run. Adding the narrator must not move a single figure. |
| Verifier coverage | 100% of numeric spans matched; `verifier_pass = 1` |
| Hedging | Causal language appears only at rung `estimated_effect` or above |
| Fallback | Forcing vLLM offline still yields a complete narrative from the template |
| Persona agreement | Narratives differ in tone; every shared number is identical across personas |

"Numbers unchanged" is the load-bearing one. It is what turns *"remove the language model and the
system still works"* from a claim into a regression test.

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
