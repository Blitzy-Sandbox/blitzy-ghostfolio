# Ghostfolio — Local Setup Guide

> Refine PR Directive 7 — Local development setup, end-to-end. Eight
> ordered steps from a fresh clone to a running stack, plus dedicated
> sections for AI provider configuration and Snowflake credentials.

This guide walks operators through a complete from-scratch local setup of
the Ghostfolio v3.0.0 codebase **including the AI Portfolio Intelligence
Layer** (chat, rebalancing, financial profile) introduced by the Agent
Action Plan.

For deeper coverage of the day-to-day developer workflow (HMR, Storybook,
testing patterns), see [`DEVELOPMENT.md`](./DEVELOPMENT.md).

---

## Prerequisites

- **Node.js** `>=22.18.0` (the repo's `.nvmrc` pins v22; `engines.node` in
  `package.json` enforces this lower bound)
- **npm** `10.x` (bundled with Node 22)
- **Docker** + **Docker Compose** (Docker Desktop on macOS / Windows; the
  `docker compose` CLI plugin on Linux)
- A clone of this repository on your local filesystem

---

## Eight-Step Setup

### Step 1 — Verify Required Ports Are Free

Ghostfolio uses the following local ports:

| Port | Service                     |
| ---- | --------------------------- |
| 3333 | API server (NestJS)         |
| 4200 | Client dev server (Angular) |
| 5432 | PostgreSQL (Docker)         |
| 6379 | Redis (Docker)              |

Confirm each port is free before starting:

```bash
lsof -i :3333 -i :4200 -i :5432 -i :6379
```

If any port is occupied, either stop the conflicting service or override
Ghostfolio's port via the corresponding environment variable
(see step 2).

---

### Step 2 — Configure Environment Variables

Copy the template into a working `.env` file:

```bash
cp .env.example .env
```

Open `.env` and populate every `<INSERT_*>` placeholder. At minimum, set:

- `REDIS_PASSWORD` — any random string
- `POSTGRES_PASSWORD` — any random string (must match Docker init)
- `ACCESS_TOKEN_SALT` — any random string
- `JWT_SECRET_KEY` — any random string

The AI provider and Snowflake variables are documented in their dedicated
sections below.

---

### Step 3 — Start PostgreSQL and Redis via Docker

The dev compose file at `docker/docker-compose.dev.yml` provisions
PostgreSQL and Redis with the credentials from `.env`:

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

Verify both containers are healthy:

```bash
docker compose -f docker/docker-compose.dev.yml ps
```

---

### Step 4 — Install Node Dependencies

```bash
npm install
```

This step also runs `prisma generate` as a postinstall hook, materializing
the typed Prisma client into `node_modules/@prisma/client` (including the
`FinancialProfile` model and `RiskTolerance` enum added by the AAP).

---

### Step 5 — Apply Database Migrations

Push the schema (development mode — no migration history required):

```bash
npm run database:push
```

For a production-style deployment, replace `database:push` with
`database:migrate` to apply the timestamped migrations under
`prisma/migrations/` exactly as committed.

---

### Step 6 — Seed Initial Data

```bash
npm run database:seed
```

`database:seed` runs the seed script defined under `"prisma.seed"` in
`package.json` and bootstraps platforms, currencies, exchange rates, and
sample symbol profiles.

---

### Step 7 — Start the API Server

In one terminal:

```bash
npm run start:server
```

The API listens at `http://localhost:3333` by default. The OpenAPI
documentation is mounted at:

- **Swagger UI:** http://localhost:3333/docs
- **OpenAPI JSON:** http://localhost:3333/docs-json

Health endpoint: `GET http://localhost:3333/api/v1/health`

---

### Step 8 — Start the Client

In a second terminal:

```bash
npm run start:client
```

The client serves on `https://localhost:4200/en`. Open that URL in your
browser, click **Get Started** to create the first user (which receives
the `ADMIN` role), and sign in.

The AI panel appears in the portfolio page sidebar; the rebalancing tab
is available at `/portfolio/rebalancing`; the financial-profile dialog
opens from the user-account page.

---

## AI Provider Configuration

The AI Portfolio Chat Agent (Feature B) and the Explainable Rebalancing
Engine (Feature C) route their LLM calls through `AiProviderService`,
which selects a backend based on the `AI_PROVIDER` environment variable.

### Provider Selection

Set `AI_PROVIDER` in your `.env` to one of:

| Value       | SDK Package         | Default Model                | Required Env Var(s) |
| ----------- | ------------------- | ---------------------------- | ------------------- |
| `anthropic` | `@ai-sdk/anthropic` | `claude-3-5-sonnet-20241022` | `ANTHROPIC_API_KEY` |
| `openai`    | `@ai-sdk/openai`    | `gpt-4o`                     | `OPENAI_API_KEY`    |
| `google`    | `@ai-sdk/google`    | `gemini-1.5-pro`             | `GOOGLE_API_KEY`    |
| `ollama`    | `@ai-sdk/openai` \* | `llama3.1`                   | `OLLAMA_BASE_URL`   |

\* Ollama is reached via the OpenAI-compatible `/v1` endpoint exposed by
the local Ollama server.

When `AI_PROVIDER` is unset, the service defaults to `anthropic`.

### Optional Model Override

`AI_MODEL` overrides the default model identifier for the selected
provider. Examples:

```bash
# Force Anthropic to use the smaller Claude 3 Haiku model
AI_PROVIDER=anthropic
AI_MODEL=claude-3-haiku-20240307
```

Setting `AI_MODEL=` (empty string) is treated identically to leaving it
unset — the provider's default model is used.

### Local Inference With Ollama

To run the AI features entirely offline, install
[Ollama](https://ollama.com), pull a tool-use-capable model, and point
the application at the local server:

```bash
# 1. Install Ollama (macOS / Linux)
brew install ollama        # or follow https://ollama.com/download

# 2. Pull a model that supports forced tool use
ollama pull qwen2.5:7b

# 3. Configure Ghostfolio
echo "AI_PROVIDER=ollama" >> .env
echo "AI_MODEL=qwen2.5:7b" >> .env
echo "OLLAMA_BASE_URL=http://localhost:11434/v1" >> .env

# 4. Start Ollama server
ollama serve
```

> **Important:** The Explainable Rebalancing Engine relies on
> `toolChoice: 'required'`. Models that do not honor forced tool
> invocation will yield HTTP 502 with outcome label `no_tool_use`. The
> Anthropic, OpenAI, and Google flagship models honor this flag; for
> Ollama, prefer `qwen2.5:7b` or larger function-calling-capable models.

### Provider-Aware Health Check

`GET http://localhost:3333/api/v1/health/anthropic` is a provider-aware
probe (despite the legacy route name) and returns:

- `200 OK` when the credential for the configured `AI_PROVIDER` is
  present (or always for `ollama`)
- `503 Service Unavailable` when the credential is missing (except
  `ollama`, which is always healthy)

---

## Snowflake Configuration

The Snowflake Sync Layer (Feature A) mirrors portfolio snapshots, trade
history, and performance metrics into Snowflake as an append-only
analytical backend. The chat agent's `query_history` tool also queries
Snowflake.

### Required Environment Variables

```bash
SNOWFLAKE_ACCOUNT=<your_snowflake_account_locator>
SNOWFLAKE_USER=<your_snowflake_username>
SNOWFLAKE_PASSWORD=<your_snowflake_password>
SNOWFLAKE_DATABASE=<your_database_name>
SNOWFLAKE_WAREHOUSE=<your_warehouse_name>
SNOWFLAKE_SCHEMA=<your_schema_name>
```

All values are read exclusively via NestJS `ConfigService` — direct
`process.env` access is forbidden in the new modules (Rule 3).

### Bootstrap Schema

On first startup, `SnowflakeSyncService` runs the DDL bootstrap script
at `apps/api/src/app/snowflake-sync/sql/bootstrap.sql` (with
`CREATE TABLE IF NOT EXISTS` semantics). The script creates three
tables:

- `portfolio_snapshots` — daily allocation snapshots, keyed by
  `(snapshot_date, user_id, asset_class)`
- `orders_history` — trade history, keyed by `(order_id)`
- `performance_metrics` — per-day TWR / volatility / Sharpe ratio,
  keyed by `(metric_date, user_id)`

All write operations use MERGE (upsert) statements with `snowflake-sdk`
bind variables — re-running the sync produces zero duplicate rows
(Rule 7).

### Running Without Snowflake

If you don't have a Snowflake account, leave the
`SNOWFLAKE_*` variables as the `<INSERT_*>` placeholders. The
application will start successfully, but:

- The daily cron (`0 2 * * *` UTC) will log connection errors
- The chat agent's `query_history` tool will return errors when the
  model invokes it
- The rebalancing engine (which does not require Snowflake) continues
  to function normally

### Manual Sync Trigger

Admins can trigger an out-of-band sync via:

```bash
curl -X POST http://localhost:3333/api/v1/snowflake-sync/trigger \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## Verification

After completing the eight-step setup, verify the full system:

```bash
# 1. Health check (basic)
curl -s http://localhost:3333/api/v1/health

# 2. Health check (AI provider)
curl -s http://localhost:3333/api/v1/health/anthropic

# 3. Health check (Snowflake)
curl -s http://localhost:3333/api/v1/health/snowflake

# 4. Swagger UI
open http://localhost:3333/docs

# 5. OpenAPI JSON
curl -s http://localhost:3333/docs-json | head

# 6. Run the test suite
npm test
```

---

## Troubleshooting

- **`npm install` fails with peer-dependency errors** — Make sure Node
  is `>=22.18.0` (`node --version`).
- **Prisma client out of sync** — Run `npx prisma generate`.
- **Docker containers cannot bind to port 5432 / 6379** — Stop any
  local PostgreSQL / Redis services before running
  `docker compose up`.
- **`invalid x-api-key` in API logs** — Set the credential variable
  matching `AI_PROVIDER`. For Ollama, no key is required but
  `OLLAMA_BASE_URL` must be reachable.
- **Rebalancing returns HTTP 502 with `no_tool_use` outcome** — The
  configured model does not support forced tool invocation. Switch to
  a flagship model (Claude 3.5 Sonnet, GPT-4o, Gemini 1.5 Pro) or a
  larger Ollama model (e.g. `qwen2.5:7b` or larger).

---

## Next Steps

- Read [`DEVELOPMENT.md`](./DEVELOPMENT.md) for ongoing development
  workflow (HMR, debugging, Storybook).
- Read the Agent Action Plan
  (`blitzy/documentation/Project Guide.md`) for the architectural
  rationale behind the AI Portfolio Intelligence Layer.
- Read `docs/decisions/agent-action-plan-decisions.md` for the
  explicit decision log, including the version-reconciliation
  decisions (Angular 19 → 21.2.7, Prisma 6 → 7.7.0).
