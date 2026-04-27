import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SnowflakeSyncService } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.service';
import { UserFinancialProfileService } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.service';

import * as anthropicSdk from '@anthropic-ai/sdk';
import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { RebalancingService } from './rebalancing.service';

/**
 * Mocks the `@anthropic-ai/sdk` module at module-load time so the spec
 * NEVER initiates a real network call to `api.anthropic.com`. The mock
 * factory replaces both the default export (the `Anthropic` class
 * imported via `import Anthropic from '@anthropic-ai/sdk'` in
 * `rebalancing.service.ts`) and the named `Anthropic` export with a
 * `jest.fn()`-backed constructor that yields an instance whose
 * `messages.create(...)` is a single shared `jest.fn()` spy. The spy is
 * also re-exported through a `__createMock` helper so each `it(...)`
 * block can stage its own `mockResolvedValueOnce(...)` response and
 * assert against `mock.calls`.
 *
 * The `__esModule: true` flag is required for the default-import interop
 * (`import X from 'pkg'`) — without it, ts-jest's CommonJS interop layer
 * resolves `Anthropic` to the entire mock object rather than its
 * `.default` property and the production-side `new Anthropic({...})`
 * call fails with `Anthropic is not a constructor`.
 *
 * Per the AAP-supplied implementation plan (Phase 2 — Mock Strategy),
 * this hoisted mock is the AUTHORITATIVE Rule 4 verification fixture:
 * Tests 4, 5, 6, 7, 10, 11 stage different `Message` shapes (with or
 * without a `tool_use` content block, with or without text-only
 * fallbacks, with or without the required `recommendations` /
 * `summary` / `warnings` top-level fields) so the production
 * `RebalancingService.recommend(...)` is exercised against EVERY
 * regression path Rule 4 prohibits — text-content parsing,
 * silent acceptance of malformed shapes, accidental tool-use bypasses,
 * etc.
 *
 * The factory is hoisted ABOVE the imports of the source under test by
 * Jest's module-mock machinery, so the service-under-test sees the
 * mocked SDK from its very first construction inside `beforeEach`. No
 * real Anthropic credentials, network egress, or paid API tokens are
 * consumed by this spec.
 */
jest.mock('@anthropic-ai/sdk', () => {
  const createMock = jest.fn();
  const Anthropic = jest.fn().mockImplementation(() => ({
    messages: {
      create: createMock
    }
  }));

  return {
    __createMock: createMock,
    __esModule: true,
    Anthropic,
    default: Anthropic
  };
});

/**
 * Unit tests for `RebalancingService` — the core service for **Feature
 * C — Explainable Rebalancing Engine** (per AAP § 0.1.1, § 0.1.2.4,
 * § 0.5.1.1, § 0.5.1.4, § 0.7.5.2).
 *
 * Source-of-truth references (AAP):
 *   - § 0.5.1.4: explicitly enumerates the four scenarios this spec
 *     MUST cover — "tool-use-only output (Rule 4), `goalReference`
 *     non-empty, structured-shape validation".
 *   - § 0.7.1.3 (Rule 3 — Credential Access via ConfigService):
 *     "ANTHROPIC_API_KEY ... read EXCLUSIVELY via injected
 *     ConfigService. Direct `process.env.ANTHROPIC` access in new
 *     module files is PROHIBITED."
 *   - § 0.7.1.4 (Rule 4 — Tool-Use Structured Output, CENTRAL TO THIS
 *     FEATURE): "RebalancingService MUST populate `RebalancingResponse`
 *     exclusively from a `tool_use` content block returned by the
 *     Anthropic SDK. Parsing Claude's text message content to extract
 *     structured fields is PROHIBITED."
 *   - § 0.7.5.2 (Rebalancing engine gate): "every item in
 *     `recommendations` has a non-empty `rationale` and `goalReference`;
 *     the response is sourced from a `tool_use` content block (Rule 4)."
 *
 * Hard rules verified by this spec (per AAP § 0.7):
 *   - Rule 1 (Module Isolation) — every collaborator type imported in
 *     this spec resolves through a public `exports` array of the source
 *     module (PortfolioService → PortfolioModule, SnowflakeSyncService →
 *     SnowflakeSyncModule, UserFinancialProfileService →
 *     UserFinancialProfileModule, MetricsService → MetricsModule).
 *   - Rule 3 (ConfigService) — Tests 1 and 2 assert the constructor
 *     reads `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` via the injected
 *     `ConfigService.get(...)`. Test 3 reads the source text of
 *     `rebalancing.service.ts` via `fs.readFileSync` and asserts there
 *     are zero matches for `process.env.ANTHROPIC` and
 *     `process.env.SNOWFLAKE` — the AAP § 0.7.5.2 "Security sweep gate"
 *     authoritative verification.
 *   - Rule 4 (Tool-Use Structured Output) — Test 4 verifies the
 *     `RebalancingResponse` returned by `recommend(...)` is sourced
 *     EXCLUSIVELY from the `tool_use` content block's `input` field
 *     (NOT from any sibling text block). Test 5 verifies the service
 *     throws `BadGatewayException` when the response contains only text
 *     content. Test 6 verifies `tool_choice: { type: 'tool', name:
 *     'rebalancing_recommendations' }` is set on every
 *     `messages.create(...)` call so Claude is REQUIRED to invoke that
 *     tool. Test 11 verifies a malformed `tool_use.input` (missing
 *     required top-level fields) also yields `BadGatewayException`
 *     rather than silent fallback parsing.
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/portfolio/current-rate.service.spec.ts` —
 *     canonical Ghostfolio NestJS spec layout with module-scope
 *     `jest.mock(...)` factories and direct service instantiation
 *     (`new RebalancingService(...)`).
 *   - `apps/api/src/app/snowflake-sync/snowflake-sync.service.spec.ts`
 *     — sibling Feature A spec demonstrating the `jest.mock(...)`
 *     factory + direct-instantiation pattern adopted here.
 */
describe('RebalancingService', () => {
  /**
   * Stable test-fixture user identifier reused across every `it(...)`
   * block. Using a stable ID makes failure logs easier to read and
   * signals "this is a test fixture, not a real user".
   */
  const TEST_USER_ID = 'user-1';

  /**
   * Stable correlation id used for every `recommend(...)` call. The
   * service propagates this string through every log line for the
   * Observability rule (AAP § 0.7.2); the spec does not assert against
   * log output, but supplying a fixed value keeps the request envelope
   * stable across tests.
   */
  const TEST_CORRELATION_ID = 'test-correlation-id';

  /**
   * Strongly-typed shape of the `ConfigService` mock. Declaring it
   * locally lets us assert against `configService.get` with full type
   * safety in Tests 1 and 2 without leaking jest internals into the
   * production typing surface.
   */
  interface ConfigServiceMock {
    get: jest.Mock<string | undefined, [string]>;
  }

  /**
   * Strongly-typed shape of the `MetricsService` mock. Mirrors the
   * three public methods consumed by the production
   * `RebalancingService` constructor (`registerHelp`) and runtime
   * (`incrementCounter`, `observeHistogram`). The mock deliberately
   * omits the internal Map-based registry of the real service —
   * counters and histograms accumulate as jest call records, not as
   * Prometheus exposition state.
   */
  interface MetricsServiceMock {
    incrementCounter: jest.Mock;
    observeHistogram: jest.Mock;
    registerHelp: jest.Mock;
  }

  /**
   * Strongly-typed shape of the `PortfolioService` mock. Exposes only
   * the two async methods consumed by `RebalancingService.buildPrompt`
   * and `recommend(...)` — `getDetails` and `getPerformance`. The
   * resolved values are minimal but well-formed so the production
   * code can navigate them without throwing
   * `Cannot read property '...' of undefined`.
   */
  interface PortfolioServiceMock {
    getDetails: jest.Mock;
    getPerformance: jest.Mock;
  }

  /**
   * Strongly-typed shape of the `SnowflakeSyncService` mock. Exposes
   * only the single async method consumed by the
   * `RebalancingService.fetchAllocationHistory(...)` private helper —
   * `queryHistory`. The default mock resolves with an empty array so
   * `summarizeHistory(...)` renders the "no historical snapshots on
   * file" sentinel without engaging the Snowflake SDK.
   */
  interface SnowflakeSyncServiceMock {
    queryHistory: jest.Mock;
  }

  /**
   * Strongly-typed shape of the `UserFinancialProfileService` mock.
   * Exposes only the single async method consumed by
   * `RebalancingService.buildPrompt(userId)` for goal-aware prompt
   * personalization — `findByUserId`.
   */
  interface UserFinancialProfileServiceMock {
    findByUserId: jest.Mock;
  }

  /**
   * Shape of a single `tool_use` content block returned by Claude.
   * Mirrors the relevant subset of the Anthropic SDK's
   * `Anthropic.ToolUseBlock` type without importing the SDK type
   * itself (the SDK is mocked at module-load time).
   */
  interface ToolUseBlock {
    id: string;
    input: unknown;
    name: string;
    type: 'tool_use';
  }

  /**
   * Shape of a single `text` content block returned by Claude. Used
   * only as a fixture in Tests 4 and 5 to stage the "text + tool_use"
   * and "text-only" responses that Rule 4 enforcement must handle
   * correctly (text blocks MUST be ignored even when a tool_use block
   * is also present, and a text-only response MUST throw
   * BadGatewayException rather than fall through to text parsing).
   */
  interface TextBlock {
    text: string;
    type: 'text';
  }

  /**
   * Shape of an Anthropic `messages.create(...)` response. Mirrors the
   * relevant subset of the SDK's `Anthropic.Message` type.
   */
  interface AnthropicMessage {
    content: (TextBlock | ToolUseBlock)[];
    id: string;
    model: string;
    role: 'assistant';
    stop_reason: string;
    stop_sequence: string | null;
    type: 'message';
    usage: { input_tokens: number; output_tokens: number };
  }

  /**
   * Shape of the single argument passed to
   * `anthropic.messages.create(...)`. Mirrors the relevant subset of
   * the SDK's `MessageCreateParams` type.
   */
  interface MessageCreateArg {
    max_tokens: number;
    messages: { content: string; role: string }[];
    model: string;
    system: string;
    tool_choice: { name: string; type: string };
    tools: {
      description: string;
      input_schema: {
        properties: Record<string, unknown>;
        required?: string[];
        type: string;
      };
      name: string;
    }[];
  }

  let configService: ConfigServiceMock;
  let createMock: jest.Mock;
  let metricsService: MetricsServiceMock;
  let portfolioService: PortfolioServiceMock;
  let service: RebalancingService;
  let snowflakeSyncService: SnowflakeSyncServiceMock;
  let userFinancialProfileService: UserFinancialProfileServiceMock;

  beforeEach(() => {
    /**
     * Reset every jest.fn() spy across all mocks so call history
     * never bleeds between `it(...)` blocks. This includes the SDK
     * mock's `messages.create` spy (re-acquired below from
     * `__createMock`).
     */
    jest.clearAllMocks();

    /**
     * Re-acquire the SDK `messages.create` mock from the
     * `jest.mock('@anthropic-ai/sdk', ...)` factory at the top of the
     * file. At runtime under Jest, `anthropicSdk` resolves to the
     * mocked module — including the non-typed `__createMock` helper
     * exposed by the factory. The `unknown` cast is the conventional
     * project-wide pattern (see also
     * `snowflake-sync.service.spec.ts` lines 514-518) for accessing
     * a test-only export from a mocked module without triggering
     * `@typescript-eslint/no-unsafe-member-access`.
     */
    createMock = (anthropicSdk as unknown as { __createMock: jest.Mock })
      .__createMock;
    createMock.mockReset();

    /**
     * `ConfigService.get(key)` resolves a small static lookup table for
     * the two Anthropic env vars consumed by `RebalancingService` —
     * and ONLY those two. Returning `undefined` for any other key
     * surfaces accidental leakage if the production code regresses to
     * read a different env var without registering it here first.
     *
     * The fake `ANTHROPIC_API_KEY` value (`'sk-test-fake-key'`) is
     * intentionally non-empty so the SDK constructor's
     * argument-validation does not reject it; the value never travels
     * to a real API because the SDK module is mocked at module-load
     * time by the `jest.mock('@anthropic-ai/sdk', ...)` block above.
     */
    configService = {
      get: jest.fn((key: string): string | undefined => {
        const map: Record<string, string> = {
          ANTHROPIC_API_KEY: 'sk-test-fake-key',
          ANTHROPIC_MODEL: 'claude-test-model'
        };
        return map[key];
      })
    };

    /**
     * `MetricsService` mock — `RebalancingService.constructor` calls
     * `metricsService.registerHelp(...)` twice for the two rebalancing
     * metrics (`rebalancing_requests_total`,
     * `rebalancing_latency_seconds`); `recommend(...)` then calls
     * `incrementCounter(...)` and `observeHistogram(...)` once each
     * inside its `finally` block. If any of the three methods were
     * absent, the test would fail in `beforeEach` (constructor) or
     * inside `recommend(...)` (terminal observation) with
     * `TypeError: ... is not a function`.
     */
    metricsService = {
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn(),
      registerHelp: jest.fn()
    };

    /**
     * `PortfolioService` mock — exposes the two async methods consumed
     * by `RebalancingService.buildPrompt(...)`. `getDetails` returns a
     * minimal-but-valid `holdings` map with two entries (an EQUITY and
     * a FIXED_INCOME asset) so `summarizePortfolio(...)` produces a
     * non-empty Markdown table. `getPerformance` is currently NOT
     * called by `recommend(...)` but is mocked defensively so future
     * refactors that wire it through `buildPrompt(...)` do not
     * regress this spec without explicit test updates.
     */
    portfolioService = {
      getDetails: jest.fn().mockResolvedValue({
        hasErrors: false,
        holdings: {
          AAPL: {
            allocationInPercentage: 0.5,
            assetClass: 'EQUITY',
            currency: 'USD',
            name: 'Apple Inc.',
            symbol: 'AAPL',
            valueInBaseCurrency: 5000
          },
          BND: {
            allocationInPercentage: 0.5,
            assetClass: 'FIXED_INCOME',
            currency: 'USD',
            name: 'Vanguard Total Bond',
            symbol: 'BND',
            valueInBaseCurrency: 5000
          }
        }
      }),
      getPerformance: jest.fn().mockResolvedValue({
        chart: [],
        firstOrderDate: undefined,
        hasErrors: false,
        performance: {
          currentNetWorth: 10000,
          currentValueInBaseCurrency: 10000,
          netPerformance: 500,
          netPerformancePercentage: 0.05,
          netPerformancePercentageWithCurrencyEffect: 0.05,
          netPerformanceWithCurrencyEffect: 500,
          totalInvestment: 9500,
          totalInvestmentValueWithCurrencyEffect: 9500
        }
      })
    };

    /**
     * `SnowflakeSyncService` mock — the production
     * `RebalancingService.fetchAllocationHistory(...)` private helper
     * issues a parameterized `SELECT` against `portfolio_snapshots`.
     * The mock resolves with an empty array so the code path executes
     * without throwing while the prompt-builder renders the "no
     * historical snapshots on file" sentinel. Test failures wishing
     * to assert against `queryHistory` call shape can inspect the
     * spy's `mock.calls` directly.
     */
    snowflakeSyncService = {
      queryHistory: jest.fn().mockResolvedValue([])
    };

    /**
     * `UserFinancialProfileService` mock — exposes `findByUserId(...)`
     * returning a synthetic `FinancialProfile` row. The fixture data
     * (riskTolerance HIGH, retirementTargetAge 65, timeHorizonYears
     * 25, an investment goal labeled "House Down Payment") is
     * sufficient for `summarizeProfile(...)` to render a populated
     * Markdown bullet list. Test 8 asserts this method is called
     * exactly with the JWT-authoritative `userId` argument.
     */
    userFinancialProfileService = {
      findByUserId: jest.fn().mockResolvedValue({
        createdAt: new Date(),
        investmentGoals: [
          {
            label: 'House Down Payment',
            targetAmount: 100_000,
            targetDate: '2030-01-01'
          }
        ],
        monthlyDebtObligations: 2000,
        monthlyIncome: 10000,
        retirementTargetAge: 65,
        retirementTargetAmount: 1_000_000,
        riskTolerance: 'HIGH',
        timeHorizonYears: 25,
        updatedAt: new Date(),
        userId: TEST_USER_ID
      })
    };

    /**
     * Direct service instantiation per the canonical Ghostfolio
     * service-spec convention (see
     * `apps/api/src/app/portfolio/current-rate.service.spec.ts`,
     * `apps/api/src/services/benchmark/benchmark.service.spec.ts`,
     * and the sibling `user-financial-profile.service.spec.ts`).
     *
     * The `as unknown as <Type>` casts are required because the mock
     * objects expose only the subset of methods exercised by the
     * production code; the full collaborator types declare many more
     * public surfaces that are intentionally absent from the mocks
     * (a regression that introduces a call to one of those absent
     * methods will fail with `TypeError: ... is not a function`,
     * which is the desired protective behavior).
     *
     * Constructor parameter order MUST match
     * `rebalancing.service.ts` exactly:
     *   (configService, metricsService, portfolioService,
     *    snowflakeSyncService, userFinancialProfileService)
     */
    service = new RebalancingService(
      configService as unknown as ConfigService,
      metricsService as unknown as MetricsService,
      portfolioService as unknown as PortfolioService,
      snowflakeSyncService as unknown as SnowflakeSyncService,
      userFinancialProfileService as unknown as UserFinancialProfileService
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — Constructor reads ANTHROPIC_API_KEY through ConfigService
  //          (Rule 3 — AAP § 0.7.1.3)
  // -------------------------------------------------------------------------

  it('reads ANTHROPIC_API_KEY from the injected ConfigService at construction time (Rule 3)', () => {
    // Sanity: the service was instantiated by `beforeEach` above. The
    // assertion verifies that during construction `configService.get`
    // received the canonical key — which is the ONLY way
    // `RebalancingService` is permitted to source the Anthropic
    // credential per Rule 3 (AAP § 0.7.1.3).
    expect(service).toBeDefined();
    expect(configService.get).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  // -------------------------------------------------------------------------
  // Test 2 — Constructor reads ANTHROPIC_MODEL through ConfigService
  //          (Rule 3 — AAP § 0.7.1.3 + AAP § 0.7.3 model override)
  // -------------------------------------------------------------------------

  it('reads ANTHROPIC_MODEL from the injected ConfigService at construction time (Rule 3 + AAP § 0.7.3 override)', () => {
    // AAP § 0.7.3 stipulates that the Claude model id MUST be
    // overridable via `ConfigService`-readable `ANTHROPIC_MODEL`.
    // Verifying the construction-time read prevents a regression
    // that hardcodes a specific model id directly in source.
    expect(configService.get).toHaveBeenCalledWith('ANTHROPIC_MODEL');
  });

  // -------------------------------------------------------------------------
  // Test 3 — Source-text grep verifies NO `process.env.ANTHROPIC` /
  //          `process.env.SNOWFLAKE` access in the production source
  //          (Rule 3 source-grep verification — AAP § 0.7.5.2 Security
  //          sweep gate)
  // -------------------------------------------------------------------------

  it('source code does NOT contain `process.env.ANTHROPIC` or `process.env.SNOWFLAKE` references (Rule 3 source-grep verification — AAP § 0.7.5.2 Security sweep gate)', () => {
    // The AUTHORITATIVE Rule 3 verification per AAP § 0.7.5.2:
    // ANY future regression that re-introduces direct credential env
    // access into the production `RebalancingService` source file
    // will fail this test at build time, BEFORE the regression can
    // be merged. The grep targets the two prefixes called out in
    // AAP § 0.7.1.3 — `ANTHROPIC` and `SNOWFLAKE`.
    //
    // `__dirname` resolves to the directory of THIS spec file at
    // runtime under Jest, so `path.join(__dirname,
    // 'rebalancing.service.ts')` correctly locates the sibling
    // production source regardless of the working directory from
    // which `nx test api` is invoked.
    const sourceText = fs.readFileSync(
      path.join(__dirname, 'rebalancing.service.ts'),
      'utf8'
    );

    expect(sourceText).not.toMatch(/process\.env\.ANTHROPIC/);
    expect(sourceText).not.toMatch(/process\.env\.SNOWFLAKE/);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Rule 4: structured RebalancingResponse sourced EXCLUSIVELY
  //          from a `tool_use` content block (CENTRAL TO FEATURE C —
  //          AAP § 0.7.1.4)
  // -------------------------------------------------------------------------

  it('reads structured RebalancingResponse EXCLUSIVELY from a `tool_use` content block (Rule 4 — AAP § 0.7.1.4 CENTRAL TO FEATURE C)', async () => {
    // Stage a Claude response containing BOTH a text block (which the
    // service MUST IGNORE per Rule 4) and a `tool_use` block whose
    // `input` is the canonical structured `RebalancingResponse`.
    // The test then asserts the service's return value equals the
    // tool_use input VERBATIM — proving that the text block was
    // never parsed and that the service sourced its output
    // exclusively from `content[type === 'tool_use'].input`.
    const expectedResponse = {
      recommendations: [
        {
          action: 'BUY',
          fromPct: 0.5,
          goalReference: 'riskTolerance',
          rationale:
            'Increase US equity to align with HIGH risk tolerance and 25-year time horizon.',
          ticker: 'VTI',
          toPct: 0.7
        }
      ],
      summary: 'Reallocate toward equities given HIGH risk tolerance.',
      warnings: []
    };

    const stagedResponse: AnthropicMessage = {
      content: [
        // Text block — the service MUST IGNORE this even though it
        // appears BEFORE the `tool_use` block.
        {
          text: 'I will provide a recommendation now.',
          type: 'text'
        },
        {
          id: 'toolu_test',
          input: expectedResponse,
          name: 'rebalancing_recommendations',
          type: 'tool_use'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    const result = await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // The result MUST equal the `tool_use.input` verbatim. If the
    // service ever falls back to parsing the text block (which would
    // be a Rule 4 violation), the result would either be a different
    // object shape or an error — either of which fails this
    // assertion.
    expect(result).toEqual(expectedResponse);
  });

  // -------------------------------------------------------------------------
  // Test 5 — Rule 4: rejects responses lacking a `tool_use` content
  //          block (regression guard against text-parsing fallbacks —
  //          AAP § 0.7.1.4)
  // -------------------------------------------------------------------------

  it('throws BadGatewayException when Anthropic returns NO `tool_use` content block (Rule 4 — text-parsing fallback regression guard)', async () => {
    // Stage a Claude response with ONLY a text block — no `tool_use`
    // block at all. The text block intentionally LOOKS like a JSON-
    // parseable rebalancing response (with `recommendations` and an
    // `action`) so a regression that reaches for `JSON.parse(text)`
    // as a fallback would silently succeed; this test catches that
    // regression by asserting the service throws BadGatewayException
    // instead.
    const stagedResponse: AnthropicMessage = {
      content: [
        {
          text: '{"recommendations": [{"action": "BUY", "ticker": "VTI"}]}',
          type: 'text'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    await expect(
      service.recommend({
        correlationId: TEST_CORRELATION_ID,
        requestPayload: {},
        userId: TEST_USER_ID
      })
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  // -------------------------------------------------------------------------
  // Test 6 — Anthropic call uses `tool_choice` to force the
  //          `rebalancing_recommendations` tool (Rule 4 enforcement at
  //          the request boundary — AAP § 0.5.1.1)
  // -------------------------------------------------------------------------

  it('forces tool invocation via `tool_choice` when calling Anthropic.messages.create (Rule 4 request-boundary enforcement)', async () => {
    // Stage a minimal valid response so the service returns rather
    // than throws — the assertions below inspect the REQUEST shape
    // sent to the SDK, not the response handling.
    const stagedResponse: AnthropicMessage = {
      content: [
        {
          id: 'toolu_test',
          input: {
            recommendations: [],
            summary: 'No changes needed.',
            warnings: []
          },
          name: 'rebalancing_recommendations',
          type: 'tool_use'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // The service MUST issue exactly ONE Anthropic call per
    // `recommend(...)` invocation — multiple calls would suggest
    // unintended retry logic that could double-count metrics.
    expect(createMock).toHaveBeenCalledTimes(1);

    // Tuple-destructure the call argument tuple from Jest's untyped
    // `mock.calls: any[][]` shape — this preserves strict typing
    // through the destructuring binding (per
    // `apps/api/src/app/ai-chat/ai-chat.service.spec.ts:506-512`).
    const [callArg] = createMock.mock.calls[0] as [MessageCreateArg];

    // The `tools` array MUST contain at least one tool with the
    // canonical `rebalancing_recommendations` name; the Rule 4
    // production code REQUIRES this name as the `tool_choice` target
    // and as the `find(...)` predicate when reading structured output
    // from the response.
    expect(Array.isArray(callArg.tools)).toBe(true);
    expect(callArg.tools.length).toBeGreaterThanOrEqual(1);

    const tool = callArg.tools[0];
    expect(tool.name).toBe('rebalancing_recommendations');
    expect(tool.input_schema).toBeDefined();

    // `tool_choice: { type: 'tool', name: '...' }` is the canonical
    // Anthropic API contract for FORCING a specific tool invocation
    // — Claude is then required to emit a `tool_use` content block
    // for that named tool, eliminating the text-only response branch
    // that Rule 4 prohibits.
    expect(callArg.tool_choice).toEqual({
      name: 'rebalancing_recommendations',
      type: 'tool'
    });
  });

  // -------------------------------------------------------------------------
  // Test 7 — Tool `input_schema` declares the three top-level
  //          RebalancingResponse fields (AAP § 0.1.2.4 contract)
  // -------------------------------------------------------------------------

  it('declares an input_schema with `recommendations`, `summary`, and `warnings` properties (AAP § 0.1.2.4 contract)', async () => {
    const stagedResponse: AnthropicMessage = {
      content: [
        {
          id: 'toolu_test',
          input: {
            recommendations: [],
            summary: '',
            warnings: []
          },
          name: 'rebalancing_recommendations',
          type: 'tool_use'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // Tuple-destructure the call argument tuple from Jest's untyped
    // `mock.calls: any[][]` shape (see Test 6 commentary).
    const [callArg] = createMock.mock.calls[0] as [MessageCreateArg];
    const tool = callArg.tools[0];
    const schema = tool.input_schema;

    // Per Anthropic's tool-definition contract, `input_schema` MUST
    // be a JSON-Schema-shaped object with `type: 'object'` and a
    // `properties` map. The three properties asserted below mirror
    // the three top-level fields of the AAP § 0.1.2.4
    // `RebalancingResponse` interface:
    //   - recommendations: Array<...>
    //   - summary: string
    //   - warnings: string[]
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties.recommendations).toBeDefined();
    expect(schema.properties.summary).toBeDefined();
    expect(schema.properties.warnings).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 8 — `recommend(...)` reads the user's FinancialProfile via the
  //          injected UserFinancialProfileService.findByUserId with the
  //          JWT-authoritative userId (Rule 5 spirit — downstream
  //          consumer of canonical profile reader)
  // -------------------------------------------------------------------------

  it('reads the user FinancialProfile via UserFinancialProfileService.findByUserId with the JWT-authoritative userId', async () => {
    const stagedResponse: AnthropicMessage = {
      content: [
        {
          id: 'toolu_test',
          input: { recommendations: [], summary: '', warnings: [] },
          name: 'rebalancing_recommendations',
          type: 'tool_use'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // The first positional argument MUST be the JWT-authoritative
    // userId. Per Rule 5 spirit: even though
    // `UserFinancialProfileService` is the canonical reader (not
    // `RebalancingService`), every downstream consumer MUST forward
    // the JWT-verified userId — never a body-supplied or
    // tool-supplied id.
    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledTimes(1);
    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledWith(
      TEST_USER_ID
    );
  });

  // -------------------------------------------------------------------------
  // Test 9 — `recommend(...)` reads the current portfolio via the
  //          injected PortfolioService.getDetails with the
  //          JWT-authoritative userId
  // -------------------------------------------------------------------------

  it('reads the current portfolio via PortfolioService.getDetails with the JWT-authoritative userId', async () => {
    const stagedResponse: AnthropicMessage = {
      content: [
        {
          id: 'toolu_test',
          input: { recommendations: [], summary: '', warnings: [] },
          name: 'rebalancing_recommendations',
          type: 'tool_use'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // The portfolio fetch MUST be issued exactly once per
    // `recommend(...)` invocation, with `userId` set to the
    // JWT-authoritative value. The `impersonationId: undefined`
    // clause is set inside the service body — the test asserts only
    // the `userId` field to keep the test resilient to future
    // signature additions (e.g., filters, dateRange) that don't
    // affect Rule 4 / Rule 5 compliance. (QA Checkpoint 9 CRITICAL
    // #1 follow-on standardized `null` → `undefined` to match the
    // existing controller pattern and avoid Prisma 7 rejection.)
    expect(portfolioService.getDetails).toHaveBeenCalledTimes(1);

    // Tuple-destructure the call argument tuple from Jest's untyped
    // `mock.calls: any[][]` shape (see Test 6 commentary).
    const [callArg] = portfolioService.getDetails.mock.calls[0] as [
      { impersonationId: string | undefined; userId: string }
    ];

    expect(callArg.userId).toBe(TEST_USER_ID);
    expect(callArg.impersonationId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 10 — Per-recommendation rationale and goalReference are
  //           non-empty (AAP § 0.7.5.2 Rebalancing engine gate)
  // -------------------------------------------------------------------------

  it('every recommendation in the response has a non-empty rationale and goalReference (AAP § 0.7.5.2 Rebalancing engine gate)', async () => {
    // Stage a multi-recommendation response. The AAP § 0.7.5.2 gate
    // demands that EVERY entry in the `recommendations` array has
    // both a non-empty `rationale` AND a non-empty `goalReference`.
    // The fixture below intentionally uses two entries with distinct
    // goalReference values (riskTolerance, timeHorizonYears) so the
    // assertion exercises both indices.
    const responseInput = {
      recommendations: [
        {
          action: 'BUY',
          fromPct: 0.1,
          goalReference: 'riskTolerance',
          rationale:
            'Increase equity allocation to align with HIGH risk tolerance and long time horizon.',
          ticker: 'VTI',
          toPct: 0.2
        },
        {
          action: 'SELL',
          fromPct: 0.3,
          goalReference: 'timeHorizonYears',
          rationale: 'Reduce bond allocation given 25-year time horizon.',
          ticker: 'BND',
          toPct: 0.2
        }
      ],
      summary: 'Reallocation favors equities.',
      warnings: []
    };

    const stagedResponse: AnthropicMessage = {
      content: [
        {
          id: 'toolu_test',
          input: responseInput,
          name: 'rebalancing_recommendations',
          type: 'tool_use'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    const result = await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // Inline assertion of the AAP § 0.7.5.2 gate: iterate every
    // recommendation and verify both fields are non-empty strings.
    // The use of `expect.any(String)` paired with a `length > 0`
    // length check enforces both type AND non-empty constraints.
    expect(result.recommendations.length).toBeGreaterThan(0);

    for (const recommendation of result.recommendations) {
      expect(recommendation.rationale).toEqual(expect.any(String));
      expect(recommendation.rationale.length).toBeGreaterThan(0);
      expect(recommendation.goalReference).toEqual(expect.any(String));
      expect(recommendation.goalReference.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 11 — Rejects responses where `tool_use.input` is missing the
  //           required top-level fields (Rule 4 shape-validation guard
  //           — AAP § 0.7.1.4)
  // -------------------------------------------------------------------------

  it('throws BadGatewayException when `tool_use.input` is missing required top-level fields (Rule 4 shape validation)', async () => {
    // Stage a `tool_use` response whose `input` is a JSON object that
    // looks plausible but is missing the required `recommendations`
    // and `summary` fields (only `warnings` is present). A regression
    // that accepts ANY truthy `tool_use.input` without shape
    // validation would silently return this malformed payload to
    // the caller — which AAP § 0.7.5.2 ("Rebalancing engine gate")
    // explicitly forbids ("returns JSON matching the
    // RebalancingResponse interface"). The expected behavior is
    // BadGatewayException so the global exception filter maps the
    // failure to HTTP 502 and the client surfaces the upstream-API
    // failure mode.
    const stagedResponse: AnthropicMessage = {
      content: [
        {
          id: 'toolu_test',
          // Note: `recommendations` and `summary` deliberately
          // missing; only `warnings` (also empty) is present.
          input: { warnings: [] } as unknown,
          name: 'rebalancing_recommendations',
          type: 'tool_use'
        }
      ],
      id: 'msg_test',
      model: 'claude-test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 100, output_tokens: 50 }
    };

    createMock.mockResolvedValueOnce(stagedResponse);

    await expect(
      service.recommend({
        correlationId: TEST_CORRELATION_ID,
        requestPayload: {},
        userId: TEST_USER_ID
      })
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
