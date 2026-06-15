import { DashboardLayoutService } from '@ghostfolio/client/dashboard/dashboard-layout.service';
import {
  DashboardItem,
  MODULE_DRAG_DATA_TYPE
} from '@ghostfolio/client/dashboard/dashboard.types';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at runtime.
// The `dashboard-canvas.component.html` template carries `i18n` attributes (the
// "Add module" button label and tooltip, the canvas `aria-label`) which the
// Angular compiler lowers to `$localize` tagged-template calls. Without this
// side-effect import the component would throw `ReferenceError: $localize is
// not defined` whenever the template is created. Placed in the `@angular`
// import group exactly as the sibling `module-catalog.component.spec.ts` does.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Gridster, GridsterItem } from 'angular-gridster2';
import { of } from 'rxjs';

import { GfDashboardCanvasComponent } from './dashboard-canvas.component';

// Replace the real `ModuleRegistryService` with a bare stand-in class usable
// only as a DI token. The real `module-registry.service.ts` statically imports
// all twelve wrapper components -> the real feature components ->
// `@ionic/angular/standalone` -> `@ionic/core`, which ships plain ESM `.js`
// files that Jest cannot parse under the project's
// `transformIgnorePatterns` rule. Mocking the registry module path
// short-circuits that entire transitive ESM chain. The factory references NO
// outer variables (no hoisting pitfall); each test supplies behavior through a
// `useValue` provider, so the component's `inject(ModuleRegistryService)` and
// this spec's `ModuleRegistryService` token resolve to the SAME stand-in.
jest.mock('@ghostfolio/client/dashboard/module-registry.service', () => ({
  ModuleRegistryService: class {}
}));

// A minimal registry of two modules with differing widths, enough to exercise
// hydrate, add, first-fit and non-overlap. `component` is a throwaway stub: the
// canvas never instantiates it in these tests because none of them render the
// `*ngComponentOutlet` (no `fixture.detectChanges()` is invoked).
const MODULE_DEFINITIONS: Record<
  string,
  {
    component: unknown;
    displayName: string;
    icon: string;
    key: string;
    minItemCols: number;
    minItemRows: number;
  }
> = {
  holdings: {
    component: class {},
    displayName: 'Holdings',
    icon: 'account_balance_wallet',
    key: 'holdings',
    minItemCols: 6,
    minItemRows: 4
  },
  markets: {
    component: class {},
    displayName: 'Markets',
    icon: 'trending_up',
    key: 'markets',
    minItemCols: 4,
    minItemRows: 3
  }
};

// Builds a fake `DragEvent` carrying the supplied module key under
// `MODULE_DRAG_DATA_TYPE`. `preventDefault`, `getData` and `types` are spied so
// the canvas drop/drag-over handlers can be asserted against.
function buildDragEvent(key: string | null) {
  const preventDefault = jest.fn();
  const dataTransfer = {
    dropEffect: 'none',
    getData: jest.fn(() => key ?? ''),
    types: key ? [MODULE_DRAG_DATA_TYPE] : []
  };

  return {
    event: {
      dataTransfer,
      preventDefault
    } as unknown as DragEvent,
    dataTransfer,
    preventDefault
  };
}

describe('GfDashboardCanvasComponent', () => {
  let component: GfDashboardCanvasComponent;
  let fixture: ComponentFixture<GfDashboardCanvasComponent>;
  let getSpy: jest.Mock;
  let queueSaveSpy: jest.Mock;
  let registryGetSpy: jest.Mock;

  beforeEach(async () => {
    // Default: first-visit (no saved layout). Individual tests override the
    // return value before invoking `ngOnInit`.
    getSpy = jest.fn(() => of(null));
    queueSaveSpy = jest.fn();
    registryGetSpy = jest.fn(
      (key: string) => MODULE_DEFINITIONS[key] ?? undefined
    );

    TestBed.configureTestingModule({
      imports: [GfDashboardCanvasComponent, NoopAnimationsModule],
      providers: [
        {
          provide: DashboardLayoutService,
          useValue: { get: getSpy, queueSave: queueSaveSpy }
        },
        {
          provide: ModuleRegistryService,
          useValue: { get: registryGetSpy, getAll: jest.fn(() => []) }
        }
      ]
    });

    // The real `angular-gridster2` engine needs a laid-out DOM (ResizeObserver,
    // element measurements) that jsdom does not provide, and its required
    // `options` signal input would otherwise trip NG0950 on teardown. These
    // unit tests target the canvas's own TypeScript logic, so the real grid
    // components are removed from the standalone component's `imports` and
    // `NO_ERRORS_SCHEMA` is added so the now-unknown `<gridster>` /
    // `<gridster-item>` elements (and their property bindings) are tolerated
    // without instantiating the real engine. `viewChild(Gridster)` consequently
    // resolves to `undefined`; tests that exercise placement install a fake grid
    // API via `installFakeGridApi()`.
    TestBed.overrideComponent(GfDashboardCanvasComponent, {
      add: { schemas: [NO_ERRORS_SCHEMA] },
      remove: { imports: [Gridster, GridsterItem] }
    });

    await TestBed.compileComponents();

    fixture = TestBed.createComponent(GfDashboardCanvasComponent);
    component = fixture.componentInstance;
    // NOTE: `fixture.detectChanges()` is intentionally NOT called. Each test
    // drives `ngOnInit` (or the public handlers) directly, keeping the unit
    // test isolated from the live Gridster view and the `*ngComponentOutlet`.
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Replaces the private `grid` view-child signal with a fake Gridster whose
  // `api.getNextPossiblePosition` simulates first-fit by placing the new item
  // immediately to the right of the right-most occupied cell. Returns the spy
  // so tests can assert it was consulted. (The real engine needs a laid-out DOM
  // that jsdom does not provide; faking the API is the deterministic way to
  // verify the canvas defers placement to `grid().api`.)
  function installFakeGridApi(): jest.Mock {
    const getNextPossiblePosition = jest.fn((item: DashboardItem) => {
      const rightEdge = component.dashboard.reduce(
        (max, current) => Math.max(max, (current.x ?? 0) + (current.cols ?? 0)),
        0
      );

      item.x = rightEdge;
      item.y = 0;
    });

    (component as unknown as { grid: () => unknown }).grid = () => ({
      api: { getNextPossiblePosition }
    });

    return getNextPossiblePosition;
  }

  it('should be created', () => {
    expect(component).toBeTruthy();
    expect(component.dashboard).toEqual([]);
  });

  // Documents the v21 root cause the M4 fix addresses: `GridsterConfig` exposes
  // no `api` field, so the previous `this.options.api?...` call was always a
  // no-op. Placement must go through the `Gridster` component API instead.
  it('should not expose a grid API on the options object (v21 contract)', () => {
    expect(component.options.api).toBeUndefined();
  });

  describe('ngOnInit (layout load)', () => {
    it('should start blank and flag the catalog to auto-open on first visit (get -> null)', () => {
      getSpy.mockReturnValue(of(null));

      component.ngOnInit();

      expect(component.dashboard).toEqual([]);
      expect(component.shouldAutoOpenCatalog()).toBe(true);
      expect(component.isInitialized()).toBe(true);
    });

    it('should hydrate the grid from a saved layout and not auto-open the catalog', () => {
      const savedLayout = {
        layoutData: {
          items: [
            { cols: 6, moduleKey: 'holdings', rows: 4, x: 0, y: 0 },
            { cols: 4, moduleKey: 'markets', rows: 3, x: 6, y: 0 }
          ],
          schemaVersion: 1
        }
      } as unknown as UserDashboardLayout;
      getSpy.mockReturnValue(of(savedLayout));

      component.ngOnInit();

      expect(component.dashboard.map((item) => item.moduleKey)).toEqual([
        'holdings',
        'markets'
      ]);
      // Per-item minimum cell dimensions are re-derived from the registry.
      expect(component.dashboard[0]).toMatchObject({
        cols: 6,
        minItemCols: 6,
        minItemRows: 4,
        moduleKey: 'holdings',
        rows: 4,
        x: 0,
        y: 0
      });
      expect(component.shouldAutoOpenCatalog()).toBe(false);
      expect(component.isInitialized()).toBe(true);
    });

    it('should fall back to the global 2x2 minimum when a stored module key is no longer registered', () => {
      // A forward-compatibility edge: the saved layout references a module key
      // that the registry no longer knows (e.g. a module removed in a later
      // release). `registryGetSpy` returns `undefined` for it, so the hydrated
      // item keeps its stored geometry but adopts the global 2x2 floor for its
      // per-item minimums (the `definition?.minItemCols ?? MIN_ITEM_COLS`
      // fallback), rather than crashing or dropping the item.
      const savedLayout = {
        layoutData: {
          items: [
            { cols: 8, moduleKey: 'retired-module', rows: 5, x: 0, y: 0 }
          ],
          schemaVersion: 1
        }
      } as unknown as UserDashboardLayout;
      getSpy.mockReturnValue(of(savedLayout));

      component.ngOnInit();

      expect(component.dashboard[0]).toMatchObject({
        cols: 8,
        minItemCols: 2,
        minItemRows: 2,
        moduleKey: 'retired-module',
        rows: 5,
        x: 0,
        y: 0
      });
      expect(component.shouldAutoOpenCatalog()).toBe(false);
      expect(component.isInitialized()).toBe(true);
    });
  });

  describe('onAddModule (first-fit placement, M4)', () => {
    it('should place a new module through grid().api.getNextPossiblePosition and persist', () => {
      const getNextPossiblePosition = installFakeGridApi();

      component.onAddModule('holdings');

      expect(getNextPossiblePosition).toHaveBeenCalledTimes(1);
      // The item handed to the grid API is the one that gets added.
      const placed = getNextPossiblePosition.mock.calls[0][0] as DashboardItem;
      expect(placed.moduleKey).toBe('holdings');
      expect(component.dashboard).toHaveLength(1);
      expect(component.dashboard[0].moduleKey).toBe('holdings');
      expect(queueSaveSpy).toHaveBeenCalledTimes(1);
    });

    it('should place consecutively added modules without overlap', () => {
      installFakeGridApi();

      component.onAddModule('holdings');
      component.onAddModule('markets');

      expect(component.dashboard).toHaveLength(2);

      const [first, second] = component.dashboard;
      const firstRight = (first.x ?? 0) + (first.cols ?? 0);
      // The second module's left edge must start at or after the first's right
      // edge — i.e. the two items do not overlap horizontally.
      expect(second.x ?? 0).toBeGreaterThanOrEqual(firstRight);
    });

    it('should ignore an unknown module key', () => {
      installFakeGridApi();

      component.onAddModule('does-not-exist');

      expect(component.dashboard).toHaveLength(0);
      expect(queueSaveSpy).not.toHaveBeenCalled();
    });

    it('should not add the same module twice', () => {
      installFakeGridApi();

      component.onAddModule('holdings');
      component.onAddModule('holdings');

      expect(component.dashboard).toHaveLength(1);
      expect(queueSaveSpy).toHaveBeenCalledTimes(1);
    });

    it('should still add and persist a module when the grid view child is not yet resolved', () => {
      // No `installFakeGridApi()` here: `grid()` resolves to `undefined` (the
      // view is never rendered in these unit tests), so the
      // `this.grid()?.api?.getNextPossiblePosition?.(newItem)` placement call
      // safely no-ops via optional chaining. The module is still added at its
      // default origin and the layout is still persisted.
      component.onAddModule('holdings');

      expect(component.dashboard).toHaveLength(1);
      expect(component.dashboard[0].moduleKey).toBe('holdings');
      expect(component.dashboard[0].x).toBe(0);
      expect(component.dashboard[0].y).toBe(0);
      expect(queueSaveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('drag-and-drop add (M3)', () => {
    it('should mark a module-carrying dragover as a valid copy drop target', () => {
      const { event, dataTransfer, preventDefault } =
        buildDragEvent('holdings');

      component.onDragOver(event);

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(dataTransfer.dropEffect).toBe('copy');
    });

    it('should ignore a dragover that does not carry a module key', () => {
      const { event, preventDefault } = buildDragEvent(null);

      component.onDragOver(event);

      expect(preventDefault).not.toHaveBeenCalled();
    });

    it('should add the dragged module on drop', () => {
      installFakeGridApi();
      const { event, preventDefault } = buildDragEvent('markets');

      component.onDrop(event);

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(component.dashboard.map((item) => item.moduleKey)).toEqual([
        'markets'
      ]);
      expect(queueSaveSpy).toHaveBeenCalledTimes(1);
    });

    it('should no-op on a drop that carries no module key', () => {
      const { event, preventDefault } = buildDragEvent(null);

      component.onDrop(event);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(component.dashboard).toHaveLength(0);
      expect(queueSaveSpy).not.toHaveBeenCalled();
    });
  });

  describe('removeItem', () => {
    it('should remove a placed module and persist the new layout', () => {
      installFakeGridApi();
      component.onAddModule('holdings');
      queueSaveSpy.mockClear();

      component.removeItem(component.dashboard[0]);

      expect(component.dashboard).toHaveLength(0);
      expect(queueSaveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('grid options contract (minimums + grid-event persistence)', () => {
    // Required case (7), global half: the canvas pins a 2x2 cell floor. The
    // gridster engine reads `minItemCols`/`minItemRows` to enforce the minimum
    // and reject below-minimum resize attempts.
    it('should pin the global minimum item size to a 2x2 cell', () => {
      expect(component.options.minItemCols).toBe(2);
      expect(component.options.minItemRows).toBe(2);
    });

    // Required case (6): drag-end (`itemChangeCallback`) and resize-end
    // (`itemResizeCallback`) are the grid-state-change events that drive
    // debounced persistence. Both are zero-argument arrows that funnel through
    // the private `persistLayout`, so invoking each must enqueue exactly one
    // save (two in total). This exercises the canvas's drag/resize persistence
    // wiring without instantiating the (removed) real grid engine.
    it('should persist the layout on the drag-end and resize-end grid callbacks', () => {
      const itemChangeCallback = component.options
        .itemChangeCallback as unknown as () => void;
      const itemResizeCallback = component.options
        .itemResizeCallback as unknown as () => void;

      itemChangeCallback();
      itemResizeCallback();

      expect(queueSaveSpy).toHaveBeenCalledTimes(2);
    });

    // Required case (7), per-item half: an added module adopts the minimum cell
    // dimensions declared in its registry definition, and those minimums are
    // never below the global 2x2 floor. `markets` is registered as 4x3, so the
    // placed item carries `minItemCols`/`minItemRows` (and initial size) of 4x3.
    it('should stamp registry-declared per-module minimums (>= 2) onto an added item', () => {
      installFakeGridApi();

      component.onAddModule('markets');

      const [added] = component.dashboard;

      expect(added.minItemCols).toBeGreaterThanOrEqual(2);
      expect(added.minItemRows).toBeGreaterThanOrEqual(2);
      expect(added.minItemCols).toBe(4);
      expect(added.minItemRows).toBe(3);
      expect(added.cols).toBe(4);
      expect(added.rows).toBe(3);
    });
  });

  describe('persistLayout (versioned payload shape)', () => {
    // Required case (8): the queued payload is EXACTLY
    // `{ layoutData: { schemaVersion: <number>, items: [{ moduleKey, x, y,
    // cols, rows }] } }`. `toHaveBeenCalledWith` deep-equals the call argument,
    // so any extra key — notably the per-item minimums, which are re-derived
    // from the registry on read-back rather than persisted — would fail the
    // assertion. The deterministic values come from the `holdings` registry
    // definition (6x4) and the fake first-fit origin (0,0).
    it('should queue a correctly-shaped versioned persistence payload', () => {
      installFakeGridApi();

      component.onAddModule('holdings');

      expect(queueSaveSpy).toHaveBeenCalledTimes(1);
      expect(queueSaveSpy).toHaveBeenCalledWith({
        layoutData: {
          items: [
            {
              cols: 6,
              moduleKey: 'holdings',
              rows: 4,
              x: 0,
              y: 0
            }
          ],
          schemaVersion: 1
        }
      });
    });
  });

  describe('getOutletInputs (memoized *ngComponentOutlet inputs)', () => {
    it('should return a stable inputs object per item across change-detection cycles', () => {
      installFakeGridApi();
      component.onAddModule('holdings');

      const [item] = component.dashboard;
      // `getOutletInputs` is `protected` (template-visible); a typed structural
      // cast reaches it without `any`, keeping the assertions free of
      // unsafe-call / unsafe-member-access lint findings.
      const canvasInternals = component as unknown as {
        getOutletInputs: (item: DashboardItem) => { removeModule: () => void };
      };
      const inputsA = canvasInternals.getOutletInputs(item);
      const inputsB = canvasInternals.getOutletInputs(item);

      // Same object reference -> the OnPush outlet never sees a "changed" input
      // and avoids needless re-creation of the wrapped feature component.
      expect(inputsA).toBe(inputsB);
      expect(typeof inputsA.removeModule).toBe('function');
    });

    it('should remove the owning item when the memoized removeModule callback fires', () => {
      installFakeGridApi();
      component.onAddModule('holdings');

      const [item] = component.dashboard;
      const canvasInternals = component as unknown as {
        getOutletInputs: (item: DashboardItem) => { removeModule: () => void };
      };
      const inputs = canvasInternals.getOutletInputs(item);
      queueSaveSpy.mockClear();

      // The wrapper invokes this callback from its header remove action; it must
      // delegate to `removeItem`, shrinking the dashboard and persisting once.
      inputs.removeModule();

      expect(component.dashboard).toHaveLength(0);
      expect(queueSaveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('openCatalog', () => {
    // Mirrors `installFakeGridApi`: the `catalog` view-child signal resolves to
    // `undefined` while no live view is rendered (these unit tests never call
    // `detectChanges`), so a fake exposing `open` is installed to verify the
    // canvas delegates to the catalog overlay.
    it('should open the module catalog overlay through the catalog view child', () => {
      const openSpy = jest.fn();
      const canvasWithCatalog = component as unknown as {
        catalog: () => { open: () => void } | undefined;
      };
      canvasWithCatalog.catalog = () => ({ open: openSpy });

      component.openCatalog();

      expect(openSpy).toHaveBeenCalledTimes(1);
    });

    it('should no-op when the catalog view child is not yet resolved', () => {
      const canvasWithCatalog = component as unknown as {
        catalog: () => { open: () => void } | undefined;
      };
      canvasWithCatalog.catalog = () => undefined;

      // The optional chaining in `openCatalog` (`this.catalog()?.open()`) keeps
      // the toolbar action safe before the catalog has rendered.
      expect(() => component.openCatalog()).not.toThrow();
    });
  });
});
