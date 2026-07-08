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
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { UserDashboardLayout } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { DashboardLayoutDto } from './dtos/dashboard-layout.dto';
import { getCorrelationId } from './user-dashboard-layout.middleware';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * `UserDashboardLayoutController` exposes the two HTTP endpoints that gate
 * read and write access to the per-user `UserDashboardLayout` record
 * introduced by AAP § 0.1.1 (single-canvas modular dashboard):
 *
 *     GET   /api/v1/user/layout  → 200 (record) | 404 (no saved layout)
 *     PATCH /api/v1/user/layout  → 200 (upserted record)
 *
 * The route prefix `'user/layout'` is auto-prefixed at runtime with the
 * global `/api/v1` URI version configured in `apps/api/src/main.ts`, so this
 * controller declares only the feature-relative segment.
 *
 * AUTH (AAP § 0.7.3 — Rule 8): both endpoints are guarded by
 * `AuthGuard('jwt')` (HTTP 401 when the JWT is missing/invalid) and
 * `HasPermissionGuard` (HTTP 403 when the authenticated user lacks the
 * relevant permission — e.g. the DEMO role, which is NOT granted the layout
 * permissions). The `userId` passed to the service is sourced exclusively
 * from `this.request.user.id` (JWT-derived) — NEVER from the request body,
 * query string, or route param. `DashboardLayoutDto` intentionally omits a
 * `userId` field so a client cannot impersonate another user via the payload.
 *
 * RULE 8 (Controller Thinness): no method body performs Prisma calls or
 * business logic — `UserDashboardLayout` is imported only as a return type
 * and all persistence lives in `UserDashboardLayoutService`. The PATCH body
 * is auto-validated by the global `ValidationPipe` against `DashboardLayoutDto`
 * (invalid body → HTTP 400 before the method runs).
 *
 * OBSERVABILITY (AAP § 0.6.1 / § 0.8.4): the per-request correlation id and
 * the `X-Correlation-ID` response header are owned by
 * `UserDashboardLayoutObservabilityMiddleware` (applied to these routes via
 * `UserModule.configure(...)`), which runs BEFORE the guard/pipe boundary so
 * the header, metrics, and a structured log line are emitted on EVERY outcome
 * — including guard-rejected `401`/`403` and pipe-rejected `400` that never
 * reach this handler. This controller simply reuses the middleware-generated
 * id (via `getCorrelationId`) and propagates it into the service so the
 * service-layer Prisma-error logs share the same id. When the middleware did
 * not run (an isolated unit test constructing the controller directly), it
 * falls back to a freshly generated id.
 */
@Controller('user/layout')
export class UserDashboardLayoutController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userDashboardLayoutService: UserDashboardLayoutService
  ) {}

  /**
   * Returns the authenticated user's persisted `UserDashboardLayout` record.
   *
   * Resolves with HTTP 200 and the row when one exists for the JWT-verified
   * user. Throws `NotFoundException` (HTTP 404 — explicitly NOT HTTP 500)
   * when no record exists, so the client can map 404 → null and render a
   * blank canvas with the module catalog auto-opened (Rule 10).
   *
   * Rule 8 compliance: the `userId` is sourced exclusively from
   * `this.request.user.id` (JWT-derived).
   */
  @Get()
  @HasPermission(permissions.readDashboardLayout)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getDashboardLayout(): Promise<UserDashboardLayout> {
    const correlationId = this.resolveCorrelationId();

    const userId = this.request.user.id;
    const layout = await this.userDashboardLayoutService.findByUserId(
      userId,
      correlationId
    );

    if (!layout) {
      // SECURITY (CWE-200 / CWE-209): the 404 message MUST NOT embed the
      // `userId` (or any request-scoped identifier). The authenticated caller
      // already knows their own identity, so echoing it back adds no value
      // while risking information disclosure if the response is logged or
      // surfaced. The correlation id (returned via the `X-Correlation-ID`
      // header and emitted in the structured server logs) is the supported
      // way to tie a specific 404 back to a request during debugging.
      throw new NotFoundException('Dashboard layout not found');
    }

    return layout;
  }

  /**
   * Creates or updates the authenticated user's `UserDashboardLayout` record.
   *
   * The request body is auto-validated against `DashboardLayoutDto` by the
   * global `ValidationPipe` (any structurally invalid body — e.g. an item
   * with `cols < 2` / `rows < 2`, a missing `type`, etc. — short-circuits
   * with HTTP 400 before this method runs). On success the upserted row is
   * returned with HTTP 200 (`@HttpCode(HttpStatus.OK)` makes the success
   * status deterministic).
   *
   * Rule 8 compliance: the `userId` is sourced exclusively from
   * `this.request.user.id` (JWT-derived); the DTO has no `userId` field.
   * Idempotency: the service upsert is keyed on the `userId` primary key, so
   * re-issuing PATCH updates the row in place.
   */
  @HttpCode(HttpStatus.OK)
  @Patch()
  @HasPermission(permissions.updateDashboardLayout)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async updateDashboardLayout(
    @Body() dto: DashboardLayoutDto
  ): Promise<UserDashboardLayout> {
    const correlationId = this.resolveCorrelationId();

    return this.userDashboardLayoutService.upsertForUser(
      this.request.user.id,
      dto,
      correlationId
    );
  }

  /**
   * Returns the correlation id stamped on the request by
   * `UserDashboardLayoutObservabilityMiddleware`. Falls back to a freshly
   * generated id when the middleware did not run (e.g. an isolated unit test
   * that instantiates the controller directly), so the service always
   * receives a valid id to tag its logs with.
   */
  private resolveCorrelationId(): string {
    return getCorrelationId(this.request) ?? randomUUID();
  }
}
