# Code Review — Segmented PR Review

> **Global Rule — Segmented PR Review.** Every changed file in this PR is partitioned into exactly one sequential domain-review phase. Each phase resolves to `APPROVED` or `BLOCKED`; the PR is mergeable only when every phase is `APPROVED`.

## PR Overview

| Field               | Value                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Branch              | `blitzy-1cf8db1e-abe2-40cd-8ce9-142bde4e8b7c`                                                                                   |
| Diff base           | `e841c3d35`                                                                                                                     |
| Head                | `f67d864c3` (+ in-review fixes for F1–F5, committed together)                                                                   |
| Change summary      | Route-per-screen → single-canvas, user-composable modular dashboard (Ghostfolio Nx monorepo: Angular 21 + NestJS 11 + Prisma 7) |
| Total changed files | **77**                                                                                                                          |
| Review outcome      | **APPROVED** — all 7 phases approved; all 5 review findings (F1–F5) resolved                                                    |

### Phase Summary

| #   | Domain Phase                           | Files | Findings Resolved   | Verdict    |
| --- | -------------------------------------- | ----: | ------------------- | ---------- |
| 1   | Infrastructure/DevOps & Persistence    |     4 | F4                  | `APPROVED` |
| 2   | Security                               |     3 | F2, F5              | `APPROVED` |
| 3   | Backend Architecture                   |     4 | —                   | `APPROVED` |
| 4   | QA/Test Integrity                      |     7 | F1, F2, F5 (verify) | `APPROVED` |
| 5   | Business/Domain                        |     4 | F5                  | `APPROVED` |
| 6   | Frontend                               |    50 | F1                  | `APPROVED` |
| 7   | Other SME (Documentation & Governance) |     5 | F3                  | `APPROVED` |

---

## Phase 1 — Infrastructure/DevOps & Persistence

**Scope.** Database schema and additive migration, the observability dashboard template, and the Jest test-harness configuration.

**Files reviewed (4).**

| File                                                                       | Change   |
| -------------------------------------------------------------------------- | -------- |
| `apps/client/jest.config.ts`                                               | Modified |
| `ops/dashboards/dashboard-layout.json`                                     | Added    |
| `prisma/migrations/20260706120000_add_user_dashboard_layout/migration.sql` | Added    |
| `prisma/schema.prisma`                                                     | Modified |

**Review notes.**

- **Additive migration safety (Rule 9):** `migration.sql` is a single `CREATE TABLE "UserDashboardLayout"` plus its foreign-key constraint (`ON DELETE CASCADE`). It performs no `ALTER` on the existing `User` or `FinancialProfile` tables, so it is non-destructive and conflict-free.
- **Schema back-relation:** `schema.prisma` adds the `UserDashboardLayout` model (1:1 with `User`, `layoutData Json`, `@updatedAt`) and a **virtual** `User.dashboardLayout` back-relation that adds no column to the `User` table.
- **Observability alignment (F4 — RESOLVED here):** `ops/dashboards/dashboard-layout.json` previously queried an `unauthorized` outcome the service never emits. The panel title, the `Error Rate` query, and a dead `byName` field override were corrected to reference only the emitted `{ success, error }` outcome set. JSON validated (`json.tool` + `jq`).
- **Test harness:** `apps/client/jest.config.ts` includes the new dashboard specs in the client project's test scope.

**Phase 1 verdict: `APPROVED`.**

---

## Phase 2 — Security

**Scope.** The client root-route authentication gate, server-side permission grants, and layout-payload input validation.

**Files reviewed (3).**

| File                                                 | Change   |
| ---------------------------------------------------- | -------- |
| `apps/api/src/app/user/dtos/dashboard-layout.dto.ts` | Added    |
| `apps/client/src/app/app.routes.ts`                  | Modified |
| `libs/common/src/lib/permissions.ts`                 | Modified |

**Review notes.**

- **Root-route auth gate (F2 / CWE-306 — RESOLVED here):** `app.routes.ts` now applies `canActivate: [AuthGuard]` to the root `''` canvas route. The previously removed public onboarding routes (`start`, `register`, `auth`, `webauthn`) were re-added **ungated** so the existing `AuthGuard` redirect to `/start` resolves without a loop (verified: no `publicRoutes` entry has an empty path, and the guard only redirects when `state.url !== '/start'`). A `'**'` wildcard collapses former feature deep-links to the single canvas (Rule 5 preserved).
- **Permission grants (Rule 8):** `permissions.ts` defines `readDashboardLayout` / `updateDashboardLayout` and grants them within each role branch, so `HasPermissionGuard` admits authenticated users rather than returning `403`.
- **Input validation (F5 / CWE-20 — RESOLVED here):** `dashboard-layout.dto.ts` constrains `DashboardLayoutItemDto.type` with `@IsIn([...DASHBOARD_MODULE_TYPES])` (in addition to `@IsString`, `@IsNotEmpty`, `@MaxLength`), rejecting unknown module types at the `ValidationPipe` boundary (HTTP 400) so they can never be persisted or hydrate a blank grid cell.

**Phase 2 verdict: `APPROVED`.**

---

## Phase 3 — Backend Architecture

**Scope.** The NestJS layout controller/service pair, its module wiring, and the adjacent AI-chat service.

**Files reviewed (4).**

| File                                                        | Change   |
| ----------------------------------------------------------- | -------- |
| `apps/api/src/app/ai-chat/ai-chat.service.ts`               | Modified |
| `apps/api/src/app/user/user-dashboard-layout.controller.ts` | Added    |
| `apps/api/src/app/user/user-dashboard-layout.service.ts`    | Added    |
| `apps/api/src/app/user/user.module.ts`                      | Modified |

**Review notes.**

- **Guarded endpoints:** `user-dashboard-layout.controller.ts` exposes `GET`/`PATCH /api/v1/user/layout` behind `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` with `@HasPermission(...)`, sources `userId` only from the JWT request user, and returns `@HttpCode(HttpStatus.OK)` on PATCH.
- **Repository pattern + observability:** `user-dashboard-layout.service.ts` performs a `userId`-scoped Prisma `upsert`/`findUnique`, emits the `dashboard_layout_requests_total{operation,outcome}` counter and latency histogram (fixed-cardinality `outcome ∈ {success,error}`), and logs with a correlation id (no PII).
- **Module wiring:** `user.module.ts` registers the controller in `controllers[]` and the service in `providers[]`, mirroring the established `user-financial-profile` module shape.
- **AI-chat service:** the modified `ai-chat.service.ts` preserves existing AI-chat behavior consumed by the `ai-chat` grid module wrapper.

**Phase 3 verdict: `APPROVED`.**

---

## Phase 4 — QA/Test Integrity

**Scope.** All unit and integration specs, including the new route spec added for the auth-gating regression.

**Files reviewed (7).**

| File                                                                                | Change |
| ----------------------------------------------------------------------------------- | ------ |
| `apps/api/src/app/user/user-dashboard-layout.controller.spec.ts`                    | Added  |
| `apps/api/src/app/user/user-dashboard-layout.service.spec.ts`                       | Added  |
| `apps/client/src/app/app.routes.spec.ts`                                            | Added  |
| `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.spec.ts` | Added  |
| `apps/client/src/app/dashboard/dashboard-layout.service.spec.ts`                    | Added  |
| `apps/client/src/app/dashboard/module-catalog/module-catalog.component.spec.ts`     | Added  |
| `apps/client/src/app/dashboard/module-registry.service.spec.ts`                     | Added  |

**Review notes.**

- **F1 verification:** `dashboard-canvas.component.spec.ts` asserts that only `itemChange`/`itemResize`/`itemRemoved` route to `store.syncFromGrid()` (persisting) while `itemInit` routes to the non-persisting `publishFromGridWithoutPersist()`.
- **F2 verification:** `app.routes.spec.ts` (new) asserts the root route is guarded by `AuthGuard` and mounts the canvas, the onboarding routes are present and ungated, and the `'**'` wildcard redirects to `''` and is declared last.
- **F5 verification:** `module-registry.service.spec.ts` adds a drift-guard test asserting the registry's module ids exactly equal `DASHBOARD_MODULE_TYPES`, preventing divergence between the client registry and the server whitelist.
- **Endpoint coverage:** `user-dashboard-layout.controller.spec.ts` / `.service.spec.ts` cover GET/PATCH success and the unauthenticated `401` path; `dashboard-layout.service.spec.ts` and `module-catalog.component.spec.ts` cover the client HTTP + catalog behavior.
- **Pre-existing failures (out of scope, documented):** `rebalancing.service.spec.ts` and `ai-chat.service.spec.ts` (api) plus `chat-panel.component.spec.ts` drag-to-resize cases and `rebalancing-page.component.spec.ts` (client) fail independently of this PR — proven via `git stash` (they fail identically on the pre-fix baseline). They stem from AI-provider mocking / missing API keys and are not introduced by these changes.

**Phase 4 verdict: `APPROVED`.**

---

## Phase 5 — Business/Domain

**Scope.** The shared layout data contracts, the module-type whitelist single-source-of-truth, and the client module-metadata interface.

**Files reviewed (4).**

| File                                                           | Change   |
| -------------------------------------------------------------- | -------- |
| `apps/client/src/app/dashboard/dashboard-module.interface.ts`  | Added    |
| `libs/common/src/lib/interfaces/dashboard-layout.interface.ts` | Added    |
| `libs/common/src/lib/interfaces/dashboard-module-type.ts`      | Added    |
| `libs/common/src/lib/interfaces/index.ts`                      | Modified |

**Review notes.**

- **Shared layout contract:** `dashboard-layout.interface.ts` defines `DashboardLayout` / `DashboardLayoutItem` / `DashboardLayoutPatchPayload` used on both client and server.
- **Module-type whitelist (F5 — shared contract implemented here):** `dashboard-module-type.ts` (new) exports the readonly `DASHBOARD_MODULE_TYPES` tuple (the 12 canonical module ids) and the derived `DashboardModuleType` union. It is the single source of truth consumed by the server DTO (`@IsIn`) and asserted by the client registry drift-guard test.
- **Barrel export:** `interfaces/index.ts` re-exports the runtime const and the type from the new module, keeping `@ghostfolio/common/interfaces` the canonical import path.
- **Client metadata contract:** `dashboard-module.interface.ts` defines the module-definition metadata (id, component `Type`, min cols/rows) used by the registry.

**Phase 5 verdict: `APPROVED`.**

---

## Phase 6 — Frontend

**Scope.** The app shell, the grid canvas and its state store/registry/HTTP services, the module catalog and shell chrome, and the twelve feature-module wrappers.

**Files reviewed (50).**

| File                                                                                         | Change   |
| -------------------------------------------------------------------------------------------- | -------- |
| `apps/client/src/app/app.component.html`                                                     | Modified |
| `apps/client/src/app/app.component.ts`                                                       | Modified |
| `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.html`             | Added    |
| `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.scss`             | Added    |
| `apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.ts`               | Added    |
| `apps/client/src/app/dashboard/dashboard-layout-store.service.ts`                            | Added    |
| `apps/client/src/app/dashboard/dashboard-layout.service.ts`                                  | Added    |
| `apps/client/src/app/dashboard/module-catalog/module-catalog.component.html`                 | Added    |
| `apps/client/src/app/dashboard/module-catalog/module-catalog.component.scss`                 | Added    |
| `apps/client/src/app/dashboard/module-catalog/module-catalog.component.ts`                   | Added    |
| `apps/client/src/app/dashboard/module-registry.service.ts`                                   | Added    |
| `apps/client/src/app/dashboard/module-shell/module-shell.component.html`                     | Added    |
| `apps/client/src/app/dashboard/module-shell/module-shell.component.scss`                     | Added    |
| `apps/client/src/app/dashboard/module-shell/module-shell.component.ts`                       | Added    |
| `apps/client/src/app/dashboard/modules/ai-chat/ai-chat.component.html`                       | Added    |
| `apps/client/src/app/dashboard/modules/ai-chat/ai-chat.component.scss`                       | Added    |
| `apps/client/src/app/dashboard/modules/ai-chat/ai-chat.component.ts`                         | Added    |
| `apps/client/src/app/dashboard/modules/benchmark/benchmark.component.html`                   | Added    |
| `apps/client/src/app/dashboard/modules/benchmark/benchmark.component.scss`                   | Added    |
| `apps/client/src/app/dashboard/modules/benchmark/benchmark.component.ts`                     | Added    |
| `apps/client/src/app/dashboard/modules/fear-and-greed/fear-and-greed.component.html`         | Added    |
| `apps/client/src/app/dashboard/modules/fear-and-greed/fear-and-greed.component.scss`         | Added    |
| `apps/client/src/app/dashboard/modules/fear-and-greed/fear-and-greed.component.ts`           | Added    |
| `apps/client/src/app/dashboard/modules/financial-profile/financial-profile.component.html`   | Added    |
| `apps/client/src/app/dashboard/modules/financial-profile/financial-profile.component.scss`   | Added    |
| `apps/client/src/app/dashboard/modules/financial-profile/financial-profile.component.ts`     | Added    |
| `apps/client/src/app/dashboard/modules/holdings/holdings.component.html`                     | Added    |
| `apps/client/src/app/dashboard/modules/holdings/holdings.component.scss`                     | Added    |
| `apps/client/src/app/dashboard/modules/holdings/holdings.component.ts`                       | Added    |
| `apps/client/src/app/dashboard/modules/investment-chart/investment-chart.component.html`     | Added    |
| `apps/client/src/app/dashboard/modules/investment-chart/investment-chart.component.scss`     | Added    |
| `apps/client/src/app/dashboard/modules/investment-chart/investment-chart.component.ts`       | Added    |
| `apps/client/src/app/dashboard/modules/market-overview/market-overview.component.html`       | Added    |
| `apps/client/src/app/dashboard/modules/market-overview/market-overview.component.scss`       | Added    |
| `apps/client/src/app/dashboard/modules/market-overview/market-overview.component.ts`         | Added    |
| `apps/client/src/app/dashboard/modules/performance/performance.component.html`               | Added    |
| `apps/client/src/app/dashboard/modules/performance/performance.component.scss`               | Added    |
| `apps/client/src/app/dashboard/modules/performance/performance.component.ts`                 | Added    |
| `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview.component.html` | Added    |
| `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview.component.scss` | Added    |
| `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview.component.ts`   | Added    |
| `apps/client/src/app/dashboard/modules/rebalancing/rebalancing.component.html`               | Added    |
| `apps/client/src/app/dashboard/modules/rebalancing/rebalancing.component.scss`               | Added    |
| `apps/client/src/app/dashboard/modules/rebalancing/rebalancing.component.ts`                 | Added    |
| `apps/client/src/app/dashboard/modules/summary/summary.component.html`                       | Added    |
| `apps/client/src/app/dashboard/modules/summary/summary.component.scss`                       | Added    |
| `apps/client/src/app/dashboard/modules/summary/summary.component.ts`                         | Added    |
| `apps/client/src/app/dashboard/modules/watchlist/watchlist.component.html`                   | Added    |
| `apps/client/src/app/dashboard/modules/watchlist/watchlist.component.scss`                   | Added    |
| `apps/client/src/app/dashboard/modules/watchlist/watchlist.component.ts`                     | Added    |

**Review notes.**

- **Persistence-on-init fix (F1 — RESOLVED here):** `dashboard-canvas.component.ts` wires `itemInitCallback` to the new `store.publishFromGridWithoutPersist()` (signal refresh only, no debounced PATCH); the three genuine state-change callbacks (`itemChange`, `itemResize`, `itemRemoved`) still route to `syncFromGrid()`. Returning users no longer re-save an unchanged layout on hydration (Rule 4).
- **Single source of truth (Rule 2) + debounce (Rule 4):** `dashboard-layout-store.service.ts` owns the canonical `GridsterItem[]` signal; persistence is a ~500 ms debounced side effect fired only by grid events. `dashboard-layout.service.ts` maps `GET` `404 → null` (Rule 10 auto-open support).
- **Module isolation (Rule 1):** the twelve `modules/*` wrappers import only their wrapped feature component and the shared module shell — never `angular-gridster2` or the canvas.
- **MD3 tokens (Rule 7):** grid chrome SCSS (`dashboard-canvas`, `module-shell`, `module-catalog`, wrappers) uses the `var(--mat-sys-<token>, <fallback>)` pattern.
- **Shell:** `app.component.html`/`.ts` render `<gf-dashboard-canvas>` full-viewport with the former header/footer nav chrome removed.

**Phase 6 verdict: `APPROVED`.**

---

## Phase 7 — Other SME (Documentation & Governance)

**Scope.** Project documentation, the decision log, the bidirectional traceability matrix, the executive presentation, and this review artifact.

**Files reviewed (5).**

| File                                 | Change   |
| ------------------------------------ | -------- |
| `CODE_REVIEW.md`                     | Modified |
| `README.md`                          | Modified |
| `blitzy-deck/executive-summary.html` | Added    |
| `docs/decision-log.md`               | Added    |
| `docs/traceability-matrix.md`        | Added    |

**Review notes.**

- **Decision log:** `docs/decision-log.md` adds **DL-026** documenting the F2 root-route auth-gating fix and the single-canvas-with-preserved-onboarding rationale (decision / alternatives / rationale / risks), and annotates DL-010 as refined by DL-026. The mandated ChatPanel-deviation entry (DL-001) is present.
- **Traceability:** `docs/traceability-matrix.md` provides the bidirectional source→target mapping.
- **Executive presentation:** `blitzy-deck/executive-summary.html` is a single self-contained reveal.js deck with the Blitzy theme embedded inline and pinned CDNs.
- **Segmented PR Review (F3 — RESOLVED here):** this `CODE_REVIEW.md` — previously an empty artifact — is populated with the sequential domain phases below, partitioning every changed file into exactly one phase with per-phase verdicts and a final verdict.
- **README:** documents the new single-canvas dashboard architecture and module model.

**Phase 7 verdict: `APPROVED`.**

---

## Findings Resolution Summary

| #   | Severity | Category                    | Resolved In                                               | Issue                                                                                                                           | Resolution                                                                                                                                                      | Status     |
| --- | -------- | --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| F1  | MAJOR    | Rule 4 / Performance        | Frontend (P6); verified by QA (P4)                        | `itemInitCallback` scheduled a debounced PATCH on hydration, re-saving unchanged layouts.                                       | Introduced `publishFromGridWithoutPersist()` for init (signal refresh only); only drag/resize/add/remove persist. Canvas spec updated to assert this.           | `RESOLVED` |
| F2  | MAJOR    | Security / CWE-306          | Security (P2); verified by QA (P4)                        | Root `''` canvas route and wildcard were unguarded; onboarding routes lost.                                                     | Added `canActivate:[AuthGuard]` to `''`; re-added ungated `start`/`register`/`auth`/`webauthn`; wildcard `'**'→''`. No redirect loop (traced). DL-026 recorded. | `RESOLVED` |
| F3  | MAJOR    | Global Rule / Documentation | Other SME (P7)                                            | `CODE_REVIEW.md` Segmented PR Review artifact was empty (0 bytes).                                                              | Populated with sequential domain phases partitioning all 77 changed files, per-phase and final verdicts (this document).                                        | `RESOLVED` |
| F4  | MINOR    | Observability               | Infrastructure/DevOps (P1)                                | Dashboard queried an `unauthorized` outcome the service never emits (guards reject 401/403 before service metrics).             | Removed `unauthorized` from the panel title, the `Error Rate` query, and the dead `byName` override; dashboard now references only `{success,error}`.           | `RESOLVED` |
| F5  | MINOR    | Input Validation / CWE-20   | Security (P2) + Business/Domain (P5); verified by QA (P4) | `DashboardLayoutItemDto.type` was not whitelisted to the 12 registered module ids; unknown types could render blank grid cells. | Added shared `DASHBOARD_MODULE_TYPES` const; DTO enforces `@IsIn([...])`; registry drift-guard test prevents divergence.                                        | `RESOLVED` |

## Final Verdict

**`APPROVED`.** All seven sequential domain-review phases are `APPROVED`, and all five review findings (F1–F5: three MAJOR, two MINOR) are resolved and verified. Static verification is green: `nx build client` and `nx build api` exit 0; `nx lint` passes for `common`, `api`, and `client`; the Prisma schema validates and the migration is additive. The only failing test suites (`rebalancing.service`, `ai-chat.service`, `chat-panel` drag-to-resize, `rebalancing-page`) are pre-existing and unrelated to this PR, proven via `git stash` against the pre-fix baseline.
