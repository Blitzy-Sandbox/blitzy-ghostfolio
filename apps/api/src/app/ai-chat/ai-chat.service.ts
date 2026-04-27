import { AiProviderService } from '@ghostfolio/api/app/ai-provider/ai-provider.service';
import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SnowflakeSyncService } from '@ghostfolio/api/app/snowflake-sync/snowflake-sync.service';
import { SymbolService } from '@ghostfolio/api/app/symbol/symbol.service';
import { UserFinancialProfileService } from '@ghostfolio/api/app/user-financial-profile/user-financial-profile.service';
import type { ChatMessage } from '@ghostfolio/common/interfaces';
import type { DateRange } from '@ghostfolio/common/types';

import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { DataSource } from '@prisma/client';
import { CoreMessage, streamText, tool, ToolSet } from 'ai';
import { Observable } from 'rxjs';
import { z } from 'zod';

/**
 * `AiChatService` is the core service for **Feature B — AI Portfolio Chat
 * Agent** described in AAP § 0.1.1, § 0.1.2.4, § 0.5.1.1, and § 0.5.1.5,
 * MIGRATED to the Vercel AI SDK per Refine PR Directive 2.
 *
 * Migration summary (Refine PR Directive 2):
 *   - REMOVED: direct `@anthropic-ai/sdk` `Anthropic` constructor +
 *     `messages.stream(...)` event-emitter loop.
 *   - REMOVED: direct `ConfigService.get('ANTHROPIC_API_KEY' | 'ANTHROPIC_MODEL')`
 *     reads. The provider + model selection is now centralized in the
 *     injected `AiProviderService` (Refine PR Directive 1).
 *   - ADDED: Vercel AI SDK `streamText({ model, tools, messages, system,
 *     maxSteps, abortSignal, ... })`. The `model` is supplied by
 *     `aiProviderService.getModel()`, so any of the four supported
 *     providers (`anthropic`, `openai`, `google`, `ollama`) drives the
 *     stream transparently.
 *   - ADDED: tools defined with Zod `parameters` schemas via the
 *     `tool()` helper from `'ai'`. Each tool's `execute` closure reads
 *     `authenticatedUserId` from the closure scope — the model NEVER
 *     supplies a user identifier in tool arguments, so an LLM-injected
 *     userId spoof is structurally impossible (Refine PR Directive 2).
 *   - ADDED: `AbortController` cancellation. When the SSE subscriber
 *     unsubscribes (browser closes the EventSource, controller request
 *     aborted), the controller signals abortion and the in-flight
 *     `streamText` call terminates cleanly via `abortController.abort()`.
 *   - ADDED: `maxSteps: 8` defense-in-depth bound (matches the previous
 *     `MAX_TOOL_TURNS` ceiling) so a misbehaving model cannot drive an
 *     unbounded chain of tool calls.
 *   - PRESERVED: the three Observability metrics —
 *     `ai_chat_streams_total{outcome}`,
 *     `ai_chat_first_token_latency_seconds`, and
 *     `ai_chat_tool_invocations_total{tool}` — still emitted on the same
 *     event boundaries (one terminal increment, one observation on first
 *     `text-delta`, one increment per `tool-call` event).
 *   - PRESERVED: the SSE protocol envelope (`text`, `tool_call`, `done`,
 *     `error` event types) so existing clients (the Angular
 *     `ChatPanelComponent`) work without any change.
 *   - PRESERVED: PII minimization — the JWT-authenticated user id is
 *     NEVER rendered into the system prompt; the `<authenticated-user>`
 *     placeholder is sent to the model instead (AAP § 0.7.3).
 *
 * Hard rules enforced by this class (AAP § 0.7):
 *
 * - **Rule 1 (Module Isolation):** Cross-module dependencies are reached
 *   only through services explicitly listed in their source module's
 *   `exports` array — `AiProviderService` (AiProviderModule),
 *   `PortfolioService` (PortfolioModule), `SymbolService` (SymbolModule),
 *   `SnowflakeSyncService` (SnowflakeSyncModule),
 *   `UserFinancialProfileService` (UserFinancialProfileModule), and
 *   `MetricsService` (MetricsModule). No imports reach into other feature
 *   module directories.
 *
 * - **Rule 3 (ConfigService) — Indirected:** This service no longer reads
 *   the AI credentials directly; that responsibility moved to
 *   `AiProviderService`. As a result, raw provider environment-variable
 *   accessors (for any of the four supported provider prefixes) are
 *   absent from this file (verified by the static-source-text grep in
 *   `ai-chat.service.spec.ts`).
 *
 * - **JWT-authoritative `userId`:** Every tool's `execute` closure binds
 *   `authenticatedUserId` from `streamChat`'s lexical scope and uses ONLY
 *   that value when calling downstream services — `userId` is not part
 *   of any tool's Zod parameter schema, so the LLM cannot supply a
 *   different value even if it tried (Refine PR Directive 2).
 *
 * - **Stateless protocol:** This service holds no per-conversation
 *   state. The client carries up to 5 messages (4 prior turns + 1 new
 *   user turn — capped by `ChatRequestDto`'s `@ArrayMaxSize(5)`) on
 *   every request.
 *
 * - **Observability (AAP § 0.7.2):** Every `streamChat(...)` invocation
 *   logs start and end events with the caller-supplied `correlationId`
 *   and the per-request `userId`. No API key NEVER appears in any log
 *   line. The static-Logger convention
 *   (`Logger.log(message, 'AiChatService')`) matches the project-wide
 *   pattern (e.g., `snowflake-sync.service.ts`).
 *
 * - **PII minimization (AAP § 0.7.3):** The personalized system prompt
 *   does NOT embed the JWT-authenticated user's literal id; it inserts
 *   the placeholder constant
 *   {@link AiChatService.AUTHENTICATED_USER_PLACEHOLDER}
 *   ("`<authenticated-user>`") instead. This keeps the real Ghostfolio
 *   user id from being transmitted to any external provider on every
 *   chat request.
 */
@Injectable()
export class AiChatService {
  /**
   * Maximum number of `streamText` steps (assistant → tool dispatch →
   * assistant) executed inside the multi-turn loop.
   *
   * The cap is a defense-in-depth bound that prevents a misbehaving
   * model from emitting an unbounded chain of tool calls (e.g., a model
   * bug that keeps re-invoking the same tool). 8 steps are generous
   * enough to support any realistic portfolio question (most resolve in
   * 1–3 steps) while preserving the per-request latency budget per
   * AAP § 0.7.5.2.
   *
   * In Vercel AI SDK terminology: each "step" is one LLM call. A step
   * that finishes with `tool-calls` is followed by an automatic
   * tool-execution step and another LLM call until either the model
   * stops emitting tool calls (natural finish) or the cap is reached.
   */
  private static readonly MAX_TOOL_TURNS = 8;

  /**
   * Maximum number of holdings rendered into the personalized system
   * prompt.
   *
   * A typical portfolio holds 10–30 positions; capping at 25 keeps the
   * system prompt compact while covering the long tail. Holdings are
   * sorted by descending allocation percentage so the most material
   * positions are always included.
   */
  private static readonly SYSTEM_PROMPT_HOLDINGS_CAP = 25;

  /**
   * Placeholder string substituted into the personalized system prompt
   * in place of the JWT-authenticated user's literal id. The model is
   * told to pass this string through verbatim in any free-form
   * reference; tool arguments DO NOT include `userId` at all (the
   * `execute` closures source `authenticatedUserId` from the closure
   * scope), so the placeholder is purely a UX cue for the model.
   *
   * Removing the literal user id from the prompt body keeps the real
   * Ghostfolio user id from being transmitted to the LLM provider on
   * every chat request and satisfies the AAP § 0.7.3 PII minimization
   * requirement.
   */
  private static readonly AUTHENTICATED_USER_PLACEHOLDER =
    '<authenticated-user>';

  /**
   * Counter metric name for chat-stream terminal outcomes. Labelled
   * with `outcome` ∈ {`success`, `error`, `cancelled`}. Cardinality is
   * bounded to 3 distinct label sets — well below the MetricsService
   * cardinality guard threshold.
   */
  private static readonly METRIC_STREAMS_TOTAL = 'ai_chat_streams_total';

  /**
   * Histogram metric name for the latency between request start and
   * the first model-emitted text delta on the SSE stream. No labels
   * — first-token latency is a single user-experience signal regardless
   * of outcome. Recorded only when the request reached the first text
   * event, so error paths that fail before any token arrives do NOT
   * corrupt this signal.
   */
  private static readonly METRIC_FIRST_TOKEN_LATENCY_SECONDS =
    'ai_chat_first_token_latency_seconds';

  /**
   * Counter metric name for individual chat-tool invocations. Labelled
   * with `tool` ∈ the four AAP § 0.5.1.5 tool names. Cardinality is
   * bounded to 4 distinct label sets.
   */
  private static readonly METRIC_TOOL_INVOCATIONS_TOTAL =
    'ai_chat_tool_invocations_total';

  public constructor(
    private readonly aiProviderService: AiProviderService,
    private readonly metricsService: MetricsService,
    private readonly portfolioService: PortfolioService,
    private readonly snowflakeSyncService: SnowflakeSyncService,
    private readonly symbolService: SymbolService,
    private readonly userFinancialProfileService: UserFinancialProfileService
  ) {
    // Register help text for the three Observability metrics
    // (AAP § 0.7.2). `registerHelp` is idempotent — calling it on every
    // service construction is safe and ensures the `# HELP` lines are
    // present in the `/api/v1/metrics` Prometheus exposition output
    // regardless of which service was instantiated first.
    this.metricsService.registerHelp(
      AiChatService.METRIC_STREAMS_TOTAL,
      'Total chat streams completed by terminal outcome (success, error, cancelled).'
    );
    this.metricsService.registerHelp(
      AiChatService.METRIC_FIRST_TOKEN_LATENCY_SECONDS,
      'Latency in seconds between request start and the first text token emitted by the LLM.'
    );
    this.metricsService.registerHelp(
      AiChatService.METRIC_TOOL_INVOCATIONS_TOTAL,
      'Total chat-tool invocations dispatched, labelled by tool name.'
    );
  }

  /**
   * Returns an SSE-compatible `Observable<MessageEvent>` that streams a
   * Vercel AI SDK `streamText(...)` response token-by-token, executes
   * tool calls inline against the four sibling services, and resolves
   * when the model emits a final assistant message containing no
   * further tool calls (or `MAX_TOOL_TURNS` is reached).
   *
   * SSE protocol — every emission is a `MessageEvent` whose `data` field
   * is a small JSON object with a `type` discriminator:
   *
   * - `{ type: 'text', value: string }`     — token delta from the model.
   * - `{ type: 'tool_call', name: string, correlationId }` — server
   *                                                          invoked a chat tool.
   * - `{ type: 'done', correlationId }`     — stream is complete (model
   *                                           emitted no further tool calls).
   * - `{ type: 'error', message, correlationId }` — surfaced before
   *                                                 `subscriber.error(...)`.
   *
   * Cancellation: when the SSE subscriber unsubscribes (e.g., the
   * browser closes the EventSource), the teardown function aborts the
   * `AbortController` linked to the `streamText` call. The Vercel AI
   * SDK terminates the underlying network stream and exits the
   * `for await (... of result.fullStream)` iterator with the
   * `cancelled` outcome.
   *
   * The `userId` parameter is the JWT-authenticated user id sourced
   * from `request.user.id` in the controller. It is the AUTHORITATIVE
   * value used for every downstream service call — tool argument
   * schemas DO NOT include `userId` at all, so the LLM cannot supply a
   * different value even if it tried (Refine PR Directive 2).
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
      // `AbortController` propagates cancellation to the in-flight
      // `streamText` call. The Vercel AI SDK accepts an `abortSignal`
      // and terminates the underlying provider HTTP stream when the
      // signal is fired — much cleaner than the old "flip a boolean
      // and check it at every loop boundary" pattern.
      const abortController = new AbortController();
      let cancelled = false;

      const run = async () => {
        // Capture the request start time once, before any I/O. The
        // first-token latency histogram is observed when the FIRST
        // `text-delta` event fires below; if the request fails before
        // any token arrives, no observation is recorded — keeping the
        // latency signal clean of failure-path noise.
        const startTime = Date.now();
        let firstTokenObserved = false;

        try {
          Logger.log(
            `[${correlationId}] chat stream start userId=${userId} ` +
              `messages=${messages.length}`,
            'AiChatService'
          );

          const systemPrompt = await this.buildSystemPrompt(userId);
          const tools = this.buildTools(userId);

          // Map our `ChatMessage[]` envelope to the Vercel AI SDK's
          // `CoreMessage[]` shape. The `role` and `content` fields share
          // the same wire-format names; the union accepts both
          // `{ role: 'user', content: string }` and
          // `{ role: 'assistant', content: string }`.
          const coreMessages: CoreMessage[] = messages.map((m) => ({
            content: m.content,
            role: m.role
          }));

          // Kick off the SDK's streaming generation. The returned
          // `result` exposes `fullStream` (an AsyncIterable of typed
          // stream parts) which we iterate to translate the Vercel AI
          // SDK's part union into our domain SSE envelope. The
          // `streamText(...)` function does NOT return a Promise — it
          // returns synchronously and the iteration drives the network
          // I/O.
          const result = streamText({
            abortSignal: abortController.signal,
            maxSteps: AiChatService.MAX_TOOL_TURNS,
            messages: coreMessages,
            model: this.aiProviderService.getModel(),
            system: systemPrompt,
            tools
          });

          // Iterate the unified stream. Each `part` is a discriminated
          // union (see `TextStreamPart<TOOLS>` in the `ai` package)
          // covering text deltas, tool calls, tool results, errors,
          // and step boundary markers. We forward only the events that
          // matter to the SSE consumer; the rest are ignored.
          for await (const part of result.fullStream) {
            if (cancelled) {
              break;
            }

            switch (part.type) {
              case 'text-delta': {
                // Record the first-token latency exactly once per
                // request. The flag closure-scoped to `run()` ensures
                // we observe the histogram exactly once even across
                // multiple steps of the multi-turn tool loop (only the
                // FIRST text token across the whole conversation
                // counts as "first token").
                if (!firstTokenObserved) {
                  firstTokenObserved = true;
                  this.metricsService.observeHistogram(
                    AiChatService.METRIC_FIRST_TOKEN_LATENCY_SECONDS,
                    (Date.now() - startTime) / 1000
                  );
                }

                subscriber.next({
                  data: { type: 'text', value: part.textDelta }
                } as MessageEvent);
                break;
              }

              case 'tool-call': {
                // Increment the per-tool counter BEFORE the SDK
                // executes the tool — counting attempts is more useful
                // than counting only successes because tool errors are
                // surfaced back to the model as error tool results
                // (the `execute` closures wrap their bodies in
                // try/catch and return a structured `{ error: ... }`
                // envelope) rather than aborting the stream.
                this.metricsService.incrementCounter(
                  AiChatService.METRIC_TOOL_INVOCATIONS_TOTAL,
                  1,
                  { tool: part.toolName }
                );

                subscriber.next({
                  data: {
                    correlationId,
                    name: part.toolName,
                    type: 'tool_call'
                  }
                } as MessageEvent);
                break;
              }

              case 'error': {
                // The Vercel AI SDK surfaces non-recoverable errors
                // (network failures, invalid API key, rate limit
                // exhaustion) via the `error` part type. We re-throw
                // so the outer try/catch routes the error to
                // `subscriber.error(...)` with the correct outcome
                // counter increment.
                throw part.error instanceof Error
                  ? part.error
                  : new Error(String(part.error));
              }

              // No-ops: `tool-result`, `step-finish`, `finish`,
              // `tool-call-streaming-start`, `tool-call-delta`,
              // `reasoning`, `reasoning-signature`, `redacted-reasoning`,
              // `source`, `file`. The SDK handles tool execution and
              // step bookkeeping internally; we only observe the
              // events the SSE consumer cares about.
              default:
                break;
            }
          }

          if (!cancelled) {
            subscriber.next({
              data: { correlationId, type: 'done' }
            } as MessageEvent);
            subscriber.complete();
            // Success terminal outcome (AAP § 0.7.2). Emitted exactly
            // once per request — the `cancelled` short-circuit below
            // ensures the cancellation path emits `cancelled` instead.
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
            // Cancellation terminal outcome (AAP § 0.7.2). Reached
            // when the SSE subscriber unsubscribed mid-stream (browser
            // closed the EventSource, controller request aborted) and
            // the loop bailed out cleanly without an exception.
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

          // Error terminal outcome (AAP § 0.7.2). Recorded regardless
          // of whether the subscriber is still attached so failures
          // are always counted; the SSE error frame is only emitted
          // while the subscriber is still subscribed.
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

      // Kick off the async runner. The Promise it returns is
      // intentionally discarded — errors are routed through
      // `subscriber.error(...)` inside the try/catch above.
      void run();

      // Teardown hook: when the subscriber unsubscribes (browser
      // closed, controller request aborted), flip the cancelled flag
      // AND fire the AbortController so the in-flight `streamText`
      // call terminates immediately rather than continuing to consume
      // model tokens (which would still be billable).
      return () => {
        cancelled = true;
        try {
          abortController.abort();
        } catch {
          // `abort()` is documented as never throwing, but defending
          // against runtime quirks keeps the teardown function
          // truly side-effect-free from the subscriber's perspective.
        }
      };
    });
  }

  /**
   * Returns the four chat-agent tool definitions registered with every
   * `streamText(...)` call.
   *
   * Each tool is created via the Vercel AI SDK's `tool({...})` helper
   * and includes:
   *
   *   - `description`: a free-form natural-language description used by
   *     the model for tool selection.
   *   - `parameters`: a Zod schema describing the input the model is
   *     allowed to supply. CRITICAL — `userId` is NOT part of any
   *     schema; the `execute` closure reads `authenticatedUserId` from
   *     the lexical scope. This makes LLM-injected userId spoofing
   *     structurally impossible (Refine PR Directive 2).
   *   - `execute`: an async closure that performs the actual work
   *     against the appropriate sibling service (PortfolioService,
   *     SymbolService, SnowflakeSyncService). The closure body wraps
   *     the dispatch in a try/catch so a failure in a single tool does
   *     NOT abort the stream — instead it surfaces a structured
   *     `{ error: ... }` envelope back to the model, which can pivot
   *     gracefully.
   *
   * The four tools (per AAP § 0.5.1.5):
   *
   *   1. `get_current_positions()` — current portfolio holdings.
   *   2. `get_performance_metrics({ startDate, endDate })` — TWR + chart.
   *   3. `query_history({ sql, binds })` — parameterized read-only
   *      Snowflake SQL via `snowflake-sdk` bind variables (Rule 2).
   *   4. `get_market_data({ ticker })` — current price for a single
   *      ticker.
   *
   * @param authenticatedUserId The JWT-authenticated user id captured
   *                            in every tool's `execute` closure.
   */
  private buildTools(authenticatedUserId: string): ToolSet {
    return {
      get_current_positions: tool({
        description:
          "Returns the authenticated user's current portfolio holdings, " +
          'including ticker, asset class, allocation percentage, currency, ' +
          'and current market value in base currency. Use this when the ' +
          'user asks about their current portfolio composition or specific ' +
          'holdings. The userId is server-supplied automatically — do NOT ' +
          'attempt to provide it.',
        // No tool input parameters. The authenticated user id is
        // supplied by the closure; the LLM cannot influence it.
        parameters: z.object({}),
        execute: async () => {
          try {
            // `impersonationId: undefined` mirrors the existing
            // controller pattern (no `x-impersonation-id` header).
            // Passing `null` is rejected by Prisma because
            // `Access.id` is non-nullable. QA Checkpoint 9 CRITICAL #1
            // follow-on after the synthetic-REQUEST provider fix.
            const result = await this.portfolioService.getDetails({
              impersonationId: undefined,
              userId: authenticatedUserId
            });
            return { holdings: result?.holdings ?? {} };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
      }),
      get_performance_metrics: tool({
        description:
          "Returns the authenticated user's portfolio performance " +
          'metrics for a date range. Includes time-weighted return ' +
          '(TWR), net performance, current value, and historical chart ' +
          'points. Use this when the user asks about returns, ' +
          'performance, or growth over a period. The userId is ' +
          'server-supplied automatically — do NOT attempt to provide it.',
        parameters: z.object({
          endDate: z
            .string()
            .describe(
              'End of the performance window in ISO 8601 (YYYY-MM-DD).'
            ),
          startDate: z
            .string()
            .describe(
              'Start of the performance window in ISO 8601 (YYYY-MM-DD).'
            )
        }),
        execute: async ({ endDate, startDate }) => {
          try {
            const dateRange = this.mapDatesToDateRange(startDate, endDate);

            if (startDate || endDate) {
              Logger.log(
                `get_performance_metrics startDate=${
                  startDate ?? '(unset)'
                } endDate=${endDate ?? '(unset)'} → dateRange=${dateRange}`,
                'AiChatService'
              );
            }

            // `impersonationId: undefined` — see
            // `get_current_positions` for the full Prisma-rejection
            // rationale (QA Checkpoint 9 CRITICAL #1 follow-on).
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
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
      }),
      query_history: tool({
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
          'currency, synced_at); performance_metrics(metric_date, ' +
          'user_id, twr, volatility, sharpe_ratio). The userId is ' +
          'server-supplied automatically — do NOT attempt to provide it.',
        parameters: z.object({
          binds: z
            .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .describe(
              'Array of bind values matching ? placeholders in the sql, ' +
                'in order. Allowed types: string, number, boolean, null.'
            ),
          sql: z
            .string()
            .describe(
              'Parameterized SELECT statement using ? placeholders. ' +
                'Must NOT contain semicolons outside string literals. ' +
                'Server enforces a 1000-row LIMIT cap.'
            )
        }),
        execute: async ({ binds, sql }) => {
          try {
            // `SnowflakeSyncService.queryHistory` enforces:
            //   - rejection of `;` outside string literals (defense-
            //     in-depth)
            //   - 1000-row LIMIT cap (resource boundary)
            // — so AiChatService just forwards the call with the JWT-
            // authoritative userId.
            const rows = await this.snowflakeSyncService.queryHistory(
              authenticatedUserId,
              sql,
              binds
            );
            return { rows };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
      }),
      get_market_data: tool({
        description:
          'Returns current market price, currency, and asset metadata ' +
          'for a single ticker symbol. Use this when the user asks ' +
          'about a specific stock/ETF/asset that may or may not be in ' +
          'their portfolio.',
        parameters: z.object({
          ticker: z
            .string()
            .min(1)
            .describe('Ticker symbol (e.g., AAPL, MSFT, VOO).')
        }),
        execute: async ({ ticker }) => {
          try {
            // The data source is server-controlled (DataSource.YAHOO is
            // Ghostfolio's most common ticker resolution provider per
            // AAP § 0.5.1.5); the LLM may only supply the ticker
            // symbol. This prevents the model from probing alternative
            // providers.
            const result = await this.symbolService.get({
              dataGatheringItem: {
                dataSource: DataSource.YAHOO,
                symbol: ticker
              }
            });
            return result ?? null;
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
      })
    };
  }

  /**
   * Builds the personalized system prompt for a given authenticated
   * user.
   *
   * The prompt is assembled once per request and combines:
   *   - Static instruction text (assistant role + tool usage guidance).
   *   - The authenticated user id placeholder used in free-form
   *     references.
   *   - A compact summary of the user's current holdings (top N by
   *     allocation, fetched from `PortfolioService.getDetails(...)`).
   *   - A summary of the user's stated `FinancialProfile` (risk
   *     tolerance, retirement targets, time horizon, investment goals)
   *     — read through `UserFinancialProfileService.findByUserId(...)`.
   *
   * Both downstream calls are wrapped with `.catch(() => null)` so
   * that a transient failure on either side (e.g., Prisma not yet
   * ready, no `FinancialProfile` row) does not block the chat — the
   * prompt simply renders a graceful placeholder.
   */
  private async buildSystemPrompt(
    authenticatedUserId: string
  ): Promise<string> {
    // Both downstream calls run in parallel via `Promise.all` and each
    // returns its own narrowed shape (or `null` on failure). The two
    // private helpers exist to give the destructured tuple explicit
    // non-`any` element types — without them, structural complexity
    // in the upstream Prisma / portfolio types would cause `portfolio`
    // and `profile` to be widened to `any` at the destructuring site.
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
    // transmitted to any LLM provider. The placeholder constant
    // `AUTHENTICATED_USER_PLACEHOLDER` is sent instead. Tool
    // arguments DO NOT include `userId` at all; the `execute` closures
    // source `authenticatedUserId` from the closure scope.
    return [
      `You are a helpful AI portfolio assistant integrated with Ghostfolio.`,
      `When you need to refer to the authenticated user in free-form ` +
        `text, use the placeholder identifier ` +
        `"${AiChatService.AUTHENTICATED_USER_PLACEHOLDER}". The server ` +
        `automatically applies the JWT-authenticated user id to every ` +
        `tool dispatch — tool inputs DO NOT accept a userId argument.`,
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
   * Fetches the user's current portfolio for the personalized system
   * prompt.
   *
   * Returns a deliberately narrow shape (`{ holdings?:
   * Record<string, unknown> }`) — the only field
   * {@link AiChatService.summarizePortfolio} inspects — so the
   * destructured tuple in {@link buildSystemPrompt} has a sound
   * static type. A transient failure (Prisma not yet ready, market
   * data provider down) is logged at WARN level and resolves to
   * `null` so the chat does not block on a non-essential
   * personalization step.
   */
  private async fetchPortfolioForPrompt(
    userId: string
  ): Promise<{ holdings?: Record<string, unknown> } | null> {
    try {
      // `impersonationId: undefined` mirrors the existing-controller
      // pattern (no `x-impersonation-id` header). Passing `null` is
      // rejected by Prisma because `Access.id` is non-nullable. QA
      // Checkpoint 9 CRITICAL #1 follow-on after the synthetic-REQUEST
      // provider fix.
      const result = await this.portfolioService.getDetails({
        impersonationId: undefined,
        userId
      });

      // The `as unknown as` double-cast is intentional: the upstream
      // `PortfolioDetails` interface has a deeply-typed `holdings`
      // map, and forcing it through `unknown` narrows the value to
      // exactly the shape this service consumes (the symbol-keyed
      // dictionary the summarizer reads).
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
   * prompt. Returns `null` when no record exists or when the
   * underlying Prisma call fails. Errors are logged at WARN level —
   * `findByUserId` itself returns `null` (not throw) for the
   * no-record case (per
   * `UserFinancialProfileService.findByUserId`), so the catch block
   * here only fires on transport / Prisma exceptions.
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
   * Renders the holdings dictionary returned by
   * `PortfolioService.getDetails` into a compact bullet list suitable
   * for inclusion in the LLM system prompt.
   *
   * Each holding is formatted as:
   *
   *   `- SYMBOL | ASSET_CLASS | XX.XX% | CURRENCY`
   *
   * Holdings are sorted by descending `allocationInPercentage` and
   * capped at {@link AiChatService.SYSTEM_PROMPT_HOLDINGS_CAP}
   * entries to keep the prompt small even for very large portfolios.
   *
   * The function is defensive against partial data — missing
   * `symbol`, `assetClass`, or `currency` is rendered as a sensible
   * fallback string.
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
   * Renders the FinancialProfile row into a compact bullet list
   * suitable for inclusion in the LLM system prompt.
   *
   * The output deliberately does NOT include the user's PII (e.g.,
   * name, email, monthly income, debt obligations) — those fields
   * are sensitive and not necessary for the chat agent to answer
   * portfolio questions factually. Including them would broaden the
   * surface for inadvertent disclosure in model responses. The
   * fields rendered are the minimum set required for goal-oriented
   * financial advice.
   *
   * `investmentGoals` is `Json` in the Prisma schema (an array of
   * `{label, targetAmount, targetDate}`); it is JSON-stringified
   * here so the model can extract individual goal labels for
   * `goalReference` tracking (a concept used by Feature C —
   * Rebalancing — but kept available here for cross-feature
   * consistency).
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
   * Maps an LLM-supplied (startDate, endDate) pair to the closest
   * `DateRange` enum value supported by
   * `PortfolioService.getPerformance`.
   *
   * AAP § 0.5.1.5 specifies the `get_performance_metrics` tool
   * accepts free-form `startDate` and `endDate` ISO 8601 strings,
   * but the existing `PortfolioService.getPerformance(...)` API
   * accepts only the enum values defined in
   * `libs/common/src/lib/types/date-range.type.ts`. This helper
   * bridges the two contracts so the model's date-range request is
   * honored as faithfully as the existing service supports. The
   * mapping is deliberately conservative — when in doubt it widens
   * to `'max'` because returning MORE history than asked for is
   * benign (the model can always filter), whereas returning LESS
   * would be a silent contract violation.
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
