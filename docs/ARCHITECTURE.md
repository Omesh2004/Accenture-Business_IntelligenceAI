# Architecture

How the pieces fit, how data flows, and the traps that have cost real time.

## The shape of it

```
                      ┌──────────────────────────────────────────┐
                      │              NexaBank                    │
                      │  Express + Prisma + Postgres  :5000      │
                      │                                          │
                      │  domain/    customers, accounts,         │
                      │             transactions, loans, cards   │
                      │  events/    tracking + the taxonomy      │
                      │  simulate/  anomaly templates + truth    │
                      └───────┬──────────────────────┬───────────┘
                              │                      │
             per-event, real time                daily, batch
                              │                      │
                    ┌─────────▼────────┐             │
                    │  Ingestion API   │             │
                    │  FastAPI  :8000  │             │
                    │  mask, id, valid │             │
                    └─────────┬────────┘             │
                              │                      │
                    ┌─────────▼────────┐             │
                    │  Kafka  :9092    │             │
                    │  transport only  │             │
                    └─────────┬────────┘             │
                              │                      │
                    ┌─────────▼──────────────────────▼───────────┐
                    │              pipeline/                     │
                    │   consumer + bronze → silver → gold        │
                    └─────────────────────┬──────────────────────┘
                                          │
                    ┌─────────────────────▼──────────────────────┐
                    │           ClickHouse  :8123                │
                    │      bronze  /  silver  /  gold            │
                    └─────────────────────┬──────────────────────┘
                                          │
                              ┌───────────▼───────────┐
                              │      Metric API       │
                              │  the ONLY doorway     │
                              └───────────┬───────────┘
                                          │
              ┌───────────────────────────┼───────────────────────┐
              │                           │                       │
   ┌──────────▼──────────┐     ┌──────────▼──────────┐  ┌─────────▼────────┐
   │  Intelligence layer │     │      Dashboard      │  │   vLLM  :8002    │
   │  agent, 6 tools,    │────▶│    Next.js  :3001   │  │  narrator only   │
   │  signal store,      │     └─────────────────────┘  │  opt-in, no       │
   │  narrator, verifier │◀───────────────────────────── │  authority       │
   └─────────────────────┘                              └──────────────────┘
```

## Folder structure

One responsibility per folder. Markdown lives only in `docs/`. Nothing lives at the root except
configuration.

```
FinInsights/
  README.md
  CLAUDE.md
  docker-compose.yml
  docs/                      all documentation, nowhere else
  contracts/                 the KPI / semantic contracts, one YAML per KPI
    signups.yaml
    kyc_completion_rate.yaml
    loan_approval_volume.yaml
    revenue.yaml
    transaction_failure_rate.yaml
    levers.yaml              the Decide tool lever library
  nexabank/                  the data source
    src/
      domain/                customers, accounts, transactions, loans, cards
      events/                event tracking and the taxonomy, in one place
      simulate/              the simulate engine and anomaly templates
  ingestion/                 FastAPI service on 8000
  pipeline/                  kafka consumer and the bronze → silver → gold transforms
  warehouse/
    clickhouse/
      bronze/                raw table DDL
      silver/                cleaned table DDL and materialized views
      gold/                  KPI rollups and the signal store DDL
  api/                       FastAPI service on 8001
    intelligence/            the agent, tools, narrator, signal store, personas
      orchestrator.py
      tools/                 trust_gate detect localize forecast materiality decide
      narrator.py
      verifier.py
      signal_store.py
      personas.py
  dashboard/                 Next.js app
```

## The two contracts between systems

Everything else is an implementation detail of one service. These two are not.

**1. The event envelope.** What NexaBank sends to ingestion. Changing its shape touches every
producer. Note that name validation **coerces** rather than rejecting — an unknown name is wrapped
rather than dropped, which means a typo lands in the warehouse and vanishes from every chart.

**2. The tenant vocabulary.** Several independent maps must agree on what a tenant is called —
the dashboard feature map, the API tenant scopes, and the RBAC configuration. Miss one and the
WebSocket closes with 1008 and requests 403.

## Data flow, in order

1. **NexaBank writes a banking fact** — a loan application row, a transaction row — to Postgres,
   and emits the matching behavioural event. Both, always. A fact with no clickstream, or a
   clickstream with no fact, is a bug, and it is the reason data is never seeded into tables
   directly.

2. **Forwarding is fire-and-forget.** Telemetry never blocks banking. A slow or dead analytics
   path must not degrade a transaction. Forwarding outcomes are counted, because the Trust Gate
   cannot otherwise tell "the KPI dropped" from "the forwarder broke".

3. **Ingestion** masks personal data, assigns a deterministic event id so retries cannot
   double-count, validates the envelope, and publishes to Kafka.

4. **Kafka** carries events. It is transport, never the system of record. If the broker is
   unreachable, ingestion falls back to writing ClickHouse directly — which is correct behaviour
   and a silent one. See the traps below.

5. **The pipeline** consumes into Bronze, then derives Silver and Gold. See
   [DATA_MODEL.md](DATA_MODEL.md).

6. **The daily extract** pulls loan, account and ledger state from NexaBank Postgres on a daily
   cadence, into the same Bronze layer with its own source id and its own freshness watermark.

7. **The Metric API** is the only doorway into the warehouse. Named, tenant-scoped reads. No tool
   and no agent writes raw SQL against raw tables.

8. **The intelligence layer** calls the Metric API, writes findings to the Signal Store, and
   narrates from stored rows only. See [INTELLIGENCE.md](INTELLIGENCE.md).

## Determinism

The intelligence layer is fully deterministic: the same rows in produce byte-identical Signal
Store rows out. That is what makes an audit trail meaningful and a disputed figure re-checkable
months later. Concretely:

- Derive ids, never generate them.
- Pin the window once at the top of a run and never call `now()` inside a stage.
- Use `uniqExact` and `quantileExact`. ClickHouse `uniq` is HyperLogLog and `quantile` is
  reservoir sampling with an RNG — its own documentation says the result is non-deterministic.
- Give every ranking a unique tiebreaker, or rank 1 flips between identical runs.
- Round floats at the write boundary.
- Model stages achieve determinism by persisting output and re-reading it, not by bit-exact math.

## Traps

These have each cost real time. They are not hypothetical.

**The Kafka fallback is silent.** Ingestion falling back to writing ClickHouse directly never
crashes and never logs an error at a level anyone watches. The whole pipeline can run on the
fallback for its lifetime. `curl localhost:8000/health` reports `ingest_path`. A consumer group
with `LOG-END-OFFSET 0` means nothing ever arrived.

**Python edits are not live.** The three Python services bind-mount nothing; their source is baked
in at build time, so `--reload` watches files that never change. Rebuild.

**TypeScript edits are not live either.** The Node services do bind-mount `src`, but neither
Turbopack nor nodemon reliably sees a write through a Windows bind mount. The running process
keeps serving old code with no error anywhere. `tsc --noEmit` passing proves the mount is current
and proves nothing about the running process — that combination, a clean type-check over code that
is not running, is what makes this one hard to spot. Restart the service.

**`today()` is server-local.** One `today()` in ClickHouse splits the KPI card, the traffic chart
and the daily rollup into different days. The container is pinned to `TZ=UTC`; use
`toDate(now('UTC'))`. Never `today()`.

**A one-sided time filter biases every comparison.** A current window with only a lower bound,
compared against a full previous window, grows through the day and resets at midnight. Bound every
window at both ends and give the current and previous windows the same length. There is also no
upper validator on an incoming event timestamp, so a client-supplied far-future event is counted
in every "last N days" window forever.

**The schema only auto-applies to an empty volume.** A schema change against a running stack needs
a migration applied by hand. Baseline an existing database before the first migration run, or
historic migrations replay and drop the live materialized view.

**Some dimensions are fabricated, not measured.** Geography, city, device type and channel are
currently synthesised per session by the producer, at random. They are invariant within a session,
which makes contributions add up — it does not make them mean anything. Ranked, confident,
meaningless output is the worst failure mode this system has, because it looks correct. A
dimension may not be localized until it is known to be measured. See DATA_MODEL.md.

**The identity headers are asserted, not proven.** The role, email and app-scope headers are set
by the browser and the analytics port is published to the host. Entitlement enforced above an
identity anyone can assert is not entitlement. Treat this as a known gap, not a control.

**A skipped test reads as green.** Pytest reports an unmeetable prerequisite as a skip. Seven
guards once passed by not running at all, over the source they were meant to police. Treat a skip
as a failure until you have read its reason.

**Never assume a metric is the metric its name claims.** Verify by running the function, not by
reading the code. Most failures here are silent renames, not exceptions.
