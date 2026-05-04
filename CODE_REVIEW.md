---
title: 'Code Review — Modular Dashboard Refactor'
review_id: AAP-MODULAR-DASHBOARD-2026
created_at: 2026-05-02
review_completed_at: PENDING
target_branch: blitzy-4678eab3-b225-4bfc-9190-5c0f3e229271
base_branch: main
aap_reference: '§ 0.8.2.4 Segmented PR Review (AAP for Modular Dashboard Refactor)'
review_pass: 1
phase_zero:
  name: Pre-flight (Segmented PR Review)
  phase: 0
  status: PENDING
  file_count: 0
phases:
  - name: Infrastructure / DevOps
    phase: 1
    status: PENDING
    file_count: 5
  - name: Security
    phase: 2
    status: PENDING
    file_count: 4
  - name: Backend Architecture
    phase: 3
    status: PENDING
    file_count: 3
  - name: QA / Test Integrity
    phase: 4
    status: PENDING
    file_count: 13
  - name: Business / Domain
    phase: 5
    status: PENDING
    file_count: 5
  - name: Frontend
    phase: 6
    status: PENDING
    file_count: 19
  - name: Other SME
    phase: 7
    status: PENDING
    file_count: 5
  - name: Principal Reviewer
    phase: 8
    status: PENDING
    file_count: 61
---

# Code Review — Modular Dashboard Refactor

> **Review Document Status:** This file was generated **at the start of the Modular Dashboard Refactor review** as the pre-flight gate artifact mandated by the **Segmented PR Review** project rule (AAP § 0.8.2.4). At creation time, every phase status is `PENDING`. As each Expert Agent claims and completes a domain phase, that phase's `status` field will be flipped to `APPROVED` (or `BLOCKED`). The file MUST be re-committed after every phase transition and after the Principal Reviewer's final binary verdict. No prior review record from any unrelated work item confers approval credit to this pass; this is **review pass 1** of the Modular Dashboard Refactor and must independently satisfy every gate listed below.

## Executive Summary

### Scope of Change

This pull request introduces the **Modular Dashboard Refactor** described in the parent Agent Action Plan (AAP). The change converts the existing Ghostfolio Angular client from a multi-route, navigation-shell-driven UI into a **single-canvas modular dashboard system**, persists per-user grid layouts to PostgreSQL via a new Prisma model and authenticated NestJS endpoint pair, and intentionally treats the existing `ChatPanelComponent` as a **standalone, co-equal grid module** (DEVIATION POINT recorded per AAP § 0.7.2). The complete in-scope inventory is enumerated below per AAP § 0.7.1; the boundaries are strict — no file outside this list is modified.

| Category                                                    |  Count | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New Angular standalone components (TS + HTML + SCSS + spec) | **24** | 6 components × 4 files each per AAP § 0.9.2 — `GfDashboardCanvasComponent`, `GfModuleCatalogComponent`, `GfModuleWrapperComponent`, plus the five module-content wrappers (`GfPortfolioOverviewModuleComponent`, `GfHoldingsModuleComponent`, `GfTransactionsModuleComponent`, `GfAnalysisModuleComponent`, `GfChatModuleComponent`) — all standalone with `ChangeDetectionStrategy.OnPush`, `gf-*` selectors per `apps/client/project.json:6`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| New Angular services (TS + spec)                            |  **8** | 4 services × 2 files: `ModuleRegistryService` (`providedIn: 'root'`), client-side `UserDashboardLayoutService` (`HttpClient` wrapper for the new endpoints), `LayoutPersistenceService` (rxjs `debounceTime(500)` orchestrator), `DashboardTelemetryService` (drag/resize SLO measurement).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| New Angular interfaces                                      |  **2** | `DashboardModuleDescriptor` (registry entry shape with `minCols`, `minRows`, `component: Type<unknown>`); `LayoutData`/`LayoutItem` (persisted JSON contract: `{ version: 1, items: LayoutItem[] }`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| New NestJS files                                            |  **7** | `UserDashboardLayoutModule`, `UserDashboardLayoutController`, `UserDashboardLayoutService`, `UpdateDashboardLayoutDto`, `DashboardLayoutDto`, plus 2 `.spec.ts` files mirroring the `UserFinancialProfileModule` template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| New Prisma migration                                        |  **1** | `prisma/migrations/<timestamp>_add_user_dashboard_layout/migration.sql` — auto-generated by `npx prisma migrate dev --name add-user-dashboard-layout`; creates `UserDashboardLayout` table with `userId UUID PRIMARY KEY` (FK → `User(id) ON DELETE CASCADE`), `layoutData jsonb NOT NULL`, `createdAt timestamptz`, `updatedAt timestamptz`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| New documentation files                                     |  **3** | `docs/observability/dashboard-layout.md` (Observability rule — metrics catalog + log shapes + alert thresholds), `docs/migrations/dashboard-traceability-matrix.md` (Explainability rule — bidirectional source→target matrix with 100% coverage), `blitzy-deck/dashboard-refactor-deck.html` (Executive Presentation rule — self-contained reveal.js HTML deck, 12–18 slides).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Repo-root review artifact                                   |  **1** | This `CODE_REVIEW.md` (Segmented PR Review rule).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Total NEW files**                                         | **46** | per AAP § 0.9.2 aggregate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Modified files                                              | **12** | `prisma/schema.prisma` (append `UserDashboardLayout` model + back-relation on `User`); `libs/common/src/lib/permissions.ts` (add 2 permission constants); `apps/api/src/app/app.module.ts` (register module); `apps/client/src/app/app.routes.ts` (collapse 22-entry route table to single root); `apps/client/src/app/app.component.{ts,html,scss}` (remove header/footer chrome); `apps/client/src/styles.scss` (gridster v21+ ships CSS bundled via `ViewEncapsulation.None`, so no global import is required — see Decision D-024); `package.json` + `package-lock.json` (add `angular-gridster2@21.0.1`); `README.md` (Dashboard section); `docs/decisions/agent-action-plan-decisions.md` (append decision rows). per AAP § 0.9.3. <br/><br/>**Path correction:** AAP § 0.6.1.8 originally specified `apps/client/src/styles/styles.scss` (with a `/styles/` subfolder); the canonical path in this repository is `apps/client/src/styles.scss` (no subfolder — the global stylesheet sits at the same level as `main.ts`, while `apps/client/src/styles/` is a sibling folder containing partials). |
| Removed folder patterns                                     |  **3** | `apps/client/src/app/components/header/**`, `apps/client/src/app/components/footer/**`, `apps/client/src/app/pages/**` per AAP § 0.7.1.3 (route-shell collapse — entire `pages` namespace removed; reusable presentation components in `apps/client/src/app/components/` retained and consumed by module wrappers).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| New npm dependencies                                        |  **1** | `angular-gridster2@21.0.1` — version-pinned by AAP § 0.3.1; standalone-only Angular API (`Gridster`, `GridsterItemComponent`); Angular 21.x peer-compatible; retains `NgZone.run` calls for zone-based hosts (per AAP § 0.6.2.2 zone-interaction analysis).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| New API endpoints                                           |  **2** | `GET /api/v1/user/layout` (read saved layout), `PATCH /api/v1/user/layout` (idempotent upsert) — both protected by `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` + `@HasPermission(...)` (AAP § 0.4.1.1, Rule 8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| New permissions                                             |  **2** | `permissions.readUserDashboardLayout`, `permissions.updateUserDashboardLayout` — granted to `ADMIN` and `USER` roles only; `DEMO` and `INACTIVE` explicitly excluded per Decision D-005 pattern (AAP § 0.4.1.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Total in-scope files (logical change units)**             | **61** | 46 NEW + 12 MODIFIED + 3 REMOVED folder patterns. This is the file_count for Phase 8 (Principal Reviewer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Risk Profile

| Risk Surface                                                                                                                 | Severity       | Mitigations                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag/resize SLO under zone-based change detection (gridster v21 NgZone interaction with `provideZoneChangeDetection()` host) | **Medium**     | AAP § 0.6.2.2 Rule 5 — gridster math runs `NgZone.runOutsideAngular(...)`; canvas is `ChangeDetectionStrategy.OnPush`; per-frame work bypasses zone overhead, drag-stop re-enters zone for state updates; `DashboardTelemetryService` measures p95 visual completion latency. **Owning phase: Phase 6.** Verified by Gate 7.                                                                                                                                                           |
| Cross-user layout read/write (JWT-Authoritative Identity, Engineering Rule 5)                                                | **Medium**     | `userId` ALWAYS read from `request.user.id`; NEVER from request body or DTO. Service `findByUserId(userId)`/`upsertForUser(userId, dto)` parameterized exclusively from JWT-derived identity. Prisma `upsert.where.userId` value set by controller, never echoed from DTO. **Owning phase: Phase 2 + Phase 3.** Verified by integration tests in Phase 4 + Gate 5/6.                                                                                                                   |
| Layout payload tampering / JSON injection                                                                                    | **Medium**     | `UpdateDashboardLayoutDto` enforces shape via class-validator: `version === 1`, `items` length 0..50 (defensive cap), `cols`/`rows` bounded integers (`cols ≥ 2`, `rows ≥ 2`, `x + cols ≤ 12`), `moduleId` non-empty string ≤ 100 chars (Decision D-023 pattern). NestJS body-parser limit 512 KB; service rejects unknown discriminator strings. **Owning phase: Phase 2.** Verified by Gate 6.                                                                                       |
| Supply-chain risk of new `angular-gridster2@21.0.1` dependency                                                               | **Low–Medium** | Established Angular community package, MIT license, ~187k weekly downloads on npm, active maintainer (`tiberiuzuld`); version pinned by AAP; no new transitive dependencies introduced beyond what npm registry resolves. CI lockfile verification + Snyk/dependabot scans inherited from existing pipeline. **Owning phase: Phase 1.**                                                                                                                                                |
| Route-table collapse to single root (`/`) breaks existing deep links                                                         | **Low–Medium** | Wildcard `{ path: '**', redirectTo: '', pathMatch: 'full' }` retained as legacy URL fallback. `RouterModule.forRoot(...)` registration in `apps/client/src/main.ts` lines 70–74 preserved verbatim per AAP § 0.4.1.2. `ServiceWorkerModule`, `PageTitleStrategy`, `ModulePreloadService`, `provideZoneChangeDetection()` all retained per Rule 5. **Owning phase: Phase 6.** Verified by Gate 11.                                                                                      |
| Header/footer chrome removal alters first-paint layout                                                                       | **Low**        | `apps/client/src/app/app.component.{ts,html,scss}` reduced to `<router-outlet />` plus optional info-message banner. `:host { display: block; height: 100vh; }` retained. No chrome offsets remain that would conflict with full-canvas rendering. **Owning phase: Phase 6.**                                                                                                                                                                                                          |
| Intentional deviation: `ChatPanelComponent` becomes standalone grid module (was embedded at `portfolio-page.html:32`)        | **Low**        | DEVIATION POINT documented in three places per AAP § 0.7.2: (1) `docs/decisions/agent-action-plan-decisions.md` decision row, (2) `docs/migrations/dashboard-traceability-matrix.md` source→target mapping, (3) AAP § 0.4.1.7 removed-integration-surface table. `ChatPanelComponent` internal implementation unchanged (selector `app-chat-panel`, SSE handling, `AiChatService` consumption, all width constants); only the mount-point host is replaced. **Owning phase: Phase 7.** |
| Prisma migration conflict against existing schema                                                                            | **Low**        | AAP Rule 9 — `schema.prisma` located at `prisma/schema.prisma` (workspace root) and read before migration generation; `User`-side back-relation field added per Decision D-013 (Prisma 7.x explicit-back-relation requirement); `onDelete: Cascade` matches `FinancialProfile.user` precedent (lines 374). **Owning phase: Phase 1.** Verified by Gate 4.                                                                                                                              |
| Module-component bleed-through (a module imports the canvas layer or another module's internals)                             | **Low**        | AAP Rule 1 (Module Isolation) + Rule 2 (single source of truth) — module wrappers MUST NOT import from `apps/client/src/app/dashboard/dashboard-canvas/**` or other module folders; static grep gate during Phase 6 review. Module wrappers consume only existing presentation components (`apps/client/src/app/components/...`) and existing data-fetching services (`apps/client/src/app/services/...`). **Owning phase: Phase 6.**                                                  |
| Persistence side-channel (a module calls layout-save APIs directly, bypassing canvas state events)                           | **Low**        | AAP Rule 4 — `UserDashboardLayoutService.update(...)` invoked only by `LayoutPersistenceService`, which subscribes exclusively to canvas-emitted `Subject<void>` driven by gridster `itemChangeCallback`/`itemResizeCallback`/add/remove. Static grep gate during Phase 6: `grep -rn "UserDashboardLayoutService" apps/client/src/app/dashboard/modules/` MUST return zero matches. **Owning phase: Phase 6.** Verified by Gate 8.                                                     |
| Material 3 theming inconsistency (raw `--mat-sys-*` without fallbacks, hard-coded color literals)                            | **Low**        | AAP Rule 7 (Decision D-020) — every CSS property value emitted by dashboard SCSS uses `var(--mat-sys-<token>, <hardcoded-fallback>)`; static regex gate during Phase 6: any `var\(--mat-sys-[a-z-]+\)` (no comma + fallback) is a violation; allow-list for literals: `0`, `none`, `auto`, `inherit`, `currentColor`, `transparent` plus enumerated layout constants. **Owning phase: Phase 6.** Verified by Gate 15.                                                                  |
| Build / lint regression                                                                                                      | **Low**        | Gate 1 verifies `npx nx build client && npx nx build api` zero-error. Gate 2 verifies pre-existing test-suite green. Gate 3 verifies new specs at ≥ 80 % line coverage on registry/canvas/layout/persistence services. **Owning phase: Phase 1 + Phase 4.**                                                                                                                                                                                                                            |

### Acceptance Gate Readiness (AAP § 0.6.3.3 + § 0.8.6)

The following fifteen gates MUST pass before Phase 8 (Principal Reviewer) can issue the binary `APPROVED` verdict. A `BLOCKED` outcome on any gate returns the work item to code generation per the Segmented PR Review rule.

| Gate        | Description                                                                                                                                                                                                                                                                                                                                                           | Owning Phase(s)   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Gate 1**  | `npx nx build client && npx nx build api` completes with zero errors and zero new warnings.                                                                                                                                                                                                                                                                           | Phase 1           |
| **Gate 2**  | All existing tests pass (no regressions); pre-existing client + api + common + ui suites green.                                                                                                                                                                                                                                                                       | Phase 4           |
| **Gate 3**  | New unit tests for `ModuleRegistryService`, `GfDashboardCanvasComponent`, client-side `UserDashboardLayoutService`, and `LayoutPersistenceService` achieve ≥ 80 % line coverage (AAP § 0.8.5).                                                                                                                                                                        | Phase 4           |
| **Gate 4**  | `npx prisma migrate dev --name add-user-dashboard-layout` runs without conflicts against the existing schema (no rename of existing columns; FK to `User(id)` with `ON DELETE CASCADE`; `userDashboardLayout UserDashboardLayout?` back-relation added per Decision D-013).                                                                                           | Phase 1           |
| **Gate 5**  | `GET /api/v1/user/layout` returns `401 Unauthorized` when called without a valid JWT bearer; returns `200 OK` with the saved layout JSON when called with an authenticated user holding `permissions.readUserDashboardLayout`; returns `404 Not Found` when no layout row exists for the authenticated user; p95 latency ≤ 300 ms.                                    | Phase 2 + Phase 5 |
| **Gate 6**  | `PATCH /api/v1/user/layout` returns `401 Unauthorized` without JWT; returns `400 Bad Request` on invalid DTO (e.g., `version !== 1`, `items.length > 50`, `cols < 2`); returns `200 OK` and persists on valid payload; idempotent (Decision D-019 upsert); p95 latency ≤ 500 ms.                                                                                      | Phase 2 + Phase 5 |
| **Gate 7**  | Drag/resize visual completion < 100 ms measured against `provideZoneChangeDetection()` host (AAP § 0.6.3.3); validated via `DashboardTelemetryService` p95 instrumentation; gridster v21 `NgZone.runOutsideAngular` integration confirmed.                                                                                                                            | Phase 6           |
| **Gate 8**  | Layout save fires within 500 ms `debounceTime` after grid state change (drag, resize, add, remove); no save on no-op; static grep gate confirms `UserDashboardLayoutService` is referenced only from `LayoutPersistenceService` and the canvas component (Rule 4).                                                                                                    | Phase 6           |
| **Gate 9**  | New user (no saved layout, GET returns `404`) → blank canvas rendered + module catalog opens automatically via `MatDialog` (AAP § 0.6.3.1, Rule 10).                                                                                                                                                                                                                  | Phase 6           |
| **Gate 10** | Returning user (GET returns `200` with non-empty `items`) → saved layout hydrated to `gridster.dashboard` array on app init; catalog does NOT auto-open; FAB remains available for explicit add (AAP § 0.6.3.2).                                                                                                                                                      | Phase 6           |
| **Gate 11** | Routing infrastructure preserved verbatim in `apps/client/src/main.ts`: `RouterModule.forRoot(routes, { ... preloadingStrategy: ModulePreloadService ... })` (lines 70–74), `ServiceWorkerModule.register(...)` (75–78), `provideZoneChangeDetection()` (87), `{ provide: TitleStrategy, useClass: PageTitleStrategy }` (102–104). Diff confirms zero edits.          | Phase 3 + Phase 6 |
| **Gate 12** | Module placement below the 2×2 cell minimum is rejected by the grid engine; `ModuleRegistryService.register({...})` throws on `minCols < 2` or `minRows < 2`; per-item gridster `[minItemCols]`/`[minItemRows]` bindings honored (Rule 6).                                                                                                                            | Phase 6           |
| **Gate 13** | New permissions granted to `ADMIN` and `USER` roles only; `DEMO` and `INACTIVE` roles do NOT receive `readUserDashboardLayout` or `updateUserDashboardLayout` (Decision D-005 pattern); `HasPermissionGuard` returns `403 Forbidden` for excluded roles.                                                                                                              | Phase 2           |
| **Gate 14** | `X-Correlation-ID` header generated via `randomUUID()` from `node:crypto` and set on every response from the new endpoints; structured log entries emitted by Nest `Logger` include the correlationId field; metrics counters (`dashboard_layout_get_total`, `dashboard_layout_patch_total`, `dashboard_layout_save_failures_total`) registered (Observability rule). | Phase 1 + Phase 3 |
| **Gate 15** | Material 3 var/fallback pattern present in every new SCSS file under `apps/client/src/app/dashboard/**/*.scss`; no raw `--mat-sys-*` references without fallback; no hard-coded color literals outside the allow-list (Rule 7, Decision D-020).                                                                                                                       | Phase 6           |

### Review Workflow

```
Phase 0 (Pre-flight) → Phase 1 (Infrastructure / DevOps) → Phase 2 (Security)
   → Phase 3 (Backend Architecture) → Phase 4 (QA / Test Integrity)
   → Phase 5 (Business / Domain) → Phase 6 (Frontend)
   → Phase 7 (Other SME) → Phase 8 (Principal Reviewer)
```

Each phase blocks the next: a `BLOCKED` status on phase _n_ MUST be resolved (i.e., the work item returns to code generation, the issue is fixed, and the review restarts from Phase 0) before phase _n+1_ may begin. The `PENDING` status indicates that the phase has not yet been claimed by an Expert Agent. Per the Segmented PR Review rule (AAP § 0.8.2.4), each phase resolves to **exactly** `APPROVED` or `BLOCKED` — qualifiers such as "approved with concerns", "conditional approval", or "approved pending" are prohibited.

> **Segmented PR Review rule (AAP § 0.8.2.4):** Every changed file MUST be partitioned into exactly one sequential domain phase from this fixed list: Infrastructure / DevOps, Security, Backend Architecture, QA / Test Integrity, Business / Domain, Frontend, Other SME, Principal Reviewer. The Principal Reviewer issues exactly `APPROVED` or `BLOCKED` after every domain phase is `APPROVED`. A `BLOCKED` verdict in any phase returns the work item to code generation with a full restart from pre-flight.

---

## Phase 0 — Pre-flight (Segmented PR Review)

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by Lead Validation Engineer_
**Date:** _to be set on phase entry_
**File count:** 0 (gate-only — Phase 0 is the artifact-creation gate, not a file-review phase)

### Purpose

Per the Segmented PR Review rule, every review pass MUST begin with an atomic Phase 0 pre-flight gate that confirms the review artifact (this `CODE_REVIEW.md`) is present at the repository root, partitions every in-scope file into exactly one downstream phase, and locks the phase boundaries before Phase 1 may begin. If any pre-flight condition fails, the review terminates immediately and remediation occurs in code generation. No prior review pass confers approval credit.

### Pre-flight Conditions

| #   | Condition                                                                                                                                                                                                                                                | Expected Outcome | Verification Method                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | This `CODE_REVIEW.md` artifact exists at repository root with valid Markdown + YAML front matter; every phase status is initialized to `PENDING`; this is review pass 1 of the Modular Dashboard Refactor.                                               | **PENDING**      | `ls /CODE_REVIEW.md` + YAML lint + `grep -c "status: PENDING" CODE_REVIEW.md` returns 9 (phase_zero + 8 phases).                                     |
| 2   | Every file listed in AAP § 0.7.1 in-scope inventory is partitioned into exactly one downstream phase (1–7); no file appears in two phases; Phase 8 (Principal Reviewer) consolidates all 61 logical change units.                                        | **PENDING**      | Phase scope sections enumerate disjoint file sets totalling 54 files (5+4+3+13+5+19+5); Phase 8 lists all 46 NEW + 12 MODIFIED + 3 REMOVED = 61.     |
| 3   | The AAP § 0.8.1 ten user-specified rules (R1–R10) and AAP § 0.8.2 four project-level rules (Observability, Explainability, Executive Presentation, Segmented PR Review) are each assigned at least one verifying phase in the Traceability Matrix below. | **PENDING**      | Cross-reference rule rows in Traceability Matrix; every rule row has a non-empty "Verifying Phase(s)" cell.                                          |
| 4   | The 15 acceptance gates (Gate 1 – Gate 15) are each assigned an owning phase; no gate is unowned.                                                                                                                                                        | **PENDING**      | Cross-reference gate rows in Acceptance Gate Readiness table; every gate row has a non-empty "Owning Phase(s)" cell.                                 |
| 5   | The work item is on the assigned feature branch (`blitzy-4678eab3-b225-4bfc-9190-5c0f3e229271`); base is `main`; this `CODE_REVIEW.md` is committed before Phase 1 begins.                                                                               | **PENDING**      | `git branch --show-current` returns the feature branch; `git log -- CODE_REVIEW.md` shows a commit by the Blitzy Code Generation Agent on this pass. |

### Sign-off

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| **Status**        | `PENDING`                                   |
| **Reviewer**      | _to be assigned (Lead Validation Engineer)_ |
| **Decision date** | _to be set on phase exit_                   |
| **Findings**      | _to be populated by the reviewer_           |

---

## Phase 1 — Infrastructure / DevOps

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by Infrastructure / DevOps Specialist_
**Date:** _to be set on phase entry_
**File count:** 5

### Scope (5 files)

| #   | Path                                                                    | Change Type  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `package.json`                                                          | MODIFY       | Add `"angular-gridster2": "21.0.1"` to `dependencies` block (alphabetical order).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | `package-lock.json`                                                     | MODIFY       | Auto-regenerated by `npm install angular-gridster2@21.0.1`; locks the gridster transitive dependency tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | `prisma/schema.prisma`                                                  | MODIFY       | Append `model UserDashboardLayout` block; add `userDashboardLayout UserDashboardLayout?` back-relation to `User` model per Decision D-013 (Prisma 7.x requirement).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | `prisma/migrations/<timestamp>_add_user_dashboard_layout/migration.sql` | CREATE       | Auto-generated by `npx prisma migrate dev --name add-user-dashboard-layout`; creates table with FK cascade, jsonb column, default timestamps; no conflicts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | `apps/client/src/styles.scss`                                           | NOT MODIFIED | AAP § 0.6.1.8 specified an `@import 'angular-gridster2/css/gridster.css';` at this path. **angular-gridster2 v21.0.1 ships no standalone `css/gridster.css` file**: the bundled CSS is embedded via `@Component({ styles: [...], encapsulation: ViewEncapsulation.None })` in `node_modules/angular-gridster2/fesm2022/angular-gridster2.mjs` and is therefore loaded automatically when the `Gridster` component is rendered. Adding the import would cause the build to fail (file-not-found). The path itself is corrected to `apps/client/src/styles.scss` (no `/styles/` subfolder — the global stylesheet sits at `apps/client/src/styles.scss` alongside `main.ts`). The deviation is documented in `docs/decisions/agent-action-plan-decisions.md` as Decision D-024. |

### Checklist

This phase enforces the build-integrity, dependency-supply-chain, schema-migration-safety, and global-stylesheet-import gates:

- [ ] **AAP Rule 9** — `schema.prisma` located at `prisma/schema.prisma`; new `UserDashboardLayout` model does not conflict with existing `User` (line 261) or `FinancialProfile` (line 364) models.
- [ ] **Decision D-013** — `User` model gains explicit back-relation field `userDashboardLayout UserDashboardLayout?`.
- [ ] **Decision D-005 pattern** — model and FK use `onDelete: Cascade, onUpdate: Cascade` (mirrors `FinancialProfile.user`).
- [ ] **Gate 1** — `npx nx build client && npx nx build api` completes with zero errors and zero new warnings.
- [ ] **Gate 4** — `npx prisma migrate dev --name add-user-dashboard-layout` runs without schema conflicts.
- [ ] **Gate 14** (partial) — Observability runbook entries reachable from Phase 7 will reference metrics emitted by code reviewed in Phase 3; Phase 1 verifies the runtime dependency footprint required for those metrics (no new metric server runtime).
- [ ] Dependency provenance — `angular-gridster2@21.0.1` is the canonical Angular-native grid engine, MIT-licensed, version-pinned by AAP § 0.3.1; no new transitive dependencies require security review beyond standard supply-chain scans.
- [ ] Lockfile diff is consistent — no spurious version bumps for unrelated packages introduced by `npm install`.

### Sign-off

| Field             | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| **Status**        | `PENDING`                                             |
| **Reviewer**      | _to be assigned (Infrastructure / DevOps Specialist)_ |
| **Decision date** | _to be set on phase exit_                             |
| **Findings**      | _to be populated by the reviewer_                     |

---

## Phase 2 — Security

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by Security Specialist_
**Date:** _to be set on phase entry_
**File count:** 4

### Scope (4 files)

| #   | Path                                                        | Change Type | Notes                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `libs/common/src/lib/permissions.ts`                        | MODIFY      | Add `readUserDashboardLayout` and `updateUserDashboardLayout` permission constants; grant to `ADMIN` and `USER` roles only; `DEMO` and `INACTIVE` explicitly excluded per Decision D-005 pattern.                                                                                                                               |
| 2   | `apps/api/src/app/user/user-dashboard-layout.controller.ts` | CREATE      | NestJS controller declaring `GET /user/layout` and `@HttpCode(HttpStatus.OK) PATCH /user/layout`; class-level `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)`; method-level `@HasPermission(permissions.readUserDashboardLayout)` / `@HasPermission(permissions.updateUserDashboardLayout)`; sets `X-Correlation-ID` header. |
| 3   | `apps/api/src/app/user/dtos/update-dashboard-layout.dto.ts` | CREATE      | Class-validator request DTO for PATCH body; enforces `version === 1`, `items` length 0..50, per-item shape (`@IsArray`, `@ValidateNested`, `@Type(() => LayoutItemDto)`, `@IsObject`, `@MaxLength(100)` on `moduleId`, integer bounds on `cols`/`rows`/`x`/`y`).                                                                |
| 4   | `apps/api/src/app/user/dtos/dashboard-layout.dto.ts`        | CREATE      | Response DTO shape echoed back from GET / PATCH; mirrors persisted JSON contract.                                                                                                                                                                                                                                               |

### Checklist

This phase enforces JWT-Authoritative Identity, permission-based authorization, payload-validation, and credential-hygiene gates:

- [ ] **AAP Rule 8** — `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` applied at class scope; per-method `@HasPermission(...)` decorators applied. Exact decorator stack mirrors `apps/api/src/app/user/user.controller.ts` line 60 + `user-financial-profile.controller.ts`.
- [ ] **Engineering Rule 5 (JWT-Authoritative Identity)** — controller derives `userId` exclusively from `request.user.id`; DTO does NOT carry `userId`; service `findByUserId(userId)` / `upsertForUser(userId, dto)` are parameterized exclusively from JWT-derived identity.
- [ ] **Decision D-019** — PATCH uses idempotent `prisma.userDashboardLayout.upsert({ where: { userId }, create: { userId, layoutData }, update: { layoutData } })`.
- [ ] **Decision D-005 pattern** — `DEMO` and `INACTIVE` roles excluded from the new permission grants; matrix mirrors `readFinancialProfile` / `updateFinancialProfile` precedent (§ 0.4.1.5).
- [ ] **Decision D-023** — class-validator DTO uses `@IsArray`, `@ValidateNested`, `@IsObject`, `@MaxLength`, integer bounds; rejects unknown discriminator strings.
- [ ] **Gate 5** — `GET /api/v1/user/layout` returns `401 Unauthorized` without JWT; returns `403 Forbidden` for users without `permissions.readUserDashboardLayout`.
- [ ] **Gate 6** — `PATCH /api/v1/user/layout` returns `401`/`400` on missing JWT / invalid DTO; persists on valid payload.
- [ ] **Gate 13** — Permission grants to `ADMIN`/`USER` only; static grep + role-permission matrix confirm exclusion of `DEMO`/`INACTIVE`.
- [ ] No new credential, secret, or environment variable introduced by this change (verified by diff).

### Sign-off

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| **Status**        | `PENDING`                              |
| **Reviewer**      | _to be assigned (Security Specialist)_ |
| **Decision date** | _to be set on phase exit_              |
| **Findings**      | _to be populated by the reviewer_      |

---

## Phase 3 — Backend Architecture

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by Backend Architecture Specialist_
**Date:** _to be set on phase entry_
**File count:** 3

### Scope (3 files)

| #   | Path                                                     | Change Type | Notes                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/api/src/app/user/user-dashboard-layout.module.ts`  | CREATE      | NestJS feature module; declares `@Module({ controllers: [UserDashboardLayoutController], providers: [UserDashboardLayoutService], imports: [PrismaModule], exports: [UserDashboardLayoutService] })`.                                                                                             |
| 2   | `apps/api/src/app/user/user-dashboard-layout.service.ts` | CREATE      | NestJS service exposing `findByUserId(userId, correlationId?)` (returns `null` on missing) and `upsertForUser(userId, layoutData, correlationId?)` (idempotent Prisma upsert per Decision D-019); injects `PrismaService`; registers `MetricsService` counters/histograms for Observability rule. |
| 3   | `apps/api/src/app/app.module.ts`                         | MODIFY      | Add `import { UserDashboardLayoutModule } from './user/user-dashboard-layout.module';` (line ~66 area); register in `@Module({ imports: [...] })` array adjacent to `UserFinancialProfileModule` (line ~182).                                                                                     |

### Checklist

This phase enforces module-isolation, controller-thinness, idempotency, observability-wiring, and routing-infrastructure-preservation gates:

- [ ] **AAP Rule 1 (Module Isolation)** — `UserDashboardLayoutModule` does not import other feature modules' internals; consumes only `PrismaModule` (and indirectly `MetricsModule` via DI).
- [ ] **Decision D-019** — service `upsertForUser` uses Prisma `upsert` keyed on `userId` (idempotent across PATCH retries).
- [ ] **Service-only data access** — controller delegates ALL business logic to the service; service is the only consumer of `prismaService.userDashboardLayout` delegate.
- [ ] **Observability wiring** — service registers metrics counters (`dashboard_layout_get_total`, `dashboard_layout_patch_total`, `dashboard_layout_save_failures_total`) and histogram (`dashboard_layout_request_duration_seconds`) per AAP § 0.6.1.10; pattern mirrors `snowflake-sync.service.ts`.
- [ ] **Gate 11 (cross-checked here)** — `apps/api/src/app/app.module.ts` modification is purely additive (one new import + one new entry in `imports: [...]`); existing module registrations preserved.
- [ ] **Gate 14** — `correlationId` parameter threaded from controller → service; structured log entries emitted via Nest `Logger` include the field.
- [ ] **AAP § 0.4.1.1** — module placement adjacent to `UserFinancialProfileModule` confirmed.

### Sign-off

| Field             | Value                                              |
| ----------------- | -------------------------------------------------- |
| **Status**        | `PENDING`                                          |
| **Reviewer**      | _to be assigned (Backend Architecture Specialist)_ |
| **Decision date** | _to be set on phase exit_                          |
| **Findings**      | _to be populated by the reviewer_                  |

---

## Phase 4 — QA / Test Integrity

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by QA / Test Integrity Specialist_
**Date:** _to be set on phase entry_
**File count:** 13

### Scope (13 files)

API specs (2):

| #   | Path                                                             | Notes                                                                                                                                                                    |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `apps/api/src/app/user/user-dashboard-layout.controller.spec.ts` | Mirrors `user-financial-profile.controller.spec.ts`: route metadata, guard registration, GET/PATCH delegation, 401/403 propagation, NotFoundException on missing layout. |
| 2   | `apps/api/src/app/user/user-dashboard-layout.service.spec.ts`    | Mirrors `user-financial-profile.service.spec.ts`: user-scoped lookup, null-on-missing, upsert-vs-create semantics, DTO field passthrough, correlation-id threading.      |

Client dashboard specs (11) — all `apps/client/src/app/dashboard/**/*.spec.ts`:

| #   | Path                                                                                                   | Notes                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 3   | `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.spec.ts`                    | Blank canvas on first visit, layout-driven render on returning user, catalog auto-open on 404, save fires within 500 ms debounce. |
| 4   | `apps/client/src/app/dashboard/module-registry.service.spec.ts`                                        | Registration, duplicate-name rejection, minimum-dimensions validation (Rule 6), retrieval.                                        |
| 5   | `apps/client/src/app/dashboard/services/user-dashboard-layout.service.spec.ts`                         | GET/PATCH calls via `HttpTestingController`, 404 handling, error propagation.                                                     |
| 6   | `apps/client/src/app/dashboard/services/layout-persistence.service.spec.ts`                            | 500 ms debounce window, no save on no-op, error path.                                                                             |
| 7   | `apps/client/src/app/dashboard/module-catalog/module-catalog.component.spec.ts`                        | List rendering, search filter, click-to-add, drag-from-catalog, auto-open behavior.                                               |
| 8   | `apps/client/src/app/dashboard/module-wrapper/module-wrapper.component.spec.ts`                        | Header rendering, remove emission.                                                                                                |
| 9   | `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview-module.component.spec.ts` | Smoke test — wrapper renders inner `GfHomeOverviewComponent`.                                                                     |
| 10  | `apps/client/src/app/dashboard/modules/holdings/holdings-module.component.spec.ts`                     | Smoke test — wrapper renders inner holdings presentation.                                                                         |
| 11  | `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.spec.ts`             | Smoke test — wrapper renders inner activities/transactions presentation.                                                          |
| 12  | `apps/client/src/app/dashboard/modules/analysis/analysis-module.component.spec.ts`                     | Smoke test — wrapper renders inner analysis presentation.                                                                         |
| 13  | `apps/client/src/app/dashboard/modules/chat/chat-module.component.spec.ts`                             | Smoke test — wrapper renders inner `ChatPanelComponent` (DEVIATION POINT — selector `app-chat-panel`).                            |

### Checklist

This phase enforces unit-test-coverage, regression-safety, and required-scenario-coverage gates per AAP § 0.8.5:

- [ ] **AAP § 0.8.5 (Unit test coverage)** — ≥ 80 % line coverage for `ModuleRegistryService`, `LayoutPersistenceService`, `GfDashboardCanvasComponent`.
- [ ] **AAP § 0.8.5 (Required scenarios)** — every required scenario covered:
  - [ ] new user → blank canvas renders, catalog auto-opens
  - [ ] returning user → saved layout renders on init
  - [ ] layout save fires on drag/resize/add/remove within 500 ms debounce
  - [ ] unauthenticated GET and PATCH return 401
  - [ ] module placement below 2×2 minimum is rejected by grid engine (Rule 6, Gate 12)
- [ ] **Gate 2** — pre-existing test suites (`api`, `client`, `common`, `ui`) remain green; no regressions.
- [ ] **Gate 3** — new spec file coverage measured and ≥ 80 %.
- [ ] **AAP § 0.8.5 (File placement)** — co-located `*.spec.ts` files next to source per existing nx workspace conventions.
- [ ] No spec relies on production secrets or live external services.
- [ ] All tests run under `CI=true npx dotenv-cli -e .env.example -- nx test <project>` per setup status; no test enters watch mode.

### Sign-off

| Field             | Value                                             |
| ----------------- | ------------------------------------------------- |
| **Status**        | `PENDING`                                         |
| **Reviewer**      | _to be assigned (QA / Test Integrity Specialist)_ |
| **Decision date** | _to be set on phase exit_                         |
| **Findings**      | _to be populated by the reviewer_                 |

---

## Phase 5 — Business / Domain

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by Business / Domain Specialist_
**Date:** _to be set on phase entry_
**File count:** 5

### Scope (5 files)

| #   | Path                                                                      | Change Type | Notes                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/client/src/app/dashboard/module-registry.service.ts`                | CREATE      | `providedIn: 'root'` registry exposing `register(metadata)`, `getAll()`, `getByName(name)`; rejects duplicate names; enforces `minCols ≥ 2`/`minRows ≥ 2` at registration.                                                                         |
| 2   | `apps/client/src/app/dashboard/services/user-dashboard-layout.service.ts` | CREATE      | `HttpClient` wrapper for `GET` / `PATCH /api/v1/user/layout`; returns Observable<LayoutData>; JWT bearer auto-attached by existing `auth.interceptor.ts`.                                                                                          |
| 3   | `apps/client/src/app/dashboard/services/layout-persistence.service.ts`    | CREATE      | rxjs-driven debouncer (`debounceTime(500)`) consuming a `Subject<void>` from the canvas; calls `userDashboardLayoutService.update(...)`; the SOLE caller of the layout service per Rule 4.                                                         |
| 4   | `apps/client/src/app/dashboard/interfaces/dashboard-module.interface.ts`  | CREATE      | TypeScript interface `DashboardModuleDescriptor` describing a registered module: `{ name: string; component: Type<unknown>; minCols: number; minRows: number; defaultCols: number; defaultRows: number; displayLabel: string; iconName: string }`. |
| 5   | `apps/client/src/app/dashboard/interfaces/layout-data.interface.ts`       | CREATE      | TypeScript interfaces `LayoutData` (`{ version: 1; items: LayoutItem[] }`) and `LayoutItem` (`{ moduleId; cols; rows; x; y }`); mirrors persisted JSON shape (AAP § 0.6.1.7); shared with `libs/common` mirror.                                    |

### Checklist

This phase enforces domain-correctness, service-contract, and module-registry-as-single-source gates:

- [ ] **AAP Rule 3 (Module Registry as sole mechanism)** — registry is the only path for introducing module types; no canvas-side hard-coded `import { GfHoldingsModuleComponent }` or `switch (moduleId)` lookups.
- [ ] **AAP Rule 4 (Persistence triggered only by grid state events)** — `LayoutPersistenceService` is the SOLE caller of `userDashboardLayoutService.update(...)`; subscribes only to canvas-emitted events.
- [ ] **AAP Rule 6 (Modules declare minimum cell dimensions)** — registry rejects entries with `minCols < 2` or `minRows < 2`; spec verifies (Phase 4 cross-link).
- [ ] **Gate 5** — client-side service GET path returns saved layout to the canvas; integrates with the API contract verified by Phase 2.
- [ ] **Gate 6** — client-side service PATCH path persists payload on drag/resize/add/remove; integrates with the API contract verified by Phase 2.
- [ ] **Gate 8** — debounce window is exactly 500 ms (rxjs `debounceTime(500)`); collapses bursts to a single PATCH.
- [ ] **AAP § 0.6.1.7** — `LayoutData` interface matches persisted JSON contract: `version === 1`, `items` length 0..50, integer bounds on cell coordinates.
- [ ] Interface shapes align with `libs/common/src/lib/interfaces/dashboard-layout.interface.ts` mirror used by the API DTOs.

### Sign-off

| Field             | Value                                           |
| ----------------- | ----------------------------------------------- |
| **Status**        | `PENDING`                                       |
| **Reviewer**      | _to be assigned (Business / Domain Specialist)_ |
| **Decision date** | _to be set on phase exit_                       |
| **Findings**      | _to be populated by the reviewer_               |

---

## Phase 6 — Frontend

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by Frontend Specialist_
**Date:** _to be set on phase entry_
**File count:** 19

### Scope (19 files)

Canvas component (3):

| #   | Path                                                                             | Change Type | Notes                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.ts`   | CREATE      | Standalone OnPush component; embeds `<gridster>` with 12-col fixed-row config; subscribes to gridster change callbacks; orchestrates module registry + persistence; auto-opens catalog on 404. |
| 2   | `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.html` | CREATE      | Template with `<gridster [options]="options"><gridster-item @for="..."></gridster-item></gridster>` plus catalog overlay slot; uses Angular control-flow `@for`/`@if`.                         |
| 3   | `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.scss` | CREATE      | Canvas-level SCSS using `var(--mat-sys-surface, #fffbfe)` and other M3 tokens with fallbacks (Rule 7, Decision D-020).                                                                         |

Module catalog component (3):

| #   | Path                                                                         | Change Type | Notes                                                                                                                                   |
| --- | ---------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | `apps/client/src/app/dashboard/module-catalog/module-catalog.component.ts`   | CREATE      | Standalone component opened via `MatDialog`; `ModuleRegistryService` injected; emits `(addModule)` event with the chosen `moduleId`.    |
| 5   | `apps/client/src/app/dashboard/module-catalog/module-catalog.component.html` | CREATE      | Template with `MatFormField` search input (`debounceTime(150)`), `MatList` rows with leading `ion-icon` + trailing add `MatIconButton`. |
| 6   | `apps/client/src/app/dashboard/module-catalog/module-catalog.component.scss` | CREATE      | Catalog overlay SCSS using `--mat-sys-surface-container-highest` + shape tokens, all with fallbacks.                                    |

Module wrapper component (3):

| #   | Path                                                                         | Change Type | Notes                                                                                                                            |
| --- | ---------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 7   | `apps/client/src/app/dashboard/module-wrapper/module-wrapper.component.ts`   | CREATE      | Standalone wrapper providing the unified header chrome (drag handle, title, kebab, remove); projects content via `<ng-content>`. |
| 8   | `apps/client/src/app/dashboard/module-wrapper/module-wrapper.component.html` | CREATE      | Template with 40-px header (drag handle on left third, title centered, kebab + remove on right) plus content slot.               |
| 9   | `apps/client/src/app/dashboard/module-wrapper/module-wrapper.component.scss` | CREATE      | Chrome SCSS strictly using the var/fallback pattern; resting elevation `--mat-sys-level1`, hover/dragging `--mat-sys-level2`.    |

Module wrappers (5):

| #   | Path                                                                                              | Change Type | Notes                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview-module.component.ts` | CREATE      | Wrapper rendering existing `GfHomeOverviewComponent` inside grid chrome; consumes `PortfolioService` unchanged.                                    |
| 11  | `apps/client/src/app/dashboard/modules/holdings/holdings-module.component.ts`                     | CREATE      | Wrapper rendering existing holdings presentation; consumes `PortfolioService` unchanged.                                                           |
| 12  | `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.ts`             | CREATE      | Wrapper rendering existing activities/transactions presentation; consumes existing transactions service unchanged.                                 |
| 13  | `apps/client/src/app/dashboard/modules/analysis/analysis-module.component.ts`                     | CREATE      | Wrapper rendering existing analysis presentation; consumes existing services unchanged.                                                            |
| 14  | `apps/client/src/app/dashboard/modules/chat/chat-module.component.ts`                             | CREATE      | Wrapper rendering existing `ChatPanelComponent` (selector `app-chat-panel`) — DEVIATION POINT per AAP § 0.7.2; consumes `AiChatService` unchanged. |

Telemetry service (1):

| #   | Path                                                                    | Change Type | Notes                                                                                                                                                              |
| --- | ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 15  | `apps/client/src/app/dashboard/services/dashboard-telemetry.service.ts` | CREATE      | Lightweight client telemetry — measures gridster drag/resize visual completion latency; emits structured logs in dev; SLO target < 100 ms (AAP § 0.6.3.3, Gate 7). |

App shell (4):

| #   | Path                                     | Change Type | Notes                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | `apps/client/src/app/app.routes.ts`      | MODIFY      | Replace 22-entry `routes` array with `[{ path: '', component: GfDashboardCanvasComponent, canActivate: [AuthGuard], title: 'Dashboard' }, { path: '**', redirectTo: '', pathMatch: 'full' }]`. **`apps/client/src/main.ts` lines 70–104 preserved verbatim** — Rule 5. |
| 17  | `apps/client/src/app/app.component.ts`   | MODIFY      | Remove `GfFooterComponent` (line 36) and `GfHeaderComponent` (line 37) imports; remove from component's `imports: [...]` array; remove logic exclusively servicing the chrome.                                                                                         |
| 18  | `apps/client/src/app/app.component.html` | MODIFY      | Reduce template to `<router-outlet />` plus optional info-message banner; remove `<gf-header>`/`<gf-footer>` references.                                                                                                                                               |
| 19  | `apps/client/src/app/app.component.scss` | MODIFY      | Remove header/footer-specific positioning rules; retain `:host { display: block; height: 100vh; }`.                                                                                                                                                                    |

### Checklist

This phase enforces grid-engine, module-isolation, persistence-via-grid-events, design-system-compliance, routing-preservation, and SLO gates:

- [ ] **AAP Rule 1 (Module Isolation)** — `grep -rn "from.*dashboard-canvas" apps/client/src/app/dashboard/modules/` returns zero matches; modules consume only `apps/client/src/app/services/...` and `apps/client/src/app/components/...` (and `libs/ui/src/lib/services/...`).
- [ ] **AAP Rule 2 (Grid state as single source of truth)** — module wrappers do NOT declare `@Input()`/`@Output()` for layout coordinates; do NOT mutate `elementRef.nativeElement.style` for layout properties.
- [ ] **AAP Rule 3 (Module Registry as sole mechanism)** — canvas resolves component types only via `descriptor.component` from the registry; no hard-coded module-component imports inside the canvas.
- [ ] **AAP Rule 4 (Persistence via grid events only)** — `grep -rn "UserDashboardLayoutService" apps/client/src/app/dashboard/modules/` returns zero matches.
- [ ] **AAP Rule 5 (Router infrastructure preserved)** — diff against `apps/client/src/main.ts` shows zero edits to lines 70–104 (`RouterModule.forRoot`, `ServiceWorkerModule`, `provideZoneChangeDetection`, `PageTitleStrategy`, `ModulePreloadService`); `apps/client/src/app/services/page-title.strategy.ts` and `apps/client/src/app/core/module-preload.service.ts` unchanged.
- [ ] **AAP Rule 6 (Minimum cell dimensions)** — `<gridster-item [minItemCols]="descriptor.minCols" [minItemRows]="descriptor.minRows">` bindings present; gridster engine enforces 2×2 floor.
- [ ] **AAP Rule 7 (Material 3 var/fallback)** — every CSS property value in `apps/client/src/app/dashboard/**/*.scss` resolves through `var(--mat-sys-<token>, <fallback>)`; static regex `var\(--mat-sys-[a-z-]+\)` (no comma) returns zero matches; only allow-list literals (`0`/`none`/`auto`/`inherit`/`currentColor`/`transparent` + enumerated layout constants from AAP § 0.5.3.2) appear.
- [ ] **AAP Rule 10 (Catalog auto-opens on first visit)** — `GfDashboardCanvasComponent.ngOnInit` opens the catalog via `MatDialog.open(...)` on `404` or empty `items`.
- [ ] **Gate 7** — drag/resize visual completion < 100 ms (instrumented by `DashboardTelemetryService` p95); gridster math runs `NgZone.runOutsideAngular`; canvas is `OnPush`.
- [ ] **Gate 8** — layout save fires within 500 ms `debounceTime` (Phase 5 service, but the canvas wires the `Subject<void>` here).
- [ ] **Gate 9** — new-user blank-canvas + auto-catalog path verified.
- [ ] **Gate 10** — returning-user hydration path verified; catalog does NOT auto-open.
- [ ] **Gate 11** — `apps/client/src/main.ts` zero-diff confirmed.
- [ ] **Gate 12** — module placement < 2×2 rejected by gridster.
- [ ] **Gate 15** — Material 3 var/fallback pattern audit zero-violation.
- [ ] **Selector Naming Convention** — all new components use `gf-*` prefix (per `apps/client/project.json:6`); `app-chat-panel` retained as legacy exception (AAP § 0.7.4).

### Sign-off

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| **Status**        | `PENDING`                              |
| **Reviewer**      | _to be assigned (Frontend Specialist)_ |
| **Decision date** | _to be set on phase exit_              |
| **Findings**      | _to be populated by the reviewer_      |

---

## Phase 7 — Other SME

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by SME (Documentation, Decision-log, Executive Communication, ChatPanelComponent deviation)_
**Date:** _to be set on phase entry_
**File count:** 5

### Scope (5 files)

| #   | Path                                               | Change Type | Notes                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `docs/observability/dashboard-layout.md`           | CREATE      | Observability runbook per Observability project rule (AAP § 0.8.2.1) — metrics catalog, structured-log fields, dashboard JSON template, alert rules, local verification procedure. Mirrors existing files: `ai-chat.md`, `ai-rebalancing.md`, `snowflake-sync.md`. |
| 2   | `docs/decisions/agent-action-plan-decisions.md`    | MODIFY      | Append decision rows: dashboard-refactor scope, ChatPanelComponent deviation per § 0.7.2, `MatDialog` vs `MatSidenav` for catalog, gridster v21 vs alternatives, JSON `layoutData` vs normalized table, `upsert` vs `update` for PATCH semantics.                  |
| 3   | `docs/migrations/dashboard-traceability-matrix.md` | CREATE      | Bidirectional traceability matrix per Explainability project rule (AAP § 0.8.2.2) — every removed/preserved/added construct mapped to its target with 100% coverage.                                                                                               |
| 4   | `blitzy-deck/dashboard-refactor-deck.html`         | CREATE      | Self-contained reveal.js executive deck per Executive Presentation project rule (AAP § 0.8.2.3) — 12–18 slides; CDN-pinned reveal.js 5.1.0, Mermaid 11.4.0, Lucide 0.460.0; Mermaid `startOnLoad: false` re-run on `slidechanged`; Blitzy brand palette.           |
| 5   | `README.md`                                        | MODIFY      | Append brief "Dashboard" section pointing at the observability runbook and the new endpoints.                                                                                                                                                                      |

### Checklist

This phase enforces project-level rule compliance and the intentional ChatPanelComponent deviation:

- [ ] **AAP § 0.8.2.1 (Observability rule)** — runbook documents the four required deliverables: structured logging with correlation IDs, distributed tracing across service boundaries, metrics endpoint, health/readiness checks; sample queries and alert thresholds present; local verification procedure included.
- [ ] **AAP § 0.8.2.2 (Explainability rule)** — decision log gains entries for the chat-panel deviation, MatDialog vs MatSidenav, gridster vs alternatives, JSON shape choice, upsert semantics; bidirectional traceability matrix achieves 100% coverage.
- [ ] **AAP § 0.8.2.3 (Executive Presentation rule)** — deck honors all canvas-section requirements: 12–18 slides, four slide types (`slide-title`, `slide-divider`, default content, `slide-closing`), every slide has at least one non-text visual (Mermaid, KPI card, styled table, or Lucide SVG), zero emoji, no fenced code blocks, CDN dependencies pinned, Mermaid `startOnLoad: false` + `slidechanged` re-init, Lucide icons re-rendered on `slidechanged`, Inter / Space Grotesk / Fira Code fonts via Google Fonts.
- [ ] **AAP § 0.7.2 (Intentional deviation)** — `ChatPanelComponent` deviation recorded in three places: (1) decision log entry, (2) traceability matrix mapping `portfolio-page.html:32` → `apps/client/src/app/dashboard/modules/chat/chat-module.component.ts`, (3) AAP § 0.4.1.7 already documents the removed integration surface.
- [ ] README "Dashboard" section is concise (≤ 10 lines), points at the observability runbook + the two endpoints + the AAP location.
- [ ] No new external dependency introduced for documentation (CDN-pinned only); no new secrets referenced.

### Sign-off

| Field             | Value                                                                           |
| ----------------- | ------------------------------------------------------------------------------- |
| **Status**        | `PENDING`                                                                       |
| **Reviewer**      | _to be assigned (SME — Documentation / Decision-log / Executive Communication)_ |
| **Decision date** | _to be set on phase exit_                                                       |
| **Findings**      | _to be populated by the reviewer_                                               |

---

## Phase 8 — Principal Reviewer (Final Sign-Off)

**Phase status: `PENDING`**
**Owning Expert Agent:** _to be claimed by Principal Reviewer_
**Date:** _to be set on phase entry_
**File count:** 61 (full final consolidation: 46 NEW + 12 MODIFIED + 3 REMOVED folder patterns)

### Scope

The Principal Reviewer consolidates the seven prior domain phases into the final binary verdict. Per the Segmented PR Review rule (AAP § 0.8.2.4), only `APPROVED` or `BLOCKED` are permitted — no qualifiers (no "approved with concerns", no "conditional approval", no "approved pending"). A `BLOCKED` verdict returns the work item to code generation with a full restart from pre-flight (Phase 0).

The full consolidation set:

| Group          |  Count | Reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEW files      |     46 | All files enumerated in AAP § 0.7.1.1 + this `CODE_REVIEW.md` (per AAP § 0.9.2 aggregate).                                                                                                                                                                                                                                                                                                                                                                                                     |
| MODIFIED files |     12 | `prisma/schema.prisma`, `libs/common/src/lib/permissions.ts`, `apps/api/src/app/app.module.ts`, `apps/client/src/app/app.routes.ts`, `apps/client/src/app/app.component.ts`, `apps/client/src/app/app.component.html`, `apps/client/src/app/app.component.scss`, `apps/client/src/styles.scss` (NOT MODIFIED — gridster v21+ bundles CSS internally; see Decision D-024), `package.json`, `package-lock.json`, `README.md`, `docs/decisions/agent-action-plan-decisions.md` (per AAP § 0.9.3). |
| REMOVED        |      3 | `apps/client/src/app/components/header/**`, `apps/client/src/app/components/footer/**`, `apps/client/src/app/pages/**` (per AAP § 0.7.1.3).                                                                                                                                                                                                                                                                                                                                                    |
| **Total**      | **61** | Full consolidation set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Checklist

The Principal Reviewer verifies that every prior domain phase issued `APPROVED` AND every gate / rule below is satisfied:

- [ ] **Phase 0 (Pre-flight)** — `APPROVED`.
- [ ] **Phase 1 (Infrastructure / DevOps)** — `APPROVED`; Gates 1, 4 satisfied.
- [ ] **Phase 2 (Security)** — `APPROVED`; Gates 5, 6, 13 satisfied; Engineering Rule 5 enforced.
- [ ] **Phase 3 (Backend Architecture)** — `APPROVED`; Rule 1, 11 satisfied; Gate 14 (in part) satisfied.
- [ ] **Phase 4 (QA / Test Integrity)** — `APPROVED`; Gates 2, 3 satisfied; AAP § 0.8.5 required scenarios all green.
- [ ] **Phase 5 (Business / Domain)** — `APPROVED`; Rules 3, 4, 6 satisfied; service contracts align with API DTOs.
- [ ] **Phase 6 (Frontend)** — `APPROVED`; Rules 1, 2, 3, 4, 5, 6, 7, 10 satisfied; Gates 7, 8, 9, 10, 11, 12, 15 satisfied.
- [ ] **Phase 7 (Other SME)** — `APPROVED`; project rules Observability + Explainability + Executive Presentation satisfied; ChatPanelComponent deviation documented in three places.
- [ ] **AAP § 0.8.6 Validation Framework** — every validation criterion verified end-to-end:
  - [ ] All five required modules (portfolio overview, holdings, transactions, analysis, AI chat) appear in catalog.
  - [ ] Adding a module from catalog places it on the canvas at the next available grid position.
  - [ ] Drag/resize visual update < 100 ms (Gate 7).
  - [ ] Layout saves to DB within 500 ms debounce (Gate 8).
  - [ ] `GET /api/v1/user/layout` p95 ≤ 300 ms; 401 unauthenticated (Gate 5).
  - [ ] `PATCH /api/v1/user/layout` returns 200 authenticated; 401 unauthenticated (Gate 6).
  - [ ] New user → blank canvas + auto-open catalog (Gate 9).
  - [ ] Returning user → saved layout hydrated on init (Gate 10).
  - [ ] Routing infrastructure preserved (Gate 11).
  - [ ] `npx nx build client && npx nx build api` zero errors (Gate 1).
  - [ ] Prisma migration runs without conflicts (Gate 4).
- [ ] **Authorization to open PR** — only after every checkbox above is `[x]` AND every domain phase status is `APPROVED`.

### Sign-off

| Field                        | Value                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| **Final verdict**            | `PENDING` (must resolve to `APPROVED` or `BLOCKED` — no qualifiers) |
| **Reviewer**                 | _to be assigned (Principal Reviewer)_                               |
| **Decision date**            | _to be set on phase exit_                                           |
| **Authorization to open PR** | _PENDING_                                                           |
| **Findings**                 | _to be populated by the Principal Reviewer_                         |

---

## Traceability Matrix

This matrix maps every AAP rule, project rule, and acceptance gate to its verifying phase(s) and the canonical evidence anchors.

### Rule → Verifying Phase(s)

| Rule (AAP § 0.8.1)                                                                   | Verifying Phase(s) |
| ------------------------------------------------------------------------------------ | ------------------ |
| **R1** — Module components MUST NOT import the grid layer                            | Phase 6            |
| **R2** — Grid state is the single source of truth for module positions and sizes     | Phase 6            |
| **R3** — Module registry is the only mechanism for adding modules                    | Phase 5, Phase 6   |
| **R4** — Persistence triggered exclusively by grid state events                      | Phase 5, Phase 6   |
| **R5** — Angular Router infrastructure preserved (single root route)                 | Phase 3, Phase 6   |
| **R6** — Modules declare minimum cell dimensions; engine enforces                    | Phase 5, Phase 6   |
| **R7** — Material 3 `var(--mat-sys-<token>, <fallback>)` pattern (Decision D-020)    | Phase 6            |
| **R8** — Layout endpoints protected by `AuthGuard('jwt')` + `HasPermissionGuard`     | Phase 2            |
| **R9** — `schema.prisma` located before migration; no conflicts with existing schema | Phase 1            |
| **R10** — Catalog auto-opens on first visit when no saved layout exists              | Phase 6            |

### Project Rule → Verifying Phase(s)

| Project Rule (AAP § 0.8.2)           | Verifying Phase(s)                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **§ 0.8.2.1 Observability**          | Phase 1 (metrics runtime), Phase 3 (metrics wiring + correlation-id), Phase 7 (runbook at `docs/observability/dashboard-layout.md`) |
| **§ 0.8.2.2 Explainability**         | Phase 7 (decision log appendix + traceability matrix at `docs/migrations/dashboard-traceability-matrix.md`)                         |
| **§ 0.8.2.3 Executive Presentation** | Phase 7 (`blitzy-deck/dashboard-refactor-deck.html`)                                                                                |
| **§ 0.8.2.4 Segmented PR Review**    | Phase 0 (this `CODE_REVIEW.md` artifact) + Phase 8 (final binary verdict)                                                           |

### Engineering Constraint → Verifying Phase(s)

| Engineering Constraint (AAP § 0.9.10)                      | Verifying Phase(s)                     |
| ---------------------------------------------------------- | -------------------------------------- |
| Module Isolation (Rule 1 of existing tech spec § 7.10)     | Phase 3 (backend), Phase 6 (frontend)  |
| JWT-Authoritative Identity (Rule 5)                        | Phase 2                                |
| Selector Naming Convention (`gf` prefix)                   | Phase 6                                |
| Persistence Restrictions (Decision D-002)                  | Phase 1, Phase 3                       |
| SSE Disconnection (Rule 6 — applies to ChatPanelComponent) | Phase 7 (deviation), Phase 6 (wrapper) |

### Gate → Verifying Phase(s)

| Gate                                                                            | Verifying Phase(s) |
| ------------------------------------------------------------------------------- | ------------------ |
| **Gate 1** — `npx nx build client && npx nx build api` zero errors              | Phase 1            |
| **Gate 2** — pre-existing tests pass (no regressions)                           | Phase 4            |
| **Gate 3** — new specs ≥ 80% line coverage                                      | Phase 4            |
| **Gate 4** — Prisma migration runs without conflicts                            | Phase 1            |
| **Gate 5** — `GET /api/v1/user/layout` 401 unauthenticated, 200 authenticated   | Phase 2, Phase 5   |
| **Gate 6** — `PATCH /api/v1/user/layout` 401 unauthenticated, 200 authenticated | Phase 2, Phase 5   |
| **Gate 7** — drag/resize < 100 ms                                               | Phase 6            |
| **Gate 8** — layout save < 500 ms debounce                                      | Phase 6            |
| **Gate 9** — new user blank canvas + auto-open catalog                          | Phase 6            |
| **Gate 10** — returning user saved layout hydrated                              | Phase 6            |
| **Gate 11** — routing infrastructure preserved                                  | Phase 3, Phase 6   |
| **Gate 12** — placement < 2×2 rejected                                          | Phase 6            |
| **Gate 13** — permissions ADMIN/USER only; DEMO/INACTIVE excluded               | Phase 2            |
| **Gate 14** — `correlation-id` header on every response; metrics registered     | Phase 1, Phase 3   |
| **Gate 15** — Material 3 var/fallback pattern in all SCSS                       | Phase 6            |

### Feature → Implementation Files

| Feature                           | Backend                                                                                                                                                                                                                                                                                                                                                                                                                                  | Frontend                                                                                                                                                                                                                                                         | Cross-cutting                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Modular Dashboard Canvas**      | —                                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/client/src/app/dashboard/dashboard-canvas/**`, `apps/client/src/app/dashboard/module-registry.service.ts`, `apps/client/src/app/dashboard/services/layout-persistence.service.ts`, `apps/client/src/app/dashboard/services/dashboard-telemetry.service.ts` | `apps/client/src/app/app.routes.ts` (single root route), `apps/client/src/app/app.component.{ts,html,scss}` (chrome removal), `apps/client/src/styles.scss` (NOT MODIFIED — gridster v21+ bundles CSS via `ViewEncapsulation.None`; see D-024), `package.json` + `package-lock.json` (gridster dep) |
| **Module Catalog**                | —                                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/client/src/app/dashboard/module-catalog/**`                                                                                                                                                                                                                | Decision log entry: MatDialog vs MatSidenav                                                                                                                                                                                                                                                         |
| **Module Wrappers**               | —                                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/client/src/app/dashboard/module-wrapper/**`, `apps/client/src/app/dashboard/modules/{portfolio-overview,holdings,transactions,analysis,chat}/**`                                                                                                           | Reuses existing presentation components and services; ChatPanelComponent deviation per § 0.7.2                                                                                                                                                                                                      |
| **Layout Persistence (server)**   | `apps/api/src/app/user/user-dashboard-layout.module.ts`, `apps/api/src/app/user/user-dashboard-layout.controller.ts`, `apps/api/src/app/user/user-dashboard-layout.service.ts`, `apps/api/src/app/user/dtos/{update-dashboard-layout,dashboard-layout}.dto.ts`, `prisma/schema.prisma` (model + back-relation), `prisma/migrations/<timestamp>_add_user_dashboard_layout/migration.sql`, `apps/api/src/app/app.module.ts` (registration) | `apps/client/src/app/dashboard/services/user-dashboard-layout.service.ts`, `apps/client/src/app/dashboard/interfaces/{dashboard-module,layout-data}.interface.ts`                                                                                                | `libs/common/src/lib/permissions.ts` (new permission constants), `docs/observability/dashboard-layout.md` (runbook)                                                                                                                                                                                 |
| **Documentation & Communication** | —                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                | `docs/observability/dashboard-layout.md`, `docs/decisions/agent-action-plan-decisions.md`, `docs/migrations/dashboard-traceability-matrix.md`, `blitzy-deck/dashboard-refactor-deck.html`, `README.md`, this `CODE_REVIEW.md`                                                                       |

---

## Status Legend

| Status     | Meaning                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PENDING`  | Phase has not yet been claimed by an Expert Agent. Initial state for all phases at the start of this review pass.                                                                                                        |
| `APPROVED` | Phase is fully reviewed and signed off; the next phase may begin. Per the Segmented PR Review rule, this is a binary, unqualified status.                                                                                |
| `BLOCKED`  | Review uncovered a blocking concern. Per the Segmented PR Review rule, a `BLOCKED` verdict on any phase returns the work item to code generation with a full restart from pre-flight (Phase 0). No qualifiers permitted. |

> **Per AAP § 0.8.2.4**, qualifiers such as "approved with concerns", "conditional approval", "approved pending", or "changes requested" are **NOT** permitted. Each phase resolves to exactly one of `PENDING`, `APPROVED`, or `BLOCKED`.

---

## Document History

| Version | Date       | Author                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0.0   | 2026-05-02 | Blitzy Code Generation Agent | **Initial creation** of this `CODE_REVIEW.md` for the Modular Dashboard Refactor review pass 1, per AAP § 0.6.1.9 and AAP § 0.7.1.5 (Segmented PR Review project rule, AAP § 0.8.2.4). All nine phase statuses (Phase 0 + Phases 1–8) initialized to `PENDING`. This artifact is the canonical review record for the Modular Dashboard Refactor work item and supersedes any prior content at this path; no prior review pass confers approval credit to this pass. |
| _next_  | _TBD_      | _Phase 0 Reviewer_           | _Phase 0 sign-off — flip status to `APPROVED` or `BLOCKED`._                                                                                                                                                                                                                                                                                                                                                                                                        |
| _next_  | _TBD_      | _Phase 1 Reviewer_           | _Phase 1 sign-off._                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| _next_  | _TBD_      | _Phase 2 Reviewer_           | _Phase 2 sign-off._                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| _next_  | _TBD_      | _Phase 3 Reviewer_           | _Phase 3 sign-off._                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| _next_  | _TBD_      | _Phase 4 Reviewer_           | _Phase 4 sign-off._                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| _next_  | _TBD_      | _Phase 5 Reviewer_           | _Phase 5 sign-off._                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| _next_  | _TBD_      | _Phase 6 Reviewer_           | _Phase 6 sign-off._                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| _next_  | _TBD_      | _Phase 7 Reviewer_           | _Phase 7 sign-off._                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| _next_  | _TBD_      | _Principal Reviewer_         | _Phase 8 final binary verdict — `APPROVED` or `BLOCKED`. Authorization to open PR set accordingly._                                                                                                                                                                                                                                                                                                                                                                 |
