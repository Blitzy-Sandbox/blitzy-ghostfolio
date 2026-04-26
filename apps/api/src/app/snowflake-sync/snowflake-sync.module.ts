import { MetricsModule } from '@ghostfolio/api/app/metrics/metrics.module';
import { PortfolioModule } from '@ghostfolio/api/app/portfolio/portfolio.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SnowflakeClientFactory } from './snowflake-client.factory';
import { SnowflakeSyncController } from './snowflake-sync.controller';
import { SnowflakeSyncService } from './snowflake-sync.service';

/**
 * `SnowflakeSyncModule` — NestJS feature module that wires the Snowflake
 * Sync layer (Feature A, AAP § 0.1.1) into the application's
 * dependency-injection graph.
 *
 * Composition (AAP § 0.5.1.1):
 *
 * - **Controllers:** `SnowflakeSyncController` — admin-only HTTP entry
 *   point at `POST /api/v1/snowflake-sync/trigger` for out-of-cycle
 *   manual syncs. The controller itself is intentionally thin
 *   (Rule 8, AAP § 0.7.1.8) and delegates to `SnowflakeSyncService`.
 *
 * - **Providers:** `SnowflakeClientFactory` and `SnowflakeSyncService`.
 *   The factory wraps `snowflake-sdk.createConnection({...})` reading
 *   the six `SNOWFLAKE_*` env vars exclusively through the injected
 *   `ConfigService` (Rule 3, AAP § 0.7.1.3). The service implements
 *   the daily cron, the `PortfolioChangedEvent` listener, the
 *   parameterized MERGE-based mirror routines (Rules 2 and 7,
 *   AAP § 0.7.1.2 and § 0.7.1.7), and the read-only `queryHistory`
 *   surface consumed by the chat-agent's `query_history` tool
 *   (AAP § 0.5.1.5).
 *
 * - **Exports:** `SnowflakeClientFactory` and `SnowflakeSyncService`.
 *   The factory is exported so the new `SnowflakeHealthIndicator`
 *   (registered additively in `HealthModule` per AAP § 0.5.1.2) can
 *   inject it directly to issue a lightweight `SELECT 1` probe at
 *   `/api/v1/health/snowflake` without depending on the heavier
 *   service. The service is exported so `AiChatModule` can inject it
 *   for the `query_history` chat-agent tool dispatch (AAP § 0.5.1.5)
 *   and so `RebalancingModule` can use it for historical context
 *   (AAP § 0.4.1.2 and § 0.1.3).
 *
 * - **Imports:**
 *   * `ConfigModule` — required for `ConfigService` injection into
 *     `SnowflakeClientFactory`. Ghostfolio's `app.module.ts` calls
 *     `ConfigModule.forRoot()` WITHOUT `isGlobal: true`, so child
 *     modules that consume `ConfigService` must explicitly re-import
 *     `ConfigModule` to bring it into local DI scope (per the NestJS
 *     `@nestjs/config` documentation).
 *   * `MetricsModule` — required for `MetricsService` injection into
 *     `SnowflakeSyncService`. The service emits per-sync counter and
 *     latency-histogram metrics (`snowflake_sync_runs_total`,
 *     `snowflake_sync_latency_seconds`) operationalizing the
 *     project-level Observability rule (AAP § 0.7.2). `MetricsModule`
 *     is NOT a global module, so this explicit import is mandatory.
 *   * `PortfolioModule` — exports `PortfolioService`, which
 *     `SnowflakeSyncService` injects to compute the
 *     `portfolio_snapshots` and `performance_metrics` rows mirrored
 *     to Snowflake. `PortfolioService` is the only legitimate
 *     cross-module access channel for portfolio data per Rule 1
 *     (AAP § 0.7.1.1).
 *   * `PrismaModule` — exports `PrismaService`, which
 *     `SnowflakeSyncService` injects to enumerate user IDs for the
 *     daily cron and to read `Order` rows for the orders mirror.
 *
 * Module-isolation posture (Rule 1, AAP § 0.7.1.1): every
 * cross-module dependency resolves through a public `exports` array
 * — no import path in this file or any sibling reaches into another
 * feature module's directory. The two cross-module consumers
 * (`AiChatModule` and `RebalancingModule`) likewise consume this
 * module's exported services exclusively through this module's
 * `exports` array.
 *
 * Schedule and event-bus infrastructure (`@nestjs/schedule`'s
 * `SchedulerRegistry` and `@nestjs/event-emitter`'s `EventEmitter2`)
 * are intentionally NOT re-imported here. Both are registered
 * globally at the application root via `ScheduleModule.forRoot()`
 * (`apps/api/src/app/app.module.ts` line 133) and
 * `EventEmitterModule.forRoot()` (line 130), so the `@Cron` and
 * `@OnEvent` decorators on `SnowflakeSyncService` are wired by the
 * root-registered providers without any local module declaration.
 */
@Module({
  controllers: [SnowflakeSyncController],
  exports: [SnowflakeClientFactory, SnowflakeSyncService],
  imports: [ConfigModule, MetricsModule, PortfolioModule, PrismaModule],
  providers: [SnowflakeClientFactory, SnowflakeSyncService]
})
export class SnowflakeSyncModule {}
