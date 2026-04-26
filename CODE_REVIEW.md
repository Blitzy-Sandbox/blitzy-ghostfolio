---
title: 'Code Review — AI Portfolio Intelligence Layer (Features A, B, C)'
review_id: AAP-AI-PORTFOLIO-2025
created_at: 2026-04-26
target_branch: blitzy-2e26f4e6-12a6-424a-84aa-c6107f7b6c02
base_branch: main
aap_reference: '§ 0.7.2 Segmented PR Review'
phases:
  - name: Infrastructure / DevOps
    phase: 1
    status: OPEN
    file_count: 3
  - name: Security
    phase: 2
    status: OPEN
    file_count: 10
  - name: Backend Architecture
    phase: 3
    status: OPEN
    file_count: 27
  - name: QA / Test Integrity
    phase: 4
    status: OPEN
    file_count: 11
  - name: Business / Domain
    phase: 5
    status: OPEN
    file_count: 4
  - name: Frontend
    phase: 6
    status: OPEN
    file_count: 18
  - name: Other SME (Snowflake)
    phase: 7
    status: OPEN
    file_count: 3
  - name: Principal Reviewer
    phase: 8
    status: OPEN
    file_count: 68
---

# Code Review — AI Portfolio Intelligence Layer

> **Review Document Status:** This file was generated **at the moment review begins** per the explicit deferral in **AAP § 0.6.1.8**. All eight phases are initialized with `status: OPEN`. Each Expert Agent updates the corresponding phase block (status, sign-off, findings) as the review progresses. The Principal Reviewer in **Phase 8** consolidates the seven prior phases into the final approval decision.

## Executive Summary

### Scope of Change

This pull request introduces the **AI Portfolio Intelligence Layer** described in the parent Agent Action Plan (AAP). The change is **strictly additive** with respect to the pre-existing Ghostfolio v3.0.0 source surface. The complete in-scope inventory is:

| Category                            |   Count | Detail                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New NestJS backend modules          |   **4** | `SnowflakeSyncModule`, `AiChatModule`, `RebalancingModule`, `UserFinancialProfileModule`                                                                                                                                                                                                                                 |
| New NestJS supporting modules       |   **2** | `MetricsModule` (Observability rule), additive `HealthIndicator`s in `HealthModule`                                                                                                                                                                                                                                      |
| New Prisma model + enum             |   **2** | `FinancialProfile` model (1:1 → `User`, cascade delete); `RiskTolerance` enum (`LOW`/`MEDIUM`/`HIGH`)                                                                                                                                                                                                                    |
| New Angular components              |   **3** | `ChatPanelComponent`, `FinancialProfileFormComponent`, `RebalancingPageComponent`                                                                                                                                                                                                                                        |
| New Angular client services         |   **3** | `AiChatService`, `RebalancingService`, `FinancialProfileService`                                                                                                                                                                                                                                                         |
| New env-var placeholders            |   **7** | `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_SCHEMA`, `ANTHROPIC_API_KEY`                                                                                                                                                                        |
| New npm dependencies                |   **3** | `@anthropic-ai/sdk@^1.0.0`, `snowflake-sdk@^1.14.0`, `@types/snowflake-sdk@^1.6.24` (devDep)                                                                                                                                                                                                                             |
| Wiring-only edits to existing files |   **8** | `apps/api/src/app/app.module.ts`, `prisma/schema.prisma`, `apps/client/src/app/app.routes.ts`, `apps/client/src/app/pages/portfolio/portfolio-page.html`, `apps/client/src/app/pages/user-account/user-account-page.ts`, `.env.example`, `libs/common/src/lib/permissions.ts`, `libs/common/src/lib/interfaces/index.ts` |
| New API endpoints                   |   **4** | `POST /api/v1/ai/chat` (SSE), `POST /api/v1/ai/rebalancing`, `GET /api/v1/user/financial-profile`, `PATCH /api/v1/user/financial-profile`                                                                                                                                                                                |
| New Snowflake tables (analytical)   |   **3** | `portfolio_snapshots`, `orders_history`, `performance_metrics`                                                                                                                                                                                                                                                           |
| **Total in-scope files**            | **~68** | Sum across all eight phases (including specs, docs, migrations)                                                                                                                                                                                                                                                          |

### Risk Profile

| Risk Surface                                             | Severity                | Mitigations                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential handling (`ANTHROPIC_API_KEY`, `SNOWFLAKE_*`) | **Medium**              | Rule 3 — `ConfigService`-only access; Phase 2 grep gate verifies zero `process.env.ANTHROPIC` / `process.env.SNOWFLAKE` references in new code.                      |
| SQL injection via `query_history` chat tool              | **Medium**              | Rule 2 — `snowflake-sdk` bind variables (`?` placeholders + `binds: [...]`). Phase 2 grep gate verifies zero string concatenation/template literals adjacent to SQL. |
| Cross-user data exposure on `FinancialProfile`           | **Medium**              | Rule 5 — every Prisma op scoped to `request.user.id` (JWT-derived). Phase 2 audit verifies.                                                                          |
| SSE backpressure / silent stream failure                 | **Low–Medium**          | Rule 6 — `ChatPanelComponent` displays non-empty `errorMessage` and reconnect button on stream error.                                                                |
| Snowflake idempotency on cron re-run                     | **Low–Medium**          | Rule 7 — MERGE upsert keyed on documented unique constraints.                                                                                                        |
| Disturbance of pre-existing surface                      | **Low** (additive-only) | Hard scope boundary at AAP § 0.6.1; only eight existing files modified, all wiring-only.                                                                             |
| Existing F-020 (`AiModule`) regression                   | **Low**                 | F-020 is read-only context; new `AiChatModule` and `RebalancingModule` are separate modules under distinct controller prefixes.                                      |
| Build / lint regression                                  | **Low**                 | Gate 1 + Gate 2 verify zero TypeScript errors and zero failing pre-existing tests.                                                                                   |

### Acceptance Gate Readiness (AAP § 0.7.5)

The following twelve gates MUST pass before Phase 8 (Principal Reviewer) can mark the review `APPROVED`:

| Gate                    | Description                                                                                                           | Owning Phase      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Gate 1                  | `npm run build` completes with zero TypeScript errors                                                                 | Phase 1           |
| Gate 2                  | `npm run test` passes pre-existing test suite (no regressions)                                                        | Phase 4           |
| Gate 8                  | All four new endpoints return non-500 on valid JWT + body                                                             | Phase 5           |
| Gate 9                  | All four new modules registered in `AppModule.imports`; `/portfolio/rebalancing` resolves; `<app-chat-panel>` renders | Phase 3 + Phase 6 |
| Gate 10                 | App starts with all 7 new env vars present; descriptive error if absent                                               | Phase 1           |
| Gate 11                 | (implicit) Parameterized Snowflake queries (Rule 2)                                                                   | Phase 2 + Phase 7 |
| Gate 12                 | All 7 new env vars present in `.env.example`; `ConfigService.get(...)` resolves each                                  | Phase 1           |
| Gate 13                 | Every provider in each new module is injected by ≥1 controller/service                                                | Phase 3           |
| Snowflake Sync Gate     | Cron registration + event handler + idempotency on re-run                                                             | Phase 7           |
| Chat Agent Gate         | `Content-Type: text/event-stream`; first token < 3 s; all 4 tools registered                                          | Phase 6           |
| Rebalancing Engine Gate | Response sourced from `tool_use` content block; non-empty `rationale` + `goalReference`                               | Phase 3 + Phase 5 |
| Financial Profile Gate  | 200 after PATCH; 404 (not 500) on absent record; 400 on invalid `retirementTargetAge`                                 | Phase 3 + Phase 6 |
| Security Sweep Gate     | Zero `process.env.ANTHROPIC` / `process.env.SNOWFLAKE` refs; zero SQL string concat; 401 on no JWT                    | Phase 2           |

### Review Workflow

```
Phase 1 (Infra/DevOps) → Phase 2 (Security) → Phase 3 (Backend Architecture)
   → Phase 4 (QA / Tests) → Phase 5 (Business / Domain) → Phase 6 (Frontend)
   → Phase 7 (Other SME — Snowflake) → Phase 8 (Principal Reviewer)
```

Each phase blocks the next: a `BLOCKED` or `CHANGES REQUESTED` status on phase _n_ must be resolved (i.e., status flipped to `APPROVED`) before phase _n+1_ may begin its review work. The `IN_PROGRESS` status indicates an Expert Agent has claimed the phase but has not yet reached a decision.

---

## Phase 1 — Infrastructure / DevOps

**Phase status: `OPEN`**
**Owning Expert Agent:** _unassigned_

### Scope

| File                | Change Kind                                                                                      | AAP Reference        |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------- |
| `package.json`      | ADD `@anthropic-ai/sdk@^1.0.0`, `snowflake-sdk@^1.14.0`, `@types/snowflake-sdk@^1.6.24` (devDep) | § 0.3.1.1, § 0.3.2.2 |
| `package-lock.json` | Auto-regenerated by `npm install` (no manual edits)                                              | § 0.3.2.2            |
| `.env.example`      | APPEND seven env-var placeholders for `SNOWFLAKE_*` (×6) and `ANTHROPIC_API_KEY`                 | § 0.5.1.2, § 0.6.1.7 |

This phase is **explicitly NOT** responsible for editing `Dockerfile`, `docker-compose*.yml`, `.github/workflows/*.yml`, `nx.json`, or `tsconfig*.json` — none of those is in AAP scope (§ 0.6.2 confirms).

### Review Checklist

- [ ] `package.json` `dependencies` includes exactly `"@anthropic-ai/sdk": "^1.0.0"` and `"snowflake-sdk": "^1.14.0"` (caret pin verbatim from AAP § 0.3.1.1).
- [ ] `package.json` `devDependencies` includes exactly `"@types/snowflake-sdk": "^1.6.24"`.
- [ ] No transitive dependency churn: existing dependency block is preserved verbatim aside from the three new entries (a `git diff package.json` shows three additions and no removals).
- [ ] `package-lock.json` is regenerated via `npm install` and committed; lockfile is reproducible (`npm ci` succeeds clean from the lockfile).
- [ ] `.env.example` contains all seven new placeholder lines under a clearly labeled comment header (`# AI / Snowflake (added by Agent Action Plan)`); existing entries are preserved byte-for-byte.
- [ ] **Gate 1:** `npm run build` completes with zero TypeScript errors after all changes.
- [ ] **Gate 10:** Application starts successfully when all seven new env vars are present (using `.env.dev` or a populated `.env`); application emits a descriptive startup error (not an unhandled exception) when any required env var is absent.
- [ ] **Gate 12:** All seven new env vars are present in `.env.example` with placeholder values; `ConfigService.get(...)` resolves each at runtime without returning `undefined`.
- [ ] No CI/CD workflow file is modified; `nx.json`, `tsconfig*.json`, `eslint.config.cjs` are unchanged (per AAP § 0.3.2.2).
- [ ] No real credential or secret value is committed in any file (placeholder `<INSERT_*>` strings only, consistent with the existing `.env.example` convention).

### Status & Sign-Off

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | `OPEN` — Awaiting Phase 1 Expert Agent assignment |
| Reviewer      | _unassigned_                                      |
| Decision date | —                                                 |
| Findings      | —                                                 |

### Handoff Notes for Phase 2 (Security)

When Phase 1 marks `APPROVED`, document the following for Phase 2:

1. **Confirmed env-var rotation surface.** Phase 2 must verify that each of the seven new env vars is read **only** through `ConfigService` and never through `process.env.*`.
2. **Confirmed lockfile integrity.** Phase 2 must perform a security audit of the freshly installed transitive dependency tree (`npm audit --production`).
3. **No secrets committed.** Phase 2 must run a secret-scanning sweep (e.g., `git log -p | grep -E '(ANTHROPIC|SNOWFLAKE).*[A-Za-z0-9]{20,}'`) to confirm no real credentials slipped into the diff.

---

## Phase 2 — Security

**Phase status: `OPEN`**
**Owning Expert Agent:** _unassigned_

### Scope (Rules 2, 3, 5 from AAP § 0.7.1)

| Rule                                             | Scope of Verification                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rule 2 — Parameterized Snowflake Queries**     | All SQL execution in `apps/api/src/app/snowflake-sync/snowflake-sync.service.ts` and `apps/api/src/app/snowflake-sync/sql/bootstrap.sql`; `query_history` tool implementation in `apps/api/src/app/ai-chat/ai-chat.service.ts`. |
| **Rule 3 — Credential Access via ConfigService** | All new module files. Specifically: `snowflake-client.factory.ts`, `snowflake-sync.service.ts`, `ai-chat.service.ts`, `rebalancing.service.ts`.                                                                                 |
| **Rule 5 — Financial Profile Authorization**     | Every Prisma operation on `FinancialProfile` in `user-financial-profile.service.ts` and any other new service that reads/writes the model.                                                                                      |

### Review Checklist

#### Rule 2 — Parameterized Snowflake Queries

- [ ] Run: `grep -rnE '(\\\$\\{|\\+ *\\\")' apps/api/src/app/snowflake-sync/ apps/api/src/app/ai-chat/` — verify NO matches that adjoin a SQL fragment string.
- [ ] Manually inspect every `connection.execute({...})` call in `snowflake-sync.service.ts`: each `sqlText` MUST be a static string with `?` placeholders; each parameter MUST appear in the `binds: [...]` array.
- [ ] `bootstrap.sql` contains pure DDL only (no parameters) — `CREATE TABLE IF NOT EXISTS` is acceptable as a literal SQL string because no user input flows into it.
- [ ] `query_history` tool dispatch in `ai-chat.service.ts` passes `binds` straight through to `snowflakeSyncService.queryHistory(userId, sql, binds)` without manipulation.
- [ ] **Defense-in-depth:** `query_history` rejects any `sql` argument containing `;` outside string literals (per AAP § 0.5.1.5).
- [ ] **Defense-in-depth:** `query_history` applies a row-count cap to result sets (e.g., max 1,000 rows returned to Claude).

#### Rule 3 — Credential Access via ConfigService

- [ ] Run: `grep -rn 'process\\.env\\.\\(ANTHROPIC\\|SNOWFLAKE\\)' apps/api/src/app/snowflake-sync/ apps/api/src/app/ai-chat/ apps/api/src/app/rebalancing/ apps/api/src/app/user-financial-profile/` — verify ZERO matches.
- [ ] Every constructor in the four new services injects `ConfigService` from `@nestjs/config`.
- [ ] Anthropic SDK clients are constructed via `new Anthropic({ apiKey: configService.get<string>('ANTHROPIC_API_KEY') })` — never `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`.
- [ ] Snowflake connections are constructed via `snowflake.createConnection({ account: configService.get<string>('SNOWFLAKE_ACCOUNT'), ... })` — never via `process.env.SNOWFLAKE_*`.
- [ ] `Logger` calls in new services NEVER emit raw `apiKey`, `password`, or `binds` arrays without redaction (per AAP § 0.7.3 logging-redaction rule).

#### Rule 5 — Financial Profile Authorization

- [ ] Every `prisma.financialProfile.findUnique(...)`, `findFirst(...)`, `update(...)`, `upsert(...)`, `delete(...)` call in `user-financial-profile.service.ts` includes a `where: { userId }` filter.
- [ ] The `userId` value used in every Prisma call is derived from the JWT payload (e.g., `request.user.id`) — never from request body, query string, or URL parameter.
- [ ] `UserFinancialProfileController` reads `request.user.id` and passes it to the service as the FIRST positional argument; the service signature MUST require `userId` (i.e., it is not optional).
- [ ] `AiChatService.dispatchTool(...)` overrides any tool-supplied `userId` with the JWT-authenticated value before delegating to downstream services (per AAP § 0.5.1.5 final paragraph).
- [ ] **Negative test:** A user with id `A` cannot read or modify the `FinancialProfile` row of user `B` even with a forged request body containing `userId: 'B'`.

#### Endpoint authentication & authorization

- [ ] `POST /api/v1/ai/chat` returns HTTP 401 without a valid JWT.
- [ ] `POST /api/v1/ai/rebalancing` returns HTTP 401 without a valid JWT.
- [ ] `GET /api/v1/user/financial-profile` returns HTTP 401 without a valid JWT.
- [ ] `PATCH /api/v1/user/financial-profile` returns HTTP 401 without a valid JWT.
- [ ] `POST /api/v1/snowflake-sync/trigger` returns HTTP 401 without a valid JWT and HTTP 403 without the `triggerSnowflakeSync` permission.
- [ ] All four user-facing endpoints use the canonical `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` pattern matching `apps/api/src/app/endpoints/ai/ai.controller.ts`.

#### Logging redaction

- [ ] Structured log emissions in `snowflake-sync.service.ts` redact `binds` array values that resemble credentials (e.g., long alphanumeric tokens).
- [ ] Structured log emissions in `ai-chat.service.ts` and `rebalancing.service.ts` redact `apiKey` and message-content fields that may contain user PII.
- [ ] No `console.log(...)` statements with raw secrets exist in any new file.

### Status & Sign-Off

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | `OPEN` — Awaiting Phase 2 Expert Agent assignment |
| Reviewer      | _unassigned_                                      |
| Decision date | —                                                 |
| Findings      | —                                                 |

### Handoff Notes for Phase 3 (Backend Architecture)

When Phase 2 marks `APPROVED`, document the following for Phase 3:

1. **Credential surface confirmed clean.** Phase 3 may proceed without re-auditing credentials and can focus purely on architectural rules (1, 4, 7, 8).
2. **JWT-derived `userId` is authoritative.** Phase 3 must verify that the four new modules respect this pattern in their service signatures.
3. **Bind-variable convention is enforced.** Phase 3 must verify that the MERGE statements (Rule 7) consume the bind-variable convention proven in Phase 2.

---

## Phase 3 — Backend Architecture

**Phase status: `OPEN`**
**Owning Expert Agent:** _unassigned_

### Scope (Rules 1, 4, 7, 8 from AAP § 0.7.1)

| Module                       | Files                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SnowflakeSyncModule`        | `snowflake-sync.module.ts`, `snowflake-sync.service.ts`, `snowflake-sync.controller.ts`, `snowflake-client.factory.ts`, `dtos/manual-trigger.dto.ts`, `interfaces/snowflake-rows.interface.ts`, `sql/bootstrap.sql` |
| `AiChatModule`               | `ai-chat.module.ts`, `ai-chat.service.ts`, `ai-chat.controller.ts`, `dtos/chat-request.dto.ts`, `interfaces/chat-tool.interface.ts`                                                                                 |
| `RebalancingModule`          | `rebalancing.module.ts`, `rebalancing.service.ts`, `rebalancing.controller.ts`, `dtos/rebalancing-request.dto.ts`, `interfaces/rebalancing-response.interface.ts`                                                   |
| `UserFinancialProfileModule` | `user-financial-profile.module.ts`, `user-financial-profile.service.ts`, `user-financial-profile.controller.ts`, `dtos/financial-profile.dto.ts`                                                                    |
| Health probes (additive)     | `apps/api/src/app/health/snowflake-health.indicator.ts`, `apps/api/src/app/health/anthropic-health.indicator.ts`                                                                                                    |
| `MetricsModule`              | `metrics.module.ts`, `metrics.service.ts`, `metrics.controller.ts`                                                                                                                                                  |
| Wiring                       | `apps/api/src/app/app.module.ts` (4 new imports, additive)                                                                                                                                                          |

### Review Checklist

#### Rule 1 — Module Isolation

- [ ] No `import` statement in any new module file resolves to a deep path inside an existing Ghostfolio feature module's directory. Permitted resolution targets:
  - Public service classes exported from the source module's `exports` array (e.g., `PortfolioService` from `PortfolioModule`, `SymbolService` from `SymbolModule`).
  - The global `PrismaService` and `ConfigService`.
  - The shared library `@ghostfolio/common/...` barrels.
  - The standard NestJS / Anthropic / Snowflake SDK packages.
- [ ] **Verification grep:** `grep -rn "from '\\@ghostfolio/api/app/[a-z-]\\+/[^']\\+/[^']\\+'" apps/api/src/app/{snowflake-sync,ai-chat,rebalancing,user-financial-profile}/` — every match MUST be a service-level import (e.g., `portfolio.service`), never a controller/dto/internal-helper import.

#### Rule 4 — Structured Rebalancing via Tool Use

- [ ] `rebalancing.service.ts` calls `client.messages.create({...})` with a `tools: [...]` array containing exactly one tool schema (`rebalancing_recommendations`) and `tool_choice: { type: 'tool', name: 'rebalancing_recommendations' }`.
- [ ] `rebalancing.service.ts` reads structured output ONLY from the response's `content` array filtered by `type === 'tool_use'`.
- [ ] `rebalancing.service.ts` NEVER inspects `content[i].text` to extract structured fields.
- [ ] `rebalancing.service.ts` validates the resulting `tool_use.input` object against the `RebalancingResponse` shape and throws `BadGatewayException` if Anthropic returns an unexpected shape.
- [ ] **Verification grep:** `grep -n "\\.text" apps/api/src/app/rebalancing/rebalancing.service.ts` — no occurrence may be used to extract fields of the structured response.

#### Rule 7 — Snowflake Sync Idempotency

- [ ] All three Snowflake write operations in `snowflake-sync.service.ts` use `MERGE INTO ... USING (...) ON ... WHEN MATCHED THEN UPDATE ... WHEN NOT MATCHED THEN INSERT ...` syntax — never `INSERT INTO ...` standalone.
- [ ] MERGE keys match the unique constraints documented in AAP § 0.5.1.1:
  - `portfolio_snapshots` MERGE key: `(snapshot_date, user_id, asset_class)`
  - `orders_history` MERGE key: `(order_id)`
  - `performance_metrics` MERGE key: `(metric_date, user_id)`
- [ ] **Idempotency test:** Running `syncSnapshots(userId, date)` / `syncOrders(userId)` / `syncMetrics(userId, date)` twice for the same input leaves row counts unchanged across all three Snowflake tables (covered by `snowflake-sync.service.spec.ts` in Phase 4).

#### Rule 8 — Controller Thinness

- [ ] No new controller method body exceeds 10 lines (counted from `{` to `}`, exclusive of decorators and signature).
- [ ] No `prisma.*` or `this.prisma...` reference appears in any new controller file.
- [ ] No business logic (looping, aggregation, conditional branching beyond simple guard checks) appears in any new controller method.
- [ ] Controllers ONLY: extract `request.user.id`, validate the DTO via class-validator, delegate to the service, return the result.

#### Module wiring

- [ ] `apps/api/src/app/app.module.ts` `imports` array contains all four new module imports in the order: `SnowflakeSyncModule`, `AiChatModule`, `RebalancingModule`, `UserFinancialProfileModule`.
- [ ] `SnowflakeSyncModule.exports` includes `SnowflakeSyncService` (consumed by `AiChatModule`).
- [ ] `UserFinancialProfileModule.exports` includes `UserFinancialProfileService` (consumed by `AiChatModule` and `RebalancingModule`).
- [ ] `AiChatModule.exports` is empty (leaf module).
- [ ] `RebalancingModule.exports` is empty (leaf module).
- [ ] **Gate 13:** Every provider in each new module's `providers` array is injected by ≥1 controller or service in that module; no dead providers.
- [ ] **Gate 9:** Module wiring is complete — application bootstraps without DI errors.

### Status & Sign-Off

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | `OPEN` — Awaiting Phase 3 Expert Agent assignment |
| Reviewer      | _unassigned_                                      |
| Decision date | —                                                 |
| Findings      | —                                                 |

### Handoff Notes for Phase 4 (QA / Test Integrity)

When Phase 3 marks `APPROVED`, document the following for Phase 4:

1. **Architecture is sound.** Phase 4 may focus purely on test coverage and behavioral correctness, not architectural shape.
2. **Each rule has corresponding test obligations.** Phase 4 must verify at least one test assertion for each of Rules 1–8.
3. **Mock surface is well-defined.** Phase 3 confirmed which services are exported and injectable; Phase 4 must verify that mocks in the new `*.spec.ts` files mirror these public surfaces accurately.

---

## Phase 4 — QA / Test Integrity

**Phase status: `OPEN`**
**Owning Expert Agent:** _unassigned_

### Scope

All new `*.spec.ts` files under:

| Path                                                     | Spec Count | Coverage             |
| -------------------------------------------------------- | ---------: | -------------------- |
| `apps/api/src/app/snowflake-sync/`                       |          2 | Service + controller |
| `apps/api/src/app/ai-chat/`                              |          2 | Service + controller |
| `apps/api/src/app/rebalancing/`                          |          2 | Service + controller |
| `apps/api/src/app/user-financial-profile/`               |          2 | Service + controller |
| `apps/client/src/app/components/chat-panel/`             |          1 | Component            |
| `apps/client/src/app/components/financial-profile-form/` |          1 | Component            |
| `apps/client/src/app/pages/portfolio/rebalancing/`       |          1 | Component            |
| **Total**                                                |     **11** |                      |

### Review Checklist

#### Pre-existing test suite integrity

- [ ] **Gate 2:** `dotenv-cli -e .env.example -- nx test api` passes (zero failing tests; pre-existing 30/30 + 2 skipped baseline preserved).
- [ ] `dotenv-cli -e .env.example -- nx test common` passes (pre-existing 23/23 baseline preserved).
- [ ] `dotenv-cli -e .env.example -- nx test ui` passes (pre-existing 6/6 baseline preserved).
- [ ] `dotenv-cli -e .env.example -- nx test client` passes for any new component test suite added.

#### Per-rule test coverage (each of Rules 1–8 from § 0.7.1)

- [ ] **Rule 1 (Module Isolation):** Tests verify imports resolve only through `exports` arrays; an architectural assertion or a static import-graph snapshot is acceptable.
- [ ] **Rule 2 (Parameterized SQL):** `snowflake-sync.service.spec.ts` asserts the SQL strings emitted by sync routines contain `?` placeholders and that the corresponding `binds` arrays carry typed values.
- [ ] **Rule 3 (ConfigService creds):** `ai-chat.service.spec.ts` and `snowflake-sync.service.spec.ts` mock `ConfigService.get(...)` and assert it is called for each credential — and `process.env` is never read for the relevant keys.
- [ ] **Rule 4 (Tool-use only):** `rebalancing.service.spec.ts` asserts the response is sourced from a `tool_use` content block and that the service throws when no `tool_use` block is present.
- [ ] **Rule 5 (FinancialProfile auth):** `user-financial-profile.service.spec.ts` asserts every Prisma call observed in the test contains `where: { userId }`; user-A cannot retrieve user-B's row.
- [ ] **Rule 6 (SSE error handling):** `chat-panel.component.spec.ts` asserts that an `EventSource` `error` event sets `errorMessage` to a non-empty string and renders the reconnect button.
- [ ] **Rule 7 (Snowflake idempotency):** `snowflake-sync.service.spec.ts` asserts that running the sync twice for the same date range leaves row counts unchanged in the mocked Snowflake driver (e.g., the second MERGE call is a no-op or only increments `updated`, not `inserted`).
- [ ] **Rule 8 (Controller thinness):** `*.controller.spec.ts` files mock the corresponding service; controller method tests verify pure delegation (no Prisma calls observed).

#### Endpoint behavior tests

- [ ] `ai-chat.controller.spec.ts` — response `Content-Type` includes `text/event-stream`; first SSE chunk arrives within 3 s on a mocked Anthropic client; error path emits an SSE error frame.
- [ ] `rebalancing.controller.spec.ts` — 200 with valid body, 401 unauth, 400 invalid body shape.
- [ ] `user-financial-profile.controller.spec.ts` — 200 after PATCH, 404 (not 500) when no record, 400 when `retirementTargetAge < currentAge`, 401 unauth.
- [ ] `snowflake-sync.controller.spec.ts` — 200 with admin permission, 401 unauth, 403 without `triggerSnowflakeSync` permission.

#### Frontend behavior tests

- [ ] `chat-panel.component.spec.ts` — stream error sets `errorMessage` truthy; reconnect button rendered when `errorMessage` truthy; reconnect click re-invokes the SSE endpoint.
- [ ] `financial-profile-form.component.spec.ts` — 404 leaves form empty; 200 pre-populates fields; validator rejects `retirementTargetAge ≤ currentUserAge` before submit.
- [ ] `rebalancing-page.component.spec.ts` — every recommendation renders `rationale` and `goalReference`; `summary` shown; each `warnings` entry shown.

#### Test hygiene

- [ ] No `*.spec.ts` file is committed with `xit`, `xdescribe`, or `.skip(...)` blocks except where the pre-existing baseline already had a `skipped` entry.
- [ ] No `blitzy_adhoc_test_*` or other temporary test artifacts are committed.
- [ ] No real credentials appear in any `*.spec.ts` fixture or mock; all test inputs use synthetic placeholders.

### Status & Sign-Off

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | `OPEN` — Awaiting Phase 4 Expert Agent assignment |
| Reviewer      | _unassigned_                                      |
| Decision date | —                                                 |
| Findings      | —                                                 |

### Handoff Notes for Phase 5 (Business / Domain)

When Phase 4 marks `APPROVED`, document the following for Phase 5:

1. **Tests demonstrate behavioral conformance.** Phase 5 may rely on the spec assertions to validate domain alignment without re-running tests.
2. **Demo-narrative test fixtures.** Any spec fixture used for the 10-minute demo (Feature A → B → C narrative) is identified for Phase 5 walk-through.

---

## Phase 5 — Business / Domain

**Phase status: `OPEN`**
**Owning Expert Agent:** _unassigned_

### Scope

| Domain Concern                                                           | Source of Truth                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Existing F-020 (`AiModule`) untouched                                    | `apps/api/src/app/endpoints/ai/` (read-only verification) |
| Three independently demoable features (A, B, C)                          | AAP § 0.1.1                                               |
| 10-minute demo narrative end-to-end                                      | AAP § 0.7.2 (Business / Domain phase scope)               |
| `RebalancingResponse` `rationale` + `goalReference` semantic correctness | AAP § 0.1.1 Feature C; § 0.1.2.4                          |

### Review Checklist

#### F-020 isolation

- [ ] `apps/api/src/app/endpoints/ai/ai.module.ts` is BYTE-FOR-BYTE unchanged (`git diff main -- apps/api/src/app/endpoints/ai/`).
- [ ] `apps/api/src/app/endpoints/ai/ai.controller.ts` is BYTE-FOR-BYTE unchanged.
- [ ] `apps/api/src/app/endpoints/ai/ai.service.ts` is BYTE-FOR-BYTE unchanged.
- [ ] The new `AiChatModule` and `RebalancingModule` mount under DISTINCT controller prefixes (`ai/chat` and `ai/rebalancing`) — neither collides with the existing `ai/prompt/:mode` route.
- [ ] No new code imports from `@ghostfolio/api/app/endpoints/ai/...` paths.

#### Feature independence

- [ ] **Feature A demo:** Snowflake Sync can be exercised stand-alone — manually triggering `POST /api/v1/snowflake-sync/trigger` (with admin permission) populates the three Snowflake tables and emits structured logs visible via the metrics dashboard.
- [ ] **Feature B demo:** AI Chat can be exercised stand-alone — opening the portfolio page sidebar, typing a question, and receiving a streamed response (no dependency on Feature C being deployed).
- [ ] **Feature C demo:** Explainable Rebalancing can be exercised stand-alone — navigating to `/portfolio/rebalancing` and rendering recommendations with rationale + goalReference.
- [ ] **Narrative continuity:** The three features tell a coherent story (data mirrored to Snowflake → AI agent queries it → rebalancing engine references the user's goals stored in `FinancialProfile`).

#### `RebalancingResponse` semantic correctness

- [ ] Each `recommendations[i].rationale` is a non-empty natural-language string explicitly referencing the user's stated financial goals.
- [ ] Each `recommendations[i].goalReference` maps EITHER to a `FinancialProfile` field name (e.g., `retirementTargetAge`, `riskTolerance`) OR to a label inside the JSON `investmentGoals` array (per AAP § 0.1.1 Feature C and § 0.1.2.4).
- [ ] `summary` is a non-empty paragraph-length string.
- [ ] `warnings` is an array (may be empty); when non-empty, each entry is a human-readable risk/caveat statement.

#### UX flow validation

- [ ] **Sidebar chat panel:** Embedded in the existing portfolio-page sidebar slot; clicking elsewhere on the page does not close the chat; SSE error displays the reconnect UI.
- [ ] **Rebalancing page:** Loads at `/portfolio/rebalancing` with the existing portfolio nav highlighted; recommendations are visible immediately (no "click to expand" — every rationale rendered by default).
- [ ] **Financial-profile dialog:** Opens from the user-account page via a clearly labeled menu item; on first open with no existing record, shows an empty form (404 handling); on subsequent opens, pre-populates from the prior PATCH.
- [ ] **Gate 8:** All four new endpoints return non-500 HTTP responses when called with a valid JWT and correctly shaped request body against a running local instance.

#### Acceptance criteria from AAP § 0.1.1

- [ ] Feature A — Snowflake daily cron at `02:00 UTC` is registered (verified by `SchedulerRegistry` log line at startup).
- [ ] Feature A — Order create/update/delete events trigger sync within the listener debounce window.
- [ ] Feature B — Chat agent dispatches all four tool calls (`get_current_positions`, `get_performance_metrics`, `query_history`, `get_market_data`).
- [ ] Feature B — System prompt is personalized per request from caller's `FinancialProfile` and current portfolio state.
- [ ] Feature B — Chat session state is stateless server-side (no `ChatSession` Prisma model created).
- [ ] Feature C — Structured output sourced exclusively from `tool_use` block (cross-reference Phase 3 Rule 4 finding).

### Status & Sign-Off

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | `OPEN` — Awaiting Phase 5 Expert Agent assignment |
| Reviewer      | _unassigned_                                      |
| Decision date | —                                                 |
| Findings      | —                                                 |

### Handoff Notes for Phase 6 (Frontend)

When Phase 5 marks `APPROVED`, document the following for Phase 6:

1. **Domain semantics confirmed.** Phase 6 may proceed knowing that the `RebalancingResponse` shape is correct and that the three components serve well-defined domain features.
2. **Demo flows are validated.** Phase 6 must ensure the three components render correctly in each demo flow, with no console errors and no broken Material Design layout.

---

## Phase 6 — Frontend

**Phase status: `OPEN`**
**Owning Expert Agent:** _unassigned_

### Scope (Rule 6 from AAP § 0.7.1)

| File                                                                                          | Type            | Phase 6 Verification                             |
| --------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------ |
| `apps/client/src/app/components/chat-panel/chat-panel.component.ts`                           | New component   | Rule 6 SSE error handling                        |
| `apps/client/src/app/components/chat-panel/chat-panel.component.html`                         | New template    | Conditional reconnect button                     |
| `apps/client/src/app/components/chat-panel/chat-panel.component.scss`                         | New styles      | MD3 conformance                                  |
| `apps/client/src/app/components/financial-profile-form/financial-profile-form.component.ts`   | New component   | 404 → empty form; client-side validation         |
| `apps/client/src/app/components/financial-profile-form/financial-profile-form.component.html` | New template    | Material Dialog form                             |
| `apps/client/src/app/components/financial-profile-form/financial-profile-form.component.scss` | New styles      | MD3 conformance                                  |
| `apps/client/src/app/pages/portfolio/rebalancing/rebalancing-page.component.ts`               | New page        | `RebalancingResponse` rendering                  |
| `apps/client/src/app/pages/portfolio/rebalancing/rebalancing-page.component.html`             | New template    | Rationale + goalReference visible                |
| `apps/client/src/app/pages/portfolio/rebalancing/rebalancing-page.component.scss`             | New styles      | MD3 conformance                                  |
| `apps/client/src/app/services/ai-chat.service.ts`                                             | New service     | EventSource lifecycle                            |
| `apps/client/src/app/services/rebalancing.service.ts`                                         | New service     | HttpClient POST wrapper                          |
| `apps/client/src/app/services/financial-profile.service.ts`                                   | New service     | HttpClient GET / PATCH wrapper                   |
| `apps/client/src/app/app.routes.ts`                                                           | Wiring (modify) | One new route entry for `/portfolio/rebalancing` |
| `apps/client/src/app/pages/portfolio/portfolio-page.html`                                     | Wiring (modify) | One new `<app-chat-panel>` element               |
| `apps/client/src/app/pages/user-account/user-account-page.ts`                                 | Wiring (modify) | One new `MatDialog.open(...)` handler            |

### Review Checklist

#### Rule 6 — SSE Disconnection Handling

- [ ] `chat-panel.component.ts` registers a handler on the `EventSource` `error` event that:
  - Sets `this.errorMessage` (a `signal<string>` or class field) to a non-empty descriptive string (e.g., `"Connection lost. Click reconnect to retry."`).
  - Closes the existing `EventSource`.
- [ ] `chat-panel.component.html` conditionally renders a reconnect `<button>` element when `errorMessage()` (or `errorMessage`) is truthy.
- [ ] The reconnect button click handler:
  - Clears `errorMessage` (sets it to empty / `null`).
  - Re-invokes the SSE endpoint.

#### Component scope behavior

- [ ] `chat-panel.component.ts`:
  - Maintains a `messages` signal (or BehaviorSubject) capped at 5 entries (4 prior turns + current user turn).
  - On submit, sends the full message array to `POST /api/v1/ai/chat` via the SSE wrapper.
  - Renders Claude's streamed tokens incrementally (token-by-token) into the latest assistant message.
  - Disables the input/send button while a stream is open (`isStreaming` signal).
- [ ] `financial-profile-form.component.ts`:
  - On `ngOnInit`, calls `financialProfileService.get()`.
  - On HTTP 200, pre-populates a reactive `FormGroup` with the returned values.
  - On HTTP 404, leaves the form empty (and does NOT show a "not found" error — the component is in "first-time setup" mode).
  - Submit button is disabled until form is valid; on submit, calls `financialProfileService.patch(formValue)` and closes the dialog on success.
- [ ] `financial-profile-form.component.ts` includes a client-side validator on `retirementTargetAge`:
  - Computes `currentUserAge` from `User.settings.dateOfBirth` when available, OR falls back to the floor (`retirementTargetAge ≥ 18`).
  - Marks the form invalid if `retirementTargetAge ≤ currentUserAge`.
  - Validator runs BEFORE the HTTP call (no flash of HTTP-400 error message in the UI).
- [ ] `rebalancing-page.component.ts`:
  - On `ngOnInit`, calls `rebalancingService.getRecommendations()`.
  - Renders the `summary` paragraph above the recommendation list.
  - Renders each `recommendations[i]` with `action`, `ticker`, `fromPct → toPct`, `rationale` (FULL TEXT, expanded by default), and a `goalReference` badge/chip.
  - Renders each `warnings[i]` in a visually distinct alert region (e.g., MD3 `warn` color tokens).

#### Material Design 3 conformance

- [ ] All three components use `@angular/material@21.2.5` primitives: `MatDialog`, `MatFormField`, `MatInput`, `MatSelect`, `MatButton`, `MatProgressBar`, `MatChipSet`/`MatChip`, etc.
- [ ] No raw `<button>`, `<input>`, or unstyled `<form>` elements bypass the MD3 design system.
- [ ] Color, spacing, and typography tokens come from the existing Ghostfolio SCSS theme — no inline hex colors, no inline `font-size: 14px` style attributes.
- [ ] Components inherit existing responsive breakpoints — no custom media queries beyond what the existing portfolio pages already use.

#### Wiring correctness

- [ ] `app.routes.ts` contains exactly one new entry: `{ path: 'portfolio/rebalancing', loadComponent: () => import('./pages/portfolio/rebalancing/rebalancing-page.component').then(m => m.RebalancingPageComponent) }` (or equivalent matching the existing `loadComponent` style); no existing route entry is reordered or modified.
- [ ] `portfolio-page.html` contains exactly one new element `<app-chat-panel></app-chat-panel>` inside the sidebar slot; no existing markup is altered.
- [ ] `user-account-page.ts` contains exactly one new `MatDialog.open(FinancialProfileFormComponent, { ... })` invocation, wired to a clearly labeled menu item or button.
- [ ] **The existing `user-account-settings/` component template is NOT modified** (per AAP § 0.4.1.1).
- [ ] Component selector embedded in `portfolio-page.html` matches the component's `selector` metadata (e.g., literal `app-chat-panel` if `selector: 'app-chat-panel'`, or appropriate alias).

#### Service layer correctness

- [ ] `ai-chat.service.ts` wraps `EventSource` lifecycle (open, message, error, close) and exposes a typed RxJS `Subject<ChatMessage>` consumed by the panel.
- [ ] `ai-chat.service.ts` includes credentials in the SSE request (cookie/auth header, depending on Ghostfolio's existing auth pattern).
- [ ] `rebalancing.service.ts` calls `HttpClient.post<RebalancingResponse>('/api/v1/ai/rebalancing', body)`.
- [ ] `financial-profile.service.ts` calls `HttpClient.get<FinancialProfile>('/api/v1/user/financial-profile')` and `HttpClient.patch<FinancialProfile>(...)`.
- [ ] All three client services use the `/api/v1/...` URI prefix (per AAP § 0.1.1.1 versioning note).
- [ ] All three client services import their typed contracts from `@ghostfolio/common/interfaces` (the new shared interface barrel additions).

#### Build & lint

- [ ] `npx nx run client:build:development-en` completes successfully with no new TypeScript errors.
- [ ] `npx nx lint client` passes (no new ESLint violations).
- [ ] **Chat Agent Gate:** Manual smoke test confirms `Content-Type: text/event-stream` on the live endpoint and first-token latency < 3 s on localhost.

### Status & Sign-Off

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | `OPEN` — Awaiting Phase 6 Expert Agent assignment |
| Reviewer      | _unassigned_                                      |
| Decision date | —                                                 |
| Findings      | —                                                 |

### Handoff Notes for Phase 7 (Other SME — Snowflake)

When Phase 6 marks `APPROVED`, document the following for Phase 7:

1. **Frontend SSE contract is verified.** Phase 7 may rely on the SSE protocol being well-formed and focus solely on Snowflake-specific concerns.
2. **`query_history` tool's frontend behavior is implicit (panel renders results).** Phase 7 must focus on the backend tool implementation and Snowflake query safety.

---

## Phase 7 — Other SME (Snowflake)

**Phase status: `OPEN`**
**Owning Expert Agent:** _Snowflake / data-warehouse SME — unassigned_

### Scope

| File                                                          | Concern                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/api/src/app/snowflake-sync/sql/bootstrap.sql`           | DDL idempotency, table schema correctness, unique constraints                             |
| `apps/api/src/app/snowflake-sync/snowflake-client.factory.ts` | Connection construction, `keepAlive` semantics, single-pool usage                         |
| `apps/api/src/app/snowflake-sync/snowflake-sync.service.ts`   | MERGE statement bind-variable usage, callback-to-Promise wrapping, `query_history` safety |

### Review Checklist

#### DDL correctness (bootstrap.sql)

- [ ] All three Snowflake tables exist:
  - `portfolio_snapshots(snapshot_date DATE, user_id STRING, asset_class STRING, allocation_pct FLOAT, total_value_usd FLOAT)` — `UNIQUE(snapshot_date, user_id, asset_class)`
  - `orders_history(order_id STRING, user_id STRING, date DATE, type STRING, ticker STRING, quantity FLOAT, unit_price FLOAT, fee FLOAT, currency STRING, synced_at TIMESTAMP_NTZ)` — `UNIQUE(order_id)`
  - `performance_metrics(metric_date DATE, user_id STRING, twr FLOAT, volatility FLOAT, sharpe_ratio FLOAT)` — `UNIQUE(metric_date, user_id)`
- [ ] DDL uses `CREATE TABLE IF NOT EXISTS` (idempotent).
- [ ] Column types match Snowflake's recommended types (e.g., `STRING` for `VARCHAR` semantics; `FLOAT` for `DOUBLE`).
- [ ] Unique constraints use Snowflake's `UNIQUE(...)` table-constraint syntax (or whatever pattern the project chose; Snowflake's enforcement is informational for unique but the constraint must be declared).

#### Connection management (snowflake-client.factory.ts)

- [ ] All six `SNOWFLAKE_*` env vars are read via `ConfigService.get<string>('SNOWFLAKE_...')` — never `process.env`.
- [ ] Connection construction uses `snowflake.createConnection({ account, username, password, database, schema, warehouse })` with all required fields.
- [ ] `keepAlive: true` is set in connection options to maintain a single shared connection, consistent with the SDK's recommended pooling pattern.
- [ ] The factory exposes `getConnection(): Promise<snowflake.Connection>` with lazy init; multiple concurrent calls do NOT create duplicate connections (idempotent factory).
- [ ] Connection failures are surfaced as descriptive errors (not unhandled promise rejections).

#### MERGE statement bind-variable usage (snowflake-sync.service.ts)

- [ ] **Cross-reference Phase 2 Rule 2 verification.** All three MERGE statements use `?` placeholders only.
- [ ] MERGE keys match the documented unique constraints (cross-reference Phase 3 Rule 7 verification):
  - `portfolio_snapshots`: ON `target.snapshot_date = source.snapshot_date AND target.user_id = source.user_id AND target.asset_class = source.asset_class`
  - `orders_history`: ON `target.order_id = source.order_id`
  - `performance_metrics`: ON `target.metric_date = source.metric_date AND target.user_id = source.user_id`
- [ ] WHEN MATCHED branch updates non-key columns; WHEN NOT MATCHED branch inserts the full row.
- [ ] Callback-style `connection.execute({...})` is wrapped in a `Promise` inline (no `snowflake-promise` external package per AAP § 0.7.3).

#### `query_history` tool safety

- [ ] `SnowflakeSyncService.queryHistory(userId, sql, binds)`:
  - Rejects any `sql` containing `;` outside string literals (defense-in-depth).
  - Applies a row-count cap (e.g., max 1,000 rows) before returning results to Claude.
  - Passes `binds` directly to `connection.execute({...})` — no transformation that could re-introduce injection.
  - Logs the `userId` and a fingerprint (hash) of the SQL — never the full SQL with user inputs interpolated.

#### Bootstrap behavior

- [ ] `SnowflakeSyncService.bootstrap()` runs the DDL on first startup if the tables are missing; safe to invoke on every application start (idempotent).
- [ ] Bootstrap failures emit a descriptive log message but do NOT crash the application (graceful degradation — Snowflake sync should be a non-critical add-on).

#### Snowflake Sync Gate (AAP § 0.7.5)

- [ ] Cron registration appears in NestJS scheduler logs at startup (`@Cron('0 2 * * *', { name: 'snowflake-daily-sync', timeZone: 'UTC' })`).
- [ ] An Order create event triggers the sync within the same request lifecycle (allowing for the listener debounce window).
- [ ] **Idempotency proof:** Running the sync twice for the same date range leaves row counts unchanged across all three Snowflake tables (covered in Phase 4 unit tests + Phase 7 integration smoke test).

### Status & Sign-Off

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | `OPEN` — Awaiting Phase 7 Expert Agent assignment |
| Reviewer      | _unassigned_                                      |
| Decision date | —                                                 |
| Findings      | —                                                 |

### Handoff Notes for Phase 8 (Principal Reviewer)

When Phase 7 marks `APPROVED`, document the following for Phase 8:

1. **All seven domain phases complete.** Phase 8 may begin holistic consolidation.
2. **All eight rules from AAP § 0.7.1 have at least one phase claiming verification responsibility.** Phase 8 confirms the cross-phase coverage matrix is complete.
3. **All twelve gates from AAP § 0.7.5 have a designated phase that owns each gate's pass/fail check.**

---

## Phase 8 — Principal Reviewer (Final Sign-Off)

**Phase status: `OPEN`**
**Owning Reviewer:** _Principal Engineer — unassigned_

### Scope

Holistic review across all seven prior phases. The Principal Reviewer:

1. Confirms each prior phase is `APPROVED`.
2. Verifies alignment with the Agent Action Plan (every section of AAP § 0.1 through § 0.7).
3. Confirms all eight numbered rules in AAP § 0.7.1 are satisfied across the codebase.
4. Confirms all twelve validation gates in AAP § 0.7.5 pass.
5. Confirms scope boundaries (AAP § 0.6.1, § 0.6.2) are respected.
6. Authorizes PR creation.

### Final Review Checklist

#### Phase consolidation

- [ ] Phase 1 (Infrastructure / DevOps) status is `APPROVED`.
- [ ] Phase 2 (Security) status is `APPROVED`.
- [ ] Phase 3 (Backend Architecture) status is `APPROVED`.
- [ ] Phase 4 (QA / Test Integrity) status is `APPROVED`.
- [ ] Phase 5 (Business / Domain) status is `APPROVED`.
- [ ] Phase 6 (Frontend) status is `APPROVED`.
- [ ] Phase 7 (Other SME — Snowflake) status is `APPROVED`.

#### Numbered rules from AAP § 0.7.1

- [ ] Rule 1 — Module Isolation — verified by Phase 3.
- [ ] Rule 2 — Parameterized Snowflake Queries — verified by Phase 2 + Phase 7.
- [ ] Rule 3 — Credential Access via ConfigService — verified by Phase 2.
- [ ] Rule 4 — Structured Rebalancing via Tool Use — verified by Phase 3.
- [ ] Rule 5 — Financial Profile Authorization — verified by Phase 2.
- [ ] Rule 6 — SSE Disconnection Handling — verified by Phase 6.
- [ ] Rule 7 — Snowflake Sync Idempotency — verified by Phase 3 + Phase 7.
- [ ] Rule 8 — Controller Thinness — verified by Phase 3.

#### Project-level rules from AAP § 0.7.2

- [ ] **Observability:** Three dashboard templates at `docs/observability/{snowflake-sync,ai-chat,ai-rebalancing}.md` exist and are descriptive. `/api/v1/health/snowflake` and `/api/v1/health/anthropic` probes return non-500. `/api/v1/metrics` endpoint registered via `MetricsModule` returns the metrics registry.
- [ ] **Explainability:** Decision log at `docs/decisions/agent-action-plan-decisions.md` is complete with at least the seven mandated decisions (Angular 19→21.2.7, Prisma 6→7.7.0, stateless chat, `tool_use`-only structured output, `PortfolioChangedEvent` reuse, `JwtAuthGuard` resolution, `getPositions()` resolution, snowflake-sync cron-vs-event coexistence). Bidirectional traceability matrix present.
- [ ] **Executive Presentation:** `blitzy-deck/agent-action-plan.html` exists, opens in a browser, contains 12–18 slides (target 16) with Blitzy theme, Mermaid architecture diagram, KPI cards, risk/mitigation table, onboarding closing slide. CDN versions pinned to `reveal.js 5.1.0`, `Mermaid 11.4.0`, `Lucide 0.460.0`.
- [ ] **Segmented PR Review:** This file (`CODE_REVIEW.md`) is complete with all eight phases reaching `APPROVED` status before PR is opened.

#### AAP validation gates from § 0.7.5

- [ ] **Gate 1** — `npm run build` zero TypeScript errors.
- [ ] **Gate 2** — `npm run test` zero pre-existing test failures.
- [ ] **Gate 8** — All four new endpoints non-500 on valid input.
- [ ] **Gate 9** — Wiring complete (4 modules in `AppModule.imports`; `/portfolio/rebalancing` resolves; `<app-chat-panel>` renders).
- [ ] **Gate 10** — App boots with all 7 env vars; descriptive error if missing.
- [ ] **Gate 11** — Parameterized Snowflake queries (Rule 2 grep zero matches).
- [ ] **Gate 12** — All 7 env vars in `.env.example`; `ConfigService.get(...)` resolves each.
- [ ] **Gate 13** — Every provider injected (no dead providers).
- [ ] **Snowflake Sync Gate** — Cron registered, event handler functional, idempotency proven.
- [ ] **Chat Agent Gate** — `Content-Type: text/event-stream`, first token < 3 s, all 4 tools registered.
- [ ] **Rebalancing Engine Gate** — Response from `tool_use`, non-empty rationale + goalReference.
- [ ] **Financial Profile Gate** — 200/PATCH, 404 (not 500) on absent record, 400 on invalid age, valid upsert idempotent.
- [ ] **Security Sweep Gate** — Zero `process.env.ANTHROPIC` / `process.env.SNOWFLAKE` refs; zero SQL string concat; 401 on no JWT.

#### Scope boundaries

- [ ] **AAP § 0.6.1.3** — Only the documented existing backend files modified (wiring-only): `apps/api/src/app/app.module.ts`, `prisma/schema.prisma`.
- [ ] **AAP § 0.6.1.5** — Only the documented existing frontend files modified (wiring-only): `apps/client/src/app/app.routes.ts`, `apps/client/src/app/pages/portfolio/portfolio-page.html`, `apps/client/src/app/pages/user-account/user-account-page.ts`.
- [ ] **AAP § 0.6.1.6** — Shared library additions: `libs/common/src/lib/permissions.ts` (5 new constants), `libs/common/src/lib/interfaces/index.ts` (3 new re-exports), 3 new `*.interface.ts` files.
- [ ] **AAP § 0.6.1.7** — Configuration files: `package.json` (3 new deps), `package-lock.json` (regenerated), `.env.example` (7 new placeholders), `prisma/migrations/<timestamp>_add_financial_profile/migration.sql` (new).
- [ ] **AAP § 0.6.2.1** — No edits to any out-of-scope file, including but not limited to `apps/api/src/app/portfolio/`, `apps/api/src/app/symbol/`, `apps/api/src/app/user/`, `apps/api/src/app/activities/`, `apps/api/src/app/auth/`, `apps/api/src/app/endpoints/ai/`, every existing Prisma model.
- [ ] **AAP § 0.6.2.2** — No out-of-scope functional domains (no chat session persistence, no Bull queues, no F-020 refactor, no streaming for rebalancing).

#### Final integration smoke

- [ ] `git diff main --name-only` shows exactly the in-scope files (no surprises).
- [ ] `git log --author="agent@blitzy.com" main..HEAD --oneline` shows the expected commit sequence.
- [ ] `npx nx format:check` passes.
- [ ] `npx nx lint api && npx nx lint client && npx nx lint common && npx nx lint ui` all pass.

### Status

| Field    | Value                              |
| -------- | ---------------------------------- |
| Status   | `OPEN` — Awaiting all prior phases |
| Reviewer | _unassigned_                       |

### Final Sign-Off

When all the above checklist items are confirmed:

- **Reviewer Name:** _(to be filled in by reviewer)_
- **Date:** _(YYYY-MM-DD)_
- **Decision:** ☐ APPROVED ☐ CHANGES REQUESTED ☐ BLOCKED
- **Authorization to open PR:** ☐ YES ☐ NO

If **CHANGES REQUESTED** or **BLOCKED**, summarize the blocking concerns:

> _Reviewer notes go here._

---

## Traceability Matrix

The following bidirectional matrix maps each review phase to the files in scope, the engineering rules verified, and the validation gates verified. This satisfies the "bidirectional traceability matrix" requirement of the Explainability rule (AAP § 0.7.2).

### Phase → Files / Rules / Gates

| Phase | Domain                  | Files in Scope                                                                                                                                       | Rule(s) Verified               | AAP Gate(s) Verified                    |
| ----- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------- |
| 1     | Infrastructure / DevOps | `package.json`, `package-lock.json`, `.env.example`                                                                                                  | —                              | Gate 1, Gate 10, Gate 12                |
| 2     | Security                | `apps/api/src/app/snowflake-sync/**`, `apps/api/src/app/ai-chat/**`, `apps/api/src/app/user-financial-profile/**`, `apps/api/src/app/rebalancing/**` | Rule 2, Rule 3, Rule 5         | Security Sweep Gate, Gate 11            |
| 3     | Backend Architecture    | All four new NestJS modules + `apps/api/src/app/app.module.ts` (wiring) + `apps/api/src/app/health/**` (additive) + `apps/api/src/app/metrics/**`    | Rule 1, Rule 4, Rule 7, Rule 8 | Gate 9, Gate 13                         |
| 4     | QA / Test Integrity     | All 11 new `*.spec.ts` files                                                                                                                         | All Rules 1–8 (test coverage)  | Gate 2                                  |
| 5     | Business / Domain       | F-020 isolation (read-only); demo narrative; UX flow                                                                                                 | —                              | Gate 8, Rebalancing Engine Gate         |
| 6     | Frontend                | All three new Angular components + 3 client services + 3 wiring edits (`app.routes.ts`, `portfolio-page.html`, `user-account-page.ts`)               | Rule 6                         | Chat Agent Gate, Financial Profile Gate |
| 7     | Other SME (Snowflake)   | `snowflake-sync/sql/bootstrap.sql`, `snowflake-client.factory.ts`, `snowflake-sync.service.ts` MERGE statements                                      | Rule 2 (cross-ref), Rule 7     | Snowflake Sync Gate                     |
| 8     | Principal Reviewer      | Holistic — all 68 in-scope files                                                                                                                     | All Rules 1–8                  | All Gates 1–13                          |

### Rule → Verifying Phase(s)

| Rule                                         | Verifying Phase(s) |
| -------------------------------------------- | ------------------ |
| Rule 1 — Module Isolation                    | Phase 3            |
| Rule 2 — Parameterized Snowflake Queries     | Phase 2, Phase 7   |
| Rule 3 — Credential Access via ConfigService | Phase 2            |
| Rule 4 — Structured Rebalancing via Tool Use | Phase 3            |
| Rule 5 — Financial Profile Authorization     | Phase 2            |
| Rule 6 — SSE Disconnection Handling          | Phase 6            |
| Rule 7 — Snowflake Sync Idempotency          | Phase 3, Phase 7   |
| Rule 8 — Controller Thinness                 | Phase 3            |

### Gate → Verifying Phase(s)

| Gate                                      | Verifying Phase(s) |
| ----------------------------------------- | ------------------ |
| Gate 1 (Build integrity)                  | Phase 1            |
| Gate 2 (Regression safety)                | Phase 4            |
| Gate 8 (Integration sign-off)             | Phase 5            |
| Gate 9 (Wiring verification)              | Phase 3, Phase 6   |
| Gate 10 (Env var binding)                 | Phase 1            |
| Gate 11 (Parameterized queries)           | Phase 2, Phase 7   |
| Gate 12 (Config propagation)              | Phase 1            |
| Gate 13 (Registration-invocation pairing) | Phase 3            |
| Snowflake Sync Gate                       | Phase 7            |
| Chat Agent Gate                           | Phase 6            |
| Rebalancing Engine Gate                   | Phase 3, Phase 5   |
| Financial Profile Gate                    | Phase 3, Phase 6   |
| Security Sweep Gate                       | Phase 2            |

### Feature → Implementation Files

| Feature                        | Backend                                                                                                                                                  | Frontend                                                                                                                | Cross-cutting                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **A — Snowflake Sync**         | `apps/api/src/app/snowflake-sync/**`                                                                                                                     | —                                                                                                                       | `apps/api/src/app/health/snowflake-health.indicator.ts`, `docs/observability/snowflake-sync.md` |
| **B — AI Chat Agent**          | `apps/api/src/app/ai-chat/**`                                                                                                                            | `apps/client/src/app/components/chat-panel/**`, `apps/client/src/app/services/ai-chat.service.ts`                       | `apps/api/src/app/health/anthropic-health.indicator.ts`, `docs/observability/ai-chat.md`        |
| **C — Rebalancing Engine**     | `apps/api/src/app/rebalancing/**`                                                                                                                        | `apps/client/src/app/pages/portfolio/rebalancing/**`, `apps/client/src/app/services/rebalancing.service.ts`             | `docs/observability/ai-rebalancing.md`                                                          |
| **Shared — Financial Profile** | `apps/api/src/app/user-financial-profile/**`, `prisma/schema.prisma` (model + enum), `prisma/migrations/<timestamp>_add_financial_profile/migration.sql` | `apps/client/src/app/components/financial-profile-form/**`, `apps/client/src/app/services/financial-profile.service.ts` | `libs/common/src/lib/interfaces/financial-profile.interface.ts`                                 |

---

## Status Legend

| Status              | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `OPEN`              | Phase has not yet been claimed by an Expert Agent. Initial state for all phases.        |
| `IN_PROGRESS`       | An Expert Agent has claimed this phase and is actively reviewing.                       |
| `BLOCKED`           | Review uncovered a blocking concern; cannot advance until the concern is resolved.      |
| `CHANGES REQUESTED` | Review identified non-blocking issues that must be addressed before the phase advances. |
| `APPROVED`          | Phase is fully reviewed and signed off; the next phase may begin.                       |

---

## Document History

| Version | Date       | Author                       | Change                                                                                                         |
| ------- | ---------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1.0.0   | 2026-04-26 | Blitzy Code Generation Agent | Initial creation per AAP § 0.7.2 (Segmented PR Review rule); all eight phases initialized with `status: OPEN`. |
