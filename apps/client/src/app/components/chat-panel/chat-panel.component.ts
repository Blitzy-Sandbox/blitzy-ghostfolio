import { AiChatService } from '@ghostfolio/client/services/ai-chat.service';
import { ChatMessage } from '@ghostfolio/common/interfaces';

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnDestroy,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

/**
 * Maximum number of messages the client transmits per request.
 *
 * Per AAP § 0.7.3, the chat protocol is stateless server-side: the client
 * carries up to four prior turns plus the current user turn (5 total). The
 * server-side `ChatRequestDto` enforces the same cap via
 * `@ArrayMaxSize(5)` (AAP § 0.5.1.1). When the local history grows past
 * this cap we trim the oldest entries first (FIFO) so the most recent
 * context is always preserved.
 */
const MAX_CLIENT_TRANSMITTED_MESSAGES = 5;

/**
 * Sidebar-mounted streaming chat agent (Feature B).
 *
 * The component is rendered inside the existing portfolio page sidebar via
 * the literal `<app-chat-panel></app-chat-panel>` selector — see
 * `portfolio-page.html`. The `'app-chat-panel'` selector intentionally
 * deviates from Ghostfolio's standard `gf-` prefix per AAP § 0.7.4: the
 * sidebar embed in `portfolio-page.html` was added as part of the AAP's
 * additive wiring with that exact tag name, so the component's `selector`
 * metadata must match.
 *
 * **Rule 6 compliance** (AAP § 0.7.1.6): when the SSE stream terminates
 * with an error the component MUST set a non-empty `errorMessage` and
 * render a visible reconnect button. This is implemented by:
 *
 * 1. The `errorMessage` signal — set to a non-empty string on stream error
 *    and cleared on successful reconnection.
 * 2. The template's `@if (errorMessage())` block — renders an error banner
 *    with a `data-testid="reconnect-button"` button so unit tests can
 *    assert visibility.
 * 3. The `reconnect()` method — re-issues the stream with the same message
 *    history that caused the failure. The pending assistant message is
 *    discarded so reconnection produces a clean re-attempt rather than
 *    appending to a partial response.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule
  ],
  // The `app-chat-panel` selector is intentionally retained instead of the
  // project-standard `gf-` prefix. Per AAP § 0.7.4, this is a documented
  // waiver: the host `apps/client/src/app/pages/portfolio/portfolio-page.html`
  // embeds `<app-chat-panel></app-chat-panel>` literally, and the AAP
  // mandates that the component's `selector` exactly match that embed.
  // The decision is recorded in
  // `docs/decisions/agent-action-plan-decisions.md` (D-005 — selector
  // waiver). This single-line ESLint disable preserves the waiver without
  // weakening the rule globally.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-chat-panel',
  styleUrls: ['./chat-panel.component.scss'],
  templateUrl: './chat-panel.component.html'
})
export class ChatPanelComponent implements OnDestroy {
  /**
   * Chat history rendered in the message list. Includes all user turns and
   * any assistant turns that have been fully or partially streamed. The
   * array is trimmed to {@link MAX_CLIENT_TRANSMITTED_MESSAGES} entries
   * before being sent to the server.
   */
  public readonly messages = signal<ChatMessage[]>([]);

  /** User-typed text awaiting submission. Bound to the input via NgModel. */
  public inputText = signal<string>('');

  /**
   * Non-empty when the most recent stream terminated with an error (Rule
   * 6). The template renders the reconnect button conditionally on this
   * value. Cleared on the next successful stream open.
   */
  public readonly errorMessage = signal<string | null>(null);

  /**
   * `true` while an SSE stream is in flight. Drives the disabled state of
   * the send button and the visibility of the streaming progress
   * indicator.
   */
  public readonly isStreaming = signal<boolean>(false);

  private readonly destroyRef = inject(DestroyRef);

  public constructor(private readonly aiChatService: AiChatService) {}

  public ngOnDestroy(): void {
    // Defensive — `takeUntilDestroyed` already handles RxJS teardown, but
    // explicitly closing the underlying fetch ensures the AbortController
    // fires immediately and any in-flight network request is cancelled.
    this.aiChatService.closeStream();
  }

  /**
   * Submits the current `inputText` as a new user turn and opens a stream
   * to receive the assistant's reply. The user turn is appended optimistically
   * so the UI feels responsive even before the server replies. A blank
   * `assistant` message is appended to receive streaming tokens — the
   * service's emissions overwrite (or accumulate into) that placeholder.
   */
  public sendMessage(): void {
    const trimmed = this.inputText().trim();

    if (trimmed.length === 0 || this.isStreaming()) {
      return;
    }

    const userMessage: ChatMessage = {
      content: trimmed,
      role: 'user',
      timestamp: Date.now()
    };

    const updated = this.appendAndTrim(this.messages(), userMessage);

    this.messages.set(updated);
    this.inputText.set('');
    this.errorMessage.set(null);

    this.openStreamForHistory(updated);
  }

  /**
   * Re-attempts the most recent request after a stream error. Discards the
   * partial assistant turn (if any) so the retry sees a clean history,
   * then re-opens the stream against the trimmed history. If there is no
   * history to retry against (a near-impossible state — the error path
   * must have at least one user turn) the method clears the error and
   * exits without making a request.
   */
  public reconnect(): void {
    if (this.isStreaming()) {
      // Defensive — should not occur because the reconnect button is only
      // shown when `errorMessage` is non-null and the stream is therefore
      // not active. Bail out rather than queue overlapping requests.
      return;
    }

    let history = this.messages();

    // Drop the trailing assistant placeholder if the previous run died
    // mid-stream so the retry doesn't see a partial reply.
    if (
      history.length > 0 &&
      history[history.length - 1].role === 'assistant'
    ) {
      history = history.slice(0, -1);
      this.messages.set(history);
    }

    if (history.length === 0) {
      this.errorMessage.set(null);

      return;
    }

    this.errorMessage.set(null);
    this.openStreamForHistory(history);
  }

  /**
   * Opens an SSE stream against the supplied history, appending streamed
   * assistant tokens to a fresh trailing placeholder. Subscribes through
   * `takeUntilDestroyed` so component teardown unconditionally completes
   * the subject.
   */
  private openStreamForHistory(history: ChatMessage[]): void {
    // Append a placeholder assistant message that streamed tokens will
    // accumulate into. This keeps the UI showing an active assistant
    // bubble even before the first token arrives.
    const placeholder: ChatMessage = {
      content: '',
      role: 'assistant',
      timestamp: Date.now()
    };

    this.messages.set([...history, placeholder]);
    this.isStreaming.set(true);

    this.aiChatService
      .openStream(history)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => {
          this.isStreaming.set(false);
        },
        error: (error: unknown) => {
          this.isStreaming.set(false);
          this.errorMessage.set(this.deriveErrorMessage(error));
        },
        next: (message) => {
          this.absorbStreamedMessage(message);
        }
      });
  }

  /**
   * Folds an SSE-emitted {@link ChatMessage} into the current message list.
   *
   * - For role `'assistant'`, accumulate `content` into the trailing
   *   placeholder (which was appended by `openStreamForHistory`).
   * - For role `'user'` (rare — only emitted by some echo modes), append
   *   as a discrete entry rather than clobbering the assistant
   *   placeholder.
   */
  private absorbStreamedMessage(message: ChatMessage): void {
    const current = this.messages();

    if (message.role === 'assistant') {
      const last = current[current.length - 1];

      if (last && last.role === 'assistant') {
        const merged: ChatMessage = {
          ...last,
          content: last.content + message.content,
          timestamp: message.timestamp ?? last.timestamp
        };

        this.messages.set([...current.slice(0, -1), merged]);

        return;
      }
    }

    this.messages.set(this.appendAndTrim(current, message));
  }

  /**
   * Extracts a user-facing error message from the supplied error value.
   * The returned string is always non-empty so Rule 6's "non-empty
   * `errorMessage`" requirement is satisfied even when the underlying
   * error provides no descriptive text.
   */
  private deriveErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
      return error.message;
    }

    if (typeof error === 'string' && error.length > 0) {
      return error;
    }

    return 'The chat stream was interrupted. Please reconnect to continue.';
  }

  /**
   * Appends `message` to `history` and trims the result to at most
   * {@link MAX_CLIENT_TRANSMITTED_MESSAGES} entries from the tail. Trimming
   * is FIFO so the newest context is always retained.
   */
  private appendAndTrim(
    history: ChatMessage[],
    message: ChatMessage
  ): ChatMessage[] {
    const next = [...history, message];

    if (next.length <= MAX_CLIENT_TRANSMITTED_MESSAGES) {
      return next;
    }

    return next.slice(next.length - MAX_CLIENT_TRANSMITTED_MESSAGES);
  }
}
