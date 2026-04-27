import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { ChatMessage } from '@ghostfolio/common/interfaces';

import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/**
 * Server endpoint for the streaming AI Portfolio Chat Agent (Feature B).
 *
 * Per AAP § 0.1.1.1, all backend routes are URI-versioned through `/api/v1`.
 */
const CHAT_ENDPOINT = '/api/v1/ai/chat';

/**
 * Discriminated interpretation of a single Server-Sent Events frame.
 *
 * `parseSseFrame(...)` returns one of these so the consumer (`consumeStream`)
 * can react to terminal events (`error`, `complete`) without losing the
 * imperative semantics of `Subject.error()` / `Subject.complete()`.
 *
 * **Why this exists**: the previous implementation cast every parsed frame
 * directly to `ChatMessage` and emitted it via `subject.next(...)`. Because
 * the backend's actual on-the-wire SSE protocol is a discriminated union
 * (`{type:'text'|'tool_call'|'done'|'error', ...}` — documented in
 * `apps/api/src/app/ai-chat/ai-chat.service.ts`), every frame produced a
 * malformed `ChatMessage` (no `role`, no `content`) and `error`/`done`
 * frames were silently absorbed instead of routed to `subject.error()` /
 * `subject.complete()`. This caused QA Checkpoint 11 Issue 1 (Rule 6
 * violation: silent SSE failures with no UI state change) and Issue 2
 * (cascading state corruption when the malformed message was forwarded to
 * the backend on subsequent requests).
 *
 * Each variant maps to a precise consumer action:
 *   - `'message'`  — emit the translated `ChatMessage` via `subject.next`.
 *   - `'error'`    — call `subject.error` and exit the read loop.
 *   - `'complete'` — call `subject.complete` and exit the read loop.
 *   - `'ignore'`   — skip the frame (tool-call notifications, comments,
 *                    unparseable JSON, unknown types — never poison the
 *                    stream on a single bad frame).
 */
type SseFrameInterpretation =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'error'; error: Error }
  | { kind: 'complete' }
  | { kind: 'ignore' };

/**
 * Client-side wrapper for the streaming AI Portfolio Chat Agent endpoint.
 *
 * **Why this service uses `fetch` + `ReadableStream` instead of `EventSource`**:
 * the chat endpoint is `POST /api/v1/ai/chat` and carries a JSON message-array
 * body. The browser's native `EventSource` API is GET-only — it cannot send a
 * request body — so it is not a valid client for this endpoint. We therefore
 * use `fetch(..., { signal })` and read the response body via
 * `response.body.getReader()` plus a `TextDecoder`, parsing Server-Sent Event
 * frames manually.
 *
 * **Why this service handles its own `Authorization` header**: the Angular
 * `AuthInterceptor` is registered on `HttpClient` and does not see `fetch(...)`
 * requests. To keep the SSE call authenticated, this service reads the JWT
 * from {@link TokenStorageService} and sets `Authorization: Bearer <token>`
 * on the outgoing fetch directly. Other client services in this feature
 * (`RebalancingService`, `FinancialProfileService`) use `HttpClient` and
 * therefore inherit `AuthInterceptor`'s behavior automatically.
 *
 * **Subject lifecycle**: `openStream(...)` returns a hot `Observable<ChatMessage>`
 * backed by an internal `Subject`. The subject completes when:
 *   - the server emits a `{type:'done'}` data frame, OR
 *   - the response body reaches EOF, OR
 *   - the user calls `closeStream()` (treated as a clean cancel).
 * It errors when:
 *   - the server emits a `{type:'error', message}` data frame, OR
 *   - the server emits an `event: error` SSE directive (NestJS lowering of
 *     `subscriber.error(...)`), OR
 *   - the network or HTTP response status fails.
 *
 * **Backend protocol contract**: the server emits SSE frames whose `data:`
 * payload is a JSON-serialized discriminated union with these shapes (see
 * `apps/api/src/app/ai-chat/ai-chat.service.ts` for the source-of-truth
 * definitions):
 *
 *   - `{ type: 'text', value: string }`                                — token delta from the model.
 *                                                                       Translated into a `ChatMessage` of role `'assistant'`
 *                                                                       and `content = value` and forwarded to subscribers.
 *   - `{ type: 'tool_call', name: string, correlationId: string }`     — server invoked a chat tool. Currently filtered
 *                                                                       (the chat panel does not render tool dispatches).
 *   - `{ type: 'done', correlationId: string }`                        — stream is complete; routed to `subject.complete()`.
 *   - `{ type: 'error', message: string, correlationId: string }`      — server-side failure; routed to `subject.error()`.
 *
 * Cancellation: `closeStream()` aborts the in-flight request via
 * `AbortController`. `AbortError` is treated as a clean cancel (the subject
 * completes), NOT an error.
 */
@Injectable({ providedIn: 'root' })
export class AiChatService {
  private abortController: AbortController | null = null;

  public constructor(private tokenStorageService: TokenStorageService) {}

  /**
   * Opens an SSE-style streaming chat exchange. Closes any pre-existing
   * stream first so concurrent calls cannot leak request handles.
   *
   * The supplied `messages` array is sent verbatim as the request body. The
   * caller (typically `ChatPanelComponent`) is responsible for trimming the
   * array to the server-imposed maximum (`@ArrayMaxSize(5)` on the DTO).
   *
   * The returned observable emits one `ChatMessage` per parsed `text` SSE
   * frame and completes when the stream terminates cleanly (a `done` frame
   * or response EOF).
   */
  public openStream(messages: ChatMessage[]): Observable<ChatMessage> {
    this.closeStream();

    const subject = new Subject<ChatMessage>();
    const abortController = new AbortController();

    this.abortController = abortController;

    const token = this.tokenStorageService.getToken();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json'
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    void this.consumeStream(messages, headers, abortController, subject);

    return subject.asObservable();
  }

  /**
   * Aborts any active streaming request. Idempotent — calling on an already
   * closed or never-opened stream is a no-op. The abort triggers the
   * fetch promise chain in {@link consumeStream} to enter its `AbortError`
   * branch, which completes (does not error) the subject.
   */
  public closeStream(): void {
    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Drives the actual `fetch` + `ReadableStream` reading loop. Kept private
   * so the public surface (`openStream` / `closeStream`) presents a clean
   * RxJS contract independent of `fetch` implementation details.
   *
   * The reader loop terminates and exits the function on the first of:
   *   1. a parsed SSE frame whose interpretation is `'error'`  → `subject.error(...)`;
   *   2. a parsed SSE frame whose interpretation is `'complete'` → `subject.complete()`;
   *   3. response-body EOF (`reader.read()` returns `{done: true}`) → `subject.complete()`;
   *   4. an exception thrown from `fetch` / `reader.read()`     → `subject.error(...)` (or
   *                                                              `subject.complete()` for `AbortError`).
   *
   * Returning early from inside the for-of loop is intentional: the
   * surrounding try/catch/finally still executes the finally block, which
   * clears `this.abortController` so a subsequent `openStream(...)` does
   * not double-abort an already completed request.
   */
  private async consumeStream(
    messages: ChatMessage[],
    headers: Record<string, string>,
    abortController: AbortController,
    subject: Subject<ChatMessage>
  ): Promise<void> {
    try {
      const response = await fetch(CHAT_ENDPOINT, {
        body: JSON.stringify({ messages }),
        headers,
        method: 'POST',
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`Chat stream failed with HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Chat stream has no response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const segments = buffer.split('\n\n');
        buffer = segments.pop() ?? '';

        for (const segment of segments) {
          const interpretation = this.parseSseFrame(segment);

          switch (interpretation.kind) {
            case 'message':
              subject.next(interpretation.message);
              break;
            case 'error':
              // The server signaled a failure (either via a `{type:'error'}`
              // data frame or an `event: error` SSE directive). Route it
              // through `subject.error(...)` so `ChatPanelComponent`'s
              // error handler fires (Rule 6 / AAP § 0.7.1.6) and exit the
              // read loop. The `finally` block clears `abortController`.
              subject.error(interpretation.error);
              return;
            case 'complete':
              // The server signaled clean stream completion via a
              // `{type:'done'}` data frame. Complete the subject and exit
              // — any subsequent bytes in the response body are ignored.
              subject.complete();
              return;
            case 'ignore':
              // Tool-call notifications, comments, blank frames, unparseable
              // JSON, and unknown discriminator values all land here.
              // Silently skip — a single bad frame must NEVER poison the
              // stream.
              break;
          }
        }
      }

      // Reader EOF without an explicit `done` frame — treat as clean
      // completion. This branch covers servers that close the connection
      // immediately after the final assistant turn without a sentinel.
      subject.complete();
    } catch (error) {
      if (this.isAbortError(error)) {
        subject.complete();

        return;
      }

      subject.error(error);
    } finally {
      // Clear the controller reference if it still points at this stream so
      // a subsequent `openStream(...)` call does not double-abort an already
      // completed request.
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  /**
   * Parses a single SSE frame into a {@link SseFrameInterpretation} tagged
   * union. The tag tells the caller exactly what to do with the frame:
   * emit a translated `ChatMessage`, terminate the subject with an error,
   * complete the subject, or skip the frame.
   *
   * Frame shape (per SSE spec): one or more `data:` lines, optionally
   * accompanied by `event:`, `id:`, or `retry:` directive lines. Multiple
   * `data:` lines within a single frame are joined with `\n` per the spec.
   * Lines beginning with `:` are SSE comments and are ignored.
   *
   * Backend protocol (see `apps/api/src/app/ai-chat/ai-chat.service.ts`):
   *
   *   - `data: {"type":"text","value":"..."}`                  → `'message'` (assistant turn)
   *   - `data: {"type":"tool_call","name":"...","correlationId":"..."}` → `'ignore'`
   *   - `data: {"type":"done","correlationId":"..."}`          → `'complete'`
   *   - `data: {"type":"error","message":"...","correlationId":"..."}` → `'error'`
   *   - `data: [DONE]`                                         → `'complete'` (legacy sentinel)
   *   - `event: error\ndata: ...`                              → `'error'` (NestJS lowering of `subscriber.error(...)`)
   *   - everything else                                        → `'ignore'`
   *
   * Defensive coding: `JSON.parse` failures and unknown discriminator
   * values both resolve to `'ignore'`. A single malformed frame must never
   * tear down a healthy stream — that would be a regression of Rule 6's
   * spirit (silent failures are prohibited; resilient parsing avoids them).
   */
  private parseSseFrame(frame: string): SseFrameInterpretation {
    const dataLines: string[] = [];
    let eventName: string | null = null;

    for (const line of frame.split('\n')) {
      if (line.startsWith(':') || line.length === 0) {
        continue;
      }

      if (line.startsWith('data:')) {
        // Per SSE spec, a single space immediately following `data:` is a
        // delimiter and should be stripped; any subsequent leading
        // whitespace is part of the payload.
        const remainder = line.slice(5);

        dataLines.push(
          remainder.startsWith(' ') ? remainder.slice(1) : remainder
        );
      } else if (line.startsWith('event:')) {
        // Track the SSE `event:` name so we can recognize NestJS's
        // lowering of `subscriber.error(...)`, which produces
        // `event: error\nid: N\ndata: ...` frames whose `data:` payload
        // is NOT JSON-shaped (it is the raw `Error.message` or HTTP body
        // string). Without recognizing this directive the error event
        // would silently route to the `'ignore'` branch below.
        const remainder = line.slice(6);

        eventName = (
          remainder.startsWith(' ') ? remainder.slice(1) : remainder
        ).trim();
      }
      // `id:` and `retry:` directives are deliberately not parsed —
      // they have no semantic effect on this client (we never reconnect
      // by id, and retry intervals are server-managed).
    }

    if (dataLines.length === 0 && eventName === null) {
      return { kind: 'ignore' };
    }

    const payload = dataLines.join('\n');

    // SSE `event: error` lowering (NestJS `@Sse()` translation of
    // `subscriber.error(err)`). Treat as a stream failure regardless of
    // whether the payload happens to be JSON-shaped.
    if (eventName === 'error') {
      const detail = payload.length > 0 ? payload : 'Chat stream error';

      return { kind: 'error', error: new Error(detail) };
    }

    // Legacy `[DONE]` sentinel — matches OpenAI-compatible streaming
    // protocols that some upstream tools emit. Cheap to support and does
    // not conflict with any other discriminator.
    if (payload === '[DONE]') {
      return { kind: 'complete' };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(payload);
    } catch {
      // Tolerate malformed frames silently — a single bad frame must not
      // poison the entire stream.
      return { kind: 'ignore' };
    }

    if (parsed === null || typeof parsed !== 'object') {
      return { kind: 'ignore' };
    }

    const obj = parsed as Record<string, unknown>;

    switch (obj.type) {
      case 'text': {
        const value = typeof obj.value === 'string' ? obj.value : '';

        if (value.length === 0) {
          // Empty text deltas are no-ops; do not append a blank assistant
          // message that would render as an empty bubble in the UI.
          return { kind: 'ignore' };
        }

        return {
          kind: 'message',
          message: { content: value, role: 'assistant' }
        };
      }
      case 'tool_call':
        // Tool dispatches are server-side bookkeeping; the chat panel
        // currently does not render a per-tool indicator. Filtered out
        // so they never pollute the messages array.
        return { kind: 'ignore' };
      case 'done':
        return { kind: 'complete' };
      case 'error': {
        const message =
          typeof obj.message === 'string' && obj.message.length > 0
            ? obj.message
            : 'The AI chat encountered an error.';

        return { kind: 'error', error: new Error(message) };
      }
      default:
        // Unknown discriminator (e.g., a future `'tool_result'` extension
        // not yet handled by this client). Skip rather than fail — the
        // stream remains usable for any subsequent recognised frames.
        return { kind: 'ignore' };
    }
  }

  /**
   * Discriminates `AbortError` (a clean user-initiated cancel) from other
   * failure modes. The Fetch spec says aborts surface as a `DOMException`
   * with `name === 'AbortError'`; we also accept the older Node-style
   * `AbortError` that some polyfills emit.
   */
  private isAbortError(error: unknown): boolean {
    if (error === null || error === undefined) {
      return false;
    }

    if (typeof error === 'object' && 'name' in error) {
      return (error as { name?: string }).name === 'AbortError';
    }

    return false;
  }
}
