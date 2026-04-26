import { AiChatService } from '@ghostfolio/client/services/ai-chat.service';
import { ChatMessage } from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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

  private aiChatService = inject(AiChatService);
  private destroyRef = inject(DestroyRef);

  public ngOnDestroy(): void {
    this.aiChatService.closeStream();
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
    this.messages.update((current) => {
      const last = current[current.length - 1];

      // If the assistant turn is in flight, append incoming content to it.
      if (
        chunk.role === 'assistant' &&
        last?.role === 'assistant' &&
        last !== undefined
      ) {
        const merged: ChatMessage = {
          ...last,
          content: `${last.content}${chunk.content}`
        };

        return [...current.slice(0, current.length - 1), merged];
      }

      // Otherwise (first chunk of a new assistant turn, or a non-assistant
      // role), append as a new entry.
      return [...current, chunk];
    });
  }
}
