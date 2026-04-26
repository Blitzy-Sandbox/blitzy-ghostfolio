import { RebalancingService } from '@ghostfolio/client/services/rebalancing.service';
import {
  RebalancingRecommendation,
  RebalancingResponse
} from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

/**
 * Routed page for the Explainable Rebalancing Engine (Feature C).
 *
 * Mounted at `/portfolio/rebalancing` (see `app.routes.ts`). The component
 * fetches a {@link RebalancingResponse} on init and renders each
 * recommendation with its `rationale` and `goalReference` immediately
 * visible — there is intentionally no "click to expand" affordance per
 * AAP § 0.5.3 ("each `rationale` field expanded by default … every
 * rationale is visible immediately").
 *
 * **CSS class hooks for tests** (refer to component spec): the template
 * exposes `.summary`, `.recommendation`, `.action`, `.ticker`,
 * `.rationale`, `.goal-reference`, and `.warning` so unit tests can assert
 * the presence and contents of each region without coupling to Material's
 * internal markup.
 *
 * **Selector**: `gf-rebalancing-page` follows Ghostfolio's standard `gf-`
 * prefix per AAP § 0.7.4. The class name `RebalancingPageComponent`
 * intentionally drops the `Gf` prefix to match the lazy-load expression in
 * `app.routes.ts` (`(m) => m.RebalancingPageComponent`); both names are
 * permitted by the AAP, which only requires that the embedded selector
 * matches the component's `selector` metadata.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'page' },
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule
  ],
  selector: 'gf-rebalancing-page',
  styleUrls: ['./rebalancing-page.component.scss'],
  templateUrl: './rebalancing-page.component.html'
})
export class RebalancingPageComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Loaded rebalancing response, or `null` while the request is in flight
   * or after a failure (the latter is also indicated by `errorMessage`).
   */
  public readonly response = signal<RebalancingResponse | null>(null);

  /**
   * `true` while the HTTP request is in flight. Drives the loading
   * indicator and disables the reload button to prevent overlapping
   * requests.
   */
  public readonly isLoading = signal<boolean>(false);

  /**
   * Non-null when the most recent fetch failed. The template renders an
   * error card with a reload button so users can retry without leaving
   * the page.
   */
  public readonly errorMessage = signal<string | null>(null);

  public constructor(private readonly rebalancingService: RebalancingService) {}

  public ngOnInit(): void {
    this.fetchRecommendations();
  }

  /**
   * Re-issues the rebalancing request. Idempotent — bails out early if a
   * request is already in flight so users tapping the reload button
   * repeatedly cannot DoS the endpoint.
   */
  public reload(): void {
    if (this.isLoading()) {
      return;
    }

    this.fetchRecommendations();
  }

  /**
   * Returns a CSS class suffix derived from a recommendation's action.
   * Used in the template via `[class.action-buy]`, `[class.action-sell]`,
   * `[class.action-hold]` to apply the matching M3 token color to the
   * recommendation card.
   */
  public actionClass(recommendation: RebalancingRecommendation): string {
    return `action-${recommendation.action.toLowerCase()}`;
  }

  /**
   * Track function for the recommendations `@for` loop. Tickers are
   * unique within a single response, so they form a stable identity for
   * Angular's view diffing.
   */
  public trackByTicker(
    _index: number,
    recommendation: RebalancingRecommendation
  ): string {
    return recommendation.ticker;
  }

  private fetchRecommendations(): void {
    this.isLoading.set(true);
    this.errorMessage.set(null);

    this.rebalancingService
      .getRecommendations()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.isLoading.set(false);
          this.response.set(null);
          this.errorMessage.set(this.deriveErrorMessage(error));
        },
        next: (response) => {
          this.isLoading.set(false);
          this.response.set(response);
        }
      });
  }

  private deriveErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
      return error.message;
    }

    if (typeof error === 'string' && error.length > 0) {
      return error;
    }

    return 'Could not load rebalancing recommendations. Please try again.';
  }
}
