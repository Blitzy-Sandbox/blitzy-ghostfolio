import { Controller, Get, Header } from '@nestjs/common';

import { MetricsService } from './metrics.service';

/**
 * `MetricsController` — exposes the in-process metrics registry over HTTP for
 * scraping by Prometheus-compatible monitoring infrastructure.
 *
 * Resolves at runtime to `GET /api/v1/metrics` after the global `api` prefix
 * (configured via `app.setGlobalPrefix('api', ...)` in
 * `apps/api/src/main.ts`) and the global URI versioning (configured via
 * `app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI })`)
 * are applied.
 *
 * The endpoint is intentionally unauthenticated and unguarded, mirroring the
 * sibling `/health` controller. Internal monitoring infrastructure (Prometheus
 * scrapers, Grafana agents, etc.) does not carry JWT credentials, and the
 * exposed counters/histograms describe aggregate operational telemetry only —
 * never per-user data.
 *
 * Per AAP § 0.7.1.8 (Rule 8 — Controller Thinness), this controller contains
 * zero business logic and zero Prisma calls. All rendering is delegated to
 * the injected {@link MetricsService}, whose
 * {@link MetricsService.getRegistryAsText} method emits the canonical
 * Prometheus 0.0.4 text exposition format.
 */
@Controller('metrics')
export class MetricsController {
  public constructor(private readonly metricsService: MetricsService) {}

  /**
   * Renders the current in-process metrics registry as a Prometheus 0.0.4
   * text exposition payload.
   *
   * The `Content-Type` header `text/plain; version=0.0.4; charset=utf-8` is
   * the published Prometheus exposition format header. Prometheus scrapers
   * key on this exact header to negotiate the response payload format; any
   * deviation (e.g., `application/json`) causes the scrape to be rejected.
   *
   * Returns an empty string when no metrics have been recorded yet
   * (e.g., immediately after a fresh boot before any service has called
   * `incrementCounter` or `observeHistogram`). An empty body is valid per
   * the Prometheus exposition specification.
   *
   * @returns The serialized Prometheus exposition payload as a UTF-8 string.
   */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  public getMetrics(): string {
    return this.metricsService.getRegistryAsText();
  }
}
