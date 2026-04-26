import { RedisCacheModule } from '@ghostfolio/api/app/redis-cache/redis-cache.module';
import { SnowflakeSyncModule } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.module';
import { TransformDataSourceInRequestModule } from '@ghostfolio/api/interceptors/transform-data-source-in-request/transform-data-source-in-request.module';
import { DataEnhancerModule } from '@ghostfolio/api/services/data-provider/data-enhancer/data-enhancer.module';
import { DataProviderModule } from '@ghostfolio/api/services/data-provider/data-provider.module';
import { PropertyModule } from '@ghostfolio/api/services/property/property.module';

import { Module } from '@nestjs/common';

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
 *
 * The `SnowflakeHealthIndicator` is registered as a provider here and the
 * matching route is exposed by `HealthController`. The indicator depends on
 * `SnowflakeClientFactory` (via constructor injection); to make that
 * provider visible to this module's DI scope we additively import
 * `SnowflakeSyncModule`, which exports both `SnowflakeClientFactory` and
 * `SnowflakeSyncService` in its `exports` array (per Rule 1 in
 * AAP § 0.7.1.1 — the factory is the only legitimate cross-module access
 * channel for Snowflake connection acquisition).
 *
 * No existing provider, controller, or import is removed or reordered —
 * the change is strictly additive in keeping with the additive-only
 * mandate enumerated in AAP § 0.6.
 */
@Module({
  controllers: [HealthController],
  imports: [
    DataEnhancerModule,
    DataProviderModule,
    PropertyModule,
    RedisCacheModule,
    SnowflakeSyncModule,
    TransformDataSourceInRequestModule
  ],
  providers: [HealthService, SnowflakeHealthIndicator]
})
export class HealthModule {}
