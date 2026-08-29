# EDGE_CASES.md

The failure modes each stage must handle, translated from the Intelligence Layer Explorer's
edge-case set into what they actually mean **in this repo**. Generic advice is useless here; each
entry names the file, the observable symptom, and the required behaviour.

A stage is not done when the happy path works. It is done when these are handled or explicitly
declared out of scope.

---

## 00. Foundation

**Late and out-of-order events.** `timestamp` is supplied by the producer, not the server:
`forwardToIngestionAPI` sends `Date.now()/1000`, and `scripts/seed_data.py` backdates freely via
`timestampOverride`. Clock skew and late arrival are therefore normal, not exceptional. Bucket on
event time, and mark any window younger than the contract's `provisional_window_minutes` as
**provisional**. Detect must suppress on provisional windows unless magnitude is extreme, or a
half-arrived window reads as a phantom drop.

**Backfill and replay.** Idempotent only after FOUNDATION-1 and FOUNDATION-4 — `uniqExact(event_id)`
makes replays converge instead of doubling. Before those land, a worker restart genuinely doubles
counts and there is no way to tell after the fact.

**Backdating rewrites history.** `trackEvent(..., timestampOverride)` inserts into past partitions
and the MV updates `daily_feature_usage` for those days. An investigation over a frozen *event-time*
window would otherwise produce different rows tomorrow than today.
`investigations.watermark_ingested_at` pins `max(ingested_at)` alongside the window so a re-run
reproduces what was visible at the time. Detect does **not** yet suppress on a provisional window,
so a half-arrived window can still read as a phantom drop.

**A replay is erased before you can detect it in `events_raw`.** `events_raw` is
`ReplacingMergeTree(_inserted_at)` with `event_id` in the sorting key, so a genuine worker replay
is collapsed on merge and `count() == uniqExact(event_id)` becomes true again. Never build a
duplicate-storm check against that table. `daily_feature_usage.raw_rows` counts rows as INSERTED
and survives the merge — that is what `dedup_integrity` reads (decision **D1**).

**Dual write paths — verified present.** `ingestion/main.py:476-507` sends to Kafka with a 5s
timeout and **falls back to a direct ClickHouse insert**. Rows on that path never enter Kafka, so
broker replay cannot reconstruct them, and the worker's batching never sees them. They are tagged:
`ingest_path` is `fallback_cloud` or `fallback_onprem`, `''` meaning "not reported by whatever wrote
this row". Never assume the Kafka topic is a complete log of `events_raw`.

**Schema evolution in `metadata`.** `metadata` is a JSON String. Adding a key is free and silent;
so is removing one. `JSONExtractString(metadata, 'missing_key')` returns `''` — **not** null. An
absent dimension therefore appears to Localize as a legitimate cell whose value is the empty
string. Filter empty-string cells explicitly, or a missing key becomes your rank-1 root cause.

**Tenant misattribution.** `resolveAnalyticsTenantId` maps `bank_a -> nexabank`. If that map and
the four tenant vocabularies disagree (coupling point 3), events land under a tenant no one
queries. Symptom is a metric that reads zero while `events_raw` grows.

---

## 01. Trust Gate

**A legitimate regime change looks like a defect.** A deliberate taxonomy migration or a real
product change can trip the same checks as corruption. Where the change log cannot disambiguate,
return `ambiguous` — never guess a verdict in either direction.

**Both a real event and a defect at once.** Scenario 4. A hard invariant can pass while a soft one
wobbles during a genuine campaign. Report both signals rather than collapsing them into one story.

**Missing corroboration.** If the corroborating events in the contract are themselves not
instrumented, corroboration is *skipped and confidence downgraded* — never treated as passing.
Given FOUNDATION-3, `loan.applied.success` is stranded on the live path, so any contract
corroborating on it must degrade rather than silently succeed.

**Vacuous checks.** There is no money field in `events_raw`, so `revenue == sum(price * qty)` is
true by construction. A check that cannot fail must not be reported as a check that passed —
that is how a trust gate manufactures false confidence.

**Silent gradual corruption.** Invariants catch step changes; slow drift needs distribution
comparison against a trailing baseline. Phase 1 may defer this, but must say it is deferred rather
than implying coverage.

---

## 02. Detect

**Cold-start series.** Below `forecast.min_history_days` there is no trustworthy band. Hold in
`insufficient_history` and surface it as that, not as an anomaly and not as silence.

**Sparse / intermittent series.** Residual tests assuming a continuous distribution are invalid on
mostly-zero counts. Switch to count-based bounds or aggregate to a coarser grain.

**Known events.** A planted simulator scenario or a seeded campaign is an expected spike. Suppress
against the known-event list, or the engine alarms on its own fixture and the false-positive gate
fails for the wrong reason.

**Provisional windows.** See Foundation. Suppress unless the magnitude is extreme.

**Multiple testing.** Monitoring ten declared KPIs plus every Tier 0 discovered series, across
several segments each, means hundreds of simultaneous tests. Without Benjamini-Hochberg, volume
alone manufactures alarms.

**Alert fatigue is the real production failure.** Weight precision over recall. A detector that
fires on everything is indistinguishable from no detector.

---

## 03. Localize

**Numerator and denominator both move.** Analyze each fundamental separately and reconcile. When
they disagree, report the disagreement — do not force a single narrative.

**Contributions that do not sum to ~1.** This is a **correctness alarm**, not a rounding issue. It
means either the fundamental is not additive at `grain.entity`, or a declared dimension is not
invariant within that entity. Fail loudly. Never normalise the numbers so they look right.

**Empty-string cells.** See Foundation — a missing metadata key produces `''`, which will happily
rank as a segment. Exclude it.

**High cardinality.** `location` has ~20 values, `device_type` 3, `channel` a handful — small
today. Still enforce `min_segment_volume` and `max_depth` from the contract, because the cube
grows multiplicatively and a depth-3 search over unbounded values is what turns seconds into
minutes.

**Low explanatory power.** Return top-k with confidence and mark `inconclusive - human review`.
Fabricating certainty to fill the slot is worse than an empty slot.

**Cause outside the recorded dimensions.** "Not explained by available dimensions" is a finding and
must be narratable as one. Given that the live path's `location`/`device_type` are noise, this will
be the *correct* answer for any live-traffic investigation.

> **FOUNDATION-2 did not fix this; the `_simulated` marker did.** FOUNDATION-2 made the live
> dimensions session-*invariant*, which is what makes contributions add up. The values are still
> produced by `selectGeoProfile()` and `selectDevice()` — a weighted dice roll per session — so
> they remain statistically independent of user, outcome and everything else.
>
> Session-invariant randomness **passes an invariance test cleanly**, so that test cannot catch it.
> The gate that does is `metadata._simulated` (P0-8), which names the invented keys per event.
> `contracts.sliceable_dimensions` drops any key in that set, and drops a contract-declared
> `live_fabricated` key on any dataset but `seeded`.
>
> A ranked cause over a dice roll is the worst output this system can produce, because it is
> indistinguishable from a correct one. Do not weaken either gate to make a live-path
> demo localize.

---

## 04. Forecast

**Cold start.** Below the floor, fall back to seasonal-naive or a category prior, widen the
interval, and set `caveat = insufficient_history`. Leave `backtest_mase` at 0 to mark it un-scored
rather than credible.

**Intermittent / zero-inflated series.** Route to count bounds rather than forcing a general
method through mostly-zero data.

**Regime change after an incident.** The pre-incident baseline is invalidated. Re-anchor and widen
the interval honestly instead of projecting a broken level forward.

**Never a single point of failure.** The deterministic baseline is always available. A forecast
stage that can be unavailable is a detection stage that can be unavailable, because Detect reads
its band.

---

## 05. Causal

**No clean pre-period, or unknown intervention timing.** The core assumption fails. Degrade to
attribution and record `degraded_reason`.

**Contaminated controls.** If the "untreated" segment was also exposed, the counterfactual is
biased. Validate control selection on pre-period fit before trusting any effect.

**Overlapping interventions.** A simulator scenario running during a seeded campaign violates the
clean-control requirement. Report attribution, not effect.

**Wide intervals.** Report as-is. "We cannot separate this from noise" is a real result.

**Simulated measures.** `pro_revenue` forbids `estimated_effect` in its contract, because a dollar
effect there is an artefact of the fixed $49 constant, not an observation. Respect that flag.

---

## 06. Decide

**No safe action known.** Return `investigate` with the evidence attached. Never invent a lever —
the contract's `allowed_levers` list is closed.

**Guardrail conflict.** Owner-role restrictions and entitlement always win over any predicted
impact.

**Delayed and unobserved outcomes.** Phase 1 records proposals and outcomes but does not learn from
them. Do not present the `outcomes` table as evidence a recommendation worked until enough rows
exist to say so.

**Recommending into a blocked KPI.** If the driver KPI is `readiness: blocked`, any recommendation
built on it is unfounded. Check readiness before proposing.

---

## 07. Narrate

**Verification failure.** Regenerate (bounded), then redact, then deterministic template. An
unverified number never reaches a reader.

**Model unavailable.** Template from the same signal cards. Degraded means plainer, never wrong,
and never a stack trace.

**Overconfident phrasing.** The verifier checks numbers; it must also check that hedging matches
evidence strength. "Caused by" on an `attribution` rung is a verification failure even when every
digit is correct.

**Prompt injection via content fields.** `metadata` is attacker-influenceable and is sanitised only
for emails and IPv4 at ingest. Never place raw metadata in the LLM context. The narrator has no SQL
and no raw-data access, so the blast radius is a bad sentence rather than a bad query — preserve
that property.

**Simulated figures.** Must carry `narrative_qualifier` verbatim. A modelled revenue number stated
bare is a fabricated metric under CLAUDE.md.

**Entitlement back-computation.** Removing a restricted card is not enough if an unrestricted ratio
reconstructs it. Honour `suppress_for_others`.

---

## 08. Observe

**No labelled incidents yet.** Shadow mode builds the set before any gate is enforced. Do not
enforce a gate against an empty golden set and call it passing.

**Synthetic and seeded traffic.** The entire Phase 1 demo runs on seeded data. That is a smoke
test, not evidence of production quality. **No gate may be declared passed on generated data** —
record which dataset each evaluation ran against.

**Metric gaming.** Precision is maximised by never alerting; recall by always alerting. Gate on
both, always paired.

**Silent model degradation.** Live metrics can look healthy while quality decays. Re-run the golden
scenarios on every prompt or model change, not on a schedule.

**Unrecorded passes.** A `trust_findings` row is required on passes too. Stage 08 measures the
suppression rate, and a gate that never records a pass cannot distinguish "nothing was wrong" from
"nothing ran".
