import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserDashboardLayout } from '@prisma/client';

/**
 * `UserDashboardLayoutService` is the single canonical read/write path for
 * the per-user `UserDashboardLayout` record introduced by AAP § 0.6.1.1.
 *
 * It is exported by `UserDashboardLayoutModule` and consumed by:
 * - `UserDashboardLayoutController` (HTTP `GET` and `PATCH /api/v1/user/layout`)
 *
 * Future consumers may inject the service via DI per the module's `exports`
 * array. The service is intentionally stateless beyond its injected
 * `PrismaService` and `MetricsService` dependencies so multiple consumer
 * modules can safely inject the same NestJS-managed singleton.
 *
 * SECURITY (AAP § 0.8.1.5 — Rule 5, JWT-Authoritative Identity):
 * Every Prisma operation on `UserDashboardLayout` is scoped by
 * `where: { userId }` using the explicitly-passed `userId` argument
 * supplied by the caller. The caller (controller or downstream service)
 * MUST source `userId` from `request.user.id` (JWT-derived) — never from
 * the request body or DTO. This service is transport-agnostic and reads
 * NO HTTP request context, keeping it composable across cron jobs,
 * event handlers, and HTTP controllers.
 *
 * The `update` branch of `upsertForUser` deliberately omits `userId`
 * because (a) `userId` is the immutable primary key on `UserDashboardLayout`
 * and (b) it is implicitly carried by the `where: { userId }` clause;
 * including it in the update payload would mask future bugs where the
 * `update.userId` field could be inadvertently set from request body.
 *
 * IDEMPOTENCY (AAP § 0.8.1.4 + Decision D-019, Idempotent PATCH via upsert):
 * `upsertForUser` uses Prisma `upsert` keyed on the `userId` primary key.
 * Multiple invocations with the same `(userId, layoutData)` produce
 * identical state — designed to absorb the client's debounced 500 ms
 * PATCH bursts (AAP § 0.6.3.3 performance target) without producing
 * duplicate rows or uniqueness violations. This contract is verified by
 * the spec test "is idempotent — calling upsertForUser twice with same
 * input does not duplicate".
 *
 * OBSERVABILITY (AAP § 0.6.1.10 + § 0.8.2.1, project-level Observability rule):
 * Four metrics are emitted by the service:
 *   - Counter `dashboard_layout_get_total{outcome}` with outcomes
 *     `found` / `not_found` / `error` (one tick per `findByUserId` call).
 *   - Counter `dashboard_layout_patch_total{outcome}` with outcomes
 *     `success` / `error` (one tick per `upsertForUser` call).
 *   - Counter `dashboard_layout_save_failures_total{reason}` with reason
 *     `db_error` (incremented additionally on Prisma upsert failure).
 *   - Histogram `dashboard_layout_request_duration_seconds{method}` with
 *     methods `GET` / `PATCH` (latency in seconds, observed on every
 *     code path via `try`/`finally`).
 *
 * Help texts are registered once per process start in the constructor;
 * counters and histograms are emitted via `try`/`catch`/`finally` so that
 * EVERY code path (success, missing record, error) observes both the
 * latency histogram and a corresponding outcome counter — never a leaked
 * metric on an unanticipated exit path.
 *
 * ERROR PROPAGATION:
 * Prisma errors are logged at ERROR level with both the `correlationId`
 * (when supplied) and the `userId` for end-to-end traceability, then
 * rethrown unmodified. The caller (controller) translates them to HTTP
 * 500 via NestJS's global exception filter. The missing-record case
 * (`findUnique` returning `null`) is NOT treated as an error — the
 * service returns `null` and logs at INFO (`Logger.log`) level so the
 * controller can map the result to HTTP 404 (per AAP § 0.8.1.10's
 * "blank canvas" first-visit semantics) without polluting the error log.
 *
 * The `layoutData` payload is NEVER logged — it can contain user UI
 * preferences (module identifiers, positions) that constitute personally-
 * identifiable behavioral data. Only metadata (counts, sizes via implicit
 * latency) and identifiers (userId, correlationId) appear in log lines.
 */
@Injectable()
export class UserDashboardLayoutService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly metricsService: MetricsService
  ) {
    // Register Prometheus help descriptions once per process start. The
    // metrics registry is a singleton, so subsequent `registerHelp` calls
    // for the same name overwrite the prior description (no-op if same
    // text). Doing this in the constructor co-locates metric definitions
    // with their first emission, mirroring the established convention in
    // `apps/api/src/app/snowflake-sync/snowflake-sync.service.ts:188-195`.
    this.metricsService.registerHelp(
      'dashboard_layout_get_total',
      'Total GET /api/v1/user/layout invocations partitioned by outcome'
    );
    this.metricsService.registerHelp(
      'dashboard_layout_patch_total',
      'Total PATCH /api/v1/user/layout invocations partitioned by outcome'
    );
    this.metricsService.registerHelp(
      'dashboard_layout_save_failures_total',
      'Total layout save failures partitioned by reason'
    );
    this.metricsService.registerHelp(
      'dashboard_layout_request_duration_seconds',
      'Layout endpoint request duration in seconds'
    );
  }

  /**
   * Reads the dashboard layout for the given authenticated user.
   *
   * Returns `null` when no record exists for the user (Prisma `findUnique`
   * does not throw in this case). The HTTP controller is responsible for
   * mapping `null` to HTTP 404 — never to HTTP 500 (per AAP § 0.8.1.10
   * "blank canvas" first-visit semantics, which dictate that a missing
   * layout triggers the blank canvas + auto-open catalog client behavior).
   * Surfacing a missing-record case as `null` rather than a thrown
   * exception preserves the controller's ability to differentiate "no
   * record yet" (first-time user) from genuine database errors.
   *
   * Rule 5 compliance (AAP § 0.8.1.5 — JWT-Authoritative Identity): the
   * `where: { userId }` clause uses the supplied argument verbatim — the
   * caller is required to source `userId` from `request.user.id` and
   * NEVER from a request body or DTO.
   *
   * Observability (AAP § 0.6.1.10): on every invocation this method
   * increments `dashboard_layout_get_total{outcome}` with outcome
   * `found` / `not_found` / `error`, and observes
   * `dashboard_layout_request_duration_seconds{method=GET}` for the
   * total wall-clock duration. The histogram observation runs in
   * `finally` so missing-record and error paths are also measured.
   *
   * @param userId        Authenticated user id (from JWT). Caller is
   *                      responsible for sourcing from `request.user.id`.
   * @param correlationId Optional request-scoped UUID propagated from the
   *                      controller boundary; embedded in structured log
   *                      lines for end-to-end traceability per AAP
   *                      § 0.8.2.1 (Observability rule).
   * @returns             The persisted layout row, or `null` if none exists.
   */
  public async findByUserId(
    userId: string,
    correlationId?: string
  ): Promise<UserDashboardLayout | null> {
    const startTime = Date.now();
    let outcome: 'found' | 'not_found' | 'error' = 'found';

    try {
      const layout = await this.prismaService.userDashboardLayout.findUnique({
        where: { userId }
      });

      if (layout === null) {
        outcome = 'not_found';
        Logger.log(
          this.formatLogMessage(
            `No dashboard layout found for user ${userId}`,
            correlationId
          ),
          'UserDashboardLayoutService'
        );
      }

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
      this.metricsService.incrementCounter('dashboard_layout_get_total', 1, {
        outcome
      });
      this.metricsService.observeHistogram(
        'dashboard_layout_request_duration_seconds',
        (Date.now() - startTime) / 1000,
        { method: 'GET' }
      );
    }
  }

  /**
   * Creates or updates the dashboard layout for the given authenticated
   * user. The `userId` is the immutable primary key on `UserDashboardLayout`,
   * so a single `upsert` call is idempotent — re-running `PATCH` with the
   * same `(userId, layoutData)` updates the record in place rather than
   * producing a duplicate row or a uniqueness violation. This idempotency
   * is REQUIRED by Decision D-019 and AAP § 0.8.1.4 because the client
   * issues debounced 500 ms PATCH bursts in response to drag/resize/add/
   * remove events on the grid canvas; multiple in-flight bursts MUST
   * collapse to a single steady-state row.
   *
   * The Prisma `upsert` clause structure mirrors AAP § 0.6.1.3 verbatim:
   *   - `where:  { userId }`             — keyed on the primary-key `userId`.
   *   - `create: { userId, layoutData }` — full row on first PATCH.
   *   - `update: { layoutData }`         — only `layoutData` mutated.
   *
   * The `update` branch deliberately omits `userId` because (a) it is
   * immutable on existing rows and (b) it is implied by the `where`
   * clause; including it would mask future bugs where `update.userId`
   * could be set from request body. `createdAt` is preserved by Prisma's
   * `@default(now())` semantics on the existing row, and `updatedAt` is
   * auto-bumped by the `@updatedAt` directive on the model.
   *
   * Rule 5 compliance (AAP § 0.8.1.5 — JWT-Authoritative Identity):
   * every component of the upsert (`where`, `create`, `update`) is
   * scoped to the `userId` parameter, which the caller MUST source from
   * the JWT-verified user identity (`request.user.id`) — never from the
   * request body. The class-validator DTO `UpdateDashboardLayoutDto`
   * ensures `layoutData` shape correctness BEFORE this method runs.
   *
   * The `layoutData as Prisma.InputJsonValue` cast is the documented
   * Prisma idiom for narrowing a typed `Prisma.JsonValue` parameter to
   * the `InputJsonValue` shape required by the Prisma column input type.
   *
   * Observability (AAP § 0.6.1.10): this method increments
   * `dashboard_layout_patch_total{outcome}` with outcome `success` /
   * `error` on every invocation, plus
   * `dashboard_layout_save_failures_total{reason=db_error}` ADDITIONALLY
   * on Prisma failure (the failure counter is in addition to the
   * outcome counter so dashboards can alert on the failure-counter rate
   * without re-deriving it from the outcome partition). The
   * `dashboard_layout_request_duration_seconds{method=PATCH}` histogram
   * is observed in `finally`, capturing latency on both success and
   * error paths.
   *
   * @param userId        Authenticated user id (from JWT). Caller is
   *                      responsible for sourcing from `request.user.id`.
   * @param layoutData    Validated layout payload (a `Prisma.JsonValue`-
   *                      compatible JSON object). The class-validator
   *                      `UpdateDashboardLayoutDto` ensures shape
   *                      correctness BEFORE this method runs.
   * @param correlationId Optional request-scoped UUID propagated from
   *                      the controller boundary; embedded in
   *                      structured log lines.
   * @returns             The upserted `UserDashboardLayout` row.
   * @throws              Prisma `PrismaClientKnownRequestError` (or any
   *                      other database error) on database failure.
   *                      The error is rethrown unmodified after logging
   *                      so the caller's exception filter can render a
   *                      consistent HTTP 500.
   */
  public async upsertForUser(
    userId: string,
    layoutData: Prisma.JsonValue,
    correlationId?: string
  ): Promise<UserDashboardLayout> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'success';

    try {
      return await this.prismaService.userDashboardLayout.upsert({
        where: { userId },
        create: {
          userId,
          layoutData: layoutData as Prisma.InputJsonValue
        },
        update: {
          layoutData: layoutData as Prisma.InputJsonValue
        }
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
      this.metricsService.incrementCounter(
        'dashboard_layout_save_failures_total',
        1,
        { reason: 'db_error' }
      );

      throw error;
    } finally {
      this.metricsService.incrementCounter('dashboard_layout_patch_total', 1, {
        outcome
      });
      this.metricsService.observeHistogram(
        'dashboard_layout_request_duration_seconds',
        (Date.now() - startTime) / 1000,
        { method: 'PATCH' }
      );
    }
  }

  /**
   * Prefixes a structured log message with `[<correlationId>] ` when a
   * non-empty correlation id was propagated from the caller, otherwise
   * returns the message unchanged. This keeps the log format consistent
   * with the cross-cutting Observability convention established by the
   * sibling services (`UserFinancialProfileService`, `SnowflakeSyncService`,
   * `AiChatService`, `RebalancingService`) so a single correlation id
   * traces a request end-to-end across feature module boundaries.
   */
  private formatLogMessage(
    message: string,
    correlationId: string | undefined
  ): string {
    return correlationId ? `[${correlationId}] ${message}` : message;
  }
}
