import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SnowflakeSyncService } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.service';
import { SymbolService } from '@ghostfolio/api/app/symbol/symbol.service';
import { UserFinancialProfileService } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.service';
import type { ChatMessage } from '@ghostfolio/common/interfaces';
import type { DateRange } from '@ghostfolio/common/types';

import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from '@prisma/client';
import { Observable } from 'rxjs';

/**
 * `AiChatService` is the core service for **Feature B — AI Portfolio Chat
 * Agent** described in AAP § 0.1.1, § 0.1.2.4, § 0.5.1.1, and § 0.5.1.5.
 *
 * Responsibilities:
 *   1. Construct an Anthropic SDK client at module init using credentials read
 *      EXCLUSIVELY through `ConfigService` (Rule 3, AAP § 0.7.1.3).
 *   2. Build a personalized system prompt for every request from the
 *      authenticated user's live `PortfolioService.getDetails(...)` snapshot
 *      and persisted `FinancialProfile` (per AAP § 0.5.1.1).
 *   3. Define the four Claude tool schemas — `get_current_positions`,
 *      `get_performance_metrics`, `query_history`, `get_market_data` — per
 *      AAP § 0.5.1.5 verbatim.
 *   4. Stream the Claude `messages.stream(...)` response token-by-token to the
 *      SSE controller via `Observable<MessageEvent>`. The controller's `@Sse()`
 *      decorator converts each emission into a `text/event-stream` frame.
 *   5. On every `tool_use` content block returned by Claude, dispatch to the
 *      corresponding sibling service (PortfolioService, SymbolService,
 *      SnowflakeSyncService) — overriding any tool-supplied `userId` with the
 *      JWT-authenticated value before the dispatch (security-critical, AAP
 *      § 0.5.1.5).
 *
 * Hard rules enforced by this class (AAP § 0.7):
 *
 * - **Rule 1 (Module Isolation):** Cross-module dependencies are reached only
 *   through services explicitly listed in their source module's `exports`
 *   array — `PortfolioService` (PortfolioModule), `SymbolService`
 *   (SymbolModule), `SnowflakeSyncService` (SnowflakeSyncModule), and
 *   `UserFinancialProfileService` (UserFinancialProfileModule). No imports
 *   reach into other feature module directories.
 *
 * - **Rule 3 (ConfigService):** Both `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`
 *   are read through the injected `ConfigService`. No direct `process` global
 *   access for Anthropic credentials appears anywhere in this file.
 *
 * - **JWT-authoritative `userId`:** `dispatchTool(...)` ignores any `userId`
 *   field that Claude supplied in a tool's `input` and substitutes the
 *   JWT-authenticated `authenticatedUserId` for every downstream service call.
 *   The same value is also embedded into the system prompt so the model can
 *   echo it back in tool inputs without being able to act on a different
 *   user's data even if it tried.
 *
 * - **Stateless protocol:** This service holds no per-conversation state. The
 *   client carries up to 5 messages (4 prior turns + 1 new user turn — capped
 *   by `ChatRequestDto`'s `@ArrayMaxSize(5)`) on every request.
 *
 * - **Observability (AAP § 0.7.2):** Every `streamChat(...)` invocation logs
 *   start and end events with the caller-supplied `correlationId` and the
 *   per-request `userId`. The Anthropic API key NEVER appears in any log line.
 *   The static-Logger convention (`Logger.log(message, 'AiChatService')`)
 *   matches the project-wide pattern (e.g., `snowflake-sync.service.ts`).
 *   The injected `MetricsService` emits three metrics on every request:
 *   `ai_chat_streams_total{outcome}` (counter; `outcome` ∈
 *   `{success, error, cancelled}`), `ai_chat_first_token_latency_seconds`
 *   (histogram, no labels), and `ai_chat_tool_invocations_total{tool}`
 *   (counter; `tool` ∈ {`get_current_positions`, `get_performance_metrics`,
 *   `query_history`, `get_market_data`}). All label values are bounded to a
 *   small fixed set per the MetricsService cardinality guard.
 *
 * - **PII minimization (AAP § 0.7.3):** The personalized system prompt does
 *   NOT embed the JWT-authenticated user's literal id; it inserts the
 *   placeholder constant {@link AiChatService.AUTHENTICATED_USER_PLACEHOLDER}
 *   ("`<authenticated-user>`") instead. The model is instructed to pass that
 *   placeholder string through verbatim in every tool input — and
 *   `dispatchTool(...)` substitutes the real JWT-authenticated user id at
 *   dispatch time, so the model can NEVER act on a different user's data
 *   even if it tried. This keeps the real Ghostfolio user id from being
 *   transmitted to Anthropic on every chat request.
 */
@Injectable()
export class AiChatService {
  /**
   * Maximum number of conversational turns (assistant ↔ tool dispatch ↔
   * assistant) executed inside the multi-turn loop in `streamChat(...)`.
   *
   * The cap is a defense-in-depth bound that prevents Claude from emitting an
   * unbounded chain of tool calls (e.g., a model bug that keeps re-invoking
   * the same tool). 8 turns is generous enough to support any realistic
   * portfolio question (most questions resolve in 1–3 turns) while preserving
   * the chat agent's per-request latency budget per AAP § 0.7.5.2.
   */
  private static readonly MAX_TOOL_TURNS = 8;

  /**
   * Default `max_tokens` budget on each `messages.stream(...)` call.
   *
   * Anthropic's API requires `max_tokens` on every request; 1024 tokens is a
   * sensible default for portfolio Q&A (≈ 750 words) without exhausting the
   * model context on a single turn.
   */
  private static readonly DEFAULT_MAX_TOKENS = 1024;

  /**
   * Maximum number of holdings rendered into the personalized system prompt.
   *
   * A typical portfolio holds 10–30 positions; capping at 25 keeps the system
   * prompt compact while covering the long tail. Holdings are sorted by
   * descending allocation percentage so the most material positions are
   * always included.
   */
  private static readonly SYSTEM_PROMPT_HOLDINGS_CAP = 25;

  /**
   * Production-grade default Claude model id used when the operator has not
   * set `ANTHROPIC_MODEL` in the environment. This is intentionally a stable
   * dated alias (`claude-3-5-sonnet-20241022`) rather than the floating
   * `claude-3-5-sonnet-latest` so the deployed application's behavior does
   * not silently change when Anthropic ships a new minor revision. Operators
   * can override the default at any time via the `ANTHROPIC_MODEL` env var
   * (per AAP § 0.7.3) without touching source.
   */
  private static readonly DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';

  /**
   * Placeholder string substituted into the personalized system prompt in
   * place of the JWT-authenticated user's literal id. The model is told to
   * pass this string through verbatim in every tool input; `dispatchTool(...)`
   * then substitutes the JWT-authenticated id at dispatch time, so the model
   * never needs to (and never sees) the real user id. This keeps Anthropic
   * receiving zero Ghostfolio user identifiers on every chat request and
   * preserves Rule 5's JWT-authoritative authorization guarantee — the
   * downstream service calls are unaffected because dispatch-time substitution
   * is independent of whatever userId Claude decides to emit.
   */
  private static readonly AUTHENTICATED_USER_PLACEHOLDER =
    '<authenticated-user>';

  /**
   * Counter metric name for chat-stream terminal outcomes. Labelled with
   * `outcome` ∈ {`success`, `error`, `cancelled`}. Cardinality is bounded
   * to 3 distinct label sets — well below the MetricsService cardinality
   * guard threshold.
   */
  private static readonly METRIC_STREAMS_TOTAL = 'ai_chat_streams_total';

  /**
   * Histogram metric name for the latency between request start and the
   * first model-emitted text delta on the SSE stream. No labels — first-
   * token latency is a single user-experience signal regardless of outcome.
   * Recorded only when the request reached the first text event, so error
   * paths that fail before any token arrives do NOT corrupt this signal.
   */
  private static readonly METRIC_FIRST_TOKEN_LATENCY_SECONDS =
    'ai_chat_first_token_latency_seconds';

  /**
   * Counter metric name for individual chat-tool invocations. Labelled with
   * `tool` ∈ the four AAP § 0.5.1.5 tool names. Cardinality is bounded to 4
   * distinct label sets.
   */
  private static readonly METRIC_TOOL_INVOCATIONS_TOTAL =
    'ai_chat_tool_invocations_total';

  /**
   * Lazily-constructed Anthropic SDK client. The `apiKey` is read once at
   * service construction time via `ConfigService.get<string>('ANTHROPIC_API_KEY')`
   * — never via the `process` global (Rule 3 / AAP § 0.7.1.3).
   */
  private readonly anthropic: Anthropic;

  /**
   * Resolved Claude model id for every `messages.stream(...)` call. Defaults
   * to {@link AiChatService.DEFAULT_MODEL} when the operator has not set
   * `ANTHROPIC_MODEL` in the environment.
   */
  private readonly model: string;

  public constructor(
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
    private readonly portfolioService: PortfolioService,
    private readonly snowflakeSyncService: SnowflakeSyncService,
    private readonly symbolService: SymbolService,
    private readonly userFinancialProfileService: UserFinancialProfileService
  ) {
    // Rule 3: credential access via ConfigService ONLY. The optional empty
    // string fallback keeps the SDK constructor from throwing on a missing
    // env var at boot — the actual API call will fail fast with a 401, which
    // is the correct failure mode (configuration error, not crash).
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY') ?? '';

    this.anthropic = new Anthropic({ apiKey });

    this.model =
      this.configService.get<string>('ANTHROPIC_MODEL') ??
      AiChatService.DEFAULT_MODEL;

    // Register help text for the three Observability metrics (AAP § 0.7.2).
    // `registerHelp` is idempotent — calling it on every service construction
    // is safe and ensures the `# HELP` lines are present in the
    // `/api/v1/metrics` Prometheus exposition output regardless of which
    // service was instantiated first.
    this.metricsService.registerHelp(
      AiChatService.METRIC_STREAMS_TOTAL,
      'Total chat streams completed by terminal outcome (success, error, cancelled).'
    );
    this.metricsService.registerHelp(
      AiChatService.METRIC_FIRST_TOKEN_LATENCY_SECONDS,
      'Latency in seconds between request start and the first text token emitted by Claude.'
    );
    this.metricsService.registerHelp(
      AiChatService.METRIC_TOOL_INVOCATIONS_TOTAL,
      'Total chat-tool invocations dispatched, labelled by tool name.'
    );
  }

  /**
   * Returns an SSE-compatible `Observable<MessageEvent>` that streams a
   * Claude `messages.stream(...)` response token-by-token, executes tool
   * calls inline against the four sibling services, and resolves when Claude
   * emits a final assistant message containing no further `tool_use` blocks.
   *
   * SSE protocol: every emission is a `MessageEvent` whose `data` field is a
   * small JSON object with a `type` discriminator:
   *
   * - `{ type: 'text', value: string }`     — token delta from the model.
   * - `{ type: 'tool_call', name: string, correlationId }` — server invoked a
   *                                                          chat tool.
   * - `{ type: 'done', correlationId }`     — stream is complete (assistant
   *                                           emitted no further tool calls).
   * - `{ type: 'error', message, correlationId }` — surfaced before
   *                                                 `subscriber.error(...)`.
   *
   * Cancellation: when the SSE subscriber unsubscribes (e.g., the browser
   * closes the EventSource), the teardown function flips an internal
   * `cancelled` flag. In-flight async work checks the flag at every loop
   * boundary so the conversation loop terminates gracefully.
   *
   * The `userId` parameter is the JWT-authenticated user id sourced from
   * `request.user.id` in the controller. It is the AUTHORITATIVE value used
   * for every downstream service call, regardless of any `userId` Claude
   * supplies in a tool input (AAP § 0.5.1.5).
   *
   * @param correlationId Per-request correlation id used for log threading.
   * @param messages      Conversation history, max 5 entries (4 prior turns +
   *                      1 new user turn) per `ChatRequestDto`.
   * @param userId        JWT-authenticated user id (NEVER from the request body).
   * @returns             An RxJS `Observable` that emits SSE-shaped
   *                      `MessageEvent` objects.
   */
  public streamChat({
    correlationId,
    messages,
    userId
  }: {
    correlationId: string;
    messages: ChatMessage[];
    userId: string;
  }): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false;

      const run = async () => {
        // Capture the request start time once, before any I/O. The first-
        // token latency histogram is observed when the FIRST `text` event
        // fires below; if the request fails before any token arrives, no
        // observation is recorded — keeping the latency signal clean of
        // failure-path noise.
        const startTime = Date.now();
        let firstTokenObserved = false;

        try {
          Logger.log(
            `[${correlationId}] chat stream start userId=${userId} ` +
              `messages=${messages.length}`,
            'AiChatService'
          );

          const systemPrompt = await this.buildSystemPrompt(userId);
          const tools = this.buildTools();

          // Map our ChatMessage[] envelope to the Anthropic SDK's
          // MessageParam[] shape. The `role` and `content` fields share the
          // same wire-format names; both unions agree on `'user' |
          // 'assistant'` for the role.
          let conversation: Anthropic.MessageParam[] = messages.map((m) => ({
            content: m.content,
            role: m.role
          }));

          // Multi-turn conversation loop: the model may emit `tool_use`
          // blocks that the server must execute before the model can finish
          // its assistant message. Each loop iteration streams one assistant
          // turn; if the turn ends with no tool_use blocks, the conversation
          // is done. The MAX_TOOL_TURNS cap is a defense-in-depth bound
          // against a runaway model that keeps re-invoking tools.
          for (
            let turn = 0;
            turn < AiChatService.MAX_TOOL_TURNS && !cancelled;
            turn += 1
          ) {
            const stream = this.anthropic.messages.stream({
              max_tokens: AiChatService.DEFAULT_MAX_TOKENS,
              messages: conversation,
              model: this.model,
              system: systemPrompt,
              tools
            });

            // Forward every token delta as a typed SSE event. The SDK emits
            // `'text'` events on every model output token; the `stream.on`
            // listener registers synchronously so no token is missed
            // between subscription and the first network response.
            stream.on('text', (textDelta: string) => {
              if (cancelled) {
                return;
              }

              // Record the first-token latency once per request. The flag
              // closure-scoped to `run()` ensures we observe the histogram
              // exactly once even across multiple turns of the multi-turn
              // tool loop (only the FIRST text token across the whole
              // conversation counts as "first token").
              if (!firstTokenObserved) {
                firstTokenObserved = true;
                this.metricsService.observeHistogram(
                  AiChatService.METRIC_FIRST_TOKEN_LATENCY_SECONDS,
                  (Date.now() - startTime) / 1000
                );
              }

              subscriber.next({
                data: { type: 'text', value: textDelta }
              } as MessageEvent);
            });

            // Wait for the assistant message to fully resolve. The returned
            // ParsedMessage exposes `content: ContentBlock[]` containing
            // text and tool_use blocks (and possibly other types we ignore).
            const finalMessage = await stream.finalMessage();

            if (cancelled) {
              break;
            }

            // Extract the tool_use blocks (if any). A turn that has no
            // tool_use blocks is the final assistant turn. The type
            // predicate `(c): c is Anthropic.ToolUseBlock` narrows the
            // filtered array to the tool-use union member without an
            // additional cast.
            const toolUses = (finalMessage.content ?? []).filter(
              (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use'
            );

            if (toolUses.length === 0) {
              break;
            }

            // Append the assistant message (verbatim, including tool_use
            // blocks) to the conversation array — the next turn's
            // `messages` array MUST include this assistant turn so Claude
            // sees its own tool_use ids alongside the matching tool_result
            // blocks the server is about to append.
            conversation = [
              ...conversation,
              { content: finalMessage.content, role: 'assistant' }
            ];

            // Execute each tool_use sequentially. Sequential execution
            // keeps the SSE event stream ordered (one tool_call event per
            // tool, in the order Claude emitted them) and avoids surfacing
            // partial state when a downstream service fails.
            const toolResults: Anthropic.ToolResultBlockParam[] = [];

            for (const toolUse of toolUses) {
              if (cancelled) {
                break;
              }

              // Record the tool invocation BEFORE the dispatch — counting
              // attempts is more useful than counting only successes
              // because tool errors are surfaced back to the model as
              // is_error tool results (line ~340 below) rather than
              // aborting the stream.
              this.metricsService.incrementCounter(
                AiChatService.METRIC_TOOL_INVOCATIONS_TOTAL,
                1,
                { tool: toolUse.name }
              );

              try {
                const toolResult = await this.dispatchTool({
                  authenticatedUserId: userId,
                  input: toolUse.input,
                  name: toolUse.name
                });

                toolResults.push({
                  content: JSON.stringify(toolResult),
                  tool_use_id: toolUse.id,
                  type: 'tool_result'
                });

                if (!cancelled) {
                  subscriber.next({
                    data: {
                      correlationId,
                      name: toolUse.name,
                      type: 'tool_call'
                    }
                  } as MessageEvent);
                }
              } catch (toolError) {
                const errorMessage =
                  toolError instanceof Error
                    ? toolError.message
                    : String(toolError);

                Logger.error(
                  `[${correlationId}] tool ${toolUse.name} failed: ${errorMessage}`,
                  'AiChatService'
                );

                // Surface the failure to the model as an `is_error` tool
                // result so the next assistant turn can apologize, retry
                // with different inputs, or pivot strategies. We do NOT
                // abort the entire stream on a single tool failure —
                // resilience matters more than perfection.
                toolResults.push({
                  content: JSON.stringify({ error: errorMessage }),
                  is_error: true,
                  tool_use_id: toolUse.id,
                  type: 'tool_result'
                });
              }
            }

            // Append the user turn that delivers all tool results back to
            // Claude. Per the Anthropic Messages protocol, tool results are
            // delivered as `content: [{ type: 'tool_result', ... }]` on a
            // user role message — NOT as a separate role.
            conversation = [
              ...conversation,
              { content: toolResults, role: 'user' }
            ];
          }

          if (!cancelled) {
            subscriber.next({
              data: { correlationId, type: 'done' }
            } as MessageEvent);
            subscriber.complete();
            // Success terminal outcome (AAP § 0.7.2). Emitted exactly once
            // per request — the `cancelled` short-circuit below ensures the
            // cancellation path emits `cancelled` instead.
            this.metricsService.incrementCounter(
              AiChatService.METRIC_STREAMS_TOTAL,
              1,
              { outcome: 'success' }
            );
            Logger.log(
              `[${correlationId}] chat stream end userId=${userId}`,
              'AiChatService'
            );
          } else {
            // Cancellation terminal outcome (AAP § 0.7.2). Reached when the
            // SSE subscriber unsubscribed mid-stream (browser closed the
            // EventSource, controller request aborted) and the loop bailed
            // out cleanly without an exception.
            this.metricsService.incrementCounter(
              AiChatService.METRIC_STREAMS_TOTAL,
              1,
              { outcome: 'cancelled' }
            );
            Logger.log(
              `[${correlationId}] chat stream cancelled userId=${userId}`,
              'AiChatService'
            );
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);

          Logger.error(
            `[${correlationId}] chat stream error userId=${userId}: ${errorMessage}`,
            'AiChatService'
          );

          // Error terminal outcome (AAP § 0.7.2). Recorded regardless of
          // whether the subscriber is still attached so failures are always
          // counted; the SSE error frame is only emitted while the
          // subscriber is still subscribed.
          this.metricsService.incrementCounter(
            AiChatService.METRIC_STREAMS_TOTAL,
            1,
            { outcome: 'error' }
          );

          if (!cancelled) {
            subscriber.next({
              data: {
                correlationId,
                message:
                  'The AI chat encountered an error. Please retry or contact support if this persists.',
                type: 'error'
              }
            } as MessageEvent);
            subscriber.error(err);
          }
        }
      };

      // Kick off the async runner. The Promise it returns is intentionally
      // discarded — errors are routed through `subscriber.error(...)` inside
      // the try/catch above.
      void run();

      // Teardown hook: when the subscriber unsubscribes (browser closed,
      // controller request aborted), flip the cancelled flag so any in-flight
      // async work exits at the next loop boundary.
      return () => {
        cancelled = true;
      };
    });
  }

  /**
   * Returns the four Claude tool schemas registered with every Anthropic
   * `messages.stream(...)` call. The schemas match AAP § 0.5.1.5 verbatim:
   *
   *   1. `get_current_positions(userId)` — current portfolio holdings.
   *   2. `get_performance_metrics(userId, startDate, endDate)` — TWR + chart.
   *   3. `query_history(userId, sql, binds)` — parameterized read-only
   *      Snowflake SQL via `snowflake-sdk` bind variables (Rule 2).
   *   4. `get_market_data(ticker)` — current price for a single ticker.
   *
   * The `userId` field is REPEATED in three of the four schemas because
   * Anthropic requires every required input to appear in the JSON Schema
   * `required` array; the value the model supplies is server-overridden in
   * `dispatchTool(...)` regardless. The fourth tool (`get_market_data`) does
   * not include `userId` because market data is not user-scoped.
   */
  private buildTools(): Anthropic.Tool[] {
    return [
      {
        description:
          "Returns the authenticated user's current portfolio holdings, " +
          'including ticker, asset class, allocation percentage, currency, ' +
          'and current market value in base currency. Use this when the ' +
          'user asks about their current portfolio composition or specific ' +
          'holdings.',
        input_schema: {
          properties: {
            userId: {
              description:
                'Identifier of the user. NOTE: this value is overridden ' +
                'server-side with the JWT-authenticated userId for ' +
                'security; supply the placeholder value provided in the ' +
                'system prompt.',
              type: 'string'
            }
          },
          required: ['userId'],
          type: 'object'
        },
        name: 'get_current_positions'
      },
      {
        description:
          "Returns the authenticated user's portfolio performance metrics " +
          'for a date range. Includes time-weighted return (TWR), net ' +
          'performance, current value, and historical chart points. Use ' +
          'this when the user asks about returns, performance, or growth ' +
          'over a period.',
        input_schema: {
          properties: {
            endDate: {
              description:
                'End of the performance window in ISO 8601 (YYYY-MM-DD).',
              type: 'string'
            },
            startDate: {
              description:
                'Start of the performance window in ISO 8601 (YYYY-MM-DD).',
              type: 'string'
            },
            userId: {
              description:
                'Identifier of the user (server-overridden with ' +
                'JWT-authenticated userId).',
              type: 'string'
            }
          },
          required: ['userId', 'startDate', 'endDate'],
          type: 'object'
        },
        name: 'get_performance_metrics'
      },
      {
        description:
          "Executes a parameterized read-only SQL query against the user's " +
          'historical Snowflake analytical store. Use this for time-series ' +
          "questions Ghostfolio's REST API cannot answer (e.g., 'What was " +
          "my asset-class allocation on this date 2 years ago?'). Bind " +
          'variables MUST be supplied in the binds array — NEVER inline ' +
          'literals into the SQL string. Tables available: ' +
          'portfolio_snapshots(snapshot_date, user_id, asset_class, ' +
          'allocation_pct, total_value_usd); orders_history(order_id, ' +
          'user_id, date, type, ticker, quantity, unit_price, fee, ' +
          'currency, synced_at); performance_metrics(metric_date, user_id, ' +
          'twr, volatility, sharpe_ratio).',
        input_schema: {
          properties: {
            binds: {
              description:
                'Array of bind values matching ? placeholders in the sql, ' +
                'in order. Allowed types: string, number, boolean, null.',
              items: {},
              type: 'array'
            },
            sql: {
              description:
                'Parameterized SELECT statement using ? placeholders. ' +
                'Must NOT contain semicolons outside string literals. ' +
                'Server enforces a 1000-row LIMIT cap.',
              type: 'string'
            },
            userId: {
              description: 'Identifier of the user (server-overridden).',
              type: 'string'
            }
          },
          required: ['userId', 'sql', 'binds'],
          type: 'object'
        },
        name: 'query_history'
      },
      {
        description:
          'Returns current market price, currency, and asset metadata for ' +
          'a single ticker symbol. Use this when the user asks about a ' +
          'specific stock/ETF/asset that may or may not be in their ' +
          'portfolio.',
        input_schema: {
          properties: {
            ticker: {
              description: 'Ticker symbol (e.g., AAPL, MSFT, VOO).',
              type: 'string'
            }
          },
          required: ['ticker'],
          type: 'object'
        },
        name: 'get_market_data'
      }
    ];
  }

  /**
   * Builds the personalized system prompt for a given authenticated user.
   *
   * The prompt is assembled once per request and combines:
   *   - Static instruction text (assistant role + tool usage guidance).
   *   - The authenticated user id placeholder used by tools.
   *   - A compact summary of the user's current holdings (top N by
   *     allocation, fetched from `PortfolioService.getDetails(...)`).
   *   - A summary of the user's stated `FinancialProfile` (risk tolerance,
   *     retirement targets, time horizon, investment goals) — read through
   *     `UserFinancialProfileService.findByUserId(...)`.
   *
   * Both downstream calls are wrapped with `.catch(() => null)` so that a
   * transient failure on either side (e.g., Prisma not yet ready, no
   * `FinancialProfile` row) does not block the chat — the prompt simply
   * renders a graceful placeholder.
   */
  private async buildSystemPrompt(
    authenticatedUserId: string
  ): Promise<string> {
    // Both downstream calls run in parallel via Promise.all and each
    // returns its own narrowed shape (or `null` on failure). The two
    // private helpers exist to give the destructured tuple explicit
    // non-`any` element types — without them, structural complexity in
    // the upstream Prisma / portfolio types would cause `portfolio` and
    // `profile` to be widened to `any` at the destructuring site.
    const [portfolio, profile] = await Promise.all([
      this.fetchPortfolioForPrompt(authenticatedUserId),
      this.fetchProfileForPrompt(authenticatedUserId)
    ]);

    const portfolioSummary = portfolio
      ? this.summarizePortfolio(portfolio)
      : '(unavailable)';
    const profileSummary = profile
      ? this.summarizeProfile(profile)
      : '(no financial profile on file)';

    // PII MINIMIZATION (AAP § 0.7.3): the literal `authenticatedUserId`
    // (the JWT-authenticated UUID for this request) is used above to
    // fetch the user's portfolio and financial profile (server-side
    // calls — the id never leaves the Ghostfolio API), but is
    // intentionally NOT embedded into the system prompt text that is
    // transmitted to Anthropic. The placeholder constant
    // `AUTHENTICATED_USER_PLACEHOLDER` is sent instead. The model is told
    // to pass that placeholder string through verbatim in every tool
    // input, and `dispatchTool(...)` substitutes the real JWT-
    // authenticated user id at dispatch time. This means the model can
    // echo `<authenticated-user>` in its tool-call inputs and the server
    // still routes the call to the correct user — Rule 5's JWT-
    // authoritative authorization remains intact, but Anthropic never
    // receives a Ghostfolio user identifier.

    return [
      `You are a helpful AI portfolio assistant integrated with Ghostfolio.`,
      `The authenticated user has the following placeholder identifier in ` +
        `tool calls: "${AiChatService.AUTHENTICATED_USER_PLACEHOLDER}".`,
      `Tool inputs that include a "userId" field MUST be set to that exact ` +
        `placeholder string ("${AiChatService.AUTHENTICATED_USER_PLACEHOLDER}"); ` +
        `the server overrides the field at dispatch time with the ` +
        `JWT-authenticated user id, so the placeholder will always resolve ` +
        `to the correct user. Do not attempt to substitute a real user id.`,
      ``,
      `# Current Portfolio`,
      portfolioSummary,
      ``,
      `# User Financial Profile`,
      profileSummary,
      ``,
      `# Tool Usage`,
      `- Prefer get_current_positions and get_performance_metrics for live data.`,
      `- Use query_history for historical or time-series questions that ` +
        `require Snowflake.`,
      `- Use get_market_data for ticker quotes.`,
      `- All responses must be factual; cite specific allocation ` +
        `percentages, returns, or dates from tool results.`
    ].join('\n');
  }

  /**
   * Fetches the user's current portfolio for the personalized system prompt.
   *
   * Returns a deliberately narrow shape (`{ holdings?: Record<string,
   * unknown> }`) — the only field {@link AiChatService.summarizePortfolio}
   * inspects — so the destructured tuple in {@link buildSystemPrompt} has a
   * sound static type. A transient failure (Prisma not yet ready, market
   * data provider down) is logged at WARN level and resolves to `null` so
   * the chat does not block on a non-essential personalization step.
   */
  private async fetchPortfolioForPrompt(
    userId: string
  ): Promise<{ holdings?: Record<string, unknown> } | null> {
    try {
      // `impersonationId: undefined` mirrors the existing-controller pattern
      // (no `x-impersonation-id` header). Passing `null` is rejected by Prisma
      // because `Access.id` is non-nullable. QA Checkpoint 9 CRITICAL #1
      // follow-on after the synthetic-REQUEST provider fix.
      const result = await this.portfolioService.getDetails({
        impersonationId: undefined,
        userId
      });

      // The `as unknown as` double-cast is intentional: the upstream
      // `PortfolioDetails` interface has a deeply-typed `holdings` map,
      // and forcing it through `unknown` narrows the value to exactly the
      // shape this service consumes (the symbol-keyed dictionary the
      // summarizer reads).
      return result as unknown as { holdings?: Record<string, unknown> };
    } catch (error) {
      Logger.warn(
        `Failed to fetch portfolio details for system prompt: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'AiChatService'
      );
      return null;
    }
  }

  /**
   * Fetches the user's `FinancialProfile` for the personalized system
   * prompt. Returns `null` when no record exists or when the underlying
   * Prisma call fails. Errors are logged at WARN level — `findByUserId`
   * itself returns `null` (not throw) for the no-record case (per
   * `UserFinancialProfileService.findByUserId`), so the catch block here
   * only fires on transport / Prisma exceptions.
   */
  private async fetchProfileForPrompt(userId: string): Promise<{
    investmentGoals?: unknown;
    retirementTargetAge?: number | null;
    retirementTargetAmount?: number | null;
    riskTolerance?: string | null;
    timeHorizonYears?: number | null;
  } | null> {
    try {
      const profile =
        await this.userFinancialProfileService.findByUserId(userId);
      return profile;
    } catch (error) {
      Logger.warn(
        `Failed to fetch financial profile for system prompt: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'AiChatService'
      );
      return null;
    }
  }

  /**
   * Renders the holdings dictionary returned by `PortfolioService.getDetails`
   * into a compact bullet list suitable for inclusion in the Claude system
   * prompt.
   *
   * Each holding is formatted as:
   *
   *   `- SYMBOL | ASSET_CLASS | XX.XX% | CURRENCY`
   *
   * Holdings are sorted by descending `allocationInPercentage` and capped at
   * {@link AiChatService.SYSTEM_PROMPT_HOLDINGS_CAP} entries to keep the
   * prompt small even for very large portfolios.
   *
   * The function is defensive against partial data — missing `symbol`,
   * `assetClass`, or `currency` is rendered as a sensible fallback string.
   */
  private summarizePortfolio(portfolio: {
    holdings?: Record<string, unknown>;
  }): string {
    const holdings = portfolio?.holdings ?? {};
    const entries = Object.values(holdings) as {
      allocationInPercentage?: number;
      assetClass?: string;
      currency?: string;
      name?: string;
      symbol?: string;
    }[];

    if (entries.length === 0) {
      return 'No holdings.';
    }

    return entries
      .slice()
      .sort(
        (a, b) =>
          (b.allocationInPercentage ?? 0) - (a.allocationInPercentage ?? 0)
      )
      .slice(0, AiChatService.SYSTEM_PROMPT_HOLDINGS_CAP)
      .map((h) => {
        const label = h.symbol ?? h.name ?? '(unknown)';
        const assetClass = h.assetClass ?? 'N/A';
        const pct = h.allocationInPercentage;
        const allocation =
          typeof pct === 'number' && Number.isFinite(pct)
            ? (pct * 100).toFixed(2)
            : '0.00';
        const currency = h.currency ?? '';
        return `- ${label} | ${assetClass} | ${allocation}% | ${currency}`;
      })
      .join('\n');
  }

  /**
   * Renders the FinancialProfile row into a compact bullet list suitable for
   * inclusion in the Claude system prompt.
   *
   * The output deliberately does NOT include the user's PII (e.g., name,
   * email, monthly income, debt obligations) — those fields are sensitive
   * and not necessary for the chat agent to answer portfolio questions
   * factually. Including them would broaden the surface for inadvertent
   * disclosure in model responses. The fields rendered are the minimum set
   * required for goal-oriented financial advice.
   *
   * `investmentGoals` is `Json` in the Prisma schema (an array of
   * `{label, targetAmount, targetDate}`); it is JSON-stringified here so
   * Claude can extract individual goal labels for `goalReference` tracking
   * (a concept used by Feature C — Rebalancing — but kept available here for
   * cross-feature consistency).
   */
  private summarizeProfile(profile: {
    investmentGoals?: unknown;
    retirementTargetAge?: number | null;
    retirementTargetAmount?: number | null;
    riskTolerance?: string | null;
    timeHorizonYears?: number | null;
  }): string {
    const investmentGoals = profile.investmentGoals ?? [];

    return [
      `- riskTolerance: ${profile.riskTolerance ?? 'N/A'}`,
      `- retirementTargetAge: ${profile.retirementTargetAge ?? 'N/A'}`,
      `- retirementTargetAmount: ${profile.retirementTargetAmount ?? 'N/A'}`,
      `- timeHorizonYears: ${profile.timeHorizonYears ?? 'N/A'}`,
      `- investmentGoals: ${JSON.stringify(investmentGoals)}`
    ].join('\n');
  }

  /**
   * Dispatches a single Claude `tool_use` block to the corresponding sibling
   * service.
   *
   * SECURITY (AAP § 0.5.1.5): regardless of any `userId` value Claude
   * supplies in `input`, this method substitutes `authenticatedUserId` (the
   * JWT-verified user id from the controller) for every downstream service
   * call. The model cannot escape its authorization boundary by supplying a
   * different `userId` in a tool input — those values are accepted by the
   * input_schema purely so Anthropic's structured tool-use protocol is
   * satisfied; they are NEVER used as a data identifier.
   *
   * Errors from downstream services propagate to the caller, which surfaces
   * them to the model as `is_error` tool results so the assistant can pivot
   * gracefully rather than crashing the whole conversation.
   */
  private async dispatchTool({
    authenticatedUserId,
    input,
    name
  }: {
    authenticatedUserId: string;
    input: unknown;
    name: string;
  }): Promise<unknown> {
    const args = (input ?? {}) as Record<string, unknown>;

    switch (name) {
      case 'get_current_positions': {
        // Override any tool-supplied `userId` with the JWT-authenticated
        // value. `impersonationId: undefined` mirrors the existing controller
        // pattern (no `x-impersonation-id` header sent), which lets
        // `validateImpersonationId` apply its default `aId = ''` and avoids
        // Prisma's "Argument 'id' must not be null" rejection. QA Checkpoint
        // 9 CRITICAL #1 follow-on after the synthetic-REQUEST provider fix.
        const result = await this.portfolioService.getDetails({
          impersonationId: undefined,
          userId: authenticatedUserId
        });
        return { holdings: result?.holdings ?? {} };
      }

      case 'get_performance_metrics': {
        // PortfolioService.getPerformance accepts a `DateRange` enum rather
        // than free-form startDate/endDate. The LLM-supplied date strings
        // are translated to the closest matching `DateRange` value via
        // `mapDatesToDateRange(...)` so the model's date-range request is
        // honored as faithfully as the existing service supports. Falls
        // back to `'max'` for malformed dates, missing inputs, or NaN
        // durations.
        const startDate =
          typeof args.startDate === 'string' ? args.startDate : undefined;
        const endDate =
          typeof args.endDate === 'string' ? args.endDate : undefined;

        const dateRange = this.mapDatesToDateRange(startDate, endDate);

        if (startDate || endDate) {
          Logger.log(
            `get_performance_metrics startDate=${
              startDate ?? '(unset)'
            } endDate=${endDate ?? '(unset)'} → dateRange=${dateRange}`,
            'AiChatService'
          );
        }

        // `impersonationId: undefined` — see `get_current_positions` for the
        // full Prisma-rejection rationale (QA Checkpoint 9 CRITICAL #1
        // follow-on).
        const result = await this.portfolioService.getPerformance({
          dateRange,
          impersonationId: undefined,
          userId: authenticatedUserId
        });

        return {
          chart: result?.chart ?? [],
          firstOrderDate: result?.firstOrderDate ?? null,
          performance: result?.performance ?? null
        };
      }

      case 'query_history': {
        const sql = typeof args.sql === 'string' ? args.sql : '';
        const rawBinds = Array.isArray(args.binds) ? args.binds : [];

        // Narrow each bind value to the union accepted by SnowflakeSyncService
        // — anything else is dropped with `null` to keep the bind ordinal
        // count intact (a length mismatch between `?` placeholders and binds
        // would otherwise throw at the driver layer).
        const binds = rawBinds.map((b): string | number | boolean | null => {
          if (b === null) {
            return null;
          }
          if (
            typeof b === 'string' ||
            typeof b === 'number' ||
            typeof b === 'boolean'
          ) {
            return b;
          }
          return null;
        });

        // SnowflakeSyncService.queryHistory enforces:
        //   - rejection of `;` outside string literals (defense-in-depth)
        //   - 1000-row LIMIT cap (resource boundary)
        // — so AiChatService just forwards the call with the JWT-
        // authoritative userId.
        const rows = await this.snowflakeSyncService.queryHistory(
          authenticatedUserId,
          sql,
          binds
        );
        return { rows };
      }

      case 'get_market_data': {
        const ticker = typeof args.ticker === 'string' ? args.ticker : '';

        if (ticker.length === 0) {
          throw new Error('get_market_data: ticker must be a non-empty string');
        }

        // The data source is server-controlled (DataSource.YAHOO is
        // Ghostfolio's most common ticker resolution provider per AAP
        // § 0.5.1.5); Claude may only supply the ticker symbol. This
        // prevents the model from probing alternative providers.
        const result = await this.symbolService.get({
          dataGatheringItem: {
            dataSource: DataSource.YAHOO,
            symbol: ticker
          }
        });
        return result ?? null;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Maps an LLM-supplied (startDate, endDate) pair to the closest
   * `DateRange` enum value supported by `PortfolioService.getPerformance`.
   *
   * AAP § 0.5.1.5 specifies the `get_performance_metrics` tool input schema
   * accepts free-form `startDate` and `endDate` ISO 8601 strings, but the
   * existing `PortfolioService.getPerformance(...)` API accepts only the
   * enum values defined in `libs/common/src/lib/types/date-range.type.ts`.
   * This helper bridges the two contracts so the model's date-range request
   * is honored as faithfully as the existing service supports. The mapping
   * is deliberately conservative — when in doubt it widens to `'max'`
   * because returning MORE history than asked for is benign (the model can
   * always filter), whereas returning LESS would be a silent contract
   * violation.
   *
   * Mapping (based on the duration `endDate - startDate`):
   *
   * | duration              | DateRange |
   * |-----------------------|-----------|
   * | <= 1 day              | `'1d'`    |
   * | <= 7 days             | `'wtd'`   |
   * | <= 31 days            | `'mtd'`   |
   * | <= 365 days           | `'1y'`    |
   * | <= 1825 days (~5 yrs) | `'5y'`    |
   * | else / unparseable    | `'max'`   |
   *
   * @param startDate Caller-supplied ISO 8601 start date string.
   * @param endDate   Caller-supplied ISO 8601 end date string.
   * @returns         A valid `DateRange` value safe to pass to
   *                  `PortfolioService.getPerformance(...)`.
   */
  private mapDatesToDateRange(
    startDate: string | undefined,
    endDate: string | undefined
  ): DateRange {
    if (!startDate || !endDate) {
      return 'max';
    }

    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      end < start
    ) {
      return 'max';
    }

    const dayMillis = 24 * 60 * 60 * 1000;
    const days = (end - start) / dayMillis;

    if (days <= 1) {
      return '1d';
    }
    if (days <= 7) {
      return 'wtd';
    }
    if (days <= 31) {
      return 'mtd';
    }
    if (days <= 365) {
      return '1y';
    }
    if (days <= 1825) {
      return '5y';
    }
    return 'max';
  }
}
