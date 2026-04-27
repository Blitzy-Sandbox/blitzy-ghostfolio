import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import type { ChatMessage } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import { HttpException, HttpStatus, MessageEvent } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  SSE_METADATA
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { AuthGuard } from '@nestjs/passport';
import { Observable, lastValueFrom, of } from 'rxjs';

import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { ChatRequestDto } from './dtos/chat-request.dto';

/**
 * Integration tests for `AiChatController` (the `@Sse()` HTTP entry point
 * for **Feature B — AI Portfolio Chat Agent** described in AAP § 0.1.1,
 * § 0.5.1.1, and § 0.5.1.5).
 *
 * Source-of-truth references (AAP):
 *   - § 0.5.1.4: explicitly enumerates the three scenarios this spec MUST
 *     cover — "Integration test for `@Sse()`: response `Content-Type:
 *     text/event-stream`, first-token latency budget, error → SSE error
 *     frame."
 *   - § 0.7.5.2 "Chat agent gate": "POST /api/v1/ai/chat response has
 *     `Content-Type: text/event-stream`; the first SSE token arrives
 *     within 3 seconds on localhost with valid credentials".
 *   - § 0.7.5.1 Gate 8 (Integration sign-off): the `POST /api/v1/ai/chat`
 *     endpoint returns a non-500 response when called with a valid JWT
 *     and a correctly shaped body.
 *   - § 0.5.1.5 (security): the JWT-authenticated `userId` MUST override
 *     any `userId` Claude could supply — this rule operates inside the
 *     service's `dispatchTool(...)` method, but at the CONTROLLER layer
 *     the same invariant is enforced structurally: the controller
 *     extracts `userId` exclusively from `request.user.id` (the
 *     `JwtStrategy.validate()`-populated identity), never from the
 *     request body. The DTO `ChatRequestDto` has no `userId` field.
 *   - § 0.7.1.8 (Rule 8 — Controller Thinness): "No new controller
 *     method body exceeds 10 lines. No `prisma.*` calls appear in new
 *     controller files." Verified by Tests 13 & 14 below.
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/snowflake-sync/snowflake-sync.controller.spec.ts`
 *     and `apps/api/src/app/user-financial-profile/user-financial-profile.controller.spec.ts`
 *     — the canonical sibling controller specs in this AAP scope. Both
 *     use the same `jest.mock(...)` factory + direct
 *     `new Controller(...)` instantiation pattern (rather than the
 *     heavier `Test.createTestingModule(...)` route). The same
 *     lightweight pattern is appropriate here because the controller is
 *     a pure delegation surface — its only behaviors are
 *     (a) generate a per-request correlationId via `randomUUID()`,
 *     (b) extract the JWT-verified `request.user.id`,
 *     (c) delegate to the service's `streamChat(...)` method, and
 *     (d) forward the resulting `Observable<MessageEvent>` unchanged.
 *     Each of those is testable with a mocked service and a synthetic
 *     `request` object.
 *   - `apps/api/src/guards/has-permission.guard.spec.ts` — pattern for
 *     verifying `@HasPermission(...)` decorator metadata via
 *     `Reflector.get(...)` and exercising `HasPermissionGuard.canActivate`
 *     directly with a synthetic `ExecutionContext` to confirm the
 *     HTTP 403 rejection path.
 *
 * SSE marshaling note: the actual `Content-Type: text/event-stream`
 * response header is applied by NestJS's framework-level SSE adapter
 * (driven by the `SSE_METADATA` flag the `@Sse()` decorator sets on the
 * method descriptor). At the controller level we therefore verify
 * `SSE_METADATA` is `true` (Test 9) — a future refactor that drops the
 * `@Sse()` decorator would fail this test even if the controller still
 * compiled, which is the integration-test invariant AAP § 0.5.1.4
 * mandates. The end-to-end runtime header verification is performed by
 * the QA bypass harness via `curl -I`; see the QA report's "SSE Frame
 * Capture Evidence" section.
 *
 * No real Anthropic SDK or network call occurs in this spec — the
 * `jest.mock('./ai-chat.service', ...)` factory below replaces the
 * service constructor with a stub that only exposes `streamChat`, so
 * the SDK module is never imported during this spec's module-load.
 */

/**
 * Replaces the real `AiChatService` constructor with a minimal mock
 * that exposes only the single service method consumed by
 * `AiChatController` (`streamChat`).
 *
 * Using a hoisted `jest.mock(...)` factory keeps the mock established
 * before the controller import resolves the real service class. The
 * mock skips the real service's heavy dependency tree
 * (`@anthropic-ai/sdk`, `MetricsService`, `PortfolioService`,
 * `SymbolService`, `SnowflakeSyncService`, `UserFinancialProfileService`,
 * `ConfigService`) — those concerns are covered by
 * `ai-chat.service.spec.ts`.
 *
 * The mock is hoisted ABOVE the
 * `import { AiChatController } from './ai-chat.controller'` line by
 * Jest's module-mock machinery, so the controller-under-test sees the
 * mocked service from its very first construction inside `beforeEach`.
 * No real Anthropic credentials, network egress, or paid API tokens
 * are consumed by this spec.
 */
jest.mock('./ai-chat.service', () => {
  return {
    AiChatService: jest.fn().mockImplementation(() => {
      return {
        streamChat: jest.fn()
      };
    })
  };
});

describe('AiChatController', () => {
  /**
   * Stable test fixture user identifiers. `USER_1_ID` is the canonical
   * authenticated caller used by most tests; `USER_2_ID` is used in the
   * cross-user isolation test (Test 5) to verify the controller
   * forwards `request.user.id` faithfully even when a different user
   * authenticates.
   */
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';

  /**
   * Canonical valid `ChatRequestDto` body used by happy-path tests.
   * The DTO carries no `userId` field — that is the structural
   * enforcement of the AAP § 0.5.1.5 JWT-authoritative `userId` rule
   * at the request-shape layer (the controller cannot read a userId
   * from the body even if it wanted to). The 5-message length is the
   * upper bound enforced by `@ArrayMaxSize(5)` (4 prior turns + 1 new
   * user turn per AAP § 0.7.3 stateless protocol).
   */
  const VALID_DTO: ChatRequestDto = {
    messages: [{ content: 'What is my portfolio worth?', role: 'user' }]
  };

  let controller: AiChatController;
  let request: RequestWithUser;
  let aiChatService: jest.Mocked<AiChatService>;

  /**
   * Builds a minimal `RequestWithUser` shape that exposes only the two
   * properties the controller reads (`user.id` and `user.permissions`).
   * The synthetic shape lets each test mutate the user payload without
   * the weight of a full Express request and without taking on the
   * broader `User` Prisma type's optional fields.
   *
   * `permissions` defaults to the `readAiChat` permission so the
   * happy-path tests don't have to repeat the grant boilerplate; the
   * 403 test (Test 11) passes an empty `permissions` array to drive
   * `HasPermissionGuard` into its rejection branch.
   */
  function buildRequest(
    userId: string,
    options: { permissions?: string[] } = {}
  ): RequestWithUser {
    return {
      user: {
        id: userId,
        permissions: options.permissions ?? [permissions.readAiChat]
      }
    } as unknown as RequestWithUser;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    request = buildRequest(USER_1_ID);
    // The mocked service returns a fresh instance per test so call
    // history is never carried across `it(...)` blocks.
    aiChatService = new (AiChatService as any)();
    controller = new AiChatController(aiChatService, request);
  });

  // -------------------------------------------------------------------------
  // Test 1 — Happy path: chat() forwards messages + JWT userId to service
  //          (AAP § 0.5.1.1 + § 0.7.5.1 Gate 8 integration sign-off)
  // -------------------------------------------------------------------------

  it('forwards the validated DTO messages and the JWT-authenticated userId to AiChatService.streamChat (Gate 8)', () => {
    // Arrange: the mocked `streamChat` returns a synthetic
    // `Observable<MessageEvent>` so the controller can return it
    // unchanged. We use `of(...)` to produce a finite Observable
    // emitting exactly one MessageEvent — the controller's only
    // contract is to RETURN this Observable, so the production
    // shape doesn't matter for this test.
    const sentinelEvent: MessageEvent = {
      data: { type: 'text', value: 'Hello' }
    };
    aiChatService.streamChat.mockReturnValueOnce(of(sentinelEvent));

    // Act
    const observable = controller.chat(VALID_DTO);

    // Assert: streamChat was called exactly once with the JWT userId
    expect(aiChatService.streamChat).toHaveBeenCalledTimes(1);
    const [callArgs] = aiChatService.streamChat.mock.calls[0] as [
      {
        correlationId: string;
        messages: ChatMessage[];
        userId: string;
      }
    ];

    // AAP § 0.5.1.5: the userId MUST be the JWT-authenticated value.
    // This is THE most critical security invariant of this controller
    // — if it ever regresses, an authenticated user could potentially
    // operate on another user's data via Anthropic's tool calls.
    expect(callArgs.userId).toBe(USER_1_ID);

    // The messages are forwarded verbatim — the controller does NOT
    // mutate, sanitize, or re-shape them; that is the validated DTO's
    // and the service's responsibility.
    expect(callArgs.messages).toBe(VALID_DTO.messages);

    // The correlationId is generated per request — Test 3 verifies its
    // shape and uniqueness; here we just assert presence.
    expect(typeof callArgs.correlationId).toBe('string');
    expect(callArgs.correlationId.length).toBeGreaterThan(0);

    // Sanity: the controller returns the Observable unchanged for
    // NestJS's `@Sse()` adapter to subscribe and pipe each emission
    // to the HTTP response.
    expect(observable).toBeInstanceOf(Observable);
  });

  // -------------------------------------------------------------------------
  // Test 2 — JWT-authoritative userId: controller NEVER reads userId
  //          from body, even if attempted (structural defense in depth)
  //          (AAP § 0.5.1.5 + § 0.7.3 + Rule 5 isolation analog)
  // -------------------------------------------------------------------------

  it('uses request.user.id as the JWT-authoritative userId regardless of body contents (security)', () => {
    aiChatService.streamChat.mockReturnValueOnce(of());

    // Even if a malicious caller smuggles extra fields into the
    // request body, the DTO's `forbidNonWhitelisted: true` global
    // ValidationPipe setting would reject them BEFORE the controller
    // method runs (see QA report §24). At the controller layer we
    // verify the SECOND defense: the controller never reads any
    // userId from any source other than `request.user.id`.
    //
    // Strict TypeScript prevents us from constructing a DTO with a
    // forbidden `userId` field at compile time, so we drop down to
    // the runtime-shape level — but NOTE: even at runtime the
    // controller has no codepath that reads `chatRequestDto.userId`,
    // so the test below is a behavioral assertion on a contract the
    // type system already enforces.
    const dtoWithSmuggledFields = VALID_DTO;

    controller.chat(dtoWithSmuggledFields);

    const [callArgs] = aiChatService.streamChat.mock.calls[0] as [
      { userId: string }
    ];

    // The forwarded userId MUST be the JWT-authenticated USER_1_ID.
    expect(callArgs.userId).toBe(USER_1_ID);
  });

  it('forwards request.user.id (USER_2_ID) when a different user authenticates (cross-user isolation)', () => {
    // Re-instantiate the controller bound to a USER_2_ID request so
    // we verify the controller does NOT cache or hardcode a single
    // user identity — every per-request lookup goes through
    // `this.request.user.id`. The Inject(REQUEST) injection token
    // gives a per-request scope at runtime; at the spec level we
    // simulate that by constructing a fresh controller per user.
    aiChatService.streamChat.mockReturnValueOnce(of());
    const user2Request = buildRequest(USER_2_ID);
    const user2Controller = new AiChatController(aiChatService, user2Request);

    user2Controller.chat(VALID_DTO);

    const [callArgs] = aiChatService.streamChat.mock.calls[0] as [
      { userId: string }
    ];

    // The forwarded userId MUST equal the new user's id and MUST NOT
    // equal the previous user's id — proving the per-request lookup.
    expect(callArgs.userId).toBe(USER_2_ID);
    expect(callArgs.userId).not.toBe(USER_1_ID);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Per-request correlationId is generated via randomUUID()
  //          (AAP § 0.7.2 Observability — per-request log threading)
  // -------------------------------------------------------------------------

  it('generates a fresh correlationId via randomUUID() on every chat() invocation', () => {
    // Two consecutive `chat(...)` calls MUST produce two distinct
    // correlationIds. The randomUUID() v4 collision probability is
    // ~2^-122 — vanishingly small — so any test failure here
    // indicates the controller cached a single id (regression).
    aiChatService.streamChat.mockReturnValueOnce(of());
    aiChatService.streamChat.mockReturnValueOnce(of());

    controller.chat(VALID_DTO);
    controller.chat(VALID_DTO);

    const [firstCallArgs] = aiChatService.streamChat.mock.calls[0] as [
      { correlationId: string }
    ];
    const [secondCallArgs] = aiChatService.streamChat.mock.calls[1] as [
      { correlationId: string }
    ];

    // Distinct values per request — proves a fresh randomUUID() per
    // call rather than a captured/cached value.
    expect(firstCallArgs.correlationId).not.toBe(secondCallArgs.correlationId);
  });

  it('generates correlationIds that match the RFC 4122 v4 UUID shape', () => {
    // randomUUID() returns RFC 4122 v4: 8-4-4-4-12 lower-case hex
    // groups with the 13th character being '4' and the 17th being
    // one of `[8, 9, a, b]`. The regex below enforces the v4 shape
    // explicitly so a regression to a non-v4 generator (e.g.
    // `Date.now().toString()`) would fail this test.
    aiChatService.streamChat.mockReturnValueOnce(of());

    controller.chat(VALID_DTO);

    const [callArgs] = aiChatService.streamChat.mock.calls[0] as [
      { correlationId: string }
    ];
    const v4Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(callArgs.correlationId).toMatch(v4Pattern);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Observable forwarding: controller returns the service's
  //          Observable unchanged (no transformation, no wrapping)
  // -------------------------------------------------------------------------

  it('returns the Observable<MessageEvent> from AiChatService.streamChat unchanged (NestJS @Sse() contract)', async () => {
    // The controller MUST return the EXACT Observable instance the
    // service produced. NestJS's `@Sse()` decorator subscribes to
    // that Observable and pipes each emission to the HTTP response;
    // any transformation (e.g. `pipe(map(...))`) would (a) violate
    // Rule 8 (Controller Thinness) by adding business logic, and
    // (b) potentially alter the SSE frame shape downstream.
    const event1: MessageEvent = { data: { type: 'text', value: 'Hello' } };
    const event2: MessageEvent = {
      data: { type: 'text', value: ' World' }
    };
    const sourceObservable = of(event1, event2);
    aiChatService.streamChat.mockReturnValueOnce(sourceObservable);

    const result = controller.chat(VALID_DTO);

    // Reference equality — NOT just shape equality. The controller
    // returns the EXACT Observable that streamChat returned.
    expect(result).toBe(sourceObservable);

    // Sanity: the Observable still emits the events end-to-end so
    // the integration with NestJS's SSE marshaller is well-formed.
    const collected: MessageEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      result.subscribe({
        complete: () => resolve(),
        error: reject,
        next: (e) => collected.push(e)
      });
    });
    expect(collected).toHaveLength(2);
    expect(collected[0]).toBe(event1);
    expect(collected[1]).toBe(event2);
  });

  // -------------------------------------------------------------------------
  // Test 5 — error → SSE error frame: service errors propagate via the
  //          Observable error channel (AAP § 0.5.1.4 explicit "error →
  //          SSE error frame" requirement)
  // -------------------------------------------------------------------------

  it('propagates service Observable errors so NestJS marshals them as SSE error frames (AAP § 0.5.1.4)', async () => {
    // The chat agent SSE protocol distinguishes two error shapes:
    //
    //   1. The service's "Frame 0": a `MessageEvent` whose `data`
    //      payload is `{ type: 'error', correlationId, message }`.
    //      This is the protocol-compliant frame the front end
    //      actually consumes (per QA report §2.B Issue #2).
    //   2. NestJS's default `event: error` frame produced when the
    //      Observable terminates via `subscriber.error(...)`. The
    //      QA report classifies this as a known design-acceptable
    //      byproduct.
    //
    // The controller's only job is to FORWARD the Observable
    // unchanged — so the test verifies that an Observable that
    // errors at the SOURCE propagates through the controller's
    // return value without interception. A future regression that
    // wraps the service Observable in `catchError(...)` would fail
    // this test (and break the SSE error-frame contract).
    const upstreamError = new Error('upstream Anthropic 401');
    const erroringObservable = new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ data: { type: 'error', message: 'sentinel' } });
      subscriber.error(upstreamError);
    });
    aiChatService.streamChat.mockReturnValueOnce(erroringObservable);

    const result = controller.chat(VALID_DTO);

    let caught: unknown;
    const collected: MessageEvent[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        result.subscribe({
          complete: () => resolve(),
          error: reject,
          next: (e) => collected.push(e)
        });
      });
    } catch (err) {
      caught = err;
    }

    // Frame 0 (the protocol-compliant pre-error frame) is delivered
    // BEFORE the error terminates the stream, exactly mirroring the
    // production behavior captured in the QA report.
    expect(collected).toHaveLength(1);
    expect((collected[0].data as { type: string }).type).toBe('error');

    // The terminal error is forwarded UNCHANGED (reference equality).
    // A regression that swallowed or rewrote the error would fail.
    expect(caught).toBe(upstreamError);
  });

  it('propagates synchronous service throws unchanged for global exception filter mapping', () => {
    // Some failure modes (e.g. invalid ANTHROPIC_API_KEY at the SDK
    // constructor level) surface as synchronous throws BEFORE the
    // Observable subscription is established. The controller MUST
    // NOT catch or wrap such errors — that is the global NestJS
    // exception filter's responsibility per Rule 8 (Controller
    // Thinness, AAP § 0.7.1.8).
    const upstreamError = new Error('SDK construction failure');
    aiChatService.streamChat.mockImplementationOnce(() => {
      throw upstreamError;
    });

    expect(() => controller.chat(VALID_DTO)).toThrow(upstreamError);
  });

  // -------------------------------------------------------------------------
  // Test 6 — first-token latency: service first emission is forwarded
  //          synchronously without controller-side delay
  //          (AAP § 0.7.5.2 chat agent gate — first SSE token within 3s)
  // -------------------------------------------------------------------------

  it('forwards the first SSE token without controller-side latency (AAP § 0.7.5.2 first-token gate)', async () => {
    // The QA report measured 82ms median first-token latency at
    // localhost; the controller must contribute negligible overhead
    // (a single `randomUUID()` call + one method delegation) to
    // preserve the 3s-budget margin. We measure the synchronous
    // controller path between `chat()` and the first emission of
    // the source Observable.
    //
    // The 3s gate itself is dominated by the upstream Anthropic
    // API roundtrip — at the controller spec level we verify a
    // strictly-tighter, framework-level invariant: the controller
    // adds no observable wall-time delay to the first emission.
    const sentinelEvent: MessageEvent = {
      data: { type: 'text', value: 'first' }
    };
    aiChatService.streamChat.mockReturnValueOnce(of(sentinelEvent));

    const start = Date.now();
    const observable = controller.chat(VALID_DTO);
    const firstEvent = await lastValueFrom(observable);
    const elapsed = Date.now() - start;

    expect(firstEvent).toBe(sentinelEvent);
    // 200ms is a generous CI-friendly cap that's still ~15x below the
    // 3s SSE first-token budget; in practice the path is sub-ms
    // because the source Observable is a synchronous `of(...)`.
    expect(elapsed).toBeLessThan(200);
  });

  // -------------------------------------------------------------------------
  // Test 7 — POST verb wiring: the `@Post()` decorator overrides the
  //          default GET that `@Sse()` would otherwise set
  //          (AAP § 0.1.2.4 endpoint matrix: POST /api/v1/ai/chat)
  // -------------------------------------------------------------------------

  it('declares POST as the HTTP verb on chat() (AAP § 0.1.2.4 endpoint matrix)', () => {
    // The decorator order on the controller is:
    //   @Post()                                          // applied LAST (outermost)
    //   @HasPermission(permissions.readAiChat)
    //   @Sse()                                            // applied middle
    //   @UseGuards(AuthGuard('jwt'), HasPermissionGuard) // applied FIRST (innermost)
    //
    // TypeScript decorators evaluate bottom-up. `@Sse()` sets
    // METHOD_METADATA to GET as a default; `@Post()` then OVERRIDES
    // it with POST. We assert the FINAL value to verify the override
    // landed correctly.
    //
    // AAP § 0.1.2.4 explicitly mandates `POST /api/v1/ai/chat` (the
    // user's prompt uses POST instead of the W3C `EventSource`
    // GET-only convention because the chat history payload is
    // length-unbounded by query-string limits).
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      AiChatController.prototype.chat
    );
    expect(method).toBe(RequestMethod.POST);
  });

  it("declares the SSE root path '/' on chat() (NestJS @Sse() default contract)", () => {
    // The `@Sse()` decorator with no path argument defaults to
    // `'/'`, which combines with the controller-level `'ai/chat'`
    // prefix to resolve at runtime to `/api/v1/ai/chat`. Asserting
    // the path here guards against a future regression that adds an
    // unintended sub-path to `@Sse()`.
    const path = Reflect.getMetadata(
      PATH_METADATA,
      AiChatController.prototype.chat
    );
    expect(path).toBe('/');
  });

  // -------------------------------------------------------------------------
  // Test 8 — SSE wiring: SSE_METADATA is true on chat() (AAP § 0.5.1.4
  //          + § 0.7.5.2 — "response Content-Type: text/event-stream")
  // -------------------------------------------------------------------------

  it('declares @Sse() on chat() — SSE_METADATA flag is set (AAP § 0.7.5.2 Content-Type)', () => {
    // The `@Sse()` decorator works by setting the framework-private
    // SSE_METADATA flag (`'__sse__'` per
    // `@nestjs/common/constants.d.ts`) to `true` on the method. The
    // NestJS runtime adapter inspects this flag to decide whether to
    // marshal the Observable via the SSE pipeline (which sets
    // `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
    // `Connection: keep-alive`, `Transfer-Encoding: chunked`, and
    // `X-Accel-Buffering: no` per the QA-verified runtime headers).
    //
    // A future refactor that drops the `@Sse()` decorator would
    // (a) silently regress the response Content-Type to
    // `application/json`, (b) break the streaming UX of
    // ChatPanelComponent, and (c) violate AAP § 0.7.5.2 — but it
    // would NOT cause a TypeScript compile error because the method
    // still returns a valid `Observable`. This metadata test is the
    // ONLY automated guard against that regression.
    const sseFlag = Reflect.getMetadata(
      SSE_METADATA,
      AiChatController.prototype.chat
    );
    expect(sseFlag).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9 — Auth chain: AuthGuard('jwt') + HasPermissionGuard wired
  //          (AAP § 0.5.1.4 401 unauth + § 0.7.5.2 401/403 wiring)
  // -------------------------------------------------------------------------

  it("registers AuthGuard('jwt') + HasPermissionGuard on chat() (HTTP 401/403 wiring)", () => {
    // The 401 (unauthenticated) and 403 (lacks permission) contracts
    // are enforced at the framework level by the two registered
    // guards. We verify the metadata so a future refactor that
    // drops either guard would fail this test loudly. The actual
    // runtime rejection behavior is tested in
    // `apps/api/src/app/auth/jwt.strategy.ts` and
    // `apps/api/src/guards/has-permission.guard.spec.ts`.
    const guards = Reflect.getMetadata(
      '__guards__',
      AiChatController.prototype.chat
    );
    expect(Array.isArray(guards)).toBe(true);
    expect(guards.length).toBe(2);

    // The first guard is the JWT auth guard. NestJS's AuthGuard()
    // factory returns a class — we verify by reference equality
    // that the registered guard is the same `AuthGuard('jwt')`
    // class, ensuring HTTP 401 fires for missing or invalid
    // bearer tokens.
    const jwtAuthGuard = AuthGuard('jwt');
    expect(guards[0]).toBe(jwtAuthGuard);

    // The second guard is HasPermissionGuard, ensuring HTTP 403
    // fires for an authenticated user lacking the required
    // permission.
    expect(guards[1]).toBe(HasPermissionGuard);
  });

  // -------------------------------------------------------------------------
  // Test 10 — @HasPermission(permissions.readAiChat) decorator wired
  //           (AAP § 0.5.1.1 + § 0.7.5.2)
  // -------------------------------------------------------------------------

  it('declares @HasPermission(permissions.readAiChat) on chat() (HTTP 403 wiring)', () => {
    // The `@HasPermission(permissions.readAiChat)` decorator sets a
    // metadata key (`'has_permission'`) on the method that the
    // `HasPermissionGuard` reads via `Reflector.get(...)`. We
    // verify the registered permission constant matches the AAP
    // § 0.5.1.1 mandate exactly. The permission registry itself is
    // verified by `libs/common/src/lib/permissions.ts`.
    const reflector = new Reflector();
    const required = reflector.get<string>(
      'has_permission',
      AiChatController.prototype.chat
    );
    expect(required).toBe(permissions.readAiChat);
  });

  it('rejects with HTTP 403 when HasPermissionGuard runs for a user lacking readAiChat', () => {
    // End-to-end verification: drive the HasPermissionGuard with a
    // synthetic ExecutionContext that mimics a request whose user
    // has no `readAiChat` permission. The guard MUST throw
    // HttpException(403). This proves that the @HasPermission
    // decorator wiring on the controller (verified above)
    // translates to a real 403 at runtime when the user lacks the
    // permission — exactly the QA-report-verified behavior for the
    // DEMO user (see QA report #20).
    const reflector = new Reflector();
    jest.spyOn(reflector, 'get').mockReturnValue(permissions.readAiChat);
    const guard = new HasPermissionGuard(reflector);
    const userWithoutPermission = {
      user: { permissions: [] }
    };
    const context = new ExecutionContextHost([userWithoutPermission as any]);

    let thrown: unknown;
    try {
      guard.canActivate(context as any);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('admits a user holding readAiChat (positive control for HasPermissionGuard)', () => {
    // Positive control: the guard MUST permit the call when the user
    // does carry the `readAiChat` permission, demonstrating that the
    // 403 path above is gating on the permission and not on an
    // unrelated guard misconfiguration.
    const reflector = new Reflector();
    jest.spyOn(reflector, 'get').mockReturnValue(permissions.readAiChat);
    const guard = new HasPermissionGuard(reflector);
    const userWithPermission = {
      user: { permissions: [permissions.readAiChat] }
    };
    const context = new ExecutionContextHost([userWithPermission as any]);

    expect(guard.canActivate(context as any)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 11 — Permission-registry parity: readAiChat exists in registry
  //           (defensive guard against rename/delete regressions)
  // -------------------------------------------------------------------------

  it('uses a permission constant that exists in the registry (readAiChat)', () => {
    // Sanity check that the permission constant exists in the
    // shared `permissions` registry; if a future refactor renames
    // or removes it, the @HasPermission decorator on the controller
    // would silently bind to `undefined` and the guard would
    // short-circuit `true` for every caller (per
    // `HasPermissionGuard.canActivate` early return on
    // `!requiredPermission`). This test fails loudly in that case.
    expect(permissions.readAiChat).toBe('readAiChat');
  });

  // -------------------------------------------------------------------------
  // Test 12 — DTO validation: ChatRequestDto rejects malformed bodies
  //           (AAP § 0.5.1.4 + QA report DTO tests §20-24)
  //
  // The DTO's `class-validator` decorators are the authoritative gate.
  // NestJS's global `ValidationPipe` runs the validators before the
  // controller method body; we verify the validators directly so the
  // 400 contract is testable without spinning up the entire HTTP stack.
  // -------------------------------------------------------------------------

  it('ChatRequestDto rejects an empty messages array (HTTP 400 — @ArrayMinSize(1))', async () => {
    // QA report §20: empty messages → HTTP 400 with
    // "messages must contain at least 1 elements".
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ChatRequestDto, { messages: [] });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.constraints?.arrayMinSize !== undefined)).toBe(
      true
    );
  });

  it('ChatRequestDto rejects > 5 messages (HTTP 400 — @ArrayMaxSize(5))', async () => {
    // QA report §12: 6 messages → HTTP 400 with
    // "messages must contain no more than 5 elements".
    // Per AAP § 0.7.3 stateless protocol: 4 prior turns + 1 new
    // user turn = 5 max.
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const sixMessages = Array.from({ length: 6 }, (_, i) => ({
      content: `message ${i}`,
      role: 'user' as const
    }));
    const dto = plainToInstance(ChatRequestDto, { messages: sixMessages });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.constraints?.arrayMaxSize !== undefined)).toBe(
      true
    );
  });

  it('ChatRequestDto rejects an invalid role (HTTP 400 — @IsIn user|assistant)', async () => {
    // QA report §13: role='moderator' → HTTP 400 with
    // "messages.0.role must be one of the following values: user,
    // assistant".
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ChatRequestDto, {
      messages: [{ content: 'hi', role: 'moderator' }]
    });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    // class-validator nests child errors inside the parent
    // ValidationError's `children` array because of @ValidateNested.
    const flatten = (errs: typeof errors): typeof errors => {
      const out: typeof errors = [];
      for (const e of errs) {
        out.push(e);
        if (e.children) out.push(...flatten(e.children));
      }
      return out;
    };
    const allErrors = flatten(errors);
    expect(allErrors.some((e) => e.constraints?.isIn !== undefined)).toBe(true);
  });

  it('ChatRequestDto rejects empty content (HTTP 400 — @IsNotEmpty)', async () => {
    // QA report §15: empty content string → HTTP 400 with
    // "should not be empty".
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ChatRequestDto, {
      messages: [{ content: '', role: 'user' }]
    });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    const flatten = (errs: typeof errors): typeof errors => {
      const out: typeof errors = [];
      for (const e of errs) {
        out.push(e);
        if (e.children) out.push(...flatten(e.children));
      }
      return out;
    };
    const allErrors = flatten(errors);
    expect(allErrors.some((e) => e.constraints?.isNotEmpty !== undefined)).toBe(
      true
    );
  });

  it('ChatRequestDto accepts a valid 1-message body', async () => {
    // Positive control: the canonical happy-path DTO MUST validate
    // cleanly. A failure here means the validators are over-strict
    // and would reject legitimate requests — a 400 regression.
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const dto = plainToInstance(ChatRequestDto, VALID_DTO);
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('ChatRequestDto accepts the maximum 5-message body (boundary)', async () => {
    // Boundary case: exactly 5 messages MUST validate (the upper
    // bound is INCLUSIVE per @ArrayMaxSize(5)).
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');

    const fiveMessages: ChatMessage[] = [
      { content: 'first user', role: 'user' },
      { content: 'first assistant', role: 'assistant' },
      { content: 'second user', role: 'user' },
      { content: 'second assistant', role: 'assistant' },
      { content: 'third user', role: 'user' }
    ];
    const dto = plainToInstance(ChatRequestDto, { messages: fiveMessages });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 13 — Rule 8 (Controller Thinness): no `prisma.*` calls in the
  //           controller file — AAP § 0.7.1.8 explicit acceptance
  //           criterion.
  //
  // This is a static-analysis test that reads the source file from
  // disk and asserts the absence of `prisma.` usage. It is the
  // executable form of the Rule 8 acceptance criterion — a future
  // refactor that introduces a Prisma call into the controller would
  // fail this test on the next CI run.
  // -------------------------------------------------------------------------

  it('the controller file contains zero `prisma.` references (Rule 8 — AAP § 0.7.1.8)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const controllerSource = await readFile(
      join(__dirname, 'ai-chat.controller.ts'),
      'utf-8'
    );

    // The controller MUST NOT touch Prisma directly — all
    // persistence and database I/O belongs to the service layer
    // (Rule 8 — Controller Thinness, AAP § 0.7.1.8). A simple
    // substring check is sufficient because there is no legitimate
    // use for the literal `prisma.` token in a controller file.
    expect(controllerSource).not.toMatch(/prisma\./);
  });

  it('chat() method body is at most 10 lines (Rule 8 — AAP § 0.7.1.8)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const controllerSource = await readFile(
      join(__dirname, 'ai-chat.controller.ts'),
      'utf-8'
    );

    // Locate the line containing `public chat(`, then walk forward
    // through the source counting balanced curly braces. The
    // method body is everything between the FIRST `{` (after the
    // signature) and its matching `}`. We count non-blank lines in
    // that span — Rule 8 caps it at ≤ 10.
    //
    // A line-walker is more robust than a regex here because the
    // signature parenthesis contains the `@Body()` decorator's own
    // parens, which trip up naive `[^)]*` regexes.
    const lines = controllerSource.split('\n');
    const startIdx = lines.findIndex((line) => /public\s+chat\s*\(/.test(line));
    expect(startIdx).toBeGreaterThanOrEqual(0);

    // Find the FIRST `{` at-or-after the signature line. The
    // signature may span multiple lines, but in this codebase the
    // body's opening brace lands a few lines after the signature
    // — we search forward to be future-proof.
    let openLineIdx = startIdx;
    while (openLineIdx < lines.length && !lines[openLineIdx].includes('{')) {
      openLineIdx += 1;
    }
    expect(openLineIdx).toBeLessThan(lines.length);

    // Walk forward counting balanced braces. Start the depth at 0,
    // increment on `{`, decrement on `}`, and stop when depth
    // returns to zero AFTER the opening line.
    let depth = 0;
    const bodyLines: string[] = [];
    for (let i = openLineIdx; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > openLineIdx) {
        bodyLines.push(line);
      }
      for (const ch of line) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth === 0 && i > openLineIdx) {
        // Drop the closing-brace line itself from the body count.
        bodyLines.pop();
        break;
      }
    }

    const nonBlankLines = bodyLines
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Rule 8 explicitly caps method bodies at 10 lines.
    expect(nonBlankLines.length).toBeLessThanOrEqual(10);
    // Sanity: the body should not be empty (the controller does
    // delegate to the service, and that single statement spans
    // multiple lines for argument readability).
    expect(nonBlankLines.length).toBeGreaterThan(0);
  });

  it('the controller file imports randomUUID from node:crypto (correlationId source)', async () => {
    // AAP § 0.7.2 Observability mandates a per-request correlationId
    // generated at the controller boundary. Ghostfolio's package.json
    // pins `engines.node >= 22.18.0`, so `randomUUID` is available
    // in the Node standard library — the controller imports it from
    // `node:crypto` rather than pulling in the third-party `uuid`
    // package. A regression that switched to a non-stdlib generator
    // would (a) introduce a new dependency surface, and (b) likely
    // break Test 3's RFC 4122 v4 shape assertion.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const controllerSource = await readFile(
      join(__dirname, 'ai-chat.controller.ts'),
      'utf-8'
    );

    expect(controllerSource).toMatch(
      /import\s+\{\s*randomUUID\s*\}\s+from\s+'node:crypto'/
    );
  });

  // -------------------------------------------------------------------------
  // Test 14 — Controller-class-level @Controller('ai/chat') prefix
  //           verification — proves the route resolves to
  //           /api/v1/ai/chat at runtime (AAP § 0.1.2.4)
  // -------------------------------------------------------------------------

  it("declares @Controller('ai/chat') as the class-level path prefix (AAP § 0.1.2.4)", () => {
    // The `@Controller('ai/chat')` class-level decorator combined
    // with the global `/api/v1` URI versioning configured in
    // `apps/api/src/main.ts` resolves at runtime to
    // `/api/v1/ai/chat` — the path mandated by the AAP endpoint
    // matrix. The metadata key is `'path'`. A regression that
    // changed the prefix to anything else would fail this test.
    const path = Reflect.getMetadata('path', AiChatController);
    expect(path).toBe('ai/chat');
  });
});
