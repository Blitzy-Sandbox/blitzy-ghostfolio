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
 * sourced exclusively from `this.request.user.id`. The `X-Correlation-ID` and
 * `Cache-Control: no-store` response headers are stamped by
 * `layoutResponseHeadersMiddleware` (wired in `UserModule` and scoped to this
 * controller), which runs BEFORE the guards/pipe — so those headers are
 * present even on the 401/403/400 short-circuit responses, not only the
 * controller-executed 200/404 paths (QA F9 Issue 4). Each handler reads the
 * middleware-generated correlation id back off the response and reuses it for
 * the service call, giving a single id that correlates the middleware, guards,
 * controller, and service logs end-to-end (`Cache-Control: no-store` keeps
 * authenticated, user-specific layout data out of any browser or shared cache —
 * QA F5 Issue 1).
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
    // Reuse the correlation id that `layoutResponseHeadersMiddleware` (wired in
    // UserModule) already generated and stamped on the response, so a single id
    // correlates the middleware, guards, controller, and service logs
    // end-to-end (QA F9 Issue 4). Falls back to a fresh id when the middleware
    // did not run (e.g. direct controller unit tests).
    const correlationId =
      (response.getHeader('X-Correlation-ID') as string) ?? randomUUID();
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
    // Reuse the correlation id that `layoutResponseHeadersMiddleware` (wired in
    // UserModule) already generated and stamped on the response, so a single id
    // correlates the middleware, guards, controller, and service logs
    // end-to-end (QA F9 Issue 4). Falls back to a fresh id when the middleware
    // did not run (e.g. direct controller unit tests).
    const correlationId =
      (response.getHeader('X-Correlation-ID') as string) ?? randomUUID();
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
