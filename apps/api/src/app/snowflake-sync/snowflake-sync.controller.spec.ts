import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';

import { ManualTriggerDto } from './dtos/manual-trigger.dto';
import { SnowflakeSyncController } from './snowflake-sync.controller';
import { SnowflakeSyncService } from './snowflake-sync.service';

/**
 * Integration tests for `SnowflakeSyncController`.
 *
 * Source-of-truth references (AAP):
 *   - § 0.5.1.4: explicitly enumerates the four scenarios this spec MUST
 *     cover — "Tests: 200 with admin permission, 401 unauth, 403 without
 *     `triggerSnowflakeSync`" plus DTO validation 400 for invalid `date`.
 *   - § 0.7.5.1 Gate 8 (Integration sign-off): the new admin endpoint
 *     `POST /api/v1/snowflake-sync/trigger` returns non-500 HTTP responses
 *     when called with a valid JWT and correctly shaped request body.
 *   - § 0.7.5.2 Snowflake sync gate: the manual trigger contract returns
 *     `{ correlationId, date, success, userId }` on the happy path and
 *     re-throws on service failure for HTTP-layer error mapping.
 *   - § 0.7.1.8 (Rule 8 — Controller Thinness): "No new controller method
 *     body exceeds 10 lines. No `prisma.*` calls appear in new controller
 *     files." (Verified by Test 8 below.)
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/user-financial-profile/user-financial-profile.controller.spec.ts`
 *     — sibling Feature controller spec using the same `jest.mock(...)`
 *     factory pattern with direct `new Controller(...)` instantiation
 *     rather than the heavier `Test.createTestingModule(...)` route.
 *     The same lightweight pattern is appropriate here because the
 *     controller is a pure delegation surface — its only behaviors are
 *     (a) extract the JWT-verified `request.user.id` for `callerUserId`,
 *     (b) pass the validated DTO's optional `userId`/`date` overrides
 *     unchanged, and (c) delegate to the service. Each of those is
 *     testable with a mocked service and a synthetic `request` object.
 *   - `apps/api/src/guards/has-permission.guard.spec.ts` — pattern for
 *     verifying `@HasPermission(...)` decorator metadata via
 *     `Reflector.get(...)` and exercising `HasPermissionGuard.canActivate`
 *     directly with a synthetic `ExecutionContext` to confirm the HTTP
 *     403 rejection path.
 */

/**
 * Replaces the real `SnowflakeSyncService` constructor with a minimal
 * mock that exposes only the single service method consumed by
 * `SnowflakeSyncController` (`triggerManualSync`).
 *
 * Using a hoisted `jest.mock(...)` factory keeps the mock established
 * before the controller import resolves the real service class. The mock
 * skips the real service's heavy dependency tree (`MetricsService`,
 * `PrismaService`, `PortfolioService`, `SnowflakeClientFactory`) — those
 * concerns are covered by `snowflake-sync.service.spec.ts`.
 */
jest.mock('./snowflake-sync.service', () => {
  return {
    SnowflakeSyncService: jest.fn().mockImplementation(() => {
      return {
        triggerManualSync: jest.fn()
      };
    })
  };
});

describe('SnowflakeSyncController', () => {
  const ADMIN_USER_ID = 'admin-user-uuid';
  const OTHER_USER_ID = 'other-user-uuid';

  let controller: SnowflakeSyncController;
  let request: RequestWithUser;
  let snowflakeSyncService: jest.Mocked<SnowflakeSyncService>;

  /**
   * Builds a minimal `RequestWithUser` shape that exposes only the two
   * properties the controller reads (`user.id`, `user.permissions`). The
   * synthetic shape lets each test mutate the user payload without the
   * weight of a full Express request and without taking on the broader
   * `User` Prisma type's optional fields.
   *
   * `permissions` defaults to the admin permission set so the
   * happy-path tests don't have to repeat the admin-grant boilerplate;
   * 403 tests pass an empty `permissions` array to drive
   * `HasPermissionGuard` into its rejection branch (Test 5).
   */
  function buildRequest(
    userId: string,
    options: { permissions?: string[] } = {}
  ): RequestWithUser {
    return {
      user: {
        id: userId,
        permissions: options.permissions ?? [permissions.triggerSnowflakeSync]
      }
    } as unknown as RequestWithUser;
  }

  /**
   * Factory that returns a fresh, minimal Express `Response` mock per
   * call.
   *
   * The controller injects `@Res({ passthrough: true }) response:
   * Response` (added per QA Checkpoint 13 Issue #1 / AAP § 0.7.2
   * Observability rule to expose `X-Correlation-ID` to clients on
   * BOTH the 200 success path AND the 502 upstream-failure path).
   * The only `Response` API touched by the controller is
   * `setHeader(name, value)`; we capture it as a `jest.fn()` so
   * individual tests can assert (a) the header was set and (b) its
   * value matches the per-request `correlationId` forwarded to the
   * service.
   *
   * A FACTORY (not a shared instance) is used because each `it(...)`
   * block creates its own Response — without isolation, a regression
   * that writes to the same `setHeader` mock from multiple tests
   * would silently leak state across the suite.
   *
   * Pattern parity: this mirrors the identical helper in
   * `apps/api/src/app/rebalancing/rebalancing.controller.spec.ts`
   * (lines 95–99), the canonical fixture for the
   * `@Res({ passthrough: true })` + `setHeader` test surface
   * established by the QA Checkpoint 11 Issue 4 fix.
   */
  const buildMockResponse = (): jest.Mocked<Response> => {
    return {
      setHeader: jest.fn()
    } as unknown as jest.Mocked<Response>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    request = buildRequest(ADMIN_USER_ID);
    // The mocked service returns a fresh instance per test so call
    // history is never carried across `it(...)` blocks.
    snowflakeSyncService = new (SnowflakeSyncService as any)();
    controller = new SnowflakeSyncController(snowflakeSyncService, request);
  });

  // -------------------------------------------------------------------------
  // Test 1 — HTTP 200 happy path with admin permission
  //          (AAP § 0.5.1.4 + § 0.7.5.2 Snowflake sync gate)
  // -------------------------------------------------------------------------

  it('returns the service envelope (HTTP 200 contract) for an admin caller with valid empty body', async () => {
    const expectedEnvelope = {
      correlationId: 'corr-uuid-123',
      date: '2025-04-26',
      success: true,
      userId: ADMIN_USER_ID
    };
    snowflakeSyncService.triggerManualSync.mockResolvedValueOnce(
      expectedEnvelope
    );

    const dto: ManualTriggerDto = {};
    const result = await controller.triggerSync(dto, buildMockResponse());

    // AAP § 0.7.5.2: returns the full sync envelope verbatim. The HTTP
    // 200 status code itself is asserted via the @HttpCode(HttpStatus.OK)
    // metadata test (Test 7 below) — the controller method body returns
    // the result unchanged so the global exception filter does NOT
    // translate it to a default 201.
    expect(result).toBe(expectedEnvelope);
    expect(snowflakeSyncService.triggerManualSync).toHaveBeenCalledTimes(1);

    // Verify the JWT-derived caller id is forwarded as `callerUserId`,
    // and that both DTO override fields default to `undefined` for an
    // empty `{}` body (the service then falls back to "today (UTC)"
    // and the caller's own user id per its documented contract).
    const args = snowflakeSyncService.triggerManualSync.mock.calls[0][0];
    expect(args.callerUserId).toBe(ADMIN_USER_ID);
    expect(args.overrideUserId).toBeUndefined();
    expect(args.overrideDate).toBeUndefined();
  });

  it('forwards both optional DTO overrides (userId + date) unchanged to the service', async () => {
    const expectedEnvelope = {
      correlationId: 'corr-uuid-456',
      date: '2025-01-15',
      success: true,
      userId: OTHER_USER_ID
    };
    snowflakeSyncService.triggerManualSync.mockResolvedValueOnce(
      expectedEnvelope
    );

    const dto: ManualTriggerDto = {
      date: '2025-01-15',
      userId: OTHER_USER_ID
    };
    const result = await controller.triggerSync(dto, buildMockResponse());

    expect(result).toBe(expectedEnvelope);
    const args = snowflakeSyncService.triggerManualSync.mock.calls[0][0];

    // Even when the DTO supplies `userId`, the controller MUST NOT
    // substitute it for `callerUserId` — `callerUserId` is the
    // JWT-verified identity, `overrideUserId` is the admin override
    // that the service uses to act on behalf of another user.
    expect(args.callerUserId).toBe(ADMIN_USER_ID);
    expect(args.overrideUserId).toBe(OTHER_USER_ID);
    expect(args.overrideDate).toBe('2025-01-15');
  });

  it('propagates service errors (e.g. Snowflake connectivity) for global exception filter mapping', async () => {
    // The service re-throws on failure so the global NestJS exception
    // filter can map the upstream failure to a 5xx; the controller
    // never wraps or catches the error (Rule 8 — Controller Thinness).
    const upstreamError = new Error(
      'Snowflake unavailable: connection refused'
    );
    snowflakeSyncService.triggerManualSync.mockRejectedValueOnce(upstreamError);

    await expect(controller.triggerSync({}, buildMockResponse())).rejects.toBe(
      upstreamError
    );
  });

  // -------------------------------------------------------------------------
  // Test 1b — X-Correlation-ID response header (Observability rule)
  //           QA Checkpoint 13 Issue #1 + AAP § 0.7.2
  //
  // Issue #1 (MINOR) at QA Checkpoint 13: "x-correlation-id HTTP
  // response header MISSING on /api/v1/snowflake-sync/trigger 502
  // response. Header IS present on POST /api/v1/ai/chat SSE
  // responses and on POST /api/v1/ai/rebalancing 502 responses."
  //
  // The fix mirrors the identical pattern already established on
  // `RebalancingController` (QA Checkpoint 11 Issue 4 fix at lines
  // 156–164 of rebalancing.controller.ts) and `AiChatController`:
  // the controller injects the Express `Response` via
  // `@Res({ passthrough: true })` and emits the `X-Correlation-ID`
  // HTTP header carrying the same UUID that the controller forwards
  // to `SnowflakeSyncService.triggerManualSync(...)` as
  // `correlationId`. The service then embeds that same id in every
  // structured `Logger.log` / `Logger.error` line and in the
  // `BadGatewayException` message body — so server-side logs, the
  // 5xx response body, and the HTTP response header all share a
  // single id per request. Operators tracing a client-visible
  // failure can read the header directly without parsing the
  // response body or correlating against the server log timestamp.
  //
  // The header is set BEFORE the service call so it is emitted on
  // BOTH the 200 success path AND any 502 upstream-failure path:
  // Express preserves headers written before a thrown exception, so
  // a `BadGatewayException` raised by `triggerManualSync(...)` (e.g.,
  // when the Snowflake driver times out, as happens against the QA
  // mock environment) still surfaces the correlation id to the
  // client.
  // -------------------------------------------------------------------------

  it('sets X-Correlation-ID response header matching the per-request correlationId (QA Checkpoint 13 Issue #1)', async () => {
    snowflakeSyncService.triggerManualSync.mockResolvedValueOnce({
      correlationId: 'corr-uuid-passthrough',
      date: '2025-04-26',
      success: true,
      userId: ADMIN_USER_ID
    });

    const dto: ManualTriggerDto = {};
    const response = buildMockResponse();

    await controller.triggerSync(dto, response);

    // The controller MUST call `response.setHeader('X-Correlation-ID',
    // <id>)` exactly once per request. A regression that omits the
    // call (or substitutes a different header name) would re-introduce
    // the original Checkpoint 13 Issue #1 observability gap.
    expect(response.setHeader).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );

    // The header value MUST equal the same `correlationId` forwarded
    // to the service — anchoring server-side logs (which use it in
    // `Logger.log` / `Logger.error` lines) and client-side
    // diagnostics (which read the header) to a single id per
    // request. This invariant is the entire point of the fix: a
    // header with a value that diverges from the service-side id
    // would defeat log correlation just as effectively as the
    // missing header would.
    const headerCall = response.setHeader.mock.calls[0];
    const headerValue = headerCall[1];
    const serviceCallArg =
      snowflakeSyncService.triggerManualSync.mock.calls[0][0];
    expect(headerValue).toBe(serviceCallArg.correlationId);
  });

  it('emits the X-Correlation-ID header BEFORE delegating to the service (so 5xx error paths also surface it)', async () => {
    // QA Checkpoint 13 Issue #1 surfaced specifically on the 502
    // path (the QA mock environment's Snowflake driver times out and
    // the service raises `BadGatewayException`). The fix's correctness
    // therefore hinges on the header being set BEFORE the service
    // call: Express preserves headers written before a thrown
    // exception, but if `setHeader(...)` were called AFTER the
    // service call (i.e., between `await ...` and `return`), the
    // 5xx error path would skip the header assignment entirely.
    //
    // We verify the ordering by recording the call sequence: when
    // the service throws, `setHeader(...)` MUST have already been
    // invoked exactly once. If a future refactor reverses the
    // ordering, this test fails on the 0-vs-1 setHeader call count.
    const upstreamError = new Error(
      'Snowflake driver timed out (mock environment)'
    );
    snowflakeSyncService.triggerManualSync.mockRejectedValueOnce(upstreamError);

    const dto: ManualTriggerDto = {};
    const response = buildMockResponse();

    await expect(controller.triggerSync(dto, response)).rejects.toBe(
      upstreamError
    );

    // setHeader was called BEFORE the service raised — so even on
    // the error path, the header is present on the HTTP response
    // surface (Express will emit it to the wire when the global
    // exception filter writes the 502 status and body).
    expect(response.setHeader).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );

    // The header value MUST equal the same `correlationId` forwarded
    // to the service so the 502 error-path correlationId in the
    // exception message body matches the correlationId in the
    // response header. The service receives the id via its
    // `correlationId` argument; we read it from the call args.
    const headerCall = response.setHeader.mock.calls[0];
    const headerValue = headerCall[1];
    const serviceCallArg =
      snowflakeSyncService.triggerManualSync.mock.calls[0][0];
    expect(headerValue).toBe(serviceCallArg.correlationId);
  });

  it('generates a distinct correlationId per request (Observability rule)', async () => {
    snowflakeSyncService.triggerManualSync.mockResolvedValue({
      correlationId: 'irrelevant-fixture',
      date: '2025-04-26',
      success: true,
      userId: ADMIN_USER_ID
    });

    const dto: ManualTriggerDto = {};
    const responseA = buildMockResponse();
    const responseB = buildMockResponse();

    await controller.triggerSync(dto, responseA);
    await controller.triggerSync(dto, responseB);

    // Two requests => two distinct correlationIds. A regression
    // where the controller cached or shared a correlationId across
    // requests would defeat log-correlation and obscure cross-request
    // failure analysis. Each request gets its own id derived from
    // a fresh `crypto.randomUUID()` call inside the controller.
    const firstCallArg =
      snowflakeSyncService.triggerManualSync.mock.calls[0][0];
    const secondCallArg =
      snowflakeSyncService.triggerManualSync.mock.calls[1][0];
    expect(firstCallArg.correlationId).not.toEqual(secondCallArg.correlationId);

    // And each response received the OTHER request's id — i.e., the
    // header value matches its OWN request's service-call id, not
    // the other request's id.
    const headerA = responseA.setHeader.mock.calls[0][1];
    const headerB = responseB.setHeader.mock.calls[0][1];
    expect(headerA).toBe(firstCallArg.correlationId);
    expect(headerB).toBe(secondCallArg.correlationId);
    expect(headerA).not.toEqual(headerB);
  });

  // -------------------------------------------------------------------------
  // Test 2 — HTTP 401 unauth: AuthGuard('jwt') is wired on the endpoint
  //
  // The actual JWT-rejection behavior is tested in
  // `apps/api/src/app/auth/jwt.strategy.ts` and verified at runtime in
  // the QA bypass harness. At the controller level, we verify the
  // decorator metadata so a future refactor that drops the guard would
  // fail this test. This mirrors the canonical
  // `user-financial-profile.controller.spec.ts` pattern.
  // -------------------------------------------------------------------------

  it('maps the 401 / 403 contract to NestJS UnauthorizedException / ForbiddenException', () => {
    // AAP § 0.2.4.2 mandates the controller endpoint return:
    //   - HTTP 401 when no valid JWT is supplied  (UnauthorizedException)
    //   - HTTP 403 when the caller lacks `triggerSnowflakeSync` permission
    //     (ForbiddenException at the framework level)
    //
    // The runtime exception throwing happens in @nestjs/passport (for 401)
    // and in `HasPermissionGuard.canActivate` (for 403, which uses raw
    // `HttpException(StatusCodes.FORBIDDEN)` — see the next test). This
    // assertion documents the contract in terms of the named NestJS
    // exception classes and proves the framework's HTTP status mapping
    // is what we expect:
    //   - UnauthorizedException -> 401
    //   - ForbiddenException     -> 403
    //
    // A future NestJS upgrade that changed those mappings would fail
    // this test loudly rather than silently breaking the AAP § 0.2.4.2
    // contract surface.
    expect(new UnauthorizedException().getStatus()).toBe(
      HttpStatus.UNAUTHORIZED
    );
    expect(new ForbiddenException().getStatus()).toBe(HttpStatus.FORBIDDEN);

    // Sanity: both extend HttpException, so the global NestJS exception
    // filter treats them as first-class HTTP responses (no 500-with-stack
    // leakage). This is the reason the existing 403 test (Test 6 below)
    // can assert `instanceof HttpException` rather than the more specific
    // `instanceof ForbiddenException`: the HasPermissionGuard throws a
    // raw HttpException rather than constructing a ForbiddenException.
    expect(new UnauthorizedException()).toBeInstanceOf(HttpException);
    expect(new ForbiddenException()).toBeInstanceOf(HttpException);
  });

  it("registers AuthGuard('jwt') + HasPermissionGuard on triggerSync (HTTP 401/403 wiring)", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      SnowflakeSyncController.prototype.triggerSync
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);

    // The first guard is the JWT auth guard. NestJS's AuthGuard()
    // factory returns a class — we verify by reference equality that
    // the registered guard is the same `AuthGuard('jwt')` instance,
    // ensuring HTTP 401 fires for missing or invalid bearer tokens.
    const jwtAuthGuard = AuthGuard('jwt');
    expect(guards[0]).toBe(jwtAuthGuard);

    // The second guard is HasPermissionGuard, ensuring HTTP 403 fires
    // for an authenticated user lacking the required permission.
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  // -------------------------------------------------------------------------
  // Test 3 — HTTP 403 without `triggerSnowflakeSync` permission
  //          (AAP § 0.5.1.4 + § 0.6.1 ADMIN-only permission scope)
  // -------------------------------------------------------------------------

  it('declares @HasPermission(permissions.triggerSnowflakeSync) on triggerSync (HTTP 403 wiring)', () => {
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      SnowflakeSyncController.prototype.triggerSync
    );
    expect(required).toBe(permissions.triggerSnowflakeSync);
  });

  it('rejects with HTTP 403 when HasPermissionGuard runs for a user lacking triggerSnowflakeSync', () => {
    // End-to-end verification: drive the HasPermissionGuard with a
    // synthetic ExecutionContext that mimics a request whose user has
    // no `triggerSnowflakeSync` permission. The guard MUST throw
    // HttpException(403). This proves that the @HasPermission decorator
    // wiring on the controller (verified above) translates to a real
    // 403 at runtime when the user lacks the admin-only permission.
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue(permissions.triggerSnowflakeSync);
    const guard = new HasPermissionGuard(reflector);
    const userWithoutPermission = {
      user: { permissions: [] }
    };
    const context = new ExecutionContextHost([userWithoutPermission as any]);

    let thrown: unknown;
    try {
      guard.canActivate(context as any);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('admits a user holding triggerSnowflakeSync (positive control for HasPermissionGuard)', () => {
    // Positive control: the guard MUST permit the call when the user
    // does carry the `triggerSnowflakeSync` permission, demonstrating
    // that the 403 path above is gating on the permission and not on
    // an unrelated guard misconfiguration.
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue(permissions.triggerSnowflakeSync);
    const guard = new HasPermissionGuard(reflector);
    const userWithPermission = {
      user: { permissions: [permissions.triggerSnowflakeSync] }
    };
    const context = new ExecutionContextHost([userWithPermission as any]);

    expect(guard.canActivate(context as any)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Permission-registry parity: triggerSnowflakeSync is admin-only
  //          (AAP § 0.7.5.2 + § 0.6.1: only ADMIN role grants this perm)
  // -------------------------------------------------------------------------

  it('uses an admin-only permission constant (triggerSnowflakeSync exists in the registry)', () => {
    // Sanity check that the permission constant exists in the shared
    // `permissions` registry; if a future refactor renames or removes
    // it, the @HasPermission decorator on the controller would silently
    // bind to `undefined` and the guard would short-circuit `true` for
    // every caller (per `HasPermissionGuard.canActivate` early return
    // on `!requiredPermission`). This test fails loudly in that case.
    expect(permissions.triggerSnowflakeSync).toBe('triggerSnowflakeSync');
  });

  // -------------------------------------------------------------------------
  // Test 5 — HTTP 400 validation: ManualTriggerDto rejects malformed `date`
  //          (AAP § 0.5.1.4 — DTO validation 400 for invalid date)
  //
  // The DTO's `class-validator` decorators are the authoritative gate.
  // NestJS's global `ValidationPipe` runs the validators before the
  // controller method body; we verify the validators directly so the
  // 400 contract is testable without spinning up the entire HTTP stack.
  // -------------------------------------------------------------------------

  it('ManualTriggerDto rejects a malformed `date` value (HTTP 400 contract)', async () => {
    // Runtime import of class-validator/class-transformer to keep the
    // test's compile-time dependency surface minimal — both packages
    // are already direct dependencies of the API project (used by every
    // existing DTO and by NestJS's global ValidationPipe).
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ManualTriggerDto, {
      date: 'not-a-real-iso-8601-date'
    });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    // The IsISO8601 validator failure surfaces the constraint name in
    // the error envelope; presence of the constraint key proves the
    // validator (and therefore the 400 contract) fired correctly.
    expect(errors.some((e) => e.constraints?.isIso8601 !== undefined)).toBe(
      true
    );
  });

  it('ManualTriggerDto accepts a valid ISO-8601 `date` value', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ManualTriggerDto, {
      date: '2025-04-26'
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('ManualTriggerDto accepts an empty body (both fields are optional)', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ManualTriggerDto, {});
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('ManualTriggerDto rejects a non-string `userId` (defense in depth)', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ManualTriggerDto, {
      userId: 12345
    });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.constraints?.isString !== undefined)).toBe(
      true
    );
  });

  // -------------------------------------------------------------------------
  // Test 6 — Rule 5-style isolation: callerUserId is JWT-derived, never body
  // -------------------------------------------------------------------------

  it('uses request.user.id (ADMIN_USER_ID) as callerUserId regardless of DTO contents', async () => {
    snowflakeSyncService.triggerManualSync.mockResolvedValueOnce({
      correlationId: 'corr-uuid-789',
      date: '2025-04-26',
      success: true,
      userId: ADMIN_USER_ID
    });

    // Even with `userId` in the body — which is a legitimate admin
    // override — the controller MUST keep `callerUserId` aligned with
    // the JWT identity. The override is forwarded as `overrideUserId`,
    // not substituted for `callerUserId`. This protects audit logs and
    // metrics labels from being forged via the request body.
    const dto: ManualTriggerDto = { userId: OTHER_USER_ID };
    await controller.triggerSync(dto, buildMockResponse());

    const args = snowflakeSyncService.triggerManualSync.mock.calls[0][0];
    expect(args.callerUserId).toBe(ADMIN_USER_ID);
    expect(args.callerUserId).not.toBe(OTHER_USER_ID);
    expect(args.overrideUserId).toBe(OTHER_USER_ID);
  });

  // -------------------------------------------------------------------------
  // Test 7 — @HttpCode(HttpStatus.OK) on POST (200, not the default 201)
  //          AAP § 0.5.1.1: explicit @HttpCode override is required.
  // -------------------------------------------------------------------------

  it('declares @HttpCode(HttpStatus.OK) (HTTP 200, not 201) on triggerSync', () => {
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      SnowflakeSyncController.prototype.triggerSync
    );
    expect(httpCode).toBe(HttpStatus.OK);
  });

  it('declares POST as the HTTP verb on triggerSync (verb wiring)', () => {
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      SnowflakeSyncController.prototype.triggerSync
    );
    expect(method).toBe(RequestMethod.POST);
  });

  // -------------------------------------------------------------------------
  // Test 8 — Rule 8 (Controller Thinness): no `prisma.*` calls in controller
  //          file; method body under 10 lines.
  //
  // This is a static-analysis test that reads the source file from disk
  // and asserts the absence of `prisma.` usage. It is the executable
  // form of the Rule 8 acceptance criterion — a future refactor that
  // introduces a Prisma call into the controller would fail this test
  // on the next CI run.
  // -------------------------------------------------------------------------

  it('the controller file contains zero `prisma.` references (Rule 8)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const controllerSource = await readFile(
      join(__dirname, 'snowflake-sync.controller.ts'),
      'utf-8'
    );

    // The controller MUST NOT touch Prisma directly — all persistence
    // belongs to the service layer (Rule 8 — Controller Thinness, AAP
    // § 0.7.1.8). A simple substring check is sufficient because there
    // is no legitimate use for the literal `prisma.` token in a
    // controller file.
    expect(controllerSource).not.toMatch(/prisma\./);
  });

  it('triggerSync method body is at most 10 lines (Rule 8)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const controllerSource = await readFile(
      join(__dirname, 'snowflake-sync.controller.ts'),
      'utf-8'
    );

    // Locate the line containing `public async triggerSync(`, then walk
    // forward through the source counting balanced curly braces. The
    // method body is everything between the FIRST `{` (after the
    // signature) and its matching `}`. We count non-blank lines in
    // that span — Rule 8 caps it at ≤ 10.
    //
    // A line-walker is more robust than a regex here because the
    // signature parenthesis contains the `@Body()` decorator's own
    // parens, which trip up naive `[^)]*` regexes.
    const lines = controllerSource.split('\n');
    const startIdx = lines.findIndex((line) =>
      /public\s+async\s+triggerSync\s*\(/.test(line)
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);

    // Find the FIRST `{` at-or-after the signature line. The signature
    // may span multiple lines, but in this codebase the body's opening
    // brace lands on the same line as the closing arg paren — we
    // search forward to be future-proof.
    let openLineIdx = startIdx;
    while (openLineIdx < lines.length && !lines[openLineIdx].includes('{')) {
      openLineIdx += 1;
    }
    expect(openLineIdx).toBeLessThan(lines.length);

    // Walk forward counting balanced braces. Start the depth at the
    // count of `{` on the opening line, then decrement on `}` per
    // subsequent line, and stop when depth returns to zero.
    let depth = 0;
    const bodyLines: string[] = [];
    for (let i = openLineIdx; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > openLineIdx) {
        bodyLines.push(line);
      }
      for (const ch of line) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth === 0 && i > openLineIdx) {
        // Drop the closing-brace line itself from the body count.
        bodyLines.pop();
        break;
      }
    }

    const nonBlankLines = bodyLines
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Rule 8 explicitly caps method bodies at 10 lines.
    expect(nonBlankLines.length).toBeLessThanOrEqual(10);
    // Sanity: the body should not be empty (the controller does
    // delegate to the service, and that single statement spans
    // multiple lines for argument readability).
    expect(nonBlankLines.length).toBeGreaterThan(0);
  });
});
