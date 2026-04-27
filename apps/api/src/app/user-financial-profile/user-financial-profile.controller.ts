import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Patch,
  Res,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { FinancialProfile } from '@prisma/client';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { FinancialProfileDto } from './dtos/financial-profile.dto';
import { UserFinancialProfileService } from './user-financial-profile.service';

/**
 * `UserFinancialProfileController` exposes the two HTTP endpoints that gate
 * read and write access to the per-user `FinancialProfile` record introduced
 * by AAP § 0.1.1:
 *
 *     GET   /api/v1/user/financial-profile  → 200 (record) | 404 (no record)
 *     PATCH /api/v1/user/financial-profile  → 200 (upserted record)
 *
 * The route prefix `'user/financial-profile'` is auto-prefixed at runtime
 * with the global `/api/v1` URI version configured in `apps/api/src/main.ts`
 * (per AAP § 0.1.1.1) — this controller therefore declares only the
 * feature-relative segment.
 *
 * Both endpoints are guarded by `AuthGuard('jwt')` (returns HTTP 401 if the
 * JWT is missing or invalid) and `HasPermissionGuard` (returns HTTP 403 if
 * the authenticated user lacks the relevant permission). The triple-decorator
 * pattern `@<HttpVerb>() @HasPermission(...) @UseGuards(AuthGuard('jwt'),
 * HasPermissionGuard)` mirrors the established precedent in
 * `apps/api/src/app/endpoints/ai/ai.controller.ts`.
 *
 * SECURITY (AAP § 0.7.1.5 — Rule 5): The `userId` passed to the service
 * layer is sourced exclusively from `this.request.user.id` (JWT-derived).
 * It is NEVER read from the request body, query string, route parameter, or
 * any other caller-controllable input. The PATCH endpoint's
 * `FinancialProfileDto` intentionally omits a `userId` field so a malicious
 * client cannot impersonate another user via the request payload.
 *
 * RULE 8 (Controller Thinness, AAP § 0.7.1.8): No method body in this file
 * exceeds 10 lines. No Prisma client calls appear here — `FinancialProfile`
 * is imported as a type only for the method return signatures, and all
 * persistence logic lives in `UserFinancialProfileService`. Validation of
 * the PATCH body is performed automatically by NestJS's global
 * `ValidationPipe` against the `FinancialProfileDto`'s `class-validator`
 * decorators (an invalid body short-circuits with HTTP 400 before any
 * controller method body executes).
 *
 * OBSERVABILITY (AAP § 0.7.2 — correlation-id propagation): Both endpoints
 * generate a fresh per-request correlation id at the controller boundary
 * via `node:crypto.randomUUID()` and surface it as the `X-Correlation-ID`
 * HTTP response header so client-side error reporters and support agents
 * can correlate a UI failure with the corresponding server-side log
 * entries (QA Checkpoint 11 Issue 4 fix). The header is emitted on both
 * the success path and the error path — `@Res({ passthrough: true })`
 * keeps NestJS in charge of body serialization, and Express preserves
 * headers set before a thrown exception so the global exception filter
 * still relays the id on `NotFoundException` / `BadRequestException`
 * responses.
 */
@Controller('user/financial-profile')
export class UserFinancialProfileController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userFinancialProfileService: UserFinancialProfileService
  ) {}

  /**
   * Returns the authenticated user's persisted `FinancialProfile` record.
   *
   * Resolves with HTTP 200 and the `FinancialProfile` row when one exists
   * for the JWT-verified user. Throws `NotFoundException` (HTTP 404 —
   * explicitly NOT HTTP 500, per AAP § 0.7.5.2 "Financial profile gate")
   * when no record exists, allowing the Angular `FinancialProfileFormComponent`
   * to distinguish a first-time setup case (empty form) from a server error.
   *
   * Rule 5 compliance: the `userId` argument supplied to the service is
   * sourced exclusively from `this.request.user.id` (JWT-derived).
   */
  @Get()
  @HasPermission(permissions.readFinancialProfile)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getFinancialProfile(
    @Res({ passthrough: true }) response: Response
  ): Promise<FinancialProfile> {
    response.setHeader('X-Correlation-ID', randomUUID());

    const userId = this.request.user.id;
    const profile = await this.userFinancialProfileService.findByUserId(userId);

    if (!profile) {
      throw new NotFoundException(
        `Financial profile not found for user ${userId}`
      );
    }

    return profile;
  }

  /**
   * Creates or updates the authenticated user's `FinancialProfile` record.
   *
   * The request body is automatically validated against `FinancialProfileDto`
   * by NestJS's global `ValidationPipe` (any structurally invalid body —
   * e.g. `retirementTargetAge < 18`, missing `riskTolerance`, malformed
   * `investmentGoals[]`, etc. — short-circuits with HTTP 400 before this
   * method runs). On success the upserted row is returned with HTTP 200;
   * `@HttpCode(HttpStatus.OK)` is applied explicitly so the success status
   * is deterministic and matches the AAP § 0.7.5.2 "Financial profile gate"
   * contract regardless of NestJS framework defaults.
   *
   * Rule 5 compliance: the `userId` argument supplied to the service is
   * sourced exclusively from `this.request.user.id` (JWT-derived). The DTO
   * deliberately has no `userId` field, so an attacker cannot impersonate
   * another user by injecting a foreign id into the request body.
   *
   * Idempotency: `UserFinancialProfileService.upsertForUser(...)` is keyed
   * on the `FinancialProfile.userId` primary key, so re-issuing the same
   * PATCH update updates the row in place rather than creating a duplicate.
   */
  @HttpCode(HttpStatus.OK)
  @Patch()
  @HasPermission(permissions.updateFinancialProfile)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async updateFinancialProfile(
    @Body() dto: FinancialProfileDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<FinancialProfile> {
    response.setHeader('X-Correlation-ID', randomUUID());

    return this.userFinancialProfileService.upsertForUser(
      this.request.user.id,
      dto,
      this.extractDateOfBirthFromJwtUser()
    );
  }

  /**
   * Reads the JWT-derived `dateOfBirth` from the authenticated user's
   * `Settings.settings` JSON column, which is the same source-of-truth
   * the client-side `FinancialProfileFormComponent` reads (see
   * `apps/client/src/app/components/financial-profile-form/`). The
   * shared `UserSettings` interface does not currently formally declare
   * `dateOfBirth`, so we narrow via a local cast — the cast is safe
   * because at runtime the field either exists (set by a forthcoming
   * server-side schema extension or by the user's profile workflow)
   * or evaluates to `undefined`.
   *
   * Rule 5 (FinancialProfile Authorization, AAP § 0.7.1.5): the value
   * is sourced exclusively from `this.request.user.settings...` (i.e.
   * the JWT-loaded user). It is NEVER read from the request body,
   * query string, route parameter, or any other caller-controllable
   * input — so a client cannot forge a different `dateOfBirth` to
   * bypass the service-layer age validation in
   * `UserFinancialProfileService.upsertForUser(...)`.
   *
   * Rule 8 (Controller Thinness, AAP § 0.7.1.8): extracting the JWT
   * read into this helper keeps `updateFinancialProfile()` at four
   * code lines — well under the ten-line ceiling — while preserving
   * the security-critical guarantee that the dateOfBirth feeding the
   * server-authoritative age check is JWT-derived, never request-body-
   * derived.
   *
   * @returns The JWT-derived dateOfBirth, or `null` when absent.
   */
  private extractDateOfBirthFromJwtUser(): string | Date | null {
    const settings = this.request.user.settings?.settings as
      | { dateOfBirth?: string | Date | null }
      | undefined;

    return settings?.dateOfBirth ?? null;
  }
}
