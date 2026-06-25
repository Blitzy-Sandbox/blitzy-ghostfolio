import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  HttpStatus,
  INestApplication,
  Injectable,
  NotFoundException,
  ValidationPipe,
  VersioningType
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Reflector } from '@nestjs/core';
import { AuthGuard, PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserDashboardLayout } from '@prisma/client';
import type { Response } from 'express';
import { sign } from 'jsonwebtoken';
import { ExtractJwt, Strategy } from 'passport-jwt';

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

  it('adopts an inbound X-Correlation-ID header (client → API propagation)', async () => {
    const inboundId = 'client-supplied-correlation-id-123';
    // Build a request carrying an inbound correlation-id header.
    const requestWithHeader = {
      headers: { 'x-correlation-id': inboundId },
      user: { id: USER_1_ID, permissions: [] }
    } as unknown as RequestWithUser;
    const controllerWithHeader = new UserDashboardLayoutController(
      requestWithHeader,
      userDashboardLayoutService
    );
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      buildRecord()
    );
    const response = buildMockResponse();

    await controllerWithHeader.getLayout(response);

    // The inbound id is threaded into the service call ...
    const [, correlationIdArg] =
      userDashboardLayoutService.findByUserId.mock.calls[0];
    expect(correlationIdArg).toBe(inboundId);
    // ... and echoed back as the response header, rather than a fresh UUID.
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      inboundId
    );
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

/**
 * Minimal `passport-jwt` strategy registered under the `'jwt'` name for the
 * HTTP integration suite below. It mirrors the real `JwtStrategy`'s token
 * extraction (`Authorization: Bearer <jwt>`) and signing secret but omits the
 * heavy `UserService`/`PrismaService`/`ConfigurationService` dependency graph,
 * so the suite can exercise the actual `AuthGuard('jwt')` rejection path
 * without booting the whole application. A missing/invalid bearer token makes
 * passport fail authentication, which `AuthGuard('jwt')` surfaces as HTTP 401
 * before the route handler (or the `ValidationPipe`) runs.
 */
const TEST_JWT_SECRET = 'dashboard-layout-spec-secret';

@Injectable()
class TestJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  public constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: TEST_JWT_SECRET
    });
  }

  // The real strategy resolves the full user; the integration suite only needs
  // a principal with an `id` and `permissions` so `request.user.id` is defined
  // and `HasPermissionGuard` (a no-op without permission metadata) passes.
  public validate(payload: { id: string }) {
    return { id: payload.id, permissions: [] };
  }
}

describe('UserDashboardLayoutController (HTTP integration — Rule 8 401)', () => {
  const USER_ID = 'user-1-uuid';
  const LAYOUT_ROUTE = '/api/v1/user/layout';

  // A controllable service double; the controller delegates persistence to it.
  const serviceMock = {
    findByUserId: jest.fn(),
    upsertForUser: jest.fn()
  };

  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UserDashboardLayoutController],
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      providers: [
        TestJwtStrategy,
        { provide: UserDashboardLayoutService, useValue: serviceMock }
      ]
    }).compile();

    app = moduleRef.createNestApplication();

    // Replicate the production HTTP surface from apps/api/src/main.ts so the
    // route resolves at the real `/api/v1/user/layout` path and the guard
    // stack executes exactly as it does in production.
    app.setGlobalPrefix('api');
    app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true
      })
    );

    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === 'string' ? address : address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    // Close the HTTP server + Nest context so Jest reports no open handles.
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 for GET /api/v1/user/layout without a JWT', async () => {
    const response = await fetch(`${baseUrl}${LAYOUT_ROUTE}`, {
      method: 'GET'
    });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    // The guard short-circuits before the handler — no service call occurs.
    expect(serviceMock.findByUserId).not.toHaveBeenCalled();
  });

  it('returns 401 for PATCH /api/v1/user/layout without a JWT', async () => {
    const response = await fetch(`${baseUrl}${LAYOUT_ROUTE}`, {
      body: JSON.stringify({ layout: [] }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH'
    });

    // Guards run before the ValidationPipe, so a missing JWT yields 401
    // regardless of the (here valid) body.
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(serviceMock.upsertForUser).not.toHaveBeenCalled();
  });

  it('returns 401 for GET with a malformed (non-Bearer) Authorization header', async () => {
    const response = await fetch(`${baseUrl}${LAYOUT_ROUTE}`, {
      headers: { authorization: 'Token not-a-jwt' },
      method: 'GET'
    });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('does NOT return 401 for GET with a valid JWT (confirms the 401 is auth-driven)', async () => {
    serviceMock.findByUserId.mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: [{ cols: 4, moduleKey: 'holdings', rows: 2, x: 0, y: 0 }],
      updatedAt: new Date(),
      userId: USER_ID
    } as UserDashboardLayout);

    const token = sign({ id: USER_ID }, TEST_JWT_SECRET);
    const response = await fetch(`${baseUrl}${LAYOUT_ROUTE}`, {
      headers: { authorization: `Bearer ${token}` },
      method: 'GET'
    });

    // An authenticated request passes the guard stack and reaches the handler,
    // proving the unauthenticated 401s above are produced by the auth guard
    // rather than by a routing or wiring artifact.
    expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
    expect(response.status).toBe(HttpStatus.OK);
    expect(serviceMock.findByUserId).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String)
    );
  });
});
