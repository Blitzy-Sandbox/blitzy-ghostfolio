import {
  DashboardLayout,
  DashboardLayoutPatchPayload
} from '@ghostfolio/common/interfaces';

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

/**
 * Raw persistence row returned by `GET`/`PATCH /api/v1/user/layout`.
 *
 * The server returns the full Prisma `UserDashboardLayout` record, so the
 * layout payload the client actually consumes lives one level down under
 * `layoutData`. This local shape exists purely to type the raw HTTP response
 * so that `row.layoutData.items` type-checks; callers of this service never
 * see it — both `get()` and `patch()` lift `layoutData` up to a top-level
 * `DashboardLayout` before emitting (see the response-shape reconciliation
 * note on the class).
 */
interface UserDashboardLayoutRow {
  createdAt: Date | string;
  layoutData: DashboardLayout;
  updatedAt: Date | string;
  userId: string;
}

/**
 * Client-side wrapper for the `/api/v1/user/layout` endpoint pair
 * (per AAP § 0.4.3 client HTTP repository, § 0.5.1, § 0.7.6). It is the sole
 * transport used by `DashboardLayoutStoreService` to hydrate the canvas on
 * load (`get()`) and to persist the canonical grid state on the debounced
 * save (`patch()`).
 *
 * Error semantics:
 *   - `get()` translates HTTP 404 to `null` so the canvas can treat
 *     "no saved layout yet" as a normal first-visit case (Rule 10 — a null
 *     layout triggers a blank canvas + auto-opened module catalog). All
 *     other errors are re-thrown so the caller can surface them.
 *   - both methods lift the persisted `layoutData` up to a top-level
 *     `DashboardLayout` (`{ items, updatedAt }`) so callers never reach
 *     through `layoutData`. Skipping this lift would make returning-user
 *     hydration read `undefined` and collapse to a blank canvas, breaking
 *     the "returning user: saved layout loaded on init" acceptance check
 *     (AAP § 0.8.3).
 *
 * The `AuthInterceptor` (see `core/auth.interceptor`) automatically attaches
 * the JWT `Authorization: Bearer ...` header to every `HttpClient` request,
 * so no manual token handling is required here.
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardLayoutService {
  public constructor(private http: HttpClient) {}

  /**
   * Fetches the authenticated user's persisted dashboard layout via
   * `GET /api/v1/user/layout`.
   *
   * Resolves to the reconciled `DashboardLayout` (`{ items, updatedAt }`) when
   * a record exists, or to `null` when the server responds `404`
   * (`NotFoundException` — first visit, no saved layout). Any non-404 error is
   * re-thrown untouched.
   */
  public get(): Observable<DashboardLayout | null> {
    return this.http.get<UserDashboardLayoutRow>('/api/v1/user/layout').pipe(
      catchError((error: HttpErrorResponse) => {
        // Per Rule 10, a first-visit user has no saved layout; the server
        // responds 404 (NotFoundException). Translate 404 to null so the
        // canvas renders a blank grid and auto-opens the catalog. Every
        // other status is a genuine failure and is re-thrown.
        if (error.status === 404) {
          return of(null);
        }

        return throwError(() => error);
      }),
      // `catchError` above may emit `null` (the 404 branch), so the lift
      // must tolerate it. When a row is present, hoist `layoutData.items`
      // to the top level alongside the server-authoritative `updatedAt`.
      map((row) =>
        row ? { items: row.layoutData.items, updatedAt: row.updatedAt } : null
      )
    );
  }

  /**
   * Persists the supplied grid state via `PATCH /api/v1/user/layout` and
   * resolves to the upserted layout.
   *
   * The input type is `DashboardLayoutPatchPayload` (`{ items }`), which omits
   * the server-controlled fields:
   *   - `userId` is sourced authoritatively from the JWT on the server.
   *   - `createdAt` is set by the Prisma default on first upsert.
   *   - `updatedAt` is maintained by the `@updatedAt` Prisma directive.
   *
   * The response (the full persisted row) is reconciled to a top-level
   * `DashboardLayout` via the same `layoutData` lift used by `get()`, so the
   * store can adopt the returned `updatedAt` without reaching through
   * `layoutData`.
   */
  public patch(
    payload: DashboardLayoutPatchPayload
  ): Observable<DashboardLayout> {
    return this.http
      .patch<UserDashboardLayoutRow>('/api/v1/user/layout', payload)
      .pipe(
        map((row) => ({
          items: row.layoutData.items,
          updatedAt: row.updatedAt
        }))
      );
  }
}
