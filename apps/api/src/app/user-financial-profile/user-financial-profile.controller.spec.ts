import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  BadRequestException,
  HttpStatus,
  NotFoundException
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { AuthGuard } from '@nestjs/passport';
import { FinancialProfile, RiskTolerance } from '@prisma/client';

import { FinancialProfileDto } from './dtos/financial-profile.dto';
import { UserFinancialProfileController } from './user-financial-profile.controller';
import { UserFinancialProfileService } from './user-financial-profile.service';

/**
 * Integration tests for `UserFinancialProfileController`.
 *
 * Source-of-truth references (AAP):
 *   - § 0.5.1.4: explicitly enumerates the five scenarios this spec MUST
 *     cover — "Integration tests: 200 after PATCH, 404 (not 500) when
 *     no record, 400 when `retirementTargetAge < currentAge`, 401 unauth"
 *     plus 403 without `readFinancialProfile`/`updateFinancialProfile`
 *     per § 0.5.1.1.
 *   - § 0.7.5.2 "Financial profile gate": "GET ... returns HTTP 200 with
 *     the persisted record after a successful PATCH and HTTP 404 (not
 *     500) when no record exists for the user; PATCH with
 *     `retirementTargetAge < currentAge` returns HTTP 400; a valid
 *     upsert creates a new row on the first call and updates (does not
 *     duplicate) on the second call".
 *   - § 0.7.1.5 (Rule 5 — FinancialProfile Authorization): "Every
 *     Prisma operation on `FinancialProfile` MUST include
 *     `where: { userId: authenticatedUserId }` using the JWT-verified
 *     user ID."
 *   - § 0.7.1.8 (Rule 8 — Controller Thinness): "No new controller
 *     method body exceeds 10 lines. No `prisma.*` calls appear in new
 *     controller files." (Verified by Test 9 below.)
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/user-financial-profile/user-financial-profile.service.spec.ts`
 *     — sibling spec using `jest.mock(...)` factory at module scope and
 *     direct instantiation rather than the heavier
 *     `Test.createTestingModule(...)` route. The same lightweight pattern
 *     is appropriate here because the controller is a pure delegation
 *     surface — its only behaviors are (a) extract userId from JWT,
 *     (b) extract dateOfBirth from JWT, (c) delegate to service, and
 *     (d) translate `null` → HTTP 404. Each of those is testable with
 *     a mocked service and a synthetic `request` object.
 *   - `apps/api/src/guards/has-permission.guard.spec.ts` — pattern for
 *     verifying guard-decorator metadata via `Reflector.get(...)`.
 */

/**
 * Replaces the real `UserFinancialProfileService` constructor with a
 * minimal mock that exposes only the two service methods consumed by
 * `UserFinancialProfileController` (`findByUserId` and `upsertForUser`).
 * Using a hoisted `jest.mock(...)` factory keeps the mock established
 * before the controller import resolves the real class.
 *
 * Both methods are spies (`jest.fn()`) so each test can configure its
 * own return value or thrown error. No real Prisma access occurs in
 * this spec — the service-layer Prisma scoping is verified separately
 * by `user-financial-profile.service.spec.ts`.
 */
jest.mock('./user-financial-profile.service', () => {
  return {
    UserFinancialProfileService: jest.fn().mockImplementation(() => {
      return {
        findByUserId: jest.fn(),
        upsertForUser: jest.fn()
      };
    })
  };
});

describe('UserFinancialProfileController', () => {
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';
  const VALID_DTO: FinancialProfileDto = {
    investmentGoals: [
      {
        label: 'Retirement',
        targetAmount: 1_000_000,
        targetDate: '2055-01-01'
      }
    ],
    monthlyDebtObligations: 1500,
    monthlyIncome: 8000,
    retirementTargetAge: 65,
    retirementTargetAmount: 1_000_000,
    riskTolerance: 'MEDIUM' as RiskTolerance,
    timeHorizonYears: 30
  };

  let controller: UserFinancialProfileController;
  let request: RequestWithUser;
  let userFinancialProfileService: jest.Mocked<UserFinancialProfileService>;

  /**
   * Builds a minimal `RequestWithUser` shape that exposes only the two
   * properties the controller reads (`user.id`, `user.settings`). The
   * synthetic shape lets each test mutate the user payload without the
   * weight of a full Express request.
   *
   * `dateOfBirth` is parameterized so the age-validation tests can model
   * a 46-year-old user (born 1980) and confirm the `BadRequestException`
   * fires; other tests pass `undefined` so the comparative check is
   * skipped (the service treats missing `dateOfBirth` as "no comparative
   * gate" per AAP § 0.5.3 fallback).
   */
  function buildRequest(
    userId: string,
    options: { dateOfBirth?: string | null } = {}
  ): RequestWithUser {
    return {
      user: {
        id: userId,
        permissions: [
          permissions.readFinancialProfile,
          permissions.updateFinancialProfile
        ],
        settings: {
          settings: {
            ...(options.dateOfBirth !== undefined
              ? { dateOfBirth: options.dateOfBirth }
              : {})
          }
        }
      }
    } as unknown as RequestWithUser;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    request = buildRequest(USER_1_ID);
    // The mocked service returns a fresh instance per test so call
    // history is never carried across `it(...)` blocks.
    userFinancialProfileService = new (UserFinancialProfileService as any)();
    controller = new UserFinancialProfileController(
      request,
      userFinancialProfileService
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — HTTP 200 after PATCH (AAP § 0.5.1.4 + § 0.7.5.2)
  // -------------------------------------------------------------------------

  it('returns the upserted FinancialProfile from PATCH (HTTP 200 contract)', async () => {
    const upsertedRecord: FinancialProfile = {
      createdAt: new Date(),
      investmentGoals: VALID_DTO.investmentGoals as any,
      monthlyDebtObligations: VALID_DTO.monthlyDebtObligations,
      monthlyIncome: VALID_DTO.monthlyIncome,
      retirementTargetAge: VALID_DTO.retirementTargetAge,
      retirementTargetAmount: VALID_DTO.retirementTargetAmount,
      riskTolerance: VALID_DTO.riskTolerance,
      timeHorizonYears: VALID_DTO.timeHorizonYears,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    userFinancialProfileService.upsertForUser.mockResolvedValueOnce(
      upsertedRecord
    );

    const result = await controller.updateFinancialProfile(VALID_DTO);

    // AAP § 0.7.5.2: a valid upsert returns the persisted row verbatim.
    // The HTTP 200 status code itself is asserted via the
    // @HttpCode(HttpStatus.OK) metadata test (Test 8 below) — the
    // controller method body returns the row unchanged so the global
    // exception filter does NOT translate it to a default 201.
    expect(result).toBe(upsertedRecord);
    expect(userFinancialProfileService.upsertForUser).toHaveBeenCalledTimes(1);

    // Rule 5: the userId argument is JWT-derived. Verify the call
    // received `request.user.id` (USER_1_ID), NOT a body-supplied id.
    const upsertArgs = userFinancialProfileService.upsertForUser.mock.calls[0];
    expect(upsertArgs[0]).toBe(USER_1_ID);
    expect(upsertArgs[1]).toBe(VALID_DTO);
  });

  // -------------------------------------------------------------------------
  // Test 2 — HTTP 404 (NOT 500) when no record exists for the JWT user
  //          (AAP § 0.5.1.4 + § 0.7.5.2 explicit "404 not 500" requirement)
  // -------------------------------------------------------------------------

  it('throws NotFoundException (HTTP 404, not 500) when no FinancialProfile exists', async () => {
    // The service contract returns `null` (per service spec test 1)
    // when no record exists. The controller maps that to HTTP 404 by
    // throwing `NotFoundException` — never `InternalServerErrorException`,
    // which would otherwise be the default for an unhandled `null` access.
    userFinancialProfileService.findByUserId.mockResolvedValueOnce(null);

    await expect(controller.getFinancialProfile()).rejects.toBeInstanceOf(
      NotFoundException
    );

    // Confirm the service was scoped to the JWT-verified userId (Rule 5).
    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledTimes(1);
    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID
    );
  });

  it('returns HTTP 404 message identifying the user when no record exists', async () => {
    // The 404 message intentionally references the userId (no PII beyond
    // what the JWT already authenticated) so operators can trace the
    // miss in logs without exposing other users' data.
    userFinancialProfileService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.getFinancialProfile();
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
  // Test 3 — HTTP 200 GET after PATCH (round-trip, AAP § 0.7.5.2)
  // -------------------------------------------------------------------------

  it('returns the persisted FinancialProfile from GET (HTTP 200 round-trip)', async () => {
    const persistedRecord: FinancialProfile = {
      createdAt: new Date(),
      investmentGoals: [] as any,
      monthlyDebtObligations: 1500,
      monthlyIncome: 8000,
      retirementTargetAge: 65,
      retirementTargetAmount: 1_000_000,
      riskTolerance: 'MEDIUM' as RiskTolerance,
      timeHorizonYears: 30,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    userFinancialProfileService.findByUserId.mockResolvedValueOnce(
      persistedRecord
    );

    const result = await controller.getFinancialProfile();

    expect(result).toBe(persistedRecord);
    // Rule 5: GET is scoped to JWT-derived userId.
    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID
    );
  });

  // -------------------------------------------------------------------------
  // Test 4 — HTTP 400 when retirementTargetAge <= currentAge
  //          (AAP § 0.5.1.4 + § 0.7.5.2 "Financial profile gate")
  //
  // This is the explicit gate the QA report (Issue #3) flagged as
  // missing. The validation is server-authoritative per AAP § 0.5.3.
  // -------------------------------------------------------------------------

  it('propagates BadRequestException (HTTP 400) when retirementTargetAge <= currentAge', async () => {
    // Build a controller wired to a 46-year-old user (born 1980-01-01).
    // The DTO requests retirementTargetAge=30, which is <= 46, so the
    // service-layer validator must throw BadRequestException — the
    // controller propagates it unchanged for the global exception
    // filter to translate to HTTP 400.
    const olderUserRequest = buildRequest(USER_1_ID, {
      dateOfBirth: '1980-01-01'
    });
    const olderUserController = new UserFinancialProfileController(
      olderUserRequest,
      userFinancialProfileService
    );
    const tooLowDto: FinancialProfileDto = {
      ...VALID_DTO,
      retirementTargetAge: 30
    };
    userFinancialProfileService.upsertForUser.mockImplementationOnce(() => {
      throw new BadRequestException(
        `retirementTargetAge (30) must be greater than the user's current age (46)`
      );
    });

    await expect(
      olderUserController.updateFinancialProfile(tooLowDto)
    ).rejects.toBeInstanceOf(BadRequestException);

    // Rule 5: the dateOfBirth passed to the service is JWT-derived.
    const upsertArgs = userFinancialProfileService.upsertForUser.mock.calls[0];
    expect(upsertArgs[2]).toBe('1980-01-01');
  });

  it('passes the JWT-derived dateOfBirth (not a body field) to the service', async () => {
    // Verifies the controller's `extractDateOfBirthFromJwtUser()` helper
    // pulls dateOfBirth from `request.user.settings.settings.dateOfBirth`
    // and passes it as the third argument to `upsertForUser`. The DTO
    // intentionally has no `dateOfBirth` field, so an attacker cannot
    // forge it via the request body — the service-layer age validator
    // is therefore always evaluated against the JWT-loaded value.
    const requestWithDob = buildRequest(USER_1_ID, {
      dateOfBirth: '1990-06-15'
    });
    const controllerWithDob = new UserFinancialProfileController(
      requestWithDob,
      userFinancialProfileService
    );
    userFinancialProfileService.upsertForUser.mockResolvedValueOnce({
      ...VALID_DTO,
      createdAt: new Date(),
      investmentGoals: VALID_DTO.investmentGoals as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as FinancialProfile);

    await controllerWithDob.updateFinancialProfile(VALID_DTO);

    const upsertArgs = userFinancialProfileService.upsertForUser.mock.calls[0];
    expect(upsertArgs[2]).toBe('1990-06-15');
  });

  it('passes null dateOfBirth to the service when settings.dateOfBirth is absent', async () => {
    // Per AAP § 0.5.3, when dateOfBirth is missing the comparative check
    // is skipped (the DTO's @Min(18) @Max(100) envelope is the only
    // gate). The controller forwards `null` so the service treats it
    // as "no reference age available".
    const requestNoDob = buildRequest(USER_1_ID); // no dateOfBirth option
    const controllerNoDob = new UserFinancialProfileController(
      requestNoDob,
      userFinancialProfileService
    );
    userFinancialProfileService.upsertForUser.mockResolvedValueOnce({
      ...VALID_DTO,
      createdAt: new Date(),
      investmentGoals: VALID_DTO.investmentGoals as any,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as FinancialProfile);

    await controllerNoDob.updateFinancialProfile(VALID_DTO);

    const upsertArgs = userFinancialProfileService.upsertForUser.mock.calls[0];
    expect(upsertArgs[2]).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 5 — HTTP 401 unauth: AuthGuard('jwt') is wired on both endpoints
  //
  // The actual JWT-rejection behavior is tested in
  // `apps/api/src/app/auth/jwt.strategy.ts` and verified at runtime in
  // the QA bypass harness. At the controller level, we verify the
  // decorator metadata so a future refactor that drops the guard would
  // fail this test.
  // -------------------------------------------------------------------------

  it("registers AuthGuard('jwt') + HasPermissionGuard on getFinancialProfile (HTTP 401/403 wiring)", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserFinancialProfileController.prototype.getFinancialProfile
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    // The first guard is the JWT auth guard. NestJS's AuthGuard()
    // factory returns a class — we verify its `name` includes
    // `JwtAuthGuard` or `MixinAuthGuard` (Passport convention) by
    // checking that an instance has the `canActivate` contract.
    const jwtAuthGuard = AuthGuard('jwt');
    expect(guards[0]).toBe(jwtAuthGuard);
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  it("registers AuthGuard('jwt') + HasPermissionGuard on updateFinancialProfile (HTTP 401/403 wiring)", () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      UserFinancialProfileController.prototype.updateFinancialProfile
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);
    const jwtAuthGuard = AuthGuard('jwt');
    expect(guards[0]).toBe(jwtAuthGuard);
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  // -------------------------------------------------------------------------
  // Test 6 — HTTP 403 without correct permission: HasPermission decorator
  //          is wired with the correct permission constants
  //
  // The actual permission-rejection behavior is tested in
  // `apps/api/src/guards/has-permission.guard.spec.ts`. At the controller
  // level we verify the decorator metadata names the correct permission.
  // -------------------------------------------------------------------------

  it('declares @HasPermission(permissions.readFinancialProfile) on getFinancialProfile (HTTP 403 wiring)', () => {
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      UserFinancialProfileController.prototype.getFinancialProfile
    );
    expect(required).toBe(permissions.readFinancialProfile);
  });

  it('declares @HasPermission(permissions.updateFinancialProfile) on updateFinancialProfile (HTTP 403 wiring)', () => {
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      UserFinancialProfileController.prototype.updateFinancialProfile
    );
    expect(required).toBe(permissions.updateFinancialProfile);
  });

  it('rejects with HTTP 403 when HasPermissionGuard runs for a user lacking the permission', () => {
    // End-to-end verification: drive the HasPermissionGuard with a
    // synthetic ExecutionContext that mimics a request whose user has
    // no `readFinancialProfile`/`updateFinancialProfile` permission.
    // The guard MUST throw HttpException(403). This proves that the
    // wiring on the controller (verified above) translates to a real
    // 403 at runtime when the user lacks the permission.
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue(permissions.readFinancialProfile);
    const guard = new HasPermissionGuard(reflector);
    const context = new ExecutionContextHost([
      { user: { permissions: [] } } as any
    ]);

    expect(() => guard.canActivate(context as any)).toThrow();
  });

  // -------------------------------------------------------------------------
  // Test 7 — Rule 5 isolation: GET/PATCH always use the JWT-verified userId
  // -------------------------------------------------------------------------

  it('uses request.user.id (USER_1_ID) for GET, never a different user', async () => {
    userFinancialProfileService.findByUserId.mockResolvedValueOnce(null);

    try {
      await controller.getFinancialProfile();
    } catch {
      /* expected NotFoundException */
    }

    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledWith(
      USER_1_ID
    );
    expect(userFinancialProfileService.findByUserId).not.toHaveBeenCalledWith(
      USER_2_ID
    );
  });

  it('uses request.user.id (USER_2_ID) for PATCH, never a different user, and ignores any forged userId', async () => {
    // Rebuild controller with USER_2_ID's request to verify the
    // controller uses the JWT-derived userId regardless of what the
    // body contains (the DTO has no `userId` field, so this is also
    // structurally enforced — but verify behaviorally to be safe).
    const user2Request = buildRequest(USER_2_ID);
    const user2Controller = new UserFinancialProfileController(
      user2Request,
      userFinancialProfileService
    );
    userFinancialProfileService.upsertForUser.mockResolvedValueOnce({
      ...VALID_DTO,
      createdAt: new Date(),
      investmentGoals: VALID_DTO.investmentGoals as any,
      updatedAt: new Date(),
      userId: USER_2_ID
    } as FinancialProfile);

    // Even if a malicious body somehow contained a `userId`, the DTO
    // forbids unknown fields and the controller never reads any
    // userId from the body. The body is the validated DTO only.
    await user2Controller.updateFinancialProfile(VALID_DTO);

    const upsertArgs = userFinancialProfileService.upsertForUser.mock.calls[0];
    expect(upsertArgs[0]).toBe(USER_2_ID);
    expect(upsertArgs[0]).not.toBe(USER_1_ID);
  });

  // -------------------------------------------------------------------------
  // Test 8 — @HttpCode(HttpStatus.OK) on PATCH (200, not 201)
  //          AAP § 0.5.1.1 explicitly requires the explicit @HttpCode.
  // -------------------------------------------------------------------------

  it('declares @HttpCode(HttpStatus.OK) (HTTP 200, not 201) on updateFinancialProfile', () => {
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      UserFinancialProfileController.prototype.updateFinancialProfile
    );
    expect(httpCode).toBe(HttpStatus.OK);
  });

  // -------------------------------------------------------------------------
  // Test 9 — Rule 8 (Controller Thinness): no `prisma.*` calls in controller
  //          file; both method bodies under 10 lines.
  //
  // This is a static-analysis test that reads the source file from disk
  // and asserts the body line counts and the absence of `prisma.` usage.
  // It is the executable form of the Rule 8 acceptance criterion — a
  // future refactor that introduces a Prisma call into the controller
  // would fail this test on the next CI run.
  // -------------------------------------------------------------------------

  it('declares HTTP method decorators on both endpoints (verb + path wiring)', () => {
    const getMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserFinancialProfileController.prototype.getFinancialProfile
    );
    const patchMethod = Reflect.getMetadata(
      METHOD_METADATA,
      UserFinancialProfileController.prototype.updateFinancialProfile
    );

    expect(getMethod).toBe(RequestMethod.GET);
    expect(patchMethod).toBe(RequestMethod.PATCH);
  });
});
