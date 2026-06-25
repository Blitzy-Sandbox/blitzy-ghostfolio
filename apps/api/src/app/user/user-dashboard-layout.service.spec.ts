import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { DashboardLayoutItem } from '@ghostfolio/common/interfaces';

import { UserDashboardLayout } from '@prisma/client';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Replaces the real `PrismaService` constructor with a minimal mock exposing
 * ONLY the two `userDashboardLayout` delegate methods consumed by
 * `UserDashboardLayoutService` (`findUnique` and `upsert`). All other Prisma
 * methods are intentionally absent so any regression that introduces an
 * unscoped query — e.g. `create({})` instead of `upsert({...})` — fails this
 * spec immediately with a clear `TypeError: ... is not a function`.
 *
 * The mock is declared with `jest.mock(...)` at module scope so it is hoisted
 * above the import that resolves `PrismaService`, matching the established
 * Ghostfolio convention.
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
  const LAYOUT: DashboardLayoutItem[] = [
    { cols: 4, moduleKey: 'portfolio-overview', rows: 2, x: 0, y: 0 },
    { cols: 8, moduleKey: 'holdings', rows: 4, x: 4, y: 0 }
  ];

  const METRIC_REQUESTS_TOTAL = 'user_dashboard_layout_requests_total';
  const METRIC_LATENCY_SECONDS = 'user_dashboard_layout_latency_seconds';

  let metricsService: jest.Mocked<
    Pick<
      MetricsService,
      'incrementCounter' | 'observeHistogram' | 'registerHelp'
    >
  >;
  let prismaService: PrismaService;
  let service: UserDashboardLayoutService;

  beforeEach(() => {
    // Re-create all collaborators per test so mock call history is never
    // carried across `it(...)` blocks.
    metricsService = {
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn(),
      registerHelp: jest.fn()
    };
    prismaService = new PrismaService(null);
    service = new UserDashboardLayoutService(
      metricsService as unknown as MetricsService,
      prismaService
    );
  });

  // Convenience: assert the request counter was incremented once with the
  // given fixed-cardinality labels and the latency histogram once for the
  // operation. Keeps the per-test metric assertions terse and consistent.
  const expectMetrics = (
    operation: 'read' | 'write',
    outcome: 'success' | 'not_found' | 'error'
  ) => {
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      1,
      { operation, outcome }
    );
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(Number),
      { operation }
    );
  };

  it('registers metric HELP descriptions on construction', () => {
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      expect.any(String)
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // findByUserId — null handling + Rule 8 user scoping
  // -------------------------------------------------------------------------

  it('returns null when no dashboard layout exists for the user', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    const result = await service.findByUserId(USER_1_ID);

    // The controller maps `null` to HTTP 404, so the service MUST resolve
    // with `null` rather than throw on a missing record.
    expect(result).toBeNull();
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
    // A missing record is observed as a `not_found` read outcome, not an error.
    expectMetrics('read', 'not_found');
  });

  it('scopes findByUserId to where: { userId } using the passed userId', async () => {
    const record: UserDashboardLayout = {
      createdAt: new Date(),
      layoutData: LAYOUT as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(record);

    const result = await service.findByUserId(USER_1_ID);

    expect(result).toBe(record);
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledTimes(
      1
    );
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
    // A returned record is observed as a `success` read outcome.
    expectMetrics('read', 'success');
  });

  it("does not query another user's row when called with the authenticated user's ID", async () => {
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

  // -------------------------------------------------------------------------
  // upsertForUser — Rule 8 scoping + JSONB persistence + idempotency
  // -------------------------------------------------------------------------

  it('upserts scoped to where: { userId } and persists the layout into layoutData', async () => {
    const upsertedRecord: UserDashboardLayout = {
      createdAt: new Date(),
      layoutData: LAYOUT as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce(upsertedRecord);

    const result = await service.upsertForUser(USER_1_ID, LAYOUT);

    expect(result).toBe(upsertedRecord);
    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    // Rule 8: the `where` clause is scoped to the supplied userId.
    expect(upsertArgs.where).toEqual({ userId: USER_1_ID });
    // The `create` branch attaches the row to the authenticated userId and
    // persists the array verbatim into the `layoutData` JSONB column.
    expect(upsertArgs.create.userId).toBe(USER_1_ID);
    expect(upsertArgs.create.layoutData).toEqual(LAYOUT);
    // The `update` branch carries the same JSON payload and omits `userId`.
    expect(upsertArgs.update.layoutData).toEqual(LAYOUT);
    expect(upsertArgs.update.userId).toBeUndefined();
    // A completed upsert is observed as a `success` write outcome.
    expectMetrics('write', 'success');
  });

  it('is idempotent — calling upsertForUser twice uses prisma upsert, never create', async () => {
    const record: UserDashboardLayout = {
      createdAt: new Date(),
      layoutData: LAYOUT as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce(record);

    const first = await service.upsertForUser(USER_1_ID, LAYOUT);
    const second = await service.upsertForUser(USER_1_ID, LAYOUT);

    // Both calls delegate to `upsert`; the mock exposes no `create`, so any
    // fallback to `create` would throw — making this a structural guarantee.
    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(2);
    expect((prismaService.userDashboardLayout as any).create).toBeUndefined();
    expect(first.userId).toBe(USER_1_ID);
    expect(second.userId).toBe(USER_1_ID);
  });

  it("scopes upsertForUser to the explicitly passed userId, never another user's ID", async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: LAYOUT as any,
      updatedAt: new Date(),
      userId: USER_2_ID
    } as UserDashboardLayout);

    await service.upsertForUser(USER_2_ID, LAYOUT);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    expect(upsertArgs.where).toEqual({ userId: USER_2_ID });
    expect(upsertArgs.where).not.toEqual({ userId: USER_1_ID });
    expect(upsertArgs.create.userId).toBe(USER_2_ID);
  });

  // -------------------------------------------------------------------------
  // Error paths — rethrow + `error` outcome metric emission
  // -------------------------------------------------------------------------

  it('rethrows and records a read error metric when findUnique rejects', async () => {
    const failure = new Error('db down');
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockRejectedValueOnce(failure);

    await expect(service.findByUserId(USER_1_ID)).rejects.toThrow(failure);

    // The failure is observed as a `read`/`error` outcome and the latency
    // histogram is still recorded via the `finally` block.
    expectMetrics('read', 'error');
  });

  it('rethrows and records a write error metric when upsert rejects', async () => {
    const failure = new Error('write conflict');
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockRejectedValueOnce(failure);

    await expect(service.upsertForUser(USER_1_ID, LAYOUT)).rejects.toThrow(
      failure
    );

    expectMetrics('write', 'error');
  });
});
