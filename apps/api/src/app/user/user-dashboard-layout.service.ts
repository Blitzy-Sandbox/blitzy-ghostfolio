import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserDashboardLayout } from '@prisma/client';

import { UpdateUserDashboardLayoutDto } from './dtos/update-user-dashboard-layout.dto';

/**
 * `UserDashboardLayoutService` is the single canonical read/write path for the
 * per-user `UserDashboardLayout` record introduced by the Modular Dashboard
 * feature (AAP § 0.1.1). It is registered + exported by `UserModule` and
 * consumed by `UserDashboardLayoutController` (HTTP `GET`/`PATCH
 * /api/v1/user/layout`).
 *
 * The service is intentionally stateless beyond its injected `PrismaService`
 * dependency. It mirrors `UserFinancialProfileService` but is simpler: the
 * layout payload is an opaque JSON blob, so there is NO business validation
 * and NO DTO→Prisma column mapping — `layoutData` is forwarded directly.
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
 *
 * In addition, the service emits two Prometheus signals via the injected
 * `MetricsService` (exposed at `GET /api/v1/metrics`), satisfying the AAP
 * § 0.8.2 Observability rule and decision-log entry D-017:
 *   - `user_dashboard_layout_requests_total` — counter labelled by
 *     `operation` (`get` | `patch`) and `outcome` (`success` | `not_found` |
 *     `error`).
 *   - `user_dashboard_layout_latency_seconds` — histogram labelled by
 *     `operation` (`get` | `patch`).
 * Both signals are emitted from a single `finally` block per operation
 * (mirroring `RebalancingService`), so latency and outcome are recorded on
 * EVERY path — success, `not_found`, and `error` alike. Labels are
 * fixed-cardinality (no `userId`/`correlationId`), keeping the series well
 * under the registry's `MAX_LABEL_CARDINALITY_PER_METRIC` guard.
 */
@Injectable()
export class UserDashboardLayoutService {
  /**
   * Prometheus counter name for total layout-endpoint outcomes. Labelled with
   * `operation ∈ { get, patch }` and `outcome ∈ { success, not_found, error }`
   * — a small, fixed cardinality set safe under the metrics registry's
   * `MAX_LABEL_CARDINALITY_PER_METRIC` guard.
   */
  private static readonly METRIC_REQUESTS_TOTAL =
    'user_dashboard_layout_requests_total';

  /**
   * Prometheus histogram name for end-to-end layout read/upsert wall-clock
   * latency. Recorded in seconds (consistent with Prometheus conventions and
   * the sibling `rebalancing_latency_seconds`) and labelled only by
   * `operation ∈ { get, patch }` to keep histogram cardinality minimal.
   */
  private static readonly METRIC_LATENCY_SECONDS =
    'user_dashboard_layout_latency_seconds';

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly metricsService: MetricsService
  ) {
    // Register the two Prometheus metric descriptions so `/api/v1/metrics`
    // emits proper `# HELP` lines (per the AAP § 0.8.2 Observability rule and
    // decision-log D-017). Registration is idempotent.
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
    // Terminal outcome for the metric labels. Pessimistic default so an
    // unexpected early exit is recorded as `error`, never a false success.
    let outcome: 'success' | 'not_found' | 'error' = 'error';

    try {
      const layout = await this.prismaService.userDashboardLayout.findUnique({
        where: { userId }
      });

      // A `null` row is the first-visit case (the controller maps it to HTTP
      // 404), distinct from both a hit and a thrown error.
      outcome = layout === null ? 'not_found' : 'success';

      // Success-path structured log (QA Issue #16). The runbook documents that
      // EVERY request emits a `[UserDashboardLayoutService] [<correlationId>]`
      // line so operators can trace a request end-to-end by correlation id;
      // previously only the error path logged, so successful reads were
      // invisible in the logs. Emitted at LOG level on BOTH non-error outcomes
      // (`success` and the normal first-visit `not_found`), carrying the
      // correlation id propagated from the controller boundary.
      Logger.log(
        this.formatLogMessage(
          layout === null
            ? `No UserDashboardLayout found for user ${userId} (first visit)`
            : `Read UserDashboardLayout for user ${userId}`,
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
      // Emit the terminal-outcome counter and latency histogram exactly once
      // per call, on EVERY path (success | not_found | error), mirroring the
      // RebalancingService finally-block pattern.
      const elapsedSeconds = (Date.now() - startTime) / 1000;

      this.metricsService.incrementCounter(
        UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
        1,
        { operation: 'get', outcome }
      );
      this.metricsService.observeHistogram(
        UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
        elapsedSeconds,
        { operation: 'get' }
      );
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
    // `patch` resolves only to `success` or `error` — an upsert always writes,
    // so `not_found` is a get-only outcome. Pessimistic default = `error`.
    let outcome: 'success' | 'error' = 'error';

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

      // Success-path structured log (QA Issue #16) — mirrors the read path so
      // every PATCH that persists a layout emits a traceable
      // `[UserDashboardLayoutService] [<correlationId>]` line, matching the
      // runbook's documented logging contract.
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
      // Emit the terminal-outcome counter and latency histogram exactly once
      // per call, on both the success and error paths (RebalancingService
      // finally-block pattern).
      const elapsedSeconds = (Date.now() - startTime) / 1000;

      this.metricsService.incrementCounter(
        UserDashboardLayoutService.METRIC_REQUESTS_TOTAL,
        1,
        { operation: 'patch', outcome }
      );
      this.metricsService.observeHistogram(
        UserDashboardLayoutService.METRIC_LATENCY_SECONDS,
        elapsedSeconds,
        { operation: 'patch' }
      );
    }
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
