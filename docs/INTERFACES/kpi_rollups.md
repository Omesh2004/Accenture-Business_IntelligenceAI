# Interface — the KPI rollups (`gold.kpi_daily` / `gold.kpi_daily_by_dim`)

**Status:** FROZEN for Round 2 (Phase 0). Owner: Track B. Consumer: Track C (`contracts/*.yaml`
are written against this) and the Metric API.

**What this is:** the gold schema Track C writes KPI contracts against — the fundamental set per
KPI, the source fact table and filter each fundamental rolls up from, and the dimensions each KPI
may be localized on. Aligned to `docs/DATA_MODEL.md` § "The five KPIs, and where each number comes
from" and `TRACK_B_PHASED_PLAN.md` decisions **D1** (revenue) and **D2** (signups).

**The one rule that drives the shape:** every KPI value comes from the **daily banking snapshot**
(`bronze.core_banking` → `silver.fact_*`), never the clickstream. The clickstream feeds
`gold.funnel_daily` (stage detail) only.

---

## Rollup table shapes

### `gold.kpi_daily` — narrow-long, one row per fundamental

| dimension | |
|---|---|
| grain | `tenant_id × kpi_id × date × fundamental` |
| stores | the value of every **additive** fundamental, per day |
| never stores | a rate — a rate is derived at read time from its two count fundamentals |
| distinct counts | stored as an `AggregateFunction` state, read back with its merge function — never a plain column in an aggregating table |
| replay-detection | row-count-as-inserted kept alongside the deduplicated count (`raw_rows` sumState pattern, carried from `daily_feature_usage`) |

A new KPI adds **rows**, never a migration.

### `gold.kpi_daily_by_dim` — the segment cube Localize searches

| dimension | |
|---|---|
| grain | `tenant_id × kpi_id × date × fundamental × dimension × value` |
| built from | the **measured fact columns** only (region, branch_code, channel, mcc, loan_type, risk_segment, account_type, term_bucket) |
| carries | `unexplained_pct` per (kpi, date, fundamental, dimension) |

### `gold.funnel_daily` — clickstream, stage detail only

| dimension | |
|---|---|
| grain | `tenant_id × funnel_id × date × stage` |
| source | `silver.events` |
| never | produces a KPI rate — the KYC / transaction-failure rates come from the fact tables |

---

## The five KPIs

| # | `kpi_id` | shape | source of truth | stored fundamentals (in `gold.kpi_daily`) | localizable dims |
|---|---|---|---|---|---|
| 1 | `signups` | count | `silver.fact_account_openings` | `accounts_opened` — count by day of `opened_at` | `account_type`, `branch_code`, `region`, `country` |
| 2 | `kyc_completion_rate` | rate | `silver.fact_loan_applications.kyc_step` | `kyc_started`, `kyc_completed` (two counts, **never the ratio**) | `loan_type`, `risk_segment`, `region`, `branch_code` |
| 3 | `loan_approval_volume` | count | `silver.fact_loan_applications` where `status='APPROVED'`, keyed on **`decided_at`** | `loans_approved`, `principal_approved` | `loan_type`, `risk_segment`, `region`, term bucket |
| 4 | `revenue` | money | modelled from measured inputs — see **D1** below | `fee_revenue`, `interest_accrued`, `pro_revenue` | `channel`, `txn_type`, `mcc`, `region`, `branch_code` |
| 5 | `transaction_failure_rate` | rate | `silver.fact_transactions.status` | `txn_total`, `txn_failed` (two counts, **never the ratio**) | `channel`, `txn_type`, `mcc`, `region`, `branch_code` |

**Fallback cut** (CLAUDE.md §5, if time runs short): KPIs 2, 3, 4 + two personas.

### Rules that make the numbers correct (get these wrong → wrong numbers)

- **Loan approval volume counts on `decided_at`, not `created_at`.** An application created in one
  window and approved in the next belongs to the window it was approved in.
- **Both rates store their two counts, never the ratio.** A stored rate is non-additive and cannot
  be localized or summed across segments.
- **A `fact_transactions` channel with no `dim_fee_schedule` row earns no fee** and silently
  vanishes from `fee_revenue`. The join is on `(txn_type, channel)`, valid-dated.

---

## Decision D1 — revenue composition

Modelled, but grounded in measured inputs. **No new table, no new extract endpoint.**

| fundamental | derivation |
|---|---|
| `fee_revenue` | `silver.fact_transactions` ⨝ `silver.dim_fee_schedule` (valid-dated, keyed `(txn_type, channel)`): `sum(fee_flat + amount × fee_pct)` per day. Card-present / interchange is a fee-schedule **row class** folded into this line, not a separate fundamental. |
| `interest_accrued` | `silver.fact_loan_applications` where `status='APPROVED'`: `sum(principal_amount × interest_rate / 365)` per day. Flat daily accrual, **not** an amortisation schedule. |
| `pro_revenue` | the one line with **no measured money behind it** — carries a `simulated:` block in `revenue.yaml`. Track B rolls up whatever pro-subscription / pro-unlock fundamental Track C's contract names (likely a `fact_transactions` subset by `txn_type`). **Confirm the exact fundamental with Track C when `revenue.yaml` lands.** |

If Track C's `revenue.yaml` later needs true amortisation, that is an **additive follow-on**
(`silver.fact_loans` + a new extract endpoint) — those tables stay dropped until then.

## Decision D2 — signups source

`signups` = `silver.fact_account_openings`, `accounts_opened` by `opened_at` day — the **daily
snapshot**, not clickstream `register.auth.success`.

Consequences: `fact_account_openings` is **kept**; `/api/extract/accounts` **is** consumed;
sync-doc **A4** (keyset tiebreaker on that endpoint) is **in scope**. This supersedes CLAUDE.md
§6's clickstream wording for signups — flagged for whoever owns CLAUDE.md.

---

## Where each fundamental's columns come from (verified against the extract API, Phase 0)

| fact table | fed by `/api/extract/` | fields the rollups read | verified |
|---|---|---|---|
| `fact_account_openings` | `accounts` | `opened_at` (`= createdOn`), `account_type`, `branch_code`, `region`, `country` | ✅ present; **A4**: endpoint lacks the `since_id` keyset tiebreaker + `cursor_id` in the response — needs the fix the other core endpoints have |
| `fact_loan_applications` | `loan_applications` | `kyc_step`, `status`, `decided_at` (null unless APPROVED/REJECTED), `principal_amount`, `interest_rate`, `loan_type`, `term_months`, `customer_id` | ✅ present (`region` / `risk_segment` join via `dim_customer`) |
| `fact_transactions` | `transactions` | `status`, `channel`, `txn_type`, `mcc`, `amount`, `occurred_at`, `region`, `country`, `branch_code` | ✅ present |
| `dim_customer` | `customers` | `risk_segment`, `age_bracket`, `income_bracket`, `branch_code`, `region` | ✅ present |
| `dim_branch` | `branches` | `region`, `country`, `city` | ✅ present |
| `dim_campaign` | `campaigns` | `name`, `channel`, `target_segment`, `start_date`, `end_date`, `spend` | ✅ present |
| `dim_fee_schedule` | reference data — see D8 | `(txn_type, channel)`, `fee_flat`, `fee_pct`, `valid_from`, `valid_to` | ⚠️ synthesised today by `seed_reference_data`; **channel casing is UPPERCASE** (`WEB`/`MOBILE`/`ATM`/`POS`) while `fact_transactions.channel` casing must be reconciled in Phase 3 or the join drops rows |
| `dim_calendar` | reference data — see D8 | `calendar_date`, `is_holiday`, `is_weekend`, `is_month_end`, `season`, `label` | ⚠️ synthesised today |

**D8 / A5 — reference-data ownership:** Track B default is **NexaBank owns** fee schedule + calendar
as extract endpoints (`/api/extract/fee_schedule`, `/api/extract/calendar`). If Track A declines or
does not build them by Phase 3, Track B keeps synthesising via `seed_reference_data` (moved to
`pipeline/extract/reference.py`).
