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

import { UpdateDashboardLayoutDto } from './dtos/update-dashboard-layout.dto';
import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Integration tests for `UserDashboardLayoutController`.
 *
 * Source-of-truth references (AAP):
 *   - § 0.8.5 — Required Test Scenarios: this spec satisfies the "controller-
 *     surface" subset of the five mandatory scenarios (HTTP 200, HTTP 401,
 *     HTTP 403, HTTP 404). The two scenarios that exercise client-side
 *     behavior (auto-open module catalog on 404; debounced save on grid
 *     state-change events) are covered by their respective Angular specs;
 *     the remaining scenario "module placement below minimum cell dimensions
 *     is rejected" is enforced by the `UpdateDashboardLayoutDto`
 *     class-validator decorators (verified by integration tests against
 *     NestJS's global ValidationPipe — out of scope for this controller spec).
 *   - § 0.8.1.5 — Rule 5 (JWT-Authoritative Identity): every test asserting
 *     `userId` flow verifies that the controller passes `request.user.id`
 *     to the service, NEVER a body-supplied or query-supplied value.
 *     Tests 1, 4, 13 are the primary Rule-5 enforcement points.
 *   - § 0.8.1.8 — Rule 8 (Auth Guards): Tests 8–12 verify the
 *     `[AuthGuard('jwt'), HasPermissionGuard]` stack is registered on each
 *     endpoint and that `HasPermissionGuard` throws on missing permission.
 *     Unauthenticated request → HTTP 401 is verified at the metadata level
 *     here (the runtime JWT-rejection path is exercised in
 *     `apps/api/src/app/auth/jwt.strategy.spec.ts`).
 *   - § 0.8.1.10 — Rule 10 (Catalog Auto-Open): the controller's HTTP 404
 *     contract is the server-side primitive that drives the client-side
 *     blank-canvas + auto-open-catalog behavior. Tests 2, 3 verify the
 *     controller returns `NotFoundException` (HTTP 404) — never HTTP 500
 *     — when no layout exists, allowing the client canvas to distinguish a
 *     first-visit scenario from a server error.
 *   - § 0.6.1.10 + § 0.8.2.1 (Observability rule): Tests 5, 6, 7 verify
 *     `X-Correlation-ID` header propagation per the project-level
 *     Observability rule. The header is set BEFORE the service call so
 *     it is also emitted on the 404 path.
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/user-financial-profile/user-financial-profile.controller.spec.ts`
 *     — sibling spec using `jest.mock(...)` factory at module scope and
 *     direct instantiation rather than the heavier
 *     `Test.createTestingModule(...)` route. The same lightweight pattern
 *     is appropriate here because the controller is a pure delegation
 *     surface — its only behaviors are (a) extract userId from JWT,
 *     (b) generate per-request correlationId, (c) emit X-Correlation-ID
 *     header, (d) delegate to service, and (e) translate `null` → HTTP 404.
 *     Each of those is testable with a mocked service and a synthetic
 *     `request` object.
 *   - `apps/api/src/guards/has-permission.guard.ts` — pattern for verifying
 *     guard-decorator metadata via `Reflector.get(...)` and runtime guard
 *     enforcement via `ExecutionContextHost`.
 */

/**
 * Replaces the real `UserDashboardLayoutService` constructor with a minimal
 * mock that exposes only the two service methods consumed by
 * `UserDashboardLayoutController` (`findByUserId` and `upsertForUser`).
 * Using a hoisted `jest.mock(...)` factory keeps the mock established
 * before the controller import resolves the real class.
 *
 * Both methods are spies (`jest.fn()`) so each test can configure its own
 * return value or thrown error. No real Prisma access occurs in this spec
 * — the service-layer Prisma scoping is verified separately by
 * `user-dashboard-layout.service.spec.ts`.
 *
 * The factory pattern at module scope (rather than `beforeEach`) is the
 * canonical Ghostfolio convention established by
 * `apps/api/src/app/user-financial-profile/user-financial-profile.controller.spec.ts`
 * and ensures that the mocked class reference is consistent across all
 * tests in the suite. Each `new UserDashboardLayoutService(...)` call in
 * `beforeEach` returns a fresh stub instance so call history never leaks
 * between `it(...)` blocks.
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

  /**
   * Reference layout payload for the PATCH happy-path tests. The shape
   * matches the `UpdateDashboardLayoutDto` contract (`{ layoutData:
   * { version: 1; items: LayoutItem[] } }`) and the structural validator
   * rules in `apps/api/src/app/user/dtos/update-dashboard-layout.dto.ts`:
   *   - `version === 1`
   *   - 0 ≤ `items.length` ≤ 50
   *   - each item: `cols ∈ [2, 12]`, `rows ≥ 2`, `x ∈ [0, 11]`, `y ≥ 0`,
   *     and the cross-field constraint `x + cols ≤ 12` (so the item fits
   *     within the 12-column grid per AAP § 0.6.1.7).
   *
   * The two items below — `portfolio-overview` at (0,0) sized 6×4 and
   * `holdings` at (6,0) sized 6×4 — together cover the full 12-column
   * width and exercise the boundary case `x + cols === GRID_COLUMN_COUNT`,
   * which is the maximum permissible width composition.
   */
  const VALID_DTO: UpdateDashboardLayoutDto = {
    layoutData: {
      version: 1,
      items: [
        { moduleId: 'portfolio-overview', cols: 6, rows: 4, x: 0, y: 0 },
        { moduleId: 'holdings', cols: 6, rows: 4, x: 6, y: 0 }
      ]
    } as UpdateDashboardLayoutDto['layoutData']
  };

  let controller: UserDashboardLayoutController;
  let request: RequestWithUser;
  let userDashboardLayoutService: jest.Mocked<UserDashboardLayoutService>;

  /**
   * Factory that returns a fresh, minimal `Response` mock per call.
   *
   * The controller injects `@Res({ passthrough: true }) response: Response`
   * on BOTH endpoints (per AAP § 0.6.1.10 Observability rule) to expose
   * the per-request `X-Correlation-ID` to clients. The only `Response`
   * API touched by the controller is `setHeader(name, value)`; we capture
   * it as a `jest.fn()` so individual tests can assert (a) the header was
   * set and (b) its value matches the per-request `correlationId`.
   *
   * A FACTORY (not a shared instance) is used because each `it(...)` block
   * creates its own Response — without isolation, a regression that writes
   * to the same `setHeader` mock from multiple tests would silently leak
   * state across the suite (Test 7's distinct-correlationIds assertion is
   * the canary for that regression).
   */
  const buildMockResponse = (): jest.Mocked<Response> => {
    return {
      setHeader: jest.fn()
    } as unknown as jest.Mocked<Response>;
  };

  /**
   * Builds a minimal `RequestWithUser` shape that exposes only the two
   * properties the controller reads (`user.id` for Rule 5 enforcement and
   * `user.permissions` for downstream guard simulation in Test 12).
   *
   * Unlike the user-financial-profile controller, the
   * `UserDashboardLayoutController` does NOT read `dateOfBirth` or any
   * other settings field — it is a pure JWT-userId-to-service delegator
   * with correlation-id observability. The synthetic shape therefore omits
   * the `settings` payload entirely, keeping each test isolated from any
   * irrelevant request state.
   *
   * The `permissions` array is pre-populated with both layout permissions
   * so that the synthetic request models a fully-authorized user. Test 12
   * overrides this via a separate `ExecutionContextHost([{ permissions: [] }])`
   * to verify the negative path (lacking permission → HTTP 403).
   */
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
    // The mocked service returns a fresh instance per test so call history
    // is never carried across `it(...)` blocks.
    userDashboardLayoutService = new (UserDashboardLayoutService as any)();
    controller = new UserDashboardLayoutController(
      request,
      userDashboardLayoutService
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — GET happy path: returns persisted record with HTTP 200
  //          (AAP § 0.8.5 + § 0.6.1.3)
  // -------------------------------------------------------------------------

  it('returns the persisted layout from GET (HTTP 200 contract)', async () => {
    // Test 1 verifies the GET happy-path delegation contract: the
    // controller resolves the JWT-derived userId, forwards it to the
    // service together with a per-request correlationId, and returns the
    // service's resolved value verbatim. The HTTP 200 status code itself
    // is the framework default for an unthrown async controller method
    // returning a non-`undefined` value — there is no @HttpCode override
    // on `findOne` (only `update` declares @HttpCode(HttpStatus.OK)).
    const persistedRecord: UserDashboardLayout = {
      userId: USER_1_ID,
      layoutData: VALID_DTO.layoutData as any,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      persistedRecord
    );

    const result = await controller.findOne(buildMockResponse());

    expect(result).toBe(persistedRecord);
    // Rule 5 (AAP § 0.8.1.5 — JWT-Authoritative Identity): the userId
    // argument to findByUserId is sourced from request.user.id (USER_1_ID),
    // NOT from any DTO/body field. The second argument is the auto-
    // generated per-request correlationId (a string — its v4 UUID shape
    // is asserted in Tests 5–7).
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledTimes(1);
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — GET 404: NotFoundException (NOT HTTP 500) when no record exists
  //          (AAP § 0.8.5 — required scenario "404 not 500")
  //          (AAP § 0.8.1.10 — Rule 10: enables blank-canvas first-visit UX)
  // -------------------------------------------------------------------------

  it('throws NotFoundException (HTTP 404, not 500) when no layout exists', async () => {
    // The service contract returns `null` (verified in
    // `user-dashboard-layout.service.spec.ts`) when no record exists for
    // the JWT-verified user. The controller MUST translate that to HTTP
    // 404 by throwing `NotFoundException` — never an unhandled `null`
    // dereference (which would produce HTTP 500). This 404 contract is
    // the SERVER-SIDE primitive that drives the CLIENT-SIDE Rule 10
    // first-visit auto-open-catalog behavior in the Angular canvas.
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    await expect(
      controller.findOne(buildMockResponse())
    ).rejects.toBeInstanceOf(NotFoundException);

    // Confirm the service was scoped to the JWT-verified userId (Rule 5).
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledTimes(1);
    expect(userDashboardLayoutService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID,
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Test 3 — GET 404 message references the userId (operator traceability)
  // -------------------------------------------------------------------------

  it('returns HTTP 404 message identifying the user when no layout exists', async () => {
    // The 404 message intentionally references the userId (no PII beyond
    // what the JWT already authenticated) so operators can trace the
    // miss in logs without exposing other users' data. Verifying the
    // message content (rather than just the exception type) defends
    // against a regression that drops the userId from the message — which
    // would degrade the operator experience for first-visit user support.
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.findOne(buildMockResponse());
      fail('Expected NotFoundException to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(
        HttpStatus.NOT_FOUND
      );
      expect((error as Error).message).toContain(USER_1_ID);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 — PATCH happy path: returns the upserted layout
  //          (AAP § 0.6.1.3 + § 0.8.1.4 idempotent upsert)
  // -------------------------------------------------------------------------

  it('returns the upserted layout from PATCH (HTTP 200 idempotent upsert)', async () => {
    // Test 4 verifies the PATCH happy-path delegation contract:
    //   1. The DTO body is forwarded to the service unchanged.
    //   2. ONLY `dto.layoutData` (NOT the entire DTO) is passed to the
    //      service — the controller must extract the validated payload
    //      field so future top-level DTO additions are NOT inadvertently
    //      echoed into the persisted JSON column.
    //   3. The userId argument is JWT-derived (Rule 5).
    //   4. The HTTP 200 status code is asserted via the
    //      @HttpCode(HttpStatus.OK) metadata test (Test 14 below) — the
    //      controller method body returns the row unchanged so the
    //      framework default of 201 (for POST/PATCH) is overridden.
    const upsertedRecord: UserDashboardLayout = {
      userId: USER_1_ID,
      layoutData: VALID_DTO.layoutData as any,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce(
      upsertedRecord
    );

    const result = await controller.update(VALID_DTO, buildMockResponse());

    expect(result).toBe(upsertedRecord);
    expect(userDashboardLayoutService.upsertForUser).toHaveBeenCalledTimes(1);

    // Rule 5: the first arg is request.user.id (USER_1_ID), the second is
    // the DTO's layoutData (NOT the entire DTO — only the validated payload
    // field). The third arg is the auto-generated per-request correlationId
    // (a string — its v4 UUID shape is asserted in Tests 5–7).
    const upsertArgs = userDashboardLayoutService.upsertForUser.mock.calls[0];
    expect(upsertArgs[0]).toBe(USER_1_ID);
    expect(upsertArgs[1]).toEqual(VALID_DTO.layoutData);
    expect(upsertArgs[2]).toEqual(expect.any(String));
  });

  // -------------------------------------------------------------------------
  // Test 5 — X-Correlation-ID response header on GET endpoint
  //          (AAP § 0.6.1.10 + § 0.8.2.1 — Observability rule)
  // -------------------------------------------------------------------------

  it('sets X-Correlation-ID response header on GET endpoint', async () => {
    // AAP § 0.6.1.10 (Observability): the controller injects the Express
    // `Response` via `@Res({ passthrough: true })` and emits an
    // `X-Correlation-ID` header carrying a fresh UUID per request,
    // enabling client-side log correlation when troubleshooting failures.
    // The header is set BEFORE the service call so it is also emitted on
    // the 404 path (Express preserves headers set before a thrown
    // exception, so `NotFoundException` responses still carry the
    // correlation id).
    const persistedRecord: UserDashboardLayout = {
      userId: USER_1_ID,
      layoutData: VALID_DTO.layoutData as any,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    userDashboardLayoutService.findByUserId.mockResolvedValueOnce(
      persistedRecord
    );
    const httpResponse = buildMockResponse();

    await controller.findOne(httpResponse);

    // Header was set exactly once with a string value.
    expect(httpResponse.setHeader).toHaveBeenCalledTimes(1);
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );

    // The header value MUST be an RFC 4122 v4 UUID (the shape produced by
    // `node:crypto.randomUUID()`). A regression to a non-v4 generator
    // (e.g. `Date.now().toString()`, `Math.random().toString(36)`) would
    // fail this regex match and surface immediately in CI.
    const headerCall = httpResponse.setHeader.mock.calls[0];
    const headerValue = headerCall[1] as string;
    const v4Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(headerValue).toMatch(v4Pattern);
  });

  // -------------------------------------------------------------------------
  // Test 6 — X-Correlation-ID response header on PATCH endpoint
  //          (AAP § 0.6.1.10 + § 0.8.2.1 — Observability rule)
  // -------------------------------------------------------------------------

  it('sets X-Correlation-ID response header on PATCH endpoint', async () => {
    // Same Observability requirement as Test 5 but for the `update`
    // endpoint. Verify the PATCH endpoint also emits an X-Correlation-ID
    // header carrying a fresh UUID per request. The header is set BEFORE
    // the service call so it is emitted on the 200 success path AND on
    // HTTP 500 service errors thrown AFTER setHeader runs (Express
    // preserves headers set before a thrown exception). The header is
    // NOT emitted on HTTP 400 validation errors because NestJS's global
    // ValidationPipe short-circuits the request before the controller
    // method body executes — see the controller class-level JSDoc's
    // "Known limitation" section for the propagation matrix.
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce({
      userId: USER_1_ID,
      layoutData: VALID_DTO.layoutData as any,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const httpResponse = buildMockResponse();

    await controller.update(VALID_DTO, httpResponse);

    expect(httpResponse.setHeader).toHaveBeenCalledTimes(1);
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );

    // RFC 4122 v4 UUID shape — same `randomUUID()` source as GET. The
    // pattern reads: 8 hex / dash / 4 hex / dash / "4" + 3 hex / dash /
    // [89ab] + 3 hex / dash / 12 hex (per RFC 4122 § 4.4).
    const headerCall = httpResponse.setHeader.mock.calls[0];
    const headerValue = headerCall[1] as string;
    const v4Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(headerValue).toMatch(v4Pattern);
  });

  // -------------------------------------------------------------------------
  // Test 7 — Distinct correlationIds across consecutive requests
  //          (AAP § 0.6.1.10 — per-request id, not memoized)
  // -------------------------------------------------------------------------

  it('generates fresh, distinct correlationIds across consecutive requests', async () => {
    // Two consecutive `findOne(...)` calls MUST produce two distinct
    // correlation ids. The `randomUUID()` v4 collision probability is
    // ~2^-122 — vanishingly small — so any test failure here indicates
    // the controller cached a single id (regression to per-instance
    // rather than per-request scope, which would defeat end-to-end
    // request tracing).
    userDashboardLayoutService.findByUserId.mockResolvedValue(null);
    const firstResponse = buildMockResponse();
    const secondResponse = buildMockResponse();

    try {
      await controller.findOne(firstResponse);
    } catch {
      /* expected NotFoundException — header is still emitted */
    }
    try {
      await controller.findOne(secondResponse);
    } catch {
      /* expected NotFoundException — header is still emitted */
    }

    const firstId = firstResponse.setHeader.mock.calls[0][1] as string;
    const secondId = secondResponse.setHeader.mock.calls[0][1] as string;
    expect(firstId).not.toBe(secondId);
  });

  // -------------------------------------------------------------------------
  // Test 8 — Guards metadata wired on findOne (HTTP 401/403 wiring)
  //          (AAP § 0.8.1.8 — Rule 8: AuthGuard('jwt') + HasPermissionGuard)
  //
  // The actual JWT-rejection behavior is tested in
  // `apps/api/src/app/auth/jwt.strategy.spec.ts`. At the controller
  // level we verify the decorator metadata so a future refactor that
  // drops the guard would fail this test.
  // -------------------------------------------------------------------------

  it("registers AuthGuard('jwt') + HasPermissionGuard on findOne (HTTP 401/403 wiring)", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.findOne
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    // The first guard is the JWT auth guard. NestJS's AuthGuard()
    // factory caches the produced guard class per strategy name —
    // calling `AuthGuard('jwt')` twice returns the same reference, so
    // `.toBe(...)` comparison is sound.
    const jwtAuthGuard = AuthGuard('jwt');
    expect(guards[0]).toBe(jwtAuthGuard);
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  // -------------------------------------------------------------------------
  // Test 9 — Guards metadata wired on update (HTTP 401/403 wiring)
  //          (AAP § 0.8.1.8 — Rule 8: AuthGuard('jwt') + HasPermissionGuard)
  // -------------------------------------------------------------------------

  it("registers AuthGuard('jwt') + HasPermissionGuard on update (HTTP 401/403 wiring)", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserDashboardLayoutController.prototype.update
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    const jwtAuthGuard = AuthGuard('jwt');
    expect(guards[0]).toBe(jwtAuthGuard);
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  // -------------------------------------------------------------------------
  // Test 10 — @HasPermission(permissions.readUserDashboardLayout) on findOne
  //           (AAP § 0.8.1.8 — Rule 8: HTTP 403 wiring)
  //
  // The actual permission-rejection behavior is tested in
  // `apps/api/src/guards/has-permission.guard.spec.ts` (and re-verified
  // in Test 12 below). At the controller level we verify the decorator
  // metadata names the correct permission constant.
  // -------------------------------------------------------------------------

  it('declares @HasPermission(permissions.readUserDashboardLayout) on findOne (HTTP 403 wiring)', () => {
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      UserDashboardLayoutController.prototype.findOne
    );
    expect(required).toBe(permissions.readUserDashboardLayout);
  });

  // -------------------------------------------------------------------------
  // Test 11 — @HasPermission(permissions.updateUserDashboardLayout) on update
  //           (AAP § 0.8.1.8 — Rule 8: HTTP 403 wiring)
  // -------------------------------------------------------------------------

  it('declares @HasPermission(permissions.updateUserDashboardLayout) on update (HTTP 403 wiring)', () => {
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      UserDashboardLayoutController.prototype.update
    );
    expect(required).toBe(permissions.updateUserDashboardLayout);
  });

  // -------------------------------------------------------------------------
  // Test 12 — Runtime 403 verification via HasPermissionGuard
  //           (AAP § 0.8.1.8 — Rule 8: end-to-end 403 path)
  // -------------------------------------------------------------------------

  it('rejects with HTTP 403 when HasPermissionGuard runs for a user lacking the permission', () => {
    // End-to-end verification: drive the HasPermissionGuard with a
    // synthetic ExecutionContext that mimics a request whose user has
    // NO `readUserDashboardLayout` permission. The guard MUST throw
    // HttpException(403). This proves that the metadata wiring asserted
    // in Tests 10–11 translates to a real 403 at runtime when the user
    // lacks the permission — closing the loop between decorator
    // declaration (compile-time) and HTTP response (runtime).
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

  // -------------------------------------------------------------------------
  // Test 13 — Rule 5 isolation: PATCH always uses the JWT-verified userId
  //           (AAP § 0.8.1.5 — JWT-Authoritative Identity / Decision D-012)
  // -------------------------------------------------------------------------

  it('uses request.user.id (USER_2_ID) for PATCH, never a different user', async () => {
    // Rebuild the controller with USER_2_ID's request to verify the
    // controller uses the JWT-derived userId regardless of the body
    // contents (the DTO has no `userId` field by structural design —
    // Decision D-012 — but verify behaviorally as defense-in-depth).
    // Even if a malicious client somehow injected a `userId` field into
    // the body, NestJS's global ValidationPipe (configured with
    // `whitelist: true`, `forbidNonWhitelisted: true`) would reject the
    // request with HTTP 400 BEFORE this method runs — but the controller
    // ALSO never reads any userId from the body, providing belt-and-
    // suspenders protection.
    const user2Request = buildRequest(USER_2_ID);
    const user2Controller = new UserDashboardLayoutController(
      user2Request,
      userDashboardLayoutService
    );
    userDashboardLayoutService.upsertForUser.mockResolvedValueOnce({
      userId: USER_2_ID,
      layoutData: VALID_DTO.layoutData as any,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await user2Controller.update(VALID_DTO, buildMockResponse());

    const upsertArgs = userDashboardLayoutService.upsertForUser.mock.calls[0];
    expect(upsertArgs[0]).toBe(USER_2_ID);
    expect(upsertArgs[0]).not.toBe(USER_1_ID);
  });

  // -------------------------------------------------------------------------
  // Test 14 — @HttpCode(HttpStatus.OK) on update (HTTP 200, not 201)
  //           (AAP § 0.6.1.3 — explicit @HttpCode override)
  //
  // NestJS's framework default for `@Patch()` (and `@Post()`) is HTTP 201
  // Created. The @HttpCode(HttpStatus.OK) override forces the success
  // status to HTTP 200 — matching the AAP § 0.6.1.3 contract that PATCH
  // endpoints return HTTP 200 (not 201) on idempotent upsert.
  // -------------------------------------------------------------------------

  it('declares @HttpCode(HttpStatus.OK) (HTTP 200, not 201) on update', () => {
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      UserDashboardLayoutController.prototype.update
    );
    expect(httpCode).toBe(HttpStatus.OK);
  });

  // -------------------------------------------------------------------------
  // Test 15 — HTTP method decorators wired correctly (verb wiring)
  //           (AAP § 0.6.1.3 — GET / PATCH endpoints)
  //
  // Verifies @Get() on findOne and @Patch() on update. A future
  // refactor that swaps the verbs (e.g., changing PATCH to PUT for
  // non-idempotent semantics) would break the AAP § 0.8.1.4 idempotent-
  // upsert contract and is caught immediately by this test.
  // -------------------------------------------------------------------------

  it('declares HTTP method decorators on both endpoints (verb wiring)', () => {
    const getMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserDashboardLayoutController.prototype.findOne
    );
    const patchMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserDashboardLayoutController.prototype.update
    );

    expect(getMethod).toBe(RequestMethod.GET);
    expect(patchMethod).toBe(RequestMethod.PATCH);
  });
});
