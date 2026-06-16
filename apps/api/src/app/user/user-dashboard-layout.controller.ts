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
 * `UserDashboardLayoutController` exposes the two authenticated dashboard
 * layout endpoints:
 *
 *     GET   /api/v1/user/layout  → 200 (record) | 404 (no record)
 *     PATCH /api/v1/user/layout  → 200 (upserted record)
 *
 * The `'user/layout'` prefix is auto-prefixed at runtime with the global
 * `/api/v1` URI version from `apps/api/src/main.ts`. Both endpoints are
 * guarded by `AuthGuard('jwt')` (401) and `HasPermissionGuard` (403); the
 * global `ValidationPipe` rejects an invalid PATCH body with 400. `userId` is
 * sourced exclusively from `this.request.user.id`, and a fresh
 * `X-Correlation-ID` response header is set before the service call (so it is
 * present on success and error paths) and passed to the service for
 * end-to-end log correlation. Both responses are additionally marked
 * `Cache-Control: no-store` so authenticated, user-specific layout data is
 * never persisted by the browser or a shared/intermediary cache (QA F5
 * Issue 1).
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
    // Authenticated, user-specific layout data must never be cached by the
    // browser or any shared/intermediary cache (QA F5 Issue 1). Set before the
    // service call so it is present on both the success (200) and error paths.
    response.setHeader('Cache-Control', 'no-store');

    const userId = this.request.user.id;
    const layout = await this.userDashboardLayoutService.findByUserId(
      userId,
      correlationId
    );

    if (!layout) {
      throw new NotFoundException('Dashboard layout not found');
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
    // Authenticated, user-specific layout data must never be cached by the
    // browser or any shared/intermediary cache (QA F5 Issue 1).
    response.setHeader('Cache-Control', 'no-store');

    return this.userDashboardLayoutService.upsertForUser(
      this.request.user.id,
      dto,
      correlationId
    );
  }
}
