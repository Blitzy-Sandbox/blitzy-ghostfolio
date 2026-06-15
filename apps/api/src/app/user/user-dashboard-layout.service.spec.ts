import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

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

  let metricsService: MetricsService;
  let prismaService: PrismaService;
  let service: UserDashboardLayoutService;

  beforeEach(() => {
    // Minimal `MetricsService` mock — the service registers HELP text in its
    // constructor and emits the counter/histogram from each `finally` block.
    metricsService = {
      registerHelp: jest.fn(),
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn()
    } as unknown as MetricsService;
    prismaService = new PrismaService(null);
    service = new UserDashboardLayoutService(metricsService, prismaService);
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
  // Observability — metric registration + per-operation emission
  // ------------------------------------------------------------------------

  const METRIC_REQUESTS_TOTAL = 'user_dashboard_layout_requests_total';
  const METRIC_LATENCY_SECONDS = 'user_dashboard_layout_latency_seconds';

  it('registers HELP text for both metrics in the constructor', () => {
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_REQUESTS_TOTAL,
      expect.stringContaining('Total user dashboard layout endpoint requests')
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      METRIC_LATENCY_SECONDS,
      expect.stringContaining('End-to-end wall-clock latency')
    );
  });

  it('emits get/success counter + latency histogram when a layout is found', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);

    await service.findByUserId(USER_1_ID);

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

  it('emits get/not_found counter + latency histogram when no layout exists', async () => {
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

  it('emits get/error counter + latency histogram and rethrows on a read failure', async () => {
    const error = new Error('db down');
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockRejectedValueOnce(error);

    await expect(service.findByUserId(USER_1_ID)).rejects.toThrow('db down');

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

  it('emits patch/success counter + latency histogram on a successful upsert', async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: DTO.layoutData as unknown as Prisma.JsonValue,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);

    await service.upsertForUser(USER_1_ID, DTO);

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

  it('emits patch/error counter + latency histogram and rethrows on an upsert failure', async () => {
    const error = new Error('write failed');
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockRejectedValueOnce(error);

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
