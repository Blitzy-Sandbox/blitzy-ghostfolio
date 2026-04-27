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
  MessageEvent,
  Post,
  Res,
  Sse,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

import { AiChatService } from './ai-chat.service';
import { ChatRequestDto } from './dtos/chat-request.dto';

/**
 * `AiChatController` is the NestJS HTTP entry point for **Feature B — AI
 * Portfolio Chat Agent** (AAP § 0.1.1, § 0.5.1.1). It exposes a single
 * Server-Sent Events (SSE) streaming endpoint at `POST /api/v1/ai/chat`
 * (the `/api/v1` prefix is supplied by the application-level URI versioning
 * configured in `apps/api/src/main.ts`; the `'ai/chat'` route prefix combined
 * with this versioning resolves to the path defined in the AAP endpoint
 * matrix at § 0.1.2.4).
 *
 * Hard-rule compliance enforced by this class:
 *
 * - **Rule 1 (Module Isolation, AAP § 0.7.1.1):** All cross-module symbols
 *   are imported either from `@nestjs/*` public packages, from sibling files
 *   inside the same `ai-chat` module directory, or from the `libs/common`
 *   barrel (`@ghostfolio/common/*`) and the `apps/api/src/decorators` /
 *   `apps/api/src/guards` shared infrastructure folders. NO import paths
 *   reach into another feature module's directory.
 *
 * - **Rule 8 (Controller Thinness, AAP § 0.7.1.8):** This controller has
 *   exactly one endpoint method and zero helper methods. The method body is
 *   well under the 10-line cap: it generates a per-request correlationId,
 *   then forwards the validated request body and the JWT-authenticated
 *   userId to `AiChatService.streamChat({...})`, returning the resulting
 *   `Observable<MessageEvent>` directly. There is no business logic, no
 *   Prisma access, no conditional branching, no error mapping, and no I/O
 *   in this file — every concern of that kind is delegated to the service.
 *
 * - **JWT-authoritative `userId` (AAP § 0.5.1.5, § 0.7.3):** The `userId`
 *   passed to the service is sourced EXCLUSIVELY from `this.request.user.id`
 *   — i.e., from the `RequestWithUser` populated by the JWT auth guard via
 *   `JwtStrategy.validate()`. The DTO does NOT carry a `userId` field, and
 *   even if it did, the controller would not read it. This prevents an
 *   authenticated user from impersonating another user by smuggling a
 *   different `userId` in the request body.
 *
 * - **Stateless protocol (AAP § 0.1.1.1, § 0.5.1.1):** This controller holds
 *   no per-conversation state. The `ChatRequestDto` enforces an
 *   `@ArrayMaxSize(5)` cap on the `messages` array (4 prior turns + 1 new
 *   user turn), so the client carries the full short-window history on
 *   every request.
 *
 * - **Observability (AAP § 0.7.2):** A fresh per-request `correlationId` is
 *   generated at this controller boundary using Node's built-in
 *   `node:crypto` `randomUUID()` (avoiding a `uuid` package dependency —
 *   Node 22.18+ ships `randomUUID` in the standard library, per
 *   `package.json` `engines.node >=22.18.0`). The correlationId is
 *   (a) propagated downstream so structured `Logger` output across the
 *   service, tool dispatches, and Anthropic API calls can be threaded
 *   together for a single chat request, (b) emitted on every SSE `done` /
 *   `tool_call` / `error` event payload, AND (c) emitted as the
 *   `X-Correlation-ID` HTTP response header on the initial SSE response
 *   line so client-side error reporters can capture it without parsing the
 *   stream (QA Checkpoint 11 Issue 4). The header is set via
 *   `@Res({ passthrough: true })`, which keeps NestJS's `@Sse()` lifecycle
 *   in charge of streaming the body while letting us decorate the headers.
 *
 * - **SSE protocol (AAP § 0.7.5.2):** The `@Sse()` decorator instructs
 *   NestJS to subscribe to the returned `Observable<MessageEvent>` and pipe
 *   each emission to the HTTP response with `Content-Type: text/event-stream`
 *   and `Cache-Control: no-cache`, satisfying the "response Content-Type:
 *   text/event-stream" assertion of the chat agent gate. POST is used
 *   (instead of GET, which the W3C `EventSource` API requires) because the
 *   conversation history is JSON-shaped and length-unbounded by query-
 *   string limits; the Angular `ChatPanelComponent` consumes the stream
 *   via a `fetch` + `ReadableStream` adapter rather than `EventSource`.
 *
 * - **Auth chain:** `@UseGuards(AuthGuard('jwt'), HasPermissionGuard)`
 *   matches the canonical Ghostfolio pattern (verified across
 *   `apps/api/src/app/endpoints/ai/ai.controller.ts`,
 *   `apps/api/src/app/portfolio/portfolio.controller.ts`, etc.).
 *   `AuthGuard('jwt')` activates the existing `JwtStrategy` which reads
 *   the `Authorization: Bearer <jwt>` header, verifies it via
 *   `JWT_SECRET_KEY`, and populates `request.user` with the resolved
 *   `UserWithSettings`; `HasPermissionGuard` then enforces the
 *   `permissions.readAiChat` permission attached via `@HasPermission(...)`.
 *   Unauthenticated requests are rejected with HTTP 401 by the JWT guard
 *   before this controller method runs; users lacking the permission are
 *   rejected with HTTP 403 by the permission guard.
 */
@Controller('ai/chat')
export class AiChatController {
  public constructor(
    private readonly aiChatService: AiChatService,
    @Inject(REQUEST) private readonly request: RequestWithUser
  ) {}

  /**
   * Streams a Claude chat completion as Server-Sent Events for the
   * authenticated user.
   *
   * Request shape: `POST /api/v1/ai/chat` with a JSON body matching
   * {@link ChatRequestDto} — `{ messages: ChatMessageDto[] }` where the
   * array length is bounded to 5 entries. The DTO is validated by the
   * application's global `ValidationPipe` (`whitelist: true`,
   * `forbidNonWhitelisted: true`); malformed bodies are rejected with HTTP
   * 400 BEFORE this method body executes.
   *
   * Response shape: a `text/event-stream` whose individual SSE frames are
   * `MessageEvent` objects emitted by the service. The discriminated event
   * payload formats are documented on
   * {@link AiChatService.streamChat}.
   *
   * HTTP status code: `@HttpCode(HttpStatus.OK)` overrides NestJS's default
   * `@Post()` status of 201 Created. The chat-completion endpoint is
   * RPC-style — it streams a model response back to the caller and creates
   * NO resource at the API surface (chat is stateless server-side per AAP
   * § 0.7.3 "Stateless chat protocol — 4-turn limit"), so HTTP 200 is the
   * semantically correct success code. This matches the pattern already
   * used by the sibling `SnowflakeSyncController` and
   * `UserFinancialProfileController` in this project (and by the existing
   * Ghostfolio `AiController` / queue controllers). See QA Test Report —
   * Checkpoint 9 INFO #1 for the original finding.
   *
   * Security: the `userId` forwarded to the service is read exclusively
   * from the JWT-authenticated `request.user.id`. The DTO carries no
   * `userId` field — the authoritative identifier comes only from the
   * `JwtStrategy`-validated bearer token. This is the single most critical
   * security invariant of this endpoint.
   *
   * @param chatRequestDto Validated request body containing the
   *                       conversation history (max 5 entries).
   * @returns An `Observable` of SSE-shaped `MessageEvent` objects; NestJS
   *          subscribes to it via the `@Sse()` decorator and pipes each
   *          emission to the HTTP response.
   */
  @HttpCode(HttpStatus.OK)
  @Post()
  @HasPermission(permissions.readAiChat)
  @Sse()
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public chat(
    @Body() chatRequestDto: ChatRequestDto,
    @Res({ passthrough: true }) response: Response
  ): Observable<MessageEvent> {
    const correlationId = randomUUID();

    response.setHeader('X-Correlation-ID', correlationId);

    return this.aiChatService.streamChat({
      correlationId,
      messages: chatRequestDto.messages,
      userId: this.request.user.id
    });
  }
}
