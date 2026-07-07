// Initializes the global `$localize` function used by Angular i18n at runtime.
// Importing `GfModuleCatalogComponent` transitively evaluates
// `../module-registry.service`, which statically imports all 12 `modules/*`
// wrappers, whose transitive feature components (e.g. `home-overview`,
// `chat-panel`) declare `$localize`-tagged templates at module scope. This
// side-effect import MUST run before that module graph is evaluated (i.e.
// before the relative `../module-registry.service` / `./module-catalog.component`
// imports below) — otherwise merely importing the SUT throws
// `ReferenceError: $localize is not defined` before any test executes. Mirrors
// the verified pattern in `chat-panel.component.spec.ts` and
// `module-registry.service.spec.ts`. Even though `ModuleRegistryService` is
// overridden via `useValue` below, the ES `import` statement still evaluates
// the real module graph, so this bootstrap remains mandatory.
import { Type, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import '@angular/localize/init';
import { MatDialogRef } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { DashboardLayoutStoreService } from '../dashboard-layout-store.service';
import { DashboardModuleDefinition } from '../dashboard-module.interface';
import { ModuleRegistryService } from '../module-registry.service';
import { GfModuleCatalogComponent } from './module-catalog.component';

describe('GfModuleCatalogComponent', () => {
  let component: GfModuleCatalogComponent;
  let fixture: ComponentFixture<GfModuleCatalogComponent>;

  // A small, controlled registry so search + add assertions are deterministic.
  const mockModules: DashboardModuleDefinition[] = [
    {
      component: class {} as Type<any>,
      defaultCols: 6,
      defaultRows: 4,
      icon: 'dashboard',
      id: 'portfolio-overview',
      minCols: 2,
      minRows: 2,
      name: 'Portfolio Overview'
    },
    {
      component: class {} as Type<any>,
      defaultCols: 6,
      defaultRows: 6,
      icon: 'account_balance_wallet',
      id: 'holdings',
      minCols: 2,
      minRows: 2,
      name: 'Holdings'
    },
    {
      component: class {} as Type<any>,
      defaultCols: 4,
      defaultRows: 6,
      icon: 'chat',
      id: 'ai-chat',
      minCols: 2,
      minRows: 2,
      name: 'AI Chat'
    }
  ];

  const mockRegistry = {
    getMinDimensions: (id: string) => {
      const definition = mockModules.find((module) => module.id === id);

      return {
        minCols: definition?.minCols ?? 2,
        minRows: definition?.minRows ?? 2
      };
    },
    list: () => mockModules,
    register: jest.fn(),
    resolve: (id: string) => mockModules.find((module) => module.id === id)
  };

  const itemsSignal = signal<any[]>([]);

  const mockStore = {
    addItem: jest.fn(),
    items: itemsSignal
  };

  const dialogRefMock = { close: jest.fn() };

  beforeEach(async () => {
    itemsSignal.set([]);

    await TestBed.configureTestingModule({
      imports: [GfModuleCatalogComponent, NoopAnimationsModule],
      providers: [
        { provide: MatDialogRef, useValue: dialogRefMock },
        { provide: ModuleRegistryService, useValue: mockRegistry },
        { provide: DashboardLayoutStoreService, useValue: mockStore }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfModuleCatalogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be created', () => {
    expect(component).toBeTruthy();
  });

  it('should render every registered module (Rule 3)', () => {
    const rows = fixture.nativeElement.querySelectorAll(
      '[data-testid^="module-catalog-item-"]'
    );

    expect(rows.length).toBe(mockModules.length);
  });

  it('should filter the list case-insensitively by name', () => {
    component.searchTerm.set('HOLD');
    fixture.detectChanges();

    expect(component.filteredModules().length).toBe(1);
    expect(component.filteredModules()[0].id).toBe('holdings');

    const rows = fixture.nativeElement.querySelectorAll(
      '[data-testid^="module-catalog-item-"]'
    );
    expect(rows.length).toBe(1);
  });

  it('should return all modules for a blank/whitespace search term', () => {
    component.searchTerm.set('   ');
    fixture.detectChanges();

    expect(component.filteredModules().length).toBe(mockModules.length);
  });

  it('should render the empty state when nothing matches', () => {
    component.searchTerm.set('no-such-module');
    fixture.detectChanges();

    const empty = fixture.nativeElement.querySelector(
      '[data-testid="module-catalog-empty"]'
    );
    expect(empty).not.toBeNull();
  });

  it('should add a module at the first free position with registry-sourced 2x2 minimums (Rule 6)', () => {
    component.onAddModule(mockModules[1]); // holdings (6x6)

    expect(mockStore.addItem).toHaveBeenCalledTimes(1);
    expect(mockStore.addItem).toHaveBeenCalledWith({
      cols: 6,
      minItemCols: 2,
      minItemRows: 2,
      rows: 6,
      type: 'holdings',
      x: 0,
      y: 0
    });
  });

  it('should stack a new module below existing items (next free y)', () => {
    itemsSignal.set([
      { cols: 6, rows: 4, type: 'portfolio-overview', x: 0, y: 0 }
    ]);

    component.onAddModule(mockModules[2]); // ai-chat (4x6)

    expect(mockStore.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai-chat', x: 0, y: 4 })
    );
  });

  it('should fall back to minimum dimensions when defaults are absent', () => {
    const noDefaults: DashboardModuleDefinition = {
      component: class {} as Type<any>,
      icon: 'widgets',
      id: 'no-defaults',
      minCols: 2,
      minRows: 2,
      name: 'No Defaults'
    };

    component.onAddModule(noDefaults);

    expect(mockStore.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        cols: 2,
        minItemCols: 2,
        minItemRows: 2,
        rows: 2,
        type: 'no-defaults'
      })
    );
  });

  it('should add via a rendered list-item click', () => {
    const holdingsRow = fixture.nativeElement.querySelector(
      '[data-testid="module-catalog-item-holdings"]'
    ) as HTMLButtonElement;
    expect(holdingsRow).not.toBeNull();

    holdingsRow.click();
    fixture.detectChanges();

    expect(mockStore.addItem).toHaveBeenCalledTimes(1);
    expect(mockStore.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'holdings' })
    );
  });

  it('should close the dialog via onClose', () => {
    component.onClose();

    expect(dialogRefMock.close).toHaveBeenCalled();
  });
});
