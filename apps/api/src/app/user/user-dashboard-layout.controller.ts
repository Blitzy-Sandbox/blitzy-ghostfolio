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
  Logger,
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
 * Canonical HTTP route prefix surfaced to operators in structured request-
 * completion log lines emitted by this controller. The literal `/user/layout`
 * path matches the `@Controller('user/layout')` decorator below; the
 * runtime `/api/v1` global URI version (`apps/api/src/main.ts`) is omitted
 * from the log field for parity with the existing runbook contract
 * (`docs/observability/dashboard-layout.md` § Structured-Log Fields:
 * `route — /user/layout`).
 */
const LAYOUT_ROUTE = '/user/layout';

/**
 * Logger context tag used by every controller-level structured log line.
 * Centralized so that the runbook's `grep -F '[UserDashboardLayoutController]'`
 * filter is stable against future log-tag drift.
 */
const LOGGER_CONTEXT = 'UserDashboardLayoutController';

/**
 * Severity levels recognised by the controller-level request logger.
 * Mirrors the PR-aligned subset of the standard Pino/RFC-5424 levels:
 *   - INFO  — normal request completion (HTTP 2xx, HTTP 4xx including
 *             404 first-visit and 401/403 short-circuits).
 *   - ERROR — uncaught throw inside the handler body (HTTP 5xx).
 * The logger prints WARN-level lines via the same JSON payload using
 * `Logger.warn(...)` when an explicit warn-level event is observed; no
 * such path exists today on this controller.
 */
type RequestLogLevel = 'INFO' | 'ERROR';

/**
 * Structured request-completion log payload shape.
 *
 * Emitted at the END of every request that reaches this controller's
 * handler body — including the HTTP 200 success path, the HTTP 404
 * NotFoundException path, and the HTTP 5xx uncaught-error path.
 *
 * The set of required fields satisfies the project-level Observability
 * rule (AAP § 0.8.2.1) and the runbook contract at
 * `docs/observability/dashboard-layout.md` § Structured-Log Fields:
 *   - `correlationId` — UUID v4 propagated from the Express middleware
 *                       in `apps/api/src/main.ts` (or, in unit tests,
 *                       a fresh `randomUUID()`).
 *   - `userId`        — JWT-derived caller id; opaque internal UUID
 *                       (NOT external PII like email/SSN/etc.). Required
 *                       for support diagnostics and Rule-5 audit trails.
 *   - `route`         — HTTP route path (`/user/layout`).
 *   - `method`        — HTTP verb (`GET` or `PATCH`).
 *   - `statusCode`    — HTTP status (200, 404, 500, etc.).
 *   - `durationMs`    — Wall-clock duration of the handler body in
 *                       milliseconds (number, not string).
 *   - `level`         — Symbolic severity (`INFO` or `ERROR`).
 *   - `timestamp`     — ISO 8601 UTC timestamp at log emission.
 *
 * The `errorMessage` field is OPTIONAL and present only on the
 * uncaught-error path; it intentionally carries `error.message` only
 * (no stack trace, no PII, no payload contents) — the full stack
 * appears on a separate `Logger.error(...)` line emitted by NestJS's
 * default exception filter.
 *
 * Every value in this payload is JSON-serializable so
 * `JSON.stringify(payload)` produces a single greppable log line.
 */
interface RequestLogPayload {
  readonly correlationId: string;
  readonly userId: string;
  readonly route: string;
  readonly method: 'GET' | 'PATCH';
  readonly statusCode: number;
  readonly durationMs: number;
  readonly level: RequestLogLevel;
  readonly timestamp: string;
  readonly errorMessage?: string;
}

/**
 * Emits the `RequestLogPayload` at the appropriate severity.
 *
 * INFO entries use `Logger.log(...)`, ERROR entries use
 * `Logger.error(...)`. Both serialize the payload as a SINGLE JSON
 * object string so log aggregators (Loki, Datadog, CloudWatch) can
 * parse the structured fields uniformly. The `LOGGER_CONTEXT` tag
 * `'UserDashboardLayoutController'` is supplied as the second
 * argument so NestJS's framework formatter prepends `[<tag>]` to the
 * line — this preserves compatibility with the existing log-grep
 * conventions used by the runbook.
 *
 * No PII redaction is performed on the payload because (a) the
 * controller has already minimized the payload to identifiers only
 * (no email, no name, no body content), and (b) the field
 * documentation at `docs/observability/dashboard-layout.md`
 * explicitly enumerates `userId` as an opaque internal identifier
 * permitted at INFO level for support traceability.
 *
 * Resolves QA Checkpoint 12 finding Issue 2 (MAJOR — Structured
 * Logging): every successful and unsuccessful controller invocation
 * now emits a single structured log line with every field promised
 * by the runbook contract, on every code path.
 */
function emitRequestLog(payload: RequestLogPayload): void {
  const serialized = JSON.stringify(payload);

  if (payload.level === 'ERROR') {
    Logger.error(serialized, LOGGER_CONTEXT);
  } else {
    Logger.log(serialized, LOGGER_CONTEXT);
  }
}

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
 * The `X-Correlation-ID` HTTP response header is emitted on EVERY response
 * from `/api/v1/user/layout*` — including HTTP 200 success, HTTP 404
 * `NotFoundException`, AND the upstream short-circuit paths HTTP 400
 * (validation), HTTP 401 (auth), HTTP 403 (permission). The id is minted by
 * an Express middleware registered in `apps/api/src/main.ts` that runs
 * BEFORE NestJS guards/pipes, so even when the request is rejected before
 * this controller's method body executes, the header is still set on the
 * response. The middleware ALSO honors a caller-supplied `X-Correlation-ID`
 * request header so that distributed-tracing systems can propagate end-to-
 * end ids through the NestJS layer rather than having the server overwrite
 * them. The middleware stashes the correlationId on `request.correlationId`,
 * which the controller methods read here and forward to
 * `UserDashboardLayoutService` so structured logs and Prometheus metrics
 * share the same canonical id end-to-end. The `??` fallback to a fresh
 * `randomUUID()` preserves unit-test compatibility — synthetic request
 * objects built directly in `*.spec.ts` files do not traverse the
 * middleware. `@Res({ passthrough: true })` keeps NestJS in charge of body
 * serialization while still allowing the controller to write the header
 * defensively (idempotent for the middleware's value).
 *
 * **Resolves QA Checkpoint 9 finding AAP-Compliance #11** — previously the
 * `X-Correlation-ID` header was missing from 401 / 403 / 400 responses
 * because correlation-id generation happened inside the controller body,
 * which guards/pipes short-circuited. Promoting the generation to an
 * Express middleware fixed the gap.
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
   * Observability (AAP § 0.6.1.10): the per-request correlation id is
   * READ from `this.request.correlationId` (set by the Express middleware
   * registered in `main.ts` for `/api/v1/user/layout*` routes — see the
   * class-level JSDoc above), then re-asserted as the `X-Correlation-ID`
   * response header (idempotent if the middleware already set the same
   * value), and forwarded to the service so structured logs and Prometheus
   * metrics emitted during the read share it. A fresh `randomUUID()`
   * fallback applies in unit tests where the middleware does not run.
   *
   * 404 message contract (QA Checkpoint 9 finding 1.5.3): the user-facing
   * 404 BODY carries a generic message ("No layout found"); the userId
   * appears only in server-side structured logs (controller-level
   * request-completion JSON line at INFO level + service-layer free-text
   * annotation at INFO level — both for support diagnostics), never in
   * the response body.
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
    // Resolve the correlationId. The Express middleware registered in
    // `apps/api/src/main.ts` for `/api/v1/user/layout*` requests has
    // already minted a correlationId, attached it as the `X-Correlation-ID`
    // response header, and stashed it on the request object — including
    // for the upstream 401 / 403 / 400 short-circuit paths that NEVER
    // reach this controller body. We REUSE that id here so structured
    // logs from this method, the service layer, and the response header
    // all share a single canonical value. The `??` fallback to a fresh
    // `randomUUID()` keeps unit tests passing — the spec builds a
    // synthetic `request` object that does not go through the middleware
    // pipeline. Resolves QA Checkpoint 9 finding AAP-Compliance #11.
    const correlationId =
      (this.request as unknown as { correlationId?: string }).correlationId ??
      randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);

    const userId = this.request.user.id;
    // Capture wall-clock start time for the per-request structured log
    // line emitted on every code path. The duration spans the handler
    // body — service call + controller-side error mapping — so the value
    // approximates the metric-side histogram observation while remaining
    // independent of it (a log emission is guaranteed even if the
    // metrics service is misconfigured or unreachable).
    const startTime = Date.now();
    // Default the structured-log status code to HTTP 200 (success path).
    // The 404 NotFoundException branch and the 5xx uncaught-error branch
    // override `statusCode` BEFORE the `finally` block emits the log
    // line, keeping the status field accurate on every path.
    let statusCode: number = HttpStatus.OK;
    let level: RequestLogLevel = 'INFO';
    let errorMessage: string | undefined;

    try {
      const layout = await this.userDashboardLayoutService.findByUserId(
        userId,
        correlationId
      );

      if (!layout) {
        // Resolves QA Checkpoint 9 finding 1.5.3 (INFO) — "404 response
        // includes own userId". The 404 BODY carries a generic message
        // ("No layout found"); operator traceability is preserved through
        // (a) the `X-Correlation-ID` response header (set BEFORE this
        // throw), (b) the service-layer free-text annotation that
        // includes the userId at INFO level for support diagnostics, and
        // (c) the controller-level structured request-completion log
        // line below (emitted from the `finally` block at INFO level
        // with statusCode 404 — the 404 path is a normal first-visit
        // outcome per Rule 10's "blank canvas" semantics, not an error
        // condition).
        statusCode = HttpStatus.NOT_FOUND;
        throw new NotFoundException('No layout found');
      }

      return layout;
    } catch (error) {
      // NotFoundException is part of the AAP § 0.8.1.10 first-visit
      // semantics (not a server error) — re-throw as-is and let the
      // `finally` block emit an INFO-level structured log line with
      // statusCode=404. All other errors (database failures, unexpected
      // exceptions) bubble up to NestJS's global exception filter as
      // HTTP 500 with an ERROR-level log line.
      if (error instanceof NotFoundException) {
        // statusCode already set to 404 above; level remains INFO.
        throw error;
      }

      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      level = 'ERROR';
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      // Emit the per-request structured log line — runs on every code
      // path (success, 404, error) per the project-level Observability
      // rule (AAP § 0.8.2.1) and the runbook contract at
      // `docs/observability/dashboard-layout.md` § Structured-Log Fields.
      // Resolves QA Checkpoint 12 finding Issue 2 (MAJOR).
      emitRequestLog({
        correlationId,
        userId,
        route: LAYOUT_ROUTE,
        method: 'GET',
        statusCode,
        durationMs: Date.now() - startTime,
        level,
        timestamp: new Date().toISOString(),
        ...(errorMessage !== undefined ? { errorMessage } : {})
      });
    }
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
   * Observability (AAP § 0.6.1.10): the per-request correlation id is
   * READ from `this.request.correlationId` (set by the Express middleware
   * registered in `main.ts` for `/api/v1/user/layout*` routes — see the
   * class-level JSDoc above), then re-asserted as the `X-Correlation-ID`
   * response header (idempotent), and forwarded to the service so
   * structured logs and Prometheus metrics emitted during the upsert
   * share it. The middleware ensures the header is emitted on EVERY
   * response — including HTTP 400 validation errors that NestJS's
   * global `ValidationPipe` short-circuits before this method body
   * runs — which fixes the previously-documented gap. A fresh
   * `randomUUID()` fallback applies in unit tests where the middleware
   * does not run.
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
    // See the GET handler's correlationId comment for the full rationale —
    // the Express middleware in `main.ts` already minted, header-wrote,
    // and stashed a correlationId for `/api/v1/user/layout*` requests
    // (including 400 validation-error responses that NestJS's global
    // ValidationPipe short-circuits before this method runs). We reuse
    // the middleware-supplied id when present so logs, headers, and
    // metrics all share one canonical value. The `??` fallback to a
    // fresh `randomUUID()` preserves unit-test compatibility.
    const correlationId =
      (this.request as unknown as { correlationId?: string }).correlationId ??
      randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);

    // The `LayoutDataPayload` class instance is structurally a JSON-
    // serializable object after class-validator validation, but TypeScript's
    // nominal typing does not auto-equate the class type to the service's
    // `Prisma.JsonValue` parameter. The `as unknown as Parameters<...>`
    // cast bridges the controller's strongly-typed DTO surface to the
    // service's persistence-layer JSON input without leaking the `Prisma`
    // namespace into this controller (Rule 8 — Controller Thinness).
    const userId = this.request.user.id;
    // Capture wall-clock start time for the per-request structured log
    // line emitted on every code path. See the GET handler for the full
    // rationale — the same pattern is replicated here so the PATCH
    // endpoint also emits a complete structured log line on success and
    // error paths per the project-level Observability rule (AAP § 0.8.2.1).
    const startTime = Date.now();
    let statusCode: number = HttpStatus.OK;
    let level: RequestLogLevel = 'INFO';
    let errorMessage: string | undefined;

    try {
      return await this.userDashboardLayoutService.upsertForUser(
        userId,
        dto.layoutData as unknown as Parameters<
          UserDashboardLayoutService['upsertForUser']
        >[1],
        correlationId
      );
    } catch (error) {
      // PATCH does not have the AAP § 0.8.1.10 first-visit semantics that
      // GET enjoys — every uncaught error here is a server-side failure
      // surfaced to the operator at ERROR level with statusCode=500.
      // NestJS's global exception filter renders the HTTP 500 response.
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      level = 'ERROR';
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      // Emit the per-request structured log line — runs on every code
      // path (success, error) per the project-level Observability rule
      // (AAP § 0.8.2.1) and the runbook contract at
      // `docs/observability/dashboard-layout.md` § Structured-Log Fields.
      // Resolves QA Checkpoint 12 finding Issue 2 (MAJOR).
      emitRequestLog({
        correlationId,
        userId,
        route: LAYOUT_ROUTE,
        method: 'PATCH',
        statusCode,
        durationMs: Date.now() - startTime,
        level,
        timestamp: new Date().toISOString(),
        ...(errorMessage !== undefined ? { errorMessage } : {})
      });
    }
  }
}
