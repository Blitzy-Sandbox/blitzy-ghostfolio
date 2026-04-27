import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SnowflakeSyncService } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.service';
import { SymbolService } from '@ghostfolio/api/app/symbol/symbol.service';
import { UserFinancialProfileService } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.service';

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiChatService } from './ai-chat.service';

/**
 * Mocks the `@anthropic-ai/sdk` default export at module-load time so the
 * spec NEVER initiates a real network call to `api.anthropic.com`. The
 * default export is the `Anthropic` constructor used by `AiChatService`'s
 * `import Anthropic from '@anthropic-ai/sdk'` line; replacing it with
 * `jest.fn().mockImplementation(...)` returns a stub instance whose
 * `messages.stream(...)` and `messages.create(...)` are jest spies.
 *
 * The `__esModule: true` flag is required for the default-import interop
 * (`import X from 'pkg'`) — without it, ts-jest's CJS interop layer
 * resolves `Anthropic` to the entire mock object rather than its
 * `.default` property and the production-side `new Anthropic({...})` call
 * fails with "Anthropic is not a constructor".
 *
 * The mock is hoisted ABOVE the `import { AiChatService } from
 * './ai-chat.service'` line by Jest's module-mock machinery, so the
 * service-under-test sees the mocked SDK from its very first construction
 * inside `beforeEach`. No real Anthropic credentials, network egress, or
 * paid API tokens are consumed by this spec.
 */
jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn(),
        stream: jest.fn()
      }
    }))
  };
});

/**
 * Unit tests for `AiChatService` — the core service for **Feature B — AI
 * Portfolio Chat Agent** (per AAP § 0.1.1, § 0.5.1.1, § 0.5.1.5).
 *
 * Source-of-truth references (AAP):
 *   - § 0.5.1.4: explicitly enumerates the four scenarios this spec MUST
 *     cover — "tool schema completeness (all 4 tools registered),
 *     `ConfigService` reads (no `process.env`), tool dispatch routing".
 *   - § 0.7.1.3 (Rule 3 — Credential Access via ConfigService):
 *     "ANTHROPIC_API_KEY ... read EXCLUSIVELY via injected `ConfigService`.
 *     Direct `process.env.ANTHROPIC` access in new module files is
 *     PROHIBITED. ... Verification: Grep for `process.env.ANTHROPIC` ... in
 *     new module files returns zero results."
 *   - § 0.7.5.2 (Chat agent gate): "all four tools are present in the
 *     `tools` array submitted to the Anthropic SDK".
 *   - § 0.5.1.5 (security): the JWT-authenticated `userId` MUST override
 *     any `userId` Claude supplies in a tool input (regression guard
 *     against LLM-injected userId spoofing).
 *
 * Hard rules verified by this spec (per AAP § 0.7):
 *   - Rule 1 (Module Isolation) — every collaborator type imported in this
 *     file resolves through a public `exports` array of the source module
 *     (PortfolioService → PortfolioModule, SymbolService → SymbolModule,
 *     SnowflakeSyncService → SnowflakeSyncModule, UserFinancialProfileService
 *     → UserFinancialProfileModule, MetricsService → MetricsModule). No
 *     deep-relative imports into other module directories.
 *   - Rule 3 (ConfigService) — Test 1 asserts the constructor reads
 *     `ANTHROPIC_API_KEY` via the injected `ConfigService.get(...)`. Test 8
 *     asserts the source text of `ai-chat.service.ts` contains zero
 *     references to `process.env.ANTHROPIC` or `process.env.SNOWFLAKE`
 *     (the static-source-text grep is the AGENT_PROMPT-mandated
 *     authoritative Rule 3 verification).
 *   - JWT-authoritative `userId` (security regression guard) — Tests 4–6
 *     assert that the JWT-authenticated `userId` overrides any Claude-
 *     supplied `userId` in the tool input for `get_current_positions`,
 *     `get_performance_metrics`, and `query_history`.
 *
 * Test-pattern anchor:
 *   - `apps/api/src/app/portfolio/current-rate.service.spec.ts` — standard
 *     Ghostfolio NestJS spec layout with mocked collaborator services.
 *   - The agent prompt explicitly mandates `Test.createTestingModule({...
 *     }).compile()` so this spec uses the NestJS testing harness with
 *     `useValue` provider overrides (rather than direct instantiation),
 *     which gives every test a fresh, isolated DI container.
 */
describe('AiChatService', () => {
  /**
   * Stable test fixture user identifiers reused across every it(...) block.
   * Two distinct ids are needed so Tests 4–6 can verify the JWT-authoritative
   * `userId` overrides any Claude-supplied id (the "evil" id plays the role
   * of the LLM-injected attempted spoof).
   */
  const REAL_USER_ID = 'real-user-id';
  const EVIL_USER_ID = 'evil-user-id';

  /**
   * Strongly-typed shape for the `ConfigService` mock used in `useValue`
   * provider overrides. Declaring it locally lets us assert against
   * `configService.get` with full type safety in Tests 1 and 8 without
   * leaking jest internals into the production typing surface.
   */
  interface ConfigServiceMock {
    get: jest.Mock<string | undefined, [string]>;
  }

  /**
   * Strongly-typed shape for the `MetricsService` mock. Mirrors the three
   * public methods consumed by `AiChatService` constructor and runtime
   * (`registerHelp`, `incrementCounter`, `observeHistogram`). The mock
   * deliberately omits the internal Map-based registry of the real service
   * — counters and histograms accumulate as jest call records, not as
   * Prometheus exposition state. Test assertions inspect `mock.calls` to
   * verify wiring; behavioral coverage of the metrics registry is in
   * `metrics.service.spec.ts`, not here.
   */
  interface MetricsServiceMock {
    incrementCounter: jest.Mock;
    observeHistogram: jest.Mock;
    registerHelp: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `PortfolioService` mock. Exposes only the
   * three async methods consumed by `AiChatService.dispatchTool(...)` and
   * `fetchPortfolioForPrompt(...)` — `getDetails`, `getPerformance`,
   * `getHoldings`. The mock returns minimally-shaped resolved values that
   * the production code can navigate without throwing
   * `Cannot read property '...' of undefined`.
   */
  interface PortfolioServiceMock {
    getDetails: jest.Mock;
    getHoldings: jest.Mock;
    getPerformance: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `SymbolService` mock. Exposes only the
   * single async method consumed by `AiChatService.dispatchTool(...)` for
   * the `get_market_data` tool dispatch — `get`. The resolved value mimics
   * the `SymbolItem` shape (currency + marketPrice) sufficient for the
   * production code path.
   */
  interface SymbolServiceMock {
    get: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `SnowflakeSyncService` mock. Exposes only
   * the single async method consumed by `AiChatService.dispatchTool(...)`
   * for the `query_history` tool dispatch — `queryHistory`. The mock
   * returns a stub row array; the production code wraps the rows in a
   * `{ rows }` envelope before serializing them to the model.
   */
  interface SnowflakeSyncServiceMock {
    queryHistory: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `UserFinancialProfileService` mock.
   * Exposes only the single async method consumed by
   * `AiChatService.fetchProfileForPrompt(...)` for system-prompt
   * personalization — `findByUserId`. The default mock resolves to `null`
   * (no profile on file); Test 9 overrides this per-call via
   * `mockResolvedValueOnce(...)`.
   */
  interface UserFinancialProfileServiceMock {
    findByUserId: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `getDetails`/`getPerformance` argument
   * objects so Tests 4 and 5 can assert against `userId`, `impersonationId`,
   * and `dateRange` without triggering the
   * `@typescript-eslint/no-unsafe-member-access` rule. The shape is a
   * narrow projection — we only inspect the three fields that
   * `AiChatService.dispatchTool(...)` populates, not the entire
   * `PortfolioService` argument surface (filters, withSummary, etc.).
   */
  interface PortfolioCallArg {
    dateRange?: string;
    impersonationId: string | null | undefined;
    userId: string;
  }

  /**
   * Strongly-typed shape for the `SymbolService.get` argument object so
   * Test 7 can assert against `dataGatheringItem.symbol` and
   * `dataGatheringItem.dataSource` without triggering
   * `@typescript-eslint/no-unsafe-member-access`. Mirrors the relevant
   * subset of the `SymbolService.get(...)` parameter.
   */
  interface SymbolCallArg {
    dataGatheringItem: {
      dataSource: string;
      symbol: string;
    };
  }

  /**
   * Strongly-typed shape for a single tool definition returned by
   * `AiChatService.buildTools(...)`. Mirrors the relevant subset of the
   * Anthropic SDK's `Tool` type (we don't import that type to keep the
   * spec independent of any specific SDK version's typing).
   */
  interface ToolShape {
    description: string;
    input_schema: {
      properties: Record<string, unknown>;
      required?: string[];
      type: string;
    };
    name: string;
  }

  let configService: ConfigServiceMock;
  let metricsService: MetricsServiceMock;
  let portfolioService: PortfolioServiceMock;
  let service: AiChatService;
  let snowflakeSyncService: SnowflakeSyncServiceMock;
  let symbolService: SymbolServiceMock;
  let userFinancialProfileService: UserFinancialProfileServiceMock;

  beforeEach(async () => {
    /**
     * `ConfigService.get(key)` resolves a small static lookup table for the
     * two Anthropic env vars consumed by `AiChatService` — and ONLY those
     * two. Returning `undefined` for any other key surfaces accidental
     * leakage if the production code regresses to read a different env
     * var without registering it here first.
     *
     * The fake `ANTHROPIC_API_KEY` value (`'sk-test-fake-key'`) is
     * intentionally non-empty so the SDK constructor's argument-validation
     * does not reject it; the value never travels to a real API because
     * the SDK module is mocked at module-load time by the
     * `jest.mock('@anthropic-ai/sdk', ...)` block above.
     */
    const configMock: ConfigServiceMock = {
      get: jest.fn((key: string): string | undefined => {
        const map: Record<string, string> = {
          ANTHROPIC_API_KEY: 'sk-test-fake-key',
          ANTHROPIC_MODEL: 'claude-test-model'
        };
        return map[key];
      })
    };

    /**
     * `MetricsService` mock — `AiChatService.constructor` calls
     * `metricsService.registerHelp(...)` THREE times for the three chat
     * metrics (`ai_chat_streams_total`, `ai_chat_first_token_latency_seconds`,
     * `ai_chat_tool_invocations_total`). If `registerHelp` were absent, the
     * test would fail in `beforeEach` with `TypeError: ... is not a function`.
     *
     * The other two methods (`incrementCounter`, `observeHistogram`) are
     * registered here so the streaming-path tests (and any future
     * cancellation/error-path tests) do not break the mock contract —
     * even though Tests 1–9 do not exercise the streaming code path
     * directly.
     */
    const metricsMock: MetricsServiceMock = {
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn(),
      registerHelp: jest.fn()
    };

    /**
     * `PortfolioService` mock — exposes the three methods consumed by
     * `AiChatService`. The resolved values are deliberately small, valid
     * shapes so the production code can navigate them without throwing.
     *
     * `getDetails` returns `{ holdings: {}, hasErrors: false }` — an empty
     * but well-formed `PortfolioDetails`-like object. `AiChatService`
     * inspects only `holdings` (per `summarizePortfolio(...)`).
     *
     * `getPerformance` returns `{ chart: [], performance: null,
     * firstOrderDate: null }`. `AiChatService.dispatchTool(...)` consumes
     * exactly these three fields when packaging the tool result for Claude.
     *
     * `getHoldings` returns `[]` — present for completeness even though
     * the current `dispatchTool` does not call it; the spec keeps the
     * mock surface broad to absorb future refactors without breaking.
     */
    const portfolioMock: PortfolioServiceMock = {
      getDetails: jest.fn().mockResolvedValue({
        hasErrors: false,
        holdings: {}
      }),
      getHoldings: jest.fn().mockResolvedValue([]),
      getPerformance: jest.fn().mockResolvedValue({
        chart: [],
        firstOrderDate: null,
        performance: null
      })
    };

    /**
     * `SymbolService` mock — exposes `get(...)` returning a synthetic
     * `SymbolItem`-shaped object with `marketPrice` and `currency`. Test 7
     * verifies `dispatchTool({name: 'get_market_data', ...})` calls this
     * mock exactly once.
     */
    const symbolMock: SymbolServiceMock = {
      get: jest.fn().mockResolvedValue({
        currency: 'USD',
        dataSource: 'YAHOO',
        marketPrice: 100,
        symbol: 'AAPL'
      })
    };

    /**
     * `SnowflakeSyncService` mock — exposes `queryHistory(userId, sql,
     * binds)` returning a stub one-row array. Test 6 inspects `mock.calls`
     * to verify the JWT-authenticated `userId` is forwarded as the FIRST
     * positional argument (NOT the Claude-supplied `userId` from the tool
     * input — security regression guard).
     */
    const snowflakeMock: SnowflakeSyncServiceMock = {
      queryHistory: jest.fn().mockResolvedValue([{ test: 'row' }])
    };

    /**
     * `UserFinancialProfileService` mock — exposes `findByUserId(userId)`
     * returning `null` (no profile on file). Test 9 overrides this on a
     * per-call basis via `mockResolvedValueOnce({...})` to inject a stub
     * `FinancialProfile` row and verify `buildSystemPrompt(...)` includes
     * the personalized fields.
     */
    const profileMock: UserFinancialProfileServiceMock = {
      findByUserId: jest.fn().mockResolvedValue(null)
    };

    /**
     * Build the NestJS testing module per AAP § 0.5.1.4. Every
     * collaborator service is registered with `useValue` so the testing
     * module never tries to construct the real (deeply-dependency-laden)
     * services. `module.get(...)` returns the original mock object
     * reference, which lets the tests assert against the same `jest.fn()`
     * spies that were injected into `AiChatService`.
     *
     * The `compile()` returns a Promise that resolves once the testing
     * module's DI container is initialized — matching the precedent in
     * `apps/api/src/app/portfolio/current-rate.service.spec.ts`.
     */
    const testingModule: TestingModule = await Test.createTestingModule({
      providers: [
        AiChatService,
        { provide: ConfigService, useValue: configMock },
        { provide: MetricsService, useValue: metricsMock },
        { provide: PortfolioService, useValue: portfolioMock },
        { provide: SnowflakeSyncService, useValue: snowflakeMock },
        { provide: SymbolService, useValue: symbolMock },
        {
          provide: UserFinancialProfileService,
          useValue: profileMock
        }
      ]
    }).compile();

    service = testingModule.get(AiChatService);
    configService = testingModule.get(ConfigService);
    metricsService = testingModule.get(MetricsService);
    portfolioService = testingModule.get(PortfolioService);
    snowflakeSyncService = testingModule.get(SnowflakeSyncService);
    symbolService = testingModule.get(SymbolService);
    userFinancialProfileService = testingModule.get(
      UserFinancialProfileService
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — Constructor reads ANTHROPIC_API_KEY through ConfigService
  //          (Rule 3 — AAP § 0.7.1.3)
  // -------------------------------------------------------------------------

  it('reads ANTHROPIC_API_KEY from the injected ConfigService at construction time (AAP § 0.7.1.3 Rule 3)', () => {
    // Sanity: the service was instantiated by `beforeEach` above. The
    // assertion verifies that during construction `configService.get`
    // received the canonical key — which is the ONLY way `AiChatService`
    // is permitted to source the Anthropic credential per Rule 3.
    expect(service).toBeDefined();
    expect(configService.get).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  it('reads ANTHROPIC_MODEL from the injected ConfigService at construction time (AAP § 0.7.3 model override)', () => {
    // AAP § 0.7.3 stipulates that the Claude model id MUST be overridable
    // via `ConfigService`-readable `ANTHROPIC_MODEL`. Verifying the
    // construction-time read prevents a regression that hardcodes a
    // specific model id in source.
    expect(configService.get).toHaveBeenCalledWith('ANTHROPIC_MODEL');
  });

  it('registers help text for the three chat metrics during construction (AAP § 0.7.2 Observability)', () => {
    // AAP § 0.7.2 mandates the chat agent emit metrics with `# HELP`
    // descriptions. The constructor calls `registerHelp(...)` exactly
    // three times — one per chat metric. Verifying this here guards
    // against a regression that drops the wiring to the metrics
    // registry, which would otherwise silently produce metrics output
    // missing its human-readable descriptions.
    expect(metricsService.registerHelp).toHaveBeenCalledTimes(3);
    const registeredNames: string[] =
      metricsService.registerHelp.mock.calls.map(
        (call: unknown[]) => call[0] as string
      );
    expect(registeredNames).toEqual(
      expect.arrayContaining([
        'ai_chat_streams_total',
        'ai_chat_first_token_latency_seconds',
        'ai_chat_tool_invocations_total'
      ])
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — buildTools() returns ALL four tool schemas
  //          (AAP § 0.5.1.5 + § 0.7.5.2 Chat agent gate)
  // -------------------------------------------------------------------------

  it('exposes exactly the four required tools: get_current_positions, get_performance_metrics, query_history, get_market_data (AAP § 0.7.5.2)', () => {
    // `buildTools` is `private` per the production source — the
    // (service as any) double-cast is the standard Jest idiom for
    // exercising a private method in a unit test without forcing the
    // method to be made public solely for testability.
    const tools = (
      service as unknown as { buildTools: () => { name: string }[] }
    ).buildTools();

    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(4);

    const names = tools.map((tool) => tool.name);
    expect(names).toContain('get_current_positions');
    expect(names).toContain('get_performance_metrics');
    expect(names).toContain('query_history');
    expect(names).toContain('get_market_data');
  });

  // -------------------------------------------------------------------------
  // Test 3 — Each tool has a valid JSON-schema input definition
  // -------------------------------------------------------------------------

  it('every tool has a non-empty input_schema, description, and properties block', () => {
    const tools = (
      service as unknown as { buildTools: () => ToolShape[] }
    ).buildTools();

    for (const tool of tools) {
      // Anthropic's `tools` API requires `name` and `description` to be
      // non-empty strings; an empty description weakens the model's
      // tool-selection accuracy. The `expect.any(String)` matcher pairs
      // with a `length > 0` length check to enforce both.
      expect(tool.name).toEqual(expect.any(String));
      expect(tool.name.length).toBeGreaterThan(0);

      expect(tool.description).toEqual(expect.any(String));
      expect(tool.description.length).toBeGreaterThan(0);

      // `input_schema` MUST be a JSON-Schema-shaped object with
      // `type: 'object'` per Anthropic's tool-definition contract.
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
      expect(typeof tool.input_schema.properties).toBe('object');
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 — dispatchTool routes get_current_positions to
  //          PortfolioService.getDetails with the JWT userId
  //          (security regression guard against LLM-injected userId spoof)
  // -------------------------------------------------------------------------

  it('routes get_current_positions tool calls to PortfolioService.getDetails with the JWT-authenticated userId, NOT the Claude-supplied one (AAP § 0.5.1.5)', async () => {
    // The Claude-supplied `userId: EVIL_USER_ID` is the regression-guard
    // fixture: if `dispatchTool` ever forwards it instead of substituting
    // `authenticatedUserId`, this test fails immediately. The check is
    // the ONLY way to detect a future regression that lets the LLM act
    // on behalf of a different Ghostfolio user.
    await (
      service as unknown as {
        dispatchTool: (args: {
          authenticatedUserId: string;
          input: unknown;
          name: string;
        }) => Promise<unknown>;
      }
    ).dispatchTool({
      authenticatedUserId: REAL_USER_ID,
      input: { userId: EVIL_USER_ID },
      name: 'get_current_positions'
    });

    expect(portfolioService.getDetails).toHaveBeenCalledTimes(1);

    // The single argument is the destructured options object passed to
    // `portfolioService.getDetails({impersonationId, userId, ...})`. The
    // `userId` field MUST equal the authenticated value (Rule 5 / AAP
    // § 0.5.1.5), and the `impersonationId` MUST be `undefined` (the
    // controller is not impersonating any other user, mirroring the
    // existing controller pattern when no `x-impersonation-id` header is
    // sent — QA Checkpoint 9 CRITICAL #1 follow-on standardized
    // `null` → `undefined` to avoid Prisma 7 rejection on
    // `Access.id` non-nullable column).
    //
    // The tuple-destructure pattern (`const [callArg] = ... as [Type]`)
    // is preferred over `mock.calls[0][0] as Type` because it preserves
    // strict typing through the destructuring binding rather than
    // double-indexing into Jest's untyped `mock.calls: any[][]` shape.
    const [callArg] = portfolioService.getDetails.mock.calls[0] as [
      PortfolioCallArg
    ];
    expect(callArg.userId).toBe(REAL_USER_ID);
    expect(callArg.userId).not.toBe(EVIL_USER_ID);
    expect(callArg.impersonationId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 5 — dispatchTool routes get_performance_metrics to
  //          PortfolioService.getPerformance with the JWT userId
  // -------------------------------------------------------------------------

  it('routes get_performance_metrics tool calls to PortfolioService.getPerformance with the JWT-authenticated userId (AAP § 0.5.1.5)', async () => {
    await (
      service as unknown as {
        dispatchTool: (args: {
          authenticatedUserId: string;
          input: unknown;
          name: string;
        }) => Promise<unknown>;
      }
    ).dispatchTool({
      authenticatedUserId: REAL_USER_ID,
      input: {
        endDate: '2024-12-31',
        startDate: '2024-01-01',
        userId: EVIL_USER_ID
      },
      name: 'get_performance_metrics'
    });

    expect(portfolioService.getPerformance).toHaveBeenCalledTimes(1);

    const [callArg] = portfolioService.getPerformance.mock.calls[0] as [
      PortfolioCallArg
    ];
    expect(callArg.userId).toBe(REAL_USER_ID);
    expect(callArg.userId).not.toBe(EVIL_USER_ID);
    // `impersonationId: undefined` — see Test 4 commentary for the
    // QA Checkpoint 9 CRITICAL #1 follow-on rationale.
    expect(callArg.impersonationId).toBeUndefined();

    // Sanity: the production code maps the LLM-supplied date strings to
    // a `DateRange` enum value; for a 365-day window (2024-01-01 →
    // 2024-12-31) the mapping resolves to `'1y'` per the documented
    // `mapDatesToDateRange` lookup table. Asserting on the dateRange
    // confirms the date-handling code path executed without forcing the
    // test to commit to a specific enum bucket boundary.
    expect(callArg.dateRange).toEqual(expect.any(String));
    expect((callArg.dateRange ?? '').length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 6 — dispatchTool routes query_history to
  //          SnowflakeSyncService.queryHistory with the JWT userId
  //          (security regression guard) and forwards the SQL/binds
  //          verbatim
  // -------------------------------------------------------------------------

  it('routes query_history tool calls to SnowflakeSyncService.queryHistory with the JWT-authenticated userId and forwards binds verbatim (AAP § 0.5.1.5 + Rule 2)', async () => {
    const sql = 'SELECT 1 FROM portfolio_snapshots WHERE user_id = ?';
    const claudeBinds: (string | number | boolean | null)[] = [
      'hacker-id',
      42,
      true,
      null
    ];

    await (
      service as unknown as {
        dispatchTool: (args: {
          authenticatedUserId: string;
          input: unknown;
          name: string;
        }) => Promise<unknown>;
      }
    ).dispatchTool({
      authenticatedUserId: REAL_USER_ID,
      input: {
        binds: claudeBinds,
        sql,
        userId: EVIL_USER_ID
      },
      name: 'query_history'
    });

    expect(snowflakeSyncService.queryHistory).toHaveBeenCalledTimes(1);

    // `queryHistory(userId, sql, binds)` is positional — the first
    // argument MUST be the JWT-authenticated user id (NOT the Claude-
    // supplied one — security regression guard against LLM-injected
    // userId spoofing).
    const [calledUserId, calledSql, calledBinds] = snowflakeSyncService
      .queryHistory.mock.calls[0] as [string, string, unknown[]];

    expect(calledUserId).toBe(REAL_USER_ID);
    expect(calledUserId).not.toBe(EVIL_USER_ID);

    // `sql` is forwarded verbatim — the service does NOT mutate or
    // re-parse it before handing it to the snowflake-sdk driver. Any
    // sanitization (e.g. `;` rejection) is performed by
    // `SnowflakeSyncService.queryHistory(...)` itself, NOT by the chat
    // agent's dispatcher.
    expect(calledSql).toBe(sql);

    // `binds` is forwarded as an array. The production code narrows
    // each entry to the `string | number | boolean | null` union, so
    // the array length MUST match the input (no entries are silently
    // dropped).
    expect(Array.isArray(calledBinds)).toBe(true);
    expect(calledBinds).toHaveLength(claudeBinds.length);
  });

  it('coerces non-array binds to an empty array on query_history dispatch (defensive narrowing)', async () => {
    // The production code defensively narrows `args.binds` to `[]`
    // when the LLM-supplied value is not an array — this prevents a
    // runtime error inside the snowflake-sdk driver's bind iteration.
    // The test verifies that defensive path exists by passing a non-
    // array `binds` and asserting the dispatcher still calls
    // `queryHistory` (i.e. did not throw at the type narrowing).
    await (
      service as unknown as {
        dispatchTool: (args: {
          authenticatedUserId: string;
          input: unknown;
          name: string;
        }) => Promise<unknown>;
      }
    ).dispatchTool({
      authenticatedUserId: REAL_USER_ID,
      input: {
        binds: 'not-an-array',
        sql: 'SELECT 1',
        userId: EVIL_USER_ID
      },
      name: 'query_history'
    });

    expect(snowflakeSyncService.queryHistory).toHaveBeenCalledTimes(1);
    const [, , calledBinds] = snowflakeSyncService.queryHistory.mock
      .calls[0] as [string, string, unknown[]];
    expect(Array.isArray(calledBinds)).toBe(true);
    expect(calledBinds).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 7 — dispatchTool routes get_market_data to SymbolService.get
  // -------------------------------------------------------------------------

  it('routes get_market_data tool calls to SymbolService.get with the Claude-supplied ticker', async () => {
    await (
      service as unknown as {
        dispatchTool: (args: {
          authenticatedUserId: string;
          input: unknown;
          name: string;
        }) => Promise<unknown>;
      }
    ).dispatchTool({
      authenticatedUserId: REAL_USER_ID,
      input: { ticker: 'AAPL' },
      name: 'get_market_data'
    });

    expect(symbolService.get).toHaveBeenCalledTimes(1);

    // Sanity: `SymbolService.get` accepts a `dataGatheringItem` envelope
    // — the production dispatcher hardcodes `dataSource: DataSource.YAHOO`
    // (server-controlled per AAP § 0.5.1.5) and passes the ticker through.
    const [callArg] = symbolService.get.mock.calls[0] as [SymbolCallArg];
    expect(callArg).toBeDefined();
    expect(callArg.dataGatheringItem).toBeDefined();
    expect(callArg.dataGatheringItem.symbol).toBe('AAPL');
    expect(callArg.dataGatheringItem.dataSource).toBe('YAHOO');
  });

  it('rejects get_market_data dispatch with an empty ticker (defensive validation)', async () => {
    // The production code throws `Error('get_market_data: ticker must
    // be a non-empty string')` when `args.ticker` is empty. Asserting
    // the rejection here guards against a regression that silently
    // calls SymbolService with an empty symbol — the data provider
    // would respond with a 400 in that case, which the chat agent
    // would surface as an `is_error` tool result; the production code
    // surfaces a clear error message instead by validating early.
    const dispatch = (
      service as unknown as {
        dispatchTool: (args: {
          authenticatedUserId: string;
          input: unknown;
          name: string;
        }) => Promise<unknown>;
      }
    ).dispatchTool;

    await expect(
      dispatch({
        authenticatedUserId: REAL_USER_ID,
        input: { ticker: '' },
        name: 'get_market_data'
      })
    ).rejects.toThrow(/ticker/);
  });

  it('rejects unknown tool names (defensive validation)', async () => {
    // A future regression that adds a new tool but forgets the
    // dispatcher's switch case would otherwise silently no-op. The
    // production code throws `Error('Unknown tool: <name>')` to
    // surface the misconfiguration loudly.
    const dispatch = (
      service as unknown as {
        dispatchTool: (args: {
          authenticatedUserId: string;
          input: unknown;
          name: string;
        }) => Promise<unknown>;
      }
    ).dispatchTool;

    await expect(
      dispatch({
        authenticatedUserId: REAL_USER_ID,
        input: {},
        name: 'no_such_tool'
      })
    ).rejects.toThrow(/Unknown tool/);
  });

  // -------------------------------------------------------------------------
  // Test 8 — Source code does NOT contain process.env.ANTHROPIC or
  //          process.env.SNOWFLAKE references (Rule 3 source-text grep)
  // -------------------------------------------------------------------------

  it('the AiChatService source file contains zero process.env.ANTHROPIC or process.env.SNOWFLAKE references (AAP § 0.7.1.3 Rule 3 grep)', () => {
    // The agent_prompt's authoritative Rule 3 verification: read the
    // sibling file's source text and assert via regex that it never
    // contains the prohibited `process.env.ANTHROPIC*` or
    // `process.env.SNOWFLAKE*` accessors. The `process.env`-getter-spy
    // alternative is documented as unreliable because Node's `process`
    // global is host-managed and not always trapper-friendly across
    // runtimes — the static-source-text grep is the more reliable
    // guard and is what the agent_prompt mandates.
    //
    // `__dirname` resolves to the absolute path of THIS spec file's
    // directory (apps/api/src/app/ai-chat). The sibling source file is
    // co-located, so `join(__dirname, 'ai-chat.service.ts')` always
    // resolves to the right path regardless of where Jest is invoked
    // from (root, monorepo, container, CI, etc).
    const sourcePath = join(__dirname, 'ai-chat.service.ts');
    const source = readFileSync(sourcePath, 'utf8');

    // Rule 3: NO `process.env.ANTHROPIC*` accessor anywhere in the
    // source. The regex is `process.env.ANTHROPIC` (no `\b` boundary
    // because variable names ending the accessor — e.g.
    // `ANTHROPIC_API_KEY` — are caught by the unanchored prefix match).
    expect(source).not.toMatch(/process\.env\.ANTHROPIC/);

    // Rule 3 (extended): NO `process.env.SNOWFLAKE*` accessor either.
    // Even though `AiChatService` only reads `ANTHROPIC_*` directly,
    // the AAP § 0.7.5.2 "Security sweep gate" requires both prefixes
    // be absent across every new module file. The `query_history`
    // tool dispatch consumes `SnowflakeSyncService.queryHistory(...)`,
    // which itself reads SNOWFLAKE_* via ConfigService — but the chat
    // service must not reference those env vars directly either.
    expect(source).not.toMatch(/process\.env\.SNOWFLAKE/);

    // Defensive sanity: the `process.env.ANTHROPIC_API_KEY` pattern
    // (the most likely accidental regression) is also explicitly
    // forbidden. The first regex above catches it, but the redundant
    // assertion makes the test failure message clearer if a regression
    // adds that exact accessor.
    expect(source).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
  });

  // -------------------------------------------------------------------------
  // Test 9 — System-prompt personalization (optional, FinancialProfile)
  // -------------------------------------------------------------------------

  it('includes FinancialProfile data in the system prompt when present (AAP § 0.5.1.1 personalization)', async () => {
    // Override the default `findByUserId(...) → null` mock with a
    // single-call stub that returns a valid `FinancialProfile`-shaped
    // object. The system-prompt builder consumes only five fields
    // (riskTolerance, retirementTargetAge, retirementTargetAmount,
    // timeHorizonYears, investmentGoals); the `userId` and timestamps
    // are irrelevant to the rendered prompt and are present here only
    // to satisfy the typed `FinancialProfile` Prisma model.
    userFinancialProfileService.findByUserId.mockResolvedValueOnce({
      createdAt: new Date(),
      investmentGoals: [],
      monthlyDebtObligations: 2000,
      monthlyIncome: 10000,
      retirementTargetAge: 65,
      retirementTargetAmount: 1_000_000,
      riskTolerance: 'HIGH',
      timeHorizonYears: 25,
      updatedAt: new Date(),
      userId: REAL_USER_ID
    });

    const systemPrompt = await (
      service as unknown as {
        buildSystemPrompt: (userId: string) => Promise<string>;
      }
    ).buildSystemPrompt(REAL_USER_ID);

    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt.length).toBeGreaterThan(0);

    // The `riskTolerance` value MUST appear verbatim in the prompt —
    // it is the most actionable single signal for goal-oriented
    // financial advice.
    expect(systemPrompt).toContain('HIGH');

    // The `retirementTargetAge` value MUST appear in the prompt.
    expect(systemPrompt).toContain('65');

    // Sanity: the `findByUserId` mock was called exactly once with
    // the JWT-authenticated user id supplied to `buildSystemPrompt`.
    expect(userFinancialProfileService.findByUserId).toHaveBeenCalledWith(
      REAL_USER_ID
    );
  });

  it('renders a placeholder when no FinancialProfile is on file (graceful fallback)', async () => {
    // The default mock resolves to `null` (set in `beforeEach`). The
    // production code MUST render a graceful placeholder string
    // (rather than throw or embed `null`/`undefined`) so the chat
    // experience is uninterrupted for first-time users without a
    // profile.
    const systemPrompt = await (
      service as unknown as {
        buildSystemPrompt: (userId: string) => Promise<string>;
      }
    ).buildSystemPrompt(REAL_USER_ID);

    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt.length).toBeGreaterThan(0);

    // The portfolio personalization section heading is present
    // regardless of profile state — it confirms the system-prompt
    // skeleton renders even when both downstream calls return null.
    expect(systemPrompt).toContain('# Current Portfolio');
    expect(systemPrompt).toContain('# User Financial Profile');
  });

  // -------------------------------------------------------------------------
  // Test 10 — PII minimization: the JWT-authenticated user id NEVER
  //           appears in the rendered system prompt (AAP § 0.7.3)
  // -------------------------------------------------------------------------

  it('does NOT embed the literal JWT-authenticated userId in the rendered system prompt (AAP § 0.7.3 PII minimization)', async () => {
    // AAP § 0.7.3 mandates that the user's literal Ghostfolio user id
    // is NEVER transmitted to Anthropic on every chat request. The
    // production code substitutes a placeholder constant (the documented
    // `<authenticated-user>` token) into the prompt; `dispatchTool(...)`
    // then substitutes the JWT-authenticated id at dispatch time. This
    // test guards against a regression that re-embeds the literal
    // `userId` into the prompt body.
    const systemPrompt = await (
      service as unknown as {
        buildSystemPrompt: (userId: string) => Promise<string>;
      }
    ).buildSystemPrompt(REAL_USER_ID);

    expect(systemPrompt).not.toContain(REAL_USER_ID);
    expect(systemPrompt).toContain('<authenticated-user>');
  });
});
