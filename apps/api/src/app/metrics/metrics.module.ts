import { Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * `MetricsModule` — NestJS feature module that wires the in-process metrics
 * registry into the application's dependency-injection graph.
 *
 * Responsibilities:
 * - Registers {@link MetricsController}, the unauthenticated HTTP endpoint that
 *   resolves at runtime to `GET /api/v1/metrics` and renders the registry as
 *   the canonical Prometheus 0.0.4 text exposition format for scraping.
 * - Registers {@link MetricsService} as a singleton provider, owning the
 *   in-process counter/histogram registry for the lifetime of the Node.js
 *   process.
 * - **Exports {@link MetricsService}** so the sibling feature modules
 *   introduced by the same Agent Action Plan — `SnowflakeSyncModule`,
 *   `AiChatModule`, and `RebalancingModule` — can inject the same singleton
 *   to record application-level counters and latency histograms (sync
 *   success/failure totals, chat token throughput, rebalancing latency).
 *
 * This export is the single permitted cross-module access surface for the
 * metrics registry, satisfying AAP § 0.7.1.1 (Rule 1 — Module Isolation):
 * cross-module access MUST occur only through services explicitly listed in
 * the source module's `exports` array.
 *
 * The module deliberately declares no `imports` array entry. {@link
 * MetricsService} is fully self-contained — it depends only on the NestJS
 * `Logger` (constructed inline via `new Logger(...)`) and native `Map` data
 * structures, with no `ConfigService`, `PrismaService`, or other cross-module
 * dependency. Adding superfluous imports would violate the additive-only
 * mandate enumerated in AAP § 0.6.
 *
 * Operationalizes the AAP § 0.7.2 project-level "Observability" rule:
 * "every deliverable MUST include structured logging with correlation IDs,
 * distributed tracing, a metrics endpoint, health/readiness checks, and a
 * dashboard template."
 */
@Module({
  controllers: [MetricsController],
  exports: [MetricsService],
  providers: [MetricsService]
})
export class MetricsModule {}
