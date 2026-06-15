import { GfXRayPageComponent } from '@ghostfolio/client/pages/portfolio/x-ray/x-ray-page.component';

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * GfXRayModuleComponent
 *
 * Thin, standalone "isolation wrapper" that re-hosts the existing,
 * self-fetching {@link GfXRayPageComponent} feature as an independently
 * placeable dashboard grid module. It supplies the grid chrome — an outlined
 * MatCard surface, a draggable header carrying the localized "X-ray" title,
 * and a remove (close) icon-button — while delegating all data concerns to
 * the wrapped feature component.
 *
 * Module isolation (AAP §0.8.1): the wrapper imports only the feature
 * component plus the Angular/Material modules needed for the chrome, holds no
 * layout state, and exposes removal solely through the {@link removeModule}
 * callback input that the owning grid canvas supplies.
 *
 * The wrapped feature component fetches its own data, so it is embedded as
 * `<gf-x-ray-page />` with no input/output bindings.
 *
 * Styling follows Decision D-020: every color/background/border value resolves
 * to a Material Design 3 system token through the mandatory
 * `var(--mat-sys-<token>, <hardcoded-fallback>)` pattern (precedent:
 * `chat-panel.component.scss`).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfXRayPageComponent,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule
  ],
  selector: 'gf-x-ray-module',
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
        <span class="gf-module-title" i18n>X-ray</span>
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
        <gf-x-ray-page />
      </div>
    </mat-card>
  `
})
export class GfXRayModuleComponent {
  @Input() removeModule?: () => void;
}
