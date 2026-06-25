import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import type { RequestWithUser } from '@ghostfolio/common/types';

import { HttpStatus, NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { UserDashboardLayout } from '@prisma/client';
import type { Response } from 'express';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Replaces the real service constructor with a mock exposing only the two
 * methods the controller delegates to. Hoisted above the import that resolves
 * `UserDashboardLayoutService`, matching the established Ghostfolio convention.
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
  const CORRELATION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const VALID_DTO: UpdateUserDashboardLayoutDto = {
    layout: [
      { cols: 4, moduleKey: 'portfolio-overview', rows: 2, x: 0, y: 0 },
      { cols: 8, moduleKey: 'holdings', rows: 4, x: 4, y: 0 }
    ]
  };

  let controller: UserDashboardLayoutController;
  let request: RequestWithUser;
  let userDashboardLayoutService: jest.Mocked<UserDashboardLayoutService>;

  const buildMockResponse = (): jest.Mocked<Response> => {
    return {
      setHeader: jest.fn()
    } as unknown as jest.Mocked<Response>;
  };

  function buildRequest(userId: string): RequestWithUser {
    return {
      user: {
        id: userId,
        permissions: []
      }
    } as unknown as RequestWithUser;
  }

  const buildRecord = (): UserDashboardLayout => {
    return {
      createdAt: new Date(),
      layoutData: VALID_DTO.layout as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    request = buildRequest(USER_1_ID);
    userDashboardLayoutService =
      new (UserDashboardLayoutService as any)() as jest.Mocked<UserDashboardLayoutService>;
    controller = new UserDashboardLayoutController(
      request,
      userDashboardLayoutService
    );
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/user/layout
  // -------------------------------------------------------------------------

  it('returns the persisted layout from GET (HTTP 200) and threads a correlationId', async () => {
    const record = buildRecord();
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(record);

    const result = await controller.getLayout(buildMockResponse());

    expect(result).toBe(record);
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledTimes(1);

    const [userIdArg, correlationIdArg] =
      userDashboardLayoutService.findByUserId.mock.calls[0];
    expect(userIdArg).toBe(USER_1_ID);
    expect(typeof correlationIdArg).toBe('string');
  });

  it('throws NotFoundException (HTTP 404) when no layout exists for the user', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    await expect(controller.getLayout(buildMockResponse())).rejects.toThrow(
      NotFoundException
    );

    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  it('surfaces HTTP 404 status and the userId in the NotFoundException', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.getLayout(buildMockResponse());
      throw new Error('Expected NotFoundException to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(
        HttpStatus.NOT_FOUND
      );
      expect((error as Error).message).toContain(USER_1_ID);
    }
  });

  it('derives userId exclusively from request.user.id on GET', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      buildRecord()
    );

    await controller.getLayout(buildMockResponse());

    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/user/layout
  // -------------------------------------------------------------------------

  it('returns the upserted layout from PATCH and delegates with (userId, dto.layout, correlationId)', async () => {
    const record = buildRecord();
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce(record);

    const result = await controller.updateLayout(
      VALID_DTO,
      buildMockResponse()
    );

    expect(result).toBe(record);
    expect(userDashboardLayoutService.upsertForUser).toHaveBeenCalledTimes(1);

    const [userIdArg, layoutArg, correlationIdArg] =
      userDashboardLayoutService.upsertForUser.mock.calls[0];
    expect(userIdArg).toBe(USER_1_ID);
    expect(layoutArg).toBe(VALID_DTO.layout);
    expect(typeof correlationIdArg).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Observability — X-Correlation-ID header (success + error paths)
  // -------------------------------------------------------------------------

  it('sets an RFC-4122-v4 X-Correlation-ID header on GET success', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      buildRecord()
    );
    const response = buildMockResponse();

    await controller.getLayout(response);

    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.stringMatching(CORRELATION_ID_PATTERN)
    );
  });

  it('sets the X-Correlation-ID header on GET even when 404 is thrown', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);
    const response = buildMockResponse();

    try {
      await controller.getLayout(response);
    } catch {
      // expected NotFoundException — the header must still have been emitted
    }

    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.stringMatching(CORRELATION_ID_PATTERN)
    );
  });

  it('sets an RFC-4122-v4 X-Correlation-ID header on PATCH', async () => {
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce(
      buildRecord()
    );
    const response = buildMockResponse();

    await controller.updateLayout(VALID_DTO, response);

    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.stringMatching(CORRELATION_ID_PATTERN)
    );
  });

  it('generates a distinct correlationId per request', async () => {
    userDashboardLayoutService.findByUserId.mockResolvedValue(null);
    const firstResponse = buildMockResponse();
    const secondResponse = buildMockResponse();

    try {
      await controller.getLayout(firstResponse);
    } catch {
      // expected 404
    }
    try {
      await controller.getLayout(secondResponse);
    } catch {
      // expected 404
    }

    const firstId = firstResponse.setHeader.mock.calls[0][1] as string;
    const secondId = secondResponse.setHeader.mock.calls[0][1] as string;
    expect(firstId).not.toBe(secondId);
  });

  // -------------------------------------------------------------------------
  // Rule 8 — guard stack on BOTH routes (unauthenticated -> 401)
  // -------------------------------------------------------------------------

  it("guards getLayout with AuthGuard('jwt') then HasPermissionGuard", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.getLayout
    );

    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    expect(guards[0]).toBe(AuthGuard('jwt'));
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  it("guards updateLayout with AuthGuard('jwt') then HasPermissionGuard", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.updateLayout
    );

    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    expect(guards[0]).toBe(AuthGuard('jwt'));
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  // -------------------------------------------------------------------------
  // Any-authenticated-user model — NO @HasPermission (deviation from template)
  // -------------------------------------------------------------------------

  it('does NOT declare @HasPermission on getLayout (any-authenticated-user model)', () => {
    const requiredPermission = new Reflector().get<unknown>(
      'has_permission',
      UserDashboardLayoutController.prototype.getLayout
    );

    expect(requiredPermission).toBeUndefined();
  });

  it('does NOT declare @HasPermission on updateLayout (any-authenticated-user model)', () => {
    const requiredPermission = new Reflector().get<unknown>(
      'has_permission',
      UserDashboardLayoutController.prototype.updateLayout
    );

    expect(requiredPermission).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // HTTP method + status-code wiring
  // -------------------------------------------------------------------------

  it('declares @HttpCode(HttpStatus.OK) on updateLayout', () => {
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      UserDashboardLayoutController.prototype.updateLayout
    );

    expect(httpCode).toBe(HttpStatus.OK);
  });

  it('wires getLayout as GET and updateLayout as PATCH', () => {
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
