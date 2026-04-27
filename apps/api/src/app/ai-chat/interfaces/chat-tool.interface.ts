/**
 * TypeScript shapes for Claude tool inputs in the AI Portfolio Chat Agent
 * (Feature B), per AAP § 0.5.1.1 and § 0.5.1.5.
 *
 * The Anthropic SDK supplies `tool_use.input` as `unknown` (typed as `any` at
 * the SDK boundary). These interfaces narrow that `unknown` to concrete shapes
 * after the `tool_use.name` switch in `AiChatService.dispatchTool(...)` so the
 * service's switch arms have full IntelliSense and compile-time safety.
 *
 * SECURITY: The `userId` field on every tool input is server-OVERRIDDEN with
 * the JWT-authenticated userId (per AAP § 0.5.1.5 and § 0.7.3). NEVER trust
 * the `userId` value Claude supplies; use it only for log correlation if at
 * all. The authoritative userId comes from `request.user.id` in the
 * controller.
 *
 * This file is pure type-only — no imports, no values, no runtime emission.
 */

/**
 * Input shape for the `get_current_positions` Claude tool call.
 *
 * Maps to `PortfolioService.getDetails({ impersonationId: undefined, userId })`
 * dispatched in `AiChatService.dispatchTool(...)`. The `userId` value is
 * server-overridden — see file header.
 */
export interface GetCurrentPositionsInput {
  userId: string;
}

/**
 * Input shape for the `get_performance_metrics` Claude tool call.
 *
 * Maps to `PortfolioService.getPerformance({ ... })` dispatched in
 * `AiChatService.dispatchTool(...)`. `startDate` / `endDate` are ISO 8601
 * date strings (`YYYY-MM-DD`).
 */
export interface GetPerformanceMetricsInput {
  endDate: string;
  startDate: string;
  userId: string;
}

/**
 * Input shape for the `query_history` Claude tool call.
 *
 * Maps to `SnowflakeSyncService.queryHistory(userId, sql, binds)` dispatched
 * in `AiChatService.dispatchTool(...)`. The `binds` array MUST be supplied
 * via Snowflake's bind-variable mechanism (Rule 2, AAP § 0.7.1.2) — the
 * service NEVER interpolates `binds` values into the `sql` string.
 *
 * The `binds` element type is the JSON-serializable union supported by
 * `snowflake-sdk`'s `connection.execute({ sqlText, binds })`. Anthropic
 * itself only emits JSON primitives in tool inputs.
 */
export interface QueryHistoryInput {
  binds: (string | number | boolean | null)[];
  sql: string;
  userId: string;
}

/**
 * Input shape for the `get_market_data` Claude tool call.
 *
 * Maps to `SymbolService.get({ dataGatheringItem: { dataSource, symbol: ticker } })`
 * dispatched in `AiChatService.dispatchTool(...)`. Unlike the other three
 * tool inputs, this one does not include a `userId` because market data is
 * not user-scoped.
 */
export interface GetMarketDataInput {
  ticker: string;
}

/**
 * Discriminated-union of supported tool names used by the chat agent. The
 * `name` property of an Anthropic `tool_use` content block is asserted
 * against this union before dispatch in `AiChatService.dispatchTool(...)`.
 */
export type ChatToolName =
  | 'get_current_positions'
  | 'get_market_data'
  | 'get_performance_metrics'
  | 'query_history';

/**
 * Discriminated union of tool-call payloads keyed by the tool `name`. Used by
 * the service's `dispatchTool(...)` switch to narrow `input` to the correct
 * concrete shape based on the discriminating `name` literal.
 *
 * Example consumption inside `AiChatService.dispatchTool(...)`:
 *
 *   switch (toolCall.name) {
 *     case 'get_current_positions': {
 *       // toolCall.input is narrowed to GetCurrentPositionsInput
 *       ...
 *     }
 *     ...
 *   }
 */
export type ChatToolInput =
  | { input: GetCurrentPositionsInput; name: 'get_current_positions' }
  | { input: GetMarketDataInput; name: 'get_market_data' }
  | { input: GetPerformanceMetricsInput; name: 'get_performance_metrics' }
  | { input: QueryHistoryInput; name: 'query_history' };
