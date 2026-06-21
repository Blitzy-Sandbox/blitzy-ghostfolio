import {
  LayoutData,
  UserDashboardLayout,
  UserDashboardLayoutPatchPayload
} from '@ghostfolio/common/interfaces';

import { HttpErrorResponse } from '@angular/common/http';
import {
  HttpClientTestingModule,
  HttpTestingController
} from '@angular/common/http/testing';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';

import { DashboardLayoutService } from './dashboard-layout.service';

/**
 * Co-located Jest unit suite for {@link DashboardLayoutService}.
 *
 * The service is the SOLE client-side wrapper for the
 * `GET`/`PATCH /api/v1/user/layout` endpoint pair. This suite verifies the
 * two behaviours the dashboard canvas relies on:
 *
 *   1. `get()` read semantics — a saved layout is returned verbatim, HTTP
 *      404 is translated to `null` (the "first visit / no saved layout"
 *      signal that drives the blank-canvas + auto-open-catalog flow), and
 *      every other HTTP error is re-thrown rather than silently swallowed.
 *   2. `queueSave()` persistence semantics — rapid successive grid
 *      state-change events collapse into a SINGLE debounced `PATCH` (500ms
 *      window, latest-payload-wins via `switchMap`), and the request body
 *      carries exactly the `{ layoutData }` patch payload with none of the
 *      server-owned fields.
 *
 * Tooling notes:
 *   - `HttpClientTestingModule` + `HttpTestingController` assert the exact
 *     verb, URL, and body of every request with no real network access.
 *   - `fakeAsync` + `tick(500)` drive the `debounceTime(500)` persistence
 *     channel deterministically.
 *   - The SUT is obtained via `TestBed.inject(...)` (NOT `new`): its
 *     constructor calls `takeUntilDestroyed()`, which requires an Angular
 *     injection context and throws `NG0203` when invoked outside of one.
 */

const LAYOUT_URL = '/api/v1/user/layout';

const mockLayoutData: LayoutData = {
  schemaVersion: 1,
  items: [{ moduleKey: 'holdings', x: 0, y: 0, cols: 6, rows: 4 }]
};

const mockLayout: UserDashboardLayout = {
  userId: 'user-1',
  layoutData: mockLayoutData,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe('DashboardLayoutService', () => {
  let service: DashboardLayoutService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [DashboardLayoutService]
    });

    service = TestBed.inject(DashboardLayoutService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Assert that no test left an unmatched or outstanding HTTP request.
    httpMock.verify();
    jest.clearAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('get()', () => {
    it('should return the saved layout on a 200 response', () => {
      let result: UserDashboardLayout | null | undefined;

      service.get().subscribe((value) => {
        result = value;
      });

      const req = httpMock.expectOne(LAYOUT_URL);
      expect(req.request.method).toBe('GET');

      req.flush(mockLayout);

      expect(result).toEqual(mockLayout);
    });

    it('should translate an HTTP 404 into a null emission (first-visit signal)', () => {
      let result: UserDashboardLayout | null | undefined;
      let errored = false;

      service.get().subscribe({
        next: (value) => {
          result = value;
        },
        error: () => {
          errored = true;
        }
      });

      const req = httpMock.expectOne(LAYOUT_URL);
      expect(req.request.method).toBe('GET');

      req.flush(null, { status: 404, statusText: 'Not Found' });

      // A 404 MUST surface as `null` (not as an error) so the canvas can
      // treat it as the "no saved layout yet" onboarding case.
      expect(result).toBeNull();
      expect(errored).toBe(false);
    });

    it('should re-throw a non-404 error instead of swallowing it to null', () => {
      let caughtError: HttpErrorResponse | undefined;
      let nextEmissions = 0;

      service.get().subscribe({
        next: () => {
          nextEmissions += 1;
        },
        error: (error: HttpErrorResponse) => {
          caughtError = error;
        }
      });

      const req = httpMock.expectOne(LAYOUT_URL);
      expect(req.request.method).toBe('GET');

      req.flush('Server error', {
        status: 500,
        statusText: 'Internal Server Error'
      });

      // The error MUST reach the subscriber unchanged — a 500 is not a
      // first-visit signal and must never be coerced to `null`.
      expect(caughtError).toBeDefined();
      expect(caughtError?.status).toBe(500);
      expect(nextEmissions).toBe(0);
    });
  });

  describe('queueSave()', () => {
    it('should debounce rapid calls into a single PATCH carrying the latest payload', fakeAsync(() => {
      // Two grid state-change events fire in quick succession (e.g. a drag
      // immediately followed by a resize).
      service.queueSave({ layoutData: { schemaVersion: 1, items: [] } });
      service.queueSave({ layoutData: mockLayoutData });

      // Before the 500ms debounce window elapses, nothing is sent.
      httpMock.expectNone(LAYOUT_URL);

      tick(500);

      // Once the window settles, exactly ONE PATCH is issued and it carries
      // the LATEST payload (switchMap is latest-wins).
      const req = httpMock.expectOne(LAYOUT_URL);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ layoutData: mockLayoutData });

      req.flush(mockLayout);
    }));

    it('should send a PATCH body of exactly { layoutData } with no server-owned fields', fakeAsync(() => {
      const payload: UserDashboardLayoutPatchPayload = {
        layoutData: mockLayoutData
      };

      service.queueSave(payload);
      tick(500);

      const req = httpMock.expectOne(LAYOUT_URL);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ layoutData: mockLayoutData });

      // The patch payload MUST NOT leak server-authoritative fields
      // (`userId`, `createdAt`, `updatedAt`).
      const body = req.request.body as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['layoutData']);
      expect(body['userId']).toBeUndefined();
      expect(body['createdAt']).toBeUndefined();
      expect(body['updatedAt']).toBeUndefined();

      req.flush(mockLayout);
    }));

    it('should emit an independent PATCH for each settled debounce window', fakeAsync(() => {
      // First window.
      service.queueSave({ layoutData: { schemaVersion: 1, items: [] } });
      tick(500);

      const firstRequest = httpMock.expectOne(LAYOUT_URL);
      expect(firstRequest.request.method).toBe('PATCH');
      expect(firstRequest.request.body).toEqual({
        layoutData: { schemaVersion: 1, items: [] }
      });
      firstRequest.flush(mockLayout);

      // Second, fully independent window.
      service.queueSave({ layoutData: mockLayoutData });
      tick(500);

      const secondRequest = httpMock.expectOne(LAYOUT_URL);
      expect(secondRequest.request.method).toBe('PATCH');
      expect(secondRequest.request.body).toEqual({
        layoutData: mockLayoutData
      });
      secondRequest.flush(mockLayout);
    }));

    it('emits on saveError$ when a PATCH fails and keeps processing later saves (QA Issue #7)', fakeAsync(() => {
      // A plain Subject does not replay, so subscribe BEFORE the failing save.
      let saveErrorCount = 0;
      const subscription = service.saveError$.subscribe(() => {
        saveErrorCount += 1;
      });

      // Silence the expected console.error so the test output stays clean while
      // still asserting the user-facing failure signal.
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      // First window: the PATCH fails (e.g. offline / 500).
      service.queueSave({ layoutData: mockLayoutData });
      tick(500);

      httpMock.expectOne(LAYOUT_URL).flush('Server error', {
        status: 500,
        statusText: 'Internal Server Error'
      });

      // The failure is re-surfaced to observers exactly once (QA Issue #7).
      expect(saveErrorCount).toBe(1);

      // The outer persistence stream MUST stay alive: a later save still issues
      // its PATCH (the inner catchError contains the error so debounceTime /
      // switchMap are not torn down, never permanently disabling saves).
      service.queueSave({ layoutData: { schemaVersion: 1, items: [] } });
      tick(500);

      const nextRequest = httpMock.expectOne(LAYOUT_URL);
      expect(nextRequest.request.method).toBe('PATCH');
      nextRequest.flush(mockLayout);

      subscription.unsubscribe();
      consoleErrorSpy.mockRestore();
    }));
  });
});
