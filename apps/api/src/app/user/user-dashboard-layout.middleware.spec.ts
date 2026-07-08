import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';

import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import {
  CORRELATION_ID_HEADER,
  METRIC_LATENCY_SECONDS,
  METRIC_REQUESTS_TOTAL,
  UserDashboardLayoutObservabilityMiddleware,
  getCorrelationId
} from './user-dashboard-layout.middleware';

/**
 * Tests for `UserDashboardLayoutObservabilityMiddleware` — the pre-guard
 * observability boundary for the dashboard-layout routes.
 *
 * Covers the QA FINAL OBSERVABILITY CHECKPOINT requirements the middleware is
 * responsible for:
 *
 *   - Issue 1/2 (metrics): `dashboard_layout_requests_total` counter (labels
 *     `operation` get/patch, `outcome` success/error/unauthorized) and
 *     `dashboard_layout_latency_seconds` histogram (label `operation`) are
 *     registered with help text and emitted from the response-`finish`
 *     listener for EVERY terminal outcome — including guard-rejected `401`/
 *     `403` (recorded as `outcome=unauthorized`), which the controller/service
 *     never observe.
 *   - Issue 3 (header): `X-Correlation-ID` (v4 UUID) is set on the response
 *     before `next()` — i.e. before the guard/pipe boundary — so it is present
 *     on the 401/400 paths.
 *   - Issue 4 (logging): a correlation-id-tagged structured log line is emitted
 *     per request, at a severity matching the outcome, with NO sensitive data.
 */
describe('UserDashboardLayoutObservabilityMiddleware', () => {
  const V4_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  let metricsService: jest.Mocked<
    Pick<
      MetricsService,
      'registerHelp' | 'incrementCounter' | 'observeHistogram'
    >
  >;
  let middleware: UserDashboardLayoutObservabilityMiddleware;

  beforeEach(() => {
    jest.restoreAllMocks();
    metricsService = {
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn(),
      registerHelp: jest.fn()
    };
    middleware = new UserDashboardLayoutObservabilityMiddleware(
      metricsService as unknown as MetricsService
    );
  });

  /**
   * Builds request/response/next test doubles, runs the middleware, and (when
   * `statusCode` is provided) fires the captured `finish` listener with that
   * final status so the metric/log assertions can run.
   */
  const run = ({
    method,
    statusCode,
    originalUrl = '/api/v1/user/layout',
    fireFinish = true,
    requestExtras = {}
  }: {
    method: string;
    statusCode?: number;
    originalUrl?: string;
    fireFinish?: boolean;
    requestExtras?: Record<string, unknown>;
  }) => {
    let finishListener: (() => void) | undefined;

    const request = {
      method,
      originalUrl,
      ...requestExtras
    } as unknown as Request;

    const response = {
      setHeader: jest.fn(),
      statusCode: statusCode ?? 200,
      on: jest.fn((event: string, listener: () => void) => {
        if (event === 'finish') {
          finishListener = listener;
        }

        return response;
      })
    } as unknown as jest.Mocked<Response> & { statusCode: number };

    const next = jest.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    if (fireFinish && finishListener) {
      finishListener();
    }

    return { next, request, response };
  };

  // ---------------------------------------------------------------------------
  // Help registration (Issue 1 — self-describing /metrics exposition)
  // ---------------------------------------------------------------------------

  it('registers Prometheus help text for both metrics on construction', () => {
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      expect.stringContaining('dashboard-layout')
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.stringContaining('Latency')
    );
  });

  // ---------------------------------------------------------------------------
  // Issue 3 — X-Correlation-ID header set before the guard/pipe boundary
  // ---------------------------------------------------------------------------

  it('sets a v4-UUID X-Correlation-ID header and calls next()', () => {
    const { next, response } = run({ method: 'GET', fireFinish: false });

    expect(response.setHeader).toHaveBeenCalledWith(
      CORRELATION_ID_HEADER,
      expect.any(String)
    );
    const headerValue = (response.setHeader as jest.Mock).mock
      .calls[0][1] as string;
    expect(headerValue).toMatch(V4_PATTERN);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('exposes the same correlation id on the request for downstream reuse', () => {
    const { request, response } = run({ method: 'GET', fireFinish: false });

    const headerValue = (response.setHeader as jest.Mock).mock
      .calls[0][1] as string;
    expect(getCorrelationId(request)).toBe(headerValue);
  });

  it('emits a distinct correlation id per request', () => {
    const first = run({ method: 'GET', fireFinish: false });
    const second = run({ method: 'GET', fireFinish: false });

    const firstId = (first.response.setHeader as jest.Mock).mock
      .calls[0][1] as string;
    const secondId = (second.response.setHeader as jest.Mock).mock
      .calls[0][1] as string;
    expect(firstId).toMatch(V4_PATTERN);
    expect(secondId).toMatch(V4_PATTERN);
    expect(firstId).not.toBe(secondId);
  });

  it('sets the header even on the 401 (guard-rejected) path', () => {
    const { response } = run({ method: 'GET', statusCode: 401 });

    expect(response.setHeader).toHaveBeenCalledWith(
      CORRELATION_ID_HEADER,
      expect.stringMatching(V4_PATTERN)
    );
  });

  // ---------------------------------------------------------------------------
  // Issue 1 — metrics recorded from the finish listener for every outcome
  // ---------------------------------------------------------------------------

  it('records get/success + latency on a 200 GET', () => {
    run({ method: 'GET', statusCode: 200 });

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'get', outcome: 'success' }
    );
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(Number),
      { operation: 'get' }
    );
  });

  it('records patch/success on a 200 PATCH', () => {
    run({ method: 'PATCH', statusCode: 200 });

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'patch', outcome: 'success' }
    );
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(Number),
      { operation: 'patch' }
    );
  });

  it('records outcome=unauthorized on a 401 (guard-rejected) request', () => {
    run({ method: 'GET', statusCode: 401 });

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'get', outcome: 'unauthorized' }
    );
  });

  it('records outcome=unauthorized on a 403 (permission-rejected) request', () => {
    run({ method: 'PATCH', statusCode: 403 });

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'patch', outcome: 'unauthorized' }
    );
  });

  it('records outcome=error on a 400 (validation-rejected) PATCH', () => {
    run({ method: 'PATCH', statusCode: 400 });

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'patch', outcome: 'error' }
    );
  });

  it('records outcome=error on a 404 GET (no saved layout)', () => {
    run({ method: 'GET', statusCode: 404 });

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'get', outcome: 'error' }
    );
  });

  it('records outcome=error on a 500 GET (server error)', () => {
    run({ method: 'GET', statusCode: 500 });

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'get', outcome: 'error' }
    );
  });

  it('never uses the correlation id as a metric label (cardinality safety)', () => {
    run({ method: 'GET', statusCode: 200 });

    const counterLabels = metricsService.incrementCounter.mock
      .calls[0][2] as Record<string, string>;
    const histogramLabels = metricsService.observeHistogram.mock
      .calls[0][2] as Record<string, string>;
    expect(Object.keys(counterLabels).sort()).toEqual(['operation', 'outcome']);
    expect(Object.keys(histogramLabels)).toEqual(['operation']);
  });

  it('does NOT record metrics for a non-get/patch verb (e.g. OPTIONS) but still sets the header', () => {
    const { response } = run({ method: 'OPTIONS', statusCode: 204 });

    expect(response.setHeader).toHaveBeenCalledWith(
      CORRELATION_ID_HEADER,
      expect.stringMatching(V4_PATTERN)
    );
    expect(metricsService.incrementCounter).not.toHaveBeenCalled();
    expect(metricsService.observeHistogram).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Issue 4 — correlation-id-tagged structured logging on all outcomes
  // ---------------------------------------------------------------------------

  it('logs a warn line carrying the correlation id on a 401', () => {
    const warnSpy = jest.spyOn(Logger, 'warn').mockImplementation(() => {});

    const { response } = run({ method: 'GET', statusCode: 401 });

    const correlationId = (response.setHeader as jest.Mock).mock
      .calls[0][1] as string;
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain(`[${correlationId}]`);
    expect(message).toContain('401');
    expect(message).toContain('outcome=unauthorized');
  });

  it('logs a warn line carrying the correlation id on a 400', () => {
    const warnSpy = jest.spyOn(Logger, 'warn').mockImplementation(() => {});

    run({ method: 'PATCH', statusCode: 400 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0] as string).toMatch(
      /^\[[0-9a-f-]{36}\].*400.*outcome=error/
    );
  });

  it('logs an error line on a 500', () => {
    const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(() => {});

    run({ method: 'PATCH', statusCode: 500 });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0] as string).toContain('500');
  });

  it('logs an info line on a 200 success', () => {
    const logSpy = jest.spyOn(Logger, 'log').mockImplementation(() => {});

    run({ method: 'GET', statusCode: 200 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0] as string).toContain('outcome=success');
  });

  it('never logs sensitive request data (Authorization header / body)', () => {
    const warnSpy = jest.spyOn(Logger, 'warn').mockImplementation(() => {});

    run({
      method: 'PATCH',
      statusCode: 401,
      requestExtras: {
        body: { password: 'super-secret-value', token: 'jwt-decoy-token' },
        headers: { authorization: 'Bearer leaked-jwt-token' }
      }
    });

    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).not.toContain('super-secret-value');
    expect(message).not.toContain('jwt-decoy-token');
    expect(message).not.toContain('leaked-jwt-token');
    expect(message.toLowerCase()).not.toContain('authorization');
  });
});
