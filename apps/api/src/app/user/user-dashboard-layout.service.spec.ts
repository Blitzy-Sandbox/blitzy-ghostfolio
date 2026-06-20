import type { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Logger } from '@nestjs/common';
import { Prisma, UserDashboardLayout } from '@prisma/client';

import { UpdateUserDashboardLayoutDto } from './dtos/update-user-dashboard-layout.dto';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Replaces the real `PrismaService` with a minimal mock exposing only the two
 * `userDashboardLayout` delegate methods consumed by the service
 * (`findUnique`, `upsert`). All other Prisma methods are intentionally absent
 * so any regression that introduces an unscoped query — e.g. `create({})`
 * instead of `upsert({...})` — fails this spec immediately with a clear
 * `TypeError: ... is not a function`.
 *
 * Declared at module scope (hoisted above the import that resolves
 * `PrismaService`), mirroring the Ghostfolio convention in
 * `user-financial-profile.service.spec.ts`.
 */
jest.mock('@ghostfolio/api/services/prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => {
      return {
        userDashboardLayout: {
          findUnique: jest.fn(),
          upsert: jest.fn()
        }
      };
    })
  };
});

describe('UserDashboardLayoutService', () => {
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';
  // Public Prometheus metric names emitted by the service (must match the
  // runbook docs/observability/user-dashboard-layout.md verbatim).
  const METRIC_LATENCY_SECONDS = 'user_dashboard_layout_latency_seconds';
  const METRIC_REQUESTS_TOTAL = 'user_dashboard_layout_requests_total';
  const DTO: UpdateUserDashboardLayoutDto = {
    layoutData: {
      schemaVersion: 1,
      items: [
        {
          moduleKey: 'portfolio-overview',
          x: 0,
          y: 0,
          cols: 6,
          rows: 4
        }
      ]
    }
  };

  let metricsService: {
    incrementCounter: jest.Mock;
    observeHistogram: jest.Mock;
    registerHelp: jest.Mock;
  };
  let prismaService: PrismaService;
  let service: UserDashboardLayoutService;

  beforeEach(() => {
    // Lightweight MetricsService stand-in. The service only ever calls these
    // three methods; recording them lets the metric-emission cases below
    // assert the exact counter/histogram contract documented in the runbook.
    metricsService = {
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn(),
      registerHelp: jest.fn()
    };
    prismaService = new PrismaService(null);
    service = new UserDashboardLayoutService(
      prismaService,
      metricsService as unknown as MetricsService
    );
  });

  afterEach(() => {
    // Restore any `jest.spyOn(...)` spies (e.g. the `Logger.error` spy used by
    // the error-path tests below) so a failed assertion mid-test can never leak
    // a live spy into a subsequent `it(...)` block.
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------------
  // findByUserId — null handling + user scoping
  // ------------------------------------------------------------------------

  it('returns null when no layout exists for the user', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    const result = await service.findByUserId(USER_1_ID);

    // The controller maps `null` to HTTP 404 — the service must resolve with
    // `null` rather than throw on a missing record.
    expect(result).toBeNull();
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
  });

  it('scopes findByUserId to where: { userId } using the passed userId', async () => {
    const record = {
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout;
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(record);

    await service.findByUserId(USER_1_ID);

    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledTimes(
      1
    );
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
  });

  it("does not read another user's row when called with the authenticated user's ID", async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    const result = await service.findByUserId(USER_1_ID);

    expect(result).toBeNull();
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
    expect(
      prismaService.userDashboardLayout.findUnique
    ).not.toHaveBeenCalledWith({
      where: { userId: USER_2_ID }
    });
  });

  // ------------------------------------------------------------------------
  // upsertForUser — upsert (not create) + scoping + idempotency + payload
  // ------------------------------------------------------------------------

  it('calls prisma.userDashboardLayout.upsert with where: { userId } scoped to the authenticated user', async () => {
    const upsertedRecord = {
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout;
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce(upsertedRecord);

    const result = await service.upsertForUser(USER_1_ID, DTO);

    expect(result).toBe(upsertedRecord);
    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    expect(upsertArgs.where).toEqual({ userId: USER_1_ID });
    // The `create` branch attaches the row to the authenticated userId.
    expect(upsertArgs.create.userId).toBe(USER_1_ID);
    // The `update` branch omits `userId` (immutable, already in `where`).
    expect(upsertArgs.update.userId).toBeUndefined();
  });

  it('forwards layoutData into BOTH the create and update branches', async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);

    await service.upsertForUser(USER_1_ID, DTO);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    expect(upsertArgs.create.layoutData).toEqual(DTO.layoutData);
    expect(upsertArgs.update.layoutData).toEqual(DTO.layoutData);
  });

  it('is idempotent — calling upsertForUser twice uses prisma upsert, never create', async () => {
    (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mockResolvedValueOnce({
        createdAt: new Date(),
        layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
        updatedAt: new Date(),
        userId: USER_1_ID
      } as UserDashboardLayout)
      .mockResolvedValueOnce({
        createdAt: new Date(),
        layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
        updatedAt: new Date(),
        userId: USER_1_ID
      } as UserDashboardLayout);

    const first = await service.upsertForUser(USER_1_ID, DTO);
    const second = await service.upsertForUser(USER_1_ID, DTO);

    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(2);
    // The mock delegate exposes no `create`, so any fallback to
    // `prisma.userDashboardLayout.create(...)` would throw — proving the
    // existing-row path is `upsert`, not `create`.
    expect((prismaService.userDashboardLayout as any).create).toBeUndefined();
    expect(first.userId).toBe(USER_1_ID);
    expect(second.userId).toBe(USER_1_ID);
  });

  it("scopes upsertForUser to the explicitly passed userId, never another user's ID", async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_2_ID
    } as UserDashboardLayout);

    await service.upsertForUser(USER_2_ID, DTO);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    expect(upsertArgs.where).toEqual({ userId: USER_2_ID });
    expect(upsertArgs.where).not.toEqual({ userId: USER_1_ID });
    expect(upsertArgs.create.userId).toBe(USER_2_ID);
  });

  // ------------------------------------------------------------------------
  // error propagation + correlation-id logging
  //
  // These cases exercise the service's `try/catch` branches and its
  // `formatLogMessage(...)` helper, which the happy-path cases above do not
  // reach. They assert two contractual guarantees: (1) a Prisma failure is
  // surfaced (re-thrown) so the controller can map it to HTTP 500 rather than
  // being swallowed into a misleading `null`/empty result, and (2) the
  // structured `Logger.error` line is prefixed with `[<correlationId>]` when —
  // and only when — a correlation id was propagated from the controller
  // boundary (AAP § Observability). The `Logger.error` spy also suppresses the
  // otherwise-noisy error output during the test run.
  // ------------------------------------------------------------------------

  it('logs with the correlation-id prefix and re-throws when the Prisma read fails', async () => {
    const readError = new Error('connection terminated unexpectedly');
    const loggerErrorSpy = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockRejectedValueOnce(readError);

    // The error must propagate unchanged (same reference) — the service does
    // not translate it into a `null` result on the read path.
    await expect(service.findByUserId(USER_1_ID, 'corr-1234')).rejects.toBe(
      readError
    );

    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = loggerErrorSpy.mock.calls[0];
    // correlationId supplied → message is prefixed `[corr-1234] `.
    expect(message).toContain('[corr-1234]');
    expect(message).toContain(USER_1_ID);
    expect(context).toBe('UserDashboardLayoutService');
  });

  it('logs without a correlation-id prefix and re-throws when the Prisma upsert fails', async () => {
    const writeError = new Error('unique constraint violation');
    const loggerErrorSpy = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockRejectedValueOnce(writeError);

    await expect(service.upsertForUser(USER_1_ID, DTO)).rejects.toBe(
      writeError
    );

    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = loggerErrorSpy.mock.calls[0];
    // No correlationId argument → message is NOT prefixed with a `[...]` block.
    expect(message).not.toContain('[');
    expect(message).toContain(USER_1_ID);
    expect(context).toBe('UserDashboardLayoutService');
  });

  // ------------------------------------------------------------------------
  // Observability metrics (AAP § 0.8.2 / decision-log D-017)
  //
  // The service emits `user_dashboard_layout_requests_total` (counter,
  // labelled by operation + outcome) and `user_dashboard_layout_latency_seconds`
  // (histogram, labelled by operation) via the injected MetricsService, from a
  // single `finally` block per operation — so latency AND outcome are recorded
  // on EVERY path (success | not_found | error). These cases lock that contract
  // and the runbook claim that the specs assert the metric emissions.
  // ------------------------------------------------------------------------

  it('registers HELP text for both metrics on construction', () => {
    // `service` is constructed in `beforeEach`, which is where registerHelp
    // fires (once per metric).
    expect(metricsService.registerHelp).toHaveBeenCalledTimes(2);
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      'Total user dashboard layout endpoint requests handled by UserDashboardLayoutService, ' +
        'labeled by operation (get | patch) and outcome (success | not_found | error).'
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      'End-to-end wall-clock latency of UserDashboardLayoutService get/upsert operations in seconds, ' +
        'labeled by operation (get | patch).'
    );
  });

  it('emits get/success counter + latency on a layout hit', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);

    await service.findByUserId(USER_1_ID);

    expect(metricsService.incrementCounter).toHaveBeenCalledTimes(1);
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'get', outcome: 'success' }
    );
    expect(metricsService.observeHistogram).toHaveBeenCalledTimes(1);
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(Number),
      { operation: 'get' }
    );
  });

  it('emits get/not_found counter + latency when no layout exists', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.findByUserId(USER_1_ID);

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'get', outcome: 'not_found' }
    );
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(Number),
      { operation: 'get' }
    );
  });

  it('emits get/error counter + latency when the read throws', async () => {
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockRejectedValueOnce(new Error('db down'));

    await expect(service.findByUserId(USER_1_ID)).rejects.toThrow('db down');

    // The finally block records the outcome even though the call threw.
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'get', outcome: 'error' }
    );
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(Number),
      { operation: 'get' }
    );
  });

  it('emits patch/success counter + latency on a successful upsert', async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);

    await service.upsertForUser(USER_1_ID, DTO);

    expect(metricsService.incrementCounter).toHaveBeenCalledTimes(1);
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

  it('emits patch/error counter + latency when the upsert throws', async () => {
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockRejectedValueOnce(new Error('write failed'));

    await expect(service.upsertForUser(USER_1_ID, DTO)).rejects.toThrow(
      'write failed'
    );

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation: 'patch', outcome: 'error' }
    );
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(Number),
      { operation: 'patch' }
    );
  });
});
