import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import {
  DashboardLayoutItem,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { EMPTY, Observable, Subject, of, throwError } from 'rxjs';
import { catchError, debounceTime, map, switchMap } from 'rxjs/operators';

/**
 * Wire shape of the `UserDashboardLayout` Prisma row returned by
 * `GET`/`PATCH /api/v1/user/layout`.
 *
 * The API persistence layer (`UserDashboardLayoutService.upsertForUser`) stores
 * the grid items as a bare `DashboardLayoutItem[]` inside the `layoutData`
 * JSONB column, and the controller returns the full row. This client therefore
 * consumes only `layoutData` and re-wraps it into the shared
 * `UserDashboardLayout` envelope (`{ layout: DashboardLayoutItem[] }`) so the
 * canvas always receives the documented shared shape. The remaining
 * server-controlled columns (`userId`, `createdAt`, `updatedAt`) are typed here
 * for contract clarity but are never surfaced to callers.
 *
 * Kept file-local because the shared `UserDashboardLayout` type is
 * intentionally the extracted `{ layout }` envelope, not the transport row.
 */
interface UserDashboardLayoutResponse {
  createdAt: string;
  layoutData: DashboardLayoutItem[];
  updatedAt: string;
  userId: string;
}

/** Debounce window (ms) applied before persisting a layout change (Rule 4). */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Owns all persistence for the dashboard canvas:
 * - `get()` loads the saved layout on canvas init (404 → `null`, the canonical
 *   "new user / blank canvas" signal that drives catalog auto-open, Rule 10).
 * - `save()` feeds grid-state-change events into a debounced PATCH pipeline.
 * - `savedLayout$` is the long-lived stream the canvas subscribes to ONCE to
 *   activate persistence. Modules never touch this service (Rule 4).
 *
 * Mirrors the canonical persistence-service pattern of `FinancialProfileService`
 * (`providedIn: 'root'`, raw `HttpClient`, 404 → `null`). The JWT
 * `Authorization` header is attached automatically by the preserved
 * `core/auth.interceptor.ts`, so no manual token handling is required here.
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardLayoutService {
  public readonly savedLayout$: Observable<UserDashboardLayout>;

  private readonly layoutChanges = new Subject<DashboardLayoutItem[]>();

  public constructor(private http: HttpClient) {
    this.savedLayout$ = this.layoutChanges.pipe(
      debounceTime(SAVE_DEBOUNCE_MS),
      switchMap((layout) =>
        this.patch(layout).pipe(
          catchError(() => {
            // Swallow a failed save so a single transient error does not
            // terminate this long-lived (root-scoped) persistence stream; the
            // next grid-state change re-attempts the PATCH.
            return EMPTY;
          })
        )
      )
    );
  }

  /**
   * Loads the persisted layout when the canvas initializes.
   *
   * The server returns the full layout row; its `layoutData` column (a bare
   * `DashboardLayoutItem[]`) is mapped into the shared `UserDashboardLayout`
   * envelope BEFORE the 404 handling so callers receive the documented
   * `{ layout }` shape — or `null`.
   *
   * Translates HTTP 404 (no saved row) to `null` so the canvas treats a
   * first-time visitor as a blank canvas and auto-opens the module catalog
   * (Rule 10). Every other status is re-thrown for the caller to surface.
   */
  public get(): Observable<UserDashboardLayout | null> {
    return this.http
      .get<UserDashboardLayoutResponse>('/api/v1/user/layout')
      .pipe(
        map((response) => ({ layout: response.layoutData })),
        catchError((error: HttpErrorResponse) => {
          if (error.status === 404) {
            return of(null);
          }

          return throwError(() => error);
        })
      );
  }

  /**
   * Persists the supplied grid items via `PATCH /api/v1/user/layout`.
   *
   * The bare item array is wrapped in the `{ layout }` body shape validated by
   * the server-side `UpdateUserDashboardLayoutDto`; the typed local both
   * enforces that contract at compile time and exercises the imported DTO. The
   * upserted row is mapped back into the shared `UserDashboardLayout` envelope
   * for symmetry with `get()`.
   */
  public patch(layout: DashboardLayoutItem[]): Observable<UserDashboardLayout> {
    const body: UpdateUserDashboardLayoutDto = { layout };

    return this.http
      .patch<UserDashboardLayoutResponse>('/api/v1/user/layout', body)
      .pipe(map((response) => ({ layout: response.layoutData })));
  }

  /**
   * Entry point for grid-state-change events (drag, resize, add, remove).
   *
   * Pushes the latest full layout onto the private `layoutChanges` Subject,
   * which the debounced `savedLayout$` pipeline coalesces into a single PATCH
   * of the final arrangement. This is the ONLY persistence trigger (Rule 4) and
   * is invoked exclusively by the canvas — modules never call it.
   */
  public save(layout: DashboardLayoutItem[]): void {
    this.layoutChanges.next(layout);
  }
}
