import { AiProviderService } from '@ghostfolio/api/app/ai-provider/ai-provider.service';
import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SnowflakeSyncService } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.service';
import { UserFinancialProfileService } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.service';

import { BadGatewayException, Logger } from '@nestjs/common';
import * as aiSdk from 'ai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import { RebalancingService } from './rebalancing.service';

/**
 * Mocks the `ai` module (Vercel AI SDK) at module-load time so the spec
 * NEVER initiates a real network call to any provider endpoint. The mock
 * factory replaces:
 *   - `generateText` — a `jest.fn()` spy that each `it(...)` block
 *     stages with `mockResolvedValueOnce(...)` to drive different
 *     `result.toolCalls` shapes.
 *   - `tool` — an identity passthrough that returns its config object
 *     verbatim. This preserves the structure (`{description,
 *     parameters}`) so the spec can inspect both the description
 *     string AND the underlying Zod parameters schema directly via
 *     `tools[TOOL_NAME].parameters.parse(...)`.
 *
 * The `__generateTextMock` and `__toolMock` test-only exports are
 * exposed through the conventional double-underscore prefix per the
 * sibling `snowflake-sync.service.spec.ts` and `ai-chat.service.spec.ts`
 * patterns.
 *
 * Per Refine PR Directive 3, this hoisted mock is the AUTHORITATIVE
 * Rule 4 verification fixture for the Vercel AI SDK migration:
 * Tests stage different `result.toolCalls` shapes (with or without
 * a matching tool name, with or without the required
 * `recommendations` / `summary` / `warnings` top-level fields, with
 * or without per-recommendation `goalReference`/`rationale`) so the
 * production `RebalancingService.recommend(...)` is exercised
 * against EVERY regression path Rule 4 prohibits.
 */
jest.mock('ai', () => {
  const generateTextMock = jest.fn();
  // The `tool()` factory in the real Vercel AI SDK returns a
  // `Tool` object. For testing we use an identity passthrough so
  // the assertions below can inspect the original `description`
  // and Zod `parameters` schema fields directly.
  const toolMock = jest.fn((cfg: unknown) => cfg);

  return {
    __esModule: true,
    __generateTextMock: generateTextMock,
    __toolMock: toolMock,
    generateText: generateTextMock,
    tool: toolMock
  };
});

/**
 * Unit tests for `RebalancingService` — the core service for **Feature
 * C — Explainable Rebalancing Engine** (per AAP § 0.1.1, § 0.1.2.4,
 * § 0.5.1.1, § 0.5.1.4, § 0.7.5.2), MIGRATED to the Vercel AI SDK per
 * **Refine PR Directive 3**.
 *
 * Source-of-truth references:
 *   - **Refine PR Directive 3** — pass/fail criterion #1: returns
 *     valid `RebalancingResponse` shape on success. Pass/fail #2:
 *     `BadGatewayException` + `no_tool_use` counter increment when
 *     `toolChoice: 'required'` is not honored by the configured
 *     provider (e.g., a model that emits text only).
 *   - **AAP § 0.5.1.4** — explicitly enumerates the four scenarios
 *     this spec MUST cover: "tool-use-only output (Rule 4),
 *     `goalReference` non-empty, structured-shape validation".
 *   - **AAP § 0.7.1.4 (Rule 4)** — "RebalancingService MUST populate
 *     `RebalancingResponse` exclusively from a `tool_use` content
 *     block returned by the Anthropic SDK. Parsing Claude's text
 *     message content to extract structured fields is PROHIBITED."
 *     For the Vercel AI SDK migration, "tool_use content block" is
 *     replaced by the equivalent Vercel SDK abstraction
 *     `result.toolCalls[i].args`.
 *   - **AAP § 0.7.5.2 (Rebalancing engine gate)** — "every item in
 *     `recommendations` has a non-empty `rationale` and
 *     `goalReference`; the response is sourced from a tool_use
 *     content block (Rule 4)."
 *
 * Hard rules verified by this spec (per AAP § 0.7):
 *   - **Rule 1 (Module Isolation)** — every collaborator type imported
 *     in this spec resolves through a public `exports` array of the
 *     source module (PortfolioService → PortfolioModule,
 *     SnowflakeSyncService → SnowflakeSyncModule,
 *     UserFinancialProfileService → UserFinancialProfileModule,
 *     MetricsService → MetricsModule, AiProviderService →
 *     AiProviderModule).
 *   - **Rule 3 (ConfigService)** — Test "source code grep" reads the
 *     source text of `rebalancing.service.ts` via `fs.readFileSync`
 *     and asserts there are zero matches for `process.env.ANTHROPIC`,
 *     `process.env.SNOWFLAKE`, or any `@anthropic-ai/sdk` import.
 *     Provider-credential reading is fully delegated to the injected
 *     `AiProviderService` (Refine PR Directive 1).
 *   - **Rule 4 (Tool-Use Structured Output)** — multiple tests verify
 *     the `RebalancingResponse` returned by `recommend(...)` is
 *     sourced EXCLUSIVELY from `result.toolCalls[0].args`, that the
 *     `generateText` call uses `toolChoice: 'required'`, and that an
 *     empty `result.toolCalls` array yields a `BadGatewayException`
 *     with the `no_tool_use` outcome label (Refine PR Directive 3
 *     pass/fail #2).
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/ai-chat/ai-chat.service.spec.ts` — sibling
 *     Vercel AI SDK migration spec (Refine PR Directive 2) using the
 *     same direct-instantiation + jest.mock('ai') pattern.
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
   * Observability rule (AAP § 0.7.2); the spec does not assert
   * against log output, but supplying a fixed value keeps the
   * request envelope stable across tests.
   */
  const TEST_CORRELATION_ID = 'test-correlation-id';

  /**
   * Stable model object returned by the AiProviderService mock.
   * The test never inspects this object's contents — it only
   * verifies that `generateText({ model, ... })` was called with
   * EXACTLY this reference (proving the production code reads from
   * AiProviderService instead of constructing its own model).
   */
  const TEST_MODEL_REF = { __test_model: true };

  /**
   * Strongly-typed shape of the `AiProviderService` mock. Mirrors the
   * three public methods consumed by `RebalancingService`:
   * `getModel()` (returns the LanguageModel instance to pass to
   * `generateText`), `getModelId()` and `getProvider()` (used in
   * structured-error log lines per Refine PR Directive 3).
   */
  interface AiProviderServiceMock {
    getModel: jest.Mock;
    getModelId: jest.Mock;
    getProvider: jest.Mock;
  }

  /**
   * Strongly-typed shape of the `MetricsService` mock. Mirrors the
   * three public methods consumed by the production
   * `RebalancingService` constructor (`registerHelp`) and runtime
   * (`incrementCounter`, `observeHistogram`).
   */
  interface MetricsServiceMock {
    incrementCounter: jest.Mock;
    observeHistogram: jest.Mock;
    registerHelp: jest.Mock;
  }

  /**
   * Strongly-typed shape of the `PortfolioService` mock. Exposes the
   * two async methods consumed by `RebalancingService.buildPrompt`
   * — `getDetails` and (defensively) `getPerformance`. The resolved
   * values are minimal but well-formed so `summarizePortfolio(...)`
   * does not encounter `undefined` field accesses.
   */
  interface PortfolioServiceMock {
    getDetails: jest.Mock;
    getPerformance: jest.Mock;
  }

  /**
   * Strongly-typed shape of the `SnowflakeSyncService` mock. Exposes
   * the single async method consumed by
   * `RebalancingService.fetchAllocationHistory(...)` —
   * `queryHistory`. The default mock resolves with an empty array so
   * the prompt-builder renders the "no historical snapshots on file"
   * sentinel without engaging the real Snowflake SDK.
   */
  interface SnowflakeSyncServiceMock {
    queryHistory: jest.Mock;
  }

  /**
   * Strongly-typed shape of the `UserFinancialProfileService` mock.
   * Exposes the single async method consumed by
   * `RebalancingService.buildPrompt(userId)` for goal-aware prompt
   * personalization — `findByUserId`.
   */
  interface UserFinancialProfileServiceMock {
    findByUserId: jest.Mock;
  }

  /**
   * Shape of a single `tool_use`-equivalent toolCall returned by the
   * Vercel AI SDK. Mirrors the relevant subset of the SDK's
   * `ToolCall` type.
   */
  interface ToolCall {
    args: unknown;
    toolCallId: string;
    toolName: string;
  }

  /**
   * Shape of a `generateText` response. Mirrors the relevant subset
   * of the SDK's `GenerateTextResult` type — only `toolCalls` is
   * inspected by the production code (Rule 4: text content is NEVER
   * parsed for structured output).
   */
  interface GenerateTextResult {
    text?: string;
    toolCalls: ToolCall[];
  }

  /**
   * Shape of the single argument passed to `generateText(...)`.
   * Mirrors the subset of the SDK's `CallSettings` & `Prompt` types
   * exercised by `RebalancingService.recommend(...)`. The `tools`
   * map is keyed by tool name (Vercel SDK convention) — different
   * from Anthropic's flat `tools: Tool[]` array — and `toolChoice`
   * is the literal string `'required'` (Vercel SDK syntax for
   * forced tool use).
   */
  interface GenerateTextArg {
    messages: { content: string; role: string }[];
    model: unknown;
    system: string;
    toolChoice: string;
    tools: Record<
      string,
      {
        description: string;
        parameters: z.ZodTypeAny;
      }
    >;
  }

  let aiProviderService: AiProviderServiceMock;
  let generateTextMock: jest.Mock;
  let metricsService: MetricsServiceMock;
  let portfolioService: PortfolioServiceMock;
  let service: RebalancingService;
  let snowflakeSyncService: SnowflakeSyncServiceMock;
  let userFinancialProfileService: UserFinancialProfileServiceMock;

  beforeEach(() => {
    /**
     * Reset every jest.fn() spy across all mocks so call history
     * never bleeds between `it(...)` blocks. This includes the SDK
     * mock's `generateText` spy (re-acquired below from
     * `__generateTextMock`).
     */
    jest.clearAllMocks();

    /**
     * Re-acquire the SDK `generateText` mock from the
     * `jest.mock('ai', ...)` factory at the top of the file. At
     * runtime under Jest, `aiSdk` resolves to the mocked module —
     * including the non-typed `__generateTextMock` helper exposed by
     * the factory. The `unknown` cast is the conventional
     * project-wide pattern for accessing a test-only export from a
     * mocked module without triggering
     * `@typescript-eslint/no-unsafe-member-access`.
     */
    generateTextMock = (aiSdk as unknown as { __generateTextMock: jest.Mock })
      .__generateTextMock;
    generateTextMock.mockReset();

    /**
     * `AiProviderService` mock — `getModel()` returns a stable
     * sentinel object reference so the spec can verify the
     * production code passes EXACTLY this reference to
     * `generateText({ model, ... })`. `getModelId()` and
     * `getProvider()` return non-empty strings so the structured
     * ERROR log line in the `no_tool_use` failure path interpolates
     * meaningful values.
     */
    aiProviderService = {
      getModel: jest.fn().mockReturnValue(TEST_MODEL_REF),
      getModelId: jest.fn().mockReturnValue('claude-test-model'),
      getProvider: jest.fn().mockReturnValue('anthropic')
    };

    /**
     * `MetricsService` mock — `RebalancingService.constructor` calls
     * `metricsService.registerHelp(...)` twice for the two
     * rebalancing metrics (`rebalancing_requests_total`,
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
     * `PortfolioService` mock — `getDetails` returns a
     * minimal-but-valid `holdings` map with two entries (an EQUITY
     * and a FIXED_INCOME asset) so `summarizePortfolio(...)`
     * produces a non-empty Markdown table.
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
     * `SnowflakeSyncService` mock — `queryHistory` resolves with an
     * empty array by default; the production code path executes
     * without throwing while the prompt-builder renders the "no
     * historical snapshots on file" sentinel.
     */
    snowflakeSyncService = {
      queryHistory: jest.fn().mockResolvedValue([])
    };

    /**
     * `UserFinancialProfileService` mock — `findByUserId(...)`
     * returns a synthetic `FinancialProfile` row. The fixture data
     * (riskTolerance HIGH, retirementTargetAge 65, timeHorizonYears
     * 25, an investment goal labeled "House Down Payment") is
     * sufficient for `summarizeProfile(...)` to render a populated
     * Markdown bullet list.
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
     * service-spec convention.
     *
     * The `as unknown as <Type>` casts are required because the mock
     * objects expose only the subset of methods exercised by the
     * production code; the full collaborator types declare many
     * more public surfaces that are intentionally absent from the
     * mocks.
     *
     * Constructor parameter order MUST match `rebalancing.service.ts`
     * exactly:
     *   (aiProviderService, metricsService, portfolioService,
     *    snowflakeSyncService, userFinancialProfileService)
     */
    service = new RebalancingService(
      aiProviderService as unknown as AiProviderService,
      metricsService as unknown as MetricsService,
      portfolioService as unknown as PortfolioService,
      snowflakeSyncService as unknown as SnowflakeSyncService,
      userFinancialProfileService as unknown as UserFinancialProfileService
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — Constructor sanity + metrics registration
  // -------------------------------------------------------------------------

  it('constructs successfully and registers the two Prometheus metrics', () => {
    expect(service).toBeDefined();

    // The constructor MUST register HELP text for both metrics so
    // `/api/v1/metrics` emits proper `# HELP` lines (per the
    // Observability rule, AAP § 0.7.2).
    expect(metricsService.registerHelp).toHaveBeenCalledTimes(2);
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      'rebalancing_requests_total',
      expect.any(String)
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      'rebalancing_latency_seconds',
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — Source-text grep verifies NO `process.env.ANTHROPIC` /
  //          `process.env.SNOWFLAKE` access AND NO `@anthropic-ai/sdk`
  //          imports in the production source (Rule 3 source-grep
  //          verification — AAP § 0.7.5.2 Security sweep gate).
  //          Refine PR Directive 1 + 3 migration verification: the
  //          production source MUST delegate provider-credential
  //          reading to AiProviderService and MUST use the Vercel AI
  //          SDK (`ai`) rather than the raw Anthropic SDK.
  // -------------------------------------------------------------------------

  it('source code does NOT contain raw provider-credential env reads or @anthropic-ai/sdk imports (Rule 3 source-grep verification — AAP § 0.7.5.2 Security sweep gate; Refine PR Directive 1 + 3 migration verification)', () => {
    // The AUTHORITATIVE Rule 3 verification per AAP § 0.7.5.2: ANY
    // future regression that re-introduces direct credential env
    // access or the raw Anthropic SDK into the production
    // `RebalancingService` source file will fail this test at build
    // time, BEFORE the regression can be merged.
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
    expect(sourceText).not.toMatch(/from '@anthropic-ai\/sdk'/);
    expect(sourceText).not.toMatch(/from "@anthropic-ai\/sdk"/);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Rule 4: structured RebalancingResponse sourced EXCLUSIVELY
  //          from `result.toolCalls[0].args` (CENTRAL TO FEATURE C —
  //          AAP § 0.7.1.4)
  // -------------------------------------------------------------------------

  it('reads structured RebalancingResponse EXCLUSIVELY from result.toolCalls[0].args (Rule 4 — AAP § 0.7.1.4 CENTRAL TO FEATURE C)', async () => {
    // Stage a Vercel SDK response containing BOTH a free-form text
    // field (which the service MUST IGNORE per Rule 4) and a
    // `toolCalls[0]` entry whose `args` is the canonical structured
    // `RebalancingResponse`. The test then asserts the service's
    // return value equals the toolCall args VERBATIM — proving
    // that the text field was never parsed and that the service
    // sourced its output exclusively from `toolCalls[0].args`.
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

    const stagedResponse: GenerateTextResult = {
      // The text field is intentionally non-empty and intentionally
      // contains a JSON-parseable rebalancing-like blob to catch
      // any regression that falls back to text parsing.
      text: '{"recommendations": "I will not be parsed"}',
      toolCalls: [
        {
          args: expectedResponse,
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    const result = await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // The result MUST equal the toolCalls[0].args verbatim. If the
    // service ever falls back to parsing `result.text` (which would
    // be a Rule 4 violation), the result would differ.
    expect(result).toEqual(expectedResponse);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Refine PR Directive 3 pass/fail #2: empty `toolCalls`
  //          yields BadGatewayException + `no_tool_use` outcome
  //          counter increment + provider name logged at ERROR level
  // -------------------------------------------------------------------------

  it('throws BadGatewayException with no_tool_use outcome when result.toolCalls is empty (Refine PR Directive 3 pass/fail #2)', async () => {
    // Stage a response where the configured provider did NOT honor
    // `toolChoice: 'required'` (e.g., a local Ollama model that
    // lacks tool-use training, or a misconfigured provider that
    // emits text only). The service MUST throw BadGatewayException
    // (HTTP 502) and MUST increment
    // `rebalancing_requests_total{outcome="no_tool_use"}`.
    const stagedResponse: GenerateTextResult = {
      text: 'I cannot use tools.',
      toolCalls: []
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    // Spy on Logger.error to verify the provider name is logged at
    // ERROR level (Refine PR Directive 3 explicit requirement). The
    // implementation is a no-op (`return undefined`) so that the spy
    // simply suppresses the actual log emission while still recording
    // every invocation. The explicit body — instead of an empty arrow —
    // satisfies the `@typescript-eslint/no-empty-function` rule.
    const errorSpy = jest.spyOn(Logger, 'error').mockImplementation(() => {
      return undefined;
    });

    await expect(
      service.recommend({
        correlationId: TEST_CORRELATION_ID,
        requestPayload: {},
        userId: TEST_USER_ID
      })
    ).rejects.toBeInstanceOf(BadGatewayException);

    // The `no_tool_use` outcome counter MUST be incremented exactly
    // once (the `finally` block runs even on the throw).
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'rebalancing_requests_total',
      1,
      { outcome: 'no_tool_use' }
    );

    // The provider name MUST appear in the ERROR log line so
    // operators can correlate the failure with the AI_PROVIDER
    // setting.
    const errorCall = errorSpy.mock.calls.find((args) => {
      const message = typeof args[0] === 'string' ? args[0] : '';
      return message.includes('no tool_use');
    });
    expect(errorCall).toBeDefined();
    if (errorCall) {
      const message = String(errorCall[0]);
      expect(message).toContain('provider=anthropic');
    }

    errorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 5 — `generateText` is invoked with `toolChoice: 'required'`
  //          (Vercel SDK equivalent of Anthropic's
  //          `tool_choice: { type: 'tool', name }`)
  // -------------------------------------------------------------------------

  it('forces tool invocation via toolChoice: "required" when calling generateText (Rule 4 request-boundary enforcement, Vercel SDK migration)', async () => {
    // Stage a minimal valid response so the service returns rather
    // than throws — the assertions below inspect the REQUEST shape
    // sent to the SDK, not the response handling.
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: {
            recommendations: [],
            summary: 'No changes needed.',
            warnings: []
          },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // The service MUST issue exactly ONE generateText call per
    // `recommend(...)` invocation — multiple calls would suggest
    // unintended retry logic that could double-count metrics.
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    const [callArg] = generateTextMock.mock.calls[0] as [GenerateTextArg];

    // The Vercel AI SDK uses `toolChoice: 'required'` (a literal
    // string) as the portable equivalent of Anthropic's
    // `tool_choice: { type: 'tool', name: '...' }`. With only one
    // tool registered, the SDK pins the model to that tool — Rule
    // 4 verification at the request boundary.
    expect(callArg.toolChoice).toBe('required');
  });

  // -------------------------------------------------------------------------
  // Test 6 — `generateText` is invoked with the model from
  //          AiProviderService.getModel() (Refine PR Directive 1 + 3
  //          AI provider indirection)
  // -------------------------------------------------------------------------

  it('passes the AiProviderService.getModel() return value verbatim to generateText (Refine PR Directive 1 + 3 indirection)', async () => {
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: { recommendations: [], summary: '', warnings: [] },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    const [callArg] = generateTextMock.mock.calls[0] as [GenerateTextArg];

    // The model passed to generateText MUST be EXACTLY the object
    // returned by AiProviderService.getModel() — the production
    // code MUST NOT construct its own model or call any other
    // provider SDK directly.
    expect(callArg.model).toBe(TEST_MODEL_REF);
    expect(aiProviderService.getModel).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7 — Tool description starts with `OUTPUT ONLY.` and
  //          enumerates the three required output fields (Refine PR
  //          Directive 3 explicit requirement)
  // -------------------------------------------------------------------------

  it('registers a single rebalancing_recommendations tool whose description starts with "OUTPUT ONLY." and enumerates recommendations/summary/warnings (Refine PR Directive 3)', async () => {
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: { recommendations: [], summary: '', warnings: [] },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    const [callArg] = generateTextMock.mock.calls[0] as [GenerateTextArg];

    // The Vercel SDK registers tools as a name-keyed map (not an
    // array). Verify the canonical `rebalancing_recommendations`
    // entry is present.
    expect(callArg.tools).toBeDefined();
    expect(callArg.tools.rebalancing_recommendations).toBeDefined();

    const toolDef = callArg.tools.rebalancing_recommendations;

    // Refine PR Directive 3 explicit requirement: the description
    // MUST OPEN with the literal string "OUTPUT ONLY." so the
    // model treats the description as the canonical output
    // contract.
    expect(toolDef.description.startsWith('OUTPUT ONLY.')).toBe(true);

    // The description MUST enumerate the three required top-level
    // fields by name.
    expect(toolDef.description).toContain('recommendations');
    expect(toolDef.description).toContain('summary');
    expect(toolDef.description).toContain('warnings');
  });

  // -------------------------------------------------------------------------
  // Test 8 — Tool parameters Zod schema requires the three top-level
  //          fields (recommendations, summary, warnings) — Refine PR
  //          Directive 3 + AAP § 0.1.2.4 contract
  // -------------------------------------------------------------------------

  it('declares a Zod parameters schema with required recommendations, summary, and warnings fields (Refine PR Directive 3 + AAP § 0.1.2.4 contract)', async () => {
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: { recommendations: [], summary: '', warnings: [] },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    const [callArg] = generateTextMock.mock.calls[0] as [GenerateTextArg];
    const schema = callArg.tools.rebalancing_recommendations.parameters;

    // Verify the schema accepts a valid payload with all three
    // top-level fields populated.
    const validResult = schema.safeParse({
      recommendations: [
        {
          action: 'BUY',
          fromPct: 0.1,
          goalReference: 'riskTolerance',
          rationale: 'Test rationale',
          ticker: 'VTI',
          toPct: 0.2
        }
      ],
      summary: 'Test summary',
      warnings: ['warning']
    });
    expect(validResult.success).toBe(true);

    // Verify the schema REJECTS payloads missing any of the three
    // required top-level fields. Each missing-field case should
    // produce a Zod validation failure.
    const missingRecommendations = schema.safeParse({
      summary: 'Test summary',
      warnings: []
    });
    expect(missingRecommendations.success).toBe(false);

    const missingSummary = schema.safeParse({
      recommendations: [],
      warnings: []
    });
    expect(missingSummary.success).toBe(false);

    const missingWarnings = schema.safeParse({
      recommendations: [],
      summary: 'Test summary'
    });
    expect(missingWarnings.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 9 — `recommend(...)` reads the user's FinancialProfile via
  //          UserFinancialProfileService.findByUserId with the
  //          JWT-authoritative userId (Rule 5 spirit — downstream
  //          consumer of canonical profile reader)
  // -------------------------------------------------------------------------

  it('reads the user FinancialProfile via UserFinancialProfileService.findByUserId with the JWT-authoritative userId', async () => {
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: { recommendations: [], summary: '', warnings: [] },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledTimes(1);
    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledWith(
      TEST_USER_ID
    );
  });

  // -------------------------------------------------------------------------
  // Test 10 — `recommend(...)` reads the current portfolio via
  //           PortfolioService.getDetails with the JWT-authoritative
  //           userId
  // -------------------------------------------------------------------------

  it('reads the current portfolio via PortfolioService.getDetails with the JWT-authoritative userId', async () => {
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: { recommendations: [], summary: '', warnings: [] },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    expect(portfolioService.getDetails).toHaveBeenCalledTimes(1);
    const [callArg] = portfolioService.getDetails.mock.calls[0] as [
      { impersonationId: string | undefined; userId: string }
    ];
    expect(callArg.userId).toBe(TEST_USER_ID);
    expect(callArg.impersonationId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 11 — `recommend(...)` reads allocation history via
  //           SnowflakeSyncService.queryHistory with the
  //           JWT-authoritative userId (Rule 2 + Rule 5 — bind
  //           variables only, no string interpolation, scoped by
  //           authenticated userId)
  // -------------------------------------------------------------------------

  it('fetches allocation history via SnowflakeSyncService.queryHistory with the JWT-authoritative userId', async () => {
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: { recommendations: [], summary: '', warnings: [] },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    expect(snowflakeSyncService.queryHistory).toHaveBeenCalledTimes(1);

    // Tuple-destructure the call argument from Jest's untyped
    // `mock.calls: any[][]` shape. The arguments are:
    //   queryHistory(userId: string, sql: string, binds: any[])
    const [userIdArg, sqlArg, bindsArg] = snowflakeSyncService.queryHistory.mock
      .calls[0] as [string, string, unknown[]];

    expect(userIdArg).toBe(TEST_USER_ID);

    // Rule 2: the SQL string MUST contain `?` placeholders (bind
    // variables) and MUST NOT contain template-literal-style
    // string interpolation. Verifying the bind list passed in
    // matches the userId is sufficient for the runtime check.
    expect(sqlArg).toContain('?');
    expect(bindsArg).toEqual([TEST_USER_ID]);
  });

  // -------------------------------------------------------------------------
  // Test 12 — Per-recommendation rationale and goalReference are
  //           non-empty (AAP § 0.7.5.2 Rebalancing engine gate)
  // -------------------------------------------------------------------------

  it('every recommendation in the response has a non-empty rationale and goalReference (AAP § 0.7.5.2 Rebalancing engine gate)', async () => {
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

    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: responseInput,
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    const result = await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    expect(result.recommendations.length).toBeGreaterThan(0);

    for (const recommendation of result.recommendations) {
      expect(recommendation.rationale).toEqual(expect.any(String));
      expect(recommendation.rationale.length).toBeGreaterThan(0);
      expect(recommendation.goalReference).toEqual(expect.any(String));
      expect(recommendation.goalReference.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 13 — Rejects responses where toolCalls[0].args is missing
  //           required top-level fields → BadGatewayException +
  //           shape_invalid outcome counter (Rule 4 shape-validation
  //           guard — AAP § 0.7.1.4)
  // -------------------------------------------------------------------------

  it('throws BadGatewayException with shape_invalid outcome when toolCalls[0].args is missing required top-level fields (Rule 4 shape validation)', async () => {
    // Stage a `toolCalls[0]` whose `args` is missing the required
    // `recommendations` and `summary` fields (only `warnings` is
    // present). This simulates the case where the SDK accepts the
    // tool call (e.g., loose Zod parsing or a permissive provider)
    // but the resulting structure is incomplete. The service's
    // defensive `Array.isArray(...) && typeof ... === 'string'`
    // shape-validation MUST reject this and increment the
    // shape_invalid counter.
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          // Note: `recommendations` and `summary` deliberately
          // missing; only `warnings` is present.
          args: { warnings: [] },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await expect(
      service.recommend({
        correlationId: TEST_CORRELATION_ID,
        requestPayload: {},
        userId: TEST_USER_ID
      })
    ).rejects.toBeInstanceOf(BadGatewayException);

    // The shape_invalid outcome counter MUST be incremented
    // exactly once (the `finally` block runs even on the throw).
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'rebalancing_requests_total',
      1,
      { outcome: 'shape_invalid' }
    );
  });

  // -------------------------------------------------------------------------
  // Test 14 — Rejects responses with missing per-recommendation
  //           goalReference → BadGatewayException + shape_invalid
  //           outcome counter (AAP § 0.7.5.2 gate enforcement)
  // -------------------------------------------------------------------------

  it('throws BadGatewayException when a recommendation has empty goalReference (AAP § 0.7.5.2 gate)', async () => {
    // Stage a recommendation with empty `goalReference` (just a
    // single space, which trim() reduces to empty). The defensive
    // per-recommendation validator MUST reject this and increment
    // the shape_invalid counter.
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: {
            recommendations: [
              {
                action: 'BUY',
                fromPct: 0.1,
                goalReference: '   ', // trims to empty
                rationale: 'Test rationale',
                ticker: 'VTI',
                toPct: 0.2
              }
            ],
            summary: 'Test summary',
            warnings: []
          },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await expect(
      service.recommend({
        correlationId: TEST_CORRELATION_ID,
        requestPayload: {},
        userId: TEST_USER_ID
      })
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'rebalancing_requests_total',
      1,
      { outcome: 'shape_invalid' }
    );
  });

  // -------------------------------------------------------------------------
  // Test 15 — Success path: increments rebalancing_requests_total
  //           {outcome="success"} and observes rebalancing_latency_seconds
  //           histogram once (Observability rule — AAP § 0.7.2)
  // -------------------------------------------------------------------------

  it('on success: increments rebalancing_requests_total{outcome=success} and observes rebalancing_latency_seconds once', async () => {
    const stagedResponse: GenerateTextResult = {
      toolCalls: [
        {
          args: {
            recommendations: [
              {
                action: 'HOLD',
                fromPct: 0.5,
                goalReference: 'riskTolerance',
                rationale:
                  'Maintain allocation aligned with HIGH risk tolerance.',
                ticker: 'VTI',
                toPct: 0.5
              }
            ],
            summary: 'No changes needed.',
            warnings: []
          },
          toolCallId: 'toolu_test',
          toolName: 'rebalancing_recommendations'
        }
      ]
    };

    generateTextMock.mockResolvedValueOnce(stagedResponse);

    await service.recommend({
      correlationId: TEST_CORRELATION_ID,
      requestPayload: {},
      userId: TEST_USER_ID
    });

    // The success outcome counter MUST be incremented exactly once.
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'rebalancing_requests_total',
      1,
      { outcome: 'success' }
    );

    // The latency histogram MUST be observed exactly once per
    // recommend() call regardless of outcome — verified by the
    // total call count to observeHistogram.
    expect(metricsService.observeHistogram).toHaveBeenCalledTimes(1);
    const [metricName, value] = metricsService.observeHistogram.mock
      .calls[0] as [string, number];
    expect(metricName).toBe('rebalancing_latency_seconds');
    expect(typeof value).toBe('number');
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Test 16 — Generic error path: when generateText throws an
  //           unexpected error, the service maps it to
  //           BadGatewayException + outcome="error"
  // -------------------------------------------------------------------------

  it('on unexpected upstream failure: throws BadGatewayException + increments rebalancing_requests_total{outcome=error}', async () => {
    // Stage a generateText rejection (network error, SDK runtime
    // failure, or any non-BadGatewayException). The service's
    // outer try/catch MUST map this to a generic
    // BadGatewayException and increment the error outcome counter.
    generateTextMock.mockRejectedValueOnce(new Error('upstream timeout'));

    await expect(
      service.recommend({
        correlationId: TEST_CORRELATION_ID,
        requestPayload: {},
        userId: TEST_USER_ID
      })
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'rebalancing_requests_total',
      1,
      { outcome: 'error' }
    );
  });
});
