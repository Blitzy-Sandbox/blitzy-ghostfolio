import type { RebalancingResponse } from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';

import { RebalancingRequestDto } from './dtos/rebalancing-request.dto';
import { RebalancingController } from './rebalancing.controller';
import { RebalancingService } from './rebalancing.service';

/**
 * Unit tests for `RebalancingController` — the HTTP entry point for
 * **Feature C — Explainable Rebalancing Engine** described in AAP § 0.1.1,
 * § 0.5.1.1, § 0.5.1.4, and § 0.7.5.2 (rebalancing-engine acceptance gate).
 *
 * Source-of-truth references (AAP):
 *   - § 0.5.1.4: explicitly enumerates the three baseline scenarios this
 *     spec MUST cover — "Tests: 200 with valid body, 401 unauth, 400
 *     invalid body shape." The 401/400 paths are enforced by the global
 *     auth guard and `ValidationPipe` respectively (framework-level
 *     concerns); this file therefore focuses on the controller's pure
 *     delegation behavior, the JWT-authoritative `userId` invariant
 *     (the central security check at the controller boundary), and the
 *     downstream `RebalancingResponse` contract verification.
 *   - § 0.7.5.2 (Rebalancing engine gate): "every item in
 *     `recommendations` has a non-empty `rationale` and `goalReference`;
 *     the response is sourced from a `tool_use` content block (Rule 4)."
 *     Test 7 verifies the per-item structural contract on the controller
 *     output path; the upstream `tool_use` sourcing is verified by the
 *     sibling spec `rebalancing.service.spec.ts`.
 *   - § 0.7.1.8 (Rule 8 — Controller Thinness): "No new controller
 *     method body exceeds 10 lines. No `prisma.*` calls appear in new
 *     controller files." Test 4 verifies one delegation per controller
 *     call — there is no internal loop, retry, or business-logic branch
 *     that would multiply service invocations.
 *   - § 0.5.1.5 / § 0.7.3 (JWT-authoritative `userId`): "the JWT-derived
 *     `userId` is authoritative ... `request.user.id` — NOT from the
 *     request body, query string, or tool-call argument." Test 2
 *     explicitly verifies the controller sources `userId` from
 *     `request.user.id` and never from the validated DTO body.
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/portfolio/current-rate.service.spec.ts` —
 *     canonical Ghostfolio direct-instantiation pattern
 *     (`new Service(null, ...)`); used here to avoid the heavier
 *     `Test.createTestingModule(...)` route, which would require
 *     overriding the `REQUEST` injection token on every test.
 *   - `apps/api/src/app/snowflake-sync/snowflake-sync.controller.spec.ts`
 *     and
 *     `apps/api/src/app/user-financial-profile/user-financial-profile.controller.spec.ts`
 *     — sibling controller specs in this AAP scope which adopt the same
 *     direct-`new Controller(...)` pattern + a synthetic
 *     `RequestWithUser` fixture. The same lightweight pattern is
 *     appropriate here because the controller is a pure delegation
 *     surface — its only behaviors are
 *     (a) generate a per-request `correlationId` via `randomUUID()`,
 *     (b) extract the JWT-verified `request.user.id`,
 *     (c) delegate to `RebalancingService.recommend({...})`, and
 *     (d) return the resulting `RebalancingResponse` unchanged.
 *
 * No real Anthropic SDK call, network egress, or paid API token is
 * consumed by this spec — `RebalancingService` is mocked via
 * `jest.Mocked<T>` and the underlying `@anthropic-ai/sdk` module is
 * never imported in this file. The `.spec.ts` test for
 * `RebalancingService` itself (`rebalancing.service.spec.ts`) verifies
 * the SDK invocation and Rule 4 (tool_use sourcing) end-to-end.
 */
describe('RebalancingController', () => {
  /**
   * Stable test-fixture user identifier reused across every `it(...)`
   * block. Using a stable id makes failure logs easier to read and
   * signals "this is a test fixture, not a real user".
   */
  const TEST_USER_ID = 'user-123';

  let controller: RebalancingController;
  let rebalancingService: jest.Mocked<RebalancingService>;

  /**
   * Factory that returns a fresh, minimal `Response` mock per call.
   *
   * The controller injects `@Res({ passthrough: true }) response: Response`
   * (added per QA Checkpoint 11 Issue 4 / AAP § 0.7.2 Observability rule
   * to expose `X-Correlation-ID` to clients). The only `Response` API
   * touched by the controller is `setHeader(name, value)`; we capture
   * it as a `jest.fn()` so individual tests can assert (a) the header
   * was set and (b) its value matches the per-request `correlationId`.
   *
   * A FACTORY (not a shared instance) is used because each `it(...)`
   * block creates its own Response — without isolation, a regression
   * that writes to the same `setHeader` mock from multiple tests
   * would silently leak state across the suite.
   */
  const buildMockResponse = (): jest.Mocked<Response> => {
    return {
      setHeader: jest.fn()
    } as unknown as jest.Mocked<Response>;
  };

  /**
   * Synthetic `RequestWithUser` fixture exposing only the single
   * property the controller reads (`user.id`). The cast through
   * `unknown` avoids the weight of constructing a full
   * `UserWithSettings` (which would require populating Prisma-typed
   * settings, permissions, role, etc.) while still satisfying the
   * controller's typed access path.
   */
  const mockRequest = {
    user: {
      id: TEST_USER_ID,
      settings: { settings: { language: 'en', baseCurrency: 'USD' } }
    }
  } as unknown as RequestWithUser;

  /**
   * Canonical happy-path `RebalancingResponse` fixture mirroring the
   * verbatim AAP § 0.1.2.4 contract: `recommendations[]` (each entry
   * carrying `action`, `ticker`, `fromPct`, `toPct`, `rationale`,
   * `goalReference`) plus a top-level `summary` and `warnings[]`.
   *
   * The two recommendations cover both `BUY` and `SELL` actions so
   * Test 7's per-item rationale/goalReference assertion exercises more
   * than a single record. Every `rationale` and `goalReference` is a
   * non-empty string — when this fixture is returned by the mocked
   * service, the controller's output trivially satisfies the AAP
   * § 0.7.5.2 acceptance gate.
   */
  const mockResponse: RebalancingResponse = {
    recommendations: [
      {
        action: 'BUY',
        fromPct: 0.1,
        goalReference: 'retirementTargetAge',
        rationale:
          'Increase US equity allocation to align with retirement goal at age 65 with HIGH risk tolerance.',
        ticker: 'VTI',
        toPct: 0.2
      },
      {
        action: 'SELL',
        fromPct: 0.4,
        goalReference: 'timeHorizonYears',
        rationale:
          'Reduce bond allocation to free capital for higher-growth assets given long time horizon.',
        ticker: 'BND',
        toPct: 0.3
      }
    ],
    summary:
      'Reallocation increases equity exposure in line with stated risk tolerance and time horizon.',
    warnings: ['Tax implications of selling BND should be reviewed.']
  };

  beforeEach(() => {
    // The minimal `Partial<jest.Mocked<RebalancingService>>` exposes only
    // the single method the controller calls (`recommend`). The double
    // cast to `jest.Mocked<RebalancingService>` lets the controller
    // constructor accept the mock without complaining about the missing
    // `anthropic`, `model`, `configService`, etc. private fields — those
    // concerns belong to `rebalancing.service.spec.ts`.
    const rebalancingServiceMock: Partial<jest.Mocked<RebalancingService>> = {
      recommend: jest.fn().mockResolvedValue(mockResponse)
    };
    rebalancingService =
      rebalancingServiceMock as jest.Mocked<RebalancingService>;

    controller = new RebalancingController(rebalancingService, mockRequest);
  });

  // ---------------------------------------------------------------------------
  // Test 1 — Controller is defined (smoke test)
  // ---------------------------------------------------------------------------

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test 2 — JWT-authoritative `userId` (SECURITY-CRITICAL)
  //          AAP § 0.5.1.5, § 0.7.3
  // ---------------------------------------------------------------------------

  it('delegates to RebalancingService.recommend with userId sourced from request.user.id (JWT-authoritative)', async () => {
    const dto: RebalancingRequestDto = {};

    const result = await controller.getRebalancing(dto, buildMockResponse());

    // The controller MUST source `userId` from `this.request.user.id`,
    // NEVER from the request body — this is the central security
    // invariant of the rebalancing endpoint. A regression here would
    // allow an authenticated user to rebalance another user's portfolio
    // by smuggling a different `userId` in the request body.
    expect(rebalancingService.recommend).toHaveBeenCalledTimes(1);
    expect(rebalancingService.recommend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TEST_USER_ID
      })
    );
    expect(result).toEqual(mockResponse);
  });

  // ---------------------------------------------------------------------------
  // Test 3 — Verbatim response forwarding (no in-controller transformation)
  // ---------------------------------------------------------------------------

  it('returns the RebalancingResponse from RebalancingService.recommend verbatim', async () => {
    const dto: RebalancingRequestDto = {};

    const result = await controller.getRebalancing(dto, buildMockResponse());

    // Reference equality (`.toBe`) verifies the controller did NOT
    // construct a new object — it returned the service's promise
    // result directly (Rule 8: zero business logic in the controller).
    expect(result).toBe(mockResponse);
    expect(result.recommendations).toHaveLength(2);
    expect(result.summary).toEqual(expect.any(String));
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 4 — Controller thinness (Rule 8, AAP § 0.7.1.8)
  // ---------------------------------------------------------------------------

  it('controller method delegates exactly once per call (Rule 8 — Controller Thinness)', async () => {
    const dto: RebalancingRequestDto = {};

    await controller.getRebalancing(dto, buildMockResponse());
    await controller.getRebalancing(dto, buildMockResponse());

    // Exactly one delegation per controller call — no internal loop,
    // no retry, no business-logic branch. Two calls to the controller
    // method => exactly two service invocations.
    expect(rebalancingService.recommend).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Test 5 — Per-request correlationId (Observability rule, AAP § 0.7.2)
  // ---------------------------------------------------------------------------

  it('passes a correlationId to RebalancingService.recommend for log correlation (Observability rule)', async () => {
    const dto: RebalancingRequestDto = {};

    await controller.getRebalancing(dto, buildMockResponse());

    // The controller MUST generate a fresh correlationId per request
    // (via `node:crypto.randomUUID()`) and forward it to the service.
    // The id is propagated through every structured log line and the
    // downstream Anthropic invocation, enabling end-to-end request
    // tracing across the HTTP/LLM boundary.
    const callArg = rebalancingService.recommend.mock.calls[0][0];
    expect(callArg.correlationId).toEqual(expect.any(String));
    expect(callArg.correlationId.length).toBeGreaterThan(0);
  });

  it('generates a distinct correlationId per request (Observability rule)', async () => {
    const dto: RebalancingRequestDto = {};

    await controller.getRebalancing(dto, buildMockResponse());
    await controller.getRebalancing(dto, buildMockResponse());

    const firstCallArg = rebalancingService.recommend.mock.calls[0][0];
    const secondCallArg = rebalancingService.recommend.mock.calls[1][0];

    // Two requests => two distinct correlationIds. A regression where
    // the controller cached or shared a correlationId across requests
    // would defeat log-correlation.
    expect(firstCallArg.correlationId).not.toEqual(secondCallArg.correlationId);
  });

  // ---------------------------------------------------------------------------
  // Test 5b — X-Correlation-ID response header (QA Checkpoint 11 Issue 4)
  //           Observability rule, AAP § 0.7.2
  // ---------------------------------------------------------------------------

  it('sets X-Correlation-ID response header matching the per-request correlationId (QA Checkpoint 11 Issue 4)', async () => {
    const dto: RebalancingRequestDto = {};
    const httpResponse = buildMockResponse();

    await controller.getRebalancing(dto, httpResponse);

    // QA Checkpoint 11 Issue 4 (INFO): "No X-Correlation-ID header on
    // rebalancing error responses." The fix injects the Express
    // `Response` via `@Res({ passthrough: true })` and emits a
    // `X-Correlation-ID` header carrying the same UUID generated for
    // the structured-log correlationId — enabling client-side log
    // correlation when troubleshooting upstream Anthropic/network
    // failures. The header is set BEFORE the service call so it is
    // emitted on both 200 and 5xx paths.
    expect(httpResponse.setHeader).toHaveBeenCalledTimes(1);
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'X-Correlation-ID',
      expect.any(String)
    );

    // The header value MUST equal the same correlationId forwarded to
    // the service — anchoring server-side logs and client-side
    // diagnostics to a single id per request.
    const headerCall = httpResponse.setHeader.mock.calls[0];
    const headerValue = headerCall[1];
    const serviceCallArg = rebalancingService.recommend.mock.calls[0][0];
    expect(headerValue).toBe(serviceCallArg.correlationId);
  });

  // ---------------------------------------------------------------------------
  // Test 6 — Request DTO body forwarding (validates DTO is wired)
  // ---------------------------------------------------------------------------

  it('forwards the request DTO body to the service as requestPayload', async () => {
    const dto: RebalancingRequestDto = {
      targetAllocation: { bonds: 0.3, equity: 0.7 }
    };

    await controller.getRebalancing(dto, buildMockResponse());

    // The validated DTO body reaches the service unchanged via the
    // `requestPayload` field — the service's `recommend(...)` signature
    // is `{ correlationId, requestPayload, userId }` and the controller
    // is responsible for constructing that envelope.
    const callArg = rebalancingService.recommend.mock.calls[0][0];
    expect(callArg.requestPayload).toEqual(dto);
  });

  it('forwards an empty DTO body (no `targetAllocation`) to the service unchanged', async () => {
    const dto: RebalancingRequestDto = {};

    await controller.getRebalancing(dto, buildMockResponse());

    // The empty DTO `{}` is the canonical happy-path body (no override
    // fields) and MUST reach the service untouched. A regression that
    // coerced `{}` to `undefined` or supplied a default would change
    // the service-side contract.
    const callArg = rebalancingService.recommend.mock.calls[0][0];
    expect(callArg.requestPayload).toEqual(dto);
  });

  // ---------------------------------------------------------------------------
  // Test 7 — Per-recommendation rationale/goalReference contract
  //          (Validation Gate, AAP § 0.7.5.2)
  // ---------------------------------------------------------------------------

  it('each recommendation in the returned response has non-empty rationale and goalReference (AAP § 0.7.5.2)', async () => {
    const dto: RebalancingRequestDto = {};

    const result = await controller.getRebalancing(dto, buildMockResponse());

    // The AAP § 0.7.5.2 rebalancing-engine acceptance gate REQUIRES
    // every recommendation to carry a non-empty `rationale` and
    // `goalReference`. This test exercises the structural contract
    // returned by the (mocked) service from the controller's
    // perspective; the upstream `tool_use` sourcing of these fields
    // is verified end-to-end by `rebalancing.service.spec.ts`.
    expect(result.recommendations.length).toBeGreaterThan(0);
    for (const rec of result.recommendations) {
      expect(rec.rationale).toEqual(expect.any(String));
      expect(rec.rationale.length).toBeGreaterThan(0);
      expect(rec.goalReference).toEqual(expect.any(String));
      expect(rec.goalReference.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 8 — HTTP status-code wiring: @HttpCode(HttpStatus.OK) overrides
  //          NestJS's default 201-Created for `@Post()` handlers.
  //          Regression guard for QA Checkpoint 9 INFO #1 (POST endpoints
  //          responded HTTP 201 instead of 200 — REST convention violation
  //          for non-resource-creating actions; this rebalancing endpoint
  //          is a query-style RPC that returns recommendations, NOT a
  //          resource-creating endpoint, so 200 OK is the correct status
  //          per the precedent established by sibling controllers
  //          `SnowflakeSyncController.triggerSync` and
  //          `UserFinancialProfileController.update` which both use
  //          `@HttpCode(HttpStatus.OK)`).
  // ---------------------------------------------------------------------------

  it('declares @HttpCode(HttpStatus.OK) (HTTP 200, not 201) on getRebalancing() (QA Checkpoint 9 INFO #1)', () => {
    // NestJS defaults `@Post()` to HTTP 201 (Created), but the
    // rebalancing endpoint is a query-style RPC — it does NOT create
    // a server-side resource. The response is a transient
    // `RebalancingResponse` computed from the user's portfolio and
    // financial profile; nothing is persisted on the server. Returning
    // 201 would incorrectly signal resource creation to API clients.
    //
    // The fix applies `@HttpCode(HttpStatus.OK)` to the
    // `getRebalancing()` handler, matching the convention already used
    // by the sibling `SnowflakeSyncController.triggerSync()` (see
    // `snowflake-sync.controller.spec.ts` ~lines 435-441) and
    // `UserFinancialProfileController.update()`. Asserting the
    // metadata here is the only automated guard against a future
    // refactor accidentally dropping the decorator and silently
    // regressing the response status code back to 201.
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      RebalancingController.prototype.getRebalancing
    );
    expect(httpCode).toBe(HttpStatus.OK);
  });
});
