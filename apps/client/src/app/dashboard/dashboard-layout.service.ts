import {
  UserDashboardLayout,
  UserDashboardLayoutPatchPayload
} from '@ghostfolio/common/interfaces';

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, of, Subject, throwError } from 'rxjs';
import { catchError, debounceTime, switchMap } from 'rxjs/operators';

/**
 * Client-side wrapper for the `/api/v1/user/layout` endpoint pair.
 *
 * Error semantics (mirrors `FinancialProfileService`):
 *   - `get()` translates HTTP 404 to `null` so the canvas can treat
 *     "no saved layout yet" as the first-visit case (blank canvas +
 *     auto-open catalog). All other errors are re-thrown.
 *
 * Persistence semantics (grid-event-driven ONLY):
 *   - `queueSave(payload)` is the SOLE public save entrypoint. It pushes
 *     onto a private `persist$` Subject that is debounced 500ms and
 *     switch-mapped to `PATCH /api/v1/user/layout`. Only the canvas's grid
 *     state-change handlers (drag/resize/add/remove) call it.
 *   - A failed `PATCH` is caught INSIDE the `switchMap` (returning `EMPTY`)
 *     so the long-lived `persist$` subscription never errors out. This keeps
 *     persistence resilient: one failed save is logged but does NOT stop the
 *     stream, so later `queueSave(...)` calls continue to persist.
 *
 * The `AuthInterceptor` attaches the JWT automatically.
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardLayoutService {
  private persist$ = new Subject<UserDashboardLayoutPatchPayload>();

  public constructor(private http: HttpClient) {
    this.persist$
      .pipe(
        debounceTime(500),
        switchMap((payload) =>
          // The inner `catchError` is REQUIRED for reliability: a failed
          // `PATCH` must NOT error (and thereby permanently terminate) the
          // long-lived `persist$` subscription. Without it, a single failed
          // save would silently stop ALL future layout persistence. Returning
          // `EMPTY` completes only this one inner observable, so the outer
          // stream stays alive and subsequent `queueSave(...)` calls keep
          // persisting (grid-event-driven persistence rule, AAP § 0.8.1).
          this.http
            .patch<UserDashboardLayout>('/api/v1/user/layout', payload)
            .pipe(
              catchError((error: HttpErrorResponse) => {
                console.error('Failed to persist dashboard layout', error);

                return EMPTY;
              })
            )
        ),
        takeUntilDestroyed()
      )
      .subscribe();
  }

  public get(): Observable<UserDashboardLayout | null> {
    return this.http.get<UserDashboardLayout>('/api/v1/user/layout').pipe(
      catchError((error: HttpErrorResponse) => {
        if (error.status === 404) {
          return of(null);
        }

        return throwError(() => error);
      })
    );
  }

  public queueSave(payload: UserDashboardLayoutPatchPayload): void {
    this.persist$.next(payload);
  }
}
