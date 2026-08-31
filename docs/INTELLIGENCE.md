# The intelligence layer

An agent with tools. A user asks a question in plain language, or a persona has a standing
question. The agent reads the intent, decides which KPIs and which tools to run and in what order,
runs them, collects verified findings into the Signal Store, then narrates.

## The division of labour

| Does | Who | Never does |
|---|---|---|
| Reads intent, plans the investigation, decides when to stop | the model | produces a number |
| Computes every figure | the tools | decides what to investigate |
| Checks every figure in the text traces to a stored row | the verifier | rewrites a figure |
| Phrases the finished result | the model | introduces a figure the verifier did not clear |

The model may choose the path. It may not choose the numbers. This is the one property the whole
product rests on, and it is enforced mechanically rather than by prompt.

## The loop

```
  question + persona
        │
        ▼
   comprehend        what is being asked, about which metrics, over what window
        │
        ▼
   ┌─ plan ──────────► which capabilities to call next, and with what arguments
   │    │
   │    ▼
   │  execute         tools run, in parallel where independent
   │    │
   │    ▼
   │  observe         results recorded as observations, each tagged with its engine
   │    │
   │    ▼
   │  validate ───────► is this enough to answer? did anything contradict?
   │    │
   └────┘  not yet, and rounds remain
        │  enough, or the round budget is spent
        ▼
   synthesize        claims assembled, entitlement applied, verifier run
        │
        ▼
   narrate           prose from cleared claims only, or a fixed-format fallback
```

Where the flexibility stops:

- A call to an unknown tool, a tool this persona may not use, or an argument the schema does not
  name is refused before execution. A bad plan fails closed.
- The loop is bounded. It stops on the validator verdict or on the round budget, and escalates
  rather than guessing when nothing came back.
- Every run records a trace: each step names the tool it called, what it passed, and how long it
  took. The trace is the product, not decoration — it is how a reader checks that an answer came
  from a stored row rather than from prose.

**Adding a capability is adding one tool specification.** The planner reads the catalogue at
runtime, so a new tool becomes available without touching the orchestration layer.

## The six tools

All deterministic. All report how much data they had and how confident they are. All read through
the Metric API, never raw SQL against raw tables. All write to the Signal Store.

### 1. Trust Gate — *is this a real change, or bad data?*

**Method:** rules plus SQL.

Checks ranges, freshness, duplicates, and simple invariants — completed cannot exceed started.
Nothing is narrated as a business story until this passes.

- A **hard** invariant breach quarantines the metric and routes an engineering note. No business
  narrative is produced at all.
- A **soft** invariant breach is an abstention, not a quarantine. `completed <= started` can break
  legitimately across sessions.
- A metric whose contract declares it is not instrumented fails here explicitly. It must never
  fall through to reading zero and narrating a phantom decline.
- **A pass is written down too.** The suppression rate is audited.

Freshness reconciles the two cadences: a KPI combining a real-time number and a daily number is
computed against the oldest common data time, and too large a gap is itself a finding.

### 2. Detect — *is this real signal, or noise?*

**Method:** statistics — robust baselines, change-point detection, false discovery control.

Fires only on a move that is **unlikely**, **material**, and **persistent** across several
windows. Any one of the three alone produces alert fatigue.

Detect scores an **additive fundamental**, never a rate. This matters more than it sounds: a rate
metric whose stored observation is a count has been narrated as though the count were the rate —
"rose 79.6% to 97.00" when the actual rate was 1.000 on every day of the window. The verifier
cannot catch this, because it checks that a number came from a row, not that the row is the
quantity the sentence names. Units travel with the figure.

### 3. Localize — *where did it come from?*

**Method:** statistics plus SQL.

Searches the segment cube and returns the stages and segments that explain the move.

- Always on **additive counts**, never on a rate and never on a distinct-user count. Neither is
  additive across dimensions, so a contribution over them is arithmetically meaningless.
- Only over dimensions the data model declares **measured**. A fabricated dimension is refused,
  with the reason stated, rather than returned with a confident contribution share.
- Returns contributions with the share of the move they explain, and says explicitly how much is
  left unexplained.

### 4. Forecast — *where is it heading?*

**Method:** classical baseline, with an optional small time-series model.

A series with little history returns a **wide, clearly caveated range**, never a confident point.
The sparse-history case is a first-class output, not a degraded one.

### 5. Materiality — *does this matter enough to surface?*

**Method:** rules plus statistics.

Ranks by statistical strength × business impact × persistence, where business impact comes from
the strategic weight declared in the contract. This is what collapses several simultaneous
movements into one story with a driver chain rather than five separate alerts.

### 6. Decide — *what should we do about it?*

**Method:** rules plus a lever library in `contracts/levers.yaml`.

This is the to-action half of the brief. For a verified driver it produces seven fields:

| Field | Example |
|---|---|
| driver | the verified cause, as Localize named it |
| controllable lever | the thing the business can actually change |
| action | the concrete step |
| expected impact | a **range**, never a point |
| owner role | who owns it, by role |
| confidence | how sure, and on what basis |
| monitoring plan | what to watch, at what threshold, for how long |

No bandits, no uplift modelling. A closed list of permitted actions per metric, declared in the
contract, so a recommendation can never be invented.

## Behaviour by data volume

The same tool must be correct on a three-day-old metric and on a year of a large tenant. The rule
is that the **method** changes and the **honesty** does not.

| Regime | What changes | What is reported |
|---|---|---|
| **Sparse** — fewer days than the baseline needs | Robust baseline degrades to a widened interval. Detect does not fire. Localize needs a minimum cell count or it abstains per dimension. | A wide range, an explicit "too new to judge", and the number of days available. |
| **Normal** | Full method. Exact aggregations throughout. | The finding, with its confidence. |
| **Large** | Aggregation moves to the Gold rollup rather than Silver. The segment cube is pruned by materiality before the search, not after. Exactness is preserved for anything that reaches a claim. | The finding, plus how much of the cube was searched. |

Two things never vary with volume: an approximate aggregation is never used for a number that
reaches a reader, and a pruned search says it pruned. A confident answer over a truncated cube is
the same failure as a confident answer over dice rolls.

## The narrator and the verifier

The narrator writes the explanation **from the stored findings only**, per persona. Raw query
output is never passed into its context.

The verifier then checks every number in the text against the claim set. If a number does not
trace, the narrative is regenerated once, then falls back to a plain deterministic template. It
never ships an unverified number.

Phrasing is centralised, because the unit a figure was measured in must travel with it into every
sentence. A modelled figure carries its qualifier every time it is stated.

## Personas and entitlement

Three personas — CFO, Operations Manager, Analyst — declared in one place: their intents, their
recommendation owner roles, and their metric priorities.

- A persona is resolved **server-side**. A requested persona is honoured only if the caller role
  allows it, so a request can never widen access.
- Entitlement is applied **before any claim is built**. A forbidden number is never phrased and
  then redacted; it is never assembled.
- If a restricted figure could be back-computed from a ratio, that ratio is suppressed too.
- Where a movement has an action owned by another department, that is stated rather than hidden.

## Engine tagging

Every produced number carries the engine that produced it — `sql`, `stats`, `rules`, `ml` or
`llm`. The LLM-versus-non-LLM breakdown shown on each insight is read back from these records. It
is a fact about what ran, never a claim the model makes about itself.

## The feedback loop

One click on each insight: was the root cause correct, was this a known event such as a holiday,
was the action taken. No model retraining. The response writes a structured row that does exactly
three things:

1. adds a suppression or known-event rule that Detect reads,
2. adjusts a method-reliability weight used when ranking causes,
3. or corrects a definition in a KPI contract.

## KPI contracts

One YAML per KPI in `contracts/`, plus `levers.yaml`. A contract declares the definition, the
grain, the additive fundamentals, which dimensions may be localized, the reliability checks, the
strategic weight, the access rules, and the closed list of actions Decide may recommend.

The narrator uses contract definitions and nothing else. Metric meaning is configuration, not
code — which is what makes onboarding a second institution a configuration task.

Contracts name **physical column and metadata keys**. There is deliberately no renaming layer, so
a contract that names a key which does not exist reads empty rather than failing, and that is why
a contract is validated against the live schema rather than trusted.
