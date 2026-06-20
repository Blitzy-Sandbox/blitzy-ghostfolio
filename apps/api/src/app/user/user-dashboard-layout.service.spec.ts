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

  let prismaService: PrismaService;
  let service: UserDashboardLayoutService;

  beforeEach(() => {
    prismaService = new PrismaService(null);
    service = new UserDashboardLayoutService(prismaService);
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
});
