import {
  FinancialProfile,
  FinancialProfilePatchPayload
} from '@ghostfolio/common/interfaces';

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * Client-side wrapper for the `/api/v1/user/financial-profile` endpoint
 * pair (per AAP § 0.1.1 Feature B/C support and § 0.5.1.1
 * `UserFinancialProfileController`).
 *
 * Error semantics:
 *   - `get()` translates HTTP 404 to `null` so the form component can
 *     treat "no record yet" as a normal case (per AAP § 0.5.3 — show empty
 *     form on 404). All other errors are re-thrown.
 *   - `patch()` returns the persisted `FinancialProfile`; the caller is
 *     responsible for catching errors and updating UI state.
 *
 * The `JwtInterceptor` / `AuthInterceptor` automatically attaches the JWT
 * `Authorization: Bearer ...` header to every `HttpClient` request, so no
 * manual token handling is required here.
 */
@Injectable({
  providedIn: 'root'
})
export class FinancialProfileService {
  public constructor(private http: HttpClient) {}

  public get(): Observable<FinancialProfile | null> {
    return this.http
      .get<FinancialProfile>('/api/v1/user/financial-profile')
      .pipe(
        catchError((error: HttpErrorResponse) => {
          // Per AAP § 0.5.3, the FinancialProfileFormComponent shows an empty
          // form on HTTP 404 (no record yet). Translate 404 to null so the
          // component does not need to know HTTP status codes.
          if (error.status === 404) {
            return of(null);
          }

          return throwError(() => error);
        })
      );
  }

  /**
   * Persists the supplied payload via `PATCH /api/v1/user/financial-profile`.
   *
   * The input type is `FinancialProfilePatchPayload`, which omits the
   * server-controlled fields (`userId`, `createdAt`, `updatedAt`):
   *   - `userId` is sourced authoritatively from the JWT on the server.
   *   - `createdAt` is set by the Prisma default on first upsert.
   *   - `updatedAt` is maintained by the `@updatedAt` Prisma directive.
   *
   * Tightening the input type at the client boundary prevents the form
   * component from accidentally constructing placeholder values for the
   * server-only fields. The server-side DTO validates and discards any
   * such fields if they were sent, so this is a defense-in-depth typing
   * improvement (not a security boundary).
   */
  public patch(
    payload: FinancialProfilePatchPayload
  ): Observable<FinancialProfile> {
    return this.http.patch<FinancialProfile>(
      '/api/v1/user/financial-profile',
      payload
    );
  }
}
