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
    TestBed.configureTestingModule({
      providers: [
        DashboardLayoutService,
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    });

    service = TestBed.inject(DashboardLayoutService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
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
});
