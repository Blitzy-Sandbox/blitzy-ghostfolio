import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
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
import { UserDashboardLayout } from '@prisma/client';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * `UserDashboardLayoutController` exposes the per-user dashboard-layout
 * endpoints introduced by the single-canvas modular-dashboard refactor:
 *
 *     GET   /api/v1/user/layout  → 200 (row) | 404 (no row)
 *     PATCH /api/v1/user/layout  → 200 (upserted row)
 *
 * The route prefix `'user/layout'` is auto-prefixed at runtime with the
 * global `/api/v1` URI version configured in `apps/api/src/main.ts`.
 *
 * AUTH (Rule 8): both endpoints are guarded by `AuthGuard('jwt')` (HTTP 401
 * when the JWT is missing/invalid) and `HasPermissionGuard`. Following the
 * `getUser()` precedent in `UserController`, NO `@HasPermission(...)`
 * decorator is applied — any authenticated user may read/write their own
 * layout (`permissions.ts` is intentionally not extended). `HasPermissionGuard`
 * is a no-op when no permission metadata is present.
 *
 * SECURITY: the `userId` is sourced EXCLUSIVELY from `this.request.user.id`
 * (JWT-derived) — never from the body, query, or params. The DTO has no
 * `userId` field, so a client cannot impersonate another user.
 *
 * OBSERVABILITY (AAP § 0.7.2): a per-request correlation id is generated at
 * the controller boundary, surfaced as the `X-Correlation-ID` response header
 * (on both success and the 404 error path), and threaded into both service
 * calls for controller→service log tracing.
 *
 * RULE 8 (controller thinness): no Prisma calls here; each method delegates
 * persistence to `UserDashboardLayoutService`.
 */
@Controller('user/layout')
export class UserDashboardLayoutController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userDashboardLayoutService: UserDashboardLayoutService
  ) {}

  /**
   * Returns the authenticated user's persisted dashboard layout, or throws
   * `NotFoundException` (HTTP 404) when none exists. The client translates
   * the 404 to `null` to drive the blank-canvas / catalog-auto-open
   * first-visit experience (Rule 10). `userId` is JWT-derived.
   */
  @Get()
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
   * Creates or updates the authenticated user's dashboard layout. The body is
   * validated against `UpdateUserDashboardLayoutDto` by the global
   * `ValidationPipe` (an invalid body short-circuits with HTTP 400 before this
   * method runs). On success the upserted row is returned with HTTP 200
   * (`@HttpCode(HttpStatus.OK)` makes the success status deterministic).
   * `userId` is JWT-derived; the persisted array is `dto.layout`.
   */
  @HttpCode(HttpStatus.OK)
  @Patch()
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async updateLayout(
    @Body() dto: UpdateUserDashboardLayoutDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<UserDashboardLayout> {
    const correlationId = randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);

    return this.userDashboardLayoutService.upsertForUser(
      this.request.user.id,
      dto.layout,
      correlationId
    );
  }
}
