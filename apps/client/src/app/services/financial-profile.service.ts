import { FinancialProfile } from '@ghostfolio/common/interfaces';

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, of, throwError } from 'rxjs';

/**
 * Server endpoints for the financial-profile data API.
 *
 * Per AAP § 0.1.1.1, all backend routes are URI-versioned through `/api/v1`.
 * The endpoint matrix in AAP § 0.1.2.4 specifies `GET` and `PATCH`
 * `/api/user/financial-profile` (which resolves to `/api/v1/user/...` after
 * versioning is applied).
 */
const FINANCIAL_PROFILE_ENDPOINT = '/api/v1/user/financial-profile';

/**
 * Client-side wrapper for the per-user financial profile data API.
 *
 * Per AAP § 0.5.3, the host component (`FinancialProfileFormComponent`)
 * pre-populates form fields when the server returns 200 with an existing
 * record and shows an empty form when the server returns 404 (first-time
 * setup). This service translates the HTTP 404 status into a `null` emission
 * inside `get()` so the calling component can branch on a simple
 * `null`-check rather than catching an `HttpErrorResponse`. All other error
 * codes propagate to the caller as RxJS errors.
 *
 * `patch()` does NOT translate 404 — the `PATCH` endpoint is an upsert per
 * AAP § 0.1.1, so it should never produce a 404, and any error from `patch()`
 * is a real failure that the caller must handle.
 *
 * The `Authorization: Bearer <token>` header is attached automatically by
 * the registered `AuthInterceptor`; no manual token handling is required.
 */
@Injectable({ providedIn: 'root' })
export class FinancialProfileService {
  public constructor(private httpClient: HttpClient) {}

  /**
   * Loads the authenticated user's financial profile, if one exists.
   *
   * Returns `null` (rather than erroring) when the server responds with
   * HTTP 404 — that status indicates "no profile has been saved yet" and is
   * a normal first-time-setup state per AAP § 0.5.3, not a failure. All
   * other error statuses propagate through as RxJS errors so callers can
   * distinguish first-time-setup (`null`) from real failures (error path).
   */
  public get(): Observable<FinancialProfile | null> {
    return this.httpClient
      .get<FinancialProfile>(FINANCIAL_PROFILE_ENDPOINT)
      .pipe(
        catchError((error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 404) {
            return of(null);
          }

          return throwError(() => error);
        })
      );
  }

  /**
   * Upserts the authenticated user's financial profile. The server endpoint
   * is JWT-authenticated and scopes every Prisma operation by the
   * authenticated user ID (Rule 5), so the request body MUST NOT include a
   * `userId` field. Server-side validation (`FinancialProfileDto`) is
   * authoritative; this client method is a thin pass-through.
   */
  public patch(profile: FinancialProfile): Observable<FinancialProfile> {
    return this.httpClient.patch<FinancialProfile>(
      FINANCIAL_PROFILE_ENDPOINT,
      profile
    );
  }
}
