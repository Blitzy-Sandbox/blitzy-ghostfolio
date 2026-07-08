import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';

import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * HTTP response header carrying the per-request correlation id. Emitted on
 * EVERY response for the dashboard-layout routes — including guard-rejected
 * `401`, pipe-rejected `400`, and thrown `404` — because this middleware runs
 * BEFORE the guard/pipe boundary (see the class doc for the lifecycle detail).
 */
export const CORRELATION_ID_HEADER = 'X-Correlation-ID';

/**
 * Property name under which the generated correlation id is attached to the
 * Express request object. Downstream request-scoped consumers (the
 * `UserDashboardLayoutController`, which injects `REQUEST`) read the id from
 * this property so the header value, the structured log lines, and the
 * service-layer Prisma-error logs all share ONE id per request.
 */
export const CORRELATION_ID_REQUEST_KEY = 'correlationId';

/**
 * Prometheus counter name: total dashboard-layout HTTP requests, partitioned
 * by `operation` (get/patch) and `outcome` (success/error/unauthorized). This
 * name — and its label set — is the exact string queried by every panel and
 * the `operation` template variable in `ops/dashboards/dashboard-layout.json`;
 * the two MUST stay in lock-step or the dashboard renders empty.
 */
export const METRIC_REQUESTS_TOTAL = 'dashboard_layout_requests_total';

/**
 * Prometheus histogram name: latency (seconds) of dashboard-layout HTTP
 * requests, partitioned by `operation`. Rendered by `MetricsService` as the
 * canonical `_bucket` / `_sum` / `_count` series consumed by the latency
 * panels in `ops/dashboards/dashboard-layout.json`.
 */
export const METRIC_LATENCY_SECONDS = 'dashboard_layout_latency_seconds';

/**
 * Shape of the Express request after this middleware has run: the generated
 * correlation id is attached under {@link CORRELATION_ID_REQUEST_KEY}. Kept as
 * a small, exported structural type so the controller can read the id in a
 * type-safe way without re-declaring the property.
 */
export type RequestWithCorrelationId = Request & {
  [CORRELATION_ID_REQUEST_KEY]?: string;
};

/**
 * Reads the correlation id previously attached to `request` by
 * {@link UserDashboardLayoutObservabilityMiddleware}. Returns `undefined` when
 * the middleware did not run (e.g. an isolated unit test that constructs the
 * controller directly), letting the caller fall back to generating its own id.
 */
export function getCorrelationId(request: unknown): string | undefined {
  return (request as RequestWithCorrelationId | null | undefined)?.[
    CORRELATION_ID_REQUEST_KEY
  ];
}

/**
 * Categorical `outcome` label values recorded on {@link METRIC_REQUESTS_TOTAL}.
 * Deliberately a tiny, bounded enumeration so the metric never breaches the
 * `MetricsService` cardinality guard.
 */
type RequestOutcome = 'success' | 'error' | 'unauthorized';

/**
 * `UserDashboardLayoutObservabilityMiddleware` — the single observability
 * boundary for the two dashboard-layout routes (`GET`/`PATCH
 * /api/v1/user/layout`), wired via `UserModule.configure(...)` with
 * `forRoutes(UserDashboardLayoutController)`.
 *
 * WHY A MIDDLEWARE (AAP § 0.6.1 / § 0.8.4 — Observability):
 *
 * The NestJS request lifecycle is: middleware → guards → interceptors → pipes
 * → route handler → exception filters. A response can therefore terminate
 * BEFORE the route handler ever runs:
 *
 *   - `AuthGuard('jwt')` rejects an unauthenticated request with `401`;
 *   - `HasPermissionGuard` rejects an under-privileged request with `403`;
 *   - the global `ValidationPipe` rejects an invalid body with `400`.
 *
 * On every one of those paths the controller body never executes, so any
 * correlation-id header / metric / log emitted from inside the handler is
 * silently lost — which is precisely the defect this middleware fixes. Being
 * the FIRST stage in the lifecycle, this middleware runs for ALL of the above
 * outcomes, so it can:
 *
 *   1. Generate one correlation id per request and set the
 *      `X-Correlation-ID` response header immediately (present on 200, 404,
 *      401, 403 and 400 alike — Express keeps headers set before a later
 *      exception is serialized).
 *   2. Record the two dashboard-layout metrics from a single `finish`
 *      listener that observes the FINAL status code — the only vantage point
 *      that also sees guard-rejected `401`/`403` (recorded as
 *      `outcome=unauthorized`), which controller/service-level recording could
 *      never capture.
 *   3. Emit one structured, correlation-id-tagged log line per request for
 *      EVERY outcome (2xx/4xx/5xx), enabling cross-boundary tracing on the
 *      error paths where operators need it most.
 *
 * CARDINALITY SAFETY: only the bounded categorical labels `operation`
 * (get/patch) and `outcome` (success/error/unauthorized) are attached to the
 * metrics — the high-cardinality correlation id is NEVER used as a metric
 * label (it lives only in the header and log lines), keeping the series count
 * far below the `MetricsService` cardinality ceiling.
 *
 * NO SENSITIVE DATA: the structured log records only the method, request path,
 * status code, derived outcome, elapsed time and correlation id — never the
 * `Authorization` header, request body, or user id — so no token / PII /
 * secret is ever written to the log stream.
 */
@Injectable()
export class UserDashboardLayoutObservabilityMiddleware implements NestMiddleware {
  private static readonly LOG_CONTEXT = 'UserDashboardLayoutObservability';

  public constructor(private readonly metricsService: MetricsService) {
    // Register the Prometheus `# HELP` descriptions once. `registerHelp` is
    // idempotent (the registry is a process singleton), so co-locating the
    // definitions with their sole emission site is safe and keeps the
    // `/api/v1/metrics` exposition self-describing.
    this.metricsService.registerHelp(
      METRIC_REQUESTS_TOTAL,
      'Total user dashboard-layout HTTP requests partitioned by operation ' +
        '(get/patch) and outcome (success/error/unauthorized).'
    );
    this.metricsService.registerHelp(
      METRIC_LATENCY_SECONDS,
      'Latency in seconds of user dashboard-layout HTTP requests partitioned ' +
        'by operation (get/patch).'
    );
  }

  /**
   * Generates the correlation id, sets the response header, exposes the id to
   * the downstream handler, and schedules the metric + log emission for when
   * the response finishes. Always calls `next()` synchronously so the request
   * proceeds into the guard chain without added latency.
   */
  public use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = randomUUID();

    // (1) Emit the header FIRST — before the guard/pipe boundary — so it is
    // present even when a guard (401/403) or the ValidationPipe (400) ends the
    // request before the controller runs.
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    // (2) Expose the id to the request-scoped controller (which injects
    // REQUEST) so the header, the finish-log below, and the service-layer
    // Prisma-error logs all reference the SAME id.
    (request as RequestWithCorrelationId)[CORRELATION_ID_REQUEST_KEY] =
      correlationId;

    const operation = this.resolveOperation(request.method);
    const startTimeNs = process.hrtime.bigint();

    // (3) Record metrics + a structured log exactly once, when the response is
    // fully flushed — this fires for EVERY terminal outcome (2xx/4xx/5xx),
    // including guard-rejected 401/403 that the controller never sees.
    response.on('finish', () => {
      // Only the two real layout verbs contribute to the metrics; other verbs
      // that may reach this path (e.g. a CORS `OPTIONS` pre-flight) are not
      // meaningful get/patch operations and are skipped to keep the series
      // clean. The header (already set above) still applies to them.
      if (operation === null) {
        return;
      }

      const elapsedSeconds =
        Number(process.hrtime.bigint() - startTimeNs) / 1e9;
      const statusCode = response.statusCode;
      const outcome = this.resolveOutcome(statusCode);

      this.metricsService.incrementCounter(METRIC_REQUESTS_TOTAL, 1, {
        operation,
        outcome
      });
      this.metricsService.observeHistogram(
        METRIC_LATENCY_SECONDS,
        elapsedSeconds,
        { operation }
      );

      this.log(correlationId, request, statusCode, outcome, elapsedSeconds);
    });

    next();
  }

  /**
   * Maps an HTTP method to the metric `operation` label. Returns `null` for
   * any verb other than `GET`/`PATCH` so non-layout traffic (e.g. a CORS
   * pre-flight) is excluded from the counter/histogram.
   */
  private resolveOperation(method: string): 'get' | 'patch' | null {
    const normalized = method.toUpperCase();

    if (normalized === 'GET') {
      return 'get';
    }

    if (normalized === 'PATCH') {
      return 'patch';
    }

    return null;
  }

  /**
   * Maps a final HTTP status code to the bounded `outcome` label:
   * `401`/`403` → `unauthorized` (auth/permission rejection), any other `>=
   * 400` → `error`, everything else → `success`. This keeps the label set at a
   * small, fixed cardinality and matches the outcome semantics the Grafana
   * dashboard's error-rate and success-rate panels expect.
   */
  private resolveOutcome(statusCode: number): RequestOutcome {
    if (statusCode === 401 || statusCode === 403) {
      return 'unauthorized';
    }

    if (statusCode >= 400) {
      return 'error';
    }

    return 'success';
  }

  /**
   * Emits one correlation-id-tagged structured log line for the completed
   * request, at a severity matching the outcome (`error` for 5xx, `warn` for
   * 4xx, `log` for success). Records only non-sensitive request metadata.
   */
  private log(
    correlationId: string,
    request: Request,
    statusCode: number,
    outcome: RequestOutcome,
    elapsedSeconds: number
  ): void {
    const message =
      `[${correlationId}] ${request.method} ${request.originalUrl} ` +
      `${statusCode} (outcome=${outcome}, ${elapsedSeconds.toFixed(4)}s)`;

    if (statusCode >= 500) {
      Logger.error(
        message,
        UserDashboardLayoutObservabilityMiddleware.LOG_CONTEXT
      );
    } else if (statusCode >= 400) {
      Logger.warn(
        message,
        UserDashboardLayoutObservabilityMiddleware.LOG_CONTEXT
      );
    } else {
      Logger.log(
        message,
        UserDashboardLayoutObservabilityMiddleware.LOG_CONTEXT
      );
    }
  }
}
