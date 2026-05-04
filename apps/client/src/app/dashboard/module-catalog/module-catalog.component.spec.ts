import { Component, Type } from '@angular/core';
import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  tick
} from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `module-catalog.component.html` template uses
// `i18n` attributes which the Angular compiler lowers to `$localize`
// tagged template calls. The companion `module-catalog.component.ts`
// declares `$localize`-tagged template literals at module scope (for
// the search aria-label and add-button aria-label). Without this
// side-effect import, simply importing the SUT class throws
// `ReferenceError: $localize is not defined` before any test even
// runs. Mirrors the pattern established at
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { MatDialogRef } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { DashboardModuleDescriptor } from '../interfaces/dashboard-module.interface';
import { ModuleRegistryService } from '../module-registry.service';
import { GfModuleCatalogComponent } from './module-catalog.component';

// Short-circuit the `@ionic/angular/standalone` ESM import chain
// before the SUT is loaded (QA Checkpoint 6 Issue #3 fix added
// IonIcon to module-catalog.component.ts directly).
//
// See `module-wrapper.component.spec.ts:18-65` for the full
// rationale; the canonical workaround is to register a `jest.mock`
// returning a bare standalone component for `IonIcon`. Jest
// hoists `jest.mock(...)` calls above all imports, so the SUT's
// `import { IonIcon } from '@ionic/angular/standalone'` resolves
// to the mock at load time and the underlying `@ionic/core`
// ESM-only `.js` files are never touched. Editing
// `apps/client/jest.config.ts`'s `transformIgnorePatterns` is
// OUT OF SCOPE for this QA-fixer pass.
jest.mock('@ionic/angular/standalone', () => {
  const { Component: NgComponent } = jest.requireActual('@angular/core');
  @NgComponent({
    selector: 'ion-icon',
    standalone: true,
    template: ''
  })
  class IonIconMock {}
  return { IonIcon: IonIconMock };
});

jest.mock('ionicons', () => ({
  addIcons: jest.fn()
}));

jest.mock('ionicons/icons', () => ({
  // Each named export below corresponds to one icon imported by
  // module-catalog.component.ts. Mock values are arbitrary; tests
  // do not assert on them.
  addOutline: 'addOutline',
  analyticsOutline: 'analyticsOutline',
  barChartOutline: 'barChartOutline',
  chatbubblesOutline: 'chatbubblesOutline',
  listOutline: 'listOutline',
  pieChartOutline: 'pieChartOutline'
}));

/**
 * Standalone test stub component used as the {@link
 * DashboardModuleDescriptor.component} field in valid-fixture
 * descriptors. Declared as a local class (not exported) so the spec
 * file is fully self-contained — no real feature wrapper (e.g.,
 * `GfChatModuleComponent`, `GfHoldingsModuleComponent`) is loaded
 * into the registry by these tests, which keeps the test surface
 * independent of feature-module evolution. Mirrors the pattern in
 * `apps/client/src/app/dashboard/module-registry.service.spec.ts`.
 *
 * Each stub has a unique selector to satisfy Angular's standalone
 * component selector-uniqueness rule; the empty `template` ensures
 * no rendering work occurs (these components never enter a
 * `ComponentFixture`'s render path — they exist purely as
 * `Type<unknown>` references on the descriptor's `component` field).
 */
@Component({
  selector: 'gf-test-module-a',
  standalone: true,
  template: ''
})
class TestModuleAComponent {}

@Component({
  selector: 'gf-test-module-b',
  standalone: true,
  template: ''
})
class TestModuleBComponent {}

@Component({
  selector: 'gf-test-module-c',
  standalone: true,
  template: ''
})
class TestModuleCComponent {}

/**
 * Module-scoped descriptor fixtures used across multiple tests. The
 * fixtures cover the three search scenarios (PascalCase displayLabel
 * match, lowercase kebab-case name match, multi-word displayLabel) and
 * are statically typed against {@link DashboardModuleDescriptor} so the
 * compile-time contract guards against accidental field-shape drift.
 */
const PORTFOLIO_DESCRIPTOR: DashboardModuleDescriptor = {
  component: TestModuleAComponent as Type<unknown>,
  defaultCols: 6,
  defaultRows: 4,
  displayLabel: 'Portfolio Overview',
  iconName: 'analytics-outline',
  minCols: 4,
  minRows: 2,
  name: 'portfolio-overview'
};

const CHAT_DESCRIPTOR: DashboardModuleDescriptor = {
  component: TestModuleBComponent as Type<unknown>,
  defaultCols: 4,
  defaultRows: 6,
  displayLabel: 'AI Chat',
  iconName: 'chatbubbles-outline',
  minCols: 2,
  minRows: 4,
  name: 'chat'
};

const HOLDINGS_DESCRIPTOR: DashboardModuleDescriptor = {
  component: TestModuleCComponent as Type<unknown>,
  defaultCols: 12,
  defaultRows: 6,
  displayLabel: 'Holdings',
  iconName: 'pie-chart-outline',
  minCols: 6,
  minRows: 4,
  name: 'holdings'
};

/**
 * Test-double for {@link ModuleRegistryService}. Exposes the same
 * `getAll` / `getByName` / `register` API surface as the real registry
 * so the SUT cannot tell the difference. Tests drive the SUT's
 * `filteredModules()` computed signal by calling
 * {@link FakeModuleRegistryService.setDescriptors} BEFORE the first
 * `fixture.detectChanges()` so the catalog's first render reads the
 * test's chosen descriptor set.
 *
 * `getAll()` returns a defensive copy via array spread (`[...]`) to
 * mirror the real registry's `Array.from(this.registry.values())`
 * behavior — this prevents tests that mutate the returned array from
 * polluting the fake's internal state and matches the real registry's
 * invariant that callers cannot smuggle a new module into the registry
 * by mutating the array `getAll()` returns.
 *
 * `register(...)` is included to maintain shape parity with the real
 * registry; the catalog SUT does not invoke `register(...)` at runtime,
 * but the fake's having that method ensures any future SUT refactor
 * that begins calling `register(...)` would not require a fake-side
 * code change before the spec compiles.
 */
class FakeModuleRegistryService {
  private descriptors: DashboardModuleDescriptor[] = [];

  public setDescriptors(descriptors: DashboardModuleDescriptor[]): void {
    this.descriptors = descriptors;
  }

  public getAll(): DashboardModuleDescriptor[] {
    return [...this.descriptors];
  }

  public getByName(name: string): DashboardModuleDescriptor | undefined {
    return this.descriptors.find((d) => d.name === name);
  }

  public register(descriptor: DashboardModuleDescriptor): void {
    this.descriptors = [...this.descriptors, descriptor];
  }
}

describe('GfModuleCatalogComponent', () => {
  let component: GfModuleCatalogComponent;
  let fixture: ComponentFixture<GfModuleCatalogComponent>;
  let mockDialogRef: { close: jest.Mock };
  let fakeRegistry: FakeModuleRegistryService;

  beforeEach(async () => {
    mockDialogRef = { close: jest.fn() };
    fakeRegistry = new FakeModuleRegistryService();

    await TestBed.configureTestingModule({
      imports: [GfModuleCatalogComponent, NoopAnimationsModule],
      providers: [
        { provide: MatDialogRef, useValue: mockDialogRef },
        { provide: ModuleRegistryService, useValue: fakeRegistry }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfModuleCatalogComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // 6.1 — Component is created.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // 6.2 — Empty registry → empty list rendered (no `<mat-list-item>`
  // rows).
  it('should render no list rows when the registry is empty', () => {
    fakeRegistry.setDescriptors([]);
    fixture.detectChanges();

    const listItems = fixture.nativeElement.querySelectorAll(
      '.gf-module-catalog-row'
    );

    expect(listItems.length).toBe(0);
  });

  // 6.3 — All modules listed when registry has entries; rendered DOM
  // contains one row per registered module and each descriptor's
  // displayLabel appears in the rendered text content.
  it('should render one list row per registered module', () => {
    fakeRegistry.setDescriptors([
      PORTFOLIO_DESCRIPTOR,
      CHAT_DESCRIPTOR,
      HOLDINGS_DESCRIPTOR
    ]);
    fixture.detectChanges();

    const listItems = fixture.nativeElement.querySelectorAll(
      '.gf-module-catalog-row'
    );
    expect(listItems.length).toBe(3);

    // Verify each descriptor's displayLabel appears in the rendered DOM
    const renderedText =
      (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(renderedText).toContain('Portfolio Overview');
    expect(renderedText).toContain('AI Chat');
    expect(renderedText).toContain('Holdings');
  });

  // 6.4 — `filteredModules()` returns all descriptors when the search
  // term is empty (the default state). Verifies the empty-string
  // sentinel branch of the SUT's `computed(...)` filter (the
  // `term.length === 0` short-circuit return path).
  it('should expose all modules in filteredModules() when searchTerm is empty', () => {
    fakeRegistry.setDescriptors([
      PORTFOLIO_DESCRIPTOR,
      CHAT_DESCRIPTOR,
      HOLDINGS_DESCRIPTOR
    ]);
    fixture.detectChanges();

    expect(component.filteredModules()).toHaveLength(3);
    expect(component.searchTerm()).toBe('');
  });

  // 6.5 — Search filter narrows the list (case-insensitive match
  // against `displayLabel`). Setting `searchTerm.set('Chat')` reduces
  // `filteredModules()` to only descriptors whose `displayLabel` or
  // `name` contains 'chat' (case-insensitive). The CHAT_DESCRIPTOR's
  // `displayLabel` is 'AI Chat', so a 'Chat' query matches it via
  // displayLabel-substring.
  it('should narrow filteredModules() to entries whose displayLabel contains the search term (case-insensitive)', () => {
    fakeRegistry.setDescriptors([
      PORTFOLIO_DESCRIPTOR,
      CHAT_DESCRIPTOR,
      HOLDINGS_DESCRIPTOR
    ]);
    fixture.detectChanges();

    component.searchTerm.set('Chat');
    fixture.detectChanges();

    expect(component.filteredModules()).toHaveLength(1);
    expect(component.filteredModules()[0].name).toBe('chat');
  });

  // 6.6 — Search filter is case-insensitive on lowercase queries
  // against PascalCase labels. PORTFOLIO_DESCRIPTOR's `displayLabel`
  // is 'Portfolio Overview', so a lowercase 'portfolio' query matches
  // via case-insensitive substring on displayLabel.
  it('should match search term case-insensitively (lowercase query against PascalCase label)', () => {
    fakeRegistry.setDescriptors([
      PORTFOLIO_DESCRIPTOR,
      CHAT_DESCRIPTOR,
      HOLDINGS_DESCRIPTOR
    ]);
    fixture.detectChanges();

    component.searchTerm.set('portfolio');
    fixture.detectChanges();

    expect(component.filteredModules()).toHaveLength(1);
    expect(component.filteredModules()[0].name).toBe('portfolio-overview');
  });

  // 6.7 — Search filter narrows by descriptor `name` (kebab-case
  // identifier). HOLDINGS_DESCRIPTOR's `name` is 'holdings', so
  // searching 'holdings' matches via the second OR branch of the SUT's
  // filter — `m.name.toLowerCase().includes(term)` — ensuring users
  // can search by either the human-readable label or the stable
  // kebab-case identifier.
  it('should match search term against the descriptor name (kebab-case identifier)', () => {
    fakeRegistry.setDescriptors([
      PORTFOLIO_DESCRIPTOR,
      CHAT_DESCRIPTOR,
      HOLDINGS_DESCRIPTOR
    ]);
    fixture.detectChanges();

    component.searchTerm.set('holdings');
    fixture.detectChanges();

    expect(component.filteredModules()).toHaveLength(1);
    expect(component.filteredModules()[0].name).toBe('holdings');
  });

  // 6.8 — Search filter trims whitespace (`searchTerm().trim()` in the
  // SUT's `computed(...)`). Setting `searchTerm.set('   chat   ')`
  // (with leading/trailing whitespace) MUST behave identically to
  // setting `'chat'` so users do not see surprising no-results
  // outcomes from a stray pasted space.
  it('should ignore leading and trailing whitespace in the search term', () => {
    fakeRegistry.setDescriptors([
      PORTFOLIO_DESCRIPTOR,
      CHAT_DESCRIPTOR,
      HOLDINGS_DESCRIPTOR
    ]);
    fixture.detectChanges();

    component.searchTerm.set('   chat   ');
    fixture.detectChanges();

    expect(component.filteredModules()).toHaveLength(1);
    expect(component.filteredModules()[0].name).toBe('chat');
  });

  // 6.9 — Click-to-add: clicking the Add button on a row triggers
  // `addModule.emit(...)` with the descriptor's `name` field (NOT the
  // `displayLabel`). This is the integration test for the
  // `(click)="onAddModule(module.name)"` template wiring. Subscribing
  // to the output is the canonical way to assert emissions on Angular
  // 21 signal-based outputs (the OutputEmitterRef returned by
  // `output()` exposes `.subscribe(...)` for backward compatibility
  // with EventEmitter consumers — see
  // `apps/client/src/app/dashboard/module-wrapper/module-wrapper.component.spec.ts`
  // for the same pattern on `remove.subscribe(...)`).
  it('should emit the addModule output with the descriptor name when an Add button is clicked', () => {
    fakeRegistry.setDescriptors([PORTFOLIO_DESCRIPTOR, CHAT_DESCRIPTOR]);
    fixture.detectChanges();

    const emitted: string[] = [];
    component.addModule.subscribe((name) => emitted.push(name));

    // Find all Add buttons (one per row); click the second one (chat).
    // The selector targets the `<button mat-icon-button matListItemMeta>`
    // inside each row that the SUT's HTML wires `(click)` on.
    const addButtons = fixture.nativeElement.querySelectorAll(
      '.gf-module-catalog-row button[mat-icon-button]'
    ) as NodeListOf<HTMLButtonElement>;

    expect(addButtons.length).toBe(2);

    addButtons[1].click();

    expect(emitted).toEqual(['chat']);
  });

  // 6.10 — Defensive: invoking `onAddModule(name)` directly emits
  // `addModule` with the supplied name. Guards the public API surface
  // for tests that exercise the method as a unit (independent of the
  // template binding tested in 6.9), and pins the contract so future
  // refactors of `onAddModule(...)` (e.g., adding a telemetry call)
  // cannot regress the emit contract without breaking this test.
  it('should emit addModule with the supplied name when onAddModule(name) is invoked directly', () => {
    fakeRegistry.setDescriptors([PORTFOLIO_DESCRIPTOR]);
    fixture.detectChanges();

    const emitted: string[] = [];
    component.addModule.subscribe((name) => emitted.push(name));

    component.onAddModule('portfolio-overview');

    expect(emitted).toEqual(['portfolio-overview']);
  });

  // 6.11 — Empty-state hint rendered when `filteredModules()` is empty
  // AND `searchTerm()` is non-empty. This covers the `@if
  // (filteredModules().length === 0)` branch in the SUT's HTML
  // template when the registry has entries but the search term
  // matches none of them.
  it('should render the empty-state hint when filteredModules() is empty due to a non-matching search term', () => {
    fakeRegistry.setDescriptors([PORTFOLIO_DESCRIPTOR, CHAT_DESCRIPTOR]);
    fixture.detectChanges();

    component.searchTerm.set('nonexistent-query-string');
    fixture.detectChanges();

    expect(component.filteredModules()).toHaveLength(0);

    const emptyHint = fixture.nativeElement.querySelector(
      '.gf-module-catalog-empty'
    ) as HTMLElement | null;
    expect(emptyHint).toBeTruthy();
    // The hint MUST contain non-empty text content (the
    // i18n-localized "No modules match your search." string).
    expect(emptyHint?.textContent).toBeTruthy();
  });

  // 6.12 — Empty-state hint also rendered when the registry itself is
  // empty (filteredModules() returns []). Covers the same
  // `@if (filteredModules().length === 0)` template branch from a
  // different upstream cause (empty registry vs. non-matching search
  // term). Both upstream causes must produce the same user-facing
  // signal so users on an empty canvas with no registered modules
  // (a transient app-init state) see the hint instead of an empty
  // void.
  it('should render the empty-state hint when the registry is empty', () => {
    fakeRegistry.setDescriptors([]);
    fixture.detectChanges();

    const emptyHint = fixture.nativeElement.querySelector(
      '.gf-module-catalog-empty'
    ) as HTMLElement | null;
    expect(emptyHint).toBeTruthy();
  });

  // 6.13 — Close button click closes the `MatDialogRef`. Asserts the
  // template wiring `(click)="onCloseDialog()"` on the
  // `<mat-dialog-actions> button[mat-button]` element propagates
  // correctly to `dialogRef.close()`. The selector is narrowed to
  // `mat-button` (NOT `mat-icon-button`) because `mat-icon-button`
  // selects the Add buttons in the list rows.
  it('should close the MatDialogRef when the Close button is clicked', () => {
    fakeRegistry.setDescriptors([PORTFOLIO_DESCRIPTOR]);
    fixture.detectChanges();

    expect(mockDialogRef.close).not.toHaveBeenCalled();

    // Find the Close button — the only `mat-button` (NOT
    // `mat-icon-button`) inside the dialog actions row.
    const closeButton = fixture.nativeElement.querySelector(
      'mat-dialog-actions button[mat-button]'
    ) as HTMLButtonElement | null;
    expect(closeButton).toBeTruthy();

    closeButton?.click();

    expect(mockDialogRef.close).toHaveBeenCalledTimes(1);
  });

  // 6.14 — Defensive: invoking `onCloseDialog()` directly closes the
  // `MatDialogRef`. Guards the public API surface for tests that
  // exercise the method as a unit independent of the template binding
  // tested in 6.13, and pins the contract so future refactors of
  // `onCloseDialog(...)` (e.g., emitting a telemetry event before
  // closing) cannot regress the close contract without breaking this
  // test.
  it('should close the MatDialogRef when onCloseDialog() is invoked directly', () => {
    expect(mockDialogRef.close).not.toHaveBeenCalled();

    component.onCloseDialog();

    expect(mockDialogRef.close).toHaveBeenCalledTimes(1);
  });

  // 6.15 — Search input two-way binds the `searchTerm` signal via
  // `[ngModel]="searchTerm()"`. Setting the signal programmatically
  // MUST propagate to the rendered `<input matInput>`'s `value`
  // property. This is the integration test for the two-way binding
  // pattern from `chat-panel.component.html` lines 144–146.
  //
  // **Why `fakeAsync` + `tick()`**: Angular Forms' `NgModel` directive
  // writes the bound value to the DOM input via a microtask
  // (`Promise.resolve().then(writeValue)`), NOT synchronously inside
  // `detectChanges()`. Without `tick()`, the input's `.value` property
  // remains an empty string at the assertion site even though the
  // `[ngModel]` binding fired in the first detectChanges. The
  // `fakeAsync` + `tick()` pattern matches the codebase precedent in
  // `apps/client/src/app/dashboard/services/layout-persistence.service.spec.ts`
  // (lines 284, 327, 367, 407) where microtask-queued behavior is
  // exercised deterministically. The trailing `detectChanges()` flushes
  // any post-microtask change-detection updates so the assertion reads
  // the post-write DOM state.
  it('should reflect the searchTerm signal in the search input value', fakeAsync(() => {
    fakeRegistry.setDescriptors([PORTFOLIO_DESCRIPTOR]);
    fixture.detectChanges();

    // Set the signal programmatically; the first `detectChanges()`
    // queues `NgModel.writeValue(...)` as a microtask.
    component.searchTerm.set('hello');
    fixture.detectChanges();

    // Drain the microtask queue so `NgModel`'s `writeValue(...)` runs
    // and updates the DOM input's `value` property. A subsequent
    // `detectChanges()` propagates any post-microtask state into the
    // rendered template.
    tick();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      'input[matInput]'
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input?.value).toBe('hello');
  }));
});
