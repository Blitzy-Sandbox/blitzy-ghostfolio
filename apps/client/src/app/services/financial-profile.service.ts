import { FinancialProfile } from '@ghostfolio/common/interfaces';

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

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

  public patch(payload: FinancialProfile): Observable<FinancialProfile> {
    return this.http.patch<FinancialProfile>(
      '/api/v1/user/financial-profile',
      payload
    );
  }
}
