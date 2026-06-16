import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, UserDashboardLayout } from '@prisma/client';

import { UpdateUserDashboardLayoutDto } from './dtos/update-user-dashboard-layout.dto';

/**
 * Terminal outcome label applied to the `user_dashboard_layout_requests_total`
 * counter. `not_found` is the normal first-visit signal (a `get` that resolves
 * to `null`), distinct from `error` (a genuine Prisma/DB or unexpected
 * failure); `patch` only ever resolves to `success` or `error`.
 */
type UserDashboardLayoutMetricOutcome = 'success' | 'not_found' | 'error';

/**
 * `UserDashboardLayoutService` is the single canonical read/write path for the
 * per-user `UserDashboardLayout` record introduced by the Modular Dashboard
 * feature. It is registered + exported by `UserModule` and
 * consumed by `UserDashboardLayoutController` (HTTP `GET`/`PATCH
 * /api/v1/user/layout`).
 *
 * The service is intentionally stateless beyond its injected `PrismaService`
 * and `MetricsService` dependencies. It mirrors `UserFinancialProfileService`
 * but is simpler: the layout payload is an opaque JSON blob, so there is NO
 * business validation and NO DTO→Prisma column mapping — `layoutData` is
 * forwarded directly.
 *
 * SECURITY: Every Prisma operation is scoped by `where: { userId }` using the
 * JWT-verified user id supplied by the caller. The caller (the controller)
 * sources `userId` from `request.user.id` — this service NEVER reads HTTP
 * request context, keeping it transport-agnostic.
 *
 * OBSERVABILITY: Every public method accepts an optional `correlationId`
 * generated at the controller boundary and propagated to the structured
 * `Logger` so a single request can be traced end-to-end. When omitted (e.g.
 * unit tests), log lines are emitted without the `[<correlationId>]` prefix.
 * Each method also emits two Prometheus signals via the shared
 * `MetricsService` from a single `finally` block — a `user_dashboard_layout_requests_total`
 * counter (labeled by `operation` and `outcome`) and a
 * `user_dashboard_layout_latency_seconds` histogram (labeled by `operation`) —
 * exposed at `GET /api/v1/metrics`.
 */
@Injectable()
export class UserDashboardLayoutService {
  /**
   * Prometheus counter name for total layout endpoint outcomes. Labeled with
   * `operation` ∈ { `get`, `patch` } and `outcome` ∈ { `success`,
   * `not_found`, `error` } — both fixed, low-cardinality label sets.
   */
  private static readonly METRIC_REQUESTS_TOTAL =
    'user_dashboard_layout_requests_total';

  /**
   * Prometheus histogram name for layout read/upsert wall-clock latency in
   * seconds. Labeled with `operation` ∈ { `get`, `patch` } only.
   */
  private static readonly METRIC_LATENCY_SECONDS =
    'user_dashboard_layout_latency_seconds';

  public constructor(
    private readonly metricsService: MetricsService,
    private readonly prismaService: PrismaService
  ) {
    // Register the two Prometheus metric descriptions so `/api/v1/metrics`
    // emits proper `# HELP` lines (per the Observability rule). Registration
    // is idempotent — the registry keeps the first description seen.
    this.metricsService.registerHelp(
      UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
      'Total user dashboard layout endpoint requests handled by UserDashboardLayoutService, ' +
        'labeled by operation (get | patch) and outcome (success | not_found | error).'
    );
    this.metricsService.registerHelp(
      UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
      'End-to-end wall-clock latency of UserDashboardLayoutService get/upsert operations in seconds, ' +
        'labeled by operation (get | patch).'
    );
  }

  /**
   * Reads the dashboard layout for the given authenticated user.
   *
   * Returns `null` when no record exists (Prisma `findUnique` does not throw
   * on a miss). The HTTP controller maps `null` to HTTP 404 — never HTTP 500 —
   * so a first-time user (no saved layout) is distinguishable from an error.
   *
   * @param userId        Authenticated user id (from JWT, NEVER request body).
   * @param correlationId Optional request-scoped correlation id for log tracing.
   */
  public async findByUserId(
    userId: string,
    correlationId?: string
  ): Promise<UserDashboardLayout | null> {
    const startTime = Date.now();
    let outcome: UserDashboardLayoutMetricOutcome = 'success';

    try {
      const layout = await this.prismaService.userDashboardLayout.findUnique({
        where: { userId }
      });

      outcome = layout ? 'success' : 'not_found';

      // Success-path structured log with the request-scoped correlation id, so
      // a successful read (and the normal first-visit `not_found`) is traceable
      // end-to-end via `[UserDashboardLayoutService] [<correlationId>]` — not
      // only error paths (QA F9 Issue 14).
      Logger.log(
        this.formatLogMessage(
          layout
            ? `Read UserDashboardLayout for user ${userId}`
            : `No UserDashboardLayout found for user ${userId} (first visit)`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

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
      this.emitMetrics('get', outcome, startTime);
    }
  }

  /**
   * Creates or updates the dashboard layout for the given authenticated user.
   * `userId` is the immutable primary key, so a single `upsert` is idempotent —
   * re-running `PATCH` with the same payload updates the row in place rather
   * than producing a duplicate or a uniqueness violation.
   *
   * `layoutData` is a Prisma `Json` column; the `as unknown as
   * Prisma.InputJsonValue` cast is the documented Prisma 7 idiom for narrowing
   * the typed DTO shape into the JSON column input.
   *
   * @param userId        Authenticated user id (from JWT, NEVER request body).
   * @param dto           Validated `UpdateUserDashboardLayoutDto` payload.
   * @param correlationId Optional request-scoped correlation id for log tracing.
   */
  public async upsertForUser(
    userId: string,
    dto: UpdateUserDashboardLayoutDto,
    correlationId?: string
  ): Promise<UserDashboardLayout> {
    const startTime = Date.now();
    let outcome: UserDashboardLayoutMetricOutcome = 'success';

    try {
      const layout = await this.prismaService.userDashboardLayout.upsert({
        create: {
          userId,
          layoutData: dto.layoutData as unknown as Prisma.InputJsonValue
        },
        update: {
          layoutData: dto.layoutData as unknown as Prisma.InputJsonValue
        },
        where: { userId }
      });

      outcome = 'success';

      // Success-path structured log with the request-scoped correlation id so a
      // successful upsert is traceable end-to-end via
      // `[UserDashboardLayoutService] [<correlationId>]` — not only error paths
      // (QA F9 Issue 14).
      Logger.log(
        this.formatLogMessage(
          `Upserted UserDashboardLayout for user ${userId}`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

      return layout;
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
      this.emitMetrics('patch', outcome, startTime);
    }
  }

  /**
   * Emits the terminal-outcome counter and the latency histogram for a single
   * layout operation. Invoked exactly once per public method from its `finally`
   * block, so the histogram is recorded for every outcome (including
   * `not_found` and `error`). Labels use only the fixed-cardinality `operation`
   * and `outcome` fields — never `userId` or `correlationId` — so the metrics
   * registry's `MAX_LABEL_CARDINALITY_PER_METRIC` guard never drops a series.
   *
   * @param operation The endpoint operation (`get` or `patch`).
   * @param outcome   The terminal outcome for the request.
   * @param startTime `Date.now()` captured at method entry, for latency.
   */
  private emitMetrics(
    operation: 'get' | 'patch',
    outcome: UserDashboardLayoutMetricOutcome,
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

  /**
   * Prefixes a structured log message with `[<correlationId>] ` when a
   * non-empty correlation id was propagated from the caller, otherwise
   * returns the message unchanged. Mirrors the precedent
   * `UserFinancialProfileService.formatLogMessage(...)`.
   */
  private formatLogMessage(message: string, correlationId?: string): string {
    return correlationId ? `[${correlationId}] ${message}` : message;
  }
}
