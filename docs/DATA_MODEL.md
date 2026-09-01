# Data model — Bronze, Silver, Gold

> **Track B rebuild status (2026-09-01).** This is the target design and it is built: Phases 1–7
> of [`docs/audit/TRACK_B_PHASED_PLAN.md`](audit/TRACK_B_PHASED_PLAN.md) landed the three databases,
> the layered DDL under `warehouse/clickhouse/{bronze,silver,gold}/`, `pipeline/` transforms, and
> the Metric API. Per-phase detail + deviations: [`docs/execution/`](execution/). Deltas from the
> tables below: `fact_cards` / `fact_campaign_interactions` / `dim_macro_environment` are **not
> built** (not in the 5-KPI chain); `silver.fact_*` are rebuilt wholesale each run (`TRUNCATE` +
> re-derive from bronze); the gold rollups are `ReplacingMergeTree` recomputed per window, not an
> `AggregatingMergeTree` MV.

Three layers in ClickHouse, one database per layer. A table belongs to exactly one layer, and the
layer decides who may read it.

| Layer | Database | What it holds | Who reads it |
|---|---|---|---|
| **Bronze** | `bronze` | Raw records exactly as received. Never edited, never deleted. The audit trail. | The pipeline only |
| **Silver** | `silver` | Cleaned and conformed. Canonical names, deduplicated, masked, sessionised, one agreed day and timezone. | The Metric API |
| **Gold** | `gold` | Ready-to-serve KPI rollups, the segment cube, and the Signal Store. | The Metric API, the tools, the dashboard |

**The dashboard and the tools never read Bronze.** Not as a convention — Bronze is a separate
database and the read paths do not have it in scope.

## Why three layers and not one flat schema

The prototype ran 30 tables as peers in one database: raw events, rollups, dimension and fact
tables, and the Signal Store all mixed together. Three things went wrong, and all three are
structural rather than accidental.

- **No safe place to re-derive.** A taxonomy fix could not be replayed, because the only copy of an
  event had already been canonicalised in place. Bronze exists so every downstream layer can be
  rebuilt from scratch without re-running the bank.
- **Correctness leaked into every reader.** Deduplication, name canonicalisation and session
  reconstruction were done in each query, differently, so two endpoints computing the same metric
  disagreed. Silver does that work once.
- **Every read scanned raw events.** A KPI card scanning per-event rows for a 90-day window is the
  optimisation problem the layering removes. Gold answers a KPI query from a pre-aggregated row.

## Bronze — raw, immutable

Bronze is append-only. Nothing in Bronze is corrected; a correction is a new row with a later
version, and Silver decides which one wins.

| Table | Grain | Source |
|---|---|---|
| `bronze.events` | one row per event as received | clickstream, real time |
| `bronze.core_banking` | one row per extracted record, per entity | daily batch extract |
| `bronze.events_dead_letter` | one row per event that failed the pipeline | either path |

Every Bronze row carries the same provenance columns, and they are what makes a replay possible:

- `event_id` / `record_id` — the deterministic identity assigned at ingestion. Not a hash of
  source id plus sequence plus timestamp: there is no source sequence, so that collides.
- `_ingested_at` — when we received it. Distinct from when it happened.
- `_source_id` — which producer path, so the two cadences can be reconciled.
- `_kafka_partition`, `_kafka_offset` — so a consumer gap is detectable rather than inferred.
- `_raw` — the untouched payload. If the parse was wrong, the original is still here.

**Engine.** `MergeTree`, partitioned by month of event time, ordered by
`(tenant_id, _source_id, timestamp)`. No `ReplacingMergeTree`: Bronze must not collapse anything,
because a duplicate arriving twice is itself the evidence the Trust Gate reads.

**Retention.** Bronze is the largest layer and the least read. A TTL moves partitions older than
the audit window to cold storage rather than deleting them.

## Silver — cleaned and conformed

Silver is where every correctness rule is applied exactly once. A reader of Silver may assume all
of the following, and no reader needs to re-implement any of them.

**What Silver does to an event:**

1. **Canonicalises the name, once.** One vocabulary, resolved at write time, so that aliases of one
   feature merge into one row and every downstream aggregate groups on the same key. The prototype
   canonicalised on read, in Python, in two places that disagreed — one took a max where the other
   summed.
2. **Deduplicates by `event_id`.** A worker replay collapses. Counting rows and counting distinct
   ids give the same answer.
3. **Masks personal data.** Silver holds no raw identifier that Bronze does not.
4. **Rebuilds sessions.** Session grain is what makes a ratio localizable — a contribution can only
   add up if the dimension is invariant within the grain it is measured at.
5. **Pins the day.** One timezone, UTC, one definition of a day, applied here and nowhere else.
6. **Rejects rather than coerces.** An unresolvable name goes to the dead-letter table with a
   reason, instead of being wrapped into a plausible-looking name that lands in the warehouse and
   vanishes from every chart.

**Tables:**

| Table | Grain |
|---|---|
| `silver.events` | one row per deduplicated, canonicalised event |
| `silver.sessions` | one row per session, with its resolved attributes |
| `silver.fact_transactions` | one row per transaction |
| `silver.fact_loan_applications` | one row per application, with its KYC step and decision |
| `silver.fact_account_openings` | one row per opened account |
| `silver.fact_cards` | one row per issued card |
| `silver.fact_campaign_interactions` | one row per interaction |
| `silver.dim_customer` | one row per customer — demographics, risk segment, branch |
| `silver.dim_branch` | one row per branch — region, country, city |
| `silver.dim_campaign` | one row per campaign |
| `silver.dim_calendar` | one row per day — holidays, known events |
| `silver.dim_fee_schedule` | one row per fee rule, with validity dates |
| `silver.dim_macro_environment` | one row per region-month — competitor rates, base rate |

**Engine.** `ReplacingMergeTree(_version)`, ordered so the deduplication key is the natural
identity of the row. Dimensions are small and unpartitioned; facts partition by month.

## Measured versus fabricated dimensions

This is a correctness rule, not a data-quality nicety, and it belongs in the data model because
the model is where it can be enforced.

A dimension may be sliced by the intelligence layer only if it was **measured**. Geography, city,
device type and channel are currently invented by the producer, at random, once per session. They
are session-invariant, so contributions over them sum to 1.0 and an explanation looks complete —
over dice rolls. Nothing downstream can tell.

Silver therefore carries, per row, a declaration of which attributes were fabricated. The contract
loader refuses to localize a dimension that appears in that declaration. An invariance test does
not catch this, because a per-session fabrication passes an invariance test cleanly.

The fix in the source is P3 work: derive geography from the branch, and device from the real user
agent. Until then the declaration is the gate.

## The five KPIs, and where each number comes from

Every KPI value is produced from the **daily banking snapshot**, not the clickstream. That is a
correctness decision, not a convenience one: the batch facts carry dimensions the bank actually
recorded, while the clickstream carries dimensions the producer invented.

| # | KPI | Shape | Source of truth | Stored fundamentals | Localizable dimensions |
|---|---|---|---|---|---|
| 1 | New account signups | count | `silver.fact_account_openings` | `accounts_opened` by day of `opened_at` | account_type, branch_code, region, country |
| 2 | KYC completion rate | rate | `silver.fact_loan_applications.kyc_step` | `kyc_started`, `kyc_completed` | loan_type, risk_segment, region, branch_code |
| 3 | Loan approval volume | count | `silver.fact_loan_applications`, `status = APPROVED`, by `decided_at` | `loans_approved`, `principal_approved` | loan_type, risk_segment, region, term bucket |
| 4 | Revenue | money | modelled from measured inputs | `fee_revenue`, `interest_accrued`, `pro_revenue` | channel, txn_type, mcc, region, branch_code |
| 5 | Transaction failure rate | rate | `silver.fact_transactions.status` | `txn_total`, `txn_failed` | channel, txn_type, mcc, region, branch_code |

Notes that are easy to get wrong:

- **Loan approval volume counts on `decided_at`, not `created_at`.** An application created in one
  window and approved in the next belongs to the window it was approved in.
- **Both rates store their two counts, never the ratio.** A rate is derived at read time. Storing
  it makes it non-additive, and a non-additive quantity cannot be localized or summed across
  segments without being wrong.
- **Revenue is modelled, but grounded.** `fee_revenue` is `fee_flat + amount * fee_pct` from
  `dim_fee_schedule` applied to real transaction amounts -- a real schedule against real money,
  not an invented figure. `interest_accrued` is approved principal times rate over 365.
  `pro_revenue` is the one line with no measured money behind it, so it carries a `simulated:`
  block. A channel with no fee-schedule row earns no fee, so a missing row silently deletes it
  from revenue.
- **The chain is what makes one story out of five.** Signups feed KYC starts, KYC completions gate
  approvals, approvals drive interest revenue, and the failure rate suppresses fee revenue and can
  depress KYC completion at the same time. A movement in revenue is explained by walking back up
  that chain, not by a revenue model.

### Which source does which job

The brief requires two sources at two cadences. They differ by *job*, not only by speed.

| | Daily banking snapshot | Real-time clickstream |
|---|---|---|
| Produces | the KPI value | behavioural context |
| Grain | transaction, application, account | event, session |
| Dimensions | measured: region, branch, channel, mcc, loan_type, risk_segment | fabricated: location, city, continent, device_type |
| Used by | Detect, Localize, Forecast, Decide | funnel stage detail, journey reconstruction |
| Never used for | screen-level abandonment | any number a reader sees as a KPI |

Localize runs on the snapshot. The clickstream answers "which step did they abandon", never "how
much did revenue fall". This is the single change that stops the engine ranking dice rolls.

## Gold — serving

Gold holds two different kinds of thing that happen to share a layer: pre-aggregated KPI rollups,
and the Signal Store where the tools write what they concluded.

### KPI rollups

The rollup is **narrow and long**, not a column per KPI. A new KPI adds rows, never a migration.

| Table | Grain | Purpose |
|---|---|---|
| `gold.kpi_daily` | tenant × kpi × date × fundamental | the value of every additive fundamental, per day |
| `gold.kpi_daily_by_dim` | tenant × kpi × date × fundamental × dimension × value | the segment cube Localize searches |
| `gold.funnel_daily` | tenant × funnel × date × stage | stage counts, so a rate is always derived from counts |

Three rules make these usable:

- **Rollups store additive fundamentals, never rates.** A rate is computed at read time from its
  two counts. Storing a rate makes it non-additive, and a non-additive quantity cannot be
  localized, averaged across days, or summed across segments without being wrong.
- **Distinct counts are aggregate states, not plain columns.** A distinct-user count is stored as
  an aggregate function state and read back with its merge function. A plain column inside an
  aggregating table decays silently as parts merge, and is not idempotent under a worker replay.
- **Row counts as inserted are kept alongside deduplicated counts.** Silver merges duplicates away,
  so the duplicate storm the Trust Gate needs to detect is invisible unless the pre-merge count is
  recorded at write time.

### The Signal Store

Where every tool writes what it concluded, and the only thing the narrator is allowed to read.

| Table | Written by |
|---|---|
| `gold.investigations` | the orchestrator, one row per run, pinning the window and the watermark |
| `gold.trust_findings` | Trust Gate — **including passes** |
| `gold.anomalies` | Detect |
| `gold.root_causes` | Localize |
| `gold.forecasts` | Forecast |
| `gold.causal_effects` | the causal check |
| `gold.recommendations` | Decide |
| `gold.insights` | the narrator, one row per persona |
| `gold.model_runs` | every stage, with its engine type, latency, tokens and cost |
| `gold.outcomes` | the feedback loop |

Two rules:

- **Every row carries `investigation_id`.** Not `anomaly_id`. A Trust Gate failure produces a
  narrative with no anomaly, and model-run rows are written by stages that execute before any
  insight exists. Hanging the audit trail off the anomaly loses exactly the runs that matter most.
- **Trust Gate writes on a pass too.** The suppression rate is itself audited, so an unrecorded
  pass is as much a hole as an unrecorded failure.

## Sizing and query performance

The point of the layering is that a dashboard query never touches an event row.

| Query | Reads | Rows scanned |
|---|---|---|
| KPI card, 30 days | `gold.kpi_daily` | ~30 per KPI |
| Segment contribution | `gold.kpi_daily_by_dim` | ~days × cells |
| Funnel | `gold.funnel_daily` | ~days × stages |
| Session or user journey | `silver.sessions`, `silver.events` | bounded by tenant and window |
| Replay after a taxonomy fix | `bronze.events` | everything, deliberately, offline |

Bronze grows without bound and is read by one process. Silver is bounded by the retention window
the Metric API serves. Gold is small enough to stay resident. That is the whole optimisation story
— there is no tuning to do if the layer boundaries are respected, and no amount of tuning saves a
KPI card that scans raw events.

## Changing the schema

- Schema files auto-apply **only to an empty volume**. A change against a running stack is a
  migration applied by hand, then mirrored into the layer DDL. The two have diverged before.
- **Baseline an existing database before the first migration run**, or historic migrations replay
  against an already-migrated schema and drop the live materialized view.
- Every migration is recorded by name and content hash, so an edited migration is detected rather
  than silently re-applied.
