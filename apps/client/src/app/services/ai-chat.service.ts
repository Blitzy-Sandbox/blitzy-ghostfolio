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
 * backed by an internal `Subject`. The subject completes when the stream
 * terminates cleanly (the server has emitted `data: [DONE]` or the response
 * body has reached EOF). It errors when the network or response status fails.
 * Calling `closeStream()` aborts the in-flight request via `AbortController`
 * and completes the subject — `AbortError` is treated as a clean cancel, NOT
 * an error.
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
   * The returned observable emits one `ChatMessage` per parsed SSE frame
   * and completes when the stream terminates cleanly.
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
   * On any non-`AbortError` failure, the subject is errored so the
   * downstream component can react (e.g., set its `errorMessage` signal per
   * Rule 6). On `AbortError`, the subject is completed cleanly — abort is
   * treated as a user-initiated cancel, not a failure.
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
          const message = this.parseSseFrame(segment);

          if (message !== null) {
            subject.next(message);
          }
        }
      }

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
   * Parses a single SSE frame into a {@link ChatMessage}. Returns `null` for
   * frames that should not produce an emission (the `[DONE]` sentinel,
   * frames consisting only of comments or empty `data:` lines, frames that
   * fail JSON parsing). The caller filters out `null` results before
   * forwarding to subscribers.
   *
   * Frame shape (per SSE spec): one or more `data:` lines, optionally
   * separated by other directive lines (e.g., `event:`, `id:`). Multiple
   * `data:` lines within a single frame are joined with `\n` per the spec.
   * Lines beginning with `:` are SSE comments and are ignored.
   */
  private parseSseFrame(frame: string): ChatMessage | null {
    const dataLines: string[] = [];

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
      }
    }

    if (dataLines.length === 0) {
      return null;
    }

    const payload = dataLines.join('\n');

    if (payload === '[DONE]') {
      return null;
    }

    try {
      return JSON.parse(payload) as ChatMessage;
    } catch {
      // Tolerate malformed frames silently — they should never occur in
      // production but a single bad frame must not poison the entire stream.
      return null;
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
