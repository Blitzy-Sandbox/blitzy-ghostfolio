import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { HEADER_KEY_TOKEN } from '@ghostfolio/common/config';
import {
  DashboardLayout,
  DashboardLayoutPatchPayload
} from '@ghostfolio/common/interfaces';

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
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
 * so no manual token handling is required for {@link get} / {@link patch}.
 *
 * Teardown persistence ({@link persistOnTeardown}) is the one exception: it
 * bypasses `HttpClient` (and therefore the `AuthInterceptor`) so it must
 * attach the token itself — see that method's contract.
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardLayoutService {
  private readonly tokenStorageService = inject(TokenStorageService);

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

  /**
   * Best-effort persistence of the supplied grid state during page teardown
   * (hard reload, tab close, bfcache eviction, or the tab being backgrounded)
   * via a `keepalive` `PATCH /api/v1/user/layout`.
   *
   * Why this exists (fixes QA CP4-Issue1, the flush-on-destroy data-loss bug):
   * the debounced save in {@link DashboardLayoutStoreService} is flushed from
   * Angular teardown hooks (`ngOnDestroy` / `DestroyRef.onDestroy`), but those
   * hooks do NOT run on a hard browser reload or tab close, and the canvas is
   * hard-mounted so it is never destroyed in-app. Even if a hook did fire, the
   * regular {@link patch} issues an asynchronous `HttpClient` XHR that the
   * browser cancels the instant the document starts unloading. A grid change
   * made inside the ~500 ms debounce window before such an unload was therefore
   * lost. This method closes that gap.
   *
   * Transport rationale:
   *   - `fetch(..., { keepalive: true })` is used because the request must
   *     outlive the unloading document AND carry a custom `Authorization`
   *     header. `navigator.sendBeacon()` is deliberately NOT used: it is
   *     `POST`-only (the endpoint is `PATCH`) and cannot set request headers,
   *     so it cannot attach the JWT bearer token Ghostfolio's auth requires.
   *   - The `AuthInterceptor` only augments `HttpClient` requests, so this raw
   *     `fetch` must read the token from {@link TokenStorageService} and set
   *     `Authorization: Bearer <token>` itself (mirroring the interceptor,
   *     using the same {@link HEADER_KEY_TOKEN} constant).
   *
   * The keepalive body is capped by the browser at 64 KB; a dashboard layout
   * (server DTO caps it at 100 items) is well under that limit.
   *
   * @returns `true` when a keepalive request was dispatched (a token exists and
   * `fetch` is available), so the store can optimistically treat the pending
   * change as persisted; `false` when it was a no-op (unauthenticated, or no
   * `fetch` — e.g. a non-browser/test environment), so the store keeps the
   * change pending for a later retry.
   */
  public persistOnTeardown(payload: DashboardLayoutPatchPayload): boolean {
    // Defensive guard for non-browser / test environments where `fetch` is
    // unavailable; nothing can be dispatched, so report a no-op.
    if (typeof fetch !== 'function') {
      return false;
    }

    const token = this.tokenStorageService.getToken();

    // Unauthenticated teardown cannot persist (the endpoint would 401);
    // report a no-op so the caller leaves the change pending.
    if (!token) {
      return false;
    }

    try {
      // Fire-and-forget: the response cannot be observed because the document
      // is going away, but `keepalive` lets the browser complete the request.
      // Swallow any rejection so an unload-time network failure never surfaces
      // as an unhandled promise rejection.
      void fetch('/api/v1/user/layout', {
        body: JSON.stringify(payload),
        headers: {
          [HEADER_KEY_TOKEN]: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        keepalive: true,
        method: 'PATCH'
      }).catch(() => undefined);

      return true;
    } catch {
      // `fetch` can throw synchronously for a malformed request; treat it as a
      // no-op so the change stays pending rather than being silently dropped.
      return false;
    }
  }
}
