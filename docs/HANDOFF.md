# HANDOFF — intelligence layer, in-flight work

**Written 2026-08-29.** This is a session handoff, not a standing document. `CLAUDE.md` holds the
rules, `docs/TASK.md` holds the numbered work, `docs/PROPOSAL.md` holds the argument. This file
holds only what a fresh agent cannot recover from those three: where the current thread stopped,
what was decided in conversation, and which traps cost time to find.

**Delete it when the sequence in §2 is finished.** A stale handoff is worse than none.

---

## 1. Verified state

Last full run, 2026-08-29, all green:

```bash
docker compose --profile test run --rm tests                     # 460 passed, 12 skipped
docker compose exec analytics-dashboard npx tsc --noEmit         # clean
cd e2e && DASHBOARD_URL=http://localhost:3001 \
  node node_modules/playwright/cli.js test tests/dashboard.agent.spec.ts   # 12 passed
```

The agent is an orchestrator, not a workflow: `planner.py` reads the tool catalogue and decides
what to call; `loop.py` executes, validates and re-plans within a persona-bounded round count;
`tools.py` holds 14 capabilities. Adding a capability is adding one `ToolSpec` — the planner finds
it. `docs/PIPELINE_CONTRACT.md` §8b is the contract for that; §8a is the Tier 0/Tier 1 boundary;
§8c is the phrasing layer added last.

### Phases already completed in this thread

| Phase | What landed |
|---|---|
| 1 | `matching.py` — typo/prefix-tolerant intent matching, plus `MIN_SELECT_SCORE` so one incidental description word cannot select a tool |
| 5a | `get_causes` retargeted from a dead `where` intent to `cause`; `personas.detail` (summary/standard/full) added so depth is presentation, never entitlement |
| 5b | Tier 0 vs Tier 1 made a property the contract carries (`Contract.governed`, `Contract.owner`); `reader._governed_ids()` raises rather than degrading |
| — | Three UI bugs: duplicate React key, `getLocations`/`getAuditLogs` firing for roles guaranteed to 403, and a policy refusal logged as a transport fault. Dismiss button on the answer card |
| — | Phrasing layer (§4 below) |

---

## 2. The sequence to continue

This order was set by the user in review and should be kept.

### 2.1 `default_window` as a *contextual read* — next up

A persona has a natural reporting window (a CFO thinks quarter-to-date; an ops manager thinks this
week). The investigation does not move.

Constraints, quoted from the user:

> Don't investigate per-window. That multiplies investigation count by persona count… Re-read
> through the metric layer, but only for the framing figure. The investigation stays canonical at
> its own window; the persona window becomes a **contextual read** — one additional metric-layer
> query producing a single number… which frames the investigation rather than replacing it.

> The framing claim needs an explicit window label in its own text — "Quarter to date, fee revenue
> is down 4.2%" rather than "Fee revenue is down 4.2%".

> Cache key should probably include the as-of date… quarter-to-date changes every day.

So: one extra metric-layer query, one extra claim, a window label in the claim's own prose, and a
cache key carrying the as-of date plus its own freshness stamp. `phrasing.window_phrase` already
produces the label; reuse it rather than writing a second date formatter.

### 2.2 Out-of-scope residual disclosure — with the back-computability test written *alongside*

When a persona's ranking omits governed KPIs they may not see, the omission must be disclosed as a
residual rather than silently dropped. The hard part is that disclosure must not let a reader
reconstruct the withheld figures.

The user was explicit that the test is written **with** the feature, not after it: assert
non-derivability per persona for the three governed KPIs an ops manager cannot see
(`cost_per_acquisition`, `fee_revenue`, `pro_revenue`) against the seven they can. Two disclosed
residuals plus a disclosed total is a solvable system; that is the failure to test for.

### 2.3 Abstention wording per persona — last, explicitly

Polish. The user placed it last on purpose. **Abstention itself stays persona-invariant** — only
the wording varies. If a change makes one persona abstain where another answers, that is a bug in
2.3, not a feature.

### 2.4 Proactive alerting restricted to Tier 1

Documented in `docs/PIPELINE_CONTRACT.md` §8a; the scheduler path is **not wired to it**. A Tier 0
auto-discovered series is answerable on request but must never be proactively surfaced — it has no
owner, no levers and no contract.

---

## 3. Opened by the last session, deliberately not fixed

### A8 — a ratio KPI is scored on its numerator (P0). Read `docs/FinInsights_Bug_Audit.md` §A8.

*(Renumbered from A4; Section A already had one.)*

`orchestrator.py` hands Detect `contract.scored_fundamental` — the numerator, because a rate is
non-additive and cannot be scored on itself. Nothing recorded that substitution, so the agent
published *"Digital Adoption Rate rose 79.6% … moved to 97.00 against an expected 54.00"*. Those
are **daily counts of digital transactions**. The real rate was `1.000` on all 14 days of the
window — every row in `fact_transactions` is already WEB or MOBILE, so adoption never moved.

Every figure traced to a stored row and the numeric verifier passed it. The verifier checks that a
number came from a row, not that the row is the quantity the sentence names.

The phrasing layer now *states* the substitution in every answer, at every persona depth. That
makes the answer honest; it does not make the KPI measured. **Still to decide** (A8 lists both):
compute the ratio as a derived series and score that (recommended — it is what the contract's
`formula` already declares, and `kyc_completion_rate` / `loan_approval_rate` are scored the same
wrong way), or rename the contract to what is actually scored.

### A9 — `Contract.is_ratio` does not recognise this contract as a ratio (P1)

`is_ratio` and `numerator()` require fundamentals carrying `event`/`events` keys.
`digital_adoption_rate` declares its fundamentals against `fact_transactions` with
`table`/`measure`/`filter`, so `is_ratio` is `False` for a KPI whose `unit` is literally `ratio`.
Nothing breaks today only because `scored_fundamental` falls through to `fundamentals[0]`, which
happens to be the numerator. A contract listing its denominator first would be scored on the
denominator with no error anywhere.

### `new_account_openings` has a forecast band of 0

Which produced "rose 19600.0%" — epsilon-guarded division, not a measurement. The prose no longer
quotes a percentage against a zero baseline, but **the zero band itself is not investigated**.
Check whether Forecast had history to work with before trusting anything about that KPI.

---

## 4. The phrasing layer (`api/intelligence/phrasing.py`)

New, small, and it computes nothing. It receives values a stage produced and a claim records, and
decides how they are said — in one place, because a cell shown as `txn_type=PAYMENT` on the
evidence card and "payment transactions" in the prose is one row described twice.

Three invariants it holds, each of which the previous flat rendering broke:

1. **A figure is stated in the unit it was measured in**, including the fundamental substitution
   above. Persona depth changes the length of that sentence, never whether it appears.
2. **Nested localisation cells are disclosed as nested.** A greedy cube emits `{txn_type=PAYMENT}`
   and `{region=Northeast, txn_type=PAYMENT}` as separate ranks; cumulative `explained_pct` reached
   **2.07** on live data. `overlap_note` detects containment structurally rather than trusting that
   number.
3. **No percentage against an expected zero.**

`Contract.scored_fundamental` is the single field the orchestrator *and* phrasing read, so they
cannot drift apart again — that drift is what produced the bad sentence.

**One trap.** `overlap_note` carries no numeral on purpose. The first draft said "they do not add
to 100%" and the numeric verifier failed the entire answer closed, correctly: `100` traced to no
stored row. `tests/test_agent_phrasing.py` asserts that sentence stays numeral-free. If you add
prose anywhere in this layer, any digit in it must come from a claim or from a `facts` entry.

---

## 5. Environment traps — these cost real time

- **Playwright.** `npx playwright` is not on PATH and the config defaults to compose hostnames.
  From the host: `cd e2e && DASHBOARD_URL=http://localhost:3001 NEXABANK_URL=http://localhost:3002
  node node_modules/playwright/cli.js test tests/<spec>`. If the browser is missing,
  `node node_modules/playwright/cli.js install chromium`.
- **The dashboard can serve a stale compile.** Turbopack's file watcher does not reliably see
  writes through a Windows bind mount. An edit to `analytics-dashboard/src` may silently not take
  effect — `docker compose restart analytics-dashboard`. Do not judge a frontend change visually
  without ruling this out; it has masked correct work more than once.
- **Python services bake their source.** `docker compose up -d --build analytics-api` after *any*
  Python edit. `--reload` in the compose command is watching files that never change.
- **Heredocs break on apostrophes** in this shell (`cat > f <<'EOF'`, `python - <<'PY'` with a
  `'` inside). Use the Write tool, or write a script into the scratchpad and run it.
- **A React duplicate key cannot be tested by counting.** React renders both children and only
  logs. Assert on the console error. A test that counted cards passed before *and* after the fix.
- `query_id` is `derive_id(tenant, persona, question)` — deterministic **by design**, so it repeats
  for a repeated question. It is not a React key. The panel mints `entryId` client-side.

---

## 6. Standing constraints stated in conversation

These are the user's, and are not all in `CLAUDE.md`:

- **No Redis, CDN, S3, GraphQL, OpenTelemetry or Datadog** in this stack — "but our codebase
  should be perfect".
- Comments 1–2 lines, no unnecessary comments. Reasoning goes in `docs/`, not inline.
- Work **phase by phase**, and test after each phase. Test smartly — spend few tokens.
- Do not touch anything outside this project.
- Reliability comes from **architecture and validation**, never from assuming the model is right.
  A scoping or infrastructure failure must never render as an analytical result — this is why the
  ranking says "Among governed metrics:", why an ungoverned KPI says it has no owner, and why
  `RegistryUnavailable` exists rather than a silent empty list.

---

## 7. Longer-standing open items (not this thread's sequence)

- **P1-6** in `docs/TASK.md` — `event_id` mandatory at every writer; `api/seed_safexbank.py` still
  writes directly without one, which keeps the legacy `concat('legacy:', …)` dedup key load-bearing.
- **P2-1 / P2-4 / P2-5** — JWT verification, WebSocket auth, `tenant_licenses` as the single
  entitlement source. Entitlement inside the layer has no leaks, but the identity it resolves from
  is still caller-asserted.
- **Rotate the leaked Supabase credential** in `scripts/nexbank_user_lookup.py`. Still in git
  history. Flag only — it is Phase 2, not Phase 1 work.
- `docs/FinInsights_Bug_Audit.md` — its header now carries a verified fixed/open split as of
  2026-08-29, plus a new **Section L** for defects in the intelligence layer itself (unentitled
  persona gets no insight row; propagation's suppression half unbuilt; truncated Localize invisible
  at rest; Tier 0 discovery failure swallowed; Detect ignores provisional windows). Still open from
  the original sweep: the dashboard `Promise.all` over 17 endpoints, `PRECOMPUTED_LAYER` never
  populating, `flush_batch` blocking the Kafka poll loop, and the swallowed exceptions.
