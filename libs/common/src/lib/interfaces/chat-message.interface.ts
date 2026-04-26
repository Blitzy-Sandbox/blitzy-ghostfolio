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
 * Wire-format chat message exchanged over `POST /api/v1/ai/chat`.
 *
 * The client sends an array of these (capped at 5 entries — 4 prior turns
 * plus the new user turn — per AAP § 0.7.3 and the server-side
 * `@ArrayMaxSize(5)` validator). The server streams responses back as
 * Server-Sent Events whose `data:` payload is a JSON-serialized
 * {@link ChatMessage} of role `'assistant'`.
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
