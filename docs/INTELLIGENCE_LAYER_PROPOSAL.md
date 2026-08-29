# INTELLIGENCE_LAYER_PROPOSAL.md

How the Phase 1 intelligence layer gets built: the determinism guarantee it makes, how it covers
every KPI rather than a chosen few, the order of work, and what it needs from the platform team.

Named distinctly from `docs/PROPOSAL.md`, which is the substrate remediation plan, and its
companion `docs/TASK.md`. Those say what is being fixed *underneath* this layer; this one says
what is being built *on top* of it. The audit both rest on is
`docs/INTELLIGENCE_LAYER_PREREQUISITES.md`.

Reference material, not repeated here: `docs/PHASE_1.md` (scope, definition of done),
`docs/PIPELINE_CONTRACT.md` (stage interfaces, claim set, verifier, gates),
`docs/KPI_CONTRACT.md` (contracts and grain), `docs/EDGE_CASES.md` (failure modes),
`docs/RESEARCH.md` (why each method).

---

## 1. The determinism guarantee

The requirement is that the layer be **fully deterministic**. Stated precisely, so it is testable
rather than aspirational:

> Given the same rows in ClickHouse, an investigation produces **byte-identical Signal Store rows**,
> every run, on any machine.

That holds for every number the system produces. It is achieved by seven specific disciplines, not
by hoping.

### 1.1 Identifiers are derived, never generated

No `uuid4()`, no `now()` in an id. Every row id is a hash of its inputs
(`docs/PIPELINE_CONTRACT.md` §1). Re-running an investigation therefore *converges* on
`ReplacingMergeTree` rather than duplicating. Idempotency and determinism are the same property
here.

### 1.2 Every window is pinned once, at the top

`now()` must never appear inside a stage. The orchestrator computes `[window_start, window_end)`
once when the investigation is created, writes it to the `investigations` row, and every stage
reads it from there. A stage that calls `now()` is non-deterministic by construction and will
disagree with itself across a midnight boundary or a slow run.

### 1.3 Exact aggregates only — ClickHouse defaults are approximate

This is the least obvious rule and the most important. Several ClickHouse defaults trade exactness
for speed, and two of them are **randomised**:

| Never use | Always use | Why |
|---|---|---|
| `uniq()` | `uniqExact()` | HyperLogLog, ~0.5% error |
| `quantile()` / `median()` | `quantileExact()` / `medianExact()` | reservoir sampling with an RNG — genuinely varies run to run |
| `topK()` | exact `GROUP BY … ORDER BY` | approximate |
| `any()` | `min()` / `argMin()` | returns whichever row arrived first |

Robust statistics — the median and MAD that Detect scores residuals with — are exactly where
`quantile()` would be reached for by reflex. Use the `Exact` variants throughout.

### 1.4 Every ordering is total

A ranking whose `ORDER BY` can tie returns a different rank-1 on different runs, because the
underlying scan order is not stable. **Every ranking ends with a unique tiebreaker** — for
Localize, the serialized dimension tuple:

```sql
ORDER BY contribution DESC, dimensions ASC     -- never ORDER BY contribution DESC alone
```

Without this, the rank-1 root cause — the single most visible output of the whole system — can
flip between identical runs.

### 1.5 Float results are rounded at the write boundary

Floating-point sums are order-dependent in their last bits. Every float written to the Signal
Store is rounded to a fixed precision (6 decimal places) at write time, and every comparison uses
a tolerance rather than `==`. This makes byte-identical output achievable without pretending
IEEE-754 addition is associative.

### 1.6 Model stages are made deterministic by persistence, not by bit-exact math

Chronos and PSqueeze may carry GPU or threading jitter that no seed fully removes. Rather than
fight that, determinism is enforced **at the storage boundary**:

- Forecast runs as a batch and **writes its band to `forecasts`**.
- Detect **reads the stored row**. It never regenerates a forecast.

So an investigation is deterministic given the stored artifact, even where regenerating that
artifact is not bit-exact. Seeds and library versions are pinned anyway, and `model_runs.inputs_hash`
records what went in — so drift becomes *detectable* rather than silent.

### 1.7 The language model sits outside the deterministic core

- **Numbers:** come from the claim set, which is built from Signal Store rows. Fully deterministic.
- **Prose:** `temperature=0`, fixed `seed`, guided decoding. Near-deterministic, and irrelevant to
  correctness because the verifier rejects any figure not in the claim set.
- **Template mode:** bit-exact, always available, and proven to carry all five scenarios on its own
  at Gate D.

So the honest formulation, which is stronger than a blanket claim:

> **The numbers are fully deterministic, without exception. The prose is deterministic in its
> facts, near-deterministic in its wording, and has a bit-exact mode.**

### 1.8 Determinism is a test, not a promise

```
run investigation twice over a frozen window
  -> diff every Signal Store row
  -> any difference is a build failure
```

This is cheap to run and catches every violation above. It belongs in the Gate D suite.

---

## 2. Covering every KPI, not a chosen few

Hand-authoring a contract per KPI does not scale — NexaBank alone resolves to 48 canonical events
across 13 namespaces, and it is one demo tenant. So contracts come in two tiers
(`docs/KPI_CONTRACT.md`): **coverage from discovery, depth from declaration.**

- **Tier 0** is synthesised nightly for every metric with data. Counts at event grain via
  `uniqExact(event_id)`; readiness computed from whether rows exist; sliceable dimensions decided
  by a *measurement* — a key qualifies only if virtually every session sees exactly one value of
  it. That test is what keeps fabricated and session-varying fields out of cube search
  automatically, rather than depending on anyone remembering.
- **Tier 1** is a declared YAML file that adds what cannot be inferred: ratios, invariants,
  entitlement, interventions, levers, and graph edges.

A Tier 0 metric still gets a real, verified answer — it moved this much, concentrated here, heading
there. It gets no causal claim and no recommended action, because nobody has declared what an
intervention or a lever means for it. Promoting one is writing its contract file; nothing else
changes.

---

## 3. Shape of the build

A new service, `api/intelligence/`, with its own container (decision **D3**: same image, different
`command`). One entry point, one ClickHouse client, one auth story — rather than inheriting
`api/main.py`'s client-per-query leak and duplicate `/insights` route while your team is actively
editing that file.

**The seam:** the service never queries `events_raw`. It asks the **Metric Layer** for fundamentals
at a declared grain. Everything the platform team is changing lands behind that seam; if the data's
shape changes, the Metric Layer changes and the nine stages do not. It is also what lets every
stage be built and tested today against a stub returning known numbers.

---

## 4. Order of work

Each phase is independently verifiable, which matters because there is no CI yet.

| # | Phase | Done when |
|---|---|---|
| 0 | **Metric Layer** + Signal Store DDL + contract loader | Stub and live implementations agree on golden inputs |
| 1 | Contract discovery (Tier 0) + declared overrides (Tier 1) | Every canonical event resolves to a contract; invariance test filters dimensions |
| 2 | **Trust Gate** + `trust_findings` | **Scenario 1 runs end to end with no LLM** — a real defect caught and suppressed |
| 3 | Forecast batch + `forecasts` | Every KPI has a band with an interval and a backtest score or caveat |
| 4 | Detect + materiality | Fires on planted movement, silent on golden-normal windows |
| 5 | Localize + propagation | Planted segment at rank 1; contributions sum to ~1; N related alerts collapse to one story |
| 6 | Causal + Decide | Rung labelled; levers only from the contract's closed list |
| 7 | Claim set + entitlement + **template narrator** | **Gate D** — all five scenarios, zero LLM rows in `model_runs` |
| 8 | LLM narrator + numeric verifier | **Gate L** — claim sets byte-identical to Gate D |
| 9 | Dashboard endpoints + Observe | Evidence card and engine breakdown render; outcomes captured |

Phase 2 gives a genuine demo. Phases 0–7 contain no LLM at all — the system is made correct before
it is made articulate.

---

## 5. What this needs from the platform team

| Need | Why it blocks | Status |
|---|---|---|
| **Metric Layer ownership decided** | Nothing can be built until the interface exists | Done — `api/intelligence/metrics.py` (`TASK.md` B-0) |
| `_simulated` marker in the envelope | Without it, Tier 0 admits fabricated dimensions into cube search | Done (`TASK.md` P0-8) |
| Canonical event name at rest | The Metric Layer cannot give two stages the same number without it | Done — `events_raw.event_name_canonical` (`TASK.md` P0-6) |
| One definition of a day | Every band and residual is computed in the wrong units until this lands | Done — `TZ=UTC`, zero `today()` calls (`TASK.md` P0-1..3) |
| `DIMS` session-invariance passing on live data | Gates Localize; a failing dimension is unsliceable | Invariance holds; the values are fabricated and now say so |
| Forwarder outcome counters | Trust Gate cannot tell "KPI dropped" from "forwarder broken" | Done — `GET /health/forwarder` (`TASK.md` P0-10) |
| Personas in `rbac.json`, on a verified identity | Entitlement has no identity source | Personas done (P2-3); **the identity is still caller-asserted** (P2-1) |
| A way to apply Signal Store DDL | No migration runner; the ten tables exist only as DDL | Done — `storage/migrate.py` (`TASK.md` P1-2, P1-3) |
| Duplicate-storm detection under `ReplacingMergeTree` | Scenario 1's invariant is merge-dependent | Decision **D1** resolved — `raw_rows` in the MV (`TASK.md` P1-5) |
| Ingest watermark on `investigations` | Backdated events make a re-run non-reproducible | Done — `watermark_ingested_at` (`TASK.md` P1-4) |

**Correction, 2026-08-28, superseded 2026-08-29.** An earlier version of this section stated that
*"the `_simulated` marker landing in the last merge removed the largest blocker."* It had not landed
at that point — a repo-wide search returned one hit, `contracts/pro_revenue.yaml`'s unrelated
`is_simulated`. It landed under P0-8, and the measured invariance test alongside it, so §6's claim
that two independent gates protect cube search now holds in both halves. The two are **not**
interchangeable: a per-session fabricated dimension passes the invariance test cleanly, so the
marker is the load-bearing one. See `docs/INTELLIGENCE_LAYER_PREREQUISITES.md` §2.1 and Block A.

---

## 6. Risks, and how each is contained

**The Metric Layer slips.** Everything waits. *Contained by* building every stage against a stub
from day one, so only the final wiring is blocked rather than the whole programme.

**Fabricated dimensions leak into a cube search.** Ranked, confident, meaningless output — the
worst failure mode this system has, because it looks correct. *Contained by* two independent gates:
the `_simulated` marker, and the measured invariance test. Either alone suffices.
**Neither exists today** — the marker was recorded as landed and is absent, and the invariance test
is unbuilt, so this risk is currently uncontained. Note also that the invariance test alone would
*not* have caught it: `eventTracker.ts` caches its dice roll per session, so a fabricated
dimension passes an invariance check cleanly. The marker is the load-bearing gate here, not the
redundant one.

**A library adds non-determinism.** *Contained by* §1.6: model outputs are persisted and re-read,
seeds and versions pinned, `inputs_hash` recorded, and the determinism diff run in the Gate D suite.

**A heavy dependency is unavailable** (no GPU, PSqueeze not installed). *Contained by* every stage
declaring a dependency-free fallback tier and recording that it used one. The pipeline never fails
because an optional package is missing.

**Scope drifts toward chart-reading.** The engine reasons over measures, never over rendered
visualizations. A heatmap is a two-dimensional cross-tab of a fundamental — the cube Localize
already searches. *Contained by* keeping the Metric Layer the only input.

**Status drifts from reality** — the failure `docs/FOUNDATION_STATUS.md` was written to prevent.
*Contained by* every "done" claim naming the command that proves it.

---

## 7. What success looks like

- Re-running any investigation over a frozen window produces byte-identical rows.
- All five scenarios pass with **zero** rows in `model_runs` where `engine_type = 'llm'`.
- Turning the LLM on changes no number, only the prose.
- Every KPI on the platform has a contract, most of them discovered rather than written.
- Every narrated figure traces to a Signal Store row; verifier coverage is 100%.
- A KPI that is not instrumented says so, instead of reading zero and narrating a collapse.
