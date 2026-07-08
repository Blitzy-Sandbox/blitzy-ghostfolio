import {
  DashboardLayout,
  DashboardLayoutItem,
  DashboardLayoutPatchPayload
} from '@ghostfolio/common/interfaces';

import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';

import { DashboardLayoutStoreService } from './dashboard-layout-store.service';
import { DashboardLayoutService } from './dashboard-layout.service';

/**
 * Unit coverage for the signal-based single-source-of-truth grid-state store
 * (Rule 2), focused on the persistence-trigger contract (Rule 4, AAP § 0.7.2)
 * and the layout-fetch loading indicator (AAP § 0.3.2).
 *
 * The store owns the ~500 ms debounced `PATCH /api/v1/user/layout`; these tests
 * mock `DashboardLayoutService` (the HTTP transport, covered by its own spec)
 * and drive the debounce with Angular `fakeAsync` / `tick`.
 *
 * Regression emphasis (QA F-1): gridster invokes `itemChangeCallback` both for
 * genuine user edits AND while laying out the hydrated grid / reflowing as
 * asynchronous wrapped-module data arrives. Persistence MUST fire ONLY for
 * genuine grid state changes — a hydration/reflow callback carrying the
 * unchanged geometry must NOT re-save the layout (which previously caused up to
 * ~6 redundant PATCHes and `updatedAt` churn per page load).
 */
describe('DashboardLayoutStoreService', () => {
  let service: DashboardLayoutStoreService;
  // Test double typed loosely so jest-mock helpers (mockReturnValue etc.) are
  // ergonomic; the store calls get()/patch()/persistOnTeardown() on this
  // collaborator.
  let layoutServiceMock: {
    get: jest.Mock;
    patch: jest.Mock;
    persistOnTeardown: jest.Mock;
  };
  // The most recent payload the store handed to patch(), captured (typed) by the
  // mock implementation so assertions read the persisted geometry without
  // reaching into the untyped `mock.calls`.
  let lastPatchPayload: DashboardLayoutPatchPayload | null;

  const DEBOUNCE_MS = 500;

  const savedItems: DashboardLayoutItem[] = [
    {
      cols: 6,
      minItemCols: 2,
      minItemRows: 2,
      rows: 4,
      type: 'portfolio-overview',
      x: 0,
      y: 0
    },
    {
      cols: 4,
      minItemCols: 2,
      minItemRows: 2,
      rows: 6,
      type: 'ai-chat',
      x: 6,
      y: 0
    }
  ];

  // Fresh deep copy per call so a test mutating an item (simulating a gridster
  // in-place drag/resize) never leaks into another test's fixtures.
  function savedLayout(): DashboardLayout {
    return {
      items: savedItems.map((item) => ({ ...item })),
      updatedAt: '2024-01-02T00:00:00.000Z'
    };
  }

  beforeEach(() => {
    lastPatchPayload = null;
    layoutServiceMock = {
      get: jest.fn(() => of(savedLayout())),
      // Annotating the payload parameter keeps `lastPatchPayload` (and therefore
      // the assertions that read it) fully typed; echo the items back as the
      // server would so the store's success handler advances its baseline.
      patch: jest.fn((payload: DashboardLayoutPatchPayload) => {
        lastPatchPayload = payload;

        return of({
          items: payload.items,
          updatedAt: '2024-01-03T00:00:00.000Z'
        });
      }),
      // Teardown transport (keepalive fetch) — returns true by default to model
      // a successfully dispatched request (an authenticated browser). Tests that
      // need the no-op path override this per-call with mockReturnValueOnce(false).
      persistOnTeardown: jest.fn(() => true)
    };

    TestBed.configureTestingModule({
      providers: [
        DashboardLayoutStoreService,
        { provide: DashboardLayoutService, useValue: layoutServiceMock }
      ]
    });

    // Constructing via the TestBed injector provides the injection context the
    // store's constructor needs for inject(DestroyRef) + takeUntilDestroyed().
    service = TestBed.inject(DashboardLayoutStoreService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('hydrate()', () => {
    it('loads the saved layout into the signal and does NOT schedule a persist (Rule 4)', fakeAsync(() => {
      let hasLayout: boolean;
      service.hydrate().subscribe((value) => (hasLayout = value));
      tick(DEBOUNCE_MS);

      expect(layoutServiceMock.get).toHaveBeenCalledTimes(1);
      expect(service.items().length).toBe(2);
      expect(hasLayout).toBe(true);
      // Hydration must never re-save the freshly loaded layout (AAP § 0.7.2).
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();
    }));

    it('emits false and leaves the canvas empty for a first-visit user (Rule 10)', fakeAsync(() => {
      layoutServiceMock.get.mockReturnValue(of(null));

      let hasLayout: boolean;
      service.hydrate().subscribe((value) => (hasLayout = value));
      tick(DEBOUNCE_MS);

      expect(hasLayout).toBe(false);
      expect(service.items().length).toBe(0);
      expect(service.isEmpty()).toBe(true);
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();
    }));

    it('sets loading() true while the layout GET is in flight and false once it settles (F-2, § 0.3.2)', fakeAsync(() => {
      // Control the GET emission so loading() can be observed mid-flight.
      const get$ = new Subject<DashboardLayout | null>();
      layoutServiceMock.get.mockReturnValue(get$.asObservable());

      expect(service.loading()).toBe(false);

      service.hydrate().subscribe();
      expect(service.loading()).toBe(true);

      get$.next(savedLayout());
      get$.complete();
      expect(service.loading()).toBe(false);
    }));

    it('clears loading() even when the layout GET errors (finalize on error)', fakeAsync(() => {
      const get$ = new Subject<DashboardLayout | null>();
      layoutServiceMock.get.mockReturnValue(get$.asObservable());

      // Subscribe with an error handler so the thrown error is consumed.
      service.hydrate().subscribe({ error: () => undefined });
      expect(service.loading()).toBe(true);

      get$.error(new Error('boom'));
      expect(service.loading()).toBe(false);
    }));
  });

  describe('persistence trigger (Rule 4 / QA F-1)', () => {
    it('does NOT persist when syncFromGrid() fires with the hydrated geometry unchanged (hydration/reflow is inert)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();

      // Simulate gridster's itemChangeCallback firing during initial layout and
      // on later async-data reflow: same geometry, no user edit.
      service.syncFromGrid();
      service.syncFromGrid();
      service.syncFromGrid();
      tick(DEBOUNCE_MS);

      // The core F-1 assertion: zero spurious PATCHes on a zero-interaction load.
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();
    }));

    it('never persists via publishFromGridWithoutPersist() (itemInitCallback path)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      service.publishFromGridWithoutPersist();
      service.publishFromGridWithoutPersist();
      tick(DEBOUNCE_MS);

      expect(layoutServiceMock.patch).not.toHaveBeenCalled();
    }));

    it('persists exactly once (debounced) when syncFromGrid() fires after a genuine geometry change', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      // Mutate a bound item in place, exactly as gridster does on a user drag,
      // then fire a burst of change callbacks — they must coalesce into one PATCH.
      const item = service.items()[0] as { x: number; y: number };
      item.x = 3;
      item.y = 2;
      service.syncFromGrid();
      service.syncFromGrid();
      tick(DEBOUNCE_MS);

      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);
      expect(lastPatchPayload?.items[0]).toEqual(
        expect.objectContaining({ x: 3, y: 2 })
      );
    }));

    it('does not re-persist an unchanged reflow after a genuine change was saved (baseline advances on save)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      const item = service.items()[0] as { cols: number };
      item.cols = 8;
      service.syncFromGrid();
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);

      // A later reflow carrying the now-saved geometry must be inert.
      service.syncFromGrid();
      service.syncFromGrid();
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);
    }));

    it('persists when a module is added via addItem() (Rule 4)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      layoutServiceMock.patch.mockClear();

      service.addItem({
        cols: 4,
        minItemCols: 2,
        minItemRows: 2,
        rows: 4,
        type: 'holdings',
        x: 0,
        y: 10
      });
      tick(DEBOUNCE_MS);

      expect(service.items().length).toBe(3);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);
    }));

    it('persists when a module is removed via removeItem() (Rule 4)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      layoutServiceMock.patch.mockClear();

      const target = service.items()[0];
      service.removeItem(target);
      tick(DEBOUNCE_MS);

      expect(service.items().length).toBe(1);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);
    }));

    it('retries a failed save on the next grid event because the baseline is not advanced on error', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      const item = service.items()[0] as { cols: number; rows: number };
      item.cols = 9;

      // First save fails: baseline stays at the hydrated layout, pending flag re-raised.
      layoutServiceMock.patch.mockReturnValueOnce(
        throwError(() => new Error('network'))
      );
      service.syncFromGrid();
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);

      // Next genuine edit retries the (still-pending) change and now succeeds.
      item.rows = 7;
      service.syncFromGrid();
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(2);
    }));

    it('emits saveError$ when a save fails (and not when it succeeds) so the shell can surface it (QA F7)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      let saveErrorCount = 0;
      service.saveError$.subscribe(() => (saveErrorCount += 1));

      const item = service.items()[0] as { cols: number; rows: number };

      // A successful save must NOT emit saveError$.
      item.cols = 9;
      service.syncFromGrid();
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);
      expect(saveErrorCount).toBe(0);

      // A failing save MUST emit saveError$ exactly once (the store notifies;
      // it never shows UI itself — Rule 2 headless single source of truth).
      item.rows = 7;
      layoutServiceMock.patch.mockReturnValueOnce(
        throwError(() => new Error('network'))
      );
      service.syncFromGrid();
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(2);
      expect(saveErrorCount).toBe(1);
    }));
  });

  describe('flush()', () => {
    it('persists a pending change immediately, bypassing the debounce (§ 0.7.2)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      layoutServiceMock.patch.mockClear();

      service.addItem({
        cols: 4,
        minItemCols: 2,
        minItemRows: 2,
        rows: 4,
        type: 'holdings',
        x: 0,
        y: 10
      });
      // Flush BEFORE the debounce window elapses — the save must fire now.
      service.flush();
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);

      // Draining the pending debounce afterwards must NOT double-persist.
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);
    }));

    it('is a no-op when there is no pending change', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      layoutServiceMock.patch.mockClear();

      service.flush();
      tick(DEBOUNCE_MS);

      expect(layoutServiceMock.patch).not.toHaveBeenCalled();
    }));
  });

  /**
   * Browser-teardown persistence (fixes QA CP4-Issue1, the flush-on-destroy
   * data-loss bug): a grid change made inside the ~500 ms debounce window before
   * a hard reload / tab close was lost because the Angular destroy hooks do not
   * run on browser unload and the async `HttpClient` PATCH is cancelled by the
   * unload. `flushOnUnload()` (wired to `pagehide` / `visibilitychange`) routes
   * the pending change through the `keepalive` teardown transport instead.
   */
  describe('flushOnUnload() / browser teardown (QA CP4-Issue1)', () => {
    // Applies a genuine in-place geometry change and marks it pending WITHOUT
    // letting the debounce elapse — the exact "edit inside the debounce window"
    // precondition of the data-loss bug.
    function makePendingChange(): void {
      const item = service.items()[0] as { x: number; y: number };
      item.x = 4;
      item.y = 8;
      service.syncFromGrid();
    }

    it('persists a pending change via the keepalive teardown transport (not the async patch) and advances the baseline so the trailing debounce does not double-save', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      layoutServiceMock.patch.mockClear();

      makePendingChange();
      service.flushOnUnload();

      // Sent via the keepalive transport carrying the mutated geometry — the
      // regular async patch (which the browser would cancel on unload) is NOT used.
      expect(layoutServiceMock.persistOnTeardown).toHaveBeenCalledTimes(1);
      const sent = layoutServiceMock.persistOnTeardown.mock
        .calls[0][0] as DashboardLayoutPatchPayload;
      expect(sent.items[0]).toEqual(expect.objectContaining({ x: 4, y: 8 }));
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();

      // Pending cleared + baseline advanced: draining the still-armed debounce
      // must NOT produce a duplicate save.
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();
      expect(layoutServiceMock.persistOnTeardown).toHaveBeenCalledTimes(1);
    }));

    it('is a no-op when nothing is pending (e.g. a zero-interaction load)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      service.flushOnUnload();

      expect(layoutServiceMock.persistOnTeardown).not.toHaveBeenCalled();
    }));

    it('leaves the change pending when the teardown transport reports a no-op (e.g. unauthenticated), so a later flush retries it', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      layoutServiceMock.patch.mockClear();

      makePendingChange();

      // Transport could not dispatch (no token / no fetch): the change must
      // remain pending rather than being silently dropped.
      layoutServiceMock.persistOnTeardown.mockReturnValueOnce(false);
      service.flushOnUnload();
      expect(layoutServiceMock.persistOnTeardown).toHaveBeenCalledTimes(1);

      // A subsequent in-app flush retries the still-pending change via patch().
      service.flush();
      expect(layoutServiceMock.patch).toHaveBeenCalledTimes(1);
      expect(lastPatchPayload?.items[0]).toEqual(
        expect.objectContaining({ x: 4, y: 8 })
      );
    }));

    it('flushes a pending change on the window "pagehide" event (hard reload / tab close)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);
      layoutServiceMock.patch.mockClear();

      makePendingChange();

      // pagehide fires before the debounce window elapses.
      window.dispatchEvent(new Event('pagehide'));

      expect(layoutServiceMock.persistOnTeardown).toHaveBeenCalledTimes(1);
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();

      // The still-armed debounce must not double-persist.
      tick(DEBOUNCE_MS);
      expect(layoutServiceMock.patch).not.toHaveBeenCalled();
    }));

    it('flushes a pending change when the tab is backgrounded (visibilitychange -> hidden)', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      makePendingChange();

      // Shadow the prototype getter so the store sees the tab as hidden.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden'
      });
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        expect(layoutServiceMock.persistOnTeardown).toHaveBeenCalledTimes(1);
      } finally {
        // Revert to the jsdom prototype getter ('visible') for other tests.
        delete (document as unknown as { visibilityState?: unknown })
          .visibilityState;
      }
    }));

    it('does NOT flush on visibilitychange while the document is still visible', fakeAsync(() => {
      service.hydrate().subscribe();
      tick(DEBOUNCE_MS);

      makePendingChange();

      // visibilityState defaults to 'visible' in jsdom — a tab-focus change, not
      // a teardown, must not trigger a teardown persist.
      document.dispatchEvent(new Event('visibilitychange'));

      expect(layoutServiceMock.persistOnTeardown).not.toHaveBeenCalled();
    }));
  });
});
