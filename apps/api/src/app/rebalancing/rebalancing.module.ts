import { AiProviderModule } from '@ghostfolio/api/app/ai-provider/ai-provider.module';
import { MetricsModule } from '@ghostfolio/api/app/metrics/metrics.module';
import { PortfolioModule } from '@ghostfolio/api/app/portfolio/portfolio.module';
import { SnowflakeSyncModule } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.module';
import { UserFinancialProfileModule } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.module';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RebalancingController } from './rebalancing.controller';
import { RebalancingService } from './rebalancing.service';

/**
 * `RebalancingModule` is the NestJS feature module that wires **Feature C —
 * Explainable Rebalancing Engine** (AAP § 0.1.1, § 0.5.1.1, § 0.7.5.2) into
 * the application's dependency-injection graph. It mounts the non-streaming
 * JSON HTTP entry point
 *
 *     POST /api/v1/ai/rebalancing
 *
 * via `RebalancingController` and orchestrates the Anthropic SDK
 * `messages.create({...})` call with a forced `tool_use` content block
 * through `RebalancingService`. The module is wired into the application
 * root via the `imports` array of `apps/api/src/app/app.module.ts` per
 * AAP § 0.4.1.1.
 *
 * Composition (AAP § 0.5.1.1):
 *
 * - **Controllers:** `RebalancingController` — the single `@Post()` JSON
 *   endpoint. Per Rule 8 (Controller Thinness, AAP § 0.7.1.8) the
 *   controller body only generates a per-request correlationId, extracts
 *   the JWT-verified user id, and delegates to
 *   `RebalancingService.recommend({...})`.
 *
 * - **Providers:** `RebalancingService` — the core service that
 *   constructs the Anthropic SDK client (Rule 3, AAP § 0.7.1.3),
 *   builds personalized prompts from live portfolio + financial profile
 *   + Snowflake historical data, defines the single
 *   `rebalancing_recommendations` tool schema (whose `input_schema`
 *   mirrors the AAP § 0.1.2.4 contract), forces the tool invocation via
 *   `tool_choice`, and reads structured output EXCLUSIVELY from the
 *   `tool_use` content block (Rule 4, AAP § 0.7.1.4 — central to this
 *   feature).
 *
 * - **Exports:** None. `RebalancingModule` is a pure leaf module — its
 *   service is consumed only by its own controller and is not required
 *   by any other feature module per the AAP architecture.
 *
 * - **Imports:**
 *   * `ConfigModule` — required for `ConfigService` injection into
 *     `RebalancingService`. Ghostfolio's `app.module.ts` calls
 *     `ConfigModule.forRoot()` WITHOUT `isGlobal: true`, so child
 *     modules that consume `ConfigService` must explicitly re-import
 *     `ConfigModule` to bring it into local DI scope.
 *   * `MetricsModule` — exports `MetricsService`, which
 *     `RebalancingService` injects to emit per-request outcome counter
 *     (`rebalancing_requests_total{outcome}`) and end-to-end latency
 *     histogram (`rebalancing_latency_seconds`), operationalizing the
 *     project-level Observability rule (AAP § 0.7.2).
 *   * `PortfolioModule` — exports `PortfolioService`, which
 *     `RebalancingService` injects to read the current allocation
 *     snapshot via the existing `PortfolioService.getDetails(...)`
 *     public method. Per Rule 1 (AAP § 0.7.1.1) this is the only
 *     legitimate cross-module access channel for portfolio data.
 *   * `SnowflakeSyncModule` — exports `SnowflakeSyncService`, which
 *     `RebalancingService` injects to enrich the prompt with up to
 *     90 days of historical `portfolio_snapshots` allocation drift via
 *     parameterized `SnowflakeSyncService.queryHistory(...)` calls
 *     (Rule 2 compliant — AAP § 0.7.1.2).
 *   * `UserFinancialProfileModule` — exports
 *     `UserFinancialProfileService`, which `RebalancingService` injects
 *     to read the persisted goals (`investmentGoals`,
 *     `retirementTargetAge`, etc.) referenced by every recommendation's
 *     `goalReference` field (AAP § 0.1.2.4). This is the
 *     `UserFinancialProfileService` cross-module exception explicitly
 *     called out in AAP § 0.1.2.1.
 *
 * Module-isolation posture (Rule 1, AAP § 0.7.1.1): every
 * cross-module dependency above resolves through a public `exports`
 * array of the source module — no import path in this file or any
 * sibling reaches into another feature module's directory.
 */
@Module({
  controllers: [RebalancingController],
  imports: [
    AiProviderModule,
    ConfigModule,
    MetricsModule,
    PortfolioModule,
    SnowflakeSyncModule,
    UserFinancialProfileModule
  ],
  providers: [RebalancingService]
})
export class RebalancingModule {}
