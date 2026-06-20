---
title: 'Code Review — Modular Dashboard System'
review_id: AAP-MODULAR-DASHBOARD-2026
created_at: 2026-06-20
review_completed_at: null
target_branch: TBD
base_branch: main
aap_reference: '§ 0.8.2 Project Governance Rules — Segmented PR Review'
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
  - name: Other SME (Grid Engine)
    phase: 7
    status: PENDING
    file_count: 0
  - name: Principal Reviewer
    phase: 8
    status: PENDING
    file_count: 0
---

# Code Review — Modular Dashboard System

> **Review Document Status:** This file is generated **at the moment the review begins** per the deferral in **AAP § 0.6.1.6** and the Segmented PR Review governance rule (**AAP § 0.8.2**). It is a **blank scaffold**: every phase is initialized to `PENDING` and no findings have been recorded yet. The review itself runs **after** the code-generation run completes. As each domain phase is reviewed, the owning Expert Agent updates that phase block (status, sign-off, findings). The Principal Reviewer in **Phase 8** then consolidates the seven prior phases into a single binary verdict — exactly `APPROVED` or `BLOCKED`, with **no qualifiers permitted**.

## Executive Summary

### Scope of Change

This pull request introduces the **Modular Dashboard System** described in the parent Agent Action Plan (AAP). The change replaces Ghostfolio's route-based Angular navigation shell with a single-canvas, drag-and-drop modular dashboard built on `angular-gridster2@21.0.1`, in which every existing authenticated UI feature becomes a self-contained, independently placeable grid module composed by the user and persisted per-user to the database. The complete in-scope inventory (to be confirmed file-by-file during review) is:

| Category                            | Count | Detail                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New client grid-core files          | TBD   | `dashboard-canvas.component.{ts,html,scss}`, `module-registry.service.ts`, `module-catalog.component.{ts,html,scss}`, `dashboard-layout.service.ts`, `dashboard.types.ts`, one isolation wrapper per feature module under `dashboard/modules/**`, and all co-located `*.spec.ts`                             |
| New API layout-feature files        | TBD   | `apps/api/src/app/user/user-dashboard-layout.controller.ts`, `user-dashboard-layout.service.ts`, `dtos/update-user-dashboard-layout.dto.ts`, plus co-located `*.spec.ts`                                                                                                                                     |
| New shared library file             | **1** | `libs/common/src/lib/interfaces/user-dashboard-layout.interface.ts`                                                                                                                                                                                                                                          |
| New Prisma model                    | **1** | `UserDashboardLayout` (keyed by `userId`, `layoutData Json`, `createdAt`, `updatedAt`, cascade-delete relation to `User`) plus the required `User` back-relation                                                                                                                                             |
| New database migration              | **1** | `prisma/migrations/<timestamp>_add_user_dashboard_layout/migration.sql` (additive `CREATE TABLE`)                                                                                                                                                                                                            |
| New npm dependency                  | **1** | `angular-gridster2@21.0.1` (the single justified non-Material UI dependency — the 12-column drag/resize grid engine)                                                                                                                                                                                         |
| New API endpoints                   | **2** | `GET /api/v1/user/layout`, `PATCH /api/v1/user/layout`                                                                                                                                                                                                                                                       |
| Modified navigation-shell files     | TBD   | `apps/client/src/app/app.routes.ts`, `apps/client/src/app/app.component.{ts,html,scss}`, `apps/client/src/app/components/header/header.component.{ts,html,scss}`, `apps/client/src/app/pages/portfolio/portfolio-page.html`, `portfolio-page.component.ts`, and (conditional) `apps/client/ngsw-config.json` |
| Modified API wiring / observability | TBD   | `apps/api/src/app/user/user.module.ts` (register controller + service), `apps/api/src/app/metrics/*` (additive layout metrics)                                                                                                                                                                               |
| Modified shared library             | **2** | `libs/common/src/lib/interfaces/index.ts` (barrel re-export), `libs/common/src/lib/permissions.ts` (two new permission constants + role grants)                                                                                                                                                              |
| Modified manifest                   | **2** | `package.json` (`angular-gridster2` entry), `package-lock.json` (regenerated on install)                                                                                                                                                                                                                     |
| Governance / observability          | TBD   | `CODE_REVIEW.md` (this file), `blitzy-deck/<dashboard-exec-summary>.html` (reveal.js), decision log + bidirectional traceability matrix (Markdown), observability dashboard template / runbook (Markdown)                                                                                                    |
| **Total in-scope files**            | TBD   | Enumerated and confirmed during the review pass                                                                                                                                                                                                                                                              |

### Risk Profile

| Risk Surface                                           | Severity       | Mitigations                                                                                                                                                                                                           |
| ------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-user layout exposure on `UserDashboardLayout`    | **Medium**     | Rule 8 — `userId` sourced exclusively from `request.user.id` (JWT-derived); every Prisma op scoped to `userId`; endpoints protected by `AuthGuard('jwt')` + `HasPermissionGuard`. Phase 2 audits.                     |
| Unbounded JSONB `layoutData` (DoS surface)             | **Medium**     | `update-user-dashboard-layout.dto.ts` applies `class-validator` size caps (`@ArrayMaxSize`, `@MaxLength` on `moduleKey`, `@IsInt`/`@Min` on geometry). Phase 2 verifies oversize payloads are rejected with HTTP 400. |
| Route collapse degrading auth / public routes          | **Medium**     | Rule 5 — the collapse targets only the authenticated in-app surface; `RouterModule.forRoot`, `ServiceWorkerModule`, `PageTitleStrategy`, and `ModulePreloadService` are preserved. Phase 6 verifies router integrity. |
| Persistence storm from rapid drag/resize               | **Low–Medium** | Rule 4 — persistence is grid-event-driven only and debounced ~500 ms via an RxJS `Subject` + `debounceTime`; module components never call the save API directly.                                                      |
| Below-minimum module resize                            | **Low**        | Rule 6 — each module declares minimum cell dimensions; the grid engine enforces `minItemCols`/`minItemRows` = 2 and rejects below-minimum resizes. Phase 7 verifies.                                                  |
| MD3 token regression (`--mat-sys-*` absent at runtime) | **Low**        | Rule 7 (Decision D-020) — all grid chrome uses the `var(--mat-sys-<token>, <hardcoded-fallback>)` pattern; bare `--mat-sys-*` references are prohibited. Phase 6 verifies.                                            |
| Disturbance of preserved feature components            | **Low**        | Rule 1 — wrappers reference existing feature components via `NgComponentOutlet`; no feature component is modified. Data flows exclusively through existing services.                                                  |
| Prisma migration conflict                              | **Low**        | Rule 9 — `schema.prisma` is read before writing the migration; the additive `CREATE TABLE` must not conflict with `User`/`FinancialProfile`. Phase 1 + Phase 3 verify the migration runs clean.                       |
| `zone.js` / grid-engine change-detection interaction   | **Low**        | `angular-gridster2` v21 retains `NgZone.run`/`NgZone.runOutsideAngular` for zone-based apps, compatible with Ghostfolio's `provideZoneChangeDetection()`. Phase 7 validates the ≤100 ms visual-update concern.        |

### Acceptance Gate Readiness

The following gates MUST pass before Phase 8 (Principal Reviewer) can issue the final `APPROVED` verdict. Each gate maps to one or more owning phases. All gates are `PENDING` until the review pass is executed.

| Gate                         | Description                                                                                                                        | Owning Phase(s)   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Build Integrity Gate         | `npx nx build client` and `npx nx build api` complete without errors                                                               | Phase 1           |
| Dependency Gate              | `angular-gridster2@21.0.1` pinned in `package.json`; lockfile reproducible (`npm ci` succeeds clean)                               | Phase 1           |
| Migration Gate               | The Prisma migration runs without conflicts; `prisma validate` / `prisma migrate` succeed                                          | Phase 1 + Phase 3 |
| Auth Gate                    | `GET`/`PATCH /api/v1/user/layout` return HTTP 401 when unauthenticated (`AuthGuard('jwt')` + `HasPermissionGuard`)                 | Phase 2           |
| DTO Validation Gate          | `layoutData` is validated; below-cap payloads accepted, oversize payloads rejected with HTTP 400                                   | Phase 2           |
| Layout Endpoint Gate         | `GET /api/v1/user/layout` returns the saved layout (≤300 ms p95) or 404 when absent; `PATCH` persists and returns HTTP 200         | Phase 2 + Phase 3 |
| Schema Precondition Gate     | `schema.prisma` read before migration; the new `UserDashboardLayout` model is non-conflicting with `User`/`FinancialProfile`       | Phase 3           |
| Controller Thinness Gate     | Layout controller methods stay within the thinness convention, contain no Prisma calls, and source `userId` from `request.user.id` | Phase 3           |
| Coverage Gate                | ≥80% line coverage for `ModuleRegistryService`, `DashboardLayoutService`, and `DashboardCanvasComponent`                           | Phase 4           |
| Catalog Completeness Gate    | All existing feature components appear as selectable catalog modules, including the AI chat panel                                  | Phase 5           |
| Onboarding Gate              | New user → blank canvas with the catalog auto-opened; returning user → saved layout loaded on app init                             | Phase 5 + Phase 6 |
| Persistence Debounce Gate    | Layout saves to the database within a ~500 ms debounce after a grid state change                                                   | Phase 6           |
| Router Integrity Gate        | Router infrastructure remains functional after the single-route collapse                                                           | Phase 6           |
| MD3 Token Gate               | All grid chrome uses `var(--mat-sys-<token>, <fallback>)`; no bare `--mat-sys-*` references                                        | Phase 6           |
| Placement Gate               | Adding a module from the catalog places it at the next available grid position                                                     | Phase 6 + Phase 7 |
| Interaction Performance Gate | Grid drag/resize completes its visual update within ~100 ms on the zone-based setup                                                | Phase 7           |
| Minimum Dimension Gate       | Below-minimum (2×2) resize attempts are rejected by the grid engine                                                                | Phase 7           |

### Review Workflow

```
Phase 0 (Pre-flight) → Phase 1 (Infra/DevOps) → Phase 2 (Security)
   → Phase 3 (Backend Architecture) → Phase 4 (QA / Test Integrity)
   → Phase 5 (Business / Domain) → Phase 6 (Frontend)
   → Phase 7 (Other SME — Grid Engine) → Phase 8 (Principal Reviewer)
```

Each phase blocks the next: a `BLOCKED` status on phase _n_ must be resolved (i.e., the underlying concern fixed and the status flipped to `APPROVED`) before phase _n+1_ may begin. Phase 0 pre-flight must pass before any domain phase begins; if any pre-flight condition fails, the review terminates immediately and remediation occurs in code generation. After all domain phases are `APPROVED`, Phase 8 issues a binary verdict — `APPROVED` or `BLOCKED`, with no qualifiers permitted.

---

## Phase 0 — Pre-flight

**Phase status: `PENDING`**
**Owning Expert Agent:** Lead Validation Engineer (Blitzy autonomous agent)
**Date:** —

### Purpose

Every review pass MUST begin with an atomic Phase 0 pre-flight that confirms all five conditions enumerated below. If **any** condition fails, the review MUST terminate immediately, log the failures, and return to code generation **without** proceeding to Phase 1. No prior review pass confers approval credit; each pass must independently satisfy Phase 0.

### Pre-flight Conditions and Evidence

| #   | Condition                                                                                                                             | Outcome     | Evidence  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------- |
| 1   | Every file listed in the AAP's required deliverables (AAP § 0.5.1, § 0.6.1, § 0.7.1) exists at its specified path.                    | **PENDING** | _Pending_ |
| 2   | The project builds with zero errors and zero new warnings (`npx nx build api`, `npx nx build client`).                                | **PENDING** | _Pending_ |
| 3   | All required test files are authored and all tests pass (`nx run-many --target=test`).                                                | **PENDING** | _Pending_ |
| 4   | All static analysis gates pass with zero violations (`nx run-many --target=lint`).                                                    | **PENDING** | _Pending_ |
| 5   | No production-path method in any required file returns a placeholder value (`???`, `NotImplementedError`, empty stub, or equivalent). | **PENDING** | _Pending_ |

### Phase 0 Verdict

**`PENDING`.** The five mandatory pre-flight conditions have not yet been evaluated. This verdict is resolved to `APPROVED` (all conditions satisfied → proceed to Phase 1) or `BLOCKED` (one or more conditions failed → return to code generation) when the review pass executes.

---

## Phase 1 — Infrastructure / DevOps

**Phase status: `PENDING`**
**Owning Expert Agent:** Infrastructure / DevOps Expert
**Date:** —

### Scope

| File                           | Change Kind                                                                                         | AAP Reference        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------- |
| `package.json`                 | ADD `angular-gridster2@21.0.1` to the `dependencies` block (no other version changes)               | § 0.3.1, § 0.3.2     |
| `package-lock.json`            | Auto-regenerated by `npm install` (no manual edits)                                                 | § 0.3.2              |
| `apps/client/ngsw-config.json` | (Conditional) adjust route/asset caching for the single-route SPA if required by the service worker | § 0.4.1.1, § 0.6.1.5 |

This phase is **explicitly NOT** responsible for editing `Dockerfile`, `docker-compose*.yml`, `.github/workflows/*.yml`, `nx.json`, or `tsconfig*.json` — none of those is in AAP scope.

### Review Checklist

- [ ] `package.json` `dependencies` includes exactly `"angular-gridster2": "21.0.1"` (exact pin per AAP § 0.3.1).
- [ ] No transitive dependency churn: the existing dependency block is preserved verbatim aside from the single new entry (`git diff package.json` shows one addition, no removals, no version bumps).
- [ ] `package-lock.json` is regenerated via `npm install` and committed; the lockfile is reproducible (`npm ci` succeeds clean).
- [ ] `@prisma/client` is regenerated (not version-bumped) via the existing `postinstall` / `database:generate-typings` `prisma generate` invocation, exposing the new `userDashboardLayout` delegate on `PrismaService`.
- [ ] `apps/client/ngsw-config.json` changes (if any) are minimal and correct for the single-route SPA; the service worker continues to cache the app shell and assets.
- [ ] **Build Integrity Gate:** `npx nx build api` and `npx nx build client` both complete with zero errors after all changes.
- [ ] **Dependency Gate:** the grid engine's Angular peer requirements are satisfied by the installed `@angular/core` 21.2.7, `@angular/common`, and `@angular/cdk` 21.2.5.
- [ ] No CI/CD workflow file is modified; `nx.json`, `tsconfig*.json`, and the ESLint config are unchanged.
- [ ] No real credential or secret value is committed in any file.

### Status & Sign-Off

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | `PENDING`                                                                |
| Reviewer      | Infrastructure / DevOps Expert                                           |
| Decision date | —                                                                        |
| Findings      | _Pending — completed when this phase is reviewed after code generation._ |

### Handoff Notes for Phase 2 (Security)

When Phase 1 marks `APPROVED`, document the following for Phase 2:

1. **Confirmed dependency surface.** Phase 2 performs a security audit of the freshly installed transitive dependency tree (`npm audit --production`).
2. **Confirmed lockfile integrity.** Phase 2 confirms the lockfile is reproducible and introduces no known-vulnerable transitive packages.
3. **No secrets committed.** Phase 2 runs a secret-scanning sweep to confirm no credentials slipped into the diff.

---

## Phase 2 — Security

**Phase status: `PENDING`**
**Owning Expert Agent:** Security Expert
**Date:** —

### Scope (Rule 8 from AAP § 0.8.1)

| File                                                             | Scope of Verification                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/api/src/app/user/user-dashboard-layout.controller.ts`      | `AuthGuard('jwt')` + `HasPermissionGuard` wiring; `@HasPermission(...)`; `userId` from `request.user.id` |
| `apps/api/src/app/user/user-dashboard-layout.service.ts`         | Cross-user isolation — every Prisma operation scoped to the JWT-derived `userId`                         |
| `apps/api/src/app/user/dtos/update-user-dashboard-layout.dto.ts` | `class-validator` size caps for DoS defense (`@ArrayMaxSize`, `@MaxLength`, `@IsInt`/`@Min`)             |
| `libs/common/src/lib/permissions.ts`                             | New `readUserDashboardLayout` / `updateUserDashboardLayout` constants and their role grants              |

### Review Checklist

#### Endpoint authentication & authorization

- [ ] `GET /api/v1/user/layout` returns HTTP 401 without a valid JWT.
- [ ] `PATCH /api/v1/user/layout` returns HTTP 401 without a valid JWT.
- [ ] Both methods use the canonical `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` pattern plus `@HasPermission(...)` decorators, matching the `user-financial-profile` precedent.
- [ ] Insufficient-permission requests (valid JWT, missing permission) return HTTP 403.

#### Cross-user authorization (layout isolation)

- [ ] Every `prisma.userDashboardLayout.*` call in `user-dashboard-layout.service.ts` is scoped by `userId`.
- [ ] The `userId` value used in every Prisma call is derived from the JWT payload (`request.user.id`) — never from request body, query string, or URL parameter.
- [ ] The controller reads `request.user.id` and passes it to the service as the first positional argument; the service signature requires `userId` (not optional).
- [ ] **Negative test:** a user with id `A` cannot read or modify the `UserDashboardLayout` row of user `B`.

#### DTO validation (DoS defense)

- [ ] `update-user-dashboard-layout.dto.ts` validates `layoutData` nested item geometry with `@IsInt`/`@Min`.
- [ ] `moduleKey` is validated with `@IsString` + `@MaxLength`.
- [ ] An `@ArrayMaxSize` cap bounds the number of modules in `layoutData`.
- [ ] Oversize / malformed payloads are rejected with HTTP 400 (not persisted, not 500).

#### Permissions & secrets

- [ ] `libs/common/src/lib/permissions.ts` adds `readUserDashboardLayout` and `updateUserDashboardLayout` and grants them in the appropriate role sets.
- [ ] No real credential or secret value appears in any new or modified file.

### Status & Sign-Off

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | `PENDING`                                                                |
| Reviewer      | Security Expert                                                          |
| Decision date | —                                                                        |
| Findings      | _Pending — completed when this phase is reviewed after code generation._ |

### Handoff Notes for Phase 3 (Backend Architecture)

When Phase 2 marks `APPROVED`, document the following for Phase 3:

1. **JWT-derived `userId` is authoritative.** Phase 3 verifies the controller/service signatures respect this pattern.
2. **Credential and permission surface confirmed clean.** Phase 3 may focus purely on architectural shape (controller thinness, DI wiring, Prisma upsert logic).
3. **DTO contract is enforced.** Phase 3 verifies the service consumes the validated DTO shape proven in Phase 2.

---

## Phase 3 — Backend Architecture

**Phase status: `PENDING`**
**Owning Expert Agent:** Backend Architecture Expert
**Date:** —

### Scope (Rule 9 from AAP § 0.8.1)

| Concern                       | Files                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Layout controller (thinness)  | `apps/api/src/app/user/user-dashboard-layout.controller.ts`                                                   |
| Layout service (Prisma logic) | `apps/api/src/app/user/user-dashboard-layout.service.ts` (read / upsert + correlation-ID logging)             |
| Module wiring                 | `apps/api/src/app/user/user.module.ts` (register controller + service in `controllers`/`providers`/`exports`) |
| Observability (additive)      | `apps/api/src/app/metrics/*` (additive layout metrics)                                                        |
| Prisma schema                 | `prisma/schema.prisma` (`UserDashboardLayout` model + `User` back-relation)                                   |
| Migration                     | `prisma/migrations/<timestamp>_add_user_dashboard_layout/migration.sql` (additive `CREATE TABLE`)             |

### Review Checklist

#### Rule 9 — Schema Precondition

- [ ] `schema.prisma` was read before the migration was written; the `UserDashboardLayout` model does not conflict with the existing `User` and `FinancialProfile` models.
- [ ] The `UserDashboardLayout` model is keyed by `userId` (`@id`), with `layoutData Json`, `createdAt @default(now())`, `updatedAt @updatedAt`, and a cascade-delete relation to `User`.
- [ ] The `User` model declares the matching `dashboardLayout UserDashboardLayout?` back-relation (required by Prisma 7.x for both sides of a 1:1 association).
- [ ] The generated migration is additive (`CREATE TABLE`) and runs without conflicts.

#### Controller thinness

- [ ] No layout-controller method body exceeds the thinness convention (counted from `{` to `}`, exclusive of decorators and signature).
- [ ] No `prisma.*` or `this.prisma...` reference appears in the layout controller.
- [ ] Controller methods only: extract `request.user.id`, validate the DTO, set the `X-Correlation-ID` response header, delegate to the service, and return the result.
- [ ] `GET` returns the layout (200) or throws `NotFoundException` (404 when no record exists); `PATCH` is annotated `@HttpCode(HttpStatus.OK)`.

#### Service architecture & observability

- [ ] `user-dashboard-layout.service.ts` injects `PrismaService`; `findByUserId(userId, correlationId?)` returns `null` when absent; `upsertForUser(userId, dto, correlationId?)` performs a Prisma `upsert`.
- [ ] Every service method accepts an optional `correlationId` propagated to a `@nestjs/common` `Logger` with a `[<correlationId>]` prefix; Prisma calls are wrapped in `try/catch` with `Logger.error`.
- [ ] Additive layout metrics are registered through the existing `MetricsModule`; no existing metric is removed or renamed.

#### Module wiring

- [ ] `user.module.ts` registers `UserDashboardLayoutController` in `controllers` and `UserDashboardLayoutService` in `providers` (and `exports` if consumed elsewhere); `UserModule` already imports `PrismaModule`.
- [ ] The controller's `@Controller('user/layout')` resolves to `/api/v1/user/layout` via the global prefix and URI versioning in `apps/api/src/main.ts`.
- [ ] The application bootstraps without DI errors; every declared provider is injected by ≥1 controller or service (no dead providers).

### Status & Sign-Off

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | `PENDING`                                                                |
| Reviewer      | Backend Architecture Expert                                              |
| Decision date | —                                                                        |
| Findings      | _Pending — completed when this phase is reviewed after code generation._ |

### Handoff Notes for Phase 4 (QA / Test Integrity)

When Phase 3 marks `APPROVED`, document the following for Phase 4:

1. **Architecture is sound.** Phase 4 may focus on test coverage and behavioral correctness, not architectural shape.
2. **Service surface is well-defined.** Phase 4 verifies that mocks in the new `*.spec.ts` files mirror the public service surface (`findByUserId`, `upsertForUser`) accurately.
3. **Endpoint contracts are documented.** Phase 4 verifies integration tests for `GET` (200 / 404) and `PATCH` (200) plus 401 on unauthenticated access.

---

## Phase 4 — QA / Test Integrity

**Phase status: `PENDING`**
**Owning Expert Agent:** QA / Test Integrity Expert
**Date:** —

### Scope

All new `*.spec.ts` files following the existing co-located convention:

| Path                                                             | Coverage                                            |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| `apps/client/src/app/dashboard/module-registry.service.spec.ts`  | Module registry service                             |
| `apps/client/src/app/dashboard/dashboard-layout.service.spec.ts` | Client layout service (404→`null`, 500 ms debounce) |
| `apps/client/src/app/dashboard/dashboard-canvas/*.spec.ts`       | Grid canvas component                               |
| `apps/client/src/app/dashboard/module-catalog/*.spec.ts`         | Searchable catalog component                        |
| `apps/api/src/app/user/user-dashboard-layout.controller.spec.ts` | Layout controller                                   |
| `apps/api/src/app/user/user-dashboard-layout.service.spec.ts`    | Layout service                                      |

### Review Checklist

#### Pre-existing test suite integrity

- [ ] `nx test client` passes (pre-existing baseline preserved; new dashboard specs pass).
- [ ] `nx test api` passes (pre-existing baseline preserved; new layout specs pass).
- [ ] `nx test common` passes (pre-existing baseline preserved; new interface barrel addition does not break common).

#### Coverage Gate (AAP § 0.8.3)

- [ ] **Coverage Gate:** ≥80% line coverage for `ModuleRegistryService`, `DashboardLayoutService`, and `DashboardCanvasComponent`.

#### Per-rule and scenario test coverage

- [ ] **Registry (Rule 3):** unit tests verify `register`/`get`/`getAll`/`has` and that all feature modules are registered at construction.
- [ ] **Layout persistence (Rule 4):** `dashboard-layout.service.spec.ts` asserts `get()` translates HTTP 404 → `null`, and that `queueSave(...)` issues a `PATCH` only after the ~500 ms debounce.
- [ ] **Canvas initialization (Rule 2):** the canvas hydrates from a saved layout, and a `null` layout opens the catalog (first-visit behavior).
- [ ] **Endpoint contracts:** integration tests for `GET` (200 / 404) and `PATCH` (200); 401 on unauthenticated access.
- [ ] **Scenario — new user:** blank canvas + catalog auto-open when no saved layout exists.
- [ ] **Scenario — returning user:** saved layout loaded on app init.
- [ ] **Scenario — save on drag/resize/add/remove:** persistence fires within the debounce window.
- [ ] **Scenario — below-minimum resize:** rejected by the grid engine (cross-reference Phase 7).

#### Test hygiene

- [ ] No `*.spec.ts` file is committed with `xit`, `xdescribe`, or `.skip(...)` beyond any pre-existing baseline.
- [ ] No `blitzy_adhoc_test_*` or other temporary test artifacts are committed.
- [ ] No real credentials appear in any fixture or mock; all test inputs use synthetic placeholders.

### Status & Sign-Off

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | `PENDING`                                                                |
| Reviewer      | QA / Test Integrity Expert                                               |
| Decision date | —                                                                        |
| Findings      | _Pending — completed when this phase is reviewed after code generation._ |

### Handoff Notes for Phase 5 (Business / Domain)

When Phase 4 marks `APPROVED`, document the following for Phase 5:

1. **Tests demonstrate behavioral conformance.** Phase 5 may rely on the spec assertions to validate domain alignment.
2. **Scenario fixtures are identified.** Phase 5 uses the new-user and returning-user scenario fixtures for the onboarding walk-through.

---

## Phase 5 — Business / Domain

**Phase status: `PENDING`**
**Owning Expert Agent:** Business / Domain Expert
**Date:** —

### Scope (Rules 1 & 10 from AAP § 0.8.1)

| Domain Concern                                                      | Source of Truth        |
| ------------------------------------------------------------------- | ---------------------- |
| Catalog completeness — every feature is a selectable module         | AAP § 0.2.1.1, § 0.8.3 |
| AI chat panel extracted to a first-class "AI Chat" grid module      | AAP § 0.1.2.2          |
| Onboarding — blank canvas + catalog auto-open on first visit        | AAP § 0.1.1, § 0.8.1   |
| Module isolation — data flows exclusively through existing services | AAP § 0.8.1            |
| Existing feature components preserved (referenced, not modified)    | AAP § 0.7.2            |

### Review Checklist

#### Catalog completeness

- [ ] All existing feature components appear as selectable modules in the catalog (portfolio overview, holdings, summary, markets, watchlist, portfolio summary, transactions/activities, allocations, analysis, FIRE, X-ray).
- [ ] The AI chat panel appears as a first-class, selectable "AI Chat" grid module.
- [ ] The inline `<app-chat-panel></app-chat-panel>` embed is removed from the portfolio page and re-hosted as a module (documented intentional deviation, AAP § 0.1.2.2).

#### Onboarding behavior (Rule 10)

- [ ] A new user is presented with a blank canvas.
- [ ] The module catalog auto-opens on first visit when no saved layout exists for the authenticated user.
- [ ] A returning user's saved layout is loaded on app init.

#### Module isolation (Rule 1)

- [ ] Module wrapper components do not import or reference the grid canvas layer.
- [ ] Data flows exclusively through the existing data-fetching services (e.g., `PortfolioService`, `SymbolService`) and each module's own existing feature service; none of these data services is modified.
- [ ] Existing feature components are referenced via `NgComponentOutlet`, not modified.

#### Scope boundaries (AAP § 0.7.2)

- [ ] No mobile/responsive grid layout support added (explicitly out of scope).
- [ ] No shared layouts, admin-defined default layouts, or multi-user collaboration (explicitly out of scope).
- [ ] Business logic and Ghostfolio API integrations remain unchanged.

### Status & Sign-Off

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | `PENDING`                                                                |
| Reviewer      | Business / Domain Expert                                                 |
| Decision date | —                                                                        |
| Findings      | _Pending — completed when this phase is reviewed after code generation._ |

### Handoff Notes for Phase 6 (Frontend)

When Phase 5 marks `APPROVED`, document the following for Phase 6:

1. **Domain semantics confirmed.** Phase 6 may proceed knowing the catalog inventory and onboarding behavior are correct.
2. **Module-isolation boundary confirmed.** Phase 6 verifies the wrapper/registry implementation respects the isolation rule in code.

---

## Phase 6 — Frontend

**Phase status: `PENDING`**
**Owning Expert Agent:** Frontend Expert
**Date:** —

### Scope (Rules 1, 2, 3, 4, 5, 7, 10 from AAP § 0.8.1)

| File                                                                                       | Type        | Phase 6 Verification                                        |
| ------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------- |
| `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.{ts,html,scss}` | New         | Grid rendering via `NgComponentOutlet`; grid state as SSOT  |
| `apps/client/src/app/dashboard/module-registry.service.ts`                                 | New service | `Map<string, ModuleDefinition>`; registry-only introduction |
| `apps/client/src/app/dashboard/module-catalog/module-catalog.component.{ts,html,scss}`     | New         | Searchable list; add/remove; auto-open                      |
| `apps/client/src/app/dashboard/dashboard-layout.service.ts`                                | New service | 404→`null`; ~500 ms debounce; grid-event-driven only        |
| `apps/client/src/app/dashboard/modules/**/*.component.ts`                                  | New (×N)    | Isolation wrappers; no canvas import; no layout state       |
| `apps/client/src/app/dashboard/dashboard.types.ts`                                         | New         | `ModuleDefinition`, `DashboardItem`, `LayoutData` types     |
| `apps/client/src/app/app.routes.ts`                                                        | Modify      | Single `path: ''` route → canvas; router preserved          |
| `apps/client/src/app/app.component.{ts,html,scss}`                                         | Modify      | Render canvas; neutralize tab-nav inputs                    |
| `apps/client/src/app/components/header/header.component.{ts,html,scss}`                    | Modify      | Simplify topnav; retain user/date-range/filter controls     |
| `apps/client/src/app/pages/portfolio/portfolio-page.html`                                  | Modify      | Remove `<app-chat-panel>` embed                             |
| `apps/client/src/app/pages/portfolio/portfolio-page.component.ts`                          | Modify      | Remove `ChatPanelComponent` import + `imports` entry        |
| `libs/common/src/lib/interfaces/user-dashboard-layout.interface.ts`                        | New shared  | `UserDashboardLayout` + patch-payload types                 |
| `libs/common/src/lib/interfaces/index.ts`                                                  | Modify      | Barrel re-export of the new interface                       |

### Review Checklist

#### Rule 1 — Module Isolation

- [ ] No wrapper or module component imports or references the grid canvas layer.
- [ ] Each wrapper hosts its existing feature component via `NgComponentOutlet` and adds only grid chrome (header + remove action).

#### Rule 2 — Grid State as Single Source of Truth

- [ ] The `GridsterItem[]` / `DashboardItem[]` array on the canvas is the authoritative store of module positions and sizes.
- [ ] Module components hold no layout state.

#### Rule 3 — Registry-Only Introduction

- [ ] `ModuleRegistryService` is `providedIn: 'root'` and registers all feature modules at construction.
- [ ] New module types are introduced only through the registry; no ad-hoc component insertion exists in the canvas or catalog.

#### Rule 4 — Grid-Event-Driven Persistence

- [ ] `DashboardLayoutService` exposes a single public save entrypoint (`queueSave(...)`) backed by an RxJS `Subject` + `debounceTime(500)` + `switchMap` issuing the `PATCH`.
- [ ] Only the canvas's grid-event handlers (drag, resize, add, remove) call `queueSave(...)`; module components never call it.
- [ ] `get()` translates HTTP 404 → `null` via `catchError`.

#### Rule 5 — Router Preservation

- [ ] `app.routes.ts` collapses to a single `path: ''` route rendering the canvas; the wildcard and authentication/bootstrap routes are retained.
- [ ] `RouterModule.forRoot`, `ServiceWorkerModule` navigation handling, `PageTitleStrategy`, and `ModulePreloadService` are preserved (not removed or degraded).
- [ ] **Router Integrity Gate:** router infrastructure remains functional after the collapse.

#### Rule 7 — MD3 Token Discipline (Decision D-020)

- [ ] All grid-chrome CSS property values resolve to MD3 system tokens via `var(--mat-sys-<token>, <hardcoded-fallback>)`.
- [ ] No bare `--mat-sys-*` reference without a fallback exists; no hardcoded raw value outside a token+fallback wrapper (excepting `0`, `none`, `auto`, `inherit`, `currentColor`, `transparent`).
- [ ] The drop-zone / active highlight uses `--mat-sys-primary-container` with a fallback.

#### Rule 10 — First-Visit Catalog Auto-Open

- [ ] On init the canvas calls `dashboardLayoutService.get()`; a `null` result opens the catalog, otherwise it hydrates the grid.
- [ ] The catalog is reachable thereafter via an "Add module" toolbar control.

#### i18n, Material, and wiring correctness

- [ ] All new UI strings carry `i18n` attributes (the client builds with `localize: true`).
- [ ] Grid chrome uses Angular Material 21.2.5 primitives (`MatCard`, `MatIconButton`/`MatIcon`, `MatSidenav`, `MatFormField`/`MatInput`, `MatList`, `MatButton`, `MatTooltip`, `MatSnackBar`, `MatProgressBar`).
- [ ] `portfolio-page.html` removes exactly the inline `<app-chat-panel>` embed; `portfolio-page.component.ts` removes the `ChatPanelComponent` import and its `imports` entry; no other markup is altered.
- [ ] Client layout calls flow through the existing `AuthInterceptor` (JWT bearer attached automatically); the service imports its typed contract from `@ghostfolio/common/interfaces`.

#### Build & lint

- [ ] `npx nx build client` completes with no new TypeScript errors.
- [ ] `npx nx lint client` passes (no new ESLint violations).

### Status & Sign-Off

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | `PENDING`                                                                |
| Reviewer      | Frontend Expert                                                          |
| Decision date | —                                                                        |
| Findings      | _Pending — completed when this phase is reviewed after code generation._ |

### Handoff Notes for Phase 7 (Other SME — Grid Engine)

When Phase 6 marks `APPROVED`, document the following for Phase 7:

1. **Component shape is verified.** Phase 7 may focus solely on the `angular-gridster2` grid-engine integration specifics.
2. **Persistence contract is verified.** Phase 7 confirms that `itemChangeCallback`/`itemResizeCallback` correctly drive the debounced save proven in Phase 6.

---

## Phase 7 — Other SME (Grid Engine / angular-gridster2)

**Phase status: `PENDING`**
**Owning Expert Agent:** Grid Engine SME (`angular-gridster2` specialist)
**Date:** —

### Scope (Rules 2, 4, 6 from AAP § 0.8.1)

| File / Concern                                     | Verification                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `dashboard-canvas.component.ts` — `GridsterConfig` | 12 columns (`minCols`/`maxCols` = 12), constant fixed row height, `minItemCols`/`minItemRows` = 2, drag/resize on |
| `angular-gridster2` v21 API usage                  | Grid API obtained via `viewChild(Gridster).api` / `initCallback`; `optionsChanged()` removed (new options object) |
| `zone.js` compatibility                            | v21 retains `NgZone.run`/`NgZone.runOutsideAngular`; compatible with `provideZoneChangeDetection()`               |
| Next-available-position placement                  | First-fit placement using the v21 grid position helpers                                                           |
| Minimum-dimension enforcement                      | Global and per-item `minItemCols`/`minItemRows` reject below-minimum resizes                                      |

### Review Checklist

#### GridsterConfig correctness

- [ ] `minCols`/`maxCols` are fixed at 12; the grid uses a constant fixed row height (pixel value).
- [ ] `minItemCols`/`minItemRows` = 2 are set globally; each module's registered minimum cell dimensions are honored per-item.
- [ ] Dragging and resizing are enabled; dragging is initiated from the module header/handle.

#### v21 API usage

- [ ] The grid API is obtained via `viewChild(Gridster).api` / `initCallback` — not the removed `optionsChanged()`.
- [ ] Applying an options change assigns a new options-object reference (the v21 requirement), not an in-place mutation.
- [ ] `itemChangeCallback` / `itemResizeCallback` are wired to the layout service's debounced save (drag/resize-end events).

#### zone.js & interaction performance

- [ ] The integration relies on v21's retained `NgZone` behavior for zone-based apps; no zoneless assumption is introduced.
- [ ] **Interaction Performance Gate:** grid drag/resize completes its visual update within ~100 ms on the zone-based setup.

#### Placement & minimum-dimension enforcement

- [ ] **Placement Gate:** adding a module from the catalog places it at the next available grid position (first-fit).
- [ ] **Minimum Dimension Gate:** below-minimum (2×2) resize attempts are rejected by the grid engine.

### Status & Sign-Off

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | `PENDING`                                                                |
| Reviewer      | Grid Engine SME                                                          |
| Decision date | —                                                                        |
| Findings      | _Pending — completed when this phase is reviewed after code generation._ |

### Handoff Notes for Phase 8 (Principal Reviewer)

When Phase 7 marks `APPROVED`, document the following for Phase 8:

1. **All seven domain phases complete.** Phase 8 may begin holistic consolidation.
2. **All ten feature rules from AAP § 0.8.1 have at least one phase claiming verification responsibility.** Phase 8 confirms the cross-phase coverage matrix is complete.
3. **All acceptance gates from AAP § 0.8.3 have a designated owning phase.**

---

## Phase 8 — Principal Reviewer (Final Sign-Off)

**Phase status: `PENDING`**
**Owning Reviewer:** Principal Engineer
**Date:** —

### Scope

Holistic review across all seven prior phases. The Principal Reviewer:

1. Confirms each prior phase is `APPROVED`.
2. Verifies alignment with the Agent Action Plan (every section of AAP § 0.1 through § 0.8).
3. Confirms all ten feature rules in AAP § 0.8.1 are satisfied across the codebase.
4. Confirms all acceptance gates in AAP § 0.8.3 pass.
5. Confirms scope boundaries (AAP § 0.7) are respected.
6. Authorizes PR creation.

### Final Review Checklist

#### Phase consolidation

- [ ] Phase 1 (Infrastructure / DevOps) status is `APPROVED`.
- [ ] Phase 2 (Security) status is `APPROVED`.
- [ ] Phase 3 (Backend Architecture) status is `APPROVED`.
- [ ] Phase 4 (QA / Test Integrity) status is `APPROVED`.
- [ ] Phase 5 (Business / Domain) status is `APPROVED`.
- [ ] Phase 6 (Frontend) status is `APPROVED`.
- [ ] Phase 7 (Other SME — Grid Engine) status is `APPROVED`.

#### Feature rules from AAP § 0.8.1

- [ ] Rule 1 — Module Isolation — verified by Phase 5 + Phase 6.
- [ ] Rule 2 — Grid State as Single Source of Truth — verified by Phase 6 + Phase 7.
- [ ] Rule 3 — Registry-Only Introduction — verified by Phase 6.
- [ ] Rule 4 — Grid-Event-Driven Persistence — verified by Phase 6 + Phase 7.
- [ ] Rule 5 — Router Preservation — verified by Phase 6.
- [ ] Rule 6 — Minimum Cell Dimensions — verified by Phase 7.
- [ ] Rule 7 — MD3 Token Discipline (D-020) — verified by Phase 6.
- [ ] Rule 8 — Auth-Guarded Endpoints — verified by Phase 2.
- [ ] Rule 9 — Schema Precondition — verified by Phase 3.
- [ ] Rule 10 — First-Visit Catalog Auto-Open — verified by Phase 5 + Phase 6.

#### Project governance rules from AAP § 0.8.2

- [ ] **Observability:** structured logging with correlation IDs, the `apps/api/src/app/health/` and `apps/api/src/app/metrics/` modules reused, layout-specific metrics added, and a dashboard template/runbook delivered and verified locally.
- [ ] **Explainability:** a Markdown decision-log table documents every non-trivial decision (decision, alternatives, why, risks); a bidirectional traceability matrix maps source navigation constructs to target module/grid implementations at 100% coverage; the ChatPanel extraction and route-collapse resolution each have an explicit decision-log entry.
- [ ] **Executive Presentation:** a self-contained reveal.js HTML executive summary (12–18 slides, target 16) is delivered with the Blitzy brand theme inline, Mermaid + Lucide visuals, and CDN versions pinned to reveal.js 5.1.0 / Mermaid 11.4.0 / Lucide 0.460.0.
- [ ] **Segmented PR Review:** this `CODE_REVIEW.md` partitions every changed file into the sequential domain phases, and each phase plus the final verdict resolves to exactly `APPROVED` or `BLOCKED`.

#### Acceptance gates from AAP § 0.8.3

- [ ] **Build Integrity Gate** — `npx nx build client` and `npx nx build api` complete without errors.
- [ ] **Dependency Gate** — `angular-gridster2@21.0.1` pinned; lockfile reproducible.
- [ ] **Migration Gate** — Prisma migration runs without conflicts.
- [ ] **Auth Gate** — `GET`/`PATCH /api/v1/user/layout` return 401 when unauthenticated.
- [ ] **DTO Validation Gate** — oversize `layoutData` payloads rejected with 400.
- [ ] **Layout Endpoint Gate** — `GET` returns the saved layout (≤300 ms p95) / 404 when absent; `PATCH` persists and returns 200.
- [ ] **Schema Precondition Gate** — new model non-conflicting with `User`/`FinancialProfile`.
- [ ] **Controller Thinness Gate** — layout controller methods thin, no Prisma calls.
- [ ] **Coverage Gate** — ≥80% line coverage for registry service, layout service, and canvas.
- [ ] **Catalog Completeness Gate** — all feature components selectable, including AI chat.
- [ ] **Onboarding Gate** — new user blank canvas + catalog auto-open; returning user saved layout.
- [ ] **Persistence Debounce Gate** — layout saves within ~500 ms debounce.
- [ ] **Router Integrity Gate** — router infrastructure remains functional.
- [ ] **MD3 Token Gate** — all chrome uses `var(--mat-sys-<token>, <fallback>)`.
- [ ] **Placement Gate** — added module placed at the next available position.
- [ ] **Interaction Performance Gate** — drag/resize visual update ≤100 ms.
- [ ] **Minimum Dimension Gate** — below-minimum resize rejected.

#### Scope boundaries

- [ ] Only the documented in-scope files (AAP § 0.7.1) are modified; out-of-scope files (AAP § 0.7.2) are untouched.
- [ ] No mobile/responsive support, shared layouts, admin defaults, or multi-user collaboration introduced.
- [ ] Existing data services, business logic, and Ghostfolio API integrations preserved unchanged.
- [ ] No Material Design 3 theme/token redefinition; the existing `theme.scss` is reused.

#### Final integration smoke

- [ ] `git diff <base> --name-only` shows exactly the in-scope files (no surprises).
- [ ] `npx nx format:check` passes.
- [ ] `npx nx lint api && npx nx lint client && npx nx lint common` all pass.

### Status

| Field    | Value              |
| -------- | ------------------ |
| Status   | `PENDING`          |
| Reviewer | Principal Engineer |

### Final Sign-Off

To be completed once all checklist items above are confirmed:

- **Reviewer Name:** Principal Engineer
- **Date:** —
- **Decision:** **PENDING** (resolves to `APPROVED` or `BLOCKED` — no qualifiers permitted)
- **Authorization to open PR:** **PENDING**

---

## Traceability Matrix

The following bidirectional matrix maps each review phase to the files in scope, the feature rules verified, and the acceptance gates verified. It satisfies the "bidirectional traceability matrix" requirement of the Explainability rule (AAP § 0.8.2). Entries are scaffolded from the known in-scope inventory and are confirmed during the review pass.

### Phase → Files / Rules / Gates

| Phase | Domain                  | Files in Scope                                                                                                                                                                  | Rule(s) Verified           | Gate(s) Verified                                                         |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| 1     | Infrastructure / DevOps | `package.json`, `package-lock.json`, `apps/client/ngsw-config.json`                                                                                                             | —                          | Build Integrity, Dependency, Migration (build)                           |
| 2     | Security                | `user-dashboard-layout.controller.ts`, `user-dashboard-layout.service.ts`, `dtos/update-user-dashboard-layout.dto.ts`, `libs/common/src/lib/permissions.ts`                     | Rule 8                     | Auth, DTO Validation, Layout Endpoint (auth)                             |
| 3     | Backend Architecture    | `user-dashboard-layout.controller.ts`, `user-dashboard-layout.service.ts`, `user.module.ts`, `apps/api/src/app/metrics/*`, `prisma/schema.prisma`, migration SQL                | Rule 9                     | Schema Precondition, Controller Thinness, Migration, Layout Endpoint     |
| 4     | QA / Test Integrity     | All new `*.spec.ts` (`apps/client/src/app/dashboard/**`, `apps/api/src/app/user/*dashboard-layout*`)                                                                            | Rules 1–10 (test coverage) | Coverage                                                                 |
| 5     | Business / Domain       | Catalog completeness, onboarding, module isolation, ChatPanel extraction (behavioral)                                                                                           | Rule 1, Rule 10            | Catalog Completeness, Onboarding                                         |
| 6     | Frontend                | `dashboard/**` components + services + types, `app.routes.ts`, `app.component.*`, `header.component.*`, `portfolio-page.html`/`.ts`, `interfaces/{index,user-dashboard-layout}` | Rules 1, 2, 3, 4, 5, 7, 10 | Persistence Debounce, Router Integrity, MD3 Token, Placement, Onboarding |
| 7     | Other SME (Grid Engine) | `dashboard-canvas.component.ts` `GridsterConfig`, `angular-gridster2` v21 API, placement, min-dimension enforcement                                                             | Rule 2, Rule 4, Rule 6     | Interaction Performance, Minimum Dimension, Placement                    |
| 8     | Principal Reviewer      | Holistic — all in-scope files                                                                                                                                                   | All Rules 1–10             | All gates                                                                |

### Rule → Verifying Phase(s)

| Rule                                          | Verifying Phase(s) |
| --------------------------------------------- | ------------------ |
| Rule 1 — Module Isolation                     | Phase 5, Phase 6   |
| Rule 2 — Grid State as Single Source of Truth | Phase 6, Phase 7   |
| Rule 3 — Registry-Only Introduction           | Phase 6            |
| Rule 4 — Grid-Event-Driven Persistence        | Phase 6, Phase 7   |
| Rule 5 — Router Preservation                  | Phase 6            |
| Rule 6 — Minimum Cell Dimensions              | Phase 7            |
| Rule 7 — MD3 Token Discipline (D-020)         | Phase 6            |
| Rule 8 — Auth-Guarded Endpoints               | Phase 2            |
| Rule 9 — Schema Precondition                  | Phase 3            |
| Rule 10 — First-Visit Catalog Auto-Open       | Phase 5, Phase 6   |

### Gate → Verifying Phase(s)

| Gate                         | Verifying Phase(s) |
| ---------------------------- | ------------------ |
| Build Integrity Gate         | Phase 1            |
| Dependency Gate              | Phase 1            |
| Migration Gate               | Phase 1, Phase 3   |
| Auth Gate                    | Phase 2            |
| DTO Validation Gate          | Phase 2            |
| Layout Endpoint Gate         | Phase 2, Phase 3   |
| Schema Precondition Gate     | Phase 3            |
| Controller Thinness Gate     | Phase 3            |
| Coverage Gate                | Phase 4            |
| Catalog Completeness Gate    | Phase 5            |
| Onboarding Gate              | Phase 5, Phase 6   |
| Persistence Debounce Gate    | Phase 6            |
| Router Integrity Gate        | Phase 6            |
| MD3 Token Gate               | Phase 6            |
| Placement Gate               | Phase 6, Phase 7   |
| Interaction Performance Gate | Phase 7            |
| Minimum Dimension Gate       | Phase 7            |

### Feature → Implementation Files

| Feature                       | Client                                                                                                                                      | API / Shared / DB                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Grid canvas**               | `apps/client/src/app/dashboard/dashboard-canvas/**`, `apps/client/src/app/dashboard/dashboard.types.ts`                                     | —                                                                                                                                                        |
| **Module registry & catalog** | `apps/client/src/app/dashboard/module-registry.service.ts`, `apps/client/src/app/dashboard/module-catalog/**`, `dashboard/modules/**`       | —                                                                                                                                                        |
| **Layout persistence**        | `apps/client/src/app/dashboard/dashboard-layout.service.ts`                                                                                 | `apps/api/src/app/user/user-dashboard-layout.{controller,service}.ts`, `dtos/update-user-dashboard-layout.dto.ts`, `prisma/schema.prisma`, migration SQL |
| **Navigation-shell refactor** | `apps/client/src/app/app.routes.ts`, `app.component.*`, `components/header/header.component.*`, `pages/portfolio/portfolio-page.html`/`.ts` | `apps/client/ngsw-config.json` (conditional)                                                                                                             |
| **Shared contract & perms**   | —                                                                                                                                           | `libs/common/src/lib/interfaces/user-dashboard-layout.interface.ts`, `libs/common/src/lib/interfaces/index.ts`, `libs/common/src/lib/permissions.ts`     |
| **Dependency**                | —                                                                                                                                           | `package.json`, `package-lock.json` (`angular-gridster2@21.0.1`)                                                                                         |

---

## Status Legend

| Status     | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `PENDING`  | The phase (or final verdict) has not yet been reviewed. Initial state for every phase in this blank scaffold. |
| `APPROVED` | The phase is fully reviewed and signed off with zero blocking concerns; the next phase may begin.             |
| `BLOCKED`  | The review uncovered a blocking concern; the phase cannot advance until the concern is resolved in code.      |

The final Phase 8 verdict is **binary** — exactly `APPROVED` or `BLOCKED`, with no qualifiers permitted.

---

## Document History

| Version | Date       | Author                       | Change                                                                                                                                                           |
| ------- | ---------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0.0   | 2026-06-20 | Blitzy Code Generation Agent | Initial creation (blank scaffold) per AAP § 0.6.1.6 and § 0.8.2 (Segmented PR Review rule). All phases initialized with `status: PENDING`; no findings recorded. |
