import { GfActivitiesPageComponent } from '@ghostfolio/client/pages/portfolio/activities/activities-page.component';

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfActivitiesPageComponent,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule
  ],
  // Module-isolation guard (F2-003): the embedded gf-activities-page is an
  // existing routed feature component that the AAP forbids us from modifying
  // (§0.7.2 — "no internal refactoring of existing feature components beyond
  // wrapping them"). On the route-based pages it used the global Router to
  // auto-open the "Add activity" dialog for zero-activity users by navigating
  // to `?createDialog=true`. Embedded at the single `''` canvas route it shares
  // the global Router/ActivatedRoute, so that onboarding behaviour leaked into
  // the dashboard — rewriting the canvas URL and popping a full-screen modal
  // over every module on each load. We contain it here, in the in-scope
  // wrapper, by shadowing both Router and ActivatedRoute with inert local
  // scopes for this subtree only. Data still flows through the existing
  // services (DataService/UserService), satisfying the module-isolation rule.
  providers: [
    {
      // Inert Router for the embedded subtree. `navigate`/`navigateByUrl` become
      // no-ops, so the page's auto `router.navigate([], { queryParams: {
      // createDialog: true } })` can no longer mutate the canvas URL.
      // Crucially this object intentionally omits `createUrlTree`: Angular's
      // RouterLink._urlTree() returns null when `router.createUrlTree` is
      // absent, which makes the page's "Add activity" FAB ([routerLink]="[]")
      // inert (no href, no navigation) without throwing.
      provide: Router,
      useValue: {
        navigate: () => Promise.resolve(true),
        navigateByUrl: () => Promise.resolve(true)
      }
    },
    {
      // Inert ActivatedRoute for the embedded subtree. Emitting empty params
      // means the page's `route.queryParams` subscription never matches
      // `createDialog`/`editDialog`, so no dialog auto-opens over the canvas.
      provide: ActivatedRoute,
      useValue: {
        params: of({}),
        queryParams: of({}),
        snapshot: { params: {}, queryParams: {} }
      }
    }
  ],
  selector: 'gf-transactions-module',
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
        <span class="gf-module-title" i18n>Transactions</span>
        <button
          aria-label="Remove module"
          i18n-aria-label
          i18n-matTooltip
          mat-icon-button
          matTooltip="Remove module"
          type="button"
          (click)="removeModule?.()"
          (mousedown)="$event.stopPropagation()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </div>
      <div class="gf-module-content">
        <gf-activities-page />
      </div>
    </mat-card>
  `
})
export class GfTransactionsModuleComponent {
  @Input() removeModule?: () => void;
}
