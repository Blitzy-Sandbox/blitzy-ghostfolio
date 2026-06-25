import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
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

/**
 * Stand-in component referenced by the mocked registry. It is never instantiated
 * because the canvas template is stripped (see `overrideComponent` below), so a
 * bare class is sufficient.
 */
class DummyModuleComponent {}

/**
 * Minimal registry the canvas reads through `ModuleRegistryService.get(...)`.
 * `portfolio-overview` and `holdings` are "registered"; everything else (e.g.
 * `ghost-module`) resolves to `undefined` so the unknown-module filter and the
 * `addModule`/`createGridsterItem` guards can be exercised.
 */
const REGISTRY: Record<string, RegisteredModule | undefined> = {
  holdings: {
    component: DummyModuleComponent,
    key: 'holdings',
    minCols: 4,
    minRows: 4,
    name: 'Holdings'
  },
  'portfolio-overview': {
    component: DummyModuleComponent,
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

    TestBed.configureTestingModule({
      imports: [GfDashboardCanvasComponent],
      providers: [
        { provide: DashboardLayoutService, useValue: layoutServiceMock },
        { provide: MatDialog, useValue: dialogMock },
        { provide: ModuleRegistryService, useValue: registryMock }
      ]
    });

    // Strip the angular-gridster2 imports and template so the component class can
    // be exercised in jsdom without the grid engine rendering. Keyboard
    // move/resize logic is pure geometry math and does not need the live grid;
    // `gridsterApi` simply stays undefined and its `calculateLayout()` call is
    // optional-chained to a no-op.
    TestBed.overrideComponent(GfDashboardCanvasComponent, {
      set: {
        imports: [],
        schemas: [NO_ERRORS_SCHEMA],
        template: ''
      }
    });

    fixture = TestBed.createComponent(GfDashboardCanvasComponent);
    component = fixture.componentInstance;
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
    expect(component.getModuleComponent('holdings')).toBe(DummyModuleComponent);
    expect(component.getModuleName('ghost-module')).toBe('');
    expect(component.getModuleComponent('ghost-module')).toBeUndefined();
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
});
