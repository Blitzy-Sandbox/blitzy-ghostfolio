import { MetricsModule } from '@ghostfolio/api/app/metrics/metrics.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import { Module } from '@nestjs/common';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * `UserDashboardLayoutModule` is the NestJS feature module that owns the
 * per-user `UserDashboardLayout` HTTP API introduced by AAP § 0.1.1 to power
 * the modular dashboard refactor. It mounts the two HTTP endpoints
 *
 *     GET   /api/v1/user/layout
 *     PATCH /api/v1/user/layout
 *
 * via `UserDashboardLayoutController`, persists data through
 * `UserDashboardLayoutService` (the single canonical idempotent
 * `findByUserId` / `upsertForUser` access path for `UserDashboardLayout`
 * rows per Decision D-019), and is wired into the application root via the
 * `imports` array of `apps/api/src/app/app.module.ts` adjacent to
 * `UserFinancialProfileModule` per AAP § 0.4.1.1 / § 0.6.1.3.
 *
 * STRUCTURAL TEMPLATE (AAP § 0.6.1.3): This module replicates
 * `apps/api/src/app/user-financial-profile/user-financial-profile.module.ts`
 * verbatim with one additive difference — `MetricsModule` is added to the
 * `imports` array because `UserDashboardLayoutService` emits Prometheus
 * counters and a latency histogram (whereas `UserFinancialProfileService`
 * does not). The decorator-key ordering (`controllers` → `exports` →
 * `imports` → `providers`) matches the established alphabetical convention
 * in the source template.
 *
 * RULE 1 (Module Isolation, AAP § 0.8.1.1):
 * `UserDashboardLayoutService` is intentionally re-listed in the `exports`
 * array so that future feature modules — for example, an account-deletion
 * service that must purge the per-user layout row, or a future analytics
 * module that reads the persisted layout — can resolve it via NestJS's DI
 * container WITHOUT importing the service file by direct path. AAP § 0.6.1.3
 * names this exported service as the canonical re-use surface: it is the
 * only provider of this module that is exposed outside of it. The
 * `UserDashboardLayoutController` is intentionally NOT exported — it is an
 * HTTP transport boundary, never a callable dependency of another module.
 *
 * GLOBAL SCOPE: This module is deliberately NOT decorated with `@Global()`.
 * AAP § 0.8.1.1 (Rule 1) requires consumer modules to explicitly import
 * `UserDashboardLayoutModule` so the cross-module dependency edge is
 * visible in the Nx project graph and ESLint module-boundary checks.
 * Making the module global would silently expose the service everywhere
 * and obscure the dependency contract.
 *
 * SCOPE: The provider is registered with NestJS's default singleton scope,
 * so `UserDashboardLayoutService` resolves to a single shared instance
 * across `UserDashboardLayoutController` (in this module) and any future
 * cross-module consumer. All consumers therefore share the same
 * `PrismaService` connection pool and `MetricsService` registry
 * transitively.
 *
 * IMPORTS:
 *   * `MetricsModule` — required for `MetricsService` injection into
 *     `UserDashboardLayoutService`. The service emits the four named
 *     Prometheus metrics (`dashboard_layout_get_total{outcome}`,
 *     `dashboard_layout_patch_total{outcome}`,
 *     `dashboard_layout_save_failures_total{reason}`, and the
 *     `dashboard_layout_request_duration_seconds{method}` histogram)
 *     mandated by AAP § 0.6.1.10 and AAP § 0.8.2.1 (project-level
 *     Observability rule). `MetricsModule` is NOT decorated with
 *     `@Global()`, so this explicit import is mandatory — verified
 *     against `apps/api/src/app/metrics/metrics.module.ts`. Cross-
 *     references for the import path: `apps/api/src/app/snowflake-sync/
 *     snowflake-sync.module.ts:1`, `apps/api/src/app/ai-chat/
 *     ai-chat.module.ts`, and `apps/api/src/app/rebalancing/
 *     rebalancing.module.ts` all use the identical alias path.
 *   * `PrismaModule` — required for `PrismaService` injection into
 *     `UserDashboardLayoutService`. The service issues
 *     `prisma.userDashboardLayout.findUnique` (read path) and
 *     `prisma.userDashboardLayout.upsert` (idempotent write path per
 *     Decision D-019) against the new `UserDashboardLayout` Prisma model
 *     introduced by AAP § 0.6.1.1. Cross-reference for the import path:
 *     `apps/api/src/app/user-financial-profile/
 *     user-financial-profile.module.ts:1` (the structural template).
 *
 * INDEPENDENCE FROM `UserModule`: This module is INTENTIONALLY independent
 * of the existing `apps/api/src/app/user/user.module.ts`. The existing
 * `UserModule` owns the user-identity / settings / signup flow and is
 * byte-identical to source per the AAP boundaries. Co-locating the new
 * file under `apps/api/src/app/user/` is a directory-organization choice
 * (the route prefix is `user/layout`) — it does NOT imply any DI-graph
 * coupling between the two modules. Consequently, NO `import` statement
 * in this file references `./user.module`, `./user.service`, or
 * `./user.controller`.
 *
 * AAP CROSS-REFERENCES:
 *   - AAP § 0.4.1.1: `app.module.ts` registers this module adjacent to
 *     `UserFinancialProfileModule` (separate file, owned by sibling agent).
 *   - AAP § 0.6.1.3: file-by-file plan listing this module's composition.
 *   - AAP § 0.6.1.10: observability metrics emitted by the service —
 *     justifies the `MetricsModule` import.
 *   - AAP § 0.7.1.1: in-scope new files inventory.
 *   - AAP § 0.8.1.1 (Rule 1, Module Isolation): non-`@Global()` posture,
 *     exports limited to `UserDashboardLayoutService`.
 *   - AAP § 0.8.2.1 (Observability rule): Prometheus metrics requirement.
 *   - Decision D-019 (Idempotent PATCH via upsert): the exported service
 *     is the canonical idempotent upsert path; future consumer modules
 *     should inject it via DI rather than construct their own Prisma
 *     queries.
 */
@Module({
  controllers: [UserDashboardLayoutController],
  exports: [UserDashboardLayoutService],
  imports: [MetricsModule, PrismaModule],
  providers: [UserDashboardLayoutService]
})
export class UserDashboardLayoutModule {}
