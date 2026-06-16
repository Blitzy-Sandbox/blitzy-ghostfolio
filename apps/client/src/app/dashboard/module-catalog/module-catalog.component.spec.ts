import {
  MODULE_DRAG_DATA_TYPE,
  ModuleDefinition
} from '@ghostfolio/client/dashboard/dashboard.types';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';

import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at runtime.
// The companion `module-catalog.component.html` template uses `i18n`
// attributes (e.g. on the "Add module" title and the search label) which the
// Angular compiler lowers to `$localize` tagged-template calls. Without this
// side-effect import, rendering the component (which `fixture.detectChanges()`
// does for the DOM-level cases below) throws
// `ReferenceError: $localize is not defined`. It is placed in the `@angular`
// import group exactly as `chat-panel.component.spec.ts` and the sibling
// `module-registry.service.spec.ts` do.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { GfModuleCatalogComponent } from './module-catalog.component';

// Replace the real `ModuleRegistryService` with a bare stand-in class usable
// only as a DI token. The real `module-registry.service.ts` statically imports
// all twelve wrapper components -> the real feature components ->
// `@ionic/angular/standalone` -> `@ionic/core`, which ships plain ESM `.js`
// files that Jest cannot parse under the project's
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (`apps/client/jest.config.ts`). Mocking the registry module path
// short-circuits that entire transitive ESM chain, keeping this a fast,
// isolated unit test. The `jest.mock` factory is hoisted above all imports by
// the Jest/ts-jest transform, so the component's `inject(ModuleRegistryService)`
// and this spec's `ModuleRegistryService` token resolve to the SAME stand-in.
// The factory references NO outer variables, so there is no hoisting pitfall;
// each test supplies the catalog's module set through a `useValue` provider.
jest.mock('@ghostfolio/client/dashboard/module-registry.service', () => ({
  // Anonymous bare class: only the exported `ModuleRegistryService` *binding*
  // matters as a DI token (kept anonymous to avoid shadowing the imported
  // token of the same name). The real implementation is never executed and the
  // class is never instantiated — each test supplies behavior via `useValue`.
  ModuleRegistryService: class {}
}));

// The dashboard canvas/catalog components statically import `IonIcon` from
// `@ionic/angular/standalone`, whose real module graph reaches `@ionic/core`'s
// plain-ESM `.js` files that Jest cannot parse under the project's
// `transformIgnorePatterns` rule (`apps/client/jest.config.ts`, out of scope
// per AAP § 0.6). Mocking the package with a minimal standalone `ion-icon`
// stand-in (exposing the bound `name` input) short-circuits that chain while
// keeping the component's `imports` array and rendered template valid. The
// companion `ionicons`/`ionicons/icons` mocks neutralise the `addIcons(...)`
// registration call the components run in their constructors.
jest.mock('@ionic/angular/standalone', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const ngCore = require('@angular/core') as typeof import('@angular/core');
  const { Component } = ngCore;
  class IonIcon {}
  Component({ inputs: ['name'], selector: 'ion-icon', template: '' })(IonIcon);
  return { IonIcon };
});
jest.mock('ionicons', () => ({ addIcons: jest.fn() }));
jest.mock(
  'ionicons/icons',
  () =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          typeof property === 'string' ? property : undefined
      }
    )
);

// A small, fixed, realistic set of module definitions with deliberately varied
// `displayName`s so the case-insensitive search filter can be exercised. The
// `component` field is a throwaway stub class — the catalog never instantiates
// it (it only renders `displayName`/`icon` and emits the `key` on click), so an
// empty class cast to the field's type is sufficient.
const MOCK_MODULES: ModuleDefinition[] = [
  {
    component: class {} as unknown as ModuleDefinition['component'],
    displayName: 'Holdings',
    icon: 'account_balance_wallet',
    key: 'holdings',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    component: class {} as unknown as ModuleDefinition['component'],
    displayName: 'AI Chat',
    icon: 'chat',
    key: 'ai-chat',
    minItemCols: 3,
    minItemRows: 4
  },
  {
    component: class {} as unknown as ModuleDefinition['component'],
    displayName: 'Markets',
    icon: 'trending_up',
    key: 'markets',
    minItemCols: 4,
    minItemRows: 3
  }
];

describe('GfModuleCatalogComponent', () => {
  let component: GfModuleCatalogComponent;
  let fixture: ComponentFixture<GfModuleCatalogComponent>;
  let getAllSpy: jest.Mock;

  beforeEach(async () => {
    getAllSpy = jest.fn(() => MOCK_MODULES);

    await TestBed.configureTestingModule({
      imports: [GfModuleCatalogComponent, NoopAnimationsModule],
      providers: [
        { provide: ModuleRegistryService, useValue: { getAll: getAllSpy } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfModuleCatalogComponent);
    component = fixture.componentInstance;
    // Triggers ngOnInit with the default `autoOpen = false`, so the catalog
    // starts closed and the `@if (opened())` template block renders nothing.
    fixture.detectChanges();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Required case 1 — Creation.
  it('should be created', () => {
    expect(component).toBeTruthy();
    expect(component.opened()).toBe(false);
  });

  // Required case 6 — autoOpen opens on init; the default keeps it closed.
  describe('autoOpen / ngOnInit', () => {
    it('should keep the catalog closed on init when autoOpen is false (default)', () => {
      // `beforeEach` already ran `ngOnInit` with the default `autoOpen = false`.
      expect(component.opened()).toBe(false);
      expect(fixture.nativeElement.querySelector('mat-sidenav')).toBeNull();
    });

    it('should open the catalog on init when autoOpen is true', () => {
      // `beforeEach` already initialized the component with `autoOpen = false`;
      // setting it true and re-invoking `ngOnInit` is the deterministic way to
      // exercise the first-visit auto-open path.
      component.autoOpen = true;
      component.ngOnInit();
      fixture.detectChanges();

      expect(component.opened()).toBe(true);
      expect(fixture.nativeElement.querySelector('mat-sidenav')).not.toBeNull();
    });
  });

  // Required case 7 — open/close/toggle drive `opened()` and emit
  // `openedChange`; the `setOpened` guard suppresses redundant emissions.
  describe('open / close / toggle (openedChange)', () => {
    it('should open the catalog and emit openedChange(true)', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.open();

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([true]);
    });

    it('should close the catalog and emit openedChange(false)', () => {
      component.open();

      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.close();

      expect(component.opened()).toBe(false);
      expect(emitted).toEqual([false]);
    });

    it('should flip opened() and emit on each toggle()', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.toggle();
      component.toggle();
      component.toggle();

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([true, false, true]);
    });

    it('should emit openedChange only once when open() is called twice (setOpened guard)', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.open();
      component.open();

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([true]);
    });

    // F2-05 — the catalog is hidden by `MatSidenav` rather than destroyed, so a
    // search term typed before a close would otherwise persist and leave the
    // list filtered (or empty) on the next open. `setOpened(true)` must reset
    // `searchTerm` so every reopen presents the full, unfiltered module list.
    it('should reset the search term on reopen so the full list is shown (F2-05)', () => {
      // Open and type a term that matches nothing -> the list filters to empty.
      component.open();
      component.searchTerm.set('zzznomatch');
      expect(component.filteredModules()).toEqual([]);

      // Closing does NOT clear the term (the sidenav hides, it is not
      // destroyed) — proving the reset on the *next open* is what restores it.
      component.close();
      expect(component.searchTerm()).toBe('zzznomatch');

      // Reopening must clear the stale term and restore every registered module.
      component.open();

      expect(component.searchTerm()).toBe('');
      expect(component.filteredModules().length).toBe(MOCK_MODULES.length);
    });

    // The reset is scoped to genuine open *transitions*: calling `open()` while
    // the catalog is already open hits the unchanged-value guard and must NOT
    // wipe a search the user is actively typing.
    it('should not clear an in-progress search when open() is called while already open', () => {
      component.open();
      component.searchTerm.set('hold');

      component.open();

      expect(component.searchTerm()).toBe('hold');
      expect(component.filteredModules().map((module) => module.key)).toEqual([
        'holdings'
      ]);
    });
  });

  // Extra coverage — `onSidenavOpenedChange` relays the MatSidenav's own
  // open-state changes (backdrop click / ESC) back into the component and is
  // protected by the same guard.
  describe('onSidenavOpenedChange', () => {
    it('should relay a user-driven close from the sidenav into opened()', () => {
      component.open();

      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.onSidenavOpenedChange(false);

      expect(component.opened()).toBe(false);
      expect(emitted).toEqual([false]);
    });

    it('should not re-emit when the sidenav reports the current state', () => {
      component.open();

      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.onSidenavOpenedChange(true);

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([]);
    });
  });

  // Required case 3 — Search filters by `displayName` (case-insensitive) at the
  // computed level.
  describe('filteredModules (computed)', () => {
    it('should filter case-insensitively by displayName', () => {
      component.searchTerm.set('MARK');

      expect(component.filteredModules().map((module) => module.key)).toEqual([
        'markets'
      ]);
      expect(getAllSpy).toHaveBeenCalled();
    });

    it('should return every registered module for an empty search term', () => {
      component.searchTerm.set('');

      expect(component.filteredModules().length).toBe(MOCK_MODULES.length);
    });

    it('should trim whitespace from the search term before matching', () => {
      component.searchTerm.set('  hold  ');

      expect(component.filteredModules().map((module) => module.key)).toEqual([
        'holdings'
      ]);
    });

    it('should return an empty list when nothing matches', () => {
      component.searchTerm.set('zzz');

      expect(component.filteredModules()).toEqual([]);
    });
  });

  // Required case 2 — every registry module renders as a row when the panel is
  // open.
  describe('catalog rows (DOM)', () => {
    it('should render every registered module as a catalog row when opened', () => {
      component.open();
      fixture.detectChanges();

      const rows = fixture.nativeElement.querySelectorAll(
        '[data-testid^="catalog-item-"]'
      );
      expect(rows.length).toBe(MOCK_MODULES.length);
      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="catalog-item-holdings"]'
        )
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="catalog-item-ai-chat"]'
        )
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="catalog-item-markets"]'
        )
      ).not.toBeNull();
    });

    // Required case 4 — the search filter is reflected in the rendered rows.
    it('should reflect the search filter in the rendered rows', () => {
      component.open();
      component.searchTerm.set('hold');
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="catalog-item-holdings"]'
        )
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="catalog-item-markets"]'
        )
      ).toBeNull();
      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="catalog-item-ai-chat"]'
        )
      ).toBeNull();
    });

    it('should render the empty-state placeholder when no module matches', () => {
      component.open();
      component.searchTerm.set('zzz');
      fixture.detectChanges();

      const rows = fixture.nativeElement.querySelectorAll(
        '[data-testid^="catalog-item-"]'
      );
      expect(rows.length).toBe(0);
      expect(
        fixture.nativeElement.querySelector('[data-testid="catalog-empty"]')
      ).not.toBeNull();
    });
  });

  // Required case 5 — selecting a module (click or direct method) emits
  // `addModule` with the module key.
  describe('addModule', () => {
    it('should emit addModule with the module key when a catalog row is clicked', () => {
      component.open();
      fixture.detectChanges();

      const emitted: string[] = [];
      component.addModule.subscribe((key) => emitted.push(key));

      const holdingsRow = fixture.nativeElement.querySelector(
        '[data-testid="catalog-item-holdings"]'
      ) as HTMLButtonElement;
      expect(holdingsRow).not.toBeNull();

      holdingsRow.click();

      expect(emitted).toEqual(['holdings']);
    });

    it('should emit addModule when onAddModule is called directly', () => {
      const emitted: string[] = [];
      component.addModule.subscribe((key) => emitted.push(key));

      component.onAddModule('ai-chat');

      expect(emitted).toContain('ai-chat');
    });

    // Drag-add — `onDragStart` writes the module key onto the drag's
    // `DataTransfer` so the canvas drop handler can place the module.
    it('should write the module key onto the drag DataTransfer on dragstart', () => {
      const setData = jest.fn();
      const dataTransfer = {
        effectAllowed: 'none',
        setData
      } as unknown as DataTransfer;
      const event = { dataTransfer } as unknown as DragEvent;

      component.onDragStart(event, 'markets');

      expect(setData).toHaveBeenCalledWith(MODULE_DRAG_DATA_TYPE, 'markets');
      expect(dataTransfer.effectAllowed).toBe('copy');
    });

    it('should no-op on dragstart when the event carries no DataTransfer', () => {
      const event = { dataTransfer: null } as unknown as DragEvent;

      expect(() => component.onDragStart(event, 'markets')).not.toThrow();
    });

    it('should mark catalog rows as draggable for drag-add', () => {
      component.open();
      fixture.detectChanges();

      const holdingsRow = fixture.nativeElement.querySelector(
        '[data-testid="catalog-item-holdings"]'
      ) as HTMLButtonElement;

      expect(holdingsRow.getAttribute('draggable')).toBe('true');
    });
  });

  // Issue 9 — the catalog surfaces which modules already live on the canvas via
  // the `placedModuleKeys` input so that an already-added module's row is
  // disabled, labelled "Added", and non-draggable. This gives the previously
  // silent duplicate-add no-op a visible, explained state (the canvas itself
  // also rejects duplicates, so a click on a placed row never adds a second
  // copy).
  describe('placedModuleKeys / isPlaced (Issue 9)', () => {
    it('should default placedModuleKeys to an empty array so nothing is placed', () => {
      expect(component.placedModuleKeys).toEqual([]);
      expect(component.isPlaced('holdings')).toBe(false);
    });

    it('should report a module as placed only when its key is in placedModuleKeys', () => {
      component.placedModuleKeys = ['holdings'];

      expect(component.isPlaced('holdings')).toBe(true);
      expect(component.isPlaced('markets')).toBe(false);
    });

    it('should disable, label "Added", and clear draggable on a placed row while leaving unplaced rows interactive', () => {
      component.placedModuleKeys = ['holdings'];
      component.open();
      fixture.detectChanges();

      const holdingsRow = fixture.nativeElement.querySelector(
        '[data-testid="catalog-item-holdings"]'
      ) as HTMLButtonElement;
      const marketsRow = fixture.nativeElement.querySelector(
        '[data-testid="catalog-item-markets"]'
      ) as HTMLButtonElement;

      // Placed row: disabled, non-draggable, and carries the "Added" marker.
      expect(holdingsRow.disabled).toBe(true);
      expect(holdingsRow.getAttribute('draggable')).toBeNull();
      expect(
        holdingsRow.querySelector('[data-testid="catalog-added-marker"]')
      ).not.toBeNull();

      // Unplaced row: still enabled, draggable, and without the marker.
      expect(marketsRow.disabled).toBe(false);
      expect(marketsRow.getAttribute('draggable')).toBe('true');
      expect(
        marketsRow.querySelector('[data-testid="catalog-added-marker"]')
      ).toBeNull();
    });

    it('should not emit addModule when a placed (disabled) row is clicked', () => {
      component.placedModuleKeys = ['holdings'];
      component.open();
      fixture.detectChanges();

      const emitted: string[] = [];
      component.addModule.subscribe((key) => emitted.push(key));

      const holdingsRow = fixture.nativeElement.querySelector(
        '[data-testid="catalog-item-holdings"]'
      ) as HTMLButtonElement;
      holdingsRow.click();

      // A disabled <button> does not fire its click handler, so no add occurs.
      expect(emitted).toEqual([]);
    });

    it('should no-op on dragstart for a placed module so it cannot be drag-added again', () => {
      component.placedModuleKeys = ['holdings'];
      const setData = jest.fn();
      const dataTransfer = {
        effectAllowed: 'none',
        setData
      } as unknown as DataTransfer;
      const event = { dataTransfer } as unknown as DragEvent;

      component.onDragStart(event, 'holdings');

      expect(setData).not.toHaveBeenCalled();
    });
  });

  // Issue 10 — a document-level Escape keydown deterministically closes an open
  // catalog (independent of where focus currently sits) and is a strict no-op
  // when the catalog is already closed, so it never emits a spurious
  // openedChange(false) nor swallows Escape from unrelated consumers.
  describe('onEscapeKeydown (Issue 10)', () => {
    it('should close an open catalog on Escape and emit openedChange(false)', () => {
      component.open();

      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      const event = {
        preventDefault: jest.fn()
      } as unknown as KeyboardEvent;
      component.onEscapeKeydown(event);

      expect(component.opened()).toBe(false);
      expect(emitted).toEqual([false]);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should be a no-op on Escape when the catalog is already closed', () => {
      // `beforeEach` leaves the catalog closed (autoOpen = false).
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      const event = {
        preventDefault: jest.fn()
      } as unknown as KeyboardEvent;
      component.onEscapeKeydown(event);

      expect(component.opened()).toBe(false);
      expect(emitted).toEqual([]);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });
});
