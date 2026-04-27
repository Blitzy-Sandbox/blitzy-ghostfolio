/**
 * Discriminator for the source of a chat message in the AI chat protocol.
 *
 * Only two roles are wire-transmitted between the Angular client and the
 * NestJS API:
 *
 * - `'user'` — text typed by the human in the chat panel.
 * - `'assistant'` — text returned by the streaming Anthropic model.
 *
 * **Why `'system'` is intentionally omitted**: the Anthropic Messages API
 * carries the system prompt as a top-level `system: string` parameter on
 * `messages.create(...)` / `messages.stream(...)`, NOT as an entry in the
 * `messages` array. Per AAP § 0.5.1.2, the chat-agent system prompt is
 * personalized server-side at request time using the authenticated user's
 * `FinancialProfile` and live portfolio state, and it MUST never be
 * transmitted from the client (which would let any caller override the
 * server's authorization-bound personalization).
 *
 * Adding `'system'` to this union would falsely suggest that clients are
 * permitted to send system messages; that path is disallowed by Rule 5
 * (FinancialProfile authorization) and the `ChatRequestDto` server-side
 * validation rejects any non-`'user' | 'assistant'` role.
 */
export type ChatMessageRole = 'user' | 'assistant';

/**
 * Wire-format chat message exchanged on the **request** side of
 * `POST /api/v1/ai/chat` and held in the client-side conversation history.
 *
 * The client sends an array of these (capped at 5 entries — 4 prior turns
 * plus the new user turn — per AAP § 0.7.3 and the server-side
 * `@ArrayMaxSize(5)` validator). The same shape is also used for messages
 * appended to the `ChatPanelComponent.messages()` signal: every entry in
 * that signal MUST satisfy this interface so the next user send can
 * forward the conversation history without triggering server-side
 * `class-validator` errors (cf. QA Checkpoint 11 Issue 2).
 *
 * The **response** side of `POST /api/v1/ai/chat` does NOT use this shape
 * directly. The server streams Server-Sent Events whose `data:` payload
 * is a JSON-serialized {@link ChatStreamFrame} (see below). The client
 * parses each `text` frame into a `ChatMessage` of role `'assistant'`
 * before appending to the conversation history.
 */
export interface ChatMessage {
  /** Source role; see {@link ChatMessageRole}. */
  role: ChatMessageRole;
  /** Message body (plain text, UTF-8). */
  content: string;
  /**
   * Optional client-supplied timestamp. Treated as advisory by the server
   * (no authority for ordering, audit, or rate-limiting). Use a numeric
   * `Date.now()` value for the client's own bookkeeping; the API ignores
   * the field on the request side.
   */
  timestamp?: string | number;
}

/**
 * On-the-wire shape of a single Server-Sent Event `data:` payload emitted
 * by `POST /api/v1/ai/chat`.
 *
 * **Why this is not `ChatMessage`**: the server emits a discriminated
 * union of four event kinds (`text`, `tool_call`, `done`, `error`) so the
 * client can distinguish token deltas from terminal events without text
 * heuristics. Casting raw frames to {@link ChatMessage} — as the client
 * previously did — produced malformed entries with no `role` and no
 * `content`, which (a) silently violated Rule 6 (SSE error handling)
 * because `error` frames were never routed to `subject.error(...)`, and
 * (b) corrupted the conversation-history array sent on the next request,
 * causing cascading HTTP 400 responses (QA Checkpoint 11 Issues 1 and 2).
 *
 * The single source of truth for the emit code is
 * `apps/api/src/app/ai-chat/ai-chat.service.ts`. This interface mirrors
 * those emit sites; any change there MUST be reflected here and in the
 * client's `parseSseFrame(...)` discriminator.
 */
export type ChatStreamFrame =
  | ChatStreamTextFrame
  | ChatStreamToolCallFrame
  | ChatStreamDoneFrame
  | ChatStreamErrorFrame;

/**
 * A token (or token group) delta in the assistant's reply. The client
 * concatenates consecutive `text` frames into a single rendered message.
 */
export interface ChatStreamTextFrame {
  type: 'text';
  /** Plain-text token slice; appended to the in-progress assistant turn. */
  value: string;
}

/**
 * Notification that the server has dispatched one of the four AI chat
 * tools (`get_current_positions`, `get_performance_metrics`,
 * `query_history`, `get_market_data`) per AAP § 0.5.1.5. The client is
 * not required to render anything for this frame; the chat panel
 * currently filters it. The `correlationId` is propagated for
 * end-to-end tracing per AAP § 0.7.2 (Observability).
 */
export interface ChatStreamToolCallFrame {
  type: 'tool_call';
  /** Tool name (e.g., `'get_current_positions'`). */
  name: string;
  /** Per-request UUID generated at the API controller boundary. */
  correlationId: string;
}

/**
 * Sentinel frame indicating clean stream termination. The client maps
 * this to `Subject.complete()` and stops appending tokens to the
 * in-progress assistant turn.
 */
export interface ChatStreamDoneFrame {
  type: 'done';
  /** Per-request UUID generated at the API controller boundary. */
  correlationId: string;
}

/**
 * Server-side error surfaced via the SSE channel. The server emits this
 * frame BEFORE calling `subscriber.error(...)` so the client receives a
 * structured payload (with a user-friendly `message` and a
 * `correlationId` for support diagnosis) even when the underlying
 * NestJS `@Sse()` lowering of `subscriber.error(...)` produces a
 * non-JSON `event: error` directive after it.
 *
 * The client maps this to `Subject.error(...)`, which Rule 6 / AAP
 * § 0.7.1.6 requires `ChatPanelComponent` to translate into a non-empty
 * `errorMessage` signal value plus a visible Reconnect button.
 */
export interface ChatStreamErrorFrame {
  type: 'error';
  /** User-facing error message; safe to render in the UI verbatim. */
  message: string;
  /** Per-request UUID generated at the API controller boundary. */
  correlationId: string;
}
