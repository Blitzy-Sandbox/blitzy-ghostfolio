import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SnowflakeSyncService } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.service';
import { UserFinancialProfileService } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.service';
import type {
  FinancialProfile,
  PortfolioDetails,
  RebalancingResponse
} from '@ghostfolio/common/interfaces';

import Anthropic from '@anthropic-ai/sdk';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RebalancingRequestDto } from './dtos/rebalancing-request.dto';

/**
 * `RebalancingService` is the core service for **Feature C — Explainable
 * Rebalancing Engine** described in AAP § 0.1.1, § 0.1.2.4, § 0.5.1.1, and
 * § 0.7.5.2 (rebalancing engine gate).
 *
 * Responsibilities:
 *   1. Construct an Anthropic SDK client at module init using credentials read
 *      EXCLUSIVELY through `ConfigService` (Rule 3, AAP § 0.7.1.3).
 *   2. Build a personalized prompt for every request from the authenticated
 *      user's live `PortfolioService.getDetails(...)` snapshot and persisted
 *      `FinancialProfile` (per AAP § 0.5.1.1).
 *   3. Define a single Claude tool schema named `rebalancing_recommendations`
 *      whose `input_schema` mirrors the verbatim `RebalancingResponse`
 *      contract from AAP § 0.1.2.4.
 *   4. Force tool invocation via `tool_choice: { type: 'tool', name: ... }`
 *      so that Claude's response is GUARANTEED to contain a `tool_use`
 *      content block (and never free-form text).
 *   5. Read structured output EXCLUSIVELY from `tool_use` content blocks —
 *      NEVER parse text content (Rule 4, AAP § 0.7.1.4 — central to this
 *      feature).
 *
 * Hard rules enforced by this class (AAP § 0.7):
 *
 * - **Rule 1 (Module Isolation):** Cross-module dependencies are reached
 *   only through services explicitly listed in their source module's
 *   `exports` array — `PortfolioService` (PortfolioModule),
 *   `SnowflakeSyncService` (SnowflakeSyncModule), and
 *   `UserFinancialProfileService` (UserFinancialProfileModule). No imports
 *   reach into other feature module directories.
 *
 * - **Rule 3 (ConfigService):** Both `ANTHROPIC_API_KEY` and
 *   `ANTHROPIC_MODEL` are read through the injected `ConfigService`. No
 *   direct `process` global access for Anthropic credentials appears
 *   anywhere in this file.
 *
 * - **Rule 4 (Tool-Use Structured Output):** The `recommend(...)` method
 *   reads `RebalancingResponse` ONLY from a content block where
 *   `block.type === 'tool_use'`. Free-form text content is NEVER parsed.
 *   When no `tool_use` block is present, the service throws
 *   `BadGatewayException` (HTTP 502) — the canonical NestJS exception for
 *   upstream-service failures.
 *
 * - **JWT-authoritative `userId`:** The `userId` parameter on
 *   `recommend(...)` is sourced by the controller from `request.user.id`
 *   (the JWT-verified user id) — NEVER from the request body. The service
 *   itself trusts this caller-supplied value as authoritative.
 *
 * - **Observability (AAP § 0.7.2):** Every `recommend(...)` invocation logs
 *   start and end events with the caller-supplied `correlationId`, the
 *   per-request `userId`, the recommendation count, and the elapsed
 *   milliseconds. The Anthropic API key NEVER appears in any log line.
 *   The static-Logger convention (`Logger.log(message, 'RebalancingService')`)
 *   matches the project-wide pattern (e.g., `snowflake-sync.service.ts`,
 *   `ai-chat.service.ts`).
 */
@Injectable()
export class RebalancingService {
  /**
   * Default `max_tokens` budget on each `messages.create(...)` call.
   *
   * Anthropic's API requires `max_tokens` on every request; 4096 tokens is
   * a generous budget for structured rebalancing output (typically a few
   * dozen recommendations plus summary and warnings text — well under the
   * cap).
   */
  private static readonly DEFAULT_MAX_TOKENS = 4096;

  /**
   * Maximum number of holdings rendered into the personalized user message.
   *
   * A typical portfolio holds 10–30 positions; capping at 50 keeps the
   * prompt compact while covering the long tail. Holdings are sorted by
   * descending allocation percentage so the most material positions are
   * always included.
   */
  private static readonly USER_MESSAGE_HOLDINGS_CAP = 50;

  /**
   * Production-grade default Claude model id used when the operator has not
   * set `ANTHROPIC_MODEL` in the environment. This is intentionally a
   * stable dated alias (`claude-3-5-sonnet-20241022`) rather than the
   * floating `claude-3-5-sonnet-latest` so the deployed application's
   * behavior does not silently change when Anthropic ships a new minor
   * revision. Operators can override the default at any time via the
   * `ANTHROPIC_MODEL` env var (per AAP § 0.7.3) without touching source.
   */
  private static readonly DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';

  /**
   * Tool name used for the single forced `tool_use` invocation. Centralized
   * here so the schema definition (`buildRebalancingTool()`), the
   * `tool_choice` clause on `messages.create(...)`, and downstream
   * validation can all reference the same string literal.
   */
  private static readonly TOOL_NAME = 'rebalancing_recommendations';

  /**
   * Lazily-constructed Anthropic SDK client. The `apiKey` is read once at
   * service construction time via
   * `ConfigService.get<string>('ANTHROPIC_API_KEY')` — never via the
   * `process` global (Rule 3 / AAP § 0.7.1.3).
   */
  private readonly anthropic: Anthropic;

  /**
   * Resolved Claude model id for every `messages.create(...)` call.
   * Defaults to {@link RebalancingService.DEFAULT_MODEL} when the operator
   * has not set `ANTHROPIC_MODEL` in the environment.
   */
  private readonly model: string;

  public constructor(
    private readonly configService: ConfigService,
    private readonly portfolioService: PortfolioService,
    private readonly snowflakeSyncService: SnowflakeSyncService,
    private readonly userFinancialProfileService: UserFinancialProfileService
  ) {
    // Rule 3: credential access via ConfigService ONLY. The optional empty
    // string fallback keeps the SDK constructor from throwing on a missing
    // env var at boot — the actual API call will fail fast with a 401,
    // which is the correct failure mode (configuration error, not crash).
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY') ?? '';

    this.anthropic = new Anthropic({ apiKey });

    this.model =
      this.configService.get<string>('ANTHROPIC_MODEL') ??
      RebalancingService.DEFAULT_MODEL;

    // The `snowflakeSyncService` field is reserved for future-use historical
    // context queries (per AAP § 0.1.3 and § 0.5.1.1: "RebalancingModule
    // optionally imports SnowflakeSyncModule for historical context").
    // Future enhancements will call `snowflakeSyncService.queryHistory(...)`
    // to feed multi-year drift data into the LLM prompt. The reference is
    // touched here so TypeScript's `noUnusedParameters` is satisfied while
    // the wiring remains live for the upcoming feature work.
    void this.snowflakeSyncService;
  }

  /**
   * Generates a structured rebalancing recommendation for the given
   * authenticated user.
   *
   * Workflow:
   *   1. Build the personalized prompt (system + user message) from the
   *      user's live portfolio holdings and persisted `FinancialProfile`.
   *   2. Construct the single `rebalancing_recommendations` tool schema
   *      whose `input_schema` mirrors the AAP § 0.1.2.4 contract.
   *   3. Invoke `anthropic.messages.create(...)` (NON-streaming) with
   *      `tool_choice: { type: 'tool', name: 'rebalancing_recommendations' }`
   *      so the model is REQUIRED to invoke that single tool — Claude's
   *      response will contain a `tool_use` content block, never free-form
   *      text.
   *   4. Read structured output EXCLUSIVELY from the `tool_use` content
   *      block's `input` field (Rule 4). NEVER parse text content blocks.
   *   5. Validate that the structured output has the three required
   *      top-level fields (`recommendations`, `summary`, `warnings`); if
   *      any are missing, throw `BadGatewayException`.
   *
   * @param   correlationId   per-request id propagated through every log
   *                          line for the Observability rule.
   * @param   requestPayload  optional override fields (per AAP § 0.5.1.1,
   *                          reserved for future expansion — currently
   *                          unused inside the service body).
   * @param   userId          authenticated user id from JWT (NEVER from
   *                          request body).
   * @returns                 structured `RebalancingResponse` populated
   *                          exclusively from the Claude `tool_use` block.
   * @throws  {BadGatewayException} when Anthropic returns no `tool_use`
   *                                block, an unexpected structured-output
   *                                shape, or any other upstream failure.
   */
  public async recommend({
    correlationId,
    requestPayload,
    userId
  }: {
    correlationId: string;
    requestPayload: RebalancingRequestDto;
    userId: string;
  }): Promise<RebalancingResponse> {
    const startTime = Date.now();

    Logger.log(
      `[${correlationId}] rebalancing request start userId=${userId}`,
      'RebalancingService'
    );

    // Suppress the unused-parameter warning for `requestPayload` — it is
    // reserved for future override fields per AAP § 0.5.1.1. Once
    // `targetAllocation` (or other override fields) are wired through into
    // the user message, this `void` discard goes away.
    void requestPayload;

    try {
      const { systemPrompt, userMessage } = await this.buildPrompt(userId);
      const tool = this.buildRebalancingTool();

      // CRITICAL Rule 4: `tool_choice` FORCES the model to invoke the named
      // tool. Per Anthropic's API contract, when `tool_choice` selects a
      // specific tool, the response WILL contain a `tool_use` content
      // block for that tool — text-only responses are not possible.
      const response = await this.anthropic.messages.create({
        max_tokens: RebalancingService.DEFAULT_MAX_TOKENS,
        messages: [{ content: userMessage, role: 'user' }],
        model: this.model,
        system: systemPrompt,
        tool_choice: { name: RebalancingService.TOOL_NAME, type: 'tool' },
        tools: [tool]
      });

      // CRITICAL Rule 4: read structured output ONLY from a `tool_use`
      // content block. The `find(...)` predicate narrows the union via the
      // discriminated `type` field; no text block is ever inspected.
      const toolUseBlock = (response.content ?? []).find(
        (block): block is Anthropic.ToolUseBlock =>
          block?.type === 'tool_use' &&
          block.name === RebalancingService.TOOL_NAME
      );

      if (!toolUseBlock || toolUseBlock.input === undefined) {
        Logger.error(
          `[${correlationId}] rebalancing returned no tool_use block ` +
            `userId=${userId}`,
          'RebalancingService'
        );
        throw new BadGatewayException(
          'Anthropic returned an unexpected response shape (no tool_use block).'
        );
      }

      // The `input` field is typed as `unknown` by the SDK because Claude
      // is responsible for shaping it according to the supplied
      // `input_schema`. We narrow at runtime by checking the three
      // required top-level fields per AAP § 0.1.2.4 contract.
      const candidate = toolUseBlock.input as RebalancingResponse;

      if (
        !Array.isArray(candidate?.recommendations) ||
        typeof candidate?.summary !== 'string' ||
        !Array.isArray(candidate?.warnings)
      ) {
        Logger.error(
          `[${correlationId}] rebalancing tool_use input has unexpected ` +
            `shape userId=${userId}`,
          'RebalancingService'
        );
        throw new BadGatewayException(
          'Anthropic tool_use response is missing required fields ' +
            '(recommendations, summary, warnings).'
        );
      }

      const elapsedMs = Date.now() - startTime;

      Logger.log(
        `[${correlationId}] rebalancing request end userId=${userId} ` +
          `recommendations=${candidate.recommendations.length} ` +
          `warnings=${candidate.warnings.length} elapsedMs=${elapsedMs}`,
        'RebalancingService'
      );

      return candidate;
    } catch (err) {
      // BadGatewayException already carries the right HTTP-502 mapping —
      // re-throw as-is so the global exception filter preserves the status.
      if (err instanceof BadGatewayException) {
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);

      Logger.error(
        `[${correlationId}] rebalancing failed userId=${userId}: ` +
          `${errorMessage}`,
        'RebalancingService'
      );

      // Map any other upstream / unexpected failure to HTTP 502. The
      // user-facing message is intentionally generic — the detailed
      // `errorMessage` lives only in the structured log line above and
      // never leaks the API key (it is constructed from `ConfigService`
      // values that are not interpolated into the message).
      throw new BadGatewayException(
        'Rebalancing recommendation could not be generated. Please retry.'
      );
    }
  }

  /**
   * Builds the single Claude tool whose `input_schema` mirrors the
   * `RebalancingResponse` contract from AAP § 0.1.2.4 verbatim.
   *
   * The tool is forced via `tool_choice` on every `messages.create(...)`
   * call so the model's response is GUARANTEED to invoke it — yielding a
   * `tool_use` content block whose `input` field is the structured
   * `RebalancingResponse` payload.
   *
   * Schema fidelity (AAP § 0.1.2.4):
   *   - `recommendations[].action` ∈ { 'BUY', 'SELL', 'HOLD' }
   *   - `recommendations[].ticker` — string
   *   - `recommendations[].fromPct` — number (decimal fraction 0.0–1.0)
   *   - `recommendations[].toPct`   — number (decimal fraction 0.0–1.0)
   *   - `recommendations[].rationale` — non-empty string referencing the
   *     user's stated financial goal (Rule 4 verification gate)
   *   - `recommendations[].goalReference` — non-empty FinancialProfile
   *     field name OR investmentGoals[<index>].label (Rule 4 verification)
   *   - `summary`  — string
   *   - `warnings` — string[]
   *
   * The descriptions are written in natural language because the model
   * uses them to generate higher-quality outputs (per the Anthropic
   * tool-use guide: "Tool descriptions should be as detailed as possible").
   *
   * Type note: `Anthropic.Tool` is the canonical SDK type for a custom
   * tool definition; it matches the project-wide convention established
   * by `AiChatService.buildTools()` (`apps/api/src/app/ai-chat/ai-chat.service.ts`).
   */
  private buildRebalancingTool(): Anthropic.Tool {
    return {
      description:
        'Returns structured portfolio rebalancing recommendations. Each ' +
        'recommendation MUST include a plain-language rationale ' +
        "explicitly referencing the user's stated financial goals and a " +
        'machine-readable goalReference identifying which financial-' +
        'profile field or investment-goal label motivated the ' +
        'recommendation. The summary briefly explains the overall ' +
        'strategy. The warnings array surfaces concerns the user should ' +
        'review (e.g., tax implications, concentration risk).',
      input_schema: {
        properties: {
          recommendations: {
            description:
              'Ordered list of rebalancing actions. Empty array means no ' +
              'changes recommended.',
            items: {
              properties: {
                action: {
                  description:
                    'Trade action: BUY to increase allocation, SELL to ' +
                    'decrease, HOLD to keep as-is.',
                  enum: ['BUY', 'SELL', 'HOLD'],
                  type: 'string'
                },
                fromPct: {
                  description:
                    'Current allocation as a decimal fraction (0.0 to ' +
                    '1.0). For example, 0.10 means 10%.',
                  type: 'number'
                },
                goalReference: {
                  description:
                    'Machine-readable reference. Either a FinancialProfile ' +
                    "field name (e.g., 'retirementTargetAge', " +
                    "'riskTolerance', 'timeHorizonYears', 'monthlyIncome', " +
                    "'monthlyDebtObligations', 'retirementTargetAmount') " +
                    'OR an investment-goal label (e.g., ' +
                    '"investmentGoals[0].label=\'House Down Payment\'"). ' +
                    'MUST NOT be empty.',
                  type: 'string'
                },
                rationale: {
                  description:
                    "Plain-language explanation referencing the user's " +
                    'financial goals. MUST NOT be empty. Should mention ' +
                    'the specific goal/profile-field motivating this ' +
                    'action.',
                  type: 'string'
                },
                ticker: {
                  description: 'Asset ticker symbol (e.g., VTI, AAPL, BND).',
                  type: 'string'
                },
                toPct: {
                  description:
                    'Target allocation as a decimal fraction (0.0 to ' +
                    '1.0). Same scale as fromPct.',
                  type: 'number'
                }
              },
              required: [
                'action',
                'ticker',
                'fromPct',
                'toPct',
                'rationale',
                'goalReference'
              ],
              type: 'object'
            },
            type: 'array'
          },
          summary: {
            description:
              'Brief overall summary of the rebalancing strategy in one ' +
              'or two sentences.',
            type: 'string'
          },
          warnings: {
            description:
              "List of concerns the user should review (e.g., 'Tax " +
              "implications of selling X should be reviewed.'). Empty " +
              'array if no warnings.',
            items: { type: 'string' },
            type: 'array'
          }
        },
        required: ['recommendations', 'summary', 'warnings'],
        type: 'object'
      },
      name: RebalancingService.TOOL_NAME
    };
  }

  /**
   * Builds the personalized prompt sent to Claude for a single
   * `recommend(...)` invocation.
   *
   * The prompt has two halves:
   *   - **systemPrompt** — neutral, fiduciary-minded persona; explicit
   *     instruction to invoke the `rebalancing_recommendations` tool;
   *     instruction to cite specific FinancialProfile fields or
   *     investmentGoal labels; instruction on the percentage-as-decimal-
   *     fraction convention used in `fromPct` / `toPct`.
   *   - **userMessage** — Markdown-style sections containing the user's
   *     current portfolio holdings (top {@link USER_MESSAGE_HOLDINGS_CAP}
   *     by allocation) and the user's persisted `FinancialProfile` (or a
   *     "no profile on file" sentinel when `findByUserId` returns `null`).
   *
   * Both the portfolio and the profile are fetched via `Promise.allSettled`
   * so a missing profile (or even a transient portfolio fetch failure)
   * does NOT bring down the rebalancing flow — the prompt degrades
   * gracefully into one whose `userMessage` describes the missing data,
   * and the LLM is instructed (via the system prompt) to surface a
   * warning-array entry asking the user to fill in their profile.
   */
  private async buildPrompt(userId: string): Promise<{
    systemPrompt: string;
    userMessage: string;
  }> {
    const [portfolioDetailsResult, profileResult] = await Promise.allSettled([
      this.portfolioService.getDetails({
        impersonationId: undefined,
        userId
      }),
      this.userFinancialProfileService.findByUserId(userId)
    ]);

    const portfolioDetails =
      portfolioDetailsResult.status === 'fulfilled'
        ? portfolioDetailsResult.value
        : null;

    // The Prisma-generated `FinancialProfile` row has
    // `investmentGoals: JsonValue` whereas the application-domain
    // `FinancialProfile` interface (from `@ghostfolio/common/interfaces`)
    // narrows that field to `InvestmentGoal[]`. The two shapes overlap on
    // every other field, and `summarizeProfile(...)` defensively re-checks
    // `Array.isArray(profile.investmentGoals)` before iterating. We
    // therefore cast through `unknown` to bridge the JSON-vs-typed-array
    // discrepancy without weakening the consumer's typing.
    const profile: FinancialProfile | null =
      profileResult.status === 'fulfilled'
        ? (profileResult.value as unknown as FinancialProfile | null)
        : null;

    const portfolioSummary = this.summarizePortfolio(portfolioDetails);
    const profileSummary = this.summarizeProfile(profile);

    const systemPrompt = [
      'You are a neutral, fiduciary-minded financial advisor providing ' +
        'rebalancing recommendations.',
      'You MUST invoke the `rebalancing_recommendations` tool to return ' +
        'structured output. Do NOT respond with free-form text.',
      'Each recommendation MUST cite a specific FinancialProfile field or ' +
        'investmentGoal label in goalReference, and the rationale MUST ' +
        'explicitly mention that goal in plain language.',
      'If the user has no financial profile on file, return an empty ' +
        'recommendations array and a warning that the user should fill ' +
        'in their FinancialProfile.',
      'Use percentages as decimal fractions in fromPct and toPct (e.g., ' +
        '0.10 for 10%).'
    ].join('\n');

    const userMessage = [
      '# Current Portfolio',
      portfolioSummary,
      '',
      '# User Financial Profile',
      profileSummary,
      '',
      '# Task',
      'Recommend rebalancing trades to align the current portfolio with ' +
        'the user financial profile and stated investment goals.',
      'Invoke the rebalancing_recommendations tool with structured output.'
    ].join('\n');

    return { systemPrompt, userMessage };
  }

  /**
   * Renders a compact text representation of the user's current portfolio
   * holdings for inclusion in the LLM user message.
   *
   * Behavior:
   *   - When `portfolio` is `null` (fetch failed) — returns a sentinel
   *     phrase the LLM can surface as a warning.
   *   - When `portfolio.holdings` is empty — returns "No holdings."
   *   - Otherwise — sorts holdings by descending `allocationInPercentage`,
   *     truncates to {@link USER_MESSAGE_HOLDINGS_CAP}, and formats each
   *     row as a single Markdown bullet line.
   *
   * Each formatted row falls back across `assetProfile` and the
   * `PortfolioPosition`'s deprecated top-level fields so the formatting
   * works against both the canonical and the legacy shape exposed by
   * `PortfolioService.getDetails(...)`.
   */
  private summarizePortfolio(
    portfolio: (PortfolioDetails & { hasErrors?: boolean }) | null
  ): string {
    if (!portfolio || !portfolio.holdings) {
      return '(no portfolio data available)';
    }

    const entries = Object.values(portfolio.holdings);

    if (entries.length === 0) {
      return 'No holdings.';
    }

    return entries
      .slice()
      .sort(
        (a, b) =>
          (b?.allocationInPercentage ?? 0) - (a?.allocationInPercentage ?? 0)
      )
      .slice(0, RebalancingService.USER_MESSAGE_HOLDINGS_CAP)
      .map((holding) => {
        const symbol =
          holding?.assetProfile?.symbol ??
          holding?.symbol ??
          holding?.assetProfile?.name ??
          holding?.name ??
          'UNKNOWN';
        const assetClass =
          holding?.assetProfile?.assetClass ?? holding?.assetClass ?? 'N/A';
        const allocationPct = (
          (holding?.allocationInPercentage ?? 0) * 100
        ).toFixed(2);
        const currency =
          holding?.assetProfile?.currency ?? holding?.currency ?? '';

        return `- ${symbol} | ${assetClass} | ${allocationPct}% | ${currency}`;
      })
      .join('\n');
  }

  /**
   * Renders a compact text representation of the user's persisted
   * `FinancialProfile` for inclusion in the LLM user message.
   *
   * Behavior:
   *   - When `profile` is `null` (no record yet, `findByUserId` returned
   *     `null`) — returns a sentinel phrase the LLM is instructed (via the
   *     system prompt) to surface as a warning-array entry asking the
   *     user to complete their profile.
   *   - Otherwise — emits one Markdown bullet line per persisted field.
   *     `investmentGoals` is JSON-stringified verbatim so the model can
   *     reference each `label` in the `goalReference` field of any
   *     recommendation it emits.
   */
  private summarizeProfile(profile: FinancialProfile | null): string {
    if (!profile) {
      return '(no financial profile on file — user has not completed setup)';
    }

    const goals = Array.isArray(profile.investmentGoals)
      ? profile.investmentGoals
      : [];

    return [
      `- riskTolerance: ${profile.riskTolerance}`,
      `- retirementTargetAge: ${profile.retirementTargetAge}`,
      `- retirementTargetAmount: ${profile.retirementTargetAmount}`,
      `- timeHorizonYears: ${profile.timeHorizonYears}`,
      `- monthlyIncome: ${profile.monthlyIncome}`,
      `- monthlyDebtObligations: ${profile.monthlyDebtObligations}`,
      `- investmentGoals: ${JSON.stringify(goals)}`
    ].join('\n');
  }
}
