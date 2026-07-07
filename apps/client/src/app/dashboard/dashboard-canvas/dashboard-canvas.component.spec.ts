// Initializes the global `$localize` function used by Angular i18n at runtime.
// Importing `GfDashboardCanvasComponent` transitively evaluates
// `../module-registry.service` and `../module-catalog/module-catalog.component`,
// which statically import all 12 `modules/*` wrappers whose transitive feature
// components (e.g. `home-overview`, `chat-panel`) declare `$localize`-tagged
// templates at module scope. This side-effect import MUST run before that
// module graph is evaluated (i.e. before the relative SUT imports below) —
// otherwise merely importing the SUT throws `ReferenceError: $localize is not
// defined` before any test executes. Mirrors the verified pattern in
// `chat-panel.component.spec.ts`, `module-registry.service.spec.ts`, and
// `module-catalog.component.spec.ts`.
import { Component, WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import '@angular/localize/init';
import { MatDialog } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import type { GridsterItemConfig } from 'angular-gridster2';
import { of } from 'rxjs';

import { DashboardLayoutStoreService } from '../dashboard-layout-store.service';
import { DashboardModuleDefinition } from '../dashboard-module.interface';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { ModuleRegistryService } from '../module-registry.service';
import { GfDashboardCanvasComponent } from './dashboard-canvas.component';

// angular-gridster2 creates a ResizeObserver during grid init; jsdom lacks it.
// Install a no-op polyfill before any component renders. (If a future gridster
// build reads ResizeObserver at module-eval time rather than at runtime, hoist
// this stub into apps/client/src/test-setup.ts instead.)
class ResizeObserverStub {
  public disconnect(): void {
    // no-op: jsdom stub, nothing to tear down
  }
  public observe(): void {
    // no-op: jsdom stub, resize events are irrelevant to these unit tests
  }
  public unobserve(): void {
    // no-op: jsdom stub, nothing to unobserve
  }
}

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

// Dependency-free stand-in for a real module wrapper, resolved from the registry
// stub and rendered through NgComponentOutlet (the real wrappers inject data
// services that are out of scope for this unit test).
@Component({
  selector: 'gf-test-module',
  standalone: true,
  template: '<div>test module</div>'
})
class TestModuleComponent {}

describe('GfDashboardCanvasComponent', () => {
  let component: GfDashboardCanvasComponent;
  let fixture: ComponentFixture<GfDashboardCanvasComponent>;
  let itemsSignal: WritableSignal<GridsterItemConfig[]>;
  let loadingSignal: WritableSignal<boolean>;
  // Test doubles are typed `any` (standard for spec test doubles) so partial
  // shapes and jest-mock helpers (mockReturnValue) are ergonomic.
  let storeMock: any;
  let registryStub: any;
  let dialogMock: any;

  const testDefinition: DashboardModuleDefinition = {
    component: TestModuleComponent,
    icon: 'grid-outline',
    id: 'portfolio-overview',
    minCols: 2,
    minRows: 2,
    name: 'Portfolio Overview'
  };

  beforeEach(async () => {
    itemsSignal = signal<GridsterItemConfig[]>([]);
    // The canvas template reads `store.loading()` to gate the layout-fetch
    // MatProgressBar (F-2); back it with a writable signal the tests can flip.
    loadingSignal = signal<boolean>(false);

    storeMock = {
      flush: jest.fn(),
      hydrate: jest.fn(() => of(true)),
      items: itemsSignal,
      loading: loadingSignal,
      publishFromGridWithoutPersist: jest.fn(),
      removeItem: jest.fn(),
      syncFromGrid: jest.fn()
    };

    registryStub = {
      getMinDimensions: jest.fn(() => ({ minCols: 2, minRows: 2 })),
      list: jest.fn(() => [testDefinition]),
      register: jest.fn(),
      resolve: jest.fn(() => testDefinition)
    };

    dialogMock = { open: jest.fn() };

    await TestBed.configureTestingModule({
      imports: [GfDashboardCanvasComponent, NoopAnimationsModule],
      providers: [
        { provide: DashboardLayoutStoreService, useValue: storeMock },
        { provide: ModuleRegistryService, useValue: registryStub }
      ]
    })
      // `GfDashboardCanvasComponent` imports `MatDialogModule`, which registers
      // `MatDialog` in the component's own standalone-imports injector. That
      // provider shadows a root/module-level `{ provide: MatDialog, useValue }`
      // override, so `inject(MatDialog)` would resolve the REAL service (which
      // then crashes in jsdom — no overlay container). Overriding the provider
      // on the component itself places the mock in the component's element
      // injector, which is resolved first, so the SUT reliably injects the mock
      // and we can assert `dialogMock.open(GfModuleCatalogComponent, ...)`.
      .overrideComponent(GfDashboardCanvasComponent, {
        add: {
          providers: [{ provide: MatDialog, useValue: dialogMock }]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfDashboardCanvasComponent);
    component = fixture.componentInstance;
    // NOTE: detectChanges() is intentionally NOT called here so each test can
    // configure `storeMock.hydrate` before ngOnInit runs (Rule 10 branches).
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should create with a fixed 12-column grid, 2x2 minimums, and the drag-handle contract', () => {
    // Render so the required-input gridster grid initializes with `options`
    // bound; this also lets the fixture tear down cleanly (gridster's
    // ngOnDestroy reads its required `options` input — NG0950 otherwise).
    fixture.detectChanges();

    expect(component).toBeTruthy();

    const options = (component as any).options;

    expect(options.minCols).toBe(12);
    expect(options.maxCols).toBe(12);
    expect(options.fixedRowHeight).toBe(40);
    expect(options.minItemCols).toBe(2);
    expect(options.minItemRows).toBe(2);
    expect(options.draggable.dragHandleClass).toBe('gf-module-drag-handle');
    expect(options.draggable.ignoreContent).toBe(true);
  });

  it('should render a gridster-item and module shell per store item, resolving the component from the registry (Rule 3)', () => {
    itemsSignal.set([
      {
        cols: 6,
        rows: 4,
        type: 'portfolio-overview',
        x: 0,
        y: 0
      } as GridsterItemConfig
    ]);

    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('gridster-item').length).toBe(
      1
    );
    expect(
      fixture.nativeElement.querySelector('gf-module-shell')
    ).not.toBeNull();
    expect(registryStub.resolve).toHaveBeenCalledWith('portfolio-overview');
  });

  it('should not render a shell for an unknown module type (graceful guard)', () => {
    registryStub.resolve.mockReturnValue(undefined);
    itemsSignal.set([
      {
        cols: 2,
        rows: 2,
        type: 'does-not-exist',
        x: 0,
        y: 0
      } as GridsterItemConfig
    ]);

    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('gf-module-shell')).toBeNull();
  });

  it('should auto-open the module catalog on first visit when no layout exists (Rule 10)', () => {
    storeMock.hydrate.mockReturnValue(of(false));

    fixture.detectChanges();

    expect(storeMock.hydrate).toHaveBeenCalledTimes(1);
    expect(dialogMock.open).toHaveBeenCalledTimes(1);
    expect(dialogMock.open).toHaveBeenCalledWith(
      GfModuleCatalogComponent,
      expect.anything()
    );
  });

  it('should NOT auto-open the catalog for a returning user with a saved layout (Rule 10)', () => {
    storeMock.hydrate.mockReturnValue(of(true));

    fixture.detectChanges();

    expect(storeMock.hydrate).toHaveBeenCalledTimes(1);
    expect(dialogMock.open).not.toHaveBeenCalled();
  });

  it('should reject sub-2x2 items and accept >=2x2 items via itemValidateCallback (Rule 6)', () => {
    // Render so the gridster grid initializes and tears down cleanly (see the
    // "should create" test for the NG0950 required-input rationale).
    fixture.detectChanges();

    const validate = (component as any).options.itemValidateCallback;

    expect(validate({ cols: 1, rows: 1 })).toBe(false);
    expect(validate({ cols: 1, rows: 3 })).toBe(false);
    expect(validate({ cols: 3, rows: 1 })).toBe(false);
    expect(validate({ cols: 2, rows: 2 })).toBe(true);
    expect(validate({ cols: 6, rows: 4 })).toBe(true);
  });

  it('should persist only on drag/resize/remove and route item-init to the non-persisting path (Rules 2/4)', () => {
    // Render so the gridster grid initializes and tears down cleanly (see the
    // "should create" test for the NG0950 required-input rationale), then clear
    // any incidental store calls made during init so the assertions below count
    // ONLY the grid-engine callbacks invoked directly by this test.
    fixture.detectChanges();
    storeMock.syncFromGrid.mockClear();
    storeMock.publishFromGridWithoutPersist.mockClear();

    const options = (component as any).options;

    options.itemChangeCallback();
    options.itemResizeCallback();
    options.itemRemovedCallback();
    options.itemInitCallback();

    // Rule 4: persistence is scheduled EXCLUSIVELY by genuine state-change
    // events (drag/resize/remove), which route to the store's persisting
    // syncFromGrid(). Item initialization/hydration is NOT a state change, so
    // it must route to publishFromGridWithoutPersist() (signal refresh only, no
    // debounced PATCH) — otherwise a returning user re-saves an unchanged
    // layout on every render (F1).
    expect(storeMock.syncFromGrid).toHaveBeenCalledTimes(3);
    expect(storeMock.publishFromGridWithoutPersist).toHaveBeenCalledTimes(1);
  });

  it('should remove an item through the store (Rule 4)', () => {
    // Render so the gridster grid initializes and tears down cleanly (see the
    // "should create" test for the NG0950 required-input rationale).
    fixture.detectChanges();

    const item = {
      cols: 2,
      rows: 2,
      type: 'holdings',
      x: 0,
      y: 0
    } as GridsterItemConfig;

    (component as any).onRemove(item);

    expect(storeMock.removeItem).toHaveBeenCalledTimes(1);
    expect(storeMock.removeItem).toHaveBeenCalledWith(item);
  });

  it('should open the catalog from the persistent add-module affordance', () => {
    storeMock.hydrate.mockReturnValue(of(true));
    fixture.detectChanges();

    const addButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.gf-dashboard-canvas__add-module'
    );

    expect(addButton).not.toBeNull();

    // F7: the affordance is an Angular Material FAB (`mat-fab`) that renders an
    // `ion-icon` "add-outline" glyph — not a raw <button> + inline SVG. Using
    // the Material component gives the built-in focus-visible ring, ripple, and
    // elevation for free (AAP § 0.3.2 component mapping), while the glyph itself
    // is an Ionicon to match the app-wide icon system (see decision log DL-027;
    // the Material Icons ligature font is never bundled).
    expect(addButton.classList.contains('mat-mdc-fab')).toBe(true);
    const addIcon = addButton.querySelector('ion-icon');
    expect(addIcon).not.toBeNull();
    expect(addIcon?.getAttribute('name')).toBe('add-outline');

    addButton.click();

    expect(dialogMock.open).toHaveBeenCalledWith(
      GfModuleCatalogComponent,
      expect.anything()
    );
  });

  it('should flush pending layout changes on destroy (flush-on-destroy, §0.7.2)', () => {
    fixture.detectChanges();

    fixture.destroy();

    expect(storeMock.flush).toHaveBeenCalledTimes(1);
  });

  it('should render the layout-fetch loading indicator only while the store is loading (F-2, §0.3.2)', () => {
    // A returning user hydrates a saved layout (catalog stays closed); the
    // loading flag is what gates the layout-fetch MatProgressBar, so drive it
    // directly rather than through the mocked hydrate() observable.
    storeMock.hydrate.mockReturnValue(of(true));
    loadingSignal.set(true);

    fixture.detectChanges();

    // While loading: the indeterminate MatProgressBar renders at the top of the
    // canvas (AAP § 0.3.2 hydration feedback), keyed by its dashboard class.
    const loadingBar: HTMLElement = fixture.nativeElement.querySelector(
      '.gf-dashboard-canvas__loading'
    );
    expect(loadingBar).not.toBeNull();
    expect(loadingBar.tagName.toLowerCase()).toBe('mat-progress-bar');
    expect(loadingBar.getAttribute('mode')).toBe('indeterminate');

    // Once the GET settles the store lowers `loading`, so the bar disappears
    // and the canvas shows the hydrated grid without a lingering indicator.
    loadingSignal.set(false);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.gf-dashboard-canvas__loading')
    ).toBeNull();
  });
});
