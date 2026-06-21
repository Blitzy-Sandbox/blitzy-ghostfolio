import { ModuleDefinition } from '@ghostfolio/client/dashboard/dashboard.types';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';

import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. `module-catalog.component.html` uses `i18n` / `i18n-*` attributes
// (the catalog title, search label/placeholder, the row tooltip and the empty
// state), which the Angular compiler lowers to `$localize` tagged-template
// calls. Without this side-effect import, merely importing the SUT throws
// `ReferenceError: $localize is not defined` before any test runs. Placed in
// the `@angular` import group exactly as `chat-panel.component.spec.ts` does.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { addIcons } from 'ionicons';
import {
  chatbubblesOutline,
  trendingUpOutline,
  walletOutline
} from 'ionicons/icons';

import {
  GfModuleCatalogComponent,
  MODULE_KEY_DATA_TRANSFER_TYPE
} from './module-catalog.component';

// Register the Ionicons referenced by the mock module definitions below. In
// production the REAL `ModuleRegistryService` constructor registers every
// module icon via `addIcons(...)`; this spec mocks that service (see
// `jest.mock` above), so it registers the mock fixtures' icon names itself —
// otherwise `<ion-icon [name]="module.icon">` emits "Could not load icon"
// warnings for the unregistered names. The catalog's own chrome icons
// (close/add) are registered by the component constructor. `addIcons` is
// global and idempotent.
addIcons({ chatbubblesOutline, trendingUpOutline, walletOutline });

// Replace the real registry with a bare DI-token class BEFORE the
// system-under-test module is loaded. `module-registry.service.ts` statically
// imports all twelve wrapper components, which transitively pull in the real
// feature components and the `@ionic/angular/standalone` ESM bundle that Jest
// cannot parse under the project's
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule. Mocking the
// whole registry module (a) keeps this a fast, isolated unit test and (b)
// supplies a clean token that the component's `inject(ModuleRegistryService)`
// resolves to — its behavior is injected per-test via a `useValue` provider.
// `jest.mock(...)` is hoisted above the imports by the jest-preset-angular TS
// transformer, and the factory references no outer variables, so there is no
// hoisting pitfall. This mirrors the sibling `module-registry.service.spec.ts`.
jest.mock('@ghostfolio/client/dashboard/module-registry.service', () => ({
  ModuleRegistryService: class {}
}));

// A small, fixed, realistic set of module definitions covering distinct keys
// and display names. `component` is a throwaway stub class — the catalog never
// instantiates it; it only renders `displayName`/`icon` and emits the `key`.
// `displayName` values are chosen so a single search term ('mark'/'hold')
// matches exactly one entry, which lets the filter tests assert precise sets.
const MOCK_MODULES: ModuleDefinition[] = [
  {
    component: class {} as unknown as ModuleDefinition['component'],
    displayName: 'Holdings',
    icon: 'wallet-outline',
    key: 'holdings',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    component: class {} as unknown as ModuleDefinition['component'],
    displayName: 'AI Chat',
    icon: 'chatbubbles-outline',
    key: 'ai-chat',
    minItemCols: 3,
    minItemRows: 4
  },
  {
    component: class {} as unknown as ModuleDefinition['component'],
    displayName: 'Markets',
    icon: 'trending-up-outline',
    key: 'markets',
    minItemCols: 4,
    minItemRows: 3
  }
];

describe('GfModuleCatalogComponent', () => {
  let component: GfModuleCatalogComponent;
  let fixture: ComponentFixture<GfModuleCatalogComponent>;
  let getAllSpy: jest.Mock;
  let hasSpy: jest.Mock;

  // Type-safe DOM query helper. Casting `nativeElement` (typed `any` by
  // `ComponentFixture`) to `HTMLElement` once keeps each assertion short and
  // free of `no-unsafe-*` lint noise. Reads the current `fixture` at call time.
  const query = (testId: string): Element | null =>
    (fixture.nativeElement as HTMLElement).querySelector(
      `[data-testid="${testId}"]`
    );

  // Minimal in-memory DataTransfer stand-in. jsdom does not implement the
  // DataTransfer API, so the drag tests synthesize one that records values set
  // under each MIME type and exposes exactly the `types`/`getData`/`setData`/
  // `dropEffect`/`effectAllowed` surface the catalog's drag handlers touch. The
  // synthesized object is cast to `DragEvent.dataTransfer` at each call site.
  const createDataTransfer = () => {
    const store = new Map<string, string>();
    // Closure-captured (not `this`-based) so the methods stay type-safe under
    // the project's strict `no-unsafe-*` lint rules; `types` is exposed on the
    // returned object by reference so reads reflect every `setData`.
    const types: string[] = [];

    return {
      dropEffect: 'none',
      effectAllowed: 'none',
      getData: (type: string): string => store.get(type) ?? '',
      setData: (type: string, value: string): void => {
        store.set(type, value);

        if (!types.includes(type)) {
          types.push(type);
        }
      },
      types
    };
  };

  beforeEach(async () => {
    // Recreate the spies each test so call history never leaks across cases.
    // `has` backs the drop-handler's registry guard (FR3, registry-only
    // introduction); it defaults to accepting the key, and the rejection test
    // overrides it to return `false`.
    getAllSpy = jest.fn(() => MOCK_MODULES);
    hasSpy = jest.fn(() => true);

    await TestBed.configureTestingModule({
      imports: [GfModuleCatalogComponent, NoopAnimationsModule],
      providers: [
        {
          provide: ModuleRegistryService,
          useValue: { getAll: getAllSpy, has: hasSpy }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfModuleCatalogComponent);
    component = fixture.componentInstance;
    // Triggers `ngOnInit` with the default `autoOpen = false`, so the catalog
    // starts closed (no `mat-sidenav` rendered).
    fixture.detectChanges();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Case 1 — Creation.
  it('should be created', () => {
    expect(component).toBeTruthy();
  });

  // Case 2 — Every registered module renders as exactly one catalog row once
  // the panel is opened (rows live inside the `@if (opened())` block).
  it('renders one catalog row per registered module when opened', () => {
    component.open();
    fixture.detectChanges();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid^="catalog-item-"]'
    );

    expect(rows.length).toBe(MOCK_MODULES.length);
    expect(query('catalog-item-holdings')).not.toBeNull();
    expect(query('catalog-item-ai-chat')).not.toBeNull();
    expect(query('catalog-item-markets')).not.toBeNull();
  });

  // Case 3 — `filteredModules()` filters by `displayName` case-insensitively at
  // the computed-signal level (an uppercase term must match a lowercase name);
  // an empty term returns every registered module.
  it('filters modules by displayName case-insensitively (computed level)', () => {
    component.searchTerm.set('MARK');

    expect(component.filteredModules().map((module) => module.key)).toEqual([
      'markets'
    ]);

    component.searchTerm.set('');

    expect(component.filteredModules().length).toBe(MOCK_MODULES.length);
  });

  // Case 4 — The same filter is reflected in the rendered rows, and a term that
  // matches nothing renders the empty state instead of any rows.
  it('filters the rendered rows and shows the empty state (DOM level)', () => {
    component.open();
    component.searchTerm.set('hold');
    fixture.detectChanges();

    expect(query('catalog-item-holdings')).not.toBeNull();
    expect(query('catalog-item-markets')).toBeNull();
    expect(query('catalog-item-ai-chat')).toBeNull();

    component.searchTerm.set('zzz');
    fixture.detectChanges();

    expect(query('catalog-empty')).not.toBeNull();
    expect(query('catalog-item-holdings')).toBeNull();
  });

  // Case 5 — Selecting a row (click) and the direct `onAddModule` method both
  // emit the module's stable `key` upward via the `addModule` output.
  it('emits addModule with the module key on row click and onAddModule', () => {
    component.open();
    fixture.detectChanges();

    const emitted: string[] = [];
    component.addModule.subscribe((key) => emitted.push(key));

    (query('catalog-item-holdings') as HTMLButtonElement).click();

    expect(emitted).toEqual(['holdings']);

    component.onAddModule('ai-chat');

    expect(emitted).toEqual(['holdings', 'ai-chat']);
    expect(emitted).toContain('ai-chat');
  });

  // Case 5b — Drag-to-add path (AAP: "adding a module by drag or click").
  // `dragstart` writes ONLY the stable key into the dedicated MIME type (no
  // emission yet); `dragover` accepts the drag; and `drop` reads the key back,
  // validates it against the registry, and emits it — the same upward `string`
  // contract as a click, never a component reference (module isolation).
  it('emits addModule with the module key via the drag-to-add path', () => {
    component.open();
    fixture.detectChanges();

    const emitted: string[] = [];
    component.addModule.subscribe((key) => emitted.push(key));

    const dataTransfer = createDataTransfer();

    // 1) dragstart on a row stamps the stable key into the drag payload.
    component.onModuleDragStart('markets', {
      dataTransfer
    } as unknown as DragEvent);

    expect(dataTransfer.getData(MODULE_KEY_DATA_TRANSFER_TYPE)).toBe('markets');
    expect(dataTransfer.effectAllowed).toBe('copy');
    // No emission on dragstart — only a completed drop adds the module.
    expect(emitted).toEqual([]);

    // 2) dragover accepts the drag (preventDefault is what lets `drop` fire)
    //    because our MIME type is present in the payload.
    const dragOverPreventDefault = jest.fn();
    component.onCatalogDragOver({
      dataTransfer,
      preventDefault: dragOverPreventDefault
    } as unknown as DragEvent);

    expect(dragOverPreventDefault).toHaveBeenCalledTimes(1);
    expect(dataTransfer.dropEffect).toBe('copy');

    // 3) drop reads the key, validates it via the registry guard, and emits it.
    const dropPreventDefault = jest.fn();
    component.onCatalogDrop({
      dataTransfer,
      preventDefault: dropPreventDefault
    } as unknown as DragEvent);

    expect(dropPreventDefault).toHaveBeenCalledTimes(1);
    expect(hasSpy).toHaveBeenCalledWith('markets');
    expect(emitted).toEqual(['markets']);
  });

  // Case 5c — Registry guard (FR3): a drop whose payload key is not registered
  // is rejected — no emission and the default action is NOT prevented.
  it('ignores a drop whose payload key is not in the registry', () => {
    component.open();
    fixture.detectChanges();

    const emitted: string[] = [];
    component.addModule.subscribe((key) => emitted.push(key));

    hasSpy.mockReturnValue(false);

    const dataTransfer = createDataTransfer();
    dataTransfer.setData(MODULE_KEY_DATA_TRANSFER_TYPE, 'not-a-real-module');

    const dropPreventDefault = jest.fn();
    component.onCatalogDrop({
      dataTransfer,
      preventDefault: dropPreventDefault
    } as unknown as DragEvent);

    expect(hasSpy).toHaveBeenCalledWith('not-a-real-module');
    expect(emitted).toEqual([]);
    expect(dropPreventDefault).not.toHaveBeenCalled();
  });

  // Case 6a — With the default `autoOpen = false`, `ngOnInit` leaves the
  // catalog closed and no `mat-sidenav` is rendered.
  it('keeps the catalog closed on init when autoOpen is false (default)', () => {
    expect(component.opened()).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('mat-sidenav')
    ).toBeNull();
  });

  // Case 6b — First-visit path: when `autoOpen` is true, `ngOnInit` opens the
  // catalog and the `mat-sidenav` is rendered. `beforeEach` already ran
  // `ngOnInit` once with `autoOpen = false`, so re-invoking it after flipping
  // the input is the deterministic way to exercise the auto-open branch.
  it('auto-opens the catalog on init when autoOpen is true', () => {
    component.autoOpen = true;
    component.ngOnInit();
    fixture.detectChanges();

    expect(component.opened()).toBe(true);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('mat-sidenav')
    ).not.toBeNull();
  });

  // Case 7a — `open`, `close` and `toggle` each drive the `opened()` signal and
  // emit the corresponding boolean through `openedChange`.
  it('drives opened() and emits openedChange on open/close/toggle', () => {
    const emissions: boolean[] = [];
    component.openedChange.subscribe((value) => emissions.push(value));

    component.open();
    expect(component.opened()).toBe(true);

    component.close();
    expect(component.opened()).toBe(false);

    component.toggle();
    expect(component.opened()).toBe(true);

    expect(emissions).toEqual([true, false, true]);
  });

  // Case 7b — The `setOpened` equality guard suppresses redundant emissions:
  // calling `open()` twice flips the state once and emits exactly once.
  it('emits openedChange only once when open() is called repeatedly', () => {
    const emissions: boolean[] = [];
    component.openedChange.subscribe((value) => emissions.push(value));

    component.open();
    component.open();

    expect(component.opened()).toBe(true);
    expect(emissions).toEqual([true]);
  });

  // `onSidenavOpenedChange` relays the MatSidenav's own open-state changes
  // (backdrop click / ESC) back into the authoritative `opened()` signal,
  // keeping the two in sync and emitting `openedChange` for the parent canvas.
  it('relays MatSidenav state into opened() via onSidenavOpenedChange', () => {
    const emissions: boolean[] = [];
    component.openedChange.subscribe((value) => emissions.push(value));

    component.onSidenavOpenedChange(true);
    expect(component.opened()).toBe(true);

    component.onSidenavOpenedChange(false);
    expect(component.opened()).toBe(false);

    expect(emissions).toEqual([true, false]);
  });
});
