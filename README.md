# FinInsights

A KPI intelligence-to-action engine for a bank, and the bank that feeds it.

**NexaBank** is a working retail bank — customers, accounts, transactions, loans and their KYC
steps, cards, campaigns, branches. It generates real banking activity and the behavioural
telemetry that accompanies it, and it holds the Simulate console that plants anomalies *in the
source data*.

**FinInsights** watches that activity, decides whether a movement is trustworthy, finds the
segment responsible, projects where it is heading, recommends an action with a named owner, and
writes the finding in plain English — with every figure traceable to a stored piece of evidence.

The governing document is [CLAUDE.md](CLAUDE.md). Read it before writing code. This README covers
only how to run the thing.

## Documentation

Markdown lives in `docs/` and nowhere else.

| Document | What it answers |
|---|---|
| [docs/SOLUTION.md](docs/SOLUTION.md) | What we are building and why, in plain English |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit and how data flows between them |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Bronze, Silver and Gold — what lives in each layer |
| [docs/INTELLIGENCE.md](docs/INTELLIGENCE.md) | The agent, its six tools, and the verifier |

## Running it

Everything runs in Docker. Do not use a host `.venv`, a host `node`, or `npm run` — those
environments drift from the images without warning.

```bash
docker compose up -d
```

| Service | Port | What it is |
|---|---|---|
| `analytics-dashboard` | 3001 | FinInsights dashboard (Next.js) |
| `nexabank-frontend` | 3002 | NexaBank retail banking app (Next.js) |
| `nexabank-backend` | 5000 | NexaBank API + Simulate engine (Express/Prisma/Postgres) |
| `ingestion-api` | 8000 | Event intake, masking, deterministic event ids (FastAPI) |
| `analytics-api` | 8001 | Metric API + the intelligence layer (FastAPI) |
| `vllm-server` | 8002 | Local narrator model — opt-in, `--profile gpu` |
| `clickhouse` | 8123 | The warehouse |
| `broker` | 9092 | Kafka — transport only, never the system of record |

The stack is complete without the narrator. `INTELLIGENCE_LLM=0` (the default) produces every
number and every finding; only the prose changes.

### Rebuilding after an edit

The three Python services (`ingestion-api`, `analytics-api`, `processor-worker`) bind-mount
nothing. Their source is baked in at build time, so `--reload` is watching files that never
change:

```bash
docker compose up -d --build analytics-api
```

The Node services (`nexabank-backend`, `nexabank-frontend`, `analytics-dashboard`) do bind-mount
`src`, but neither watcher reliably sees a write through a Windows bind mount. Restart before
judging a change:

```bash
docker compose restart nexabank-backend
```

### Checking your work

```bash
# Query the warehouse
docker compose exec clickhouse clickhouse-client --password clickhouse \
  --database feature_intelligence --query "SELECT count() FROM events_raw"

# Type-check a TypeScript project without touching host node_modules
docker compose exec analytics-dashboard npx tsc --noEmit

# Run the Python suite. A SKIP is a failure until you have read its reason.
docker compose --profile test run --rm tests

# Confirm Kafka is carrying events rather than silently running the ClickHouse fallback
curl -s localhost:8000/health          # ingest_path: kafka | clickhouse_fallback
```

## Rebuild status

The repository is mid-migration from a prototype into the structure CLAUDE.md section 12
describes. The state before the migration is recoverable at tag `pre-cleanup-2026-08-31`.

| Phase | What it does | State |
|---|---|---|
| P0 | Delete stale docs, junk, dead code | done |
| P1 | Move to the section 12 folder structure; split the 4,176-line `api/main.py` | next |
| P2 | Freeze the four interfaces; rewrite `contracts/` to the five-KPI chain | |
| P3 | NexaBank generates the full banking domain; Simulate console with anomaly templates | |
| P4 | Bronze / Silver / Gold in ClickHouse | |
| P5 | Rebuild the intelligence agent against the live Metric API | |

## Secrets

Never commit one. `.env.example` lists every variable the stack reads; copy it to `.env` and fill
it in. Credentials are read from the environment, never from source.
