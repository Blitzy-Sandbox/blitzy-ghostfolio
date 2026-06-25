import {
  DashboardLayoutItem,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';

import { DashboardLayoutService } from './dashboard-layout.service';

describe('DashboardLayoutService', () => {
  const layout: DashboardLayoutItem[] = [
    { cols: 4, moduleKey: 'portfolio-overview', rows: 2, x: 0, y: 0 },
    { cols: 8, moduleKey: 'holdings', rows: 4, x: 4, y: 0 }
  ];
  const row = {
    createdAt: '2026-01-01T00:00:00.000Z',
    layoutData: layout,
    updatedAt: '2026-01-01T00:00:00.000Z',
    userId: 'user-1'
  };

  let httpMock: HttpTestingController;
  let service: DashboardLayoutService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });

    httpMock = TestBed.inject(HttpTestingController);
    service = TestBed.inject(DashboardLayoutService);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('get() extracts layoutData from the returned row', () => {
    let result: UserDashboardLayout | null = null;

    service.get().subscribe((value) => (result = value));

    const req = httpMock.expectOne('/api/v1/user/layout');
    expect(req.request.method).toBe('GET');
    req.flush(row);

    // `get()` extracts the row's `layoutData` column and re-wraps it in the
    // shared `UserDashboardLayout` envelope (`{ layout }`), so the canvas always
    // receives the documented shared shape — hence the assertion is the
    // envelope, not the bare item array.
    expect(result).toEqual({ layout });
  });

  it('get() translates an HTTP 404 to null (blank-canvas signal)', () => {
    // Seed with a non-null envelope so the assertion proves the 404 path
    // actively reset the value to `null` (the blank-canvas signal, Rule 10)
    // rather than it simply never having been assigned.
    let result: UserDashboardLayout | null = { layout };

    service.get().subscribe((value) => (result = value));

    httpMock
      .expectOne('/api/v1/user/layout')
      .flush('Not Found', { status: 404, statusText: 'Not Found' });

    expect(result).toBeNull();
  });

  it('get() rethrows a non-404 error', () => {
    let errored = false;

    service.get().subscribe({ error: () => (errored = true) });

    httpMock
      .expectOne('/api/v1/user/layout')
      .flush('Boom', { status: 500, statusText: 'Server Error' });

    expect(errored).toBe(true);
  });

  it('debounces save() by 500ms and PATCHes only the latest layout', fakeAsync(() => {
    service.savedLayout$.subscribe();

    service.save([layout[0]]);
    service.save(layout);

    // Nothing is sent before the debounce window elapses.
    httpMock.expectNone('/api/v1/user/layout');

    tick(500);

    const req = httpMock.expectOne('/api/v1/user/layout');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ layout });
    req.flush(row);
  }));
});
