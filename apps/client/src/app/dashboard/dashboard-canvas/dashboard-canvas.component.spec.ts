import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n. The live
// canvas template compiles its `i18n` attributes and the component's
// `$localize` aria-label helpers to `$localize` tagged-template calls, so
// rendering the (now un-stripped) template through TestBed throws
// `ReferenceError: $localize is not defined` without this side-effect import.
import '@angular/localize/init';
import { MatDialog } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Observable, Subject, of } from 'rxjs';

import { DashboardLayoutService } from '../dashboard-layout.service';
import {
  ModuleRegistryService,
  RegisteredModule
} from '../module-registry.service';
import { GfDashboardCanvasComponent } from './dashboard-canvas.component';

// The canvas transitively imports the module catalog (which pulls in
// `@ionic/angular/standalone`, untransformed ESM Jest cannot parse) and the real
// registry (which imports all twelve wrapper components and, through them, the
// entire feature-page graph that evaluates `$localize` at load). None of that is
// needed here: `MatDialog` is mocked so the catalog class is only ever passed as
// a token, and `ModuleRegistryService` is replaced with a lightweight stand-in.
// Stubbing the catalog and every wrapper keeps this spec fully isolated, mirroring
// the approach already used by `module-registry.service.spec.ts`.
jest.mock('../module-catalog/module-catalog.component', () => ({
  GfModuleCatalogComponent: class GfModuleCatalogComponent {}
}));
jest.mock('../modules/activities/activities-module.component', () => ({
  GfActivitiesModuleComponent: class GfActivitiesModuleComponent {}
}));
jest.mock('../modules/ai-chat/ai-chat-module.component', () => ({
  GfAiChatModuleComponent: class GfAiChatModuleComponent {}
}));
jest.mock('../modules/allocations/allocations-module.component', () => ({
  GfAllocationsModuleComponent: class GfAllocationsModuleComponent {}
}));
jest.mock('../modules/analysis/analysis-module.component', () => ({
  GfAnalysisModuleComponent: class GfAnalysisModuleComponent {}
}));
jest.mock('../modules/fire/fire-module.component', () => ({
  GfFireModuleComponent: class GfFireModuleComponent {}
}));
jest.mock('../modules/holdings/holdings-module.component', () => ({
  GfHoldingsModuleComponent: class GfHoldingsModuleComponent {}
}));
jest.mock('../modules/market/market-module.component', () => ({
  GfMarketModuleComponent: class GfMarketModuleComponent {}
}));
jest.mock(
  '../modules/portfolio-overview/portfolio-overview-module.component',
  () => ({
    GfPortfolioOverviewModuleComponent: class GfPortfolioOverviewModuleComponent {}
  })
);
jest.mock('../modules/rebalancing/rebalancing-module.component', () => ({
  GfRebalancingModuleComponent: class GfRebalancingModuleComponent {}
}));
jest.mock('../modules/summary/summary-module.component', () => ({
  GfSummaryModuleComponent: class GfSummaryModuleComponent {}
}));
jest.mock('../modules/watchlist/watchlist-module.component', () => ({
  GfWatchlistModuleComponent: class GfWatchlistModuleComponent {}
}));
jest.mock('../modules/x-ray/x-ray-module.component', () => ({
  GfXRayModuleComponent: class GfXRayModuleComponent {}
}));

// The canvas now imports `IonIcon` from `@ionic/angular/standalone` and lists it
// in its `imports` array, and registers its chrome glyphs through `addIcons(...)`
// from `ionicons`/`ionicons/icons` (QA F3 FINDING-1). `@ionic/angular/standalone`
// is untransformed `.mjs` ESM that Jest cannot parse under the project's
// `transformIgnorePatterns` (the same reason the catalog is stubbed above), so it
// is mocked here. `IonIcon` MUST be a real standalone directive (not a bare class)
// because Angular validates every entry in a component's `imports` array; a
// minimal `@Directive({ selector: 'ion-icon' })` satisfies that — the JIT test
// environment (`setupZoneTestEnv`) compiles its runtime decorator — and lets the
// template's `<ion-icon>` elements render as inert stand-ins. `ionicons` and
// `ionicons/icons` are stubbed so the constructor's `addIcons(...)` call is an
// inert no-op in this isolated unit environment.
jest.mock('@ionic/angular/standalone', () => {
  // jest.mock factories are hoisted above all imports, so `@angular/core` must be
  // pulled in with require() here — a top-level ES import binding cannot be
  // referenced from a hoisted factory. The `as typeof import(...)` cast keeps
  // `Directive` fully typed (so no no-unsafe-* lint warnings fire).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { Directive } =
    require('@angular/core') as typeof import('@angular/core');

  // The real <ion-icon> is a third-party ELEMENT-selector component; this stub
  // mirrors that element selector so the canvas's `<ion-icon>` usages resolve to
  // it. The element-selector lint rule targets first-party directives and is not
  // meaningful for a third-party element stub, hence the narrow disable.
  // eslint-disable-next-line @angular-eslint/directive-selector
  @Directive({ selector: 'ion-icon' })
  class IonIcon {}

  return { IonIcon };
});
jest.mock('ionicons', () => ({ addIcons: jest.fn() }));
jest.mock('ionicons/icons', () => ({}));

/**
 * angular-gridster2 v21 observes its host element with `ResizeObserver` to react
 * to container size changes. The jest-preset-angular (jsdom) environment does not
 * implement it, so creating the live `<gridster>` template would throw without
 * this deterministic stand-in. It is installed once, at module load, before any
 * `TestBed` configuration runs; it records nothing and never fires, because the
 * canvas behaviour under test does not depend on resize notifications.
 */
const ResizeObserverMock = jest.fn().mockImplementation(() => ({
  disconnect: jest.fn(),
  observe: jest.fn(),
  unobserve: jest.fn()
}));

globalThis.ResizeObserver =
  ResizeObserverMock as unknown as typeof ResizeObserver;

/**
 * Standalone stand-in projected through the canvas's live `*ngComponentOutlet`.
 * The mocked registry resolves its registered module keys to this component, so
 * the spec exercises the real template + registry + component-outlet rendering
 * path (instead of stripping the template) while the heavy feature wrappers stay
 * mocked. The `data-testid` marker lets a test assert that real rendering of the
 * resolved module actually occurred inside the grid.
 */
@Component({
  selector: 'gf-stub-module',
  standalone: true,
  template: '<div data-testid="stub-module">stub module</div>'
})
class StubModuleComponent {}

/**
 * Minimal registry the canvas reads through `ModuleRegistryService.get(...)`.
 * `portfolio-overview` and `holdings` are "registered"; everything else (e.g.
 * `ghost-module`) resolves to `undefined` so the unknown-module filter and the
 * `addModule`/`createGridsterItem` guards can be exercised.
 */
const REGISTRY: Record<string, RegisteredModule | undefined> = {
  holdings: {
    component: StubModuleComponent,
    key: 'holdings',
    minCols: 4,
    minRows: 4,
    name: 'Holdings'
  },
  'portfolio-overview': {
    component: StubModuleComponent,
    key: 'portfolio-overview',
    minCols: 4,
    minRows: 2,
    name: 'Portfolio Overview'
  }
};

describe('GfDashboardCanvasComponent', () => {
  let component: GfDashboardCanvasComponent;
  let dialogMock: { open: jest.Mock };
  let fixture: ComponentFixture<GfDashboardCanvasComponent>;
  let layoutServiceMock: {
    get: jest.Mock;
    save: jest.Mock;
    savedLayout$: Observable<UserDashboardLayout>;
  };
  let registryMock: Pick<ModuleRegistryService, 'get'>;

  beforeEach(() => {
    layoutServiceMock = {
      get: jest.fn().mockReturnValue(of(null)),
      save: jest.fn(),
      // Long-lived stream the canvas subscribes to once; never emits in tests.
      savedLayout$: new Subject<UserDashboardLayout>()
    };
    dialogMock = {
      open: jest.fn().mockReturnValue({ afterClosed: () => of(undefined) })
    };
    registryMock = {
      get: (key: string) => REGISTRY[key]
    };

    // The canvas template is kept LIVE (not stripped): TestBed pulls in the
    // component's real angular-gridster2 imports and template, so the grid, the
    // module cards, and the `*ngComponentOutlet` projection render for real.
    // Only the external collaborators are mocked — the layout service, the
    // dialog, and the registry (which resolves to `StubModuleComponent`) — while
    // `NoopAnimationsModule` satisfies the Material menu/tooltip animation
    // dependency in jsdom.
    TestBed.configureTestingModule({
      imports: [GfDashboardCanvasComponent, NoopAnimationsModule],
      providers: [
        { provide: DashboardLayoutService, useValue: layoutServiceMock },
        { provide: MatDialog, useValue: dialogMock },
        { provide: ModuleRegistryService, useValue: registryMock }
      ]
    });

    fixture = TestBed.createComponent(GfDashboardCanvasComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    // The live `<gridster>` is a top-level element, so the real angular-gridster2
    // v21 `Gridster` component is instantiated at `createComponent`. Its
    // `Gridster.ngOnDestroy` reads a *required* `options` signal input, which is
    // only bound during change detection. Pure-unit tests below intentionally
    // exercise the component instance without rendering, so a trailing
    // `detectChanges()` here binds `[options]="options"` before the fixture is
    // torn down — otherwise gridster's teardown throws NG0950. It runs after each
    // test's assertions, so it cannot alter any expectation, and it keeps the
    // grid engine real rather than stubbing or suppressing teardown errors.
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('first visit (no saved layout): blanks the canvas and auto-opens the catalog', () => {
    layoutServiceMock.get.mockReturnValue(of(null));

    fixture.detectChanges();

    expect(component.items).toEqual([]);
    expect(dialogMock.open).toHaveBeenCalledTimes(1);
  });

  it('returning user: maps saved items, filters unknown modules, clamps below-minimum dimensions', () => {
    const saved: UserDashboardLayout = {
      layout: [
        // Below the registered 4×2 minimum → clamped up on load.
        { cols: 1, moduleKey: 'portfolio-overview', rows: 1, x: 0, y: 0 },
        { cols: 4, moduleKey: 'holdings', rows: 4, x: 4, y: 0 },
        // Not registered → dropped so no empty, untitled card renders.
        { cols: 2, moduleKey: 'ghost-module', rows: 2, x: 0, y: 4 }
      ]
    };
    layoutServiceMock.get.mockReturnValue(of(saved));

    fixture.detectChanges();

    expect(component.items.length).toBe(2);

    const overview = component.items.find(
      (item) => item.moduleKey === 'portfolio-overview'
    );
    expect(overview?.cols).toBe(4);
    expect(overview?.rows).toBe(2);

    // A restored layout must NOT trigger the first-visit catalog auto-open.
    expect(dialogMock.open).not.toHaveBeenCalled();
  });

  it('resolves module name and component through the registry', () => {
    expect(component.getModuleName('holdings')).toBe('Holdings');
    expect(component.getModuleComponent('holdings')).toBe(StubModuleComponent);
    expect(component.getModuleName('ghost-module')).toBe('');
    expect(component.getModuleComponent('ghost-module')).toBeUndefined();
  });

  it('renders the resolved module into the live grid via ngComponentOutlet', () => {
    const saved: UserDashboardLayout = {
      layout: [{ cols: 4, moduleKey: 'holdings', rows: 4, x: 0, y: 0 }]
    };
    layoutServiceMock.get.mockReturnValue(of(saved));

    // Render the LIVE template (no override/strip): the canvas must resolve
    // `holdings` through the registry and project `StubModuleComponent` through
    // `*ngComponentOutlet` inside the grid card — proving the real
    // template/registry/outlet integration, not a bypassed stub.
    fixture.detectChanges();

    expect(component.items.length).toBe(1);

    const rootElement = fixture.nativeElement as HTMLElement;
    const projected = rootElement.querySelector('[data-testid="stub-module"]');
    expect(projected).not.toBeNull();
  });

  it('moveModule shifts a module within the grid and persists the new geometry', () => {
    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 4,
      y: 2
    };
    component.items = [item];

    component.moveModule(item, 1, 1);

    expect(item.x).toBe(5);
    expect(item.y).toBe(3);
    expect(layoutServiceMock.save).toHaveBeenCalledWith([
      { cols: 4, moduleKey: 'portfolio-overview', rows: 2, x: 5, y: 3 }
    ]);
  });

  it('moveModule clamps to the left and top edges', () => {
    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 0,
      y: 0
    };
    component.items = [item];

    component.moveModule(item, -5, -5);

    expect(item.x).toBe(0);
    expect(item.y).toBe(0);
    expect(layoutServiceMock.save).toHaveBeenCalled();
  });

  it('moveModule clamps to the right edge accounting for module width', () => {
    // 12-column grid, 4-wide module → maximum column index is 8.
    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 8,
      y: 0
    };
    component.items = [item];

    component.moveModule(item, 5, 0);

    expect(item.x).toBe(8);
  });

  it('resizeModule grows a module and persists the new size', () => {
    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 0,
      y: 0
    };
    component.items = [item];

    component.resizeModule(item, 2, 3);

    expect(item.cols).toBe(6);
    expect(item.rows).toBe(5);
    expect(layoutServiceMock.save).toHaveBeenCalledWith([
      { cols: 6, moduleKey: 'portfolio-overview', rows: 5, x: 0, y: 0 }
    ]);
  });

  it('resizeModule clamps down to the module minimum footprint (2×2 floor)', () => {
    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 0,
      y: 0
    };
    component.items = [item];

    component.resizeModule(item, -10, -10);

    expect(item.cols).toBe(4);
    expect(item.rows).toBe(2);
  });

  it('resizeModule clamps width to the remaining grid columns', () => {
    // Anchored at column 10 with a 2-wide minimum → cannot grow past 2 columns.
    const item = {
      cols: 2,
      minItemCols: 2,
      minItemRows: 2,
      moduleKey: 'holdings',
      rows: 2,
      x: 10,
      y: 0
    };
    component.items = [item];

    component.resizeModule(item, 5, 0);

    expect(item.cols).toBe(2);
  });

  it('removeModule drops only the targeted tile and persists', () => {
    const first = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 0,
      y: 0
    };
    const second = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 4,
      moduleKey: 'holdings',
      rows: 4,
      x: 4,
      y: 0
    };
    component.items = [first, second];

    component.removeModule(first);

    expect(component.items).toEqual([second]);
    expect(layoutServiceMock.save).toHaveBeenCalled();
  });

  it('adds the module chosen in the catalog, stamped at the registry minimum, and persists', () => {
    dialogMock.open.mockReturnValue({ afterClosed: () => of('holdings') });

    component.openCatalog();

    expect(component.items.length).toBe(1);
    expect(component.items[0].moduleKey).toBe('holdings');
    expect(component.items[0].cols).toBe(4);
    expect(component.items[0].rows).toBe(4);
    expect(layoutServiceMock.save).toHaveBeenCalled();
  });

  it('ignores a duplicate module key so the grid never holds two of the same module', () => {
    dialogMock.open.mockReturnValue({ afterClosed: () => of('holdings') });

    component.openCatalog();
    component.openCatalog();

    expect(
      component.items.filter((item) => item.moduleKey === 'holdings').length
    ).toBe(1);
  });

  it('does NOT persist on gridster callbacks fired before the grid settles (load-time placement / normalization) (Rule 4 / F2-LOW-01)', () => {
    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 0,
      y: 0
    };
    component.items = [item];

    // `isLayoutInitialized` is still false here (the post-load NgZone.onStable
    // flip has not run). angular-gridster2 fires `itemResizeCallback` for every
    // item during initial placement and `itemChangeCallback` from `pushItems`
    // collision normalization; both arrive in this pre-settled window and MUST
    // NOT persist, otherwise the canvas would PATCH on every page load and
    // silently re-persist a normalized layout on read.
    component.options.itemResizeCallback?.(item as never, undefined as never);
    component.options.itemChangeCallback?.(item as never, undefined as never);

    expect(layoutServiceMock.save).not.toHaveBeenCalled();
  });

  it('persists a genuine post-settle gridster drag/resize and deduplicates idempotent re-fires (Rule 4 / F2-LOW-01)', () => {
    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 0,
      y: 0
    };
    component.items = [item];

    // Simulate the settled post-load state: the one-shot NgZone.onStable flip
    // has armed persistence and snapshotted the loaded layout as the
    // deep-compare baseline. (Private state is reached through a typed cast to
    // avoid `any` while exercising the gating contract directly.)
    const internals = component as unknown as {
      isLayoutInitialized: boolean;
      lastPersistedLayout: string | null;
    };
    internals.isLayoutInitialized = true;
    internals.lastPersistedLayout = JSON.stringify([
      { cols: 4, moduleKey: 'portfolio-overview', rows: 2, x: 0, y: 0 }
    ]);

    // An idempotent re-fire (no geometry change, e.g. a window resize) matches
    // the snapshot and is skipped.
    component.options.itemChangeCallback?.(item as never, undefined as never);
    expect(layoutServiceMock.save).not.toHaveBeenCalled();

    // A genuine pointer drag changes geometry → exactly one persist carrying
    // only the serialized contract (no gridster internals).
    item.x = 3;
    component.options.itemChangeCallback?.(item as never, undefined as never);
    expect(layoutServiceMock.save).toHaveBeenCalledTimes(1);
    expect(layoutServiceMock.save).toHaveBeenLastCalledWith([
      { cols: 4, moduleKey: 'portfolio-overview', rows: 2, x: 3, y: 0 }
    ]);

    // A genuine pointer resize changes size → a second persist.
    item.rows = 5;
    component.options.itemResizeCallback?.(item as never, undefined as never);
    expect(layoutServiceMock.save).toHaveBeenCalledTimes(2);
    expect(layoutServiceMock.save).toHaveBeenLastCalledWith([
      { cols: 4, moduleKey: 'portfolio-overview', rows: 5, x: 3, y: 0 }
    ]);
  });

  it('does not persist merely by loading a saved layout, even as gridster fires its initial callbacks (Rule 4 / F2-LOW-01)', () => {
    const saved: UserDashboardLayout = {
      layout: [{ cols: 4, moduleKey: 'holdings', rows: 4, x: 0, y: 0 }]
    };
    layoutServiceMock.get.mockReturnValue(of(saved));

    // ngOnInit loads the saved layout and arms the one-shot persistence flip.
    fixture.detectChanges();

    expect(component.items.length).toBe(1);

    // The post-load NgZone.onStable flip has not fired synchronously, so the
    // initial-placement resize and any normalization change callbacks gridster
    // emits while rendering the loaded layout must be gated out — no load-time
    // PATCH.
    const item = component.items[0];
    component.options.itemResizeCallback?.(item as never, undefined as never);
    component.options.itemChangeCallback?.(item as never, undefined as never);

    expect(layoutServiceMock.save).not.toHaveBeenCalled();
  });

  it('captures the gridster API on init and recalculates the layout on a keyboard change', () => {
    const calculateLayout = jest.fn();

    // Simulate the grid engine handing back its API through `initCallback`.
    component.options.initCallback?.(
      undefined as never,
      { calculateLayout } as never
    );

    const item = {
      cols: 4,
      minItemCols: 4,
      minItemRows: 2,
      moduleKey: 'portfolio-overview',
      rows: 2,
      x: 0,
      y: 0
    };
    component.items = [item];

    component.moveModule(item, 1, 0);

    // A programmatic (keyboard) change must ask the captured grid API to
    // recompute item positions, then persist through the single entry point.
    expect(calculateLayout).toHaveBeenCalled();
    expect(layoutServiceMock.save).toHaveBeenCalled();
  });

  it('ignores an unregistered module key returned by the catalog', () => {
    dialogMock.open.mockReturnValue({ afterClosed: () => of('ghost-module') });

    component.openCatalog();

    // `ghost-module` is not in the registry, so nothing is placed and no save
    // is triggered.
    expect(component.items).toEqual([]);
    expect(layoutServiceMock.save).not.toHaveBeenCalled();
  });

  it('stacks a newly added module below the lowest existing module', () => {
    // Seed a placed module so the new tile computes its row from a non-empty
    // grid (nextY = the lowest existing item's bottom edge).
    component.items = [
      {
        cols: 4,
        minItemCols: 4,
        minItemRows: 4,
        moduleKey: 'holdings',
        rows: 4,
        x: 0,
        y: 2
      }
    ];

    dialogMock.open.mockReturnValue({
      afterClosed: () => of('portfolio-overview')
    });

    component.openCatalog();

    const added = component.items.find(
      (item) => item.moduleKey === 'portfolio-overview'
    );
    expect(added).toBeDefined();
    // nextY = max(0, holdings.y + holdings.rows) = 2 + 4 = 6, anchored at x = 0.
    expect(added?.x).toBe(0);
    expect(added?.y).toBe(6);
  });
});
