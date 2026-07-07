import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Logger } from '@nestjs/common';
import { UserDashboardLayout } from '@prisma/client';

import { DashboardLayoutDto } from './dtos/dashboard-layout.dto';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Replaces the real `PrismaService` constructor with a minimal mock that
 * exposes only the two `userDashboardLayout` delegate methods consumed by
 * `UserDashboardLayoutService` (`findUnique` and `upsert`). All other Prisma
 * methods are intentionally absent so any regression that introduces an
 * unscoped query — e.g. `findFirst({})`, `findMany({})`, or `create({})`
 * instead of `upsert({...})` — fails this spec immediately with a clear
 * `TypeError: ... is not a function` rather than silently passing.
 *
 * The mock is declared at module-scope so `jest.mock(...)` is hoisted above
 * the import that resolves `PrismaService`, mirroring the Ghostfolio
 * convention used by the sibling `user-financial-profile.service.spec.ts`.
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

/**
 * Unit tests for `UserDashboardLayoutService`.
 *
 * Verifies the security-critical guarantees from AAP § 0.7.3 (Rule 8 —
 * layout authorization):
 *   1. Every Prisma call contains `where: { userId }` scoped to the explicit
 *      `userId` argument.
 *   2. User-1 cannot read/write user-2's row — the service never widens the
 *      `where` clause.
 *   3. `upsertForUser` is idempotent — it delegates to Prisma `upsert`, never
 *      `create`.
 *   4. The entire validated DTO is persisted as the `layoutData` JSON column.
 */
describe('UserDashboardLayoutService', () => {
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';

  const buildDto = (): DashboardLayoutDto => {
    return {
      items: [
        { cols: 4, rows: 4, type: 'portfolio-overview', x: 0, y: 0 },
        {
          cols: 4,
          minItemCols: 2,
          minItemRows: 2,
          rows: 6,
          type: 'ai-chat',
          x: 4,
          y: 0
        }
      ]
    };
  };

  let prismaService: PrismaService;
  let service: UserDashboardLayoutService;

  beforeEach(() => {
    prismaService = new PrismaService(null);
    service = new UserDashboardLayoutService(prismaService);
  });

  afterEach(() => {
    // Restore any `jest.spyOn` spies (e.g. the `Logger.error` spy used by the
    // error-propagation specs below) so a spy created in one test never leaks
    // into the next. The module-level `jest.mock(...)` of `PrismaService` is
    // unaffected (it is a module factory mock, not a `jest.spyOn` spy).
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // findByUserId — Rule 8 scoping + null handling
  // ---------------------------------------------------------------------------

  it('returns null when no layout exists for the user', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    const result = await service.findByUserId(USER_1_ID);

    expect(result).toBeNull();
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
  });

  it('scopes findByUserId to where: { userId } using the passed userId', async () => {
    const record: UserDashboardLayout = {
      createdAt: new Date(),
      layoutData: buildDto() as any,
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
  });

  it("does not read another user's row when called with the authenticated user's ID", async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.findByUserId(USER_1_ID);

    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
    expect(
      prismaService.userDashboardLayout.findUnique
    ).not.toHaveBeenCalledWith({
      where: { userId: USER_2_ID }
    });
  });

  // ---------------------------------------------------------------------------
  // upsertForUser — Rule 8 scoping + idempotency + payload persistence
  // ---------------------------------------------------------------------------

  it('calls prisma.userDashboardLayout.upsert with where/create/update scoped to the authenticated user', async () => {
    const dto = buildDto();
    const upsertedRecord: UserDashboardLayout = {
      createdAt: new Date(),
      layoutData: dto as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce(upsertedRecord);

    const result = await service.upsertForUser(USER_1_ID, dto);

    expect(result).toBe(upsertedRecord);
    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    // Rule 8: the `where` clause is scoped to the JWT-derived userId.
    expect(upsertArgs.where).toEqual({ userId: USER_1_ID });
    // The `create` branch attaches the row to the authenticated userId.
    expect(upsertArgs.create.userId).toBe(USER_1_ID);
    expect(upsertArgs.create.layoutData).toEqual(dto);
    // The `update` branch omits `userId` (immutable + implied by `where`).
    expect(upsertArgs.update.userId).toBeUndefined();
    expect(upsertArgs.update.layoutData).toEqual(dto);
  });

  it('is idempotent — calling upsertForUser twice uses prisma upsert, not create', async () => {
    const dto = buildDto();
    (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mockResolvedValueOnce({
        createdAt: new Date(),
        layoutData: dto as any,
        updatedAt: new Date(),
        userId: USER_1_ID
      } as UserDashboardLayout)
      .mockResolvedValueOnce({
        createdAt: new Date(),
        layoutData: dto as any,
        updatedAt: new Date(),
        userId: USER_1_ID
      } as UserDashboardLayout);

    const first = await service.upsertForUser(USER_1_ID, dto);
    const second = await service.upsertForUser(USER_1_ID, dto);

    // Because the mock delegate exposes only `findUnique`/`upsert`, any
    // fallback to `prisma.userDashboardLayout.create(...)` would throw and
    // fail — a structural guarantee that the write path is `upsert`.
    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(2);
    expect((prismaService.userDashboardLayout as any).create).toBeUndefined();
    expect(first.userId).toBe(USER_1_ID);
    expect(second.userId).toBe(USER_1_ID);
  });

  it("scopes upsertForUser to the explicitly passed userId, never another user's ID", async () => {
    const dto = buildDto();
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: dto as any,
      updatedAt: new Date(),
      userId: USER_2_ID
    } as UserDashboardLayout);

    await service.upsertForUser(USER_2_ID, dto);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    // Authorization-isolation: scoped to USER_2_ID, never USER_1_ID.
    expect(upsertArgs.where).toEqual({ userId: USER_2_ID });
    expect(upsertArgs.where).not.toEqual({ userId: USER_1_ID });
    expect(upsertArgs.create.userId).toBe(USER_2_ID);
  });

  it('persists the entire validated DTO payload as layoutData in both branches', async () => {
    const dto = buildDto();
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: dto as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);

    await service.upsertForUser(USER_1_ID, dto);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    // The whole DTO (`{ items: [...] }`) is stored verbatim as layoutData.
    expect(upsertArgs.create.layoutData).toEqual(dto);
    expect(upsertArgs.update.layoutData).toEqual(dto);
    expect(upsertArgs.create.layoutData.items).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Error propagation + structured logging (observability — AAP § 0.6.1 /
  // § 0.8.4). These specs exercise the `catch` branches so that a Prisma
  // failure is surfaced to the controller (which maps it to HTTP 500) rather
  // than being swallowed, and assert the correlation-id-aware log format
  // produced by the private `formatLogMessage` helper.
  // ---------------------------------------------------------------------------

  it('rethrows and logs without a correlation-id prefix when findByUserId fails', async () => {
    const failure = new Error('connection reset by peer');
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockRejectedValueOnce(failure);
    const loggerSpy = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);

    // The service MUST rethrow the identical error object so the controller
    // can distinguish an infrastructure failure (HTTP 500) from a missing
    // record (`null` → HTTP 404).
    await expect(service.findByUserId(USER_1_ID)).rejects.toBe(failure);

    // A single structured error line is emitted under the service context.
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    const [message, context] = loggerSpy.mock.calls[0] as [string, string];
    expect(context).toBe('UserDashboardLayoutService');
    // The failure log intentionally omits the userId (PII-safe): the message
    // carries the operation stem and the underlying error, not the user id.
    expect(message).toContain('Failed to read UserDashboardLayout');
    expect(message).toContain('connection reset by peer');
    // With NO correlationId the message carries no `[...]` prefix.
    expect(message).not.toMatch(/^\[/);
  });

  it('rethrows and logs with a correlation-id prefix when upsertForUser fails', async () => {
    const failure = new Error('unique constraint violation');
    const correlationId = 'corr-abc-123';
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockRejectedValueOnce(failure);
    const loggerSpy = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);

    await expect(
      service.upsertForUser(USER_1_ID, buildDto(), correlationId)
    ).rejects.toBe(failure);

    expect(loggerSpy).toHaveBeenCalledTimes(1);
    const [message, context] = loggerSpy.mock.calls[0] as [string, string];
    expect(context).toBe('UserDashboardLayoutService');
    // The propagated correlationId prefixes the structured message so a
    // single request can be traced end-to-end across the service boundary.
    expect(message).toContain(`[${correlationId}] `);
    // PII-safe: the upsert failure log omits the userId, carrying only the
    // operation stem and the underlying error text.
    expect(message).toContain('Failed to upsert UserDashboardLayout');
    expect(message).toContain('unique constraint violation');
  });
});
