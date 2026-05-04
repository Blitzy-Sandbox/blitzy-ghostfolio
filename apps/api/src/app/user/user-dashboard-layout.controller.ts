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
import { UserDashboardLayout } from '@prisma/client';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { UpdateDashboardLayoutDto } from './dtos/update-dashboard-layout.dto';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * `UserDashboardLayoutController` exposes the two HTTP endpoints that gate
 * read and write access to the per-user `UserDashboardLayout` record
 * introduced by AAP § 0.1.1 to power the modular dashboard refactor:
 *
 *     GET   /api/v1/user/layout  → 200 (record) | 404 (no record) | 401 | 403
 *     PATCH /api/v1/user/layout  → 200 (idempotent upsert) | 400 | 401 | 403
 *
 * The route prefix `'user/layout'` is auto-prefixed at runtime with the
 * global `/api/v1` URI version configured in `apps/api/src/main.ts` (per
 * AAP § 0.1.1.1).
 *
 * AUTH (AAP § 0.8.1.8 — Rule 8): Both endpoints declare
 * `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)` plus
 * `@HasPermission(...)` at METHOD level (NOT class level), mirroring the
 * established precedent in `apps/api/src/app/user-financial-profile/
 * user-financial-profile.controller.ts` (AAP § 0.6.1.3 structural
 * template) and `apps/api/src/app/user/user.controller.ts`. Unauthenticated
 * requests are rejected with HTTP 401 by `AuthGuard('jwt')` BEFORE the
 * permission guard runs; authenticated requests for users without the
 * relevant permission are rejected with HTTP 403 by `HasPermissionGuard`.
 *
 * SECURITY (AAP § 0.8.1.5 — Rule 5, JWT-Authoritative Identity):
 * The `userId` passed to the service layer is sourced exclusively from
 * `this.request.user.id` (JWT-derived). It is NEVER read from the request
 * body, query string, route parameter, or any other caller-controllable
 * input. The PATCH endpoint's `UpdateDashboardLayoutDto` intentionally
 * omits a `userId` field (Decision D-012, structural defense-in-depth)
 * so that a malicious client cannot impersonate another user via the
 * request payload — and any unrecognized field would additionally be
 * rejected by NestJS's global `ValidationPipe` (configured with
 * `whitelist: true`, `forbidNonWhitelisted: true`).
 *
 * RULE 8 (Controller Thinness, AAP § 0.7.1.8): NO Prisma client calls
 * appear here — `UserDashboardLayout` is imported as a TYPE only for the
 * method return signatures, and ALL persistence logic lives in
 * `UserDashboardLayoutService`. Validation of the PATCH body is performed
 * automatically by NestJS's global `ValidationPipe` against the
 * `UpdateDashboardLayoutDto`'s `class-validator` decorators (an invalid
 * body short-circuits with HTTP 400 BEFORE any controller method body
 * executes — the controller never sees a structurally-invalid payload).
 *
 * OBSERVABILITY (AAP § 0.6.1.10 + § 0.8.2.1 — correlation-id propagation):
 * Both endpoints generate a fresh per-request correlation id at the
 * controller boundary via `node:crypto.randomUUID()` (RFC 4122 v4) and
 * surface it as the `X-Correlation-ID` HTTP response header. The header
 * is set BEFORE the service call so it is emitted on BOTH the success
 * path (HTTP 200) AND the error paths reachable via the controller
 * method body (HTTP 404 `NotFoundException`, HTTP 500 service errors)
 * — Express preserves headers set before a thrown exception. The same
 * correlation id is forwarded to the service so structured logs and
 * Prometheus metrics emitted by `UserDashboardLayoutService` share it
 * for end-to-end traceability across the controller / service /
 * Prisma boundary. `@Res({ passthrough: true })` keeps NestJS in
 * charge of body serialization while still allowing the controller
 * to write the header.
 *
 * **Known limitation — HTTP 400 (DTO validation errors)**: NestJS's
 * global `ValidationPipe` runs BEFORE the controller method body
 * executes — when an incoming PATCH body fails class-validator (e.g.,
 * missing `layoutData`, `cols < 2`, `x + cols > 12`), the framework
 * short-circuits the request with HTTP 400 `BadRequestException`
 * before `randomUUID()` and `response.setHeader('X-Correlation-ID',
 * ...)` ever run. Therefore the X-Correlation-ID header is NOT
 * emitted on validation-error 400 responses. Requests rejected by
 * the upstream `AuthGuard('jwt')` (HTTP 401) and `HasPermissionGuard`
 * (HTTP 403) likewise short-circuit before the controller body and
 * therefore also do not carry the header. Operators troubleshooting
 * 400/401/403 responses MUST correlate via the global request
 * logger's request-id (e.g., the access log's per-request id) rather
 * than via this header. Promoting the correlation-id generation to a
 * NestJS interceptor that runs ahead of `ValidationPipe` would close
 * this gap; that is recorded as a future enhancement (out of scope
 * for the v1 dashboard refactor).
 *
 * IDEMPOTENCY (AAP § 0.8.1.4 — Decision D-019): The service method
 * `upsertForUser(...)` uses `prisma.userDashboardLayout.upsert(...)`
 * keyed on the `userId` primary key, so re-issuing the same PATCH with
 * an identical payload updates the row in place rather than creating a
 * duplicate or producing a uniqueness violation. This contract is
 * REQUIRED because the Angular client issues debounced 500 ms PATCH
 * bursts in response to drag/resize/add/remove grid events
 * (AAP § 0.6.3.3) — the controller's PATCH endpoint must safely absorb
 * the deduplicated bursts.
 *
 * STRUCTURAL TEMPLATE (AAP § 0.6.1.3): This controller mirrors
 * `apps/api/src/app/user-financial-profile/user-financial-profile.controller.ts`
 * verbatim — same import grouping, same constructor parameter order
 * (`@Inject(REQUEST)` first, service second), same triple-decorator
 * pattern, same `@Res({ passthrough: true })` injection, same
 * `randomUUID()` correlation-id generation, same `@HttpCode(HttpStatus.OK)`
 * on PATCH, same `NotFoundException` mapping. Cross-reference:
 * `apps/api/src/app/snowflake-sync/snowflake-sync.controller.ts` provides
 * additional precedent for `setHeader` BEFORE service call.
 */
@Controller('user/layout')
export class UserDashboardLayoutController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userDashboardLayoutService: UserDashboardLayoutService
  ) {}

  /**
   * Returns the authenticated user's persisted `UserDashboardLayout` row.
   *
   * Resolves with HTTP 200 and the `UserDashboardLayout` record when one
   * exists for the JWT-verified user. Throws `NotFoundException` (HTTP 404
   * — explicitly NOT HTTP 500) when no record exists, allowing the
   * Angular `GfDashboardCanvasComponent` to distinguish a first-visit
   * scenario from a server error: the 404 path triggers the "blank canvas
   * + auto-open module catalog" first-visit semantics required by
   * AAP § 0.8.1.10 (Rule 10) and AAP § 0.6.3.1.
   *
   * Rule 5 compliance (AAP § 0.8.1.5 — JWT-Authoritative Identity): the
   * `userId` argument supplied to the service is sourced exclusively from
   * `this.request.user.id` (JWT-derived). It is NEVER read from the
   * request body, query string, or route parameter.
   *
   * Observability (AAP § 0.6.1.10): a fresh per-request correlation id
   * is emitted as the `X-Correlation-ID` response header BEFORE the
   * service call, so the header is also emitted on the 404 path
   * (Express preserves headers set before a thrown exception). The same
   * id is forwarded to the service so structured logs and Prometheus
   * metrics emitted during the read share it.
   *
   * @param response Express response, passthrough-injected for header
   *                 decoration only.
   * @returns        The persisted `UserDashboardLayout` row.
   * @throws         `NotFoundException` (HTTP 404) when no record exists
   *                 for the JWT-verified user.
   */
  @Get()
  @HasPermission(permissions.readUserDashboardLayout)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async findOne(
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
      throw new NotFoundException(`No layout found for user ${userId}`);
    }

    return layout;
  }

  /**
   * Creates or updates the authenticated user's `UserDashboardLayout` record.
   *
   * The request body is automatically validated against
   * `UpdateDashboardLayoutDto` by NestJS's global `ValidationPipe` (any
   * structurally invalid body — e.g. missing `layoutData`, malformed
   * `items[]`, `cols < 2`, `x + cols > 12`, `version !== 1`, items array
   * length > 50, etc. — short-circuits with HTTP 400 BEFORE this method
   * runs). On success the upserted row is returned with HTTP 200;
   * `@HttpCode(HttpStatus.OK)` is applied explicitly so the success
   * status is deterministic and matches the AAP § 0.6.1.3 contract
   * regardless of NestJS framework defaults.
   *
   * Rule 5 compliance (AAP § 0.8.1.5 — JWT-Authoritative Identity): the
   * `userId` argument supplied to the service is sourced exclusively
   * from `this.request.user.id` (JWT-derived). The DTO deliberately has
   * no `userId` field (Decision D-012, structural defense-in-depth), so
   * an attacker cannot impersonate another user by injecting a foreign
   * id into the request body. Only `dto.layoutData` (NOT the entire
   * `dto`) is forwarded to the service so that future top-level DTO
   * fields are NOT inadvertently echoed into the persisted JSON column.
   *
   * Idempotency (AAP § 0.8.1.4 — Decision D-019):
   * `UserDashboardLayoutService.upsertForUser(...)` is keyed on the
   * `UserDashboardLayout.userId` primary key, so re-issuing the same
   * PATCH update updates the row in place rather than creating a
   * duplicate or producing a uniqueness violation. This contract is
   * REQUIRED because the Angular client
   * (`apps/client/src/app/dashboard/services/user-dashboard-layout.service.ts`)
   * issues debounced 500 ms PATCH bursts in response to drag/resize/add/
   * remove grid events (AAP § 0.6.3.3) — the controller's PATCH endpoint
   * must safely absorb the deduplicated bursts without producing
   * duplicate rows.
   *
   * Observability (AAP § 0.6.1.10): a fresh per-request correlation id
   * is emitted as the `X-Correlation-ID` response header BEFORE the
   * service call, so the header is emitted on the 200 success path
   * AND on HTTP 500 service errors thrown after `setHeader` runs
   * (Express preserves headers set before a thrown exception). The
   * header is NOT emitted on HTTP 400 validation errors because
   * NestJS's global `ValidationPipe` short-circuits the request
   * before this method body executes (see the class-level JSDoc's
   * "Known limitation" section for the full propagation matrix and
   * the operator-facing remediation guidance). The same id is
   * forwarded to the service so structured logs and Prometheus
   * metrics emitted during the upsert share it.
   *
   * @param dto      Validated request body containing the
   *                 `LayoutDataPayload` payload.
   * @param response Express response, passthrough-injected for header
   *                 decoration only.
   * @returns        The upserted `UserDashboardLayout` row.
   */
  @HttpCode(HttpStatus.OK)
  @Patch()
  @HasPermission(permissions.updateUserDashboardLayout)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async update(
    @Body() dto: UpdateDashboardLayoutDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<UserDashboardLayout> {
    const correlationId = randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);

    // The `LayoutDataPayload` class instance is structurally a JSON-
    // serializable object after class-validator validation, but TypeScript's
    // nominal typing does not auto-equate the class type to the service's
    // `Prisma.JsonValue` parameter. The `as unknown as Parameters<...>`
    // cast bridges the controller's strongly-typed DTO surface to the
    // service's persistence-layer JSON input without leaking the `Prisma`
    // namespace into this controller (Rule 8 — Controller Thinness).
    const userId = this.request.user.id;
    return this.userDashboardLayoutService.upsertForUser(
      userId,
      dto.layoutData as unknown as Parameters<
        UserDashboardLayoutService['upsertForUser']
      >[1],
      correlationId
    );
  }
}
