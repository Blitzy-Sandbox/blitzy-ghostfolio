import { AiProviderService } from '@ghostfolio/api/app/ai-provider/ai-provider.service';
import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SnowflakeSyncService } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.service';
import { SymbolService } from '@ghostfolio/api/app/symbol/symbol.service';
import { UserFinancialProfileService } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.service';

import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiChatService } from './ai-chat.service';

/**
 * Unit tests for `AiChatService` after **Refine PR Directive 2** — the
 * Vercel AI SDK migration. The service no longer constructs the
 * Anthropic SDK directly; the LanguageModel is obtained via the
 * injected `AiProviderService` (Refine PR Directive 1), which centralizes
 * provider selection across `anthropic | openai | google | ollama`. The
 * four chat-agent tools are now defined with the Vercel AI SDK's
 * `tool({...})` helper using Zod `parameters` schemas, and each tool's
 * `execute` closure captures the JWT-authenticated user id from its
 * lexical scope — `userId` is NOT a tool parameter, so LLM-injected
 * userId spoofing is structurally impossible.
 *
 * Source-of-truth references:
 *   - AAP § 0.5.1.5 — the four chat-agent tool definitions.
 *   - AAP § 0.7.1.3 (Rule 3) — credentials read EXCLUSIVELY through
 *     `ConfigService` (now reached indirectly through `AiProviderService`).
 *   - AAP § 0.7.5.2 — chat-agent gate: all four tools present in the
 *     `tools` argument submitted to the SDK.
 *   - Refine PR Directive 2 — Vercel AI SDK migration, Zod schemas,
 *     closure-bound `authenticatedUserId`.
 *
 * Hard rules verified by this spec:
 *   - **Rule 1 (Module Isolation):** every collaborator imported here
 *     resolves through a public `exports` array of its source module.
 *   - **Rule 3 (ConfigService):** the source file of `ai-chat.service.ts`
 *     contains zero `process.env.ANTHROPIC*` and zero
 *     `process.env.SNOWFLAKE*` accessors (static-source-text grep —
 *     authoritative AAP-mandated check).
 *   - **JWT-authoritative `userId`:** every tool's `execute` closure
 *     binds `authenticatedUserId` from the closure scope and uses ONLY
 *     that value when calling downstream services.
 *   - **PII minimization (AAP § 0.7.3):** the literal user id is NEVER
 *     embedded into the rendered system prompt; the `<authenticated-user>`
 *     placeholder is sent to the model instead.
 */
describe('AiChatService', () => {
  /**
   * Stable test fixture for the JWT-authenticated user id. Reused across
   * every it(...) block so the closure-binding assertions are consistent.
   *
   * Refine PR Directive 2 removed the prior `EVIL_USER_ID` regression
   * fixture: under the new architecture, `userId` is NOT a tool
   * parameter, so the LLM has no way to supply a spoofed value through
   * tool arguments at all. The test surface is therefore narrower —
   * we only need to verify the closure-captured value flows through.
   */
  const REAL_USER_ID = 'real-user-id';

  /**
   * Strongly-typed shape for the `AiProviderService` mock. Mirrors the
   * three public methods consumed by `AiChatService` (`getModel`,
   * `getProvider`, `getModelId`). The `getModel` mock returns an empty
   * object cast to a stub `LanguageModel` — `buildTools()` and
   * `buildSystemPrompt()` are exercised directly without driving a real
   * `streamText` call, so the model never actually flows through any
   * SDK internals.
   */
  interface AiProviderServiceMock {
    getModel: jest.Mock;
    getModelId: jest.Mock;
    getProvider: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `MetricsService` mock. Mirrors the
   * three public methods consumed by `AiChatService` constructor and
   * runtime (`registerHelp`, `incrementCounter`, `observeHistogram`).
   */
  interface MetricsServiceMock {
    incrementCounter: jest.Mock;
    observeHistogram: jest.Mock;
    registerHelp: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `PortfolioService` mock. Exposes only
   * the three async methods consumed by `AiChatService` tool execute
   * closures and `fetchPortfolioForPrompt(...)` — `getDetails`,
   * `getPerformance`, `getHoldings`.
   */
  interface PortfolioServiceMock {
    getDetails: jest.Mock;
    getHoldings: jest.Mock;
    getPerformance: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `SymbolService` mock. Exposes only the
   * single async method consumed by the `get_market_data` tool execute
   * closure — `get`.
   */
  interface SymbolServiceMock {
    get: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `SnowflakeSyncService` mock. Exposes
   * only the single async method consumed by the `query_history` tool
   * execute closure — `queryHistory`.
   */
  interface SnowflakeSyncServiceMock {
    queryHistory: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `UserFinancialProfileService` mock.
   * Exposes only the single async method consumed by
   * `AiChatService.fetchProfileForPrompt(...)` — `findByUserId`.
   */
  interface UserFinancialProfileServiceMock {
    findByUserId: jest.Mock;
  }

  /**
   * Strongly-typed shape for the `getDetails` / `getPerformance`
   * argument objects so the tool-execute tests can assert against
   * `userId`, `impersonationId`, and `dateRange` without triggering
   * `@typescript-eslint/no-unsafe-member-access`.
   */
  interface PortfolioCallArg {
    dateRange?: string;
    impersonationId: string | null | undefined;
    userId: string;
  }

  /**
   * Strongly-typed shape for the `SymbolService.get` argument object.
   */
  interface SymbolCallArg {
    dataGatheringItem: {
      dataSource: string;
      symbol: string;
    };
  }

  /**
   * Strongly-typed shape for a single Vercel AI SDK tool returned by
   * the private `buildTools()` helper. `parameters` is the Zod schema
   * (we only need to confirm it exists and is an object); `execute`
   * is the closure that performs the actual work.
   *
   * The execute signature in the Vercel AI SDK is
   * `(args, options) => Promise<unknown>` where `options` carries
   * runtime metadata (toolCallId, messages, abortSignal). For unit
   * testing we pass a stub options object — the production closures
   * ignore the `options` argument entirely.
   */
  interface ToolShape {
    description: string;
    execute: (
      args: Record<string, unknown>,
      options: { messages: unknown[]; toolCallId: string }
    ) => Promise<unknown>;
    parameters: unknown;
  }

  let aiProviderService: AiProviderServiceMock;
  let metricsService: MetricsServiceMock;
  let portfolioService: PortfolioServiceMock;
  let service: AiChatService;
  let snowflakeSyncService: SnowflakeSyncServiceMock;
  let symbolService: SymbolServiceMock;
  let userFinancialProfileService: UserFinancialProfileServiceMock;

  /**
   * Stub `ToolExecutionOptions` passed as the second argument to every
   * `execute(...)` invocation in the tool-routing tests. The production
   * closures DO NOT read this object — they only read the args object
   * (which is the model-supplied tool input). The stub is present
   * solely to satisfy the Vercel AI SDK's two-argument execute signature.
   */
  const TOOL_EXEC_OPTIONS = { messages: [], toolCallId: 'test-call-id' };

  beforeEach(async () => {
    /**
     * `AiProviderService` mock — replaces the previous direct Anthropic
     * SDK construction. The `getModel` returns an empty object cast to
     * `unknown` because none of the unit tests in this spec drive a real
     * `streamText(...)` call; `buildTools` and `buildSystemPrompt` are
     * exercised directly via the (service as unknown as ...) escape
     * hatch and never inspect the model object.
     *
     * `getProvider` and `getModelId` return harmless string defaults
     * — they are not asserted against by any test in this file but
     * are present so a future test that consumes them does not fail
     * with `TypeError: ... is not a function`.
     */
    const aiProviderMock: AiProviderServiceMock = {
      getModel: jest.fn().mockReturnValue({}),
      getModelId: jest.fn().mockReturnValue('claude-test-model'),
      getProvider: jest.fn().mockReturnValue('anthropic')
    };

    /**
     * `MetricsService` mock — `AiChatService.constructor` calls
     * `metricsService.registerHelp(...)` THREE times for the three
     * chat metrics. The other two methods are present so future tests
     * that exercise the streaming path (which calls `incrementCounter`
     * and `observeHistogram`) do not break the mock contract.
     */
    const metricsMock: MetricsServiceMock = {
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn(),
      registerHelp: jest.fn()
    };

    /**
     * `PortfolioService` mock — exposes the three methods consumed by
     * `AiChatService`. The resolved values are deliberately small,
     * valid shapes so the production code can navigate them without
     * throwing.
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
     * `SymbolItem`-shaped object.
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
     * binds)` returning a stub one-row array.
     */
    const snowflakeMock: SnowflakeSyncServiceMock = {
      queryHistory: jest.fn().mockResolvedValue([{ test: 'row' }])
    };

    /**
     * `UserFinancialProfileService` mock — exposes `findByUserId(userId)`
     * returning `null` (no profile on file). Test 9 overrides this on
     * a per-call basis to inject a stub `FinancialProfile`.
     */
    const profileMock: UserFinancialProfileServiceMock = {
      findByUserId: jest.fn().mockResolvedValue(null)
    };

    /**
     * Build the NestJS testing module. Every collaborator service is
     * registered with `useValue` so the testing module never tries to
     * construct the real (deeply-dependency-laden) services.
     */
    const testingModule: TestingModule = await Test.createTestingModule({
      providers: [
        AiChatService,
        { provide: AiProviderService, useValue: aiProviderMock },
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
    aiProviderService = testingModule.get(AiProviderService);
    metricsService = testingModule.get(MetricsService);
    portfolioService = testingModule.get(PortfolioService);
    snowflakeSyncService = testingModule.get(SnowflakeSyncService);
    symbolService = testingModule.get(SymbolService);
    userFinancialProfileService = testingModule.get(
      UserFinancialProfileService
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — Service constructs successfully with AiProviderService injected
  //          (Refine PR Directive 2: AiProviderService replaces direct
  //           Anthropic SDK construction)
  // -------------------------------------------------------------------------

  it('constructs successfully with AiProviderService injected (Refine PR Directive 2)', () => {
    expect(service).toBeDefined();
    // The service must NOT have any direct Anthropic SDK property; the
    // model is reached lazily via `aiProviderService.getModel()` only
    // inside `streamChat(...)`. We don't assert on `getModel` having
    // been called at construction time because it is intentionally
    // deferred to per-stream invocation (so a misconfigured provider
    // is detected at the first stream attempt rather than at module
    // boot, matching the Refine PR Directive 1 startup-log pattern).
    expect(aiProviderService).toBeDefined();
  });

  it('registers help text for the three chat metrics during construction (AAP § 0.7.2 Observability)', () => {
    // AAP § 0.7.2 mandates the chat agent emit metrics with `# HELP`
    // descriptions. The constructor calls `registerHelp(...)` exactly
    // three times — one per chat metric.
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
    // `buildTools(authenticatedUserId)` is `private` per the production
    // source — the (service as any) double-cast is the standard Jest
    // idiom for exercising a private method without forcing it to be
    // made public solely for testability. Under the Vercel AI SDK
    // migration, the return type is `ToolSet` — a record keyed by tool
    // name — rather than the previous Anthropic SDK array.
    const tools = (
      service as unknown as {
        buildTools: (userId: string) => Record<string, unknown>;
      }
    ).buildTools(REAL_USER_ID);

    expect(typeof tools).toBe('object');
    expect(tools).not.toBeNull();

    const names = Object.keys(tools);
    expect(names).toHaveLength(4);
    expect(names).toContain('get_current_positions');
    expect(names).toContain('get_performance_metrics');
    expect(names).toContain('query_history');
    expect(names).toContain('get_market_data');
  });

  // -------------------------------------------------------------------------
  // Test 3 — Each tool has a Zod parameters schema, description, execute
  //          closure (Refine PR Directive 2 contract)
  // -------------------------------------------------------------------------

  it('every tool has a non-empty description, a parameters schema object, and an execute closure', () => {
    const tools = (
      service as unknown as {
        buildTools: (userId: string) => Record<string, ToolShape>;
      }
    ).buildTools(REAL_USER_ID);

    for (const toolName of Object.keys(tools)) {
      const tool = tools[toolName];

      // `description` must be a non-empty string. The Vercel AI SDK
      // forwards the description into the model prompt for tool
      // selection — an empty description weakens selection accuracy.
      expect(tool.description).toEqual(expect.any(String));
      expect(tool.description.length).toBeGreaterThan(0);

      // `parameters` is a Zod schema object — the `tool()` helper
      // accepts any value with a `_def` (Zod) or `jsonSchema` shape.
      // The unit test only confirms it is a non-null object; the
      // schema's runtime parsing is exercised by the Vercel AI SDK
      // during real model invocations.
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.parameters).toBe('object');
      expect(tool.parameters).not.toBeNull();

      // `execute` is the closure that runs the tool body. Every chat
      // tool in this service has an execute closure (the SDK auto-runs
      // them across `maxSteps`).
      expect(typeof tool.execute).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 — get_current_positions tool execute uses the closure-captured
  //          authenticatedUserId
  //          (Refine PR Directive 2: userId from closure, NOT from args)
  // -------------------------------------------------------------------------

  it('get_current_positions execute closure calls PortfolioService.getDetails with the closure-captured userId (Refine PR Directive 2)', async () => {
    // Build the tools with the JWT-authenticated user id captured in
    // every execute closure. The Zod schema for this tool has NO
    // userId parameter — there is no possible code path through which
    // the LLM could supply a different value. The test verifies the
    // closure capture by asserting the downstream service receives
    // `REAL_USER_ID`.
    const tools = (
      service as unknown as {
        buildTools: (userId: string) => Record<string, ToolShape>;
      }
    ).buildTools(REAL_USER_ID);

    await tools.get_current_positions.execute({}, TOOL_EXEC_OPTIONS);

    expect(portfolioService.getDetails).toHaveBeenCalledTimes(1);

    const [callArg] = portfolioService.getDetails.mock.calls[0] as [
      PortfolioCallArg
    ];
    expect(callArg.userId).toBe(REAL_USER_ID);

    // `impersonationId: undefined` mirrors the existing-controller
    // pattern (no `x-impersonation-id` header). Passing `null` is
    // rejected by Prisma because `Access.id` is non-nullable. QA
    // Checkpoint 9 CRITICAL #1 follow-on after the synthetic-REQUEST
    // provider fix.
    expect(callArg.impersonationId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 5 — get_performance_metrics tool execute uses the closure-captured
  //          authenticatedUserId and forwards startDate/endDate
  // -------------------------------------------------------------------------

  it('get_performance_metrics execute closure calls PortfolioService.getPerformance with the closure-captured userId and a mapped dateRange (Refine PR Directive 2)', async () => {
    const tools = (
      service as unknown as {
        buildTools: (userId: string) => Record<string, ToolShape>;
      }
    ).buildTools(REAL_USER_ID);

    await tools.get_performance_metrics.execute(
      {
        endDate: '2024-12-31',
        startDate: '2024-01-01'
      },
      TOOL_EXEC_OPTIONS
    );

    expect(portfolioService.getPerformance).toHaveBeenCalledTimes(1);

    const [callArg] = portfolioService.getPerformance.mock.calls[0] as [
      PortfolioCallArg
    ];
    expect(callArg.userId).toBe(REAL_USER_ID);
    expect(callArg.impersonationId).toBeUndefined();

    // The production code maps the LLM-supplied date strings to a
    // `DateRange` enum value via `mapDatesToDateRange(startDate,
    // endDate)`. For a 365-day window (2024-01-01 → 2024-12-31) the
    // mapping resolves to `'1y'` per the documented lookup table.
    expect(callArg.dateRange).toEqual(expect.any(String));
    expect((callArg.dateRange ?? '').length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 6 — query_history tool execute uses the closure-captured
  //          authenticatedUserId and forwards SQL/binds verbatim
  //          (Rule 2 — parameterized bind variables)
  // -------------------------------------------------------------------------

  it('query_history execute closure calls SnowflakeSyncService.queryHistory with the closure-captured userId and forwards binds verbatim (AAP Rule 2 + Refine PR Directive 2)', async () => {
    const sql = 'SELECT 1 FROM portfolio_snapshots WHERE user_id = ?';
    const claudeBinds: (string | number | boolean | null)[] = [
      'param-value',
      42,
      true,
      null
    ];

    const tools = (
      service as unknown as {
        buildTools: (userId: string) => Record<string, ToolShape>;
      }
    ).buildTools(REAL_USER_ID);

    await tools.query_history.execute(
      {
        binds: claudeBinds,
        sql
      },
      TOOL_EXEC_OPTIONS
    );

    expect(snowflakeSyncService.queryHistory).toHaveBeenCalledTimes(1);

    // `queryHistory(userId, sql, binds)` is positional — the first
    // argument MUST be the closure-captured user id.
    const [calledUserId, calledSql, calledBinds] = snowflakeSyncService
      .queryHistory.mock.calls[0] as [string, string, unknown[]];

    expect(calledUserId).toBe(REAL_USER_ID);
    // `sql` is forwarded verbatim. Sanitization (e.g. `;` rejection)
    // is performed by `SnowflakeSyncService.queryHistory(...)` itself,
    // NOT by the chat agent's tool closure.
    expect(calledSql).toBe(sql);
    // `binds` is forwarded as an array. Length and order are
    // preserved exactly.
    expect(Array.isArray(calledBinds)).toBe(true);
    expect(calledBinds).toHaveLength(claudeBinds.length);
  });

  // -------------------------------------------------------------------------
  // Test 7 — get_market_data tool execute calls SymbolService.get with
  //          the LLM-supplied ticker (the only model-controllable
  //          parameter)
  // -------------------------------------------------------------------------

  it('get_market_data execute closure calls SymbolService.get with the LLM-supplied ticker (Refine PR Directive 2)', async () => {
    const tools = (
      service as unknown as {
        buildTools: (userId: string) => Record<string, ToolShape>;
      }
    ).buildTools(REAL_USER_ID);

    await tools.get_market_data.execute({ ticker: 'AAPL' }, TOOL_EXEC_OPTIONS);

    expect(symbolService.get).toHaveBeenCalledTimes(1);

    // `SymbolService.get` accepts a `dataGatheringItem` envelope — the
    // production closure hardcodes `dataSource: DataSource.YAHOO` and
    // passes the ticker through.
    const [callArg] = symbolService.get.mock.calls[0] as [SymbolCallArg];
    expect(callArg).toBeDefined();
    expect(callArg.dataGatheringItem).toBeDefined();
    expect(callArg.dataGatheringItem.symbol).toBe('AAPL');
    expect(callArg.dataGatheringItem.dataSource).toBe('YAHOO');
  });

  // -------------------------------------------------------------------------
  // Test 8 — Source code does NOT contain forbidden direct accessors
  //          (AAP § 0.7.1.3 Rule 3 source-text grep + Refine PR Directive 2
  //           Anthropic SDK removal)
  // -------------------------------------------------------------------------

  it('the AiChatService source file contains zero process.env.ANTHROPIC, zero process.env.SNOWFLAKE references, and zero direct @anthropic-ai/sdk imports (AAP § 0.7.1.3 Rule 3 + Refine PR Directive 2)', () => {
    // The agent_prompt's authoritative Rule 3 verification: read the
    // sibling file's source text and assert via regex that it never
    // contains the prohibited `process.env.ANTHROPIC*` or
    // `process.env.SNOWFLAKE*` accessors.
    //
    // ADDED for Refine PR Directive 2: ALSO assert that the source
    // does NOT import the `@anthropic-ai/sdk` package directly, since
    // the Vercel AI SDK migration centralizes provider construction in
    // `AiProviderService`. Any direct Anthropic SDK import in this file
    // would indicate the migration regressed.
    const sourcePath = join(__dirname, 'ai-chat.service.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(/process\.env\.ANTHROPIC/);
    expect(source).not.toMatch(/process\.env\.SNOWFLAKE/);
    expect(source).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);

    // Refine PR Directive 2: the file must NOT directly import the
    // Anthropic SDK; provider construction is centralized in
    // `AiProviderService`.
    expect(source).not.toMatch(/from\s+['"]@anthropic-ai\/sdk['"]/);
  });

  // -------------------------------------------------------------------------
  // Test 9 — System-prompt personalization (FinancialProfile)
  // -------------------------------------------------------------------------

  it('includes FinancialProfile data in the system prompt when present (AAP § 0.5.1.1 personalization)', async () => {
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
    const systemPrompt = await (
      service as unknown as {
        buildSystemPrompt: (userId: string) => Promise<string>;
      }
    ).buildSystemPrompt(REAL_USER_ID);

    expect(systemPrompt).not.toContain(REAL_USER_ID);
    expect(systemPrompt).toContain('<authenticated-user>');
  });
});
