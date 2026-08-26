# FinInsights Dashboard — Migration Plan for the Intelligence Layer

**Purpose:** Hand-off plan for the coding agent (Google Antigravity) that will audit the existing FinInsights codebase and evolve it so the dashboard can show and visualize the new "Intelligence Layer" (9-stage reasoning pipeline) instead of the current flat analytics views.

This is a **plan only** — no code. It is organized so the agent can work top-down: data model → APIs/realtime → shared UI primitives → page-by-page changes → rollout.

---

## 0. What's actually changing (one paragraph)

Today, FinInsights is: `NexaBank/JavaBank telemetry → FastAPI → Kafka → ClickHouse (events_raw, daily_feature_usage, tenant_licenses, tracking_toggles, config_audit_log, ai_reports) → Next.js dashboard`, with a local Ollama model bolted on at the end to write free-text summaries. The new architecture keeps Kafka/ClickHouse as the substrate but inserts **seven reasoning stages** between raw data and anything shown to a user: a **trust gate** (is the data even real), **detect** (is this movement real), **localize** (root cause), **forecast** (zero-shot trajectories), **causal impact** (did X actually cause Y), **decide** (recommended actions via bandits/uplift models), and only then **narrate** (an LLM writes a verified sentence — replacing the current Ollama free-text call). An **observe** stage closes the loop and tracks whether the system is actually right. The dashboard's job changes from "render pre-aggregated charts" to "render the output and confidence/verdict of each reasoning stage, and let a human approve or reject what stage 6 recommends."

---

## 1. Data model changes (ClickHouse) — do this first

Everything downstream depends on this, so it's the first work item.

### 1.1 New "signal store" tables
The new architecture is explicit that six tables are the shared memory every stage reads/writes. These do not exist in the current schema and must be added:

| Table | Purpose | Notes for schema design |
|---|---|---|
| `anomalies` | Output of the Detect stage | tenant_id, metric_id, window, deviation type, robust z-score, effect size, persistence count, status (fired/suppressed/provisional) |
| `root_causes` | Output of the Localize stage | anomaly_id (FK), ranked dimension combinations (region/device/channel/category/tier/path), contribution share per candidate, method used (PSqueeze/Squeeze/HotSpot) |
| `forecasts` | Output of the Forecast stage | metric_id, horizon, point forecast, prediction interval (lo/hi), backtest MASE/CRPS vs seasonal-naive, model used, "beat naive" boolean (fallback flag) |
| `recommendations` | Output of the Decide stage | anomaly_id/context, candidate action, predicted uplift, cost, rank, approval status (proposed/approved/rejected/executed) |
| `outcomes` | Closed-loop results | recommendation_id (FK), realized effect, whether it matched prediction — this is what stage 8 needs |
| `model_runs` | Audit trail | model name/version, stage, input hash, latency, verifier result — powers the new Observability page |

**Also required, orthogonal to the signal store:**
- A `trust_verdicts` table (or extend `config_audit_log`) capturing the Trust Gate's decision per metric/window: pass / flag / halt, which check failed (schema, distribution, invariant/reconciliation, upstream corroboration, coincident-change), and whether the metric is currently quarantined.

### 1.2 Changes to existing tables
- **`daily_feature_usage`**: audit for the "ratio rule" violation — the new architecture requires that no rate/ratio ever be stored directly; only numerator and denominator ("fundamentals") are stored, with rates computed at read time. If any existing rollup stores a pre-computed rate (conversion %, error rate, etc.), it needs to be split into its additive components so Localize and the Trust Gate's reconciliation checks can operate on it. Check `daily_feature_usage` and any funnel-stage tables specifically.
- **`events_raw`**: needs a deterministic `event_id` (hash of natural key) if not already present, so downstream counts become distinct-counts and Kafka at-least-once delivery doesn't inflate figures. Also confirm event-time bucketing vs. arrival-time, and add a "provisional" flag/watermark for recent windows.
- **`ai_reports`**: this table's role changes fundamentally. Today it caches raw Ollama text. It needs to instead store the **structured, schema-validated narrative** (signal cards referenced, per-figure verification status, hedge-language/confidence level, and — critically — a link back to `trust_verdicts` so a quarantined metric never gets a narrative written about it as if it were a real business event).

### 1.3 Tenant scoping
Every new table above must carry `tenant_id` and follow the same row-level isolation pattern already used for `events_raw`. This is not new work conceptually, just needs to be replicated onto six new tables plus `trust_verdicts`.

---

## 2. API / backend service changes

The FastAPI layer needs new read endpoints (and a couple of write endpoints for human-in-the-loop actions). Suggested groupings:

- `GET /trust/verdicts?tenant&metric&range` — trust gate status per metric/window, plus quarantine list.
- `GET /anomalies?tenant&range&status` — anomaly feed.
- `GET /anomalies/{id}/root-causes` — ranked cause set for drill-down.
- `GET /forecasts?tenant&metric&horizon` — forecast + interval + backtest score.
- `GET /causal-impact?tenant&intervention_id` — synthetic control result, lift + credible interval.
- `GET /recommendations?tenant&status` and `POST /recommendations/{id}/approve` / `/reject` — the approval workflow. This needs to route through existing RBAC/audit (`config_audit_log`) since it's a governed action, not just a read.
- `GET /narratives/{report_id}` — now returns structured payload (verified figures + citations to signal store rows), not a text blob.
- `GET /model-runs?stage&range` and `GET /golden-set-results` — for the new Observability page.

All existing endpoints backing the current dashboard pages (feature analytics, funnel, license usage, multi-tenant comparison) stay, but should be audited so any rate/percentage they return is computed from fundamentals at query time rather than read from a stored rate column (see 1.2).

### 2.1 Real-time / WebSocket changes
The current WebSocket only pushes KPI deltas on ClickHouse commit. New event types are needed so the dashboard doesn't have to poll:
- `anomaly.detected` (streaming path only — Detect stage has a sub-second online detector; most other stages are batch-scheduled and should NOT be pushed live, they should just refresh on their own schedule)
- `trust.verdict.changed` (a metric got quarantined or released)
- `recommendation.created`
- `narrative.verified` / `narrative.redacted`

Batch-scheduled stages (forecast, causal, decide, narrate) should be polled/refreshed on the dashboard at a sane interval, not wired into the live socket — wiring everything into the socket will make the "17 users active" style live panel noisy for no benefit.

---

## 3. Shared UI primitives to build once, reuse everywhere

Before touching individual pages, build these shared components — nearly every page below needs at least one of them:

1. **Trust badge** — a small pill (pass / flagged / quarantined) attachable to any metric card, chart title, or table row. This is the single most reused new element; almost every existing chart needs one next to it now, because a chart should never render a quarranted metric as if it were normal.
2. **Confidence/uncertainty band renderer** — for forecast charts: point line + shaded interval, with a visual cue when a series fell back to the classical model (i.e., the foundation model didn't beat naive baseline).
3. **Verdict-to-verb chip** — proceed / flagged / suppressed, styled consistently (this already exists conceptually in the architecture explorer HTML — teal/amber/slate — reuse that palette logic if brand allows).
4. **Root-cause breakdown table/tree** — dimension × contribution-share, sortable, for the Localize output. Needed by both Feature Analytics and Funnel Analysis drill-downs.
5. **Approve/Reject action row** — for recommendations, with a required-comment field wired to the audit log.
6. **"Why this number" popover** — click any figure in a narrative and see the signal-store record it was verified against. This directly implements the new architecture's core guarantee ("no number is invented") and should be treated as a first-class, non-optional UI element, not a nice-to-have.

---

## 4. Page-by-page changes

Mapping to the current sidebar: Dashboard, Feature Analytics, Funnel Analysis, User Journey, License vs Usage, Predictive Insights, Tenants, Configuration, Governance, Trust & Transparency, AI Report.

### 4.1 Dashboard (Overview)
- Add an **anomaly feed panel** near the existing KPI tiles — only populated from the streaming Detect path, so it stays genuinely real-time.
- Attach the **trust badge** to each of the four top KPI tiles (Total Events, Active Features, Avg Response Time, Error Rate) — if the trust gate has quarantined the metric behind a tile, the tile must visually say so instead of showing a possibly-fake number.
- "AI Insights" panel at the bottom of this page currently pulls from Ollama free text — repoint it at the new structured narrative endpoint (see 4.10) and add the "why this number" popover.

### 4.2 Feature Analytics
- Keep the trend chart and top-features leaderboard, but:
  - Any spike/dip the Detect stage fired on should be annotated directly on the trend chart (marker + hover for anomaly detail).
  - Clicking an annotated point opens the **root-cause breakdown** (dimension table) sourced from `root_causes` — this replaces the manual "eyeball the two lines" comparison currently offered.

### 4.3 Funnel Analysis
- Stage drop-offs currently shown as static percentages — recompute from fundamentals (numerator/denominator) at read time per the ratio rule, not from a stored percentage.
- "Leakage Matrix" severity tags (Critical/High) should be cross-checked against the Trust Gate — a critical-looking drop that's actually a data defect (e.g., a broken event) must not be labeled "Critical" business leakage; it should show the quarantine badge instead.
- Add root-cause drill-down on any funnel stage, same component as 4.2.

### 4.4 User Journey
- Largely unchanged structurally, but timelines should surface a trust badge on any event whose metric is currently quarantined, so an analyst debugging a user doesn't get misled by known-bad data.

### 4.5 License vs Usage
- Low-risk page; mainly needs the trust badge wired in for consistency. No new pipeline stage directly targets license data.

### 4.6 Predictive Insights → becomes the **Forecast** page
This page changes the most among the "existing" pages. Current "Opportunity Radar" / "Model Pulse" cards were heuristic; they should be replaced or backed by real output:
- Forecast chart per metric: point forecast + shaded prediction interval (uses primitive #2), horizon selector.
- Show backtest score (MASE/CRPS vs. seasonal-naive) next to each series so users can see forecast credibility, and a visible flag when a series fell back to the classical model instead of the foundation model.
- "At Risk" / "Growing" tags should be derived from the forecast + detect stages jointly, not a standalone heuristic score.

### 4.7 New page: **Root Cause / Diagnostics** (optional standalone, or keep as drill-down modals only)
If the team wants a dedicated page rather than only drill-downs from 4.2/4.3: a searchable list of anomalies with their ranked causes, filterable by tenant/date/severity. Recommend starting with drill-down modals (cheaper) and promoting to a full page only if usage demands it.

### 4.8 New page: **Causal Impact**
For campaign/feature-launch style questions ("did the festival sale actually cause the lift"):
- Intervention picker (date range + affected segment).
- Observed vs. synthetic-control counterfactual chart, with the credible interval on the estimated lift.
- Explicit "ladder" label showing whether the system is only reporting association/attribution vs. a fully corroborated causal estimate — don't let the UI imply causation when the backend only cleared the attribution rung.

### 4.9 New: **Recommendations** panel (could live inside Dashboard or its own nav item)
- List of proposed actions ranked by uplift-per-cost, each with the Approve/Reject action row (primitive #5).
- Approved actions should show up in Governance's audit trail (this is a natural fit, not a duplicate feature).
- Must clearly separate "business recommendation" vs. "engineering recommendation" (e.g., a currency-bug incident should propose a rollback/reprocess action, not a marketing action) — surface the recommendation's category as a visible chip.

### 4.10 AI Report → **Narrate & Verify**
Biggest behavioral change on the page:
- Replace the single Ollama free-text call with the structured/verified narrative endpoint.
- Every quantitative figure in the generated report must be clickable via the "why this number" popover (primitive #6), tracing to the exact signal-store row.
- If verification fails twice, the UI must show the deterministic template-filled fallback (plain but correct) rather than hide the failure — add a small "degraded mode" indicator so users know when they're seeing the fallback path.
- If the underlying metric is quarantined by the Trust Gate, this page must show an **incident note**, not a business narrative (this is explicit in the new spec — a currency-bug scenario should produce "revenue spike is not real, metric quarantined," never a fake growth story).

### 4.11 Trust & Transparency
- This page's purpose expands from "who can see what data" to also becoming the home of the **Trust Gate** itself:
  - List of currently quarantined metrics, the failing check (schema/distribution/invariant/corroboration/coincident-change), and time since quarantine.
  - History of past verdicts (pass/flag/halt) per metric, for audit purposes.
- Keep the existing on-prem/cloud data-access matrix as-is; add the trust verdict history as a new section/tab rather than replacing anything.

### 4.12 Governance
- Extend the existing toggle/audit-log view to also capture recommendation approvals/rejections (from 4.9) in the same audit trail, since both are "auditable operational changes" per the existing design language.

### 4.13 New page: **Model Observability** (could nest under Configuration)
Needed to support the Observe/close-the-loop stage:
- Per-stage health: detection false-positive rate, localization hit-rate@k, forecast MASE, recommendation uplift vs. regret — each against its pass bar.
- Rollout-ladder indicator per capability: shadow → assist → approve → autonomous, so stakeholders can see which stages are still human-gated vs. trusted to act.
- Calibration chart (stated confidence vs. observed accuracy) if the team wants to go this deep initially; can be phase-2.
- Model run trace list (from `model_runs`) for debugging/audit.

### 4.14 Tenants / Multi-Tenant Comparison
- No structural change required beyond making sure every new panel above (anomalies, forecasts, recommendations, trust verdicts) is filterable by the existing tenant selector (Both Banks / NexaBank / SafexBank), consistent with today's pattern.

---

## 5. Rollout strategy (recommend mirroring the new architecture's own philosophy)

The new architecture itself prescribes a ladder — shadow (log only) → assist (suggest) → approve (human signs) → narrow autonomy — and the same discipline should apply to shipping the dashboard changes, not just the ML stages:

1. **Phase 1 — Foundation & Trust, invisible-first.** Ship the schema changes (Section 1) and backend endpoints (Section 2) with the Trust Gate running in shadow mode: compute verdicts, store them, but don't change any existing chart's behavior yet. Validates the pipeline without risking a false quarantine hiding real data from users.
2. **Phase 2 — Surface trust + detect.** Turn on the trust badge (primitive #1) across Dashboard/Feature Analytics/Funnel Analysis, and the anomaly feed. This is the highest-value, lowest-risk visible change.
3. **Phase 3 — Forecast + Localize.** Rebuild Predictive Insights on real forecast data; add root-cause drill-downs.
4. **Phase 4 — Causal + Decide.** Add the Causal Impact page and Recommendations panel, in "assist" mode only (nothing auto-executes; every action requires the Approve row).
5. **Phase 5 — Narrate cutover.** Swap Ollama for the verified narrative pipeline last, once stages 0–6 have real data behind them to ground the narrative in — doing this first would just make the LLM output prettier lies faster.
6. **Phase 6 — Observability.** Ship the Model Observability page once there's enough run history in `model_runs`/`outcomes` to make it non-empty.

---

## 6. Things the agent should explicitly check in the existing codebase before writing anything

- Grep for any place a **rate/percentage is stored** rather than computed (violates the ratio rule; will break Localize and Trust Gate reconciliation if not fixed).
- Grep for **exact-count logic on `events_raw`** that assumes exactly-once delivery — needs the `event_id` dedup fix.
- Confirm whether the current WebSocket broadcast is commit-triggered for *all* tables or just `events_raw`/`daily_feature_usage` — new tables (`anomalies`, `recommendations`, etc.) need to opt in individually per Section 2.1, not by default.
- Confirm the Ollama call site in the backend (likely near `ai_reports` writes) so it can be cleanly swapped for the vLLM/Qwen2.5 structured-output call in Phase 5, rather than ripped out ad hoc.
- Audit `config_audit_log` schema to confirm it can generically accept a new "action type" (recommendation approval) without a breaking migration.

---

## 7. Open questions to resolve with the team before Phase 3+

- Where does inference actually run — is there GPU capacity for the forecast/narrate stages, or should Phase 3–5 start with the CPU-only classical fallback (StatsForecast) and templated narration first, upgrading to the foundation models later?
- Who has approval rights on the Recommendations panel — same RBAC roles as today's Governance toggles, or a new role?
- Should Root Cause get a dedicated page (Section 4.7) or stay as drill-down modals — depends on how often analysts need to browse causes vs. jump to them from an alert.
