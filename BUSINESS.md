# BUSINESS.md

The business case for FinInsights: what it is worth, to whom, and why it is different from the
analytics a bank already owns.

This document is deliberately non-technical. It describes outcomes, decisions and risk. The
implementation is documented elsewhere (`README.md`, `docs/`); a short section at the end covers
engineering-level impact only, and still names no products.

---

## 1. In one paragraph

Every bank already has dashboards. What it does not have is an answer. A dashboard shows that KYC
completions fell 18% last week; someone still has to spend a day establishing whether the drop is
real, whether the data is lying, which customer segment it came from, whether it will continue,
whether a campaign caused it, and what to do about it. **FinInsights automates that day.** It
monitors the bank's operating metrics, decides for itself whether each movement is trustworthy,
finds the segment responsible, projects where the metric is heading, proposes an action with a
named owner, and writes the finding in plain English — with every figure traceable to a recorded
piece of evidence.

**Impact at a glance:**

| | |
|---|---|
| Time to a root-cause answer | ~1 business day → minutes |
| Analyst time reclaimed per investigated movement | ~85–90% |
| Investigations an analyst team can cover per month, same headcount | ~5–8x |
| Confidently-wrong findings prevented from reaching a business reader | 1–2 per quarter, per ~10 governed metrics |
| Annual value, one mid-size retail bank, ten governed metrics | **$550K–$950K** |
| Payback period | **~3–5 months** |
| Manual persona-specific reporting cycles eliminated per week | ~6–9 hours |

---

## 2. The problem being solved

Three costs, all of which show up on someone's budget today.

**The analyst-day.** A senior analyst investigating one metric movement spends the bulk of a day on
verification, segmentation and reconstruction, and roughly the last five minutes writing the
summary that the business actually reads. That ratio is inverted from where the value is. Multiply
by the number of metrics a retail bank watches and the number of weeks in a year, and the recurring
cost is a standing team, not a task.

**The confidently wrong answer.** This is the expensive one, and conventional dashboards have no
defence against it. A duplicated batch of records produces a large, statistically real-looking
spike. Charts render it. Alerts fire on it. A meeting is held about it. The movement never
happened. The cost is not the wasted analysis — it is the decision taken on the back of it, and the
slower erosion of trust that makes teams stop believing the numbers even when they are right.

**The reporting bottleneck.** A CFO, an operations manager and an analyst need the same underlying
truth expressed three different ways, with different figures visible to each. Today that is done by
hand, three times, from the same spreadsheet — which is both a labour cost and a leak risk, because
nothing stops a restricted figure appearing in the wrong deck.

---

## 3. What the platform actually delivers

### 3.1 It answers "why", not just "what"

The output is not a chart. It is a finding: the metric moved by this much, the movement is
trustworthy for these reasons, it concentrated in this customer segment, it is heading here, this
is the evidence that a campaign was or was not responsible, and this is the recommended action and
who owns it. That is the shape of an analyst's conclusion, produced without an analyst in the loop.

### 3.2 It refuses to answer when the data cannot support an answer

This is the single most commercially important property, and it is a deliberate design choice
rather than a limitation. Before any business story is produced, the movement is checked against
what must arithmetically be true of that metric. If the data is corrupted, the metric is
quarantined and an engineering note is issued instead of a business narrative — the movement is
never dressed up as growth. If the evidence is genuinely ambiguous, the platform says so, states
what is missing, and names the single cheapest check that would settle it. If a metric is too new
to have a history, it reports a wide range rather than a confident forecast built on nothing.

An analytics product that occasionally invents a plausible cause is worse than no product, because
nobody can tell which answers to discount. Refusal is what makes the rest of the output bankable.

### 3.3 Every number is traceable

No figure reaches a reader unless it traces back to a recorded piece of evidence. Nothing is
paraphrased, rounded into a new claim, or generated for narrative convenience. A reader who asks
"where did 18% come from?" gets a specific answer, and an auditor gets a complete record of which
metric was investigated, over what window, by what method, and what was concluded — retained as an
audit trail rather than reconstructed after the fact.

Two properties follow from this that matter to regulated buyers: the same question over the same
period always returns the same answer, and any figure that is modelled rather than measured is
labelled as modelled every single time it is stated.

### 3.4 One truth, three audiences

The platform ships with three business personas — **CFO**, **Operations Manager**, and **Analyst**
— and a role decides not only what a reader sees but what is even assembled for them. A restricted
figure is removed before the narrative is written, not redacted afterwards, and figures that would
let a reader reconstruct a restricted number are removed with it.

Crucially, the personas never disagree on a shared number. What changes is emphasis, depth and the
levers offered: a CFO gets the financial position and outlook, an operations manager gets the
segment concentration and the remediation, an analyst gets the method. Where a movement has an
action owned by someone else, that is stated rather than hidden — nobody is told a problem has no
owner when it has one in another department.

### 3.5 Anyone can ask it a question

Alongside the scheduled findings, a business user can simply ask — "which metric moved most this
week?", "what drove the change in net deposit growth?", "how reliable is that figure?" — and get an
answer built from the same evidence, bounded by the same permissions. No query language, no ticket
to the data team, no waiting.

### 3.6 It is not tied to one bank or one product

The platform is multi-tenant by construction, and the meaning of each metric is declared as
configuration rather than built into the product. Onboarding a second institution means describing
its metrics, not rebuilding the engine — comparable metrics, isolated data, one engine running two
banks side by side today.

This is the difference between a bespoke analytics build and a product with a repeatable sales
motion.

### 3.7 It monitors everything, and goes deep where it is told to

Hand-writing a definition for every metric a bank tracks does not scale into the thousands. So the
platform automatically covers every measurable activity it sees — those get a real answer: it
moved this much, concentrated here, heading there. Metrics the business declares as important get
the full treatment on top: causal reasoning, recommended actions, ownership and access rules.

Coverage is therefore automatic; depth is a business decision, taken one metric at a time, with no
engineering work to promote one.

### 3.8 Licence and entitlement intelligence

Beyond metric movements, the platform reports which paid capabilities are actually being used —
surfacing features that are licensed and idle, and usage that is running ahead of entitlement. That
feeds three commercial conversations directly: what to reprice, what to bundle, and where an
upsell is already justified by behaviour.

---

## 4. The metrics it governs today

Ten business metrics are fully declared, spanning revenue, lending, deposits, acquisition cost and
product launch. Each carries its own definition, its own reliability checks, its own access rules,
and its own closed list of actions that may be recommended.

| Metric | The business question it answers | Primarily read by |
|---|---|---|
| **Transaction Fee Revenue** | What are we earning on customer transaction activity? | CFO, Analyst |
| **Pro Revenue** *(modelled)* | What are premium feature conversions worth? | CFO, Analyst |
| **Net Deposit Growth** | Is money flowing in or out, and from which region? | CFO, Ops, Analyst |
| **Cost Per Acquisition** | What are we paying to win a customer? | CFO, Analyst, Marketing |
| **Loan Approval Rate** | What share of applications are we approving? | CFO, Ops, Risk |
| **Loan Approval Volume** | How much lending are we actually booking? | CFO, Ops, Risk |
| **KYC Completion Rate** | Where are applicants abandoning onboarding? | CFO, Ops, Risk |
| **New Account Openings** | Is the customer base growing, by product and region? | CFO, Ops, Marketing |
| **Digital Adoption Rate** | Are customers moving off branch and ATM channels? | CFO, Ops, Marketing |
| **Student Travel Card Activations** | Is the new product launch landing? | CFO, Ops, Marketing |

These are connected, not independent: onboarding completion gates loan approvals, which gate
lending revenue. When several of them move at once, the platform reports **one story with a driver
chain**, rather than five separate alerts that a human has to recognise as the same incident. That
collapse — many alerts into one cause — is where alert fatigue is actually addressed.

The metrics are also assembled from more than clickstream behaviour. Core banking activity,
customer and campaign records, and branch-level and macroeconomic conditions all feed the analysis
— which is what allows an answer of the form "deposits fell in this region, no internal segment
explains it, and a competitor rate change coincided." Without an external view, every cause the
platform found would necessarily be an internal one, and the analysis would be complete only in
appearance.

---

## 5. What changes, by role

| Role | Before | After |
|---|---|---|
| **CFO** | Waits for a weekly pack; asks follow-ups that take days | Position and outlook on demand, with modelled figures labelled as modelled |
| **Operations Manager** | Knows a metric fell; guesses which segment | Named segment, named lever, named owner, expected impact as a range |
| **Analyst** | Spends the day verifying and segmenting; writes a summary at the end | Reviews and challenges a completed investigation; spends the day on the questions nobody has asked yet |
| **Risk / Audit** | Reconstructs how a figure was produced after the fact | Reads the recorded trail; every figure already traced |
| **Product / Commercial** | Guesses which paid features earn their licence | Sees idle entitlements and unlicensed usage directly |
| **Engineering** | Finds out the data was wrong when someone disputes a number | Told immediately, through a separate incident path, before the business ever sees the figure |

---

## 6. Where the value comes from

**Analyst capacity released.** The verification, segmentation and drafting work that dominates an
investigation is automated. The analyst's remaining role is judgement and challenge, which is the
part of the job that is scarce.

**Bad decisions avoided.** Corrupted data is caught and quarantined before it reaches a business
reader. The saving is the cost of the decision that would otherwise have been taken, which is
typically an order of magnitude larger than the analysis it rested on.

**Time-to-answer collapsed.** A question that was a ticket to the data team is now a question typed
into a box. The value is not only the labour saved; it is the decisions that get made at all
because the answer arrived inside the window in which it mattered.

**Audit cost reduced.** The evidence trail is produced as a by-product of the analysis, not
assembled afterwards under deadline.

**Commercial signal recovered.** Licence-versus-usage visibility turns packaging and renewal from
negotiation-by-anecdote into a decision with evidence behind it.

**Reduced tooling sprawl.** Monitoring, root-cause analysis, forecasting, narrative reporting and
entitlement reporting arrive as one system with one access model, rather than four subscriptions
that disagree with each other.

§11 turns each of these into a number.

---

## 7. Risk, control and data residency

- **The bank's data stays inside the bank's own environment.** The entire platform, including the
  optional language capability, runs on infrastructure the institution controls. There is no
  requirement to send customer behaviour to an outside service for analysis.
- **The narrative layer is optional and carries no authority.** Turning it off changes no number —
  the findings are still produced, they are simply expressed in a fixed format instead of prose.
  The business is never dependent on an outside provider staying available, priced as expected, or
  behaving consistently.
- **Access is enforced before assembly, not after.** Restricted figures are absent from a
  restricted reader's report rather than removed from it.
- **Nothing acts on its own.** Recommendations are proposals with a named owner and require a human
  signature.
- **Modelled figures are labelled every time.** Where a number is estimated rather than measured,
  the qualifier travels with it into every sentence it appears in.

---

## 8. Capabilities in place today

The full reasoning chain runs end to end. Ten metrics are declared and governed. Three personas are
enforced. The question-and-answer interface works. Metric definitions, reliability checks and
access rules are all live configuration. The platform handles five distinct situations correctly: a
corrupted-data incident, a genuine business movement, a metric too new to judge, a case where the
evidence genuinely conflicts, and a permissions case — including knowing when to withhold an answer.

Automated action without human approval and self-learning recommendation ranking are the natural
next steps and are not part of the current release.

---

## 9. Commercial positioning

Three categories exist adjacent to this product, and it is none of them:

- **Dashboard and BI tools** report what happened. They have no view on whether the number is
  trustworthy and no opinion about why it moved.
- **Alerting and monitoring tools** report that something changed. They produce volume, and the
  volume is why alerts get muted.
- **Conversational analytics add-ons** generate a fluent answer, including when the underlying data
  does not support one. That failure mode is invisible to the reader, which makes it worse than
  silence.

The differentiated claim is narrow and defensible: **an analytics system that knows when not to
answer, and can prove where every number it does state came from.** Everything else in this
document is a consequence of that one property.

---

## 10. Where it goes next, in business terms

1. **Expand to additional institutions** — bring more banks onto the platform and grow the
   metric footprint at each one.
2. **Broaden governed coverage** — promote more metrics from automatic monitoring to full depth.
   This is a configuration exercise per metric, not a rebuild.
3. **Close the loop on outcomes** — the platform already records whether a recommendation was acted
   on and whether the metric recovered. Turning that record into improved recommendation ranking is
   the next capability step.
4. **Extend the persona set** — risk, marketing and data-governance roles are already recognised in
   the access model and can be surfaced as first-class readers.
5. **Graduate to narrow autonomy** — a small, pre-approved set of routine actions executing without
   a signature, once the accumulated outcome record justifies it.

---

## 11. Impact, in detail

Figures below are built the way a business case is built ahead of a rollout — from the mechanisms
in §6, industry benchmarks for this category of work, and a **mid-size retail bank** baseline:
roughly 150–400 employees touching operations, risk and analytics; a data/analytics function of
6–12 people; and a metric footprint comparable to the ten governed KPIs in §4. Each line states its
assumption, so it can be tightened against a specific institution's numbers directly.

### 11.1 Analyst time

| Assumption | Value used |
|---|---|
| Fully-loaded cost of a senior analyst | $110K/year (~$55/hour) |
| Metric movements investigated per week, across the team | ~12 |
| Time per investigation today (verify → segment → forecast → write-up) | ~6 hours |
| Time per investigation with FinInsights (review + judgement only) | ~45–60 minutes |
| Time reclaimed per investigation | **~85–90%**, ~5 hours |

**Annual value:** 12 investigations/week × ~5 hours reclaimed × 50 weeks × $55/hour
≈ **$165,000/year** in analyst time, redeployable to work that currently doesn't get done.

### 11.2 Bad decisions avoided

| Assumption | Value used |
|---|---|
| Frequency of a data-defect-shaped false movement, per 10 governed metrics | ~1–2/quarter (~5–8/year) |
| Share of those that would otherwise reach a business decision unchallenged | ~50% |
| Cost of one decision made on a false movement (a reallocated campaign, a paused rollout, a misdirected root-cause effort, the credibility repair after) | $25,000–$60,000 |

**Annual value:** ~3–4 prevented incidents/year × ~$40,000 midpoint ≈ **$120,000–$160,000/year.**
This is the mechanism most likely to be understated here — the downstream cost of a bad decision
compounds, and this figure only counts the direct cost of the one decision, not what it caused
afterward.

### 11.3 Reporting cycle time

| Assumption | Value used |
|---|---|
| Analysts/managers producing persona-specific reporting (CFO pack, ops review, risk view) | 2–3 people |
| Hours per week each spends assembling role-specific cuts of the same underlying data | ~3 hours |
| Reduction once one finding renders three ways automatically | ~80% |

**Annual value:** ~2.5 people × 3 hours/week × 0.8 × 50 weeks × $55/hour ≈ **$33,000/year**, plus
the harder-to-price benefit of the CFO, ops and risk views never silently disagreeing.

### 11.4 Throughput, not just cost

| Metric | Value |
|---|---|
| Investigations one analyst can meaningfully own per month, today | ~15–20 |
| Investigations one analyst can meaningfully own per month, with the day compressed to review | ~80–120 |
| Effective capacity multiple, same headcount | **~5–8x** |

This is the number worth leading a conversation with a growing institution: the constraint on
analytics coverage stops being headcount.

### 11.5 Blended value and payback

| | Low | High |
|---|---|---|
| Analyst time reclaimed (§11.1) | $140,000 | $190,000 |
| Bad decisions avoided (§11.2) | $120,000 | $160,000 |
| Reporting cycle time (§11.3) | $25,000 | $40,000 |
| Licence/entitlement recovery (upsell + de-provisioning surfaced, not counted elsewhere) | $50,000 | $100,000 |
| **Total annual value** | **~$335,000** | **~$490,000** |

Widened to **$550K–$950K** in the headline table to include indirect effects this breakdown
excludes — faster decisions that wouldn't have been made in time at all, and reduced churn from
analysts spending less time on rote verification. The breakdown above is the defensible floor; the
headline range is the fuller picture.

Against a typical mid-market platform licence plus a bounded implementation, this range implies a
**payback period of roughly 3–5 months** — fast enough that a focused rollout against one metric
family (the KYC → loan approval → revenue chain in §4 is the natural starting point, since it is
already wired end to end) pays for itself well within the first year.

### 11.6 What moves these numbers, in either direction

- **Bank size and metric count** scale §11.1–§11.3 roughly linearly; a larger institution with more
  governed metrics sees a proportionally larger number, not a fixed one.
- **How often the data is actually dirty** is the single biggest swing factor in §11.2 — an
  institution with cleaner upstream pipelines will see this line shrink, and one with more
  fragmented sourcing will see it grow.
- **How many roles currently duplicate reporting by hand** drives §11.3 independent of bank size —
  a bank with one shared reporting function sees less benefit here than one where CFO, risk and ops
  each maintain their own view today.

---

## 12. Appendix — technical impact, briefly

Included because these engineering properties are what the business claims above actually rest on.

- **Reproducibility.** The same question over the same period returns an identical answer, on any
  machine, on any day. That is what makes an audit trail meaningful and a disputed figure
  re-checkable months later.
- **Correctness before articulacy.** The reasoning is built and complete before any language
  capability is applied. The language layer phrases figures it is given and originates none; a
  figure that cannot be traced causes the sentence to be rewritten or the answer to fall back to a
  fixed format. Removing the language capability entirely changes no number.
- **Analytics never slows the banking product.** Measurement is decoupled from the customer-facing
  journey, so a slowdown in the analytics path cannot degrade a transaction.
- **Failure is loud, not silent.** The system is designed so a number quietly becoming wrong is
  caught immediately rather than discovered later, and the absence of data is itself detectable
  rather than reading as a healthy zero.
- **Portability by construction.** No part of the reasoning engine contains banking vocabulary.
  Every institution-specific fact lives in declared configuration, which is what makes onboarding a
  second tenant a configuration task rather than a project.
