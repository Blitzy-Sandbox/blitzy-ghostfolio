import {
  UserDashboardLayout,
  UserDashboardLayoutPatchPayload
} from '@ghostfolio/common/interfaces';

import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';

import { DashboardLayoutService } from './dashboard-layout.service';

/**
 * Unit tests for {@link DashboardLayoutService} — the persistence boundary
 * for the dashboard grid layout. The suite verifies the two AAP-mandated
 * behaviours of this service:
 *
 *   1. Read path (mirrors `FinancialProfileService`): `get()` resolves to
 *      the saved row on HTTP 200, to `null` on HTTP 404 (first-visit
 *      detection), and re-throws every other error verbatim.
 *
 *   2. Write path (grid-event-driven, debounced): `queueSave()` is the sole
 *      public save entrypoint; rapid invocations collapse into at most one
 *      `PATCH /api/v1/user/layout` per 500ms window (latest-wins via
 *      `switchMap`), and each independent window issues its own request.
 *
 * The service is always obtained via `TestBed.inject(...)` rather than
 * constructed directly, because the constructor calls `takeUntilDestroyed()`
 * which requires an active injection context to resolve its `DestroyRef`.
 */
const LAYOUT_URL = '/api/v1/user/layout';

const mockLayout: UserDashboardLayout = {
  userId: 'user-1',
  layoutData: {
    schemaVersion: 1,
    items: [{ moduleKey: 'allocations', x: 0, y: 0, cols: 4, rows: 4 }]
  },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z'
};

function buildPayload(moduleKey: string): UserDashboardLayoutPatchPayload {
  return {
    layoutData: {
      schemaVersion: 1,
      items: [{ moduleKey, x: 0, y: 0, cols: 6, rows: 4 }]
    }
  };
}

describe('DashboardLayoutService', () => {
  let service: DashboardLayoutService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });

    // Inject (do not `new`) so the constructor's `takeUntilDestroyed()` runs
    // inside a valid injection context.
    service = TestBed.inject(DashboardLayoutService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Fails the test if any request was issued but never flushed/expected.
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('get()', () => {
    it('should issue GET /api/v1/user/layout and emit the saved row on 200', () => {
      let emitted: UserDashboardLayout | null | undefined;

      service.get().subscribe((value) => {
        emitted = value;
      });

      const req = httpMock.expectOne(LAYOUT_URL);

      expect(req.request.method).toBe('GET');

      req.flush(mockLayout);

      expect(emitted).toEqual(mockLayout);
    });

    it('should translate HTTP 404 to null (first-visit case)', () => {
      let emitted: UserDashboardLayout | null | undefined;
      let errored = false;

      service.get().subscribe({
        next: (value) => {
          emitted = value;
        },
        error: () => {
          errored = true;
        }
      });

      const req = httpMock.expectOne(LAYOUT_URL);

      req.flush(null, { status: 404, statusText: 'Not Found' });

      expect(emitted).toBeNull();
      expect(errored).toBe(false);
    });

    it('should re-throw non-404 errors verbatim', () => {
      let caughtError: HttpErrorResponse | undefined;
      let emittedNext = false;

      service.get().subscribe({
        next: () => {
          emittedNext = true;
        },
        error: (error: HttpErrorResponse) => {
          caughtError = error;
        }
      });

      const req = httpMock.expectOne(LAYOUT_URL);

      req.flush('Server error', {
        status: 500,
        statusText: 'Internal Server Error'
      });

      expect(emittedNext).toBe(false);
      expect(caughtError).toBeInstanceOf(HttpErrorResponse);
      expect(caughtError?.status).toBe(500);
    });
  });

  describe('queueSave()', () => {
    it('should collapse rapid calls into exactly one PATCH per 500ms window', fakeAsync(() => {
      service.queueSave(buildPayload('first'));
      service.queueSave(buildPayload('second'));

      const latestPayload = buildPayload('latest');
      service.queueSave(latestPayload);

      // Nothing should be sent until the debounce window elapses.
      httpMock.expectNone(LAYOUT_URL);

      tick(500);

      const req = httpMock.expectOne(LAYOUT_URL);

      expect(req.request.method).toBe('PATCH');
      // `switchMap` is latest-wins: the body is the most recent payload.
      expect(req.request.body).toEqual(latestPayload);

      req.flush(mockLayout);

      // No further request is produced from the collapsed window.
      httpMock.expectNone(LAYOUT_URL);
    }));

    it('should not issue a PATCH before the 500ms debounce elapses', fakeAsync(() => {
      service.queueSave(buildPayload('pending'));

      tick(499);
      httpMock.expectNone(LAYOUT_URL);

      // Advancing past the boundary fires the (single) debounced request.
      tick(1);
      const req = httpMock.expectOne(LAYOUT_URL);

      expect(req.request.method).toBe('PATCH');

      req.flush(mockLayout);
    }));

    it('should issue a separate PATCH for each independent debounce window', fakeAsync(() => {
      const firstPayload = buildPayload('window-1');
      service.queueSave(firstPayload);
      tick(500);
      const firstRequest = httpMock.expectOne(LAYOUT_URL);

      expect(firstRequest.request.body).toEqual(firstPayload);
      firstRequest.flush(mockLayout);

      const secondPayload = buildPayload('window-2');
      service.queueSave(secondPayload);
      tick(500);
      const secondRequest = httpMock.expectOne(LAYOUT_URL);

      expect(secondRequest.request.body).toEqual(secondPayload);
      secondRequest.flush(mockLayout);
    }));

    it('should send only { layoutData } in the PATCH body', fakeAsync(() => {
      const payload = buildPayload('body-shape');
      service.queueSave(payload);

      tick(500);

      const req = httpMock.expectOne(LAYOUT_URL);

      expect(req.request.method).toBe('PATCH');
      // The wire payload is a `UserDashboardLayoutPatchPayload`: exactly the
      // `layoutData` key. Server-controlled fields are never sent — `userId`
      // is read from the JWT and `createdAt`/`updatedAt` are maintained by
      // Prisma's `@default(now())` / `@updatedAt` directives.
      expect(req.request.body).toEqual(payload);
      expect(req.request.body).not.toHaveProperty('userId');
      expect(req.request.body).not.toHaveProperty('createdAt');
      expect(req.request.body).not.toHaveProperty('updatedAt');

      req.flush(mockLayout);
    }));
  });

  describe('public API surface', () => {
    it('should expose queueSave as the only public write method', () => {
      expect(typeof service.queueSave).toBe('function');
      // Persistence must be debounced + grid-event-driven only; no direct
      // write methods may leak onto the public surface.
      expect('patch' in service).toBe(false);
      expect('save' in service).toBe(false);
    });
  });
});
