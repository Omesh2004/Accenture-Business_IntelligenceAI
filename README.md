<p align="center">
  <img src="analytics-dashboard/public/logo1.png" alt="FinInsights logo" width="84" />
</p>

<h1 align="center">FinInsights</h1>
<p align="center"><b>A multi-tenant product-analytics platform that explains <i>why</i> a banking metric moved — and refuses to answer when the data cannot support one.</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white" alt="Python 3.11" />
  <img src="https://img.shields.io/badge/FastAPI-0.111-009688?logo=fastapi&logoColor=white" alt="FastAPI 0.111" />
  <img src="https://img.shields.io/badge/Next.js-16%20%2F%2015-000000?logo=next.js&logoColor=white" alt="Next.js 16 and 15" />
  <img src="https://img.shields.io/badge/ClickHouse-24.3-FFCC01?logo=clickhouse&logoColor=black" alt="ClickHouse 24.3" />
  <img src="https://img.shields.io/badge/Kafka-7.4-231F20?logo=apachekafka&logoColor=white" alt="Kafka 7.4" />
  <img src="https://img.shields.io/badge/vLLM-optional-6f42c1?logo=nvidia&logoColor=white" alt="vLLM optional" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose" />
</p>

---

Most analytics tools are very good at drawing the chart and completely silent about the
part you actually care about: *why did that line move, and can I trust it enough to act on
it?* FinInsights is an attempt at the second half of that question.

It watches a set of declared banking metrics. For each one it checks whether the underlying
data is even fit to answer from, decides whether the movement is real rather than noise,
finds the segment the movement concentrated in, works out whether it was price, volume or
mix, forecasts where the metric is heading, proposes an action that has a named human owner,
and writes the finding in plain English where **every single figure traces back to a stored
database row**. When the data cannot support a conclusion, it is built to say so — it
quarantines a metric whose event stream is corrupted, and abstains on an ambiguous case
while naming the one cheapest check that would settle it.

This repository is a **monorepo**. It contains the FinInsights platform *and* **NexaBank**,
a working demo retail bank that produces the telemetry and the core-banking records the
platform analyses. NexaBank is a data source, not the product — but it is a real Express +
Prisma + Next.js application with accounts, transfers, loans, KYC, cards and four paid
"Pro" modules, so the analytics have something honest to chew on.

- **Repository:** [Nucleus-Analytic-tool-with-banking-website](https://github.com/abhishekkumawat-47/Nucleus-Analytic-tool-with-banking-website)
- **Report a bug or suggest a feature:** [GitHub issues](https://github.com/abhishekkumawat-47/Nucleus-Analytic-tool-with-banking-website/issues)
- **The business case, in non-technical language:** [BUSINESS.md](BUSINESS.md)
- **The contributor operating manual:** [CLAUDE.md](CLAUDE.md)

<p align="center">
  <img src="wireframes/dashboard.png" alt="The FinInsights dashboard showing KPI cards, traffic trends and real-time users" width="92%" />
</p>

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Key features](#key-features)
- [Visual walkthrough](#visual-walkthrough)
- [Project structure](#project-structure)
- [Working on the code](#working-on-the-code)
- [Documentation map](#documentation-map)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Maintainers](#maintainers)
- [License](#license)

---

## Requirements

Everything runs in Docker. You do not need Python, Node, Kafka or ClickHouse installed on
your machine — and you should not use a host virtual environment even if you have one,
because it drifts from the image silently.

### On your machine

| What | Why |
|---|---|
| **Docker Desktop / Docker Engine** with Compose v2 (`docker compose`, not `docker-compose`) | Everything is a container |
| **~8 GB of RAM available to Docker** (10 GB is comfortable) | Kafka + Zookeeper + ClickHouse + three Next.js dev servers is not a light stack |
| **~15 GB of free disk** | Six base images plus two `npm ci` runs |
| **Git** | Shell scripts and SQL are pinned to LF endings via `.gitattributes`; clone normally and this is handled for you |

### One external service you must provide

**A PostgreSQL 14+ database for NexaBank.** There is deliberately no Postgres service in
`docker-compose.yml` — the bank's own records live outside the analytics stack, the way they
would at a real customer. The project is wired for [Supabase](https://supabase.com) (free tier
is fine), which gives you the two connection strings Prisma wants. Any plain PostgreSQL also
works: point both `DATABASE_URL` and `DIRECT_URL` at the same URL.

### One external credential you must create

**A Google OAuth client.** The analytics dashboard signs in with Google and has no other
provider and no local fallback, so without this the dashboard on port 3001 is unreachable.
Setup takes about three minutes — see [Step 3](#3-create-a-google-oauth-client) below.

### Ports that must be free

```
2181    Zookeeper                  8123    ClickHouse (HTTP)
3001    FinInsights dashboard      9000    ClickHouse (native)
3002    NexaBank frontend          9092    Kafka (from your host)
5000    NexaBank backend + ws     29092    Kafka (inside the compose network)
8000    Ingestion API
8001    Analytics API              8002    vLLM — only if you opt into the GPU profile
```

None of these are configurable through environment variables; every mapping in
`docker-compose.yml` is a literal. If one clashes you have to edit that file by hand, and
moving 3001 or 8001 also means updating `NEXTAUTH_URL`, the Google redirect URI, and
`NEXT_PUBLIC_ANALYTICS_WS_URL`.

### Optional — only for the LLM narrator

The language model is **off by default and the platform is complete without it**. It phrases
English; it never produces a number. Turning it on needs an NVIDIA GPU, the NVIDIA Container
Toolkit, and a Hugging Face token. See
[Turning on the LLM narrator](#turning-on-the-llm-narrator-optional).

---

## Installation

Budget about 20 minutes for the first run: roughly 10 for the initial image build, and the
rest for creating credentials and seeding data. There is no one-shot bootstrap script — the
steps below are the whole thing, in order.

### 1. Clone the repository

```bash
git clone https://github.com/abhishekkumawat-47/Nucleus-Analytic-tool-with-banking-website.git
cd Nucleus-Analytic-tool-with-banking-website
```

### 2. Create the environment files

> **This is the step that stops a fresh clone from starting.** Compose declares
> `env_file:` for two files that are gitignored and therefore not in the repository. If they
> are missing, `docker compose up` fails immediately with an env-file error. Only
> `.env.example` is tracked.

**a. The root `.env`** — start from the example, then add the four keys it is missing:

```bash
cp .env.example .env
```

```env
# .env  (edit after copying)
DEPLOYMENT_MODE=CLOUD
KAFKA_BROKER_URL=broker:29092
KAFKA_TOPIC_EVENTS=feature-events
CLICKHOUSE_HOST=clickhouse
CLICKHOUSE_PORT=8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=clickhouse        # <- .env.example leaves this blank; the container uses "clickhouse"
CLICKHOUSE_DATABASE=feature_intelligence

# Not in .env.example, but read by docker-compose.yml:
EXTRACT_API_TOKEN=local-dev-extract-token
INTELLIGENCE_LLM=0                    # 1 turns on the optional LLM narrator
# HF_TOKEN=hf_...                     # only needed for the GPU profile
```

**b. `analytics-dashboard/.env.local`** — create this file yourself; there is no template:

```env
GOOGLE_CLIENT_ID="<your Google OAuth client id>"
GOOGLE_CLIENT_SECRET="<your Google OAuth client secret>"
NEXTAUTH_URL="http://localhost:3001"
NEXTAUTH_SECRET="<a long random string>"
NEXT_PUBLIC_API_URL="/api"
NEXT_PUBLIC_ANALYTICS_WS_URL="ws://localhost:8001"
NEXT_PUBLIC_NEXABANK_URL="http://localhost:3002"
```

**c. `NexaBank/backend/.env`** — create this file too:

```env
NODE_ENV=development
PORT=5000
FRONTEND_URL=http://localhost:3002

# Your external PostgreSQL. With Supabase, DATABASE_URL is the pooled string (port 6543)
# and DIRECT_URL is the direct one (port 5432). With plain Postgres, use the same URL twice.
DATABASE_URL=postgresql://USER:PASSWORD@HOST:6543/postgres?pgbouncer=true&sslmode=require
DIRECT_URL=postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require

JWT_SEC=<a long random string>

# Tenant seed data (read once by src/seedTenants.ts on every container start)
TENANT_A_ID=bank_a
TENANT_A_NAME=NexaBank
TENANT_A_IFSC=NEXA
TENANT_A_BRANCH=0001
TENANT_B_ID=bank_b
TENANT_B_NAME=SafeX Bank
TENANT_B_IFSC=SAFX
TENANT_B_BRANCH=0001

# The built-in bank administrator. Set SYSTEM_PASSWORD before the first boot — otherwise a
# random one is generated and you will not be able to sign in to the admin console.
SYSTEM_EMAIL=system@nexabank.internal
SYSTEM_NAME=NexaBank System
SYSTEM_TENANT=bank_a
SYSTEM_PASSWORD=<choose one now>

# Internal ledger accounts
ACC_PRO_LICENSE=NEXABANK-SYSTEM
ACC_REVENUE=NEXABANK-SYSTEM-REVENUE
ACC_EXTERNAL=EXTERNAL-BANK
ACC_MERCHANT=MERCHANT-ID
ACC_CRYPTO=CRYPTO-EXCHANGE
ACC_WEALTH=WEALTH-REBALANCE-SYS
```

### 3. Create a Google OAuth client

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. Go to **APIs & Services → OAuth consent screen**. Choose **External**, fill in the app name
   and your support email, and save. Leave the publishing status as **Testing**.
3. Still on the consent screen, add **your own Google address under Test users**. If you skip
   this, Google refuses your sign-in and the dashboard sends you to `/unauthorized`.
4. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
5. Under **Authorized redirect URIs**, add exactly:
   `http://localhost:3001/api/auth/callback/google`
6. Copy the client ID and secret into `analytics-dashboard/.env.local`.

### 4. Grant yourself access in `rbac.json`

Who can see what is decided by a checked-in JSON file keyed on email address. The file ships
pre-populated with the maintainers' accounts — **replace them with yours.**

```json
{
  "super_admins": ["you@example.com"],
  "app_admins": {
    "nexabank":  ["you@example.com"],
    "safexbank": ["you@example.com"]
  },
  "personas": {
    "default": "analyst",
    "by_role": { "super_admin": "cfo", "app_admin": "ops_manager", "user": "analyst" },
    "by_email": {},
    "allowed": ["cfo", "ops_manager", "analyst", "marketing_lead", "risk_officer", "data_steward"],
    "selectable_by_role": {
      "super_admin": ["cfo", "ops_manager", "analyst", "marketing_lead", "risk_officer", "data_steward"],
      "app_admin":   ["ops_manager", "analyst", "marketing_lead", "risk_officer", "data_steward"],
      "user":        ["analyst"]
    }
  }
}
```

Keep the whole `personas` block — the analytics API reads it to resolve who is answering.
An email that appears nowhere resolves to the `user` role, which is refused everything.

> Put yourself under **`app_admins`** if you want to actually look at the dashboards. A
> `super_admin` deliberately sees only aggregate summaries; the detailed pages are an
> `app_admin` surface.

### 5. Build and start

```bash
docker compose up -d --build
```

That starts 11 of the 14 services. `vllm-server` sits behind a `gpu` profile and `tests` /
`e2e` behind a `test` profile, so none of them start unless you ask.

First build is genuinely slow — two Next.js `npm ci` runs plus a Python image. Watch the two
things that can fail quietly:

```bash
docker compose logs -f init-kafka        # must end with the 'feature-events' topic created
docker compose logs -f nexabank-backend  # 'prisma db push' + seedTenants must both succeed
```

### 6. Verify the stack is healthy, not merely running

```bash
# Ingestion — and, critically, whether Kafka is really in the path
curl -s localhost:8000/health
#   "ingest_path": "kafka"                -> good
#   "ingest_path": "clickhouse_fallback"  -> the broker was unreachable at startup. Events
#                                            still land, but Kafka and the worker are bypassed.

# The Analytics API has NO /health route. Use this instead:
curl -s localhost:8001/deployment/info

# NexaBank
curl -s localhost:5000/
curl -s localhost:5000/api/health/forwarder

# Kafka is genuinely carrying events (LOG-END-OFFSET 0 means nothing ever arrived)
docker compose exec broker kafka-consumer-groups --bootstrap-server broker:29092 \
  --describe --group feature-processor-group

# ClickHouse is up and the schema ran
docker compose exec clickhouse clickhouse-client --password clickhouse \
  --database feature_intelligence --query "SELECT count() FROM events_raw"
```

Interactive API docs live at **<http://localhost:8000/docs>** for the ingestion service.
The Analytics API's `/docs` exists but is behind RBAC, so a plain browser gets a 403 — see
the [FAQ](#faq).

### 7. Load some data — do not skip this

**The stack boots completely empty.** Every dashboard will show zeros until you generate
traffic, and that is the single most common "is it broken?" moment. The order below matters,
and the code enforces it with HTTP 409 refusals.

```bash
# 1. Reference data FIRST. Branches are reference data, and a customer created against an
#    empty branch table gets a null branch — which silently removes `region` from every KPI
#    that localizes on it. The simulate route refuses with 409 rather than let that happen.
docker compose exec nexabank-backend npx tsx src/scripts/seedReferenceData.ts

# 2. Generate the demo dataset. This drives the simulation console through the real auth
#    path and writes BOTH telemetry and real core-banking rows.
docker compose exec nexabank-backend npx tsx src/scripts/generateDemoData.ts

# 3. Derive account / card / transaction lifecycle states from what actually happened
docker compose exec nexabank-backend npx tsx src/scripts/applyLifecycle.ts

# 4. Seed the Pro-feature entitlements into ClickHouse
docker compose exec analytics-api python api/seed_licenses.py

# 5. Pull the three batch sources into ClickHouse. Run this in the `intelligence` service —
#    it is the only container holding EXTRACT_API_TOKEN, so this 401s anywhere else.
#    Allow ~20 minutes for ~200 users; it waits on the database, not the HTTP response.
docker compose run --rm --no-deps -T intelligence python -c \
  "from api.intelligence import loaders; \
   print(loaders.load_core_banking()); print(loaders.load_crm()); \
   print(loaders.load_market_ops(['nexabank','safexbank']))"
```

**Or do it from the UI.** Sign in to NexaBank at <http://localhost:3002> with the
`SYSTEM_EMAIL` / `SYSTEM_PASSWORD` you set in step 2c, then open the admin simulation console
at **<http://localhost:3002/admin/simulate>** and run it twice — once per bank:

1. Tenant `NexaBank (bank_a)`, User count `20`, Historical days `10` → **Run simulation**
2. Tenant `SafeX Bank (bank_b)`, same numbers → **Run simulation**

<p align="center">
  <img src="wireframes/Nexabank/simulate.png" alt="The NexaBank admin simulation console with tenant, user count, historical days and scenario template controls" width="92%" />
</p>

The console also carries about twenty named scenario templates — a KYC drop confined to
mobile users in India, a loan-approval freeze, a shift of traffic to mobile, a Pro-conversion
collapse, and a deliberate "noise control" that the platform is *supposed* to stay quiet
about. It records no ground truth: a planted movement exists only as the shape of the events,
so the intelligence layer has to infer it the way it would a real incident.

### 8. Sign in to the dashboard

Open **<http://localhost:3001>**, sign in with the Google account you listed in `rbac.json`,
and you should land on the app selector and then a populated dashboard.

### Starting over

```bash
# Wipe the simulated banking data (keeps ADMIN logins and the three ledger accounts)
docker compose exec nexabank-backend npx tsx src/scripts/resetDemoData.ts --yes

# Stop everything, keep the data
docker compose down

# Stop everything and DESTROY all volumes — ClickHouse, Kafka and the model cache
docker compose down -v
```

Note that `docker compose down -v` destroys the six local volumes but touches **nothing** in
your external PostgreSQL. Customers, accounts, transactions and events all survive there.
Use `resetDemoData.ts` for that side.

---

## Configuration

### Where configuration lives

| File | Committed? | Consumed by | Needed to start? |
|---|---|---|---|
| `.env` (repo root) | `.env.example` only | Compose `${VAR}` interpolation, and `core/config.py` inside every Python image | Not strictly, but the extract and LLM paths come from here |
| `analytics-dashboard/.env.local` | **No** — gitignored, no template | `env_file:` on `analytics-dashboard` | **Yes** — compose errors out without it |
| `NexaBank/backend/.env` | **No** — gitignored | `env_file:` on `nexabank-backend` | **Yes** — compose errors out without it |
| `NexaBank/frontend/.env.local` | No | Next.js | No — compose sets what it needs directly |
| `rbac.json` | Yes | Dashboard and Analytics API | Yes — this is who can see what |
| `contracts/*.yaml` | Yes | The intelligence layer | Yes — these are the metric definitions |

### Root `.env` reference

| Variable | Default | What it does |
|---|---|---|
| `DEPLOYMENT_MODE` | `CLOUD` | `ON_PREM` switches ingestion to a direct insert and pins the instance to one tenant |
| `KAFKA_BROKER_URL` | `broker:29092` | Broker address for the ingestion API and worker |
| `KAFKA_TOPIC_EVENTS` | `feature-events` | The topic `init-kafka` creates |
| `CLICKHOUSE_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | `clickhouse` / `8123` / `default` / `""` / `feature_intelligence` | Warehouse connection. **The container is created with the password `clickhouse`, so the code default of `""` will not connect** |
| `EXTRACT_API_TOKEN` | `local-dev-extract-token` | Shared secret for NexaBank's nine `/api/extract/*` batch endpoints. Unset means they return 503 |
| `INTELLIGENCE_LLM` | `0` | `1` enables the LLM narrator |
| `VLLM_URL` | `http://vllm-server:8000/v1` | Any OpenAI-compatible endpoint |
| `HF_TOKEN` | *(empty)* | Hugging Face token, for pulling the Qwen AWQ weights |
| `VLLM_MODEL` / `VLLM_MAX_LEN` / `VLLM_GPU_UTIL` | *(unset)* | Pin the model instead of auto-selecting by free VRAM |
| `VLLM_WSL2_ENABLE_PIN_MEMORY` | `1` | Works around "UVA is not available" on WSL2 |
| `HF_HUB_DISABLE_XET` | `1` | Falls back to plain HTTPS downloads; the Xet transfer path fails behind some networks |
| `NEXT_MODE` | `development` | `production` makes both Next.js apps build ahead of time instead of compiling each route on first visit |
| `CORS_ALLOW_ORIGINS` | `http://localhost:3000,3001,3002` | Read by the Analytics API |
| `API_PORT_INGESTION` / `API_PORT_ANALYTICS` | — | **Dead.** Nothing reads them; ports are hardcoded in compose |
| `OLLAMA_URL` | `http://ollama:11434` | **Vestigial.** There is no Ollama service any more — the LLM is vLLM on 8002 |

There are around forty more knobs for the intelligence layer, all prefixed `INTEL_` or
`INTELLIGENCE_`, all with sensible defaults, all documented in
[`api/intelligence/config.py`](api/intelligence/config.py). Nothing in that layer is
hardcoded.

### Tenant vocabulary — two names for the same bank

This trips everybody up once. The banking side and the analytics side use different ids:

| | NexaBank | SafeX Bank |
|---|---|---|
| PostgreSQL / NexaBank (`Tenant.id`) | `bank_a` | `bank_b` |
| ClickHouse / dashboard (`events_raw.tenant_id`) | `nexabank` | `safexbank` |
| IFSC prefix | `NEXA` | `SAFX` |

The Analytics API accepts `bank_a` / `bank_b` in any query parameter and rewrites them before
RBAC runs, so both spellings work at the edge. Internally, four independent maps must agree —
`api/main.py`, `analytics-dashboard/src/lib/feature-map.ts`,
`NexaBank/backend/src/middleware/eventTracker.ts` and `rbac.json`. Miss one when adding a
tenant and the WebSocket closes with code 1008 and requests start returning 403.

### What needs a rebuild after you edit what

This is the single most common source of "my change did nothing".

| You edited | What to run |
|---|---|
| `api/`, `ingestion/`, `processing/`, `core/`, `storage/`, `contracts/` | `docker compose up -d --build <service>` — **the Python services bind-mount nothing.** Their source is baked in at build time, so the `--reload` flag is watching files that never change |
| `rbac.json` | Live in the dashboard immediately. The Analytics API reads the copy baked into its image, so `docker compose up -d --build analytics-api` |
| `analytics-dashboard/src`, `NexaBank/*/src` | Bind-mounted, but file watchers do not reliably see writes through a Windows bind mount. `docker compose restart <service>` before judging the change |
| `storage/schema.sql` | Also add a file to `storage/migrations/` and apply it — `schema.sql` only runs on an empty volume |
| `.env` | `docker compose up -d` re-creates containers with the new values; the Python services additionally need `--build` |

A shortcut for the most common case ships as `rebuild.ps1`:

```powershell
docker compose up -d --build analytics-api
```

### Turning on the LLM narrator (optional)

The layer is complete without it. The model only phrases English — every figure it emits is
re-checked against the stored claim set, and an unverifiable draft falls back to the
deterministic template. Turning it off changes no number.

```bash
# In .env:
#   HF_TOKEN=hf_...
#   INTELLIGENCE_LLM=1

docker compose --profile gpu up -d vllm-server
curl localhost:8002/v1/models                 # confirm what it actually serves
docker compose up -d --build intelligence analytics-api
```

With `VLLM_MODEL` unset, `vllm_entrypoint.sh` picks a tier by free VRAM:

| Free VRAM | Model | GPU util | Max length |
|---|---|---|---|
| ≥ 6500 MiB | `Qwen/Qwen2.5-7B-Instruct-AWQ` | 0.85 | 4096 |
| ≥ 2800 MiB | `Qwen/Qwen2.5-3B-Instruct-AWQ` | 0.75 | 2048 |
| below that | `Qwen/Qwen2.5-1.5B-Instruct-AWQ` | 0.65 | 1024 |

No model name is hardcoded downstream — set `INTEL_LLM_MODEL` to pin one, or leave it empty
and the narrator asks the server what it serves. Any OpenAI-compatible server works. Confirm
the model is genuinely in play:

```bash
docker compose exec clickhouse clickhouse-client --password clickhouse \
  --database feature_intelligence \
  --query "SELECT engine_type, count() FROM model_runs GROUP BY engine_type"
```

### Applying schema changes

`storage/schema.sql` is mounted at `/docker-entrypoint-initdb.d/init.sql`, so it runs **only
on an empty ClickHouse volume**. Editing it does nothing to a running stack. Everything after
the first boot goes through the migration runner, which records each applied file in
`schema_migrations` by name and content hash:

```bash
docker compose exec -T ingestion-api python storage/migrate.py --status    # always check first
docker compose exec -T ingestion-api python storage/migrate.py --baseline  # first time on an existing DB
docker compose exec -T ingestion-api python storage/migrate.py             # apply pending
```

> **The baseline trap.** The runner arrived after the migrations had already been applied by
> hand. On an un-baselined live volume every historic file looks pending, and replaying one of
> them drops the live materialized view. `migrate.py` detects this, prints `REFUSING TO APPLY`
> and exits 2. Baseline first, then apply normally forever after.

Every schema change must land in **both** `storage/migrations/<date>_<name>.sql` (for running
stacks) and `storage/schema.sql` (for fresh volumes). Two tests enforce the pairing.

---

## How it works

### The five systems

One repository, five deployable systems, joined by exactly two contracts — an HTTP event
envelope and a tenant-id vocabulary. There is no shared library, no shared database and no
shared type package, which is deliberate: each system can be deployed and reasoned about on
its own.

| # | System | Containers | What it does |
|---|---|---|---|
| 1 | **NexaBank** | `nexabank-backend` (:5000), `nexabank-frontend` (:3002) | The demo bank. Real banking flows, and the only real producer of telemetry |
| 2 | **Ingestion pipeline** | `ingestion-api` (:8000), `processor-worker` | Accepts, validates and buffers events; batches them into the warehouse |
| 3 | **Analytics API** | `analytics-api` (:8001) | 50 REST endpoints plus a WebSocket; enforces roles and tenant scope |
| 4 | **Intelligence layer** | `intelligence` (no port) | The scheduled investigation engine and the query agent |
| 5 | **Analytics dashboard** | `analytics-dashboard` (:3001) | The only human-facing read surface |

Four of those run the **same Docker image** (`python:3.11-slim`, built from the root
`Dockerfile`) and differ only by their compose `command`.

### The event pipeline, end to end

```
Browser (NexaBank :3002)
  │  axios, x-session-id header
  ▼
Express :5000 — eventTracker middleware
  ├─► PostgreSQL `Event` row (its UUID becomes the event_id)
  └─► forwardToIngestionAPI()  ── UNAWAITED, fire-and-forget ──┐
        enforceTaxonomy(name), bank_a → nexabank,              │
        session-cached geo/device, metadata._simulated[]       │
                                                               ▼
                                    POST http://ingestion-api:8000/events
                                      ├ 64 KB body cap                → 413
                                      ├ FeatureEvent validation       → 422 + dead letter
                                      ├ PII masking (emails, IPv4)
                                      ├ admin tracking toggle         → 403
                                      └ Kafka `feature-events`, key = tenant_id, 5 s timeout
                                           │      └─ on failure: direct insert, ingest_path='fallback_cloud'
                                           ▼
                      processing/worker.py — group `feature-processor-group`,
                      batch 500 / flush 2 s, offsets committed AFTER insert,
                      poison rows dead-lettered
                                           ▼
                      ClickHouse `feature_intelligence.events_raw`
                                           ▼  mv_daily_feature_usage
                      `daily_feature_usage`  (uniqExact aggregate states)
                                           ▼
                      Analytics API :8001 ── REST JSON ─────────► dashboard :3001
                                          ── WS METRICS_UPDATE (10 s poll) ─►
                                          ── WS REALTIME_EVENT (Kafka tail) ─►
```

Two design rules are load-bearing here:

- **Telemetry never blocks banking.** The forward call is unawaited and its failures are
  counted rather than thrown. A dead analytics stack cannot stop a customer transferring money.
- **The fallback is invisible in normal operation.** If Kafka is unreachable, ingestion writes
  straight to ClickHouse, tags the row `fallback_cloud`, and still returns 202. This once hid
  for an entire development phase. `GET :8000/health` is how you tell.

### The two contracts

**1. The HTTP event envelope** (`FeatureEvent` in `core/models.py`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_id` | string | **yes** | Rejected if blank — replay-safe deduplication depends on it |
| `event_name` | string | **yes** | **Coerced, never rejected.** An unrecognised name becomes `core.<name>.action` |
| `tenant_id` | string | **yes** | Also the Kafka partition key |
| `user_id` | string | **yes** | SHA-256 hashed at the producer |
| `timestamp` | float (unix seconds) | **yes** | Must fall inside `[now − 90 days, now + 5 min]` |
| `channel` | enum | **yes** | `web` \| `mobile` \| `api` \| `batch` |
| `session_id` | string | no (`""`) | Carried from the browser via `x-session-id` |
| `metadata` | object | no (`{}`) | Free-form; unknown top-level fields are folded into `metadata._unrecognized_fields` rather than dropped |
| `schema_version` | int | no (`1`) | Envelope shape version |

```bash
curl -X POST localhost:8000/events -H 'Content-Type: application/json' -d '{
  "event_id": "evt_1a2b3c4d5e6f",
  "event_name": "login.auth.success",
  "tenant_id": "nexabank",
  "user_id": "user_123",
  "timestamp": 1718361234.56,
  "channel": "web",
  "metadata": {"browser": "Chrome"}
}'
# -> 202 {"status": "Event queued successfully"}
```

**2. The tenant-id vocabulary** — described under [Configuration](#tenant-vocabulary--two-names-for-the-same-bank).

### The data layer

One ClickHouse database, `feature_intelligence`, holds everything: 31 tables plus one
materialized view. There is no ORM and no query builder — every read is hand-written SQL with
bound parameters through a fresh client per call.

**Clickstream and plumbing**

| Table | Engine | What it holds |
|---|---|---|
| `events_raw` | `ReplacingMergeTree(_inserted_at)` | Every telemetry event, one row each, partitioned by month |
| `daily_feature_usage` | `AggregatingMergeTree` | Daily rollup as `uniqExact` aggregate states, plus a `raw_rows` sum |
| `mv_daily_feature_usage` | Materialized view | Feeds the rollup on insert, grouping on the canonical event name |
| `events_dead_letter` | `MergeTree` | Un-insertable rows with the verbatim payload and error |
| `schema_migrations` | `ReplacingMergeTree` | The migration ledger |

**Product configuration and cached output:** `tenant_licenses`, `tracking_toggles`,
`config_audit_log`, `ai_reports`.

**The Signal Store** — ten tables, one per pipeline stage, all joined by `investigation_id`:
`investigations`, `trust_findings`, `anomalies`, `root_causes`, `forecasts`, `causal_effects`,
`recommendations`, `insights`, `model_runs`, `outcomes`.

**Batch sources** — five fact tables (`fact_transactions`, `fact_loan_applications`,
`fact_account_openings`, `fact_cards`, `fact_campaign_interactions`), six dimensions
(`dim_customer`, `dim_campaign`, `dim_branch`, `dim_macro_environment`, `dim_calendar`,
`dim_fee_schedule`), and two bookkeeping tables (`source_freshness`, `ingest_watermarks`).

Because the worker commits Kafka offsets *after* inserting, delivery is at-least-once. Three
mechanisms absorb the replays: a producer-minted `event_id`, storage-level collapse via
`ReplacingMergeTree`, and read-level `uniqExact` counting rather than `count()`.

### The intelligence layer

Every 15 minutes, for each tenant and each governed KPI, the layer asks seven questions in
order and records the answer to each as a database row.

| # | Stage | Question it answers | Engine tag | Writes to |
|---|---|---|---|---|
| 01 | **Trust Gate** | Is this data fit to answer from at all? | `rule` | `trust_findings` (always, including passes) |
| 04 | **Forecast** | What was this metric expected to be? | `stats` | `forecasts` |
| 02 | **Detect** | Is the deviation real, persistent and material? | `stats` | `anomalies` |
| 03 | **Localize** | Which segment is it concentrated in? | `stats` | `root_causes` |
| 02a | **Decompose** | Was it price, volume or mix? | `stats` | `root_causes` |
| 05 | **Causal** | How strong is the causal evidence, honestly? | `rule` | `causal_effects` |
| 06 | **Decide** | Which owned lever addresses it? | `rule` | `recommendations` |
| 07 | **Narrate + verify** | Does every figure trace to a stored row? | `rule` / `llm` | `insights` |
| 08 | **Observe** | What did this cost to produce? | — | `model_runs` |

Build order is not execution order: Forecast runs as a batch *before* Detect, because Detect
scores against the band Forecast stored.

Four properties are worth calling out, because they are the point of the whole layer:

- **No invented numbers.** Every figure in a narrative must match a value from a stored claim
  row within a tolerance of 0.01. An unverifiable draft is stripped back to the headline
  rather than published. This applies to the LLM output exactly as it applies to the template.
- **Determinism.** The same rows in produce byte-identical rows out. Ids are *derived* by
  hashing their inputs rather than generated; the analysis window is pinned once at whole UTC
  midnights and never recomputed inside a stage; only exact aggregates are used (`uniqExact`,
  never HyperLogLog `uniq`); every ranking has a full tiebreaker so rank 1 cannot flip; floats
  are rounded at the write boundary.
- **Honest engine accounting.** Every produced number is tagged `rule`, `stats`, `sql`, `ml`
  or `llm`. The LLM-vs-non-LLM split is then *computed* from those rows, never narrated by the
  model. Read it at `GET /intelligence/telemetry`.
- **Refusal is a first-class answer.** A hard invariant break (a duplicate-event storm, say)
  quarantines the metric and issues an engineering note instead of a business finding. A soft
  invariant wobble makes the run abstain and name the single cheapest check that would settle
  it. Nothing acts on its own — recommendations name a human owner and require a signature.

On top of the scheduled pipeline sits a **persona-aware query agent**: a bounded
plan → act → observe → validate → re-plan loop over a catalogue of 15 deterministic tools.
The planner chooses *capabilities*, never numbers; the capabilities produce the numbers and
the verifier checks them. It works with no model at all — the rule-based planner is
dependency-free — and an optional LLM planner falls back to it on any failure.

### Roles, personas and how identity flows

```
Google OAuth → NextAuth JWT → role + adminApps resolved from rbac.json
             → axios interceptor attaches four headers
             → RBACMiddleware on :8001 enforces them

X-User-Email   your address
X-User-Role    super_admin | app_admin | user
X-Admin-Apps   comma-joined app ids
X-Active-App   the app id in the current URL
```

**Roles** decide which endpoints and which tenants you can reach:

- `super_admin` — aggregate summaries only (`/admin`, `/metrics/kpi`, `/insights`,
  `/tenants`, `/features/usage`, `/deployment`, `/ai_report`, `/tracking`, `/config`,
  `/intelligence`). Explicitly blocked from the detailed and user-level endpoints.
- `app_admin` — full detail, but must name a tenant and may only name tenants inside its own
  app. Cross-app comparison is refused.
- `user` — no analytics API access at all.

**Personas** decide how a finding *reads*. They are resolved server-side from your role, and
you can switch only within an allowlist your role permits — so switching can never widen
access. Six ship in the box:

| Persona | Remit | Depth |
|---|---|---|
| **CFO** | Financial outcome, exposure and outlook across the portfolio | summary |
| **Operations manager** | Day-to-day levers, segment concentration, remediation | standard |
| **Analyst** | Full method detail: decomposition, localisation, provenance, runtime | full |
| **Marketing lead** | Acquisition efficiency: spend, funnel entry, product uptake | standard |
| **Risk and compliance officer** | KYC integrity, approval discipline, auditability | full |
| **Data steward** | Pipeline health: freshness, trust verdicts, lineage, cost | full |

Personas never disagree about a shared number. What changes is depth, framing, which owners'
levers are shown as *yours*, and how much the agent may spend answering.

---

## Key features

### The ten governed KPIs

Each one is a hand-written YAML contract in [`contracts/`](contracts/) that declares what the
number means, which additive parts it is built from, which dimensions may legitimately be
sliced, who it is for, and the **closed list** of actions a recommendation may propose. A
recommendation cannot invent a lever outside that list.

| KPI | Unit | Grain | Recommendation owner |
|---|---|---|---|
| `fee_revenue` | currency (INR) | daily / transaction | `revenue_ops` |
| `pro_revenue` *(modelled)* | currency (USD) | daily / event | `revenue_ops` |
| `net_deposit_growth` | currency (USD) | monthly / transaction | `retail_banking` |
| `cost_per_acquisition` | currency (USD) | weekly / campaign | `marketing_ops` |
| `loan_approval_rate` | ratio | daily / application | `lending_ops` |
| `loan_approval_volume` | count | daily / event | `lending_ops` |
| `kyc_completion_rate` | ratio | daily / session | `growth_analytics` |
| `new_account_openings` | count | daily / account | `retail_banking` |
| `digital_adoption_rate` | ratio | daily / transaction | `digital_channels` |
| `new_product_activations` | count | daily / card | `product_marketing` |

They form a declared driver graph, so several simultaneous movements can be reported as one
story rather than five separate alerts:

```
cost_per_acquisition → new_account_openings → net_deposit_growth → digital_adoption_rate
kyc_completion_rate  → loan_approval_volume → pro_revenue
kyc_completion_rate  → loan_approval_rate   → fee_revenue
```

Anything the platform sees that has *no* contract still gets a conservative automatic
treatment — it can be detected, localized and forecast, but never gets a causal claim or a
recommended action, because nobody has declared what those would mean. Promoting one to full
depth means writing its contract file; no code changes.

### The analytics dashboard

| Page | What you get |
|---|---|
| `/dashboard` | KPI cards, traffic chart, real-time users, AI insights, world map, top pages, device split |
| `/features` | Feature usage over time, top-features ranking, an interactive usage heatmap |
| `/intelligence` | The agentic surface: an editorial finding, "ask the analyst", attribution (segment concentration and factor decomposition), and a collapsible audit trail |
| `/predictive` | Adoption scoring, opportunity radar, model pulse, anomaly insights |
| `/tenants` | Two banks side by side: KPI comparison, traffic trends, adoption matrix, funnel, behaviour, performance |
| `/license-usage` | Paid-for versus actually-used features, with a waste alert |
| `/governance` | Per-feature tracking consent toggles, with an audit of who changed what |
| `/transparency` | An on-prem/cloud toggle showing exactly what a super admin can and cannot see |
| `/ai-report` | An executive markdown report with a snapshot, focus distribution and print-to-PDF |
| `/admin` | Super-admin global overview and the RBAC viewer |
| `/settings` | Read-only URL-pattern → feature routing table |

Every analytics page has two URLs — `/dashboard` and `/nexabank/dashboard` render the same
component — because the URL's first segment is how the active app is identified.

Two independent WebSockets keep it live: one for `METRICS_UPDATE` frames (a 10-second
ClickHouse poll) and one for `REALTIME_EVENT` frames (a Kafka tail). Agent answers stream over
Server-Sent Events read off a `fetch` body reader, with a silent fallback to the batch
endpoint if a proxy buffers the stream.

### Honest-data labelling

The dashboard asks the API which metadata dimensions the producer *invented* rather than
measured, and puts an amber **Simulated** badge on any card or chart built on one. Geography,
city, continent, device type and channel are all drawn once per session from a weighted table
on the live path, and the envelope says so in `metadata._simulated`. The intelligence layer
refuses to localize on a dimension flagged that way outside the seeded dataset — because
ranked, confident, meaningless output is the worst failure mode a system like this has.

### NexaBank, the demo bank

<p align="center">
  <img src="wireframes/Nexabank/home.png" alt="The NexaBank landing page" width="92%" />
</p>

- **Accounts and money movement** — registration and login with JWT-in-httpOnly-cookie,
  multi-account opening (savings, current, loan, credit card, investment), own-account
  transfers, a payee book, payee payments, transaction history with search and date filters
- **Loans** — four products (home 8.5%, auto 9.2%, personal 10.5%, student 8.0%), an EMI
  calculator, a three-step application with PAN/Aadhaar/income KYC, and an admin approval
  queue that disburses to a chosen account and books a real ledger transaction
- **Cards, notifications and CRM attributes** — age, income and employment brackets, risk
  segment, lifetime value, home branch
- **Four paid "Pro" modules** at ₹2,000/month each, unlocked by a real ledger transaction:
  Crypto Trading (live prices from CoinGecko with a cached fallback), Wealth Management
  (net-worth view and portfolio rebalancing), Payroll Pro (bulk payouts with per-batch
  limits), and a Finance Library
- **Admin** — the loan queue, per-feature tracking toggles, and the simulation console

<p align="center">
  <img src="wireframes/Nexabank/apply_loan.png" alt="The NexaBank three-step loan application with KYC" width="46%" />
  <img src="wireframes/Nexabank/crypto.png" alt="The NexaBank crypto trading Pro module" width="46%" />
</p>

<p align="center">
  <img src="wireframes/Nexabank/wealth_mgmt.png" alt="The NexaBank wealth management Pro module" width="46%" />
  <img src="wireframes/Nexabank/payroll.png" alt="The NexaBank bulk payroll Pro module" width="46%" />
</p>

### Four data sources, one warehouse

The clickstream is real-time. Three further batch feeds are pulled from NexaBank's
token-guarded extract API on a 60-minute loop — never through a direct database connection.

| Source | What it is | Cadence | Freshness SLA |
|---|---|---|---|
| `nexabank_clickstream` | Product telemetry | real-time | 15 min |
| `nexabank_core` | Core banking: transactions, applications, accounts, cards | hourly batch | 120 min |
| `nexabank_crm` | Customers, campaigns, interactions | weekly | 7 days |
| `market_ops` | Branch operations and macro environment | monthly | 31 days |

The cadences differ by three orders of magnitude on purpose. A KPI whose numerator refreshes
hourly and whose denominator refreshes weekly can move for reasons that have nothing to do
with the business — the Trust Gate exists to catch exactly that before anything is narrated.

---

## Visual walkthrough

### Architecture

<p align="center">
  <img src="wireframes/architecture.jpeg" alt="Runtime pipeline diagram showing the client, ingestion, broker, storage and analytics layers" width="95%" />
</p>

> This diagram predates the intelligence layer and shows an earlier LLM runtime. Read it for
> the shape of the ingestion path; read [How it works](#how-it-works) for what runs today.

### Feature analytics

<p align="center">
  <img src="wireframes/feature-analysis.png" alt="Feature usage trend lines and top-feature ranking across both tenants" width="92%" />
</p>

### Funnel analysis

<p align="center">
  <img src="wireframes/funnel.png" alt="Funnel progression map and stage-by-stage leakage matrix" width="92%" />
</p>

### License versus usage

<p align="center">
  <img src="wireframes/license-usage.png" alt="Premium feature entitlement compared against observed adoption" width="92%" />
</p>

### Predictive insights

<p align="center">
  <img src="wireframes/predictive.png" alt="Opportunity radar, model pulse and feature adoption predictions" width="92%" />
</p>

### Tenant comparison

<p align="center">
  <img src="wireframes/tenants.png" alt="NexaBank and SafeX Bank compared side by side across KPIs and trends" width="92%" />
</p>

### Trust and transparency

<p align="center">
  <img src="wireframes/transparency.png" alt="Data visibility matrix showing what leaves the premises in cloud mode" width="92%" />
</p>

### AI report

<p align="center">
  <img src="wireframes/ai-report.jpeg" alt="Executive AI report with key takeaways, action plan and analytics snapshot" width="92%" />
</p>

### NexaBank loans

<p align="center">
  <img src="wireframes/Nexabank/loans.png" alt="The NexaBank loan products page with EMI calculator" width="92%" />
</p>

---

## Project structure

```
.
├── api/                     Analytics API (FastAPI, :8001) and the intelligence layer
│   ├── main.py              50 HTTP routes + 1 WebSocket; RBACMiddleware lives here
│   ├── page_map.py          canonicalize_event_name — the READ-side taxonomy dialect
│   ├── websocket_manager.py Per-tenant fan-out: Kafka tail + 10 s ClickHouse poll
│   ├── insights.py          Legacy LLM client with a rule-based fallback
│   └── intelligence/        The deterministic pipeline
│       ├── orchestrator.py  Runs the seven stages in order per KPI
│       ├── service.py       Three scheduler loops: batch, forecast, sweep
│       ├── stages/          trust_gate, detect, localize, decompose, forecast,
│       │                    causal_decide, narrate, llm_narrator
│       ├── metrics.py       The ONLY doorway to data — stages never touch events_raw
│       ├── signal_store.py  One writer per Signal Store table
│       ├── planner.py       Rule and LLM planners behind one interface
│       ├── loop.py          The bounded agent loop
│       ├── tools.py         15 capabilities the planner can choose from
│       ├── personas.py      The six reader personas
│       └── phrasing.py      The single place that decides how a figure reads in English
├── core/                    Shared contracts: models.py (FeatureEvent), event_names.py,
│                            config.py, security.py (PII masking), middleware.py
├── ingestion/main.py        Ingestion API (:8000) — /events, fast seed, /health
├── processing/worker.py     Kafka consumer → ClickHouse batcher, dead letters, backpressure
├── storage/                 ClickHouse client, schema.sql, migrate.py, 19 migrations
├── contracts/               10 KPI contract YAML files — the metric definitions
├── scripts/                 8 operational scripts (see below)
├── tests/                   33 pytest modules — run only via the `test` compose profile
├── e2e/                     Playwright specs: dashboard, NexaBank, API
├── fixtures/                planted_truth.json — the golden-scenario ground truth
├── analytics-dashboard/     FinInsights dashboard (Next.js 16 / React 19, :3001)
├── NexaBank/                The demo bank
│   ├── backend/             Express 4 + Prisma 6 + ws (:5000)
│   │   ├── src/middleware/eventTracker.ts   The producer-side taxonomy and forwarder
│   │   ├── src/scripts/     seedReferenceData, generateDemoData, resetDemoData,
│   │   │                    plantMovement, applyLifecycle
│   │   └── prisma/schema.prisma             17 PostgreSQL models
│   └── frontend/            Next.js 15 / React 18 bank app (:3002)
├── docs/                    16 engineering documents (see the documentation map)
├── skills/                  3 task guides for common changes
├── wireframes/              The screenshots used in this README
├── docker-compose.yml       14 services, 3 profiles, 6 volumes
├── Dockerfile               The shared Python image for four services
├── rbac.json                Roles and personas
├── vllm_entrypoint.sh       Picks a Qwen2.5 AWQ tier by free VRAM
├── CLAUDE.md                The contributor operating manual
└── BUSINESS.md              The non-technical business case
```

### Operational scripts

| Script | What it does |
|---|---|
| `scripts/verify_data_quality.py` | Eight data-quality checks over live ClickHouse. Runs the *real* Node taxonomy function rather than reimplementing it, so it cannot drift |
| `scripts/run_intelligence_gates.py` | 39 end-to-end gates: determinism, the five planted scenarios, entitlement, idempotency, read-path correctness |
| `scripts/seed_data.py` | Scenario seeder that posts through the real ingestion envelope |
| `scripts/taxonomy_probe.js` | Shows what the Node taxonomy dialect does to a list of event names |
| `scripts/investigate_kpi.py` | Re-scores one KPI now instead of waiting for the 15-minute sweep |
| `scripts/reconcile_kafka_offsets.py` | Committed consumer-group offsets versus what actually landed |
| `scripts/find_dual_path_duplicates.py` | Finds events written by both the Kafka and fallback paths |
| `scripts/nexbank_user_lookup.py` | Looks up a NexaBank user, or lists a tenant's admins |

---

## Working on the code

### The one rule that matters

**Run everything through Docker.** `docker compose exec <service> ...` is the default for
every check, query, type-check and script here. A host virtual environment or a host
`node_modules` drifts from the image silently, and the container is what actually executes in
production.

```bash
# Python — /app is the repo root minus NexaBank/ and analytics-dashboard/
docker compose exec analytics-api python -c \
  "from api.page_map import canonicalize_event_name as c; print(c('loan.approved.success'))"

# ClickHouse
docker compose exec clickhouse clickhouse-client --password clickhouse \
  --database feature_intelligence --query "SHOW TABLES"

# TypeScript, without touching host node_modules
docker compose exec analytics-dashboard npx tsc --noEmit
docker compose exec nexabank-backend    npx tsc --noEmit
docker compose exec nexabank-frontend   npx tsc --noEmit

# Logs
docker compose logs -f --tail=100 processor-worker
docker compose logs -f ingestion-api analytics-api intelligence
```

### Running the checks

| Check | Command | What it proves |
|---|---|---|
| Unit and integration suite | `docker compose --profile test run --rm tests` | 33 modules covering envelope validation, dead-letter paths, worker retry, schema/runtime column parity, taxonomy dialects, persona and RBAC registries, every intelligence stage, the query agent |
| One module | `docker compose --profile test run --rm tests python -m pytest tests/test_intelligence_stages.py -v` | Same harness, narrower target |
| Data quality | `docker compose --profile test run --rm -e CLICKHOUSE_URL=http://clickhouse:8123 tests python scripts/verify_data_quality.py` | Taxonomy reachability, event identity, session grain, duplicates, dimension coverage, geo consistency, contract events landed, rollup consistency. Exit 0 only when all pass |
| Intelligence gates | See below | Determinism, the five scenarios, entitlement, idempotency, read path |
| Browser end to end | `docker compose --profile test run --rm e2e` | Playwright over the dashboard, NexaBank and the API |

The intelligence gates need the scheduler stopped first, because it sweeps the same tables on
a timer and every determinism check would fail for a reason unrelated to determinism:

```bash
docker compose stop intelligence

# Re-seed into the gate tenants first, or the planted truth will not match
docker compose --profile test run --rm tests python scripts/seed_data.py --scenario all \
  --tenants gate_alpha,gate_beta --realtime-tenant gate_alpha \
  --users-per-tenant 320 --sessions-per-tenant 700

docker compose --profile test run --rm tests python scripts/run_intelligence_gates.py
docker compose start intelligence
```

> **Treat a skipped test as a failure here.** Twelve regression guards once passed by not
> running at all, because their prerequisites were unmeetable inside the image — and pytest
> reports an unmeetable prerequisite as a skip, which reads as green.

### Adding a tracked event

This is the subtlest thing in the codebase, so it has [its own guide](skills/event-taxonomy/SKILL.md).
The short version: event names are three lowercase dot-separated segments
(`<page>.<feature>.<status>`), and the taxonomy is implemented **three times** — once in Node
at the producer, once on ingest, once on read. None of the three rejects a bad name; every one
*coerces*. So the failure mode is a silent rename, not an error: the row lands in `events_raw`
and vanishes from every chart, with no log line anywhere.

1. Emit it with a three-part name — `trackEvent("loans.emi_estimator.success", ...)` on the
   backend, or `track(...)` / `measureAndTrack(...)` on the frontend.
2. If the raw name is not already three-part, add it to `LEGACY_MAP` in `enforceTaxonomy`
   (`NexaBank/backend/src/middleware/eventTracker.ts`). Do not rely on the generic fallback —
   that is what strands an event in the `core.*` junk namespace.
3. Make sure the read dialect (`canonicalize_event_name` in `api/page_map.py`) resolves it,
   and handle the fact that it can legitimately return `None`.
4. Prove it, rather than reading the code:
   ```bash
   docker compose --profile test run --rm tests \
     node scripts/taxonomy_probe.js NexaBank/backend/src/middleware/eventTracker.ts names.txt
   docker compose --profile test run --rm -e CLICKHOUSE_URL=http://clickhouse:8123 \
     tests python scripts/verify_data_quality.py
   ```

### Adding an analytics endpoint

See [`skills/analytics-endpoint/SKILL.md`](skills/analytics-endpoint/SKILL.md). The essentials:
use a fresh ClickHouse client per call, bind parameters with `%(name)s`, follow the standard
tenant-filter idiom, bound every time window at **both** ends with equal-length current and
previous windows, and never use ClickHouse's `today()` (it is server-local and once split the
KPI card, the traffic chart and the rollup into three different days).

If you change a response shape, update its `lib/api.ts` method, its `types/index.ts` type and
every consumer — including the handlers that other endpoints call internally.

### Building an intelligence stage

See [`skills/intelligence-pipeline/SKILL.md`](skills/intelligence-pipeline/SKILL.md). The
non-negotiables: read data only through the metric layer, write findings to the Signal Store,
derive ids rather than generating them, tag every produced number with its engine, and never
let a model produce a figure that reaches a reader unverified.

---

## Documentation map

| You want to... | Read |
|---|---|
| Understand the system in depth | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Change ClickHouse, add a table, or understand the identity design | [`docs/DATABASE.md`](docs/DATABASE.md) |
| Know the project scope and definition of done | [`docs/PHASE_1.md`](docs/PHASE_1.md) |
| Build a pipeline stage and know its inputs and outputs | [`docs/PIPELINE_CONTRACT.md`](docs/PIPELINE_CONTRACT.md) |
| Define or read a KPI contract | [`docs/KPI_CONTRACT.md`](docs/KPI_CONTRACT.md) |
| Handle a stage's failure modes | [`docs/EDGE_CASES.md`](docs/EDGE_CASES.md) |
| Run or extend a demo scenario | [`docs/SCENARIOS.md`](docs/SCENARIOS.md) |
| Defend a design choice, or plan an upgrade | [`docs/RESEARCH.md`](docs/RESEARCH.md) |
| Know how the intelligence layer is built and what it guarantees | [`docs/INTELLIGENCE_LAYER_PROPOSAL.md`](docs/INTELLIGENCE_LAYER_PROPOSAL.md) |
| Read the standing bug audit | [`docs/FinInsights_Bug_Audit.md`](docs/FinInsights_Bug_Audit.md) |
| Work on the code as a contributor (or an AI agent) | [`CLAUDE.md`](CLAUDE.md) |
| Read the business case | [`BUSINESS.md`](BUSINESS.md) |
| See every NexaBank route on one page | [`NexaBank/ROUTE_MAP.md`](NexaBank/ROUTE_MAP.md) |

Two of these need a caveat. [`docs/VALIDATION_LAYER.md`](docs/VALIDATION_LAYER.md) is **design
only** — nothing it describes is implemented or scheduled. `docs/HANDOFF.md` is a transient
session note that is meant to be deleted when its sequence finishes, so it may not exist.

More broadly: the status documents in this repository have gone stale in *both* directions —
recording work as done that was inert, and later recording work as missing that had shipped.
When a document and the code disagree, believe the code, and re-run the check rather than
trusting either.

---

## Known limitations

Stating these plainly is more useful than pretending otherwise.

- **RBAC is not a production security boundary.** The Analytics API trusts `X-User-Role`,
  `X-User-Email` and `X-Admin-Apps` as identity, the dashboard's browser-side axios layer sets
  them, and port 8001 is published to your host. Anyone who can reach it can assert any role.
  Persona resolution being server-side narrows nothing when the identity it resolves from is
  free text. Hardening this is scoped work that has not been done.
- **Neither Python API authenticates anything.** `POST /events` on port 8000 is open — any
  caller who can reach it can write events under any tenant. The fast-seed and purge routes on
  the same port are equally open.
- **`NEXTAUTH_SECRET` is a committed shared default.** `docker-compose.yml` hardcodes it, and
  compose `environment:` overrides `env_file:`, so whatever you write in `.env.local` is
  ignored at runtime. Rotate it before this goes anywhere real.
- **Geography, device and channel are fabricated on the live path.** They are drawn once per
  session from a weighted table, not measured. The envelope declares this in
  `metadata._simulated`, the dashboard badges anything built on them, and the intelligence
  layer refuses to slice on them outside the seeded dataset — but they are still dice rolls.
- **There is no money field anywhere in the telemetry.** Every clickstream revenue figure is
  modelled from a licence event at a declared constant, and the contract that does so carries
  a qualifier the narrator must repeat verbatim.
- **`pro_revenue` is scored on an event count, not a dollar figure**, and currency units are
  not reconciled across contracts (`fee_revenue` is in INR; three others are in USD). A
  cross-contract revenue roll-up would be mixing currencies.
- **SafeX Bank is a synthetic second tenant, not a second running application.** It exists to
  demonstrate multi-tenancy. The dashboard's "open app" link for it points at a port nothing
  serves.
- **Some published metrics are not quite the quantity their name suggests.** `/tenants/compare`
  publishes an event-count threshold as `conversion_rate`; `/predictive/adoption` publishes a
  bounded growth heuristic as a forecast, with no interval. The intelligence layer's own
  figures go through the numeric verifier; these older endpoints do not.
- **`/insights` and `/ai_report` are not verified.** Only the `/intelligence/*` surface has the
  numeric verifier. The older report endpoints can return model-authored prose, and the
  last-resort branch of `/ai_report` returns a fixed template with a `fallback_reason` field.
- **The Kafka topic has one partition.** The producer keys on tenant and the worker handles
  rebalancing, but none of that is exercised today. Scope any throughput claim accordingly.
- **`docs/` is a mixed bag of current and stale.** See the note in the documentation map.

Scoped-out on purpose (not simply unbuilt) — full synthetic-control causal inference, learning
from recorded outcomes, any autonomy that executes an action without a human signature,
open-ended metric discovery beyond the conservative automatic tier, and per-series trained
forecasters (which would break the zero-training-data property). The reasoning is in
[`docs/PHASE_1.md`](docs/PHASE_1.md).

---

## Troubleshooting

**`docker compose up` fails immediately with an env-file error.**
You have not created `analytics-dashboard/.env.local` and/or `NexaBank/backend/.env`. Neither
is in the repository. See [Installation step 2](#2-create-the-environment-files).

**Every chart is empty and every number is zero.**
The stack seeds nothing on its own. Run [step 7](#7-load-some-data--do-not-skip-this). Then
check `curl -s localhost:8000/health` — if `ingest_path` says `clickhouse_fallback`, events are
landing but Kafka is out of the path.

**`ingest_path: clickhouse_fallback`.**
The broker was unreachable when ingestion started. Events still reach ClickHouse, but the
streaming path is not being exercised. Once `broker` is healthy, `docker compose restart
ingestion-api`. Confirm with the consumer-group check — a `LOG-END-OFFSET` of 0 means nothing
ever arrived.

**`curl localhost:8001/health` returns 404.**
The Analytics API has no `/health` route. Use `GET /deployment/info` as the liveness probe.

**`http://localhost:8001/docs` returns 403.**
The RBAC middleware only exempts `OPTIONS`, `/deployment*`, `/health*`, `/` and `/ws/*`, and a
browser sends no role header. The ingestion API's docs at
[localhost:8000/docs](http://localhost:8000/docs) work normally. To read the analytics schema,
either browse `api/main.py` or call it with the headers attached.

**Simulation returns HTTP 409 "No branches for this tenant".**
Run `seedReferenceData.ts` first. Branches are reference data, and skipping them silently
strips `region` out of every KPI that localizes on it — which is why the route refuses.

**Simulation returns HTTP 409 "No existing customers to simulate".**
By default a run generates activity for customers the bank already has. Pass
`"createAccounts": true` on the first run for that tenant, or use the console's one-click
"Create accounts" action on the toast.

**The extract endpoints return 503.**
`EXTRACT_API_TOKEN` is unset on `nexabank-backend`. Set it in the root `.env` and restart.

**The batch loaders return 401.**
You ran them in `analytics-api`, which deliberately does not carry `EXTRACT_API_TOKEN` — least
privilege. Use `docker compose run --rm --no-deps intelligence ...`.

**I edited a Python file and nothing changed.**
The three Python services bind-mount nothing; their source is baked in at build time. Run
`docker compose up -d --build <service>`. The `--reload` flag in their compose command is
watching files that never change.

**I edited a TypeScript file and nothing changed.**
Those trees *are* bind-mounted, but the watchers do not reliably see writes through a Windows
bind mount. `docker compose restart <service>` before concluding the change is wrong. Note
that `tsc --noEmit` passing proves the mount is current and proves nothing about the running
process — that combination is what makes this one hard to spot.

**I edited `rbac.json` and the dashboard updated but the API did not.**
The dashboard re-reads the file on every request. The Analytics API reads the copy baked into
its image. Run `docker compose up -d --build analytics-api`.

**`npx tsx ...` fails on an offline or locked-down machine.**
`tsx` is not a declared dependency, so `npx` downloads it at run time. The declared TypeScript
runner is `ts-node` — substitute `npx ts-node` for `npx tsx` in the seeding commands.

**The dashboard sends me to `/unauthorized` after signing in.**
Your email is not in `rbac.json`, or you did not add yourself as a **Test user** on the Google
OAuth consent screen. Both are required.

**The intelligence gates report seven determinism failures.**
The scheduler was still running and writing to the same tables mid-comparison. Stop it first —
the gate runner detects this and exits 2 rather than reporting misleading failures.

**vLLM restart-loops with `$'\r': command not found`.**
`vllm_entrypoint.sh` was checked out with CRLF line endings. `.gitattributes` prevents this;
run `git add --renormalize .` or re-clone.

**vLLM dies with "UVA is not available" on WSL2.**
Keep `VLLM_WSL2_ENABLE_PIN_MEMORY=1`.

**A Hugging Face download fails with a CAS client error.**
Keep `HF_HUB_DISABLE_XET=1`, which falls back to plain HTTPS transfers.

**The first visit to each page takes 17–24 seconds.**
That is Next.js dev mode compiling each route on first navigation. Set `NEXT_MODE=production`
to build ahead of time.

**Builds are slow and the images are large.**
`.dockerignore` does not exclude `.venv/`, `wireframes/` or `.pytest_cache/` from the Python
build context, so they are copied into every Python image. Adding them is a one-line fix.

**The `intelligence` container logs connection errors on a cold start.**
It has no `depends_on` for `nexabank-backend` but calls its extract API, so its loader loop
complains until the bank finishes booting. It resolves itself.

---

## FAQ

**Do I need to run all fourteen services?**
No. A bare `docker compose up` starts eleven of them — everything except the GPU profile and
the test profile. That is the normal working set.

**Can I run just the bank, or just the dashboard?**
Yes, but with caveats. `NexaBank/docker-compose.yml` runs the bank alone — useful for
exercising the banking UI, but it sets no ingestion URL, so telemetry goes nowhere. The
dashboard has its own Dockerfile, but running it alone needs `ANALYTICS_API_HOST` and
`INGESTION_API_HOST` pointed at reachable services or every request loops back to the
container itself. For anything analytical, use the root compose file.

**Is an NVIDIA GPU required?**
No. The language model is off by default and the platform is complete without it — the
deterministic template covers every demo scenario and is bit-exact. The GPU is only for
phrasing findings more fluently.

**Why is there no `/health` on the Analytics API?**
An oversight rather than a decision; the RBAC middleware even exempts the path. Use
`GET /deployment/info`.

**Why does the same event name resolve differently depending on where it came from?**
Because the taxonomy is implemented three times and the dialects disagree about the reserved
`free.` / `pro.` prefixes. An event posted straight to the ingestion API keeps them; one that
went through the NexaBank backend has them stripped. Twelve producer names currently differ
between the two paths. This is documented rather than fixed because fixing it would rewrite
history in the warehouse.

**How do I point this at my own application instead of NexaBank?**
Emit events that satisfy the envelope, then add your tenant id to the four maps that must
agree: `api/main.py`, `analytics-dashboard/src/lib/feature-map.ts`,
`NexaBank/backend/src/middleware/eventTracker.ts` and `rbac.json` — plus
`INTELLIGENCE_TENANTS` in `docker-compose.yml`. Then write a KPI contract for anything you
want the full investigation depth on; everything else gets the conservative automatic
treatment for free.

**How do I add a new KPI?**
Write a YAML file in [`contracts/`](contracts/) declaring what it means, its additive
fundamentals, its sliceable dimensions, its detection thresholds, and its closed list of
levers. No code changes. [`docs/KPI_CONTRACT.md`](docs/KPI_CONTRACT.md) is the reference.

**Does the AI ever make up a number?**
It is designed not to be able to. Every figure in a narrative must match a value from a stored
row within tolerance; an unverifiable draft is stripped to the headline or the answer abstains.
Note the scope: this applies to the `/intelligence/*` surface. The older `/insights` and
`/ai_report` endpoints do not have that verifier.

**Why does a Trust Gate failure still produce output?**
Because "the data is corrupted" is a genuine answer and a useful one. The run terminates the
business path and issues an engineering incident note instead — the whole point being that a
data defect never gets narrated as a business finding.

**Can I make my own account a NexaBank admin?**
Not through a script — there is no promotion path in the repository. Set `SYSTEM_PASSWORD` in
`NexaBank/backend/.env` before the first boot and sign in as `SYSTEM_EMAIL`, or flip
`Customer.role` to `ADMIN` in PostgreSQL directly.

**Why does `docker compose down -v` not clear the bank's data?**
Because the bank's database is external. `down -v` destroys the ClickHouse, Kafka and model
volumes only. Use `resetDemoData.ts` for the PostgreSQL side.

**Are there secrets in this repository?**
No `.env` file is tracked — only `.env.example`. Two things do warrant attention: the
`NEXTAUTH_SECRET` default hardcoded in `docker-compose.yml`, and `rbac.json`, which ships with
the maintainers' real email addresses. If you fork this, clear `rbac.json` and rotate that
secret.

---

## Maintainers

| Maintainer | GitHub |
|---|---|
| Abhishek Kumawat | [@abhishekkumawat-47](https://github.com/abhishekkumawat-47) |
| Omesh Mehta | [@Omesh2004](https://github.com/Omesh2004) |
| Vinod Singh Rathore | [@vin0drath0re](https://github.com/vin0drath0re) |

Contributions are welcome. Before opening a pull request, please read
[`CLAUDE.md`](CLAUDE.md) — it carries the working rules that keep this codebase honest, and
run the test suite and the data-quality gate:

```bash
docker compose --profile test run --rm tests
docker compose --profile test run --rm -e CLICKHOUSE_URL=http://clickhouse:8123 \
  tests python scripts/verify_data_quality.py
```

---

## License

No license file is currently present in this repository. All rights are reserved by the
maintainers until one is added.
