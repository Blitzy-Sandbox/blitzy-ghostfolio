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

import { UpdateUserDashboardLayoutDto } from './dtos/update-user-dashboard-layout.dto';
import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Replaces the real `UserDashboardLayoutService` with a minimal mock exposing
 * only the two methods the controller consumes (`findByUserId`,
 * `upsertForUser`). Hoisted so the mock is established before the controller
 * import resolves the real class. No real Prisma access occurs here — service
 * scoping is verified by `user-dashboard-layout.service.spec.ts`.
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

describe('UserDashboardLayoutController', () => {
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';
  const VALID_DTO: UpdateUserDashboardLayoutDto = {
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

  let controller: UserDashboardLayoutController;
  let request: RequestWithUser;
  let userDashboardLayoutService: jest.Mocked<UserDashboardLayoutService>;

  // Typed minimal Express `Response` mock: the cast is laundered through a
  // concrete `setHeader` mock signature so the F6 correlation-ID assertions can
  // read `.mock.calls[0][1]` as a `string` without scattering `no-unsafe-*`
  // accesses (the real controller only ever touches `response.setHeader`).
  const buildMockResponse = () => {
    return {
      setHeader: jest.fn()
    } as unknown as Response & {
      setHeader: jest.Mock<(name: string, value: string) => void>;
    };
  };

  function buildRequest(userId: string): RequestWithUser {
    return {
      user: {
        id: userId,
        permissions: [
          permissions.readUserDashboardLayout,
          permissions.updateUserDashboardLayout
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

  // ------------------------------------------------------------------------
  // PATCH — HTTP 200, returns upserted row, JWT-derived userId
  // ------------------------------------------------------------------------

  it('returns the upserted layout from PATCH and delegates with JWT userId + dto', async () => {
    const upsertedRecord = {
      createdAt: new Date(),
      layoutData: VALID_DTO.layoutData as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout;
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce(
      upsertedRecord
    );

    const httpResponse = buildMockResponse();
    const result = await controller.updateLayout(VALID_DTO, httpResponse);

    expect(result).toBe(upsertedRecord);
    expect(userDashboardLayoutService.upsertForUser).toHaveBeenCalledTimes(1);

    const upsertArgs = userDashboardLayoutService.upsertForUser.mock.calls[0];
    // Rule: userId is JWT-derived (request.user.id), dto is forwarded as-is.
    expect(upsertArgs[0]).toBe(USER_1_ID);
    expect(upsertArgs[1]).toBe(VALID_DTO);
    // Observability (F6): the SAME correlation id emitted as the
    // X-Correlation-ID response header is propagated to the service as the 3rd
    // argument, so the service's [<correlationId>] logs tie back to the header.
    const correlationId = httpResponse.setHeader.mock.calls[0][1] as string;
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(upsertArgs[2]).toBe(correlationId);
  });

  // ------------------------------------------------------------------------
  // GET — HTTP 404 (not 500) when null, HTTP 200 round-trip
  // ------------------------------------------------------------------------

  it('throws NotFoundException (HTTP 404, not 500) when no layout exists', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    await expect(
      controller.getLayout(buildMockResponse())
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledTimes(1);
    // findByUserId now receives the propagated correlation id as the 2nd arg.
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  it('returns a 404 message identifying the user when no layout exists', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.getLayout(buildMockResponse());
      fail('Expected NotFoundException to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(
        HttpStatus.NOT_FOUND
      );
      expect((error as Error).message).toContain(USER_1_ID);
    }
  });

  it('returns the persisted layout from GET (HTTP 200 round-trip)', async () => {
    const persistedRecord = {
      createdAt: new Date(),
      layoutData: VALID_DTO.layoutData as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout;
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      persistedRecord
    );

    const result = await controller.getLayout(buildMockResponse());

    expect(result).toBe(persistedRecord);
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  // ------------------------------------------------------------------------
  // X-Correlation-ID header (Observability)
  // ------------------------------------------------------------------------

  it('sets a v4 X-Correlation-ID header on GET', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: VALID_DTO.layoutData as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);
    const httpResponse = buildMockResponse();

    await controller.getLayout(httpResponse);

    expect(httpResponse.setHeader).toHaveBeenCalledTimes(1);
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );
    const headerValue = httpResponse.setHeader.mock.calls[0][1] as string;
    expect(headerValue).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('sets a v4 X-Correlation-ID header on PATCH', async () => {
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: VALID_DTO.layoutData as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);
    const httpResponse = buildMockResponse();

    await controller.updateLayout(VALID_DTO, httpResponse);

    expect(httpResponse.setHeader).toHaveBeenCalledTimes(1);
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );
    const headerValue = httpResponse.setHeader.mock.calls[0][1] as string;
    expect(headerValue).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('propagates the same correlationId into findByUserId on GET', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: VALID_DTO.layoutData as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as UserDashboardLayout);
    const httpResponse = buildMockResponse();

    await controller.getLayout(httpResponse);

    // The 2nd arg to the service is the SAME v4 id emitted as X-Correlation-ID,
    // so service logs correlate with the header the client observed (F6).
    const correlationId = httpResponse.setHeader.mock.calls[0][1] as string;
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const findArgs = userDashboardLayoutService.findByUserId.mock.calls[0];
    expect(findArgs[0]).toBe(USER_1_ID);
    expect(findArgs[1]).toBe(correlationId);
  });

  it('generates distinct correlationIds across consecutive requests', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValue(null);
    const firstResponse = buildMockResponse();
    const secondResponse = buildMockResponse();

    try {
      await controller.getLayout(firstResponse);
    } catch {
      /* expected NotFoundException — header still emitted */
    }
    try {
      await controller.getLayout(secondResponse);
    } catch {
      /* expected NotFoundException — header still emitted */
    }

    const firstId = firstResponse.setHeader.mock.calls[0][1] as string;
    const secondId = secondResponse.setHeader.mock.calls[0][1] as string;
    expect(firstId).not.toBe(secondId);
  });

  // ------------------------------------------------------------------------
  // Rule: JWT-derived userId isolation
  // ------------------------------------------------------------------------

  it('uses request.user.id (USER_1_ID) for GET, never a different user', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.getLayout(buildMockResponse());
    } catch {
      /* expected NotFoundException */
    }

    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
    expect(userDashboardLayoutService.findByUserId).not.toHaveBeenCalledWith(
      USER_2_ID,
      expect.any(String)
    );
  });

  it('uses request.user.id (USER_2_ID) for PATCH, never a different user', async () => {
    const user2Request = buildRequest(USER_2_ID);
    const user2Controller = new UserDashboardLayoutController(
      user2Request,
      userDashboardLayoutService
    );
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: VALID_DTO.layoutData as any,
      updatedAt: new Date(),
      userId: USER_2_ID
    } as UserDashboardLayout);

    await user2Controller.updateLayout(VALID_DTO, buildMockResponse());

    const upsertArgs = userDashboardLayoutService.upsertForUser.mock.calls[0];
    expect(upsertArgs[0]).toBe(USER_2_ID);
    expect(upsertArgs[0]).not.toBe(USER_1_ID);
  });

  // ------------------------------------------------------------------------
  // Decorator metadata — guards, permissions, status code, verbs
  // ------------------------------------------------------------------------

  it("registers AuthGuard('jwt') + HasPermissionGuard on getLayout", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.getLayout
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    expect(guards[0]).toBe(AuthGuard('jwt'));
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  it("registers AuthGuard('jwt') + HasPermissionGuard on updateLayout", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.updateLayout
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    expect(guards[0]).toBe(AuthGuard('jwt'));
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  it('declares @HasPermission(readUserDashboardLayout) on getLayout', () => {
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      UserDashboardLayoutController.prototype.getLayout
    );
    expect(required).toBe(permissions.readUserDashboardLayout);
  });

  it('declares @HasPermission(updateUserDashboardLayout) on updateLayout', () => {
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      UserDashboardLayoutController.prototype.updateLayout
    );
    expect(required).toBe(permissions.updateUserDashboardLayout);
  });

  it('rejects with HTTP 403 when HasPermissionGuard runs for a user lacking the permission', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue(permissions.readUserDashboardLayout);
    const guard = new HasPermissionGuard(reflector);
    const context = new ExecutionContextHost([
      { user: { permissions: [] } } as any
    ]);

    expect(() => guard.canActivate(context as any)).toThrow();
  });

  it('declares @HttpCode(HttpStatus.OK) (HTTP 200, not 201) on updateLayout', () => {
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      UserDashboardLayoutController.prototype.updateLayout
    );
    expect(httpCode).toBe(HttpStatus.OK);
  });

  it('declares GET and PATCH HTTP-method decorators on the endpoints', () => {
    const getMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserDashboardLayoutController.prototype.getLayout
    );
    const patchMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserDashboardLayoutController.prototype.updateLayout
    );
    expect(getMethod).toBe(RequestMethod.GET);
    expect(patchMethod).toBe(RequestMethod.PATCH);
  });
});
