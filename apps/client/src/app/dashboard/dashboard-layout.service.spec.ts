import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { HEADER_KEY_TOKEN } from '@ghostfolio/common/config';
import { DashboardLayout } from '@ghostfolio/common/interfaces';

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { DashboardLayoutService } from './dashboard-layout.service';

describe('DashboardLayoutService', () => {
  let httpMock: HttpTestingController;
  let service: DashboardLayoutService;
  // Controllable token source for persistOnTeardown()'s manual Authorization
  // header (the raw keepalive fetch bypasses the AuthInterceptor).
  let tokenStorageMock: { getToken: jest.Mock };
  // Spy over the global `fetch` used by the keepalive teardown transport,
  // restored after each test.
  let fetchMock: jest.Mock;
  let originalFetch: typeof globalThis.fetch;

  const layoutUrl = '/api/v1/user/layout';

  const mockItems = [
    { cols: 6, rows: 4, type: 'portfolio-overview', x: 0, y: 0 },
    { cols: 4, rows: 6, type: 'ai-chat', x: 6, y: 0 }
  ];

  const mockRow = {
    createdAt: '2024-01-01T00:00:00.000Z',
    layoutData: { items: mockItems },
    updatedAt: '2024-01-02T00:00:00.000Z',
    userId: 'user-1'
  };

  beforeEach(() => {
    tokenStorageMock = { getToken: jest.fn(() => 'test-jwt-token') };

    // Install a fetch spy for the keepalive teardown transport. jsdom does not
    // implement fetch, so this both provides it and lets us assert on it.
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn(() => Promise.resolve({ ok: true } as Response));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    TestBed.configureTestingModule({
      providers: [
        DashboardLayoutService,
        { provide: TokenStorageService, useValue: tokenStorageMock },
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    });

    service = TestBed.inject(DashboardLayoutService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    globalThis.fetch = originalFetch;
  });

  describe('get()', () => {
    it('should GET /api/v1/user/layout and lift layoutData.items to a top-level DashboardLayout', () => {
      let result: DashboardLayout | null;

      service.get().subscribe((value) => (result = value));

      const req = httpMock.expectOne(layoutUrl);
      expect(req.request.method).toBe('GET');
      req.flush(mockRow);

      // EXPLICIT reconciliation assertions (returning-user hydration correctness):
      expect(result).toEqual({
        items: mockItems,
        updatedAt: mockRow.updatedAt
      });
      expect(result.items).toBe(mockItems);
      expect((result as any).layoutData).toBeUndefined();
    });

    it('should translate HTTP 404 to null (first-visit user, Rule 10)', () => {
      let result: DashboardLayout | null = { items: [] };

      service.get().subscribe((value) => (result = value));

      httpMock
        .expectOne(layoutUrl)
        .flush('Not Found', { status: 404, statusText: 'Not Found' });

      expect(result).toBeNull();
    });

    it('should re-throw non-404 errors (e.g. 500)', () => {
      let errorStatus: number;

      service
        .get()
        .subscribe({ error: (error) => (errorStatus = error.status) });

      httpMock
        .expectOne(layoutUrl)
        .flush('Server Error', { status: 500, statusText: 'Server Error' });

      expect(errorStatus).toBe(500);
    });
  });

  describe('patch()', () => {
    it('should PATCH the items payload and lift layoutData.items on the response', () => {
      let result: DashboardLayout;

      service
        .patch({ items: mockItems })
        .subscribe((value) => (result = value));

      const req = httpMock.expectOne(layoutUrl);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ items: mockItems });
      req.flush(mockRow);

      expect(result).toEqual({
        items: mockItems,
        updatedAt: mockRow.updatedAt
      });
    });
  });

  describe('persistOnTeardown()', () => {
    it('dispatches a keepalive PATCH carrying the bearer token and returns true (fixes QA CP4-Issue1)', () => {
      const dispatched = service.persistOnTeardown({ items: mockItems });

      expect(dispatched).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(layoutUrl);
      expect(init.method).toBe('PATCH');
      // `keepalive` is what lets the request outlive the unloading document.
      expect(init.keepalive).toBe(true);

      // The AuthInterceptor does not run for a raw fetch, so the token must be
      // attached manually under the same header the interceptor uses.
      const headers = init.headers as Record<string, string>;
      expect(headers[HEADER_KEY_TOKEN]).toBe('Bearer test-jwt-token');
      expect(headers['Content-Type']).toBe('application/json');

      // Body is the same `{ items }` shape patch() sends.
      expect(JSON.parse(init.body as string)).toEqual({ items: mockItems });

      // Crucially, it must NOT go through HttpClient (which the browser would
      // cancel on unload) — no XHR is issued.
      httpMock.expectNone(layoutUrl);
    });

    it('is a no-op returning false when unauthenticated (no token)', () => {
      tokenStorageMock.getToken.mockReturnValue(null);

      const dispatched = service.persistOnTeardown({ items: mockItems });

      expect(dispatched).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is a no-op returning false when fetch is unavailable (non-browser environment)', () => {
      globalThis.fetch = undefined as unknown as typeof globalThis.fetch;

      const dispatched = service.persistOnTeardown({ items: mockItems });

      expect(dispatched).toBe(false);
    });
  });
});
