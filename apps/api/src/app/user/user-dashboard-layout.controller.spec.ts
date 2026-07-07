import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import { HttpStatus, NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { AuthGuard } from '@nestjs/passport';
import { UserDashboardLayout } from '@prisma/client';
import type { Response } from 'express';

import { DashboardLayoutDto } from './dtos/dashboard-layout.dto';
import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Replaces the real `UserDashboardLayoutService` constructor with a minimal
 * mock exposing only the two methods the controller consumes (`findByUserId`,
 * `upsertForUser`). The hoisted `jest.mock(...)` factory establishes the mock
 * before the controller import resolves the real class. No real Prisma access
 * occurs — service-layer Prisma scoping is verified in
 * `user-dashboard-layout.service.spec.ts`.
 */
jest.mock('./user-dashboard-layout.service', () => {
  return {
    UserDashboardLayoutService: jest.fn().mockImplementation(() => {
      return {
        findByUserId: jest.fn(),
        upsertForUser: jest.fn()
      };
    })
  };
});

/**
 * Tests for `UserDashboardLayoutController` covering the AAP § 0.8.3 scenarios:
 * GET returns the saved layout (200); GET returns 404 (NOT 500) when no
 * record; PATCH persists and returns the row (200); guard wiring so
 * unauthenticated → 401 and unauthorized → 403 (Rule 8); the JWT-derived
 * userId is always used (never a body value); `@HttpCode(HttpStatus.OK)` on
 * PATCH; and the `X-Correlation-ID` header carries a v4 UUID propagated to the
 * service.
 */
describe('UserDashboardLayoutController', () => {
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';
  const V4_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const VALID_DTO: DashboardLayoutDto = {
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

  let controller: UserDashboardLayoutController;
  let request: RequestWithUser;
  let userDashboardLayoutService: jest.Mocked<UserDashboardLayoutService>;

  const buildLayoutRecord = (userId: string): UserDashboardLayout => {
    return {
      createdAt: new Date(),
      layoutData: VALID_DTO as any,
      updatedAt: new Date(),
      userId
    };
  };

  const buildMockResponse = (): jest.Mocked<Response> => {
    return {
      setHeader: jest.fn()
    } as unknown as jest.Mocked<Response>;
  };

  function buildRequest(userId: string): RequestWithUser {
    return {
      user: {
        id: userId,
        permissions: [
          permissions.readDashboardLayout,
          permissions.updateDashboardLayout
        ]
      }
    } as unknown as RequestWithUser;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    request = buildRequest(USER_1_ID);
    userDashboardLayoutService = new (UserDashboardLayoutService as any)();
    controller = new UserDashboardLayoutController(
      request,
      userDashboardLayoutService
    );
  });

  // ---------------------------------------------------------------------------
  // PATCH — HTTP 200 contract + JWT-derived userId + correlationId propagation
  // ---------------------------------------------------------------------------

  it('returns the upserted UserDashboardLayout from PATCH (HTTP 200 contract)', async () => {
    const upsertedRecord = buildLayoutRecord(USER_1_ID);
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce(
      upsertedRecord
    );

    const result = await controller.updateDashboardLayout(
      VALID_DTO,
      buildMockResponse()
    );

    expect(result).toBe(upsertedRecord);
    expect(userDashboardLayoutService.upsertForUser).toHaveBeenCalledTimes(1);

    const upsertArgs = userDashboardLayoutService.upsertForUser.mock.calls[0];
    // Rule 8 / § 0.7.3: userId is JWT-derived; dto is the validated body.
    expect(upsertArgs[0]).toBe(USER_1_ID);
    expect(upsertArgs[1]).toBe(VALID_DTO);
    // correlationId propagated to the service as the third argument.
    expect(typeof upsertArgs[2]).toBe('string');
    expect(upsertArgs[2]).toMatch(V4_PATTERN);
  });

  // ---------------------------------------------------------------------------
  // GET — HTTP 404 (NOT 500) when no record
  // ---------------------------------------------------------------------------

  it('throws NotFoundException (HTTP 404, not 500) when no layout exists', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    await expect(
      controller.getDashboardLayout(buildMockResponse())
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledTimes(1);
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  it('returns an HTTP 404 with status NOT_FOUND and a generic, PII-safe message (no userId leak — CWE-200/209)', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.getDashboardLayout(buildMockResponse());
      fail('Expected NotFoundException to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(
        HttpStatus.NOT_FOUND
      );
      // SECURITY (CWE-200 / CWE-209): the 404 message MUST be generic and
      // MUST NOT embed the authenticated user's id (or any request-scoped
      // identifier). Requests are correlated via the `X-Correlation-ID`
      // header + structured server logs, not by leaking the userId into the
      // client-facing error body. This assertion is a regression guard
      // against re-introducing the identifier into the message.
      expect((error as Error).message).toBe('Dashboard layout not found');
      expect((error as Error).message).not.toContain(USER_1_ID);
    }
  });

  // ---------------------------------------------------------------------------
  // GET — HTTP 200 round-trip
  // ---------------------------------------------------------------------------

  it('returns the persisted UserDashboardLayout from GET (HTTP 200 round-trip)', async () => {
    const persistedRecord = buildLayoutRecord(USER_1_ID);
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      persistedRecord
    );

    const result = await controller.getDashboardLayout(buildMockResponse());

    expect(result).toBe(persistedRecord);
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  // ---------------------------------------------------------------------------
  // Observability — X-Correlation-ID header (v4 UUID) on both endpoints
  // ---------------------------------------------------------------------------

  it('sets an X-Correlation-ID response header (v4 UUID) on GET', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      buildLayoutRecord(USER_1_ID)
    );
    const httpResponse = buildMockResponse();

    await controller.getDashboardLayout(httpResponse);

    expect(httpResponse.setHeader).toHaveBeenCalledTimes(1);
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );
    const headerValue = httpResponse.setHeader.mock.calls[0][1] as string;
    expect(headerValue).toMatch(V4_PATTERN);
  });

  it('sets an X-Correlation-ID response header (v4 UUID) on PATCH', async () => {
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce(
      buildLayoutRecord(USER_1_ID)
    );
    const httpResponse = buildMockResponse();

    await controller.updateDashboardLayout(VALID_DTO, httpResponse);

    expect(httpResponse.setHeader).toHaveBeenCalledTimes(1);
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );
    const headerValue = httpResponse.setHeader.mock.calls[0][1] as string;
    expect(headerValue).toMatch(V4_PATTERN);
  });

  it('emits a fresh, distinct X-Correlation-ID per request (also on the 404 path)', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValue(null);
    const firstResponse = buildMockResponse();
    const secondResponse = buildMockResponse();

    try {
      await controller.getDashboardLayout(firstResponse);
    } catch {
      /* expected NotFoundException — header still emitted */
    }
    try {
      await controller.getDashboardLayout(secondResponse);
    } catch {
      /* expected NotFoundException — header still emitted */
    }

    const firstId = firstResponse.setHeader.mock.calls[0][1] as string;
    const secondId = secondResponse.setHeader.mock.calls[0][1] as string;
    expect(firstId).toMatch(V4_PATTERN);
    expect(secondId).toMatch(V4_PATTERN);
    expect(firstId).not.toBe(secondId);
  });

  // ---------------------------------------------------------------------------
  // Rule 8 — guard wiring (401 unauth via AuthGuard('jwt'), 403 via HasPermissionGuard)
  // ---------------------------------------------------------------------------

  it("registers AuthGuard('jwt') + HasPermissionGuard on getDashboardLayout (401/403 wiring)", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.getDashboardLayout
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    expect(guards[0]).toBe(AuthGuard('jwt'));
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  it("registers AuthGuard('jwt') + HasPermissionGuard on updateDashboardLayout (401/403 wiring)", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.updateDashboardLayout
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    expect(guards[0]).toBe(AuthGuard('jwt'));
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  // ---------------------------------------------------------------------------
  // Rule 8 — permission metadata (403 wiring)
  // ---------------------------------------------------------------------------

  it('declares @HasPermission(permissions.readDashboardLayout) on getDashboardLayout', () => {
    const required = new Reflector().get<string>(
      'has_permission',
      UserDashboardLayoutController.prototype.getDashboardLayout
    );
    expect(required).toBe(permissions.readDashboardLayout);
  });

  it('declares @HasPermission(permissions.updateDashboardLayout) on updateDashboardLayout', () => {
    const required = new Reflector().get<string>(
      'has_permission',
      UserDashboardLayoutController.prototype.updateDashboardLayout
    );
    expect(required).toBe(permissions.updateDashboardLayout);
  });

  it('rejects with HTTP 403 when HasPermissionGuard runs for a user lacking the permission', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue(permissions.readDashboardLayout);
    const guard = new HasPermissionGuard(reflector);
    const context = new ExecutionContextHost([
      { user: { permissions: [] } } as any
    ]);

    expect(() => guard.canActivate(context as any)).toThrow();
  });

  // ---------------------------------------------------------------------------
  // § 0.7.3 — JWT-derived userId isolation (never a body value)
  // ---------------------------------------------------------------------------

  it('uses request.user.id (USER_1_ID) for GET, never a different user', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.getDashboardLayout(buildMockResponse());
    } catch {
      /* expected NotFoundException */
    }

    expect(userDashboardLayoutService.findByUserId.mock.calls[0][0]).toBe(
      USER_1_ID
    );
    expect(userDashboardLayoutService.findByUserId.mock.calls[0][0]).not.toBe(
      USER_2_ID
    );
  });

  it('uses request.user.id (USER_2_ID) for PATCH, never a body-forged userId', async () => {
    const user2Request = buildRequest(USER_2_ID);
    const user2Controller = new UserDashboardLayoutController(
      user2Request,
      userDashboardLayoutService
    );
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce(
      buildLayoutRecord(USER_2_ID)
    );

    await user2Controller.updateDashboardLayout(VALID_DTO, buildMockResponse());

    const upsertArgs = userDashboardLayoutService.upsertForUser.mock.calls[0];
    expect(upsertArgs[0]).toBe(USER_2_ID);
    expect(upsertArgs[0]).not.toBe(USER_1_ID);
  });

  // ---------------------------------------------------------------------------
  // Deterministic status + verb wiring
  // ---------------------------------------------------------------------------

  it('declares @HttpCode(HttpStatus.OK) (HTTP 200, not 201) on updateDashboardLayout', () => {
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      UserDashboardLayoutController.prototype.updateDashboardLayout
    );
    expect(httpCode).toBe(HttpStatus.OK);
  });

  it('declares HTTP method decorators on both endpoints (verb wiring)', () => {
    const getMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserDashboardLayoutController.prototype.getDashboardLayout
    );
    const patchMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserDashboardLayoutController.prototype.updateDashboardLayout
    );
    expect(getMethod).toBe(RequestMethod.GET);
    expect(patchMethod).toBe(RequestMethod.PATCH);
  });
});
