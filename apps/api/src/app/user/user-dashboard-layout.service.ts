import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserDashboardLayout } from '@prisma/client';

import { DashboardLayoutDto } from './dtos/dashboard-layout.dto';

/**
 * `UserDashboardLayoutService` is the single canonical read/write path for
 * the per-user `UserDashboardLayout` record introduced by AAP § 0.1.1
 * (single-canvas modular dashboard). It abstracts all Prisma access to the
 * `UserDashboardLayout` table behind a repository-style API.
 *
 * It is registered as a provider by `UserModule` and consumed by
 * `UserDashboardLayoutController` (HTTP `GET`/`PATCH /api/v1/user/layout`).
 *
 * The service is intentionally stateless beyond its injected `PrismaService`
 * and `MetricsService` dependencies and is transport-agnostic: it reads NO
 * HTTP request context.
 *
 * SECURITY (AAP § 0.7.3 — Rule 8): Every Prisma operation is scoped by
 * `where: { userId }` using the JWT-verified user identifier supplied by the
 * caller. The controller sources `userId` from `request.user.id`; this
 * service never reads it from a request body/query/param.
 *
 * OBSERVABILITY (AAP § 0.6.1 / § 0.8.4): Each public method accepts an
 * optional `correlationId` (UUID-shaped) generated at the controller
 * boundary and propagated into the structured `Logger` calls so a single
 * request can be traced end-to-end. When omitted (e.g. a unit test), log
 * lines are emitted without the `[<correlationId>]` prefix.
 *
 * In addition to structured logging, both public methods register
 * Prometheus counters and latency histograms in the shared, process-wide
 * {@link MetricsService} (injected from the exported `MetricsModule`),
 * exactly as the sibling `RebalancingService` / `AiChatService` /
 * `SnowflakeSyncService` do. This backs the `ops/dashboards/dashboard-layout.json`
 * Grafana template (which queries `dashboard_layout_requests_total{operation,outcome}`
 * and `dashboard_layout_latency_seconds_bucket{operation}`) and the
 * `GET /api/v1/metrics` scrape endpoint. Emission happens in a `finally`
 * block so every return path — success or thrown error — is counted exactly
 * once. Labels are deliberately fixed-cardinality (`operation ∈ { get, patch }`,
 * `outcome ∈ { success, error }`); the request-scoped `userId` / `correlationId`
 * are NEVER used as label values, keeping the series count well within the
 * registry's `MAX_LABEL_CARDINALITY_PER_METRIC` guard.
 */
@Injectable()
export class UserDashboardLayoutService {
  /**
   * Prometheus counter name for total dashboard-layout persistence requests.
   * Labeled with `operation ∈ { get, patch }` and `outcome ∈ { success,
   * error }` — a small, fixed cardinality set safe under the metrics
   * registry's `MAX_LABEL_CARDINALITY_PER_METRIC` guard. Matches the
   * `dashboard_layout_requests_total{operation,outcome}` series consumed by
   * `ops/dashboards/dashboard-layout.json`.
   */
  private static readonly METRIC_REQUESTS_TOTAL =
    'dashboard_layout_requests_total';

  /**
   * Prometheus histogram name for dashboard-layout persistence wall-clock
   * latency. Recorded in seconds (consistent with Prometheus conventions and
   * with `rebalancing_latency_seconds`). Labeled only by
   * `operation ∈ { get, patch }` so the `dashboard_layout_latency_seconds_bucket{operation}`
   * panels can break latency down by read vs. write while keeping cardinality
   * minimal.
   */
  private static readonly METRIC_LATENCY_SECONDS =
    'dashboard_layout_latency_seconds';

  public constructor(
    private readonly metricsService: MetricsService,
    private readonly prismaService: PrismaService
  ) {
    // Register the two Prometheus metric descriptions so `/api/v1/metrics`
    // emits proper `# HELP` lines (per the Observability rule). Registration
    // is idempotent — the registry keeps the first description seen.
    this.metricsService.registerHelp(
      UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
      'Total per-user dashboard layout persistence requests handled by ' +
        'UserDashboardLayoutService, labeled by operation (get | patch) and ' +
        'outcome (success | error).'
    );
    this.metricsService.registerHelp(
      UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
      'Wall-clock latency of UserDashboardLayoutService read/upsert Prisma ' +
        'operations in seconds, labeled by operation (get | patch).'
    );
  }

  /**
   * Reads the dashboard layout for the given authenticated user.
   *
   * Returns `null` when no record exists (Prisma `findUnique` does not throw
   * in this case). The controller maps `null` to HTTP 404 — never HTTP 500 —
   * so the client can distinguish a first-visit (no saved layout) from a
   * genuine error and map 404 → null on its side.
   *
   * Rule 8 compliance: the `where: { userId }` clause is required and sourced
   * from the caller (JWT-derived), never from the request body.
   */
  public async findByUserId(
    userId: string,
    correlationId?: string
  ): Promise<UserDashboardLayout | null> {
    const startTime = Date.now();
    let outcome: 'error' | 'success' = 'success';

    try {
      return await this.prismaService.userDashboardLayout.findUnique({
        where: { userId }
      });
    } catch (error) {
      outcome = 'error';

      Logger.error(
        this.formatLogMessage(
          `Failed to read UserDashboardLayout: ${
            error instanceof Error ? error.message : String(error)
          }`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

      throw error;
    } finally {
      // Emit the request counter and latency histogram exactly once per
      // call, regardless of return path. A first-visit `null` result is a
      // successful read (not an error) and is counted with outcome=success.
      this.emitMetrics('get', outcome, startTime);
    }
  }

  /**
   * Creates or updates the dashboard layout for the given authenticated user.
   * `userId` is the immutable primary key, so a single `upsert` is idempotent:
   * re-issuing `PATCH` with the same payload updates the row in place rather
   * than creating a duplicate or triggering a uniqueness violation.
   *
   * The `create` branch attaches the new row to the supplied `userId` (FK to
   * `User.id`, cascade delete). Both branches write the `layoutData` JSON
   * column. The `dto as unknown as Prisma.InputJsonValue` cast is the
   * documented Prisma 7 idiom for narrowing a typed DTO into a `Json` column
   * input (mirrors `mapDtoToPrismaInput` in the financial-profile service).
   *
   * Rule 8 compliance: every component of the upsert (`where`, `create`,
   * `update`) is scoped to the `userId` parameter (JWT-derived).
   */
  public async upsertForUser(
    userId: string,
    dto: DashboardLayoutDto,
    correlationId?: string
  ): Promise<UserDashboardLayout> {
    const startTime = Date.now();
    let outcome: 'error' | 'success' = 'success';

    try {
      return await this.prismaService.userDashboardLayout.upsert({
        create: {
          userId,
          layoutData: dto as unknown as Prisma.InputJsonValue
        },
        update: {
          layoutData: dto as unknown as Prisma.InputJsonValue
        },
        where: { userId }
      });
    } catch (error) {
      outcome = 'error';

      Logger.error(
        this.formatLogMessage(
          `Failed to upsert UserDashboardLayout: ${
            error instanceof Error ? error.message : String(error)
          }`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

      throw error;
    } finally {
      // Emit the request counter and latency histogram exactly once per
      // upsert call, regardless of return path (created, updated, or thrown).
      this.emitMetrics('patch', outcome, startTime);
    }
  }

  /**
   * Prefixes a structured log message with `[<correlationId>] ` when a
   * non-empty correlation id was propagated from the caller, otherwise
   * returns the message unchanged — keeping the log format consistent with
   * the sibling `UserFinancialProfileService`.
   */
  private formatLogMessage(
    message: string,
    correlationId: string | undefined
  ): string {
    return correlationId ? `[${correlationId}] ${message}` : message;
  }

  /**
   * Records the terminal-outcome counter and the latency histogram for a
   * single dashboard-layout persistence operation.
   *
   * Centralizes the emission so both `findByUserId` (`operation = 'get'`) and
   * `upsertForUser` (`operation = 'patch'`) share identical label semantics.
   * Called from each method's `finally` block, so it runs exactly once per
   * invocation regardless of success or thrown error.
   *
   * Labels are fixed-cardinality only (`operation`, `outcome`); the latency
   * histogram carries just `operation`. No `userId` / `correlationId` is ever
   * used as a label value, so the metrics registry's
   * `MAX_LABEL_CARDINALITY_PER_METRIC` guard can never silently drop a series.
   */
  private emitMetrics(
    operation: 'get' | 'patch',
    outcome: 'error' | 'success',
    startTime: number
  ): void {
    const elapsedSeconds = (Date.now() - startTime) / 1000;

    this.metricsService.incrementCounter(
      UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
      1,
      { operation, outcome }
    );
    this.metricsService.observeHistogram(
      UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
      elapsedSeconds,
      { operation }
    );
  }
}
