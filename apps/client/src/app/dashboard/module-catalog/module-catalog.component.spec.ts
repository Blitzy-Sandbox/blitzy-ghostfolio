import { ModuleDefinition } from '@ghostfolio/client/dashboard/dashboard.types';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';

import { TestBed } from '@angular/core/testing';

import { GfModuleCatalogComponent } from './module-catalog.component';

// Replace the real `ModuleRegistryService` with a bare stand-in so that
// importing the system-under-test does NOT pull in the registry's transitive
// import chain (the twelve wrapper components -> the real feature components ->
// `@ionic/angular/standalone` -> `@ionic/core`, which ships plain ESM `.js`
// files that Jest cannot parse under the project's
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule). Each test
// overrides the provider with a fully controllable `getAll` mock via
// `useValue`, so this factory body only needs to exist as a light, ESM-free
// token. The `jest.mock` call is hoisted above the imports above, so both this
// spec's `ModuleRegistryService` token and the SUT's injected dependency
// resolve to this stand-in. This mirrors the established mocking approach in
// `module-registry.service.spec.ts`.
jest.mock('@ghostfolio/client/dashboard/module-registry.service', () => ({
  ModuleRegistryService: class {
    public getAll(): ModuleDefinition[] {
      return [];
    }
  }
}));

// A throwaway component class used only to satisfy the `component: Type<unknown>`
// field of `ModuleDefinition`. The catalog never instantiates it — it only reads
// the metadata — so an empty class is sufficient.
class FakeModuleComponent {}

// A representative slice of the registry's catalog, with deliberately varied
// `displayName`s so the case-insensitive search filter can be exercised.
const MOCK_MODULES: ModuleDefinition[] = [
  {
    component: FakeModuleComponent,
    displayName: 'Portfolio Overview',
    icon: 'dashboard',
    key: 'portfolio-overview',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    component: FakeModuleComponent,
    displayName: 'Holdings',
    icon: 'account_balance_wallet',
    key: 'holdings',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    component: FakeModuleComponent,
    displayName: 'AI Chat',
    icon: 'chat',
    key: 'ai-chat',
    minItemCols: 3,
    minItemRows: 4
  }
];

describe('GfModuleCatalogComponent', () => {
  let component: GfModuleCatalogComponent;
  let registryMock: { getAll: jest.Mock };

  beforeEach(() => {
    registryMock = { getAll: jest.fn().mockReturnValue(MOCK_MODULES) };

    TestBed.configureTestingModule({
      providers: [{ provide: ModuleRegistryService, useValue: registryMock }]
    });

    // Construct the component inside an injection context so its `inject()`
    // field initializer resolves the mocked registry. The component is never
    // rendered (no `detectChanges`), so the `MatSidenav` template chrome is
    // never instantiated — these are pure component-logic assertions against a
    // mocked registry.
    component = TestBed.runInInjectionContext(
      () => new GfModuleCatalogComponent()
    );
  });

  it('should create', () => {
    expect(component).toBeTruthy();
    expect(component.opened()).toBe(false);
  });

  describe('autoOpen / ngOnInit', () => {
    it('stays closed on init when autoOpen is false', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.ngOnInit();

      expect(component.opened()).toBe(false);
      expect(emitted).toEqual([]);
    });

    it('opens on init and emits openedChange when autoOpen is true', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.autoOpen = true;
      component.ngOnInit();

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([true]);
    });
  });

  describe('open / close / toggle', () => {
    it('open() opens the catalog and emits openedChange once', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.open();

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([true]);
    });

    it('close() closes the catalog and emits openedChange', () => {
      const emitted: boolean[] = [];
      component.open();
      component.openedChange.subscribe((value) => emitted.push(value));

      component.close();

      expect(component.opened()).toBe(false);
      expect(emitted).toEqual([false]);
    });

    it('toggle() flips the opened state on each call', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.toggle();
      component.toggle();
      component.toggle();

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([true, false, true]);
    });

    it('does not emit openedChange when the value is unchanged (guard)', () => {
      const emitted: boolean[] = [];
      component.openedChange.subscribe((value) => emitted.push(value));

      component.open();
      component.open();
      component.close();
      component.close();

      expect(emitted).toEqual([true, false]);
    });
  });

  describe('onSidenavOpenedChange', () => {
    it('relays a user-driven close from the sidenav into the opened state', () => {
      const emitted: boolean[] = [];
      component.open();
      component.openedChange.subscribe((value) => emitted.push(value));

      component.onSidenavOpenedChange(false);

      expect(component.opened()).toBe(false);
      expect(emitted).toEqual([false]);
    });

    it('does not re-emit when the sidenav reports the current state', () => {
      const emitted: boolean[] = [];
      component.open();
      component.openedChange.subscribe((value) => emitted.push(value));

      component.onSidenavOpenedChange(true);

      expect(component.opened()).toBe(true);
      expect(emitted).toEqual([]);
    });
  });

  describe('filteredModules', () => {
    it('returns every registered module when the search term is empty', () => {
      expect(component.filteredModules()).toEqual(MOCK_MODULES);
      expect(registryMock.getAll).toHaveBeenCalled();
    });

    it('filters case-insensitively by displayName', () => {
      component.searchTerm.set('hold');
      expect(component.filteredModules()).toEqual([MOCK_MODULES[1]]);

      component.searchTerm.set('AI');
      expect(component.filteredModules()).toEqual([MOCK_MODULES[2]]);
    });

    it('trims whitespace from the search term before matching', () => {
      component.searchTerm.set('  portfolio  ');

      expect(component.filteredModules()).toEqual([MOCK_MODULES[0]]);
    });

    it('returns an empty list when nothing matches', () => {
      component.searchTerm.set('no-such-module');

      expect(component.filteredModules()).toEqual([]);
    });
  });

  describe('onAddModule', () => {
    it('emits the selected module key on addModule', () => {
      const emitted: string[] = [];
      component.addModule.subscribe((key) => emitted.push(key));

      component.onAddModule('ai-chat');

      expect(emitted).toEqual(['ai-chat']);
    });
  });
});
