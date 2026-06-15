import { ChatPanelComponent } from '@ghostfolio/client/components/chat-panel/chat-panel.component';

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ChatPanelComponent,
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule
  ],
  selector: 'gf-ai-chat-module',
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }

      .gf-module-card {
        background-color: var(--mat-sys-surface-container, rgba(0, 0, 0, 0.04));
        color: var(--mat-sys-on-surface, var(--dark-primary-text));
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .gf-module-header {
        align-items: center;
        border-bottom: 1px solid var(--mat-sys-outline, rgba(0, 0, 0, 0.12));
        display: flex;
        justify-content: space-between;
        padding: 0.25rem 0.25rem 0.25rem 0.75rem;
      }

      .gf-module-drag-handle {
        cursor: move;
      }

      .gf-module-title {
        color: var(--mat-sys-on-surface, var(--dark-primary-text));
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .gf-module-content {
        flex: 1 1 auto;
        overflow: auto;
        padding: 0.5rem;
      }
    `
  ],
  template: `
    <mat-card appearance="outlined" class="gf-module-card">
      <div class="gf-module-header gf-module-drag-handle">
        <span class="gf-module-title" i18n>AI Chat</span>
        <button
          i18n-matTooltip
          mat-icon-button
          matTooltip="Remove module"
          (click)="removeModule?.()"
          (mousedown)="$event.stopPropagation()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </div>
      <div class="gf-module-content">
        <app-chat-panel></app-chat-panel>
      </div>
    </mat-card>
  `
})
export class GfAiChatModuleComponent {
  @Input() removeModule?: () => void;
}
