# CLAUDE.md — FinInsights Working Prototype

This is the master document for the whole team and for Claude Code. Read it fully before writing
any code. It says what we are building for the Round 2 prototype, the rules that must always hold,
the exact KPIs and personas, the tech and how to use each piece, the folder structure, and how the
team splits the work to build in parallel.

Source of truth is the problem statement (BusinessIntelligence.ai, Round 2). Every choice here maps
to something the brief asks for. If a task does not map to the brief, we do not build it.

---

## 1. What we are building, in one paragraph

A KPI intelligence-to-action engine for a bank. It watches banking activity, notices when an
important number moves in a way that matters, checks the data is real and not a glitch, works out
which part of the business caused the move, says how confident it is, explains it in plain language
for the person asking, and recommends a concrete action with an owner. The data comes from our own
banking app, NexaBank. The engine is FinInsights.

## 2. The golden rule (this defines the product)

The large language model is never the source of a number. All the analysis is done by deterministic
tools (SQL, statistics, simple rules, light ML). A small local model does only two things: it reads
the user's question and plans the investigation, and it turns the finished, verified results into a
sentence. Every number shown to a user must trace back to a value a tool computed and stored. If a
number cannot be traced, it is not shown.

The brief explicitly asks us to show when we use SQL, rules, statistics, ML, causal inference,
retrieval, or the LLM, and why. We show this on every insight (see the "engine breakdown" below).

## 3. What the brief requires, and where we satisfy it

| Brief expectation | Where we satisfy it |
|---|---|
| 3 to 5 connected KPIs across 2 to 3 sources with different cadences | The KPI chain in section 5, over two sources in section 6 |
| A lightweight KPI / semantic contract | YAML contracts in `contracts/` (section 9) |
| At least two personas, different narratives or actions | Three personas in section 7 |
| One multi-factor KPI movement with known drivers | Revenue-drop scenario, section 10 |
| One low-confidence scenario, engine abstains | Abstain scenario, section 10 |
| One sparse-history / new KPI scenario | New-product scenario, section 10 |
| One role-based entitlement scenario | Ops persona cannot see revenue, section 10 |
| Evidence: freshness, method, contribution, confidence, lineage | Evidence card, section 8 |
| A clear LLM vs non-LLM breakdown | Engine breakdown, section 8 |
| Runtime telemetry: latency, model calls, tokens, cost | Telemetry, section 8 |

We hit every minimum expectation. We do not build beyond them.

## 4. The data source: NexaBank must generate real banking data

NexaBank is not just a click tracker. It generates the real activity of a bank: customers,
accounts, transactions, bill payments, loan applications and their KYC steps, cards, and premium
feature usage. It emits two kinds of data together: the business facts (a loan was applied for, a
payment succeeded or failed) and the behavioral telemetry (which screens, which device, which
region).

NexaBank also has a Simulate control panel. From one screen you choose a template (a spike, a
gradual drop, added noise, a burst of unauthorized access), set the parameters (which KPI, which
segment, how big, how many days), and it generates the users, days, and events that make that true.
Every planted scenario writes down its own ground truth to a fixture file, so we can later check
whether the engine found what was actually planted.

The rule that makes this honest: an anomaly must exist in the source data first. If a scenario says
"loan demand spikes," NexaBank actually creates more loan events. The engine must discover the spike
from the data. We never paint an anomaly onto a chart.

## 5. The KPIs to build (one connected chain, not twenty)

We build one connected chain of five KPIs. They are connected so a move in one explains a move in
another, which lets the agent answer many questions from one chain instead of us building a model
per KPI.

1. New account signups — a daily count. Top of the funnel.
2. KYC completion rate — a rate through a funnel (completed divided by started).
3. Loan approval volume — a daily count, from the daily banking snapshot.
4. Revenue — money per day (fees, interchange, interest).
5. Transaction failure rate — a rate. The health signal that can explain drops in the others.

Why these five: fewer signups or lower KYC completion lead to fewer approvals, which lead to lower
revenue. A failure or fraud spike can drag any of them down. So "why did revenue drop?" is answered
by walking the chain, not by a separate revenue model.

How each KPI is explained depends on its shape, not on a fixed formula. This is important and is why
we do NOT use a retail price-volume-mix method (this is a bank, not a shop):

- A rate through a funnel (KYC completion, transaction failure) is explained by which stage leaked
  and which segment drove it, always computed on the underlying counts, never on the rate itself.
- A count (signups, loan approvals) is explained by segment and time.
- Money (revenue) is explained by which fee line moved and which upstream volume driver in the chain
  caused it.

If time runs short, the safe cut is three KPIs (KYC completion, loan approval volume, revenue) and
two personas. That still satisfies every minimum expectation.

## 6. The two data sources (different cadences, as the brief requires)

- Real-time clickstream: user events, streamed through Kafka, per-event grain. Drives signups, KYC
  completion, transaction failures.
- Daily banking snapshot: loan, account, and ledger state, extracted once a day from NexaBank's
  Postgres, daily grain. Drives loan approval volume and revenue.

The two cadences are the point. The Trust Gate and the freshness rule must reconcile them: when a
KPI combines a real-time number and a daily number, we compute against the oldest common data time,
and if they are too far apart we say so or abstain.

## 7. The personas (same chain, different lens)

Personas are lenses on the same five KPIs, not separate products. Build the same signal cards once,
then filter and reframe per persona.

- CFO / Executive. Cares about revenue and approval volume. Sees the money numbers. Gets short,
  outcome-first narratives. Can see sensitive financial figures.
- Ops / Onboarding Manager. Cares about signups and KYC completion and where the funnel leaks. Gets
  operational detail (which step, which device, which vendor). Cannot see revenue or margin. This is
  our entitlement scenario: the revenue-at-risk number is structurally removed from this persona's
  card before the narrator ever sees it, and if it could be back-computed from a ratio, that ratio
  is suppressed too.
- Risk / Fraud Analyst. Cares about transaction failures and the unauthorized-access anomaly. Gets
  the urgent-flag-and-isolate behavior and risk-owner actions.

Two personas is the minimum; the third makes the entitlement and action stories cleaner. If time is
short, ship CFO and Ops.

## 8. What every insight carries

- Evidence card: source freshness, the method used, each driver's contribution, a confidence value,
  and lineage (which events, which tables, which contract).
- Engine breakdown: which parts were done by SQL, statistics, rules, ML, or the LLM, and which
  numbers came from where. This is read from stored records, not asserted by the model.
- Telemetry: latency, number of model calls, tokens, and estimated cost for that insight.

## 9. The intelligence layer (the heart)

This is an agent with tools. A user asks a question in plain language, or a persona has a standing
question. The agent reads the intent, decides which KPIs and which tools to run and in what order,
runs them, collects the verified findings into a Signal Store, then narrates.

The tools (all deterministic, all report how much data they had and how confident they are):

- Trust Gate. Is this a real change or bad data? Checks ranges, freshness, duplicates, and simple
  invariants (completed cannot exceed started). Nothing is narrated as a business story until this
  passes. Method: rules plus SQL.
- Detect. Is this real signal or noise? Fires only on moves that are unlikely, material, and
  persistent across several windows. Method: statistics (robust baselines, change-point, false
  discovery control).
- Localize. Where did it come from? Searches the segment cube and returns the stages and segments
  that explain the move, on the additive counts. Method: statistics (PSqueeze) plus SQL.
- Forecast. Where is it heading? For a series with little history it returns a wide, clearly
  caveated range, never a confident point. Method: classical baseline; a small time-series model is
  optional and added later.
- Materiality. Does this matter enough to surface? Ranks by statistical strength times business
  impact (using the contract's strategic weight) times persistence. Method: rules plus statistics.
- Decide (the Action tool). This is the "to-action" half of the brief and must be built. For a
  verified driver it produces the seven-field recommendation the brief asks for: driver, controllable
  lever, action, expected impact (as a range), owner role, confidence, and a monitoring plan (what
  to watch, threshold, for how long). Method: rules plus a small lever library in YAML. No bandits,
  no uplift modeling; that is over-engineering for a prototype.

Then the Narrator (the LLM) writes the explanation from the stored findings only, per persona. A
numeric verifier checks every number in the text traces to a stored signal; if not, it regenerates,
then falls back to a plain template. It never ships an unverified number.

Feedback loop (keep it concrete, no model retraining): a one-click response on each insight (was the
root cause correct, was this a known event like a holiday, was the action taken) writes a structured
row that does exactly three things: adds a suppression or known-event rule the Detect tool reads,
adjusts a method-reliability weight used when ranking causes, or corrects a definition in a KPI
contract.

## 10. The demo scenarios (all from one seeded NexaBank run)

1. Multi-factor movement: revenue drops; the agent walks the chain and shows it was driven by a KYC
   completion leak in one segment plus a transaction-failure rise, with contributions.
2. Low confidence: a spike where the Trust Gate suspects a data glitch but the calendar shows a real
   campaign; the engine abstains, says what is known and missing, and names the one cheapest check.
3. Sparse history: a newly launched feature with a few days of data returns a wide, caveated range,
   not a false anomaly.
4. Role entitlement: the same KYC insight shown to CFO includes revenue at risk; shown to Ops it does
   not, and cannot be back-computed; plus an unauthorized-access burst is flagged urgent and isolated.

## 11. Tech stack and how each piece is used

- NexaBank: TypeScript, Express, Prisma over Postgres. Generates banking data and telemetry, holds
  the Simulate panel and anomaly templates. Postgres is also the daily-snapshot source.
- Ingestion API: Python, FastAPI. Receives events, masks personal data, assigns a deterministic
  event id (so retries cannot double-count), validates the event shape.
- Kafka: the transport between ingestion and the warehouse. One topic, partitioned by tenant. It is
  transport only, never the system of record.
- ClickHouse: the analytics warehouse, organized in three layers (see section 12). Fast columnar
  storage for all reads.
- Metric API: Python, FastAPI. The only doorway into the warehouse. Named, tenant-scoped reads. No
  tool and no agent writes raw SQL against raw tables; they call the Metric API.
- Intelligence layer: Python. The agent, the tools, the Signal Store, the narrator and verifier.
- LLM serving: a small local model served on-prem. Target is vLLM serving a quantized
  Qwen2.5-Instruct model. If the current code uses Ollama with a small Llama model, that is fine to
  start; the requirement is small, local, and on-prem, not the specific server.
- Dashboard: Next.js. Shows the KPIs, the funnel, the AI insight with its evidence card, the engine
  breakdown, the telemetry, and the persona switch.

The point of the small local model is data sovereignty and low cost. Because the tools do the
analysis, a small model is enough to narrate, and it runs on our own hardware.

## 12. Strict project structure

One responsibility per folder. Markdown lives only in `docs/`. Nothing lives at the root except
config.

```
FinInsights/
  README.md
  docker-compose.yml
  docs/                      all documentation, nowhere else
    SOLUTION.md              the intended solution, plain English
    ARCHITECTURE.md          how the pieces fit and data flows
    DATA_MODEL.md            bronze / silver / gold explained
    INTELLIGENCE.md          the agent and each tool
  contracts/                 the KPI / semantic contracts (YAML), one per KPI
    signups.yaml
    kyc_completion_rate.yaml
    loan_approval_volume.yaml
    revenue.yaml
    transaction_failure_rate.yaml
    levers.yaml              the Decide tool's lever library
  nexabank/                  the data source
    src/
      domain/                customers, accounts, transactions, loans, cards
      events/                event tracking and the taxonomy, in one place
      simulate/              the simulate engine and anomaly templates
  ingestion/                 FastAPI service on 8000
  pipeline/                  kafka consumer and the bronze to silver to gold transforms
  warehouse/
    clickhouse/
      bronze/                raw table DDL
      silver/                cleaned table DDL and materialized views
      gold/                  KPI rollups and the signal store DDL
  api/                       FastAPI service on 8001 (the Metric API and endpoints)
    intelligence/            the agent, tools, narrator, signal store, personas
      orchestrator.py
      tools/                 trust_gate.py detect.py localize.py forecast.py materiality.py decide.py
      narrator.py
      verifier.py
      signal_store.py
      personas.py
  dashboard/                 Next.js app
```

The three warehouse layers:

- Bronze: raw events exactly as received. Never changed. The audit trail.
- Silver: cleaned. Names canonicalized, duplicates removed by event id, personal data masked,
  sessions rebuilt, one agreed day and timezone.
- Gold: ready-to-serve KPIs and rollups, plus the Signal Store where tools write findings.

The dashboard and the tools read only Silver and Gold, never raw Bronze.

## 13. How the team works in parallel

Agree these four interfaces first, then everyone can build at once without blocking:

- The event shape (what NexaBank sends to ingestion).
- The Metric API (the named reads the tools and dashboard call).
- The KPI contract format (the YAML in `contracts/`).
- The Signal Store tables (where tools write and the narrator reads).

With those fixed, the four tracks run in parallel:

- Track A, Data source. Owns `nexabank/`. Builds the banking domain data, the event tracking, the
  Simulate panel and anomaly templates, the ground-truth fixtures.
- Track B, Pipeline and warehouse. Owns `ingestion/`, `pipeline/`, `warehouse/`, and the Metric API
  in `api/`. Builds Bronze, Silver, Gold, the KPI rollups, and the contract loader.
- Track C, Intelligence. Owns `api/intelligence/` and `contracts/`. Builds the agent, the six tools,
  the Signal Store, the narrator and verifier, the personas, and the Decide tool.
- Track D, Dashboard. Owns `dashboard/`. Builds the KPI views, the AI insight panel, the evidence
  card, the engine breakdown, the telemetry, and the persona switch.

Track C can start against fake Signal Store rows while Track B fills real data. Track D can start
against a fixed sample insight. Nobody waits.

## 14. Rules

Always:

- Compute every number with a tool and store it. The narrator only phrases stored numbers.
- Read data only through the Metric API. Tools never write raw SQL against raw tables.
- Tag every number with the engine that produced it (SQL, stats, rules, ML, or LLM).
- Choose the decomposition by the KPI's shape (rate, count, or money), not a fixed formula.
- Abstain when the data is thin or the evidence conflicts. Say what is missing and the one check.
- Plant anomalies in the source data first; the engine must discover them.

Never:

- Never let the model invent, guess, or adjust a number.
- Never use a retail price-volume-mix method. This is a bank.
- Never build beyond the minimum expectations in section 3. No extra KPIs, no fourth persona, no
  third data source, no bandits or fine-tuning.
- Never read raw Bronze from the dashboard or the tools.
- Never commit secrets. Rotate any credentials already in the repo.

## 15. Definition of done for the prototype

- All four scenarios in section 10 run end to end from one seeded NexaBank run and show on the
  dashboard.
- Five (or the fallback three) connected KPIs work across the two sources at their two cadences.
- Every KPI has a contract; the narrator uses only contract definitions.
- Every number in every narrative traces to a stored signal (the verifier passes fully).
- The Ops persona never shows revenue, and it cannot be back-computed.
- The Decide tool outputs the full seven-field recommendation for the multi-factor scenario.
- Every insight shows the evidence card, the engine breakdown, and the telemetry.
- On the planted ground truth, Localize names the planted segment first.