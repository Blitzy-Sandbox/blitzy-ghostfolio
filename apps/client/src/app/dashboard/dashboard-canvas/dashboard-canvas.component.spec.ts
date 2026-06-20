import { DashboardLayoutService } from '@ghostfolio/client/dashboard/dashboard-layout.service';
import { GfModuleCatalogComponent } from '@ghostfolio/client/dashboard/module-catalog/module-catalog.component';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';

import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at runtime.
// The companion `dashboard-canvas.component.html` (and the real
// `module-catalog.component.html`, which renders inside this canvas) use `i18n`
// attributes that the Angular compiler lowers to `$localize` tagged-template
// calls. Without this side-effect import, rendering those templates during
// `fixture.detectChanges()` throws `ReferenceError: $localize is not defined`.
// Placed in the `@angular` import group exactly as the sibling
// `module-catalog.component.spec.ts` and the source `chat-panel.component.spec.ts`
// do; it still runs during the import phase, before any spec body executes.
import '@angular/localize/init';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { of, throwError } from 'rxjs';

import { GfDashboardCanvasComponent } from './dashboard-canvas.component';

// CRITICAL test-isolation seam. The REAL `ModuleRegistryService` statically
// imports all twelve wrapper components in its constructor; those wrappers
// transitively pull in `@ionic/angular/standalone` — an ESM-only bundle that
// Jest's `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` cannot parse.
// Importing the canvas pulls the catalog, which imports the registry, so the
// chain would otherwise load and crash the transform. Replacing the whole
// registry MODULE with a bare token class severs that chain while leaving a
// clean DI token for `inject(ModuleRegistryService)` to resolve. The actual,
// controllable registry behavior is supplied per-test via the `useValue`
// provider below — NOT by this factory. `jest.mock(...)` is hoisted above the
// imports by the jest-preset-angular transformer and the factory references no
// outer variables, so there is no hoisting pitfall. Mirrors the sibling
// `module-catalog.component.spec.ts`.
jest.mock('@ghostfolio/client/dashboard/module-registry.service', () => ({
  ModuleRegistryService: class {
    public get() {
      return undefined;
    }
    public getAll() {
      return [];
    }
    public has() {
      return false;
    }
    public register() {
      // No-op: the controllable behavior is supplied by the `useValue` mock
      // registry, not by this token stub (whose only job is to keep the real
      // registry module — and its 12 wrapper imports — from loading).
    }
  }
}));

// A tiny REAL standalone component used as every mock module definition's
// `component`. `*ngComponentOutlet` renders it for each placed grid item, so it
// must be a genuine (standalone, Angular-21-default) component, not a plain
// class. Its `gf-` selector satisfies `@angular-eslint/component-selector`.
// It declares the `removeModule` input that the canvas binds through
// `getOutletInputs` (mirroring the real wrappers' `@Input() removeModule`), so
// `NgComponentOutlet` can bind it without the NG0303 unknown-input error.
@Component({ selector: 'gf-stub-module', template: '' })
class StubModuleComponent {
  @Input() public removeModule?: () => void;
}

// A small, fixed set of `ModuleDefinition`s covering distinct keys and minimum
// dimensions. `portfolio-overview`/`holdings` are 6x4 and `ai-chat` is 3x4 so
// the minimum-dimension assertions can verify per-module mins (>= the global
// 2x2) are sourced from the registry definition.
const MOCK_DEFINITIONS = [
  {
    component: StubModuleComponent,
    displayName: 'Portfolio Overview',
    icon: 'dashboard',
    key: 'portfolio-overview',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    component: StubModuleComponent,
    displayName: 'Holdings',
    icon: 'account_balance_wallet',
    key: 'holdings',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    component: StubModuleComponent,
    displayName: 'AI Chat',
    icon: 'chat',
    key: 'ai-chat',
    minItemCols: 3,
    minItemRows: 4
  }
];

// jsdom does not implement `ResizeObserver`, which the REAL `angular-gridster2`
// engine observes on init. Polyfilling a no-op stub lets the real grid (an
// ESM `.mjs` bundle that Jest DOES transform) initialize, so the canvas, the
// real catalog, and the real grid all instantiate and every canvas method is
// directly exercisable for coverage.
class ResizeObserverStub {
  public disconnect() {
    // no-op
  }
  public observe() {
    // no-op
  }
  public unobserve() {
    // no-op
  }
}

describe('GfDashboardCanvasComponent', () => {
  let component: GfDashboardCanvasComponent;
  let fixture: ComponentFixture<GfDashboardCanvasComponent>;
  let mockRegistry: {
    get: jest.Mock;
    getAll: jest.Mock;
    has: jest.Mock;
    register: jest.Mock;
  };
  let mockLayoutService: { get: jest.Mock; queueSave: jest.Mock };

  beforeAll(() => {
    global.ResizeObserver =
      ResizeObserverStub as unknown as typeof globalThis.ResizeObserver;
  });

  beforeEach(async () => {
    // Recreate the registry spies each test so call history never leaks. They
    // resolve against the fixed `MOCK_DEFINITIONS` set above.
    mockRegistry = {
      get: jest.fn((key: string) =>
        MOCK_DEFINITIONS.find((definition) => definition.key === key)
      ),
      getAll: jest.fn(() => MOCK_DEFINITIONS),
      has: jest.fn((key: string) =>
        MOCK_DEFINITIONS.some((definition) => definition.key === key)
      ),
      register: jest.fn()
    };

    // `get()` defaults to the first-visit signal (`of(null)`); individual tests
    // override it with `mockReturnValue(of(mockLayout))`. `queueSave` is a spy
    // so persistence calls (drag/resize/add/remove) can be asserted.
    mockLayoutService = {
      get: jest.fn(() => of(null)),
      queueSave: jest.fn()
    };

    await TestBed.configureTestingModule({
      imports: [GfDashboardCanvasComponent, NoopAnimationsModule],
      providers: [
        { provide: ModuleRegistryService, useValue: mockRegistry },
        { provide: DashboardLayoutService, useValue: mockLayoutService }
      ]
    }).compileComponents();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Creates the component and runs the first change-detection pass, which fires
  // `ngOnInit` -> `loadLayout()`. Because the mocked `get()` returns a
  // synchronous `of(...)`, the layout resolves before this call returns.
  function createComponent() {
    fixture = TestBed.createComponent(GfDashboardCanvasComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  // Case 1 — Creation.
  it('creates', () => {
    createComponent();

    expect(component).toBeTruthy();
  });

  // Case 2 — First visit: `get()` resolves to `null`, so the canvas stays blank
  // and the catalog auto-opens.
  it('shows a blank canvas and auto-opens the catalog on first visit (get -> null)', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();

    expect(component.dashboard.length).toBe(0);
    expect(component.isInitialized()).toBe(true);
    expect(component.shouldAutoOpenCatalog()).toBe(true);
  });

  // Case 3 — Returning user: `get()` resolves to a saved layout, so the grid
  // hydrates from `layoutData.items` (in order) and the catalog does NOT
  // auto-open.
  it('hydrates the grid from a saved layout (get -> layout)', () => {
    mockLayoutService.get.mockReturnValue(
      of({
        createdAt: '2024-01-01T00:00:00.000Z',
        layoutData: {
          items: [
            { cols: 6, moduleKey: 'portfolio-overview', rows: 4, x: 0, y: 0 },
            { cols: 6, moduleKey: 'holdings', rows: 4, x: 6, y: 0 }
          ],
          schemaVersion: 1
        },
        updatedAt: '2024-01-01T00:00:00.000Z',
        userId: 'user-1'
      })
    );

    createComponent();

    expect(component.dashboard.length).toBe(2);
    expect(component.dashboard.map((item) => item.moduleKey)).toEqual([
      'portfolio-overview',
      'holdings'
    ]);
    expect(component.shouldAutoOpenCatalog()).toBe(false);
  });

  // Extra branch — Forward compatibility: a saved layout may reference a module
  // key that is no longer registered (e.g. a module removed in a later
  // release). The item still hydrates, falling back to the global 2x2 minimum
  // dimensions (`definition?.minItemCols ?? MIN_ITEM_COLS`) rather than
  // crashing; its geometry is preserved from the saved record.
  it('hydrates an unregistered module key with fallback minimum dimensions', () => {
    mockLayoutService.get.mockReturnValue(
      of({
        createdAt: '2024-01-01T00:00:00.000Z',
        layoutData: {
          items: [
            { cols: 5, moduleKey: 'retired-module', rows: 3, x: 0, y: 0 }
          ],
          schemaVersion: 1
        },
        updatedAt: '2024-01-01T00:00:00.000Z',
        userId: 'user-1'
      })
    );

    createComponent();

    expect(component.dashboard.length).toBe(1);

    const hydrated = component.dashboard[0];

    expect(hydrated.moduleKey).toBe('retired-module');
    expect(hydrated.cols).toBe(5);
    expect(hydrated.rows).toBe(3);
    expect(hydrated.minItemCols).toBe(2);
    expect(hydrated.minItemRows).toBe(2);
  });

  // Case 4 — Adding a module places one new item carrying the registry-sourced
  // minimum dimensions and funnels a correctly-shaped payload to `queueSave`.
  it('adds a module with registry min dimensions and persists', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();
    component.onAddModule('portfolio-overview');

    expect(component.dashboard.length).toBe(1);

    const added = component.dashboard[0];

    expect(added.moduleKey).toBe('portfolio-overview');
    expect(added.cols).toBe(6);
    expect(added.rows).toBe(4);
    expect(added.minItemCols).toBe(6);
    expect(added.minItemRows).toBe(4);
    expect(mockLayoutService.queueSave).toHaveBeenCalledWith({
      layoutData: {
        items: [
          expect.objectContaining({
            cols: 6,
            moduleKey: 'portfolio-overview',
            rows: 4,
            x: expect.any(Number),
            y: expect.any(Number)
          })
        ],
        schemaVersion: 1
      }
    });
  });

  // Extra branch — Dedup guard: re-adding an already-placed module is a no-op
  // (the `@for` tracks by `moduleKey`, so duplicates are rejected up front).
  it('does not add a duplicate module (dedup guard)', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();
    component.onAddModule('portfolio-overview');
    component.onAddModule('portfolio-overview');

    expect(component.dashboard.length).toBe(1);
  });

  // Extra branch — Unknown key: an unregistered key is ignored (registry-only
  // introduction) and never triggers a save.
  it('ignores an unknown module key', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();
    component.onAddModule('does-not-exist');

    expect(component.dashboard.length).toBe(0);
    expect(mockLayoutService.queueSave).not.toHaveBeenCalled();
  });

  // Case 5 — Removing a module shrinks the authoritative grid state and
  // persists the change exactly once.
  it('removes a module and persists', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();
    component.onAddModule('portfolio-overview');
    mockLayoutService.queueSave.mockClear();
    component.removeItem(component.dashboard[0]);

    expect(component.dashboard.length).toBe(0);
    expect(mockLayoutService.queueSave).toHaveBeenCalledTimes(1);
  });

  // Case 6 — Drag-end and resize-end persistence: both gridster item callbacks
  // are zero-arg arrows that funnel through `persistLayout()` -> `queueSave`.
  it('persists on drag-end and resize-end (item callbacks)', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();
    // The gridster callbacks are zero-arg arrows (`() => this.persistLayout()`);
    // cast away the engine's `(item, itemComponent)` signature to invoke them.
    (component.options.itemChangeCallback as () => void)();
    (component.options.itemResizeCallback as () => void)();

    expect(mockLayoutService.queueSave).toHaveBeenCalledTimes(2);
  });

  // Case 7 — Minimum-dimension enforcement: the engine is configured with the
  // global 2x2 minimum and every added item carries its per-module minimums
  // (each >= 2) sourced from the registry definition.
  it('enforces the global 2x2 minimum and per-module minimums >= 2', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();

    expect(component.options.minItemCols).toBe(2);
    expect(component.options.minItemRows).toBe(2);

    component.onAddModule('ai-chat');

    const added = component.dashboard[0];

    expect(added.minItemCols).toBeGreaterThanOrEqual(2);
    expect(added.minItemRows).toBeGreaterThanOrEqual(2);
    expect(added.minItemCols).toBe(3);
    expect(added.minItemRows).toBe(4);
  });

  // Case 8 — The persistence payload is exactly
  // `{ layoutData: { schemaVersion, items: [{ moduleKey, x, y, cols, rows }] } }`
  // with no extra keys.
  it('emits a correctly-shaped persistence payload', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();
    component.onAddModule('holdings');

    const payload: unknown = mockLayoutService.queueSave.mock.calls[0][0];

    expect(payload).toEqual({
      layoutData: {
        items: [
          {
            cols: expect.any(Number),
            moduleKey: 'holdings',
            rows: expect.any(Number),
            x: expect.any(Number),
            y: expect.any(Number)
          }
        ],
        schemaVersion: expect.any(Number)
      }
    });
  });

  // Extra branch — `getOutletInputs` memoizes a STABLE inputs object per item so
  // OnPush change detection does not tear down and re-create the rendered
  // module; the object exposes a `removeModule` callback.
  it('memoizes the NgComponentOutlet inputs object per item', () => {
    mockLayoutService.get.mockReturnValue(of(null));

    createComponent();
    component.onAddModule('portfolio-overview');

    const item = component.dashboard[0];
    // `getOutletInputs` is `protected`; reach it through a typed accessor (not
    // `any`) so the reference-equality and shape assertions stay type-safe.
    const canvasInternals = component as unknown as {
      getOutletInputs: (item: unknown) => { removeModule: () => void };
    };
    const inputsA = canvasInternals.getOutletInputs(item);
    const inputsB = canvasInternals.getOutletInputs(item);

    expect(inputsA).toBe(inputsB);
    expect(typeof inputsA.removeModule).toBe('function');
  });

  // Extra branch — Non-404 load failure: `DashboardLayoutService.get()`
  // re-throws every error other than 404, so the canvas surfaces a recoverable
  // error state (it still marks itself initialized so the inline error/retry
  // affordance renders instead of an unrecoverable blank canvas) and does NOT
  // auto-open the catalog.
  it('surfaces a recoverable error state on a non-404 load failure', () => {
    mockLayoutService.get.mockReturnValue(
      throwError(() => new Error('Internal Server Error'))
    );

    createComponent();

    expect(component.loadError()).toBe(true);
    expect(component.isInitialized()).toBe(true);
    expect(component.shouldAutoOpenCatalog()).toBe(false);
    expect(component.dashboard.length).toBe(0);
  });

  // Extra branch — `retryLoad()` re-runs the initial load. The first attempt
  // fails (non-404) and the retry succeeds with `null` (first visit), clearing
  // the error and auto-opening the catalog.
  it('retries the initial load after a transient failure (retryLoad)', () => {
    mockLayoutService.get
      .mockReturnValueOnce(throwError(() => new Error('Internal Server Error')))
      .mockReturnValueOnce(of(null));

    createComponent();

    expect(component.loadError()).toBe(true);

    component.retryLoad();

    expect(component.loadError()).toBe(false);
    expect(component.isInitialized()).toBe(true);
    expect(component.shouldAutoOpenCatalog()).toBe(true);
    expect(mockLayoutService.get).toHaveBeenCalledTimes(2);
  });

  // Extra branch — `openCatalog()` delegates to the rendered catalog's `open()`.
  // A saved layout is loaded so the catalog renders (it is gated behind
  // `@if (isInitialized() && !loadError())`) and the `viewChild` resolves.
  it('opens the catalog from the toolbar (openCatalog)', () => {
    mockLayoutService.get.mockReturnValue(
      of({
        createdAt: '2024-01-01T00:00:00.000Z',
        layoutData: { items: [], schemaVersion: 1 },
        updatedAt: '2024-01-01T00:00:00.000Z',
        userId: 'user-1'
      })
    );

    createComponent();
    fixture.detectChanges();

    const catalogDebugElement = fixture.debugElement.query(
      By.directive(GfModuleCatalogComponent)
    );

    expect(catalogDebugElement).toBeTruthy();

    const openSpy = jest.spyOn(catalogDebugElement.componentInstance, 'open');

    component.openCatalog();

    expect(openSpy).toHaveBeenCalled();
  });
});
