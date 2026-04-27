import { RedisCacheModule } from '@ghostfolio/api/app/redis-cache/redis-cache.module';
import { SnowflakeSyncModule } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.module';
import { TransformDataSourceInRequestModule } from '@ghostfolio/api/interceptors/transform-data-source-in-request/transform-data-source-in-request.module';
import { DataEnhancerModule } from '@ghostfolio/api/services/data-provider/data-enhancer/data-enhancer.module';
import { DataProviderModule } from '@ghostfolio/api/services/data-provider/data-provider.module';
import { PropertyModule } from '@ghostfolio/api/services/property/property.module';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AnthropicHealthIndicator } from './anthropic-health.indicator';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SnowflakeHealthIndicator } from './snowflake-health.indicator';

/**
 * `HealthModule` registers the application's readiness/liveness probe
 * surfaces.
 *
 * Existing probes (unchanged):
 *   - `GET /api/v1/health`                       — DB + Redis aggregate
 *   - `GET /api/v1/health/data-enhancer/:name`   — per-enhancer probe
 *   - `GET /api/v1/health/data-provider/:source` — per-provider probe
 *
 * Additive AAP wiring (per AAP § 0.5.1.2 + § 0.7.2 Observability rule):
 *   - `GET /api/v1/health/snowflake` — lightweight `SELECT 1` probe of the
 *     Snowflake analytical backend that supports Feature A (Snowflake
 *     Sync) and the Feature B chat-agent `query_history` tool.
 *   - `GET /api/v1/health/anthropic` — configuration-only probe that
 *     verifies the Anthropic SDK can be instantiated with the configured
 *     `ANTHROPIC_API_KEY` and exposes the `messages.create` /
 *     `messages.stream` primitives consumed by Feature B (AI Portfolio
 *     Chat Agent) and Feature C (Explainable Rebalancing Engine). The
 *     probe makes NO paid Anthropic API call.
 *
 * Provider registration:
 *   - `SnowflakeHealthIndicator` — depends on `SnowflakeClientFactory`
 *     (provided via the additive `SnowflakeSyncModule` import below;
 *     that module exports both `SnowflakeClientFactory` and
 *     `SnowflakeSyncService` so cross-module access is permitted by
 *     Rule 1 in AAP § 0.7.1.1).
 *   - `AnthropicHealthIndicator` — depends on `ConfigService` (provided
 *     via the additive `ConfigModule` import below; Ghostfolio's
 *     `app.module.ts` calls `ConfigModule.forRoot()` WITHOUT
 *     `isGlobal: true`, so any child module that consumes
 *     `ConfigService` must explicitly re-import `ConfigModule` to
 *     bring it into local DI scope, per the `@nestjs/config`
 *     documentation).
 *
 * No existing provider, controller, or import is removed or reordered —
 * the change is strictly additive in keeping with the additive-only
 * mandate enumerated in AAP § 0.6.
 */
@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule,
    DataEnhancerModule,
    DataProviderModule,
    PropertyModule,
    RedisCacheModule,
    SnowflakeSyncModule,
    TransformDataSourceInRequestModule
  ],
  providers: [HealthService, AnthropicHealthIndicator, SnowflakeHealthIndicator]
})
export class HealthModule {}
