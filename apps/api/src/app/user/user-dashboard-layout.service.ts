import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { DashboardLayoutItem } from '@ghostfolio/common/interfaces';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserDashboardLayout } from '@prisma/client';

/**
 * Canonical read/upsert path for the per-user `UserDashboardLayout` record.
 * Registered as a provider in `UserModule` and consumed by
 * `UserDashboardLayoutController` (`GET`/`PATCH /api/v1/user/layout`).
 *
 * Every Prisma operation is scoped by `where: { userId }` using the
 * JWT-verified user id supplied by the caller; this service reads no HTTP
 * request context. An optional `correlationId` is propagated into log lines
 * for end-to-end request tracing, and request/latency metrics are emitted to
 * the shared `MetricsService` registry.
 *
 * Design rationale (metric location, tracing approach, first-visit semantics)
 * is recorded in `docs/decisions/dashboard-refactor-decisions.md` (D-102, D-103).
 */
@Injectable()
export class UserDashboardLayoutService {
  /** Counter: total layout requests, labeled by `operation` and `outcome`. */
  private static readonly METRIC_REQUESTS_TOTAL =
    'user_dashboard_layout_requests_total';

  /** Histogram: layout request latency in seconds, labeled by `operation`. */
  private static readonly METRIC_LATENCY_SECONDS =
    'user_dashboard_layout_latency_seconds';

  public constructor(
    private readonly metricsService: MetricsService,
    private readonly prismaService: PrismaService
  ) {
    // Register `# HELP` descriptions so `/api/v1/metrics` documents these
    // series even before the first observation (idempotent).
    this.metricsService.registerHelp(
      UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
      'Total dashboard-layout requests handled by UserDashboardLayoutService, ' +
        'labeled by operation (read | write) and outcome (success | not_found | error).'
    );
    this.metricsService.registerHelp(
      UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
      'Latency of UserDashboardLayoutService read/write operations in seconds, ' +
        'labeled by operation (read | write).'
    );
  }

  /**
   * Reads the dashboard layout for the authenticated user. Returns `null` when
   * no record exists (`findUnique` does not throw); the controller maps `null`
   * to HTTP 404.
   *
   * @param userId        Authenticated user id (JWT-derived, never request body).
   * @param correlationId Optional request-scoped id for end-to-end tracing.
   */
  public async findByUserId(
    userId: string,
    correlationId?: string
  ): Promise<UserDashboardLayout | null> {
    const startTime = Date.now();
    let outcome: 'success' | 'not_found' | 'error' = 'success';

    // Span boundary (read): trace entry into the Prisma read operation.
    Logger.debug(
      this.formatLogMessage(
        `UserDashboardLayout read start userId=${userId}`,
        correlationId
      ),
      'UserDashboardLayoutService'
    );

    try {
      const layout = await this.prismaService.userDashboardLayout.findUnique({
        where: { userId }
      });

      outcome = layout ? 'success' : 'not_found';

      return layout;
    } catch (error) {
      outcome = 'error';

      Logger.error(
        this.formatLogMessage(
          `Failed to read UserDashboardLayout for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

      throw error;
    } finally {
      // Emit terminal-outcome counter + latency histogram exactly once per
      // call, on every return path. Labels are fixed-cardinality only
      // (no userId/correlationId) to respect the metrics cardinality guard.
      const elapsedSeconds = (Date.now() - startTime) / 1000;

      this.metricsService.incrementCounter(
        UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
        1,
        { operation: 'read', outcome }
      );
      this.metricsService.observeHistogram(
        UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
        elapsedSeconds,
        { operation: 'read' }
      );

      // Span boundary (read): trace exit with resolved outcome and elapsed time.
      Logger.debug(
        this.formatLogMessage(
          `UserDashboardLayout read end userId=${userId} outcome=${outcome} ` +
            `elapsedMs=${Date.now() - startTime}`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );
    }
  }

  /**
   * Creates or updates the authenticated user's dashboard layout. `userId` is
   * the immutable primary key, so a single `upsert` is idempotent. The
   * validated `layout` array is persisted into the `layoutData` JSONB column.
   *
   * @param userId        Authenticated user id (JWT-derived, never request body).
   * @param layout        Validated grid-item array from `dto.layout`.
   * @param correlationId Optional request-scoped id for end-to-end tracing.
   */
  public async upsertForUser(
    userId: string,
    layout: DashboardLayoutItem[],
    correlationId?: string
  ): Promise<UserDashboardLayout> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'success';

    // Span boundary (write): trace entry into the Prisma upsert operation.
    Logger.debug(
      this.formatLogMessage(
        `UserDashboardLayout write start userId=${userId} items=${layout.length}`,
        correlationId
      ),
      'UserDashboardLayoutService'
    );

    try {
      // Prisma 7 idiom: narrow a typed array into a JSON column input.
      const layoutData = layout as unknown as Prisma.InputJsonValue;

      return await this.prismaService.userDashboardLayout.upsert({
        create: {
          userId,
          layoutData
        },
        update: {
          layoutData
        },
        where: { userId }
      });
    } catch (error) {
      outcome = 'error';

      Logger.error(
        this.formatLogMessage(
          `Failed to upsert UserDashboardLayout for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

      throw error;
    } finally {
      const elapsedSeconds = (Date.now() - startTime) / 1000;

      this.metricsService.incrementCounter(
        UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
        1,
        { operation: 'write', outcome }
      );
      this.metricsService.observeHistogram(
        UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
        elapsedSeconds,
        { operation: 'write' }
      );

      // Span boundary (write): trace exit with resolved outcome and elapsed time.
      Logger.debug(
        this.formatLogMessage(
          `UserDashboardLayout write end userId=${userId} outcome=${outcome} ` +
            `elapsedMs=${Date.now() - startTime}`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );
    }
  }

  /**
   * Prefixes a log message with `[<correlationId>] ` when a correlation id was
   * propagated, otherwise returns the message unchanged.
   */
  private formatLogMessage(
    message: string,
    correlationId: string | undefined
  ): string {
    return correlationId ? `[${correlationId}] ${message}` : message;
  }
}
