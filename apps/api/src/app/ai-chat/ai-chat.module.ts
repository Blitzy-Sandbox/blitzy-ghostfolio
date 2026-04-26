import { MetricsModule } from '@ghostfolio/api/app/metrics/metrics.module';
import { PortfolioModule } from '@ghostfolio/api/app/portfolio/portfolio.module';
import { SnowflakeSyncModule } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.module';
import { SymbolModule } from '@ghostfolio/api/app/symbol/symbol.module';
import { UserFinancialProfileModule } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.module';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';

/**
 * `AiChatModule` is the NestJS feature module that wires **Feature B —
 * AI Portfolio Chat Agent** (AAP § 0.1.1, § 0.5.1.1) into the application's
 * dependency-injection graph. It mounts the streaming HTTP entry point
 *
 *     POST /api/v1/ai/chat  (Server-Sent Events)
 *
 * via `AiChatController` and orchestrates the Anthropic SDK streaming call
 * plus the four Claude tool dispatches through `AiChatService`. The module
 * is wired into the application root via the `imports` array of
 * `apps/api/src/app/app.module.ts` per AAP § 0.4.1.1.
 *
 * Composition (AAP § 0.5.1.1):
 *
 * - **Controllers:** `AiChatController` — the single `@Sse()` endpoint.
 *   Per Rule 8 (Controller Thinness, AAP § 0.7.1.8) the controller body
 *   only generates a per-request correlationId, extracts the JWT-verified
 *   user id, and delegates to `AiChatService.streamChat({...})`.
 *
 * - **Providers:** `AiChatService` — the core streaming service that
 *   constructs the Anthropic SDK client (Rule 3, AAP § 0.7.1.3),
 *   builds personalized system prompts from live portfolio + financial
 *   profile data, defines the four AAP § 0.5.1.5 tool schemas
 *   (`get_current_positions`, `get_performance_metrics`, `query_history`,
 *   `get_market_data`), and dispatches each `tool_use` content block to
 *   the corresponding sibling service.
 *
 * - **Exports:** None. `AiChatModule` is a pure leaf module — its
 *   service is consumed only by its own controller and is not required
 *   by any other feature module per the AAP architecture.
 *
 * - **Imports:**
 *   * `ConfigModule` — required for `ConfigService` injection into
 *     `AiChatService`. Ghostfolio's `app.module.ts` calls
 *     `ConfigModule.forRoot()` WITHOUT `isGlobal: true`, so child
 *     modules that consume `ConfigService` must explicitly re-import
 *     `ConfigModule` to bring it into local DI scope.
 *   * `MetricsModule` — exports `MetricsService`, which `AiChatService`
 *     injects to emit per-stream counter, first-token-latency
 *     histogram, and per-tool counter metrics, operationalizing the
 *     project-level Observability rule (AAP § 0.7.2).
 *   * `PortfolioModule` — exports `PortfolioService`, which
 *     `AiChatService` injects to power the `get_current_positions`
 *     and `get_performance_metrics` tool dispatches via the existing
 *     `PortfolioService.getDetails(...)` and
 *     `PortfolioService.getPerformance(...)` public methods. Per Rule 1
 *     (AAP § 0.7.1.1) this is the only legitimate cross-module access
 *     channel for portfolio data.
 *   * `SnowflakeSyncModule` — exports `SnowflakeSyncService`, which
 *     `AiChatService` injects to power the `query_history` tool
 *     dispatch via `SnowflakeSyncService.queryHistory(userId, sql,
 *     binds)` (AAP § 0.5.1.5). All bind variables are passed through
 *     the service unchanged — no string interpolation crosses the
 *     boundary, satisfying Rule 2 (AAP § 0.7.1.2).
 *   * `SymbolModule` — exports `SymbolService`, which `AiChatService`
 *     injects to power the `get_market_data` tool dispatch.
 *   * `UserFinancialProfileModule` — exports
 *     `UserFinancialProfileService`, which `AiChatService` injects to
 *     hydrate the per-request system prompt with the authenticated
 *     user's persisted goals, risk tolerance, and other personalization
 *     fields (AAP § 0.5.1.1).
 *
 * Module-isolation posture (Rule 1, AAP § 0.7.1.1): every
 * cross-module dependency above resolves through a public `exports`
 * array of the source module — no import path in this file or any
 * sibling reaches into another feature module's directory.
 */
@Module({
  controllers: [AiChatController],
  imports: [
    ConfigModule,
    MetricsModule,
    PortfolioModule,
    SnowflakeSyncModule,
    SymbolModule,
    UserFinancialProfileModule
  ],
  providers: [AiChatService]
})
export class AiChatModule {}
