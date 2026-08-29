# RESEARCH.md

The published work behind each stage, what it justifies, and — importantly — **which parts Phase 1
actually implements versus defers**. Every component in the Intelligence Layer Explorer was chosen
from literature or documented production practice rather than preference; this file keeps that
rationale attached to the build.

Read this when you need to defend a design choice, or when you are about to upgrade a Phase 1
placeholder into its real implementation.

## How to read the status column

- **Implemented** — Phase 1 builds this, in the deterministic form described.
- **Deferred** — the idea is honoured, the named library is not added. Phase 1 uses a simpler
  method that produces the same *shape* of output (interval, rank, verdict) so the upgrade is a
  swap rather than a redesign.
- **Approved** — cleared by CLAUDE.md rule 2 and designed into the interface, but **not installed**.
  The dependency-free tier is what runs today.
- **Rejected** — deliberately not used here, with the reason.

Nothing in the Deferred or Approved columns is a Phase 1 dependency. See CLAUDE.md rule 2.

---

## Localization (stage 03)

| Source | Justifies | Status |
|---|---|---|
| Bhagwan et al., **Adtributor: Revenue Debugging in Advertising Systems**, NSDI 2014 (Microsoft) | Slicing an **additive** measure across dimensions to find the responsible one; >95% accuracy in production, order-of-magnitude faster troubleshooting. The additivity requirement is why this repo moved KPIs to session/event grain. | **Implemented** as a greedy cube search |
| Sun et al., **HotSpot: Anomaly Localization for Additive KPIs**, IEEE Access (Baidu) | MCTS + pruning to localize in seconds; the source of the min-volume pruning rule. | Deferred — pruning idea kept, MCTS not |
| Li et al., **Squeeze**, ISSRE 2019 | Deviation-magnitude clustering across large attribute cubes. | Deferred |
| Li et al., **PSqueeze** | Multiple simultaneous causes; extends localization to **derived/ratio** measures via their fundamental components; robust as forecast-residual error grows. | **Approved**, not installed — `stages/localize.py` runs greedy exact search at every cube size |

**The load-bearing idea:** every one of these requires an additive measure. That is not an
implementation detail to work around — it is why `docs/KPI_CONTRACT.md` makes `grain.entity`
the first thing a contract declares.

### PSqueeze: approved, and what changed

Checked 2026-08-27. **License: MIT** — free, commercial use included. Licensing was never the
constraint.

Originally deferred on three grounds. The scope decision of 2026-08-27 — cover every KPI on the
platform, not three — resolved two of them and left one as a precondition:

- **Cube size — resolved, and it reversed the argument.** The original case for greedy exact search
  was that our cube was small enough to search exactly. Across every discovered KPI and every
  tenant that is no longer true, and approximate search with principled pruning becomes the
  correct tool rather than a shortcut. Exact search survives as the strategy for small cubes,
  where it is still better.
- **Dependency weight — accepted.** It pulls numpy, scipy, pandas, scikit-learn and more. That is
  now an approved cost (CLAUDE.md rule 2) rather than a blocker, with a dependency-free greedy
  fallback retained so a missing library degrades instead of failing.
- **Fabricated dimensions — still a precondition, and unaffected by any of this.** Per
  `docs/FinInsights_Bug_Audit.md` A1/A2, a stronger localizer over random dimensions produces
  better-looking nonsense. The session-invariance test and the `_simulated` marker are what gate
  this, and they gate PSqueeze exactly as they gated greedy search. **A better algorithm was never
  going to fix bad inputs.**

  **Both gates now exist, and they are not interchangeable.** `metadata._simulated` (P0-8) is
  emitted per event and read by `metrics.simulated_keys`; the invariance test is
  `metrics.dimension_invariance`. The invariance test would not have caught this case on its own:
  `eventTracker.ts` caches its random geo/device profile **once per session**, so a fabricated
  dimension is perfectly session-invariant and passes cleanly. The marker is the load-bearing
  gate; the invariance test catches a different failure (session-*varying* keys such as
  `channel`). Installing PSqueeze behind them is now a swap, not a risk.
  See `docs/PROPOSAL.md` §2 Block A.

**Explicitly rejected:** SHAP. It attributes a *model's* prediction, not a metric movement. A
different problem, frequently confused with this one.

---

## Detection (stage 02)

| Source | Justifies | Status |
|---|---|---|
| Truong, Oudre & Vayatis, **ruptures: change point detection in Python** | Offline change-point detection for non-stationary signals. | Deferred — Phase 1 uses persistence counting |
| Killick, Fearnhead & Eckley, **Optimal detection of changepoints with a linear computational cost (PELT)**, 2012 | Exact segmentation with pruning at near-linear cost; practical across many series. | Deferred |
| Benjamini & Hochberg, **Controlling the False Discovery Rate**, 1995 | Multiple-testing control across many monitored series. | **Implemented** — ~15 lines, no dependency |

Robust residual scoring (median/MAD rather than mean/stddev) is standard practice rather than a
single citation: a fresh anomaly contaminates a mean-based baseline and hides itself. Phase 1
computes it in ClickHouse.

Forecast-residual detection outperforms static thresholds in published comparisons, which is why
`detection.band_source: forecast` is in every contract. Alert fatigue is the most commonly reported
production failure mode, so precision is weighted over recall throughout.

---

## Forecasting (stage 04)

| Source | Justifies | Status |
|---|---|---|
| Amazon Science, **Chronos / Chronos-Bolt** | Zero-shot probabilistic forecasting; ~120M params, 300+ forecasts/sec on one GPU. | **Approved**, not installed — the intended default once wired, subject to the promotion rule |
| Google Research, **TimesFM** | Decoder-only time-series foundation model. | Deferred |
| Salesforce, **Moirai / Moirai-2** | Universal forecasting transformer; small variants at the best error/latency point. | Deferred |
| Datadog, **Toto** | Purpose-built for observability metrics; motivated by the unsustainability of hundreds of hand-tuned per-stream models. | Deferred |
| Nixtla, **StatsForecast** | AutoETS, MSTL, Croston/ADIDA as fast CPU classical baselines. | Deferred — Phase 1 hand-rolls seasonal-naive and rolling median in SQL |

**A zero-shot foundation model is the intended default forecaster.** `stages/forecast.py` ships
`seasonal_naive` and `rolling_median` only; the method registry in `docs/PIPELINE_CONTRACT.md` §4b
is design, not code. With thousands of series, the per-series tuning burden is the failure mode — the exact motivation behind Toto and Chronos. A
TSFM covers every series with one model, requires no training data, and emits the probabilistic
interval Detect consumes. Its history floor is *lower* than a classical seasonal model's, because
it transfers across series instead of fitting seasonality from scratch. It remains subject to the
same promotion rule: beat seasonal-naive on that series or fall back. See
`docs/PIPELINE_CONTRACT.md` §4b.

**Statistical models (ETS, ARIMA/SARIMA) are welcome, gated on history.** They belong in the
Forecast method registry (`docs/PIPELINE_CONTRACT.md` §4b) with a 56-day floor, because weekly
seasonality needs roughly eight cycles before seasonal terms stop fitting noise. Seeded history is
well under that, so nothing would qualify yet — measured by the promotion rule rather than argued.
The promotion rule itself **is** implemented, in `forecast.backtest()`.

**Prophet is not recommended even once history allows it.** It is in maintenance mode, carries a
heavy Stan toolchain, and its advantage — holiday and multi-seasonality handling — is not where
this dataset's difficulty lies. ETS or SARIMA via `statsmodels` gets more of the benefit for far
less operational weight.

**Per-series *trained* models (LSTM/GRU) remain excluded by design,** not by effort. They would
break the zero-training-data claim and recreate the per-stream tuning burden that motivated Toto.
A pretrained zero-shot forecaster is categorically different: it arrives with its weights and
learns nothing from our data, so the claim survives intact.

**What Phase 1 keeps from this body of work** is the *contract*, not the model: a forecast is a
point **plus an interval plus a method plus a backtest score plus a caveat**. That shape is what
Detect and the narrator consume, so swapping in Chronos later changes one module and no
interfaces. Rolling-origin backtesting against a seasonal-naive baseline (MASE) is implemented,
because a forecast that cannot beat naive should not be trusted regardless of what produced it.

---

## Causal inference (stage 05)

| Source | Justifies | Status |
|---|---|---|
| Brodersen, Gallusser, Koehler, Remy & Scott, **Inferring causal impact using Bayesian structural time-series models**, *Annals of Applied Statistics* 9(1):247–274, 2015 | The counterfactual framing: predict what would have happened absent the intervention; the difference is the inferred impact, with posterior intervals that widen over the horizon. | Deferred — framing implemented, BSTS not |
| Abadie, Diamond & Hainmueller, **Synthetic Control Methods**, 2010 | Constructing a counterfactual from a donor pool of untreated units. | Deferred — Phase 1 uses a single untreated control segment |
| Sharma & Kiciman, **DoWhy** (Microsoft Research) | Explicit identify → estimate → refute workflow with refutation tests. | Deferred |
| Microsoft, **EconML** | Heterogeneous treatment effects, for "for whom" questions. | Deferred |

**The load-bearing idea Phase 1 does implement** is the evidence ladder: association → attribution
→ corroborated cause → estimated effect → experiment, with the rung **labelled in the output**.
Brodersen's own stated limitation — that continuously-intervening platforms violate the
clean-control requirement — is why `degrade_to: attribution` is mandatory in every contract.

---

## Decision (stage 06)

| Source | Justifies | Status |
|---|---|---|
| Li, Chu, Langford & Schapire, **A Contextual-Bandit Approach to Personalized News Article Recommendation**, WWW 2010 | LinUCB; the canonical cold-start formulation — learning which actions pay off without a labelled dataset. | Deferred |
| Chapelle & Li, **An Empirical Evaluation of Thompson Sampling**, NeurIPS 2011 | Thompson Sampling is competitive on real ad and recommendation workloads. | Deferred |
| **CausalML** (Uber), **EconML** (Microsoft), scikit-uplift | Uplift/CATE meta-learners: target persuadables, skip sure-things, avoid sleeping dogs. | Deferred |
| Offline policy evaluation literature | Scoring a new policy from logged data before exposing anyone to it. | Deferred |

Phase 1 is rules-based and writes proposals only. The `outcomes` table exists **now** specifically
so that the labelled experience these methods require accumulates from day one — you cannot
retrofit a reward signal. Nothing may learn from un-audited output.

---

## Foundation and substrate (stage 00)

| Source | Justifies | Status |
|---|---|---|
| PostHog engineering, **Kafka → ClickHouse analytics at scale** | Production precedent for this exact substrate: materialized views transforming rows at insert time to power trends, funnels, retention and paths. | **Implemented** (pre-existing) |
| Cloudflare / GitLab / PostHog practice, **tiered aggregation with mergeable intermediate states** | Rollups must store `-State` aggregates read with `-Merge`, never a plain integer inside an aggregating engine. | **Implemented** by FOUNDATION-4 |
| Industry practice, 2026 | Deterministic identity so at-least-once delivery stops inflating downstream figures. | **Implemented** by FOUNDATION-1 — **but not as published.** The usual recipe is a hash of the natural key; here that fails (no source sequence exists), so we use the Postgres `Event.id` UUID instead. See `docs/DATABASE.md`. |

The decaying-total failure this literature warns about is present in this repo right now:
`total_events UInt64` inside an `AggregatingMergeTree`. It is not a theoretical risk.

---

## Trust gate and data quality (stage 01)

| Source | Justifies | Status |
|---|---|---|
| Data observability literature — **the five pillars** (freshness, distribution, volume, schema, lineage) | The checks that separate a data defect from a business event, including "unknown unknowns" no one wrote a test for. | Partially implemented |
| Framework comparison, 2026 (**Great Expectations** / **dbt tests** / **Soda Core** / **Deequ**) | Python-native vs warehouse-native vs YAML-first multi-source selection rationale. | Deferred — contracts carry declarative checks instead |
| **Evidently** / **NannyML** | Distribution and population drift monitoring. | Deferred |
| **OpenLineage** + **Marquez** | Resolving "what changed upstream at exactly that timestamp". | Deferred — CLAUDE.md rule 2 bans it |
| Reconciliation practice | A quality engine must scan several fields at once, because any one can be the corrupted one. | Partially implemented |

**Where this repo departs from the literature, and why it must.** The canonical worked examples —
a Fahrenheit/Celsius sensor, a currency unit collapse — are all *field-value* corruptions. This
system has no numeric measure field at all: `events_raw` is `tenant_id`, `event_name`, `user_id`,
`channel`, `timestamp`, `metadata`. There is nothing to collapse. The defects it can actually
suffer are **structural**: duplicate delivery, taxonomy misroute, tenant misattribution, tracking
toggles, clock skew. `docs/SCENARIOS.md` scenario 1 is built on the first of those, which is why it
is a duplicate-event storm rather than a currency bug.

---

## Narration and grounding (stage 07)

| Source | Justifies | Status |
|---|---|---|
| Semantic-layer benchmarks, 2026 (dbt Labs; ClickHouse study) | A ~4KB semantic document raised analytical accuracy **17–23 points**, and made model choice statistically insignificant — so the smallest quantized tier suffices. | **Implemented** — this is the case for `contracts/*.yaml` |
| Text-to-SQL evaluation | Free text-to-SQL retains error rates up to ~20% on complex tasks even for top models, failing on joins, aggregations and filters. | **Implemented as a prohibition** — text-to-metric, never text-to-SQL |
| Same benchmark | Models incorrectly sum snapshot data across dates, producing vastly inflated values. | Eliminated upstream by the additivity rules |
| **vLLM**, **XGrammar** / **Outlines**, **Pydantic** | Constrained decoding so parsing never fails and the output shape is guaranteed. | **Implemented** (vLLM + Pydantic already present) |

This is the single strongest empirical result behind the whole design: **with a good semantic
layer, a small model is enough.** It is why the KPI contract is the centre of gravity and the LLM
is the last five minutes.

---

## Observability and rollout (stage 08)

| Source | Justifies | Status |
|---|---|---|
| ML deployment practice | Shadow deployment before user-facing rollout is the only way to validate on real traffic without exposure. | **Implemented as the rollout ladder** |
| Data observability literature | Pipeline health and model behaviour must both be monitored; a pipeline can run perfectly while producing poor data. | Partially implemented |
| **Langfuse** (runs on ClickHouse), **OpenTelemetry**, **MLflow** | Tracing, evals, cost tracking, model registry. | Deferred — `model_runs` covers the Phase 1 need |
| Data governance practice, 2026 | Remediation must preserve lineage, ownership and auditability where analytics inform regulated decisions. | Partially implemented — this is a **bank**, so it matters |
| Data quality practice, 2026 | Quality matters more once AI is involved, because AI amplifies both insights and errors. | Rationale for the whole trust gate |

---

## The claim all of this defends

> Seven of the nine stages reason rather than report. One touches the GPU. Zero require training
> data.

That is the deliverable, and it is measurable rather than rhetorical: the LLM-vs-non-LLM breakdown
is computed from `model_runs.engine_type`, not asserted by the model. If the language model is
removed, the system still detects, diagnoses, forecasts, labels causal evidence, proposes an
action, and records everything — it just stops talking.

Phase 1's deferrals do not weaken that claim. Every deferred item sits in a stage that is already
non-LLM; swapping seasonal-naive for Chronos or a greedy cube search for PSqueeze makes those
stages *better*, not more numerous. The ratio is structural.
