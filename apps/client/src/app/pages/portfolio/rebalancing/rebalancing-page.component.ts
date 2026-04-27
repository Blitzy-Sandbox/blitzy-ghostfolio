import { RebalancingService } from '@ghostfolio/client/services/rebalancing.service';
import {
  RebalancingRecommendation,
  RebalancingResponse
} from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
// QA Checkpoint 12 Issue #2 (Component Library Adherence — AAP § 0.5.3):
// MatButtonModule is required so the error-state "Try again" recovery action
// can be a `mat-flat-button color="primary"` directive — bringing parity with
// the chat-panel's "Reconnect" button and providing Material ripple, focus
// management, ARIA semantics, and theme-token alignment that the previous
// plain HTML <button> lacked.
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';

/**
 * Localized fallback shown when no actionable error message can be
 * extracted from the failure surfaced by `RebalancingService`. Defined at
 * module scope so the localized string is registered with `$localize`
 * exactly once at class-loading time.
 */
const REBALANCING_FALLBACK_ERROR_MESSAGE = $localize`Unable to load rebalancing recommendations.`;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatButtonModule, MatCardModule, MatProgressBarModule],
  selector: 'gf-rebalancing-page',
  standalone: true,
  styleUrls: ['./rebalancing-page.component.scss'],
  templateUrl: './rebalancing-page.component.html'
})
export class RebalancingPageComponent implements OnInit {
  public errorMessage = signal<string | null>(null);
  public isLoading = signal<boolean>(true);
  public response = signal<RebalancingResponse | null>(null);

  public constructor(
    private destroyRef: DestroyRef,
    private rebalancingService: RebalancingService
  ) {}

  public ngOnInit() {
    this.fetchRecommendations();
  }

  public onReload() {
    this.fetchRecommendations();
  }

  public trackByRecommendation(
    _index: number,
    item: RebalancingRecommendation
  ) {
    return `${item.action}-${item.ticker}`;
  }

  public trackByWarning(_index: number, item: string) {
    return item;
  }

  private fetchRecommendations() {
    this.errorMessage.set(null);
    this.isLoading.set(true);
    this.response.set(null);

    this.rebalancingService
      .getRecommendations()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.errorMessage.set(this.buildErrorMessage(error));
          this.isLoading.set(false);
        },
        next: (response) => {
          this.response.set(response);
          this.isLoading.set(false);
        }
      });
  }

  /**
   * Extracts the most useful, user-facing message from an arbitrary error
   * surfaced by `HttpClient`.
   *
   * **Why this exists**: prior to QA Checkpoint 11 Issue 3, this handler
   * read `error?.message` directly. On an `HttpErrorResponse`, that field
   * is the framework-generated string of the form
   * `"Http failure response for {url}: {status} {statusText}"` — it leaks
   * the API URL into the UI and ignores the friendly message embedded in
   * the parsed JSON body (e.g.
   * `"Rebalancing recommendation could not be generated. Please retry."`).
   *
   * The extraction strategy mirrors the canonical pattern established by
   * `FinancialProfileFormComponent.buildSaveErrorMessage(...)`:
   *
   *   1. If `error` is an `HttpErrorResponse` AND the parsed JSON body has
   *      a non-empty `message` (string or string[]), return that
   *      verbatim — this is the path NestJS exception filters always
   *      take, so it surfaces the application's intended copy.
   *   2. Otherwise, fall back to the localized generic message defined at
   *      the top of this file. We deliberately do NOT fall back to
   *      `error.message` for `HttpErrorResponse`, because that string
   *      leaks the URL.
   *   3. For non-`HttpErrorResponse` failures (network errors, RxJS
   *      operator errors, etc.) fall back to `error.message` if it is a
   *      non-empty string, otherwise the localized fallback.
   */
  private buildErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as
        | { message?: string | string[] }
        | undefined
        | null;

      if (body?.message !== undefined && body?.message !== null) {
        if (Array.isArray(body.message) && body.message.length > 0) {
          return body.message.join(', ');
        }

        if (typeof body.message === 'string' && body.message.length > 0) {
          return body.message;
        }
      }

      // HttpErrorResponse.message would leak the URL — never surface it.
      return REBALANCING_FALLBACK_ERROR_MESSAGE;
    }

    if (
      error !== null &&
      typeof error === 'object' &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string' &&
      (error as { message: string }).message.length > 0
    ) {
      return (error as { message: string }).message;
    }

    return REBALANCING_FALLBACK_ERROR_MESSAGE;
  }
}
