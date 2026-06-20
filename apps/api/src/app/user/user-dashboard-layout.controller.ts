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
import type { UserDashboardLayout } from '@prisma/client';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { UpdateUserDashboardLayoutDto } from './dtos/update-user-dashboard-layout.dto';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * `UserDashboardLayoutController` exposes the two HTTP endpoints that gate
 * read and write access to the per-user `UserDashboardLayout` record
 * introduced by the Modular Dashboard feature (AAP § 0.1.1):
 *
 *     GET   /api/v1/user/layout  → 200 (record) | 404 (no record)
 *     PATCH /api/v1/user/layout  → 200 (upserted record)
 *
 * The route prefix `'user/layout'` is auto-prefixed at runtime with the
 * global `/api/v1` URI version configured in `apps/api/src/main.ts`; this
 * controller declares only the feature-relative segment.
 *
 * Both endpoints are guarded by `AuthGuard('jwt')` (HTTP 401 if the JWT is
 * missing/invalid) and `HasPermissionGuard` (HTTP 403 if the user lacks the
 * permission). The triple-decorator pattern mirrors the established
 * `user-financial-profile` precedent.
 *
 * SECURITY: the `userId` passed to the service is sourced exclusively from
 * `this.request.user.id` (JWT-derived) — NEVER from the request body, query,
 * or route param. `UpdateUserDashboardLayoutDto` intentionally omits a
 * `userId` field so a client cannot impersonate another user.
 *
 * CONTROLLER THINNESS: no method body exceeds 10 lines, and no Prisma call
 * appears here — `UserDashboardLayout` is imported as a type only and all
 * persistence lives in `UserDashboardLayoutService`. Invalid PATCH bodies are
 * rejected with HTTP 400 by the global `ValidationPipe` before the method runs.
 *
 * OBSERVABILITY: both endpoints generate a fresh correlation id (via
 * `node:crypto.randomUUID()`), emit it as the `X-Correlation-ID` response
 * header BEFORE the service call (so it is present on both success and error
 * paths, e.g. 404), AND propagate the SAME id into the service call so the
 * service's structured `[<correlationId>]` log lines tie back to the header a
 * client observed.
 */
@Controller('user/layout')
export class UserDashboardLayoutController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userDashboardLayoutService: UserDashboardLayoutService
  ) {}

  /**
   * Returns the authenticated user's persisted `UserDashboardLayout`.
   *
   * Resolves with HTTP 200 + the row when one exists. Throws
   * `NotFoundException` (HTTP 404 — explicitly NOT 500) when no record
   * exists, so the client can open the module catalog on a blank canvas for
   * a first-time user.
   */
  @Get()
  @HasPermission(permissions.readUserDashboardLayout)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getLayout(
    @Res({ passthrough: true }) response: Response
  ): Promise<UserDashboardLayout> {
    const correlationId = randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);

    const userId = this.request.user.id;
    const layout = await this.userDashboardLayoutService.findByUserId(
      userId,
      correlationId
    );

    if (!layout) {
      throw new NotFoundException(
        `Dashboard layout not found for user ${userId}`
      );
    }

    return layout;
  }

  /**
   * Creates or updates the authenticated user's `UserDashboardLayout`.
   *
   * The body is validated against `UpdateUserDashboardLayoutDto` by the global
   * `ValidationPipe` (an invalid body short-circuits with HTTP 400). On
   * success the upserted row is returned with HTTP 200 (`@HttpCode` makes the
   * status deterministic). The upsert is keyed on the `userId` primary key, so
   * re-issuing the same PATCH updates in place rather than duplicating.
   */
  @HttpCode(HttpStatus.OK)
  @Patch()
  @HasPermission(permissions.updateUserDashboardLayout)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async updateLayout(
    @Body() dto: UpdateUserDashboardLayoutDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<UserDashboardLayout> {
    const correlationId = randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);

    return this.userDashboardLayoutService.upsertForUser(
      this.request.user.id,
      dto,
      correlationId
    );
  }
}
