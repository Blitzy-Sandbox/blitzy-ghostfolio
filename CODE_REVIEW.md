---
title: 'Code Review — Modular Dashboard System'
review_id: AAP-MODULAR-DASHBOARD-2026
created_at: 2026-06-15
target_branch: 'blitzy-9e341ebe-9d33-442b-87d7-5a86d4f168f3'
base_branch: main
aap_reference: '§ 0.8.2 Segmented PR Review (Project Governance Rule)'
review_pass: 1
phase_zero:
  name: Pre-flight
  phase: 0
  status: PENDING
  file_count: 0
phases:
  - name: Infrastructure / DevOps
    phase: 1
    status: PENDING
    file_count: 0
  - name: Security
    phase: 2
    status: PENDING
    file_count: 0
  - name: Backend Architecture
    phase: 3
    status: PENDING
    file_count: 0
  - name: QA / Test Integrity
    phase: 4
    status: PENDING
    file_count: 0
  - name: Business / Domain
    phase: 5
    status: PENDING
    file_count: 0
  - name: Frontend
    phase: 6
    status: PENDING
    file_count: 0
  - name: Other SME (Database / Prisma)
    phase: 7
    status: PENDING
    file_count: 0
  - name: Principal Reviewer
    phase: 8
    status: PENDING
    file_count: 0
---

# Code Review — Modular Dashboard System

> **Review Document Status:** This file is generated **at the moment the review begins**, per the Segmented PR Review governance rule (**AAP § 0.8.2**). The review itself is performed **after** the code generation run completes. Consequently, every phase below — Phase 0 (Pre-flight) plus the seven domain phases (1–7) and the Phase 8 Principal Reviewer final sign-off — is initialized to `PENDING`. As each Expert Agent reviews its phase, that phase's status, sign-off, and findings will be resolved to exactly `APPROVED` or `BLOCKED` (binary, no qualifiers permitted). The Principal Reviewer in **Phase 8** consolidates the seven prior phases into the final binary verdict only after all domain phases are resolved.

## Executive Summary

### Scope of Change

This pull request introduces the **Modular Dashboard System**, which replaces Ghostfolio's route-based Angular navigation shell with a single-canvas, drag-and-drop modular dashboard built on `angular-gridster2@21.0.1`, with each user's grid layout persisted to the database. The change is **additive at the dependency level** (one new runtime package) and **refactor-plus-additive** at the application level (a new client grid system, a new API layout feature, a new Prisma model, and a collapse of the authenticated feature surface into a single `/` canvas route while preserving the router infrastructure). The in-scope inventory is summarized below; exact file counts are confirmed by each phase during review.

| Category                                |       Count | Detail                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New client grid-system source files     | **PENDING** | `dashboard-canvas/`, `module-registry.service.ts`, `module-catalog/`, `dashboard-layout.service.ts`, `modules/**` wrappers, `dashboard.types.ts` under `apps/client/src/app/dashboard/**` _(file count confirmed during review Phase 6 — Frontend)_                                    |
| New API layout-feature source files     | **PENDING** | `user-dashboard-layout.controller.ts`, `user-dashboard-layout.service.ts`, `dtos/update-user-dashboard-layout.dto.ts` under `apps/api/src/app/user/**` _(file count confirmed during review Phase 3 — Backend Architecture)_                                                           |
| New shared-library files                |       **1** | `libs/common/src/lib/interfaces/user-dashboard-layout.interface.ts`                                                                                                                                                                                                                    |
| New Prisma model + migration            |       **2** | `UserDashboardLayout` model (1:1 → `User`, cascade delete) in `prisma/schema.prisma`; additive `CREATE TABLE` migration under `prisma/migrations/**` _(1 model + 1 migration)_                                                                                                         |
| New API endpoints                       |       **2** | `GET /api/v1/user/layout`, `PATCH /api/v1/user/layout`                                                                                                                                                                                                                                 |
| New npm dependency                      |       **1** | `angular-gridster2@21.0.1` (the single justified non-Material UI dependency)                                                                                                                                                                                                           |
| New permission constants                |       **2** | `readUserDashboardLayout`, `updateUserDashboardLayout` in `libs/common/src/lib/permissions.ts`                                                                                                                                                                                         |
| Navigation-shell edits (existing files) | **PENDING** | `app.routes.ts`, `app.component.{ts,html,scss}`, `components/header/header.component.{ts,html,scss}`, `pages/portfolio/portfolio-page.html`, `pages/portfolio/portfolio-page.component.ts`, `ngsw-config.json` (conditional) _(file count confirmed during review Phase 6 — Frontend)_ |
| Wiring-only edits (existing files)      | **PENDING** | `apps/api/src/app/user/user.module.ts`, `libs/common/src/lib/interfaces/index.ts`, `package.json` _(file count confirmed during review Phase 8 — Principal Reviewer)_                                                                                                                  |
| Governance / observability deliverables | **PENDING** | `CODE_REVIEW.md` (this file), `blitzy-deck/*dashboard*exec*summary*.html`, decision log + bidirectional traceability matrix (Markdown), observability dashboard template / runbook _(file count confirmed during review Phase 8 — Principal Reviewer)_                                 |
| **Total in-scope files**                | **PENDING** | Confirmed by Phase 8 (Principal Reviewer) after all domain phases resolve                                                                                                                                                                                                              |

### Risk Profile

| Risk Surface                                               | Severity       | Mitigations                                                                                                                                                                                                             |
| ---------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation collapse degrades router infrastructure         | **Medium**     | Router-preservation rule — `RouterModule.forRoot`, `ServiceWorkerModule`, `PageTitleStrategy`, and `ModulePreloadService` retained; single `/` route only. Verified by Phase 6.                                         |
| Cross-user layout exposure on `UserDashboardLayout`        | **Medium**     | Auth-guard rule — every Prisma op scoped to `request.user.id` (JWT-derived); `AuthGuard('jwt')` + `HasPermissionGuard`. Verified by Phase 2.                                                                            |
| Unbounded `layoutData` JSONB payload (DoS)                 | **Low–Medium** | `class-validator` DTO with `@ArrayMaxSize`, `@MaxLength`, and `@IsInt`/`@Min` size caps. Verified by Phase 2.                                                                                                           |
| Module components leaking layout state / importing canvas  | **Low–Medium** | Module-isolation + single-source-of-truth rules — wrappers hold no layout state and never import the canvas layer. Verified by Phase 6.                                                                                 |
| Below-minimum module resize corrupting the grid            | **Low**        | Minimum-cell-dimension rule — global and per-item `minItemCols`/`minItemRows` enforced by the grid engine. Verified by Phase 6.                                                                                         |
| MD3 token regression on grid chrome                        | **Low**        | Decision D-020 — `var(--mat-sys-<token>, <hardcoded-fallback>)` mandated for all grid chrome. Verified by Phase 6.                                                                                                      |
| Prisma migration conflict with `User` / `FinancialProfile` | **Low**        | Schema-precondition rule — `schema.prisma` read before authoring; additive `CREATE TABLE` only; `User` back-relation declared. Verified by Phase 7.                                                                     |
| Disturbance of preserved data services / business logic    | **Low**        | Boundary directive (AAP § 0.1.2.3) — all existing data-fetching services (`PortfolioService`, `SymbolService`, and the other established feature services) and business logic preserved unchanged. Verified by Phase 5. |
| Build / lint / migration regression                        | **Low**        | Build & migration gate — `npx nx build client`, `npx nx build api`, and the Prisma migration complete without errors. Verified by Phase 1 + Phase 7.                                                                    |

### Acceptance Gate Readiness

The following gates derive from the AAP § 0.8.3 validation criteria. Each MUST pass before Phase 8 (Principal Reviewer) can issue the final `APPROVED` verdict. All gates are `PENDING` until resolved by their owning phase.

| Gate                         | Description                                                                                                               | Owning Phase(s)   | Status    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------- |
| Catalog Completeness Gate    | Every existing feature component appears as a selectable module in the catalog, including the AI chat panel.              | Phase 5 + Phase 6 | `PENDING` |
| Placement Gate               | Adding a module from the catalog places it at the next available grid position (first-fit).                               | Phase 6           | `PENDING` |
| Interaction Performance Gate | Grid drag / resize completes its visual update within ~100ms on the zone-based setup.                                     | Phase 6           | `PENDING` |
| Persistence Debounce Gate    | Layout saves to the database within a ~500ms debounce after a grid state change.                                          | Phase 3 + Phase 6 | `PENDING` |
| Layout GET Contract Gate     | `GET /api/v1/user/layout` returns the saved layout (≤300ms p95), 404→`null` on first visit, and 401 when unauthenticated. | Phase 2 + Phase 3 | `PENDING` |
| Layout PATCH Contract Gate   | `PATCH /api/v1/user/layout` persists and returns 200, and returns 401 when unauthenticated.                               | Phase 2 + Phase 3 | `PENDING` |
| Onboarding Gate              | New user → blank canvas with the catalog auto-opened; returning user → saved layout loaded on app init.                   | Phase 5 + Phase 6 | `PENDING` |
| Router Integrity Gate        | Router infrastructure remains functional after the single-route collapse.                                                 | Phase 6           | `PENDING` |
| Minimum Cell Dimension Gate  | Each module declares minimum cell dimensions; the grid engine enforces them and rejects below-minimum resizes.            | Phase 6           | `PENDING` |
| MD3 Token Discipline Gate    | Grid chrome uses `var(--mat-sys-<token>, <hardcoded-fallback>)`; bare `--mat-sys-*` without fallback is absent.           | Phase 6           | `PENDING` |
| Auth Guard Gate              | Layout endpoints are protected by `AuthGuard('jwt')` + `HasPermissionGuard`; unauthenticated requests return 401.         | Phase 2           | `PENDING` |
| Build & Migration Gate       | `npx nx build client` and `npx nx build api` complete without errors; the Prisma migration runs without conflicts.        | Phase 1 + Phase 7 | `PENDING` |
| Test Coverage Gate           | ≥80% line coverage for the module registry service, the layout persistence service, and the grid canvas component.        | Phase 4           | `PENDING` |

### Review Workflow

```
Phase 0 (Pre-flight) → Phase 1 (Infra / DevOps) → Phase 2 (Security)
   → Phase 3 (Backend Architecture) → Phase 4 (QA / Tests)
   → Phase 5 (Business / Domain) → Phase 6 (Frontend)
   → Phase 7 (Other SME — Database / Prisma) → Phase 8 (Principal Reviewer)
```

Each phase blocks the next: a `BLOCKED` status on phase _n_ must be resolved (i.e., status flipped to `APPROVED`) before phase _n+1_ may begin its review work. The `PENDING` status indicates the phase has not yet been resolved by its Expert Agent. After all domain phases reach `APPROVED`, Phase 8 issues a binary verdict — `APPROVED` or `BLOCKED`, with no qualifiers permitted.

> **Segmented PR Review rule (AAP § 0.8.2):** the review runs as a **complete, atomic pass** against the final delivered state. No prior review iteration confers approval credit to a subsequent pass. Phase 0 pre-flight must confirm its conditions before any domain phase may begin. If any Phase 0 condition fails, the review terminates immediately and remediation occurs in code generation. After all domain phases are `APPROVED`, Phase 8 issues the final binary verdict.

---

## Phase 0 — Pre-flight

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (Lead Validation Engineer)_
**Date:** _Pending_

### Purpose

Every review pass MUST begin with an atomic Phase 0 pre-flight that confirms all conditions enumerated below. If **any** condition fails, the review MUST terminate immediately, log the failures, and return to code generation **without** proceeding to Phase 1. No prior review pass confers approval credit; each pass must independently satisfy Phase 0.

### Pre-flight Conditions

| #   | Condition                                                                                                                 | Outcome   |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Every file listed in the AAP's required deliverables (§ 0.6.1, § 0.2.3) exists at its specified path.                     | `PENDING` |
| 2   | The project builds with zero errors and zero new warnings (`npx nx build client`, `npx nx build api`).                    | `PENDING` |
| 3   | All required test files are authored and all tests pass (registry, layout service, canvas, catalog, controller, service). | `PENDING` |
| 4   | All static analysis gates pass with zero violations (`npx nx run-many --target=lint --all`).                              | `PENDING` |
| 5   | No production-path method in any required file returns a placeholder / stub value.                                        | `PENDING` |
| 6   | The Prisma migration for `UserDashboardLayout` applies cleanly with no conflict against `User` / `FinancialProfile`.      | `PENDING` |

### Phase 0 Verdict

**`PENDING`.** The pre-flight conditions will be confirmed at the start of the review. Only once all conditions are satisfied may the review proceed sequentially through Phases 1–7, then to the Principal Reviewer in Phase 8.

---

## Phase 1 — Infrastructure / DevOps

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (Infrastructure / DevOps Expert)_
**Date:** _Pending_

### Scope

| File                           | Change Kind                                               | AAP Reference        |
| ------------------------------ | --------------------------------------------------------- | -------------------- |
| `package.json`                 | ADD `angular-gridster2@21.0.1` to `dependencies`          | § 0.3.1, § 0.3.2     |
| `package-lock.json`            | Auto-regenerated by `npm install` (no manual edits)       | § 0.3.2              |
| `apps/client/ngsw-config.json` | Conditional — single-route caching adjustment for the SPA | § 0.4.1.1, § 0.6.1.5 |

This phase is **explicitly NOT** responsible for editing `Dockerfile`, `docker-compose*.yml`, `.github/workflows/*.yml`, `nx.json`, or `tsconfig*.json` — none of those is in AAP scope.

### Review Checklist

- [ ] `package.json` `dependencies` includes exactly `"angular-gridster2": "21.0.1"` (exact pin per AAP § 0.3.1); no existing dependency version is changed and no package is removed (`git diff package.json` shows one addition).
- [ ] `package-lock.json` is regenerated via `npm install` and committed; the lockfile is reproducible (`npm ci` succeeds clean from the lockfile).
- [ ] The grid engine's Angular peer requirements are satisfied by the installed `@angular/core` 21.2.7, `@angular/common`, and `@angular/cdk` 21.2.5 — no peer-dependency conflict on install.
- [ ] `apps/client/ngsw-config.json` (if modified) remains valid JSON and the service worker continues to handle navigation for the single-route SPA.
- [ ] **Build & Migration Gate (build half):** `npx nx build client` and `npx nx build api` complete with zero errors after the dependency addition.
- [ ] No CI/CD workflow file is modified; `nx.json`, `tsconfig*.json`, and the ESLint config are unchanged.
- [ ] No real credential or secret value is committed in any file.

### Status & Sign-Off

| Field         | Value            |
| ------------- | ---------------- |
| Status        | `PENDING`        |
| Reviewer      | _To be assigned_ |
| Decision date | _Pending_        |
| Findings      | _Pending review_ |

### Handoff Notes for Phase 2 (Security)

When Phase 1 marks `APPROVED`, document the following for Phase 2:

1. **Confirmed dependency surface.** Phase 2 may perform a security audit of the freshly installed transitive dependency tree introduced by `angular-gridster2` (`npm audit`).
2. **Confirmed lockfile integrity.** Phase 2 may rely on a reproducible lockfile when reasoning about the supply-chain surface.
3. **No secrets committed.** Phase 2 must run a secret-scanning sweep to confirm no real credentials slipped into the diff.

---

## Phase 2 — Security

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (Security Expert)_
**Date:** _Pending_

### Scope

| Concern                                      | Scope of Verification                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint authentication & authorization**  | `apps/api/src/app/user/user-dashboard-layout.controller.ts` — `AuthGuard('jwt')` + `HasPermissionGuard` + `@HasPermission(...)` on both methods.    |
| **Per-user layout authorization**            | `apps/api/src/app/user/user-dashboard-layout.service.ts` — every Prisma op scoped to a JWT-derived `userId`; no cross-user read/write.              |
| **Permission constants**                     | `libs/common/src/lib/permissions.ts` — new `readUserDashboardLayout` / `updateUserDashboardLayout` constants granted to the correct role sets.      |
| **Input-validation hardening (DoS defense)** | `apps/api/src/app/user/dtos/update-user-dashboard-layout.dto.ts` — `class-validator` size caps on `layoutData` (array length, string length, ints). |

### Review Checklist

#### Endpoint authentication & authorization

- [ ] `GET /api/v1/user/layout` returns HTTP 401 without a valid JWT.
- [ ] `PATCH /api/v1/user/layout` returns HTTP 401 without a valid JWT.
- [ ] Both endpoints use the canonical `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` pattern, matching the `user-financial-profile.controller.ts` precedent.
- [ ] Each endpoint declares the correct `@HasPermission(...)` decorator (`readUserDashboardLayout` for GET, `updateUserDashboardLayout` for PATCH); absent permission yields HTTP 403.

#### Per-user layout authorization

- [ ] Every `prisma.userDashboardLayout.findUnique(...)` / `upsert(...)` call in the service includes a `where: { userId }` filter.
- [ ] The `userId` used in every Prisma call is derived from the JWT payload (`request.user.id`) — never from request body, query string, or URL parameter.
- [ ] The controller reads `request.user.id` and passes it to the service as the first positional argument; the service signature requires `userId` (not optional).
- [ ] **Negative case:** a user with id `A` cannot read or modify the `UserDashboardLayout` row of user `B`, even with a forged request body.

#### Permission constants

- [ ] `libs/common/src/lib/permissions.ts` defines `readUserDashboardLayout` and `updateUserDashboardLayout` alongside the existing `readFinancialProfile` / `updateFinancialProfile` constants.
- [ ] Both new permissions are granted in the appropriate role permission sets (consistent with how the financial-profile permissions are granted).

#### Input-validation hardening (DoS defense)

- [ ] `update-user-dashboard-layout.dto.ts` validates `layoutData` as a structured array with `@ArrayMaxSize(...)` bounding the number of modules.
- [ ] Each item validates `moduleKey` (`@IsString`, `@MaxLength`) and geometry fields (`@IsInt`, `@Min`) for `x`, `y`, `cols`, `rows`.
- [ ] Oversized or malformed payloads are rejected with HTTP 400 (not 500) before reaching Prisma.
- [ ] No secret-scanning sweep finds real credentials in any new or modified file.

### Status & Sign-Off

| Field         | Value            |
| ------------- | ---------------- |
| Status        | `PENDING`        |
| Reviewer      | _To be assigned_ |
| Decision date | _Pending_        |
| Findings      | _Pending review_ |

### Handoff Notes for Phase 3 (Backend Architecture)

When Phase 2 marks `APPROVED`, document the following for Phase 3:

1. **Auth surface confirmed clean.** Phase 3 may proceed without re-auditing the guard wiring and can focus on architectural shape.
2. **JWT-derived `userId` is authoritative.** Phase 3 must verify the service signature requires `userId` as its first argument.
3. **DTO caps are enforced.** Phase 3 must verify the controller delegates DTO validation rather than re-implementing it.

---

## Phase 3 — Backend Architecture

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (Backend Architecture Expert)_
**Date:** _Pending_

### Scope

| Component        | Files                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Layout endpoints | `apps/api/src/app/user/user-dashboard-layout.controller.ts`                                   |
| Layout service   | `apps/api/src/app/user/user-dashboard-layout.service.ts`                                      |
| DTO              | `apps/api/src/app/user/dtos/update-user-dashboard-layout.dto.ts`                              |
| Module wiring    | `apps/api/src/app/user/user.module.ts` (register controller + service in providers / exports) |
| Observability    | `apps/api/src/app/metrics/*` (additive layout metrics)                                        |

### Review Checklist

#### Controller thinness

- [ ] No new controller method body exceeds the ~10-line thinness convention (counted `{` to `}`, exclusive of decorators and signature).
- [ ] No `prisma.*` or `this.prisma...` reference appears in `user-dashboard-layout.controller.ts`.
- [ ] Controllers only: source `userId` from `this.request.user.id`, set the `X-Correlation-ID` response header (`randomUUID` from `node:crypto`), delegate to the service, and return the result.
- [ ] `GET` returns the layout with HTTP 200, or throws `NotFoundException` (HTTP 404) when no record exists.
- [ ] `PATCH` is annotated `@HttpCode(HttpStatus.OK)` and returns the persisted layout.

#### Service correctness

- [ ] `user-dashboard-layout.service.ts` is `@Injectable` and injects the global `PrismaService`.
- [ ] `findByUserId(userId, correlationId?)` returns `null` when no record exists (controller maps `null` → 404).
- [ ] `upsertForUser(userId, dto, correlationId?)` performs a Prisma `upsert` keyed on `userId`.
- [ ] Every method accepts an optional `correlationId` propagated to a `@nestjs/common` `Logger` with a `[<correlationId>]` prefix; Prisma calls are wrapped in `try/catch` with `Logger.error`.

#### Module wiring & route resolution

- [ ] `user.module.ts` registers `UserDashboardLayoutController` in `controllers` and `UserDashboardLayoutService` in `providers` (and `exports` if consumed elsewhere); `PrismaModule` is already imported.
- [ ] `@Controller('user/layout')` resolves to `/api/v1/user/layout` via the global prefix and URI versioning in `apps/api/src/main.ts`.
- [ ] Application bootstraps without DI errors; no dead providers.

#### Observability (additive)

- [ ] Any layout-specific metrics added under `apps/api/src/app/metrics/*` are additive and do not alter existing metric registrations.
- [ ] **Persistence Debounce Gate (server half):** the `PATCH` handler persists the payload it receives; the ~500ms debounce is owned by the client (verified in Phase 6).

### Status & Sign-Off

| Field         | Value            |
| ------------- | ---------------- |
| Status        | `PENDING`        |
| Reviewer      | _To be assigned_ |
| Decision date | _Pending_        |
| Findings      | _Pending review_ |

### Handoff Notes for Phase 4 (QA / Test Integrity)

When Phase 3 marks `APPROVED`, document the following for Phase 4:

1. **Architecture is sound.** Phase 4 may focus purely on test coverage and behavioral correctness.
2. **Mock surface is well-defined.** Phase 3 confirms which service methods are public and injectable; Phase 4 verifies the spec mocks mirror these surfaces.
3. **404→`null` contract.** Phase 4 must verify the service returns `null` (not a throw) when no record exists, and that the controller maps it to 404.

---

## Phase 4 — QA / Test Integrity

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (QA / Test Integrity Expert)_
**Date:** _Pending_

### Scope

All new `*.spec.ts` files following the co-located test convention:

| Path                                                             | Coverage Target                        |
| ---------------------------------------------------------------- | -------------------------------------- |
| `apps/client/src/app/dashboard/module-registry.service.spec.ts`  | Registry register / get / getAll / has |
| `apps/client/src/app/dashboard/dashboard-layout.service.spec.ts` | 404→`null`, 500ms debounce, queueSave  |
| `apps/client/src/app/dashboard/dashboard-canvas/*.spec.ts`       | Canvas init, hydrate, placement, save  |
| `apps/client/src/app/dashboard/module-catalog/*.spec.ts`         | Search filter, add / remove, auto-open |
| `apps/api/src/app/user/user-dashboard-layout.controller.spec.ts` | 200 / 404 / 401 contract               |
| `apps/api/src/app/user/user-dashboard-layout.service.spec.ts`    | `findByUserId` / `upsertForUser`       |

### Review Checklist

#### Pre-existing test-suite integrity

- [ ] `npm run test:api` passes (no regression in the pre-existing suite).
- [ ] `npm run test:common` passes (pre-existing baseline preserved).
- [ ] `npm run test:ui` passes (pre-existing baseline preserved).
- [ ] Client test suite passes for the new dashboard component / service specs.

#### Coverage of acceptance criteria (AAP § 0.8.3)

- [ ] **Test Coverage Gate:** ≥80% line coverage for `module-registry.service.ts`, `dashboard-layout.service.ts`, and `dashboard-canvas.component.ts`.
- [ ] Registry: unit tests assert all registered module types are returned by `getAll()` and resolvable by `get(key)`.
- [ ] Canvas: initialization test asserts a `null` layout opens the catalog and a non-`null` layout hydrates the grid.
- [ ] Layout service: a 404 from `GET` is translated to `null`; `queueSave(...)` issues a single `PATCH` after the debounce window for a burst of changes.
- [ ] Integration: `GET` / `PATCH /api/v1/user/layout` behavior is exercised (200 / 404 / 401).
- [ ] Scenario — new user: blank canvas + catalog auto-open when no saved layout exists.
- [ ] Scenario — returning user: saved layout loads on app init.
- [ ] Scenario — save-on-event: drag / resize / add / remove each triggers a debounced save.
- [ ] Scenario — unauthenticated: layout endpoints return 401.
- [ ] Scenario — below-minimum: a resize below `minItemCols`/`minItemRows` is rejected by the engine.

#### Test hygiene

- [ ] No `*.spec.ts` is committed with `xit`, `xdescribe`, or `.skip(...)` beyond any pre-existing baseline skip.
- [ ] No `blitzy_adhoc_test_*` or other temporary test artifacts are committed.
- [ ] No real credentials appear in any spec fixture or mock; all inputs are synthetic placeholders.

### Status & Sign-Off

| Field         | Value            |
| ------------- | ---------------- |
| Status        | `PENDING`        |
| Reviewer      | _To be assigned_ |
| Decision date | _Pending_        |
| Findings      | _Pending review_ |

### Handoff Notes for Phase 5 (Business / Domain)

When Phase 4 marks `APPROVED`, document the following for Phase 5:

1. **Tests demonstrate behavioral conformance.** Phase 5 may rely on the spec assertions to validate domain alignment.
2. **Scenario fixtures.** The new-user and returning-user scenario fixtures are identified for Phase 5 walk-through.

---

## Phase 5 — Business / Domain

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (Business / Domain Expert)_
**Date:** _Pending_

### Scope

| Domain Concern                                      | Source of Truth                                           |
| --------------------------------------------------- | --------------------------------------------------------- |
| Catalog completeness (all features as modules)      | AAP § 0.2.1.1 (module candidates), § 0.8.3                |
| Preserved data services / business logic untouched  | AAP § 0.1.2.3 (boundary directives)                       |
| Onboarding behavior (first-visit vs returning user) | AAP § 0.1.1, § 0.8.1 (first-visit catalog auto-open)      |
| ChatPanel extraction (documented deviation)         | AAP § 0.1.2.2 (intentional deviation, decision-log entry) |

### Review Checklist

#### Catalog completeness

- [ ] Every authenticated feature component is registered as a selectable module: Portfolio Overview (`gf-home-overview`), Holdings (`gf-home-holdings`), Summary (`gf-home-summary`), Markets (`gf-home-market`), Watchlist (`gf-home-watchlist`), Portfolio Summary (`gf-portfolio-summary`), Transactions (`gf-activities-page`), Allocations (`gf-allocations-page`), Analysis (`gf-analysis-page`), FIRE (`gf-fire-page`), X-ray (`gf-x-ray-page`), and AI Chat (`app-chat-panel`).
- [ ] **Catalog Completeness Gate:** the catalog lists all registered modules, searchable by name.

#### Preserved boundaries

- [ ] All existing data-fetching services (`PortfolioService`, `SymbolService`, and the other established feature services per AAP § 0.1.2.3) are unchanged — data-fetching, business logic, and Ghostfolio API integrations preserved.
- [ ] Existing feature components are **referenced by** wrappers, not modified (module-isolation rule — internal refactoring is out of scope).
- [ ] No out-of-scope domain is introduced (no mobile/responsive support, no shared layouts, no admin-defined defaults, no multi-user collaboration).

#### Onboarding behavior

- [ ] **Onboarding Gate (new user):** a user with no saved layout is presented with a blank canvas and the catalog auto-opens.
- [ ] **Onboarding Gate (returning user):** a user with a saved layout has it loaded on app init; the catalog does not auto-open.
- [ ] The AI Chat panel appears as a first-class, selectable module on the blank canvas (the documented ChatPanel extraction).

#### Documented deviation

- [ ] The inline `<app-chat-panel></app-chat-panel>` embed in `portfolio-page.html` is removed and re-hosted as an "AI Chat" grid module, and this deviation is recorded in the decision log (AAP § 0.1.2.2).

### Status & Sign-Off

| Field         | Value            |
| ------------- | ---------------- |
| Status        | `PENDING`        |
| Reviewer      | _To be assigned_ |
| Decision date | _Pending_        |
| Findings      | _Pending review_ |

### Handoff Notes for Phase 6 (Frontend)

When Phase 5 marks `APPROVED`, document the following for Phase 6:

1. **Domain inventory confirmed.** Phase 6 may verify each catalog module resolves to the expected feature component via the registry.
2. **Onboarding contract.** Phase 6 must verify the `null`-layout → catalog-auto-open wiring end-to-end.

---

## Phase 6 — Frontend

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (Frontend Expert)_
**Date:** _Pending_

### Scope

| File                                                                          | Type            | Phase 6 Verification                                  |
| ----------------------------------------------------------------------------- | --------------- | ----------------------------------------------------- |
| `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.*` | New component   | `GridsterConfig` (12-col, fixed row height, 2×2 min)  |
| `apps/client/src/app/dashboard/module-registry.service.ts`                    | New service     | `Map<string, ModuleDefinition>`; registry-only intro  |
| `apps/client/src/app/dashboard/module-catalog/module-catalog.component.*`     | New component   | Searchable catalog; add / remove; auto-open           |
| `apps/client/src/app/dashboard/dashboard-layout.service.ts`                   | New service     | 404→`null`; 500ms debounce; `queueSave` only entry    |
| `apps/client/src/app/dashboard/modules/**`                                    | New wrappers    | Module isolation; no layout state; no canvas import   |
| `apps/client/src/app/dashboard/dashboard.types.ts`                            | New types       | `ModuleDefinition`, `DashboardItem`, `LayoutData`     |
| `apps/client/src/app/app.routes.ts`                                           | Wiring (modify) | Single `path: ''` → canvas; router providers retained |
| `apps/client/src/app/app.component.{ts,html,scss}`                            | Wiring (modify) | Render canvas; neutralize tab-nav inputs              |
| `apps/client/src/app/components/header/header.component.{ts,html,scss}`       | Wiring (modify) | Retain user/account controls; shed tab navigation     |
| `apps/client/src/app/pages/portfolio/portfolio-page.html`                     | Wiring (modify) | Remove the inline `<app-chat-panel>` embed            |
| `apps/client/src/app/pages/portfolio/portfolio-page.component.ts`             | Wiring (modify) | Remove `ChatPanelComponent` import / `imports` entry  |

### Review Checklist

#### Grid canvas

- [ ] `DashboardCanvasComponent` is a standalone, `OnPush` component importing `Gridster` and `GridsterItemComponent` from `angular-gridster2`.
- [ ] `GridsterConfig` sets `minCols`/`maxCols` = 12, a constant fixed row height, draggable + resizable enabled, and `itemChangeCallback`/`itemResizeCallback` wired to the layout service's debounced save.
- [ ] Each grid item renders its module via `NgComponentOutlet` resolving `registry.get(item.moduleKey).component`.
- [ ] The grid API is obtained via `viewChild(Gridster).api` / `initCallback` per the v21 API (no `optionsChanged()`).
- [ ] **Grid state single source of truth:** the `GridsterItem[]` (`DashboardItem[]`) array on the canvas is authoritative; module components hold no layout state.

#### Registry & catalog

- [ ] **Registry-only introduction:** `ModuleRegistryService` is `providedIn: 'root'`, holds a `Map<string, ModuleDefinition>`, registers all module definitions in its constructor, and exposes `register`/`get`/`getAll`/`has`; ad-hoc component insertion is absent.
- [ ] `ModuleCatalogComponent` filters a `MatList`/`MatCard` of registered modules via a `MatFormField` search input.
- [ ] **Placement Gate:** selecting (click or drag) a catalog entry places the module at the next available grid position (first-fit using the gridster position helpers).
- [ ] A module-header action removes a module from the grid.
- [ ] **Onboarding Gate:** the catalog auto-opens on first visit when the layout is `null`.

#### Layout persistence (client)

- [ ] `DashboardLayoutService` wraps `GET`/`PATCH /api/v1/user/layout`; `get()` translates HTTP 404 to `null` via `catchError` (mirroring `FinancialProfileService`).
- [ ] A private `persist$` `Subject` piped through `debounceTime(500)` + `switchMap` issues the `PATCH`.
- [ ] **Persistence Debounce Gate (client half):** `queueSave(layout)` is the only public save entry point and is invoked solely by the canvas's grid-event handlers — module components never call it.
- [ ] `layoutData` is a versioned array of `{ moduleKey, x, y, cols, rows }` entries carrying a `schemaVersion` field.

#### Module isolation

- [ ] **Module isolation:** each wrapper hosts its existing feature component, adds `MatCard` chrome (title + remove `MatIconButton`), and does **not** import or reference the canvas layer.
- [ ] Data flows exclusively through existing services; wrappers hold no layout state.

#### Minimum cell dimensions

- [ ] **Minimum Cell Dimension Gate:** each `ModuleDefinition` declares `minItemCols`/`minItemRows`; the grid engine enforces global and per-item minimums (≥ 2×2) and rejects below-minimum resizes.

#### Router preservation

- [ ] **Router Integrity Gate:** `app.routes.ts` collapses to a single `path: ''` route rendering the canvas, with no additional routes for the authenticated surface; `RouterModule.forRoot`, `ServiceWorkerModule`, `PageTitleStrategy`, and `ModulePreloadService` in `main.ts` are preserved unchanged.
- [ ] Authentication, bootstrap, and public routes remain operational.
- [ ] `portfolio-page.html` no longer contains the inline `<app-chat-panel>` embed; `portfolio-page.component.ts` no longer imports `ChatPanelComponent`.

#### MD3 token discipline (Decision D-020)

- [ ] **MD3 Token Discipline Gate:** all grid-chrome CSS property values resolve to MD3 system tokens via `var(--mat-sys-<token>, <hardcoded-fallback>)`; bare `--mat-sys-*` without a fallback is absent.
- [ ] The drop-zone / active highlight uses `var(--mat-sys-primary-container, <fallback>)`.
- [ ] All new UI strings carry `i18n` attributes (the client builds with `localize: true`).

#### Build & lint

- [ ] `npx nx build client` completes with no new TypeScript errors.
- [ ] `npx nx lint client` passes with no new ESLint violations.
- [ ] **Interaction Performance Gate:** drag / resize visual update completes within ~100ms on the zone-based setup (v21 retains `NgZone` behavior for zone.js apps).

### Status & Sign-Off

| Field         | Value            |
| ------------- | ---------------- |
| Status        | `PENDING`        |
| Reviewer      | _To be assigned_ |
| Decision date | _Pending_        |
| Findings      | _Pending review_ |

### Handoff Notes for Phase 7 (Other SME — Database / Prisma)

When Phase 6 marks `APPROVED`, document the following for Phase 7:

1. **Client persistence contract verified.** Phase 7 may rely on the `PATCH` payload shape (versioned `layoutData` array) when reasoning about the column type.
2. **`layoutData` is JSONB.** Phase 7 must confirm the Prisma `Json` column maps to PostgreSQL `jsonb` and that the migration is additive.

---

## Phase 7 — Other SME (Database / Prisma)

**Phase status: `PENDING`**
**Owning Expert Agent:** _To be assigned (Database / Prisma SME)_
**Date:** _Pending_

### Scope

| File                                                                    | Concern                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `prisma/schema.prisma`                                                  | `UserDashboardLayout` model + `User` back-relation; no conflict with existing models |
| `prisma/migrations/<timestamp>_add_user_dashboard_layout/migration.sql` | Additive `CREATE TABLE`; cascade-delete FK; clean apply                              |
| `angular-gridster2` grid-engine integration                             | Version pin, Angular-21 alignment, zone.js compatibility                             |

### Review Checklist

#### Prisma model correctness

- [ ] **Schema-precondition rule:** `prisma/schema.prisma` was read before the migration was authored; the new model does not conflict with `User` or `FinancialProfile`.
- [ ] `UserDashboardLayout` is keyed by `userId String @id`, with `layoutData Json`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`, and a `user User @relation(fields: [userId], references: [id], onDelete: Cascade)` relation — mirroring `FinancialProfile`.
- [ ] The `User` model declares the matching `dashboardLayout UserDashboardLayout?` back-relation (required by Prisma 7.7.0 for both sides of a 1:1 association).
- [ ] The `layoutData Json` column maps to PostgreSQL `jsonb`.

#### Migration correctness

- [ ] **Build & Migration Gate (migration half):** the generated migration is a non-conflicting additive `CREATE TABLE` and applies cleanly (`prisma migrate` / `database:push`).
- [ ] The foreign key on `userId` references `User(id)` with `ON DELETE CASCADE`.
- [ ] No existing table or column is altered or dropped by the migration.
- [ ] `@prisma/client` is regenerated (not version-bumped) so the `userDashboardLayout` delegate is available on `PrismaService`.

#### Grid-engine integration (SME)

- [ ] `angular-gridster2` is pinned to exactly `21.0.1` (Angular-major alignment scheme; v21 ↔ Angular 21).
- [ ] The v21 line retains `NgZone.run`/`NgZone.runOutsideAngular`, compatible with Ghostfolio's zone-based `provideZoneChangeDetection()` setup.
- [ ] The standalone usage pattern is used: `import { Gridster, GridsterItemComponent } from 'angular-gridster2'` with `<gridster [options]>` and `@for`-rendered `<gridster-item [item]>`.

### Status & Sign-Off

| Field         | Value            |
| ------------- | ---------------- |
| Status        | `PENDING`        |
| Reviewer      | _To be assigned_ |
| Decision date | _Pending_        |
| Findings      | _Pending review_ |

### Handoff Notes for Phase 8 (Principal Reviewer)

When Phase 7 marks `APPROVED`, document the following for Phase 8:

1. **All seven domain phases complete.** Phase 8 may begin holistic consolidation.
2. **Every rule from AAP § 0.8.1 has a phase claiming verification responsibility.** Phase 8 confirms the cross-phase coverage matrix is complete.
3. **Every acceptance gate from AAP § 0.8.3 has a designated owning phase.**

---

## Phase 8 — Principal Reviewer (Final Sign-Off)

**Phase status: `PENDING`**
**Owning Reviewer:** _To be assigned (Principal Engineer)_
**Date:** _Pending_

### Scope

Holistic review across all seven prior phases. The Principal Reviewer:

1. Confirms each prior phase is `APPROVED`.
2. Verifies alignment with the Agent Action Plan (AAP § 0.1 through § 0.8).
3. Confirms all feature-specific rules in AAP § 0.8.1 are satisfied across the codebase.
4. Confirms all project governance rules in AAP § 0.8.2 are satisfied (Observability, Explainability, Executive Presentation, Segmented PR Review).
5. Confirms all acceptance gates in AAP § 0.8.3 pass.
6. Confirms scope boundaries (AAP § 0.7) are respected.
7. Authorizes PR creation.

### Final Review Checklist

#### Phase consolidation

- [ ] Phase 1 (Infrastructure / DevOps) status is `APPROVED`.
- [ ] Phase 2 (Security) status is `APPROVED`.
- [ ] Phase 3 (Backend Architecture) status is `APPROVED`.
- [ ] Phase 4 (QA / Test Integrity) status is `APPROVED`.
- [ ] Phase 5 (Business / Domain) status is `APPROVED`.
- [ ] Phase 6 (Frontend) status is `APPROVED`.
- [ ] Phase 7 (Other SME — Database / Prisma) status is `APPROVED`.

#### Feature-specific rules from AAP § 0.8.1

- [ ] Module isolation — verified by Phase 6.
- [ ] Grid state as single source of truth — verified by Phase 6.
- [ ] Registry-only introduction — verified by Phase 6.
- [ ] Grid-event-driven persistence — verified by Phase 3 + Phase 6.
- [ ] Router preservation — verified by Phase 6.
- [ ] Minimum cell dimensions — verified by Phase 6.
- [ ] MD3 token discipline (D-020) — verified by Phase 6.
- [ ] Auth-guarded endpoints — verified by Phase 2.
- [ ] Schema precondition — verified by Phase 7.
- [ ] First-visit catalog auto-open — verified by Phase 5 + Phase 6.

#### Project governance rules from AAP § 0.8.2

- [ ] **Observability:** structured logging with correlation IDs, the reused `health/` and `metrics/` modules, layout-specific metrics, and a dashboard template / runbook exist and are verified locally.
- [ ] **Explainability:** the decision-log table is complete (including the ChatPanel-extraction and route-collapse entries) and a bidirectional traceability matrix maps source navigation constructs to target module/grid implementations at 100% coverage.
- [ ] **Executive Presentation:** the self-contained reveal.js HTML executive summary (12–18 slides, target 16) exists with the Blitzy theme inline and CDN versions pinned to reveal.js 5.1.0 / Mermaid 11.4.0 / Lucide 0.460.0.
- [ ] **Segmented PR Review:** this `CODE_REVIEW.md` reaches all eight phases `APPROVED` before the PR is opened.

#### Acceptance gates from AAP § 0.8.3

- [ ] Catalog Completeness Gate — all features (incl. AI chat) appear as selectable modules.
- [ ] Placement Gate — added modules land at the next available position.
- [ ] Interaction Performance Gate — drag / resize visual update within ~100ms.
- [ ] Persistence Debounce Gate — layout saves within the ~500ms debounce.
- [ ] Layout GET Contract Gate — saved layout (≤300ms p95), 404→`null`, 401 unauthenticated.
- [ ] Layout PATCH Contract Gate — persists + returns 200, 401 unauthenticated.
- [ ] Onboarding Gate — new user blank+catalog; returning user saved layout.
- [ ] Router Integrity Gate — router infrastructure remains functional.
- [ ] Minimum Cell Dimension Gate — below-minimum resizes rejected.
- [ ] MD3 Token Discipline Gate — token+fallback pattern throughout grid chrome.
- [ ] Auth Guard Gate — 401 when unauthenticated.
- [ ] Build & Migration Gate — `npx nx build client` / `api` succeed; migration applies clean.
- [ ] Test Coverage Gate — ≥80% for registry service, layout service, canvas.

#### Scope boundaries

- [ ] Only the in-scope files enumerated in AAP § 0.7.1 are modified.
- [ ] No out-of-scope domain is introduced (no mobile/responsive layout, no shared/admin layouts, no multi-user collaboration).
- [ ] Preserved data services, business logic, the F-020 AI feature, and the existing theme/tokens are unchanged.
- [ ] Only the additive `UserDashboardLayout` model and the required `User` back-relation touch the Prisma schema.

#### Final integration smoke

- [ ] `git diff <base> --name-only` shows exactly the in-scope files (no surprises).
- [ ] `npx nx format:check` passes.
- [ ] `npx nx lint api && npx nx lint client && npx nx lint common && npx nx lint ui` all pass.

### Status

| Field    | Value            |
| -------- | ---------------- |
| Status   | `PENDING`        |
| Reviewer | _To be assigned_ |

### Final Sign-Off

_Pending._ The Principal Reviewer will record the consolidated findings and the binary verdict (`APPROVED` or `BLOCKED`) after all seven domain phases are resolved.

- **Reviewer Name:** _To be assigned_
- **Date:** _Pending_
- **Decision:** _Pending_
- **Authorization to open PR:** _Pending_

---

## Traceability Matrix

The following bidirectional matrix maps each review phase to the files in scope, the feature-specific rules verified, and the acceptance gates verified. It satisfies the "bidirectional traceability matrix" requirement of the Explainability rule (AAP § 0.8.2). Entries are scaffolded from the AAP's in-scope inventory and are confirmed by each phase during review.

### Phase → Files / Rules / Gates

| Phase | Domain                      | Files in Scope                                                                                                                                                                                   | Rule(s) Verified                                                                               | Gate(s) Verified                                                                      |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1     | Infrastructure / DevOps     | `package.json`, `package-lock.json`, `apps/client/ngsw-config.json`                                                                                                                              | —                                                                                              | Build & Migration Gate (build half)                                                   |
| 2     | Security                    | `apps/api/src/app/user/user-dashboard-layout.controller.ts`, `user-dashboard-layout.service.ts`, `dtos/update-user-dashboard-layout.dto.ts`, `libs/common/src/lib/permissions.ts`                | Auth-guarded endpoints                                                                         | Auth Guard Gate, Layout GET/PATCH Contract Gates (401)                                |
| 3     | Backend Architecture        | `user-dashboard-layout.controller.ts`, `user-dashboard-layout.service.ts`, `dtos/update-user-dashboard-layout.dto.ts`, `apps/api/src/app/user/user.module.ts`, `apps/api/src/app/metrics/*`      | Grid-event-driven persistence (server)                                                         | Layout GET/PATCH Contract Gates, Persistence Debounce Gate                            |
| 4     | QA / Test Integrity         | All new `*.spec.ts` under `apps/client/src/app/dashboard/**` and `apps/api/src/app/user/*dashboard-layout*`                                                                                      | All rules (test coverage)                                                                      | Test Coverage Gate                                                                    |
| 5     | Business / Domain           | Module candidates (read-only); preserved services; onboarding behavior; ChatPanel extraction                                                                                                     | First-visit catalog auto-open                                                                  | Catalog Completeness Gate, Onboarding Gate                                            |
| 6     | Frontend                    | `apps/client/src/app/dashboard/**` (canvas, registry, catalog, layout service, wrappers, types) + nav-shell edits (`app.routes.ts`, `app.component.*`, `header.component.*`, `portfolio-page.*`) | Module isolation, single source of truth, registry-only, router preservation, min cells, D-020 | Placement, Interaction Performance, Router Integrity, Min Cell, MD3, Onboarding Gates |
| 7     | Other SME (Database/Prisma) | `prisma/schema.prisma`, `prisma/migrations/**/*add_user_dashboard_layout*`                                                                                                                       | Schema precondition                                                                            | Build & Migration Gate (migration half)                                               |
| 8     | Principal Reviewer          | Holistic — all in-scope files                                                                                                                                                                    | All rules (§ 0.8.1)                                                                            | All gates (§ 0.8.3)                                                                   |

### Rule → Verifying Phase(s)

| Rule (AAP § 0.8.1)                   | Verifying Phase(s) |
| ------------------------------------ | ------------------ |
| Module isolation                     | Phase 6            |
| Grid state as single source of truth | Phase 6            |
| Registry-only introduction           | Phase 6            |
| Grid-event-driven persistence        | Phase 3, Phase 6   |
| Router preservation                  | Phase 6            |
| Minimum cell dimensions              | Phase 6            |
| MD3 token discipline (D-020)         | Phase 6            |
| Auth-guarded endpoints               | Phase 2            |
| Schema precondition                  | Phase 7            |
| First-visit catalog auto-open        | Phase 5, Phase 6   |

### Gate → Verifying Phase(s)

| Gate (AAP § 0.8.3)           | Verifying Phase(s) |
| ---------------------------- | ------------------ |
| Catalog Completeness Gate    | Phase 5, Phase 6   |
| Placement Gate               | Phase 6            |
| Interaction Performance Gate | Phase 6            |
| Persistence Debounce Gate    | Phase 3, Phase 6   |
| Layout GET Contract Gate     | Phase 2, Phase 3   |
| Layout PATCH Contract Gate   | Phase 2, Phase 3   |
| Onboarding Gate              | Phase 5, Phase 6   |
| Router Integrity Gate        | Phase 6            |
| Minimum Cell Dimension Gate  | Phase 6            |
| MD3 Token Discipline Gate    | Phase 6            |
| Auth Guard Gate              | Phase 2            |
| Build & Migration Gate       | Phase 1, Phase 7   |
| Test Coverage Gate           | Phase 4            |

### Feature → Implementation Files

| Feature                       | Client                                                                                                                                                     | API / Database                                                                                                                                                                              | Shared / Cross-cutting                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Grid canvas**               | `apps/client/src/app/dashboard/dashboard-canvas/**`, `dashboard.types.ts`                                                                                  | —                                                                                                                                                                                           | `angular-gridster2@21.0.1` (`package.json`)                                                               |
| **Module registry & catalog** | `apps/client/src/app/dashboard/module-registry.service.ts`, `module-catalog/**`, `modules/**`                                                              | —                                                                                                                                                                                           | —                                                                                                         |
| **Layout persistence**        | `apps/client/src/app/dashboard/dashboard-layout.service.ts`                                                                                                | `apps/api/src/app/user/user-dashboard-layout.controller.ts`, `user-dashboard-layout.service.ts`, `dtos/update-user-dashboard-layout.dto.ts`, `prisma/schema.prisma`, `prisma/migrations/**` | `libs/common/src/lib/interfaces/user-dashboard-layout.interface.ts`, `libs/common/src/lib/permissions.ts` |
| **Navigation-shell refactor** | `app.routes.ts`, `app.component.{ts,html,scss}`, `components/header/header.component.{ts,html,scss}`, `pages/portfolio/portfolio-page.{html,component.ts}` | —                                                                                                                                                                                           | `apps/client/ngsw-config.json` (conditional)                                                              |

---

## Status Legend

| Status     | Meaning                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `PENDING`  | The phase has not yet been resolved by its Expert Agent. Initial state for all phases in a freshly created file.    |
| `APPROVED` | The phase is fully reviewed and signed off with zero blocking findings; the next phase may begin.                   |
| `BLOCKED`  | The review uncovered a blocking concern; the phase cannot advance until the concern is resolved in code generation. |

Per the Segmented PR Review rule, each phase and the final verdict resolve to exactly `APPROVED` or `BLOCKED` (binary, no qualifiers permitted) once the review is performed.

---

## Document History

| Version | Date       | Author                       | Change                                                                                                                                                                  |
| ------- | ---------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0.0   | 2026-06-15 | Blitzy Code Generation Agent | Initial creation per AAP § 0.8.2 (Segmented PR Review rule) for the Modular Dashboard System feature; Phase 0 plus all eight phases initialized with `status: PENDING`. |
