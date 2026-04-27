import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import type { RebalancingResponse } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { RebalancingRequestDto } from './dtos/rebalancing-request.dto';
import { RebalancingService } from './rebalancing.service';

/**
 * `RebalancingController` is the NestJS HTTP entry point for **Feature C —
 * Explainable Rebalancing Engine** (AAP § 0.1.1, § 0.5.1.1, § 0.7.5.2). It
 * exposes a single non-streaming JSON endpoint at `POST /api/v1/ai/rebalancing`
 * (the `/api/v1` prefix is supplied by the application-level URI versioning
 * configured in `apps/api/src/main.ts`; the `'ai/rebalancing'` route prefix
 * combined with that versioning resolves to the path defined in the AAP
 * endpoint matrix at § 0.1.2.4).
 *
 * Hard-rule compliance enforced by this class:
 *
 * - **Rule 1 (Module Isolation, AAP § 0.7.1.1):** All cross-module symbols are
 *   imported either from `@nestjs/*` public packages, from sibling files
 *   inside the same `rebalancing` module directory, or from the `libs/common`
 *   barrel (`@ghostfolio/common/*`) and the `apps/api/src/decorators` /
 *   `apps/api/src/guards` shared infrastructure folders. NO import paths reach
 *   into another feature module's directory.
 *
 * - **Rule 4 (Tool-Use Structured Output, AAP § 0.7.1.4):** This controller
 *   does NOT call the Anthropic SDK directly and does NOT inspect any
 *   `tool_use` content block. Structured-output handling is the sole
 *   responsibility of `RebalancingService.recommend(...)`. The controller's
 *   role is to forward the validated request body and the JWT-authoritative
 *   `userId` to the service and return the typed `RebalancingResponse`
 *   verbatim.
 *
 * - **Rule 8 (Controller Thinness, AAP § 0.7.1.8):** This controller has
 *   exactly one endpoint method and zero helper methods. The method body is
 *   well under the 10-line cap: it generates a per-request correlationId then
 *   forwards the validated request body and the JWT-authenticated userId to
 *   `RebalancingService.recommend({...})`, returning the resulting
 *   `Promise<RebalancingResponse>` directly. There is no business logic, no
 *   Prisma access, no conditional branching, no error mapping, and no I/O in
 *   this file — every concern of that kind is delegated to the service.
 *
 * - **JWT-authoritative `userId` (AAP § 0.5.1.5, § 0.7.3):** The `userId`
 *   passed to the service is sourced EXCLUSIVELY from `this.request.user.id`
 *   — i.e., from the `RequestWithUser` populated by the JWT auth guard via
 *   `JwtStrategy.validate()`. The DTO does NOT carry a `userId` field, and
 *   even if it did, the controller would not read it. This prevents an
 *   authenticated user from impersonating another user by smuggling a
 *   different `userId` in the request body.
 *
 * - **Per-request correlationId (Observability, AAP § 0.7.2):** A fresh
 *   `correlationId` is generated at the controller boundary on every request
 *   via Node's built-in `node:crypto.randomUUID()`. The id is (a) forwarded
 *   to the service which propagates it through every structured log line
 *   and the downstream Anthropic API invocation, AND (b) emitted to the
 *   client as the `X-Correlation-ID` HTTP response header so support
 *   diagnostics can correlate a user-visible failure with the corresponding
 *   server-side log entries (QA Checkpoint 11 Issue 4 fix). The header is
 *   set on both the success path and the error path — `@Res({ passthrough:
 *   true })` keeps NestJS in charge of serializing the typed response body,
 *   and the global exception filter preserves headers set before the
 *   thrown exception, so a `BadGatewayException` in the service still
 *   surfaces the correlation id to the client.
 *
 * - **Auth pipeline (`@UseGuards(AuthGuard('jwt'), HasPermissionGuard)`):**
 *   `AuthGuard('jwt')` activates the existing `JwtStrategy` which reads the
 *   `Authorization: Bearer <jwt>` header, verifies it via `JWT_SECRET_KEY`,
 *   and populates `request.user` with the resolved `UserWithSettings`;
 *   `HasPermissionGuard` then enforces the `permissions.readAiRebalancing`
 *   permission attached via `@HasPermission(...)`. Unauthenticated requests
 *   are rejected with HTTP 401 by the JWT guard before this controller
 *   method runs; users lacking the permission are rejected with HTTP 403 by
 *   the permission guard.
 *
 * - **Non-streaming response (AAP § 0.6.2.1, § 0.7.3):** Unlike the AI chat
 *   feature (which uses `@Sse()`), the rebalancing endpoint returns a single
 *   JSON `RebalancingResponse` payload. The service uses
 *   `anthropic.messages.create(...)` (not `stream(...)`) per Rule 4 because
 *   the structured `tool_use` content block is only available on the
 *   completed response.
 */
@Controller('ai/rebalancing')
export class RebalancingController {
  public constructor(
    private readonly rebalancingService: RebalancingService,
    @Inject(REQUEST) private readonly request: RequestWithUser
  ) {}

  /**
   * Generates a structured rebalancing recommendation for the authenticated
   * user.
   *
   * Request shape: `POST /api/v1/ai/rebalancing` with a JSON body matching
   * {@link RebalancingRequestDto} — currently `{ targetAllocation?:
   * Record<string, number> }` where every field is optional. The DTO is
   * validated by the application's global `ValidationPipe` (`whitelist: true`,
   * `forbidNonWhitelisted: true`); malformed bodies are rejected with HTTP
   * 400 BEFORE this method body executes.
   *
   * Response shape: a single JSON `RebalancingResponse` payload (per AAP
   * § 0.1.2.4) populated EXCLUSIVELY from the Anthropic SDK `tool_use`
   * content block (Rule 4). Every entry in `recommendations` carries a
   * non-empty `rationale` and `goalReference`; if Anthropic returns an
   * unexpected shape, the service throws `BadGatewayException` (HTTP 502)
   * which the global exception filter maps to a typed error response.
   *
   * HTTP status code: `@HttpCode(HttpStatus.OK)` overrides NestJS's default
   * `@Post()` status of 201 Created. The rebalancing endpoint is query-style
   * — it returns structured recommendations derived from the user's
   * current portfolio and creates NO resource at the API surface (the
   * response is a transient `RebalancingResponse`; nothing is persisted
   * server-side), so HTTP 200 is the semantically correct success code.
   * This matches the pattern already used by the sibling
   * `SnowflakeSyncController` and `UserFinancialProfileController` in this
   * project. See QA Test Report — Checkpoint 9 INFO #1 for the original
   * finding.
   *
   * Security: the `userId` forwarded to the service is read exclusively from
   * the JWT-authenticated `request.user.id`. The DTO carries no `userId`
   * field — the authoritative identifier comes only from the
   * `JwtStrategy`-validated bearer token. This is the single most critical
   * security invariant of this endpoint and is verified by
   * `rebalancing.controller.spec.ts`.
   *
   * @param   rebalancingRequestDto Validated request body carrying optional
   *                                override fields (e.g.,
   *                                `targetAllocation`).
   * @returns A `Promise` resolving to the structured `RebalancingResponse`
   *          produced by `RebalancingService.recommend(...)`.
   */
  @HttpCode(HttpStatus.OK)
  @Post()
  @HasPermission(permissions.readAiRebalancing)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getRebalancing(
    @Body() rebalancingRequestDto: RebalancingRequestDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<RebalancingResponse> {
    const correlationId = randomUUID();

    response.setHeader('X-Correlation-ID', correlationId);

    return this.rebalancingService.recommend({
      correlationId,
      requestPayload: rebalancingRequestDto,
      userId: this.request.user.id
    });
  }
}
