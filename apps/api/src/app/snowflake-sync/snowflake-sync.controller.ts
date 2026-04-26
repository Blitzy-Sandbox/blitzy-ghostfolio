import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { ManualTriggerDto } from './dtos/manual-trigger.dto';
import { SnowflakeSyncService } from './snowflake-sync.service';

/**
 * SnowflakeSyncController
 *
 * Feature A admin-only HTTP entry point that triggers an out-of-cycle
 * Snowflake sync. The full route is `POST /api/v1/snowflake-sync/trigger`
 * (the `/api/v1` prefix is auto-applied by `main.ts` URI versioning;
 * the controller therefore registers the un-versioned segment
 * `'snowflake-sync'`).
 *
 * The class is intentionally a thin pass-through (AAP § 0.1.2.1 and
 * Rule 8 in § 0.7.1.8): it extracts the JWT-verified caller from the
 * per-request injected `RequestWithUser`, lets NestJS's globally-
 * configured `ValidationPipe` validate the body against
 * `ManualTriggerDto`, and forwards the resulting parameters to
 * `SnowflakeSyncService.triggerManualSync(...)`. NO Prisma calls and
 * NO business logic appear here — the service owns the sync sequence,
 * the per-user authorization for `overrideUserId`, the correlation-id
 * generation, and the structured logging.
 *
 * Security posture (AAP § 0.1.2.2):
 *
 *  - `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` — JWT
 *    authentication runs first (returning HTTP 401 for missing or
 *    invalid bearer tokens), then permission enforcement
 *    (returning HTTP 403 if the caller lacks
 *    `permissions.triggerSnowflakeSync`).
 *
 *  - `@HasPermission(permissions.triggerSnowflakeSync)` — gates the
 *    endpoint to admin operators. The permission constant lives in
 *    the shared `libs/common/src/lib/permissions.ts` registry and is
 *    granted only to the `ADMIN` role (per the role table in that
 *    file).
 *
 *  - The caller's user id is sourced exclusively from the
 *    JWT-verified `request.user.id`. The DTO's `userId` field is an
 *    OPTIONAL admin override that the service uses to act on behalf
 *    of another user; the controller passes it through unchanged
 *    and never substitutes it for the caller id.
 *
 * Decorator order matches the Ghostfolio canonical pattern verified in
 * `apps/api/src/app/endpoints/ai/ai.controller.ts` (lines 29–31) and
 * `apps/api/src/app/admin/queue/queue.controller.ts` (lines 23–25):
 *   1. `@HttpCode(HttpStatus.OK)` (explicit override of `@Post` 201)
 *   2. `@Post('<segment>')`
 *   3. `@HasPermission(<permission>)`
 *   4. `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)`
 *
 * The HTTP code override is intentional: this endpoint TRIGGERS a
 * background mirror — no resource is created at the API surface
 * (Snowflake rows are MERGE-upserted internally, see Rule 7 in
 * § 0.7.1.7), so HTTP 200 is the semantically correct response code
 * rather than the default `@Post` 201.
 */
@Controller('snowflake-sync')
export class SnowflakeSyncController {
  public constructor(
    private readonly snowflakeSyncService: SnowflakeSyncService,
    @Inject(REQUEST) private readonly request: RequestWithUser
  ) {}

  /**
   * Triggers an out-of-cycle Snowflake sync for the JWT-authenticated
   * caller (or for `dto.userId` when the caller is acting as an admin
   * override).
   *
   * Body validation is delegated to the global `ValidationPipe` via the
   * sibling `ManualTriggerDto` — both fields are optional, so an empty
   * `{}` body is accepted and the service falls back to "today (UTC)"
   * for the date and the caller's own user id for the user.
   *
   * Method body is intentionally 5 lines (Rule 8: ≤ 10 lines) and
   * contains zero business logic, zero Prisma calls, and zero
   * permission checks beyond the decorator-driven `HasPermissionGuard`.
   * Errors raised by the service propagate to the global NestJS
   * exception filter, which already maps them to the appropriate HTTP
   * status code.
   *
   * @param dto Validated request body (both fields optional).
   * @returns The service envelope: `{ correlationId, date, success, userId }`.
   */
  @HttpCode(HttpStatus.OK)
  @Post('trigger')
  @HasPermission(permissions.triggerSnowflakeSync)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async triggerSync(@Body() dto: ManualTriggerDto) {
    return this.snowflakeSyncService.triggerManualSync({
      callerUserId: this.request.user.id,
      overrideUserId: dto.userId,
      overrideDate: dto.date
    });
  }
}
