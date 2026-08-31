# The intended solution

Plain English. No code, no table names. What the product does, why it is shaped this way, and
what it refuses to do.

## The problem

Every bank already has dashboards. What it does not have is an answer.

A dashboard shows that KYC completions fell 18% last week. Someone then spends a day on it:
establishing whether the drop is real or a data glitch, which customer segment it came from,
whether it will continue, whether a campaign caused it, and what to do. Roughly the last five
minutes of that day produce the summary the business actually reads. That ratio is inverted from
where the value is.

Worse is the confidently wrong answer. A duplicated batch of records produces a large,
statistically real-looking spike. Charts render it. Alerts fire. A meeting is held. The movement
never happened. The cost is not the wasted analysis — it is the decision taken on the back of it.

## What we build

A KPI intelligence-to-action engine. It watches banking activity, notices when an important
number moves in a way that matters, checks the data is real, works out which part of the business
caused the move, says how confident it is, explains it in plain language for the person asking,
and recommends a concrete action with a named owner.

The data comes from our own banking app, NexaBank. The engine is FinInsights.

## The golden rule

**The language model is never the source of a number.**

All analysis is done by deterministic tools — SQL, statistics, simple rules, light ML. A small
local model does exactly two things: it reads the question and plans the investigation, and it
turns the finished, verified results into a sentence. Every number shown to a user traces back to
a value a tool computed and stored. If a number cannot be traced, it is not shown.

Two consequences follow, and both are load-bearing:

- Turning the model off changes no number. The findings are still produced; they are simply
  expressed in a fixed format instead of prose. The business is never dependent on a provider
  staying available or behaving consistently.
- The model may choose the path. It may not choose the numbers.

## The five KPIs, as one connected chain

We build one chain, not twenty independent metrics.

1. **New account signups** — a daily count. Top of the funnel.
2. **KYC completion rate** — a rate through a funnel: completed divided by started.
3. **Loan approval volume** — a daily count, from the daily banking snapshot.
4. **Revenue** — money per day: fees, interchange, interest.
5. **Transaction failure rate** — a rate. The health signal that can drag any of the others down.

Fewer signups or lower KYC completion lead to fewer approvals, which lead to lower revenue. So
"why did revenue drop?" is answered by walking the chain rather than by a separate revenue model.
When several metrics move at once, the engine reports **one story with a driver chain**, not five
alerts a human has to recognise as the same incident.

How a KPI is explained depends on its **shape**, not on a fixed formula. This is a bank, not a
shop, so there is no price-volume-mix decomposition anywhere:

- A **rate** through a funnel is explained by which stage leaked and which segment drove it —
  always computed on the underlying counts, never on the rate itself.
- A **count** is explained by segment and by time.
- **Money** is explained by which fee line moved, and which upstream volume driver in the chain
  caused it.

## Two sources, two cadences

- **Real-time clickstream.** User events, per-event grain, streamed through Kafka. Drives signups,
  KYC completion, transaction failures.
- **Daily banking snapshot.** Loan, account and ledger state, extracted once a day from the
  NexaBank database, daily grain. Drives loan approval volume and revenue.

The two cadences are the point, not an accident. When a KPI combines a real-time number and a
daily number, we compute against the oldest common data time. If the two are too far apart, we say
so, or we abstain.

## Three personas, one truth

Personas are lenses on the same five KPIs, not separate products. The same signal cards are built
once, then filtered and reframed.

| Persona | Cares about | Sees |
|---|---|---|
| **CFO / Executive** | Revenue, approval volume | The money numbers. Short, outcome-first narrative. |
| **Ops / Onboarding Manager** | Signups, KYC completion, where the funnel leaks | Operational detail — which step, which device, which vendor. **No revenue.** |
| **Risk / Fraud Analyst** | Transaction failures, unauthorized access | Urgent-flag-and-isolate behaviour, risk-owner actions. |

Entitlement is enforced **before assembly, not after**. A restricted figure is absent from a
restricted reader report rather than removed from it — and if it could be back-computed from a
ratio, that ratio is suppressed too. The personas never disagree on a shared number; what changes
is emphasis, depth, and the levers offered.

## Refusal is a feature

The single most commercially important property, and a deliberate design choice rather than a
limitation.

- If the data is **corrupted**, the metric is quarantined and an engineering note is issued
  instead of a business narrative. The movement is never dressed up as growth.
- If the evidence is **genuinely ambiguous**, the engine says so, states what is missing, and
  names the single cheapest check that would settle it.
- If a metric is **too new to have a history**, it reports a wide, clearly caveated range rather
  than a confident forecast built on nothing.

An analytics system that occasionally invents a plausible cause is worse than no system, because
nobody can tell which answers to discount. Refusal is what makes the rest of the output bankable.

## Anomalies must be real

The NexaBank Simulate console plants scenarios. The rule that makes this honest: **an anomaly must
exist in the source data first.**

If a scenario says "loan demand spikes", NexaBank actually creates more loan applications, on
chosen days, for chosen users, with the matching clickstream. The engine must then discover the
spike from the data like any other movement. We never paint an anomaly onto a chart, and the
engine is never told where to look.

Every planted scenario writes its own ground truth to a fixture file, so we can afterwards check
whether the engine found what was actually planted — and, just as importantly, whether it found
things that were not.

## What every insight carries

- **Evidence card** — source freshness, the method used, each driver contribution, a confidence
  value, and lineage: which events, which tables, which contract.
- **Engine breakdown** — which parts were done by SQL, statistics, rules, ML or the LLM, and which
  numbers came from where. Read from stored records, never asserted by the model.
- **Telemetry** — latency, model calls, tokens, and estimated cost for that insight.

## The four demo scenarios

All four run from one seeded NexaBank run.

1. **Multi-factor movement.** Revenue drops. The agent walks the chain and shows it was driven by
   a KYC completion leak in one segment plus a transaction-failure rise, with contributions.
2. **Low confidence.** A spike the Trust Gate suspects is a data glitch, but the calendar shows a
   real campaign. The engine abstains, says what is known and what is missing, and names the one
   cheapest check.
3. **Sparse history.** A newly launched product with a few days of data returns a wide, caveated
   range — not a false anomaly.
4. **Role entitlement.** The same KYC insight shows revenue at risk to the CFO and not to Ops,
   where it also cannot be back-computed. An unauthorized-access burst is flagged urgent and
   isolated.

## Definition of done

- All four scenarios run end to end from one seeded run and show on the dashboard.
- Five connected KPIs work across the two sources at their two cadences.
- Every KPI has a contract, and the narrator uses only contract definitions.
- Every number in every narrative traces to a stored signal — the verifier passes fully.
- The Ops persona never shows revenue, and it cannot be back-computed.
- The Decide tool outputs its full seven-field recommendation for the multi-factor scenario.
- Every insight shows the evidence card, the engine breakdown and the telemetry.
- On the planted ground truth, Localize names the planted segment first.

If time runs short, the safe cut is three KPIs (KYC completion, loan approval volume, revenue) and
two personas. That still satisfies every minimum expectation.
