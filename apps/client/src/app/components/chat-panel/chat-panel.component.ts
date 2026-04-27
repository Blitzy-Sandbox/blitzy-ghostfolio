import { AiChatService } from '@ghostfolio/client/services/ai-chat.service';
import { ChatMessage } from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostBinding,
  OnDestroy,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

const MAX_CLIENT_TRANSMITTED_MESSAGES = 5; // 4 prior turns + 1 new user turn (AAP § 0.5.1.1)
const STREAM_ERROR_MESSAGE = $localize`Connection lost. Click reconnect to retry.`;

// Refine PR Directive 6 — Collapse / drag-resize layout constants.
//
// The collapsed-state width MUST be expressed in `rem` (not `px`) so that the
// collapsed strip honors the user's root font-size preference; per the
// directive the explicit value is `2.75rem`, large enough to host a centered
// chevron toggle button with breathing room on either side. The min/max
// resize bounds are explicit `px` values per the directive (200/600). The
// default panel width matches the pre-resize behavior of the chat panel
// (~17.5rem at the typical 16px root font, i.e. 280px).
const COLLAPSED_WIDTH_REM = '2.75rem';
const DEFAULT_EXPANDED_WIDTH_PX = 280;
const MIN_EXPANDED_WIDTH_PX = 200;
const MAX_EXPANDED_WIDTH_PX = 600;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule
  ],
  // The 'app-chat-panel' selector intentionally deviates from the project-wide
  // 'gf' prefix per AAP § 0.7.4: the embed in
  // apps/client/src/app/pages/portfolio/portfolio-page.html is literally
  // <app-chat-panel></app-chat-panel>, and the AAP mandates the component
  // selector match that embed verbatim.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-chat-panel',
  styleUrls: ['./chat-panel.component.scss'],
  templateUrl: './chat-panel.component.html'
})
export class ChatPanelComponent implements OnDestroy {
  public errorMessage = signal<string>('');
  public inputText = signal<string>('');
  public isStreaming = signal<boolean>(false);
  public messages = signal<ChatMessage[]>([]);

  // Refine PR Directive 6 — Collapse / drag-resize component state.
  //
  // CRITICAL persistence rule (Directive 6, paragraph 1):
  //   `isCollapsed` state is component-instance scope only. It MUST NOT
  //   persist to `localStorage`, `sessionStorage`, or any server-side store;
  //   state resets to `false` on component destroy. This is intentionally
  //   ephemeral: navigating away from `/portfolio` and returning re-renders
  //   the component fresh with `isCollapsed() === false`.
  //
  // We DELIBERATELY DO NOT initialize from any persisted source, and we
  // DELIBERATELY DO NOT write to any persistent store on toggle. The signal
  // simply ceases to exist when the component is destroyed.
  public isCollapsed = signal<boolean>(false);

  // Per the directive, the default expanded panel width is 280px.
  public panelWidth = signal<number>(DEFAULT_EXPANDED_WIDTH_PX);

  private aiChatService = inject(AiChatService);
  private destroyRef = inject(DestroyRef);

  // Drag-resize lifecycle state. `isDragging` guards the move/up handlers so
  // they short-circuit when no drag is in progress (defense in depth — the
  // listeners are also attached/detached on demand). `dragStartX` and
  // `dragStartWidth` are captured at mousedown so width updates compute as
  // the delta from the initial cursor position.
  private isDragging = false;
  private dragStartX = 0;
  private dragStartWidth = DEFAULT_EXPANDED_WIDTH_PX;

  // Bound handler references retained so that `removeEventListener` can match
  // the exact function reference attached by `addEventListener`. Without
  // this, `ngOnDestroy` would fail to detach the listeners and we would leak
  // listeners across component re-instantiations.
  private boundOnMouseMove = this.onMouseMove.bind(this);
  private boundOnMouseUp = this.onMouseUp.bind(this);

  /**
   * Refine PR Directive 6 — `@HostBinding('style.width')` getter.
   *
   * Returns `'2.75rem'` when the panel is collapsed and
   * `'${panelWidth()}px'` otherwise. Angular re-evaluates host bindings on
   * each change detection cycle; because both `isCollapsed` and
   * `panelWidth` are signals, any update via `set()` automatically marks the
   * component for check (with `OnPush` + signal-based change detection).
   *
   * The `:host` SCSS rule additionally declares `transition: width 0.2s
   * ease`, so the width change between collapsed and expanded animates
   * smoothly without explicit JS coordination.
   */
  @HostBinding('style.width')
  public get hostWidth(): string {
    if (this.isCollapsed()) {
      return COLLAPSED_WIDTH_REM;
    }

    return `${this.panelWidth()}px`;
  }

  public ngOnDestroy(): void {
    this.aiChatService.closeStream();

    // Defense in depth: if the user destroyed the component while a drag was
    // in progress, ensure the document-level move/up listeners are detached
    // so they do not leak across navigations. `endDrag()` is idempotent and
    // safe to call when no drag is active.
    this.endDrag();
  }

  public onSend(): void {
    const text = this.inputText().trim();

    if (!text || this.isStreaming()) {
      return;
    }

    const userTurn: ChatMessage = { content: text, role: 'user' };
    const trimmed = this.appendAndTrim(this.messages(), userTurn);

    this.messages.set(trimmed);
    this.inputText.set('');

    this.startStream();
  }

  public reconnect(): void {
    if (this.isStreaming()) {
      return;
    }

    this.startStream();
  }

  /**
   * Refine PR Directive 6 — collapse / expand toggle.
   *
   * Flips the `isCollapsed` signal. The companion `@HostBinding('style.width')`
   * getter recomputes `:host` width on the next change detection pass, the
   * `:host { transition: width 0.2s ease }` rule animates the change, and
   * the template's `@if (!isCollapsed()) { ... }` block hides the message
   * list, error banner, progress bar, and input form so only the toggle
   * header is visible in the collapsed state.
   *
   * No persistence: clicking this button only mutates in-memory signal
   * state. There are no writes to localStorage, sessionStorage, or the
   * server.
   */
  public toggleCollapsed(): void {
    this.isCollapsed.update((current) => !current);
  }

  /**
   * Refine PR Directive 6 — drag-resize mousedown handler.
   *
   * Wired to the resize handle div (`position: absolute; right: 0; top: 0;
   * width: 5px; cursor: col-resize`). On mousedown, captures the starting
   * cursor X and current panel width, then attaches document-level
   * mousemove / mouseup listeners so the drag continues even if the cursor
   * leaves the handle's 5px hit area. `event.preventDefault()` blocks the
   * browser's default text-selection / drag-image behavior during the drag.
   */
  public onMouseDown(event: MouseEvent): void {
    // Guard: do not start a drag while the panel is collapsed — the resize
    // handle is hidden in collapsed state via the template's @if block, but
    // this is a defense-in-depth check.
    if (this.isCollapsed()) {
      return;
    }

    event.preventDefault();
    this.isDragging = true;
    this.dragStartX = event.clientX;
    this.dragStartWidth = this.panelWidth();

    document.addEventListener('mousemove', this.boundOnMouseMove);
    document.addEventListener('mouseup', this.boundOnMouseUp);
  }

  /**
   * Refine PR Directive 6 — drag-resize mousemove handler.
   *
   * Computes the new panel width as `dragStartWidth - (clientX -
   * dragStartX)`. The chat panel sits on the right side of the portfolio
   * page sidebar, so a leftward cursor movement (negative deltaX) MUST
   * INCREASE the panel width — the subtraction inverts the cursor delta to
   * yield the correct "drag toward the page to grow the panel" behavior.
   *
   * The result is clamped to the [MIN_EXPANDED_WIDTH_PX,
   * MAX_EXPANDED_WIDTH_PX] = [200, 600] range per the directive's explicit
   * bounds.
   */
  private onMouseMove(event: MouseEvent): void {
    if (!this.isDragging) {
      return;
    }

    const deltaX = event.clientX - this.dragStartX;
    const proposedWidth = this.dragStartWidth + deltaX;
    const clampedWidth = Math.min(
      MAX_EXPANDED_WIDTH_PX,
      Math.max(MIN_EXPANDED_WIDTH_PX, proposedWidth)
    );

    this.panelWidth.set(clampedWidth);
  }

  /**
   * Refine PR Directive 6 — drag-resize mouseup handler.
   *
   * Releases the drag state and detaches the document-level listeners so
   * subsequent mousemove events outside an active drag do not run handler
   * code. `endDrag()` is also called from `ngOnDestroy` for cleanup safety.
   *
   * The `MouseEvent` parameter is intentionally omitted — the handler does
   * not consult any field of the event object. Omitting it keeps the
   * `@typescript-eslint/no-unused-vars` rule satisfied without weakening
   * the listener's runtime contract: native `addEventListener('mouseup', fn)`
   * accepts handlers of any arity, including zero.
   */
  private onMouseUp(): void {
    this.endDrag();
  }

  /**
   * Idempotent drag-cleanup helper. Called from `onMouseUp` and
   * `ngOnDestroy`. Safe to invoke when no drag is in progress.
   */
  private endDrag(): void {
    this.isDragging = false;
    document.removeEventListener('mousemove', this.boundOnMouseMove);
    document.removeEventListener('mouseup', this.boundOnMouseUp);
  }

  private appendAndTrim(
    current: ChatMessage[],
    next: ChatMessage
  ): ChatMessage[] {
    const combined = [...current, next];

    if (combined.length <= MAX_CLIENT_TRANSMITTED_MESSAGES) {
      return combined;
    }

    return combined.slice(combined.length - MAX_CLIENT_TRANSMITTED_MESSAGES);
  }

  private startStream(): void {
    this.errorMessage.set('');
    this.isStreaming.set(true);

    this.aiChatService
      .openStream(this.messages())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => {
          this.isStreaming.set(false);
        },
        error: () => {
          this.isStreaming.set(false);
          this.errorMessage.set(STREAM_ERROR_MESSAGE);
        },
        next: (chunk) => {
          this.handleStreamChunk(chunk);
        }
      });
  }

  private handleStreamChunk(chunk: ChatMessage): void {
    // Defense in depth: AiChatService.parseSseFrame translates the backend's
    // discriminated SSE union into ChatMessage shape and ONLY emits frames
    // of role 'assistant' (text deltas). Tool-call / done / error frames are
    // routed out-of-band via Subject.complete() / Subject.error(). The
    // pre-fix implementation emitted raw {type,...} payloads here, which
    // appended malformed entries with no `role` and no `content` — those
    // entries then poisoned the next request body and triggered cascading
    // HTTP 400 responses (QA Checkpoint 11 Issue 2 / Rule 6 violation).
    //
    // Reject anything that is not a structurally-valid assistant ChatMessage
    // to ensure the conversation history remains forwardable to the server
    // without `class-validator` rejection.
    if (
      chunk === null ||
      chunk === undefined ||
      typeof chunk !== 'object' ||
      chunk.role !== 'assistant' ||
      typeof chunk.content !== 'string'
    ) {
      return;
    }

    this.messages.update((current) => {
      const last = current[current.length - 1];

      // If the assistant turn is in flight, append incoming content to it.
      if (last?.role === 'assistant') {
        const merged: ChatMessage = {
          ...last,
          content: `${last.content}${chunk.content}`
        };

        return [...current.slice(0, current.length - 1), merged];
      }

      // Otherwise (first chunk of a new assistant turn), append as a new
      // entry.
      return [...current, chunk];
    });
  }
}
