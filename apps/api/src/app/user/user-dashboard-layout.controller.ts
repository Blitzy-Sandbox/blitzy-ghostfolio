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
 * Per-user dashboard-layout endpoints:
 *
 *     GET   /api/v1/user/layout  → 200 (row) | 404 (no row)
 *     PATCH /api/v1/user/layout  → 200 (upserted row)
 *
 * Both endpoints are guarded by `AuthGuard('jwt')` and `HasPermissionGuard`
 * (no `@HasPermission(...)` decorator — any authenticated user may read/write
 * their own layout). `userId` is sourced exclusively from
 * `this.request.user.id`; the body carries no `userId`. Persistence is
 * delegated to `UserDashboardLayoutService`.
 *
 * Tracing: each request adopts an inbound `X-Correlation-ID` header when the
 * client supplies one (client → API propagation) and otherwise mints a new id;
 * the id is echoed back as `X-Correlation-ID` and threaded into the service
 * call. Design rationale lives in
 * `docs/decisions/dashboard-refactor-decisions.md` (D-003 for the separate
 * guarded controller and any-authenticated-user auth model; D-012 for the
 * correlation-ID tracing/observability design).
 */
@Controller('user/layout')
export class UserDashboardLayoutController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userDashboardLayoutService: UserDashboardLayoutService
  ) {}

  /**
   * Returns the authenticated user's persisted layout, or throws
   * `NotFoundException` (HTTP 404) when none exists. The client maps the 404
   * to `null` to drive the first-visit blank-canvas experience.
   */
  @Get()
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getLayout(
    @Res({ passthrough: true }) response: Response
  ): Promise<UserDashboardLayout> {
    const correlationId = this.resolveCorrelationId();
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
   * Creates or updates the authenticated user's layout. The body is validated
   * against `UpdateUserDashboardLayoutDto` by the global `ValidationPipe` (an
   * invalid body short-circuits with HTTP 400 before this method runs). Returns
   * the upserted row with HTTP 200.
   */
  @HttpCode(HttpStatus.OK)
  @Patch()
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async updateLayout(
    @Body() dto: UpdateUserDashboardLayoutDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<UserDashboardLayout> {
    const correlationId = this.resolveCorrelationId();
    response.setHeader('X-Correlation-ID', correlationId);

    return this.userDashboardLayoutService.upsertForUser(
      this.request.user.id,
      dto.layout,
      correlationId
    );
  }

  /**
   * Adopts a client-supplied `X-Correlation-ID` request header (normalizing an
   * array-valued header to its first entry) when present and non-empty,
   * otherwise mints a fresh UUID. Enables a single correlation id to span
   * client → API → service/Prisma log lines.
   */
  private resolveCorrelationId(): string {
    const inbound = this.request.headers?.['x-correlation-id'];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    return candidate?.trim() ? candidate : randomUUID();
  }
}
