import { Component, DestroyRef, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `dashboard-canvas.component.ts` declares
// `$localize`-tagged template literals at module scope (the
// `ADD_MODULE_LABEL`, `COULD_NOT_LOAD_LABEL`, and `DISMISS_LABEL`
// constants), and the companion `dashboard-canvas.component.html`
// template uses `i18n` attributes which the Angular compiler lowers to
// `$localize` tagged template calls. The transitively-imported
// `module-wrapper.component.ts` and `module-catalog.component.ts` also
// declare `$localize`-tagged constants at module scope. Without this
// side-effect import, simply importing the SUT class throws
// `ReferenceError: $localize is not defined` before any test even runs.
// Mirrors the canonical pattern from
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Observable, Subject } from 'rxjs';

import { DashboardModuleDescriptor } from '../interfaces/dashboard-module.interface';
import { LayoutData } from '../interfaces/layout-data.interface';
import { ModuleRegistryService } from '../module-registry.service';
import { DashboardTelemetryService } from '../services/dashboard-telemetry.service';
import { LayoutPersistenceService } from '../services/layout-persistence.service';
import { UserDashboardLayoutService } from '../services/user-dashboard-layout.service';
import { GfDashboardCanvasComponent } from './dashboard-canvas.component';

/**
 * Unit-test spec for {@link GfDashboardCanvasComponent} — the central
 * orchestrator component of the modular dashboard refactor (AAP
 * § 0.6.1.4).
 *
 * **Coverage objectives** (AAP § 0.8.5 — ≥ 80 % line coverage):
 *
 *   - Construction & default state — canvas instantiates with empty
 *     `dashboard()` signal, `isLoading()` true, `hasError()` false.
 *   - Rule 10 (AAP § 0.8.1.10) — auto-open catalog on first visit when
 *     the layout GET emits `null` (HTTP 404 translated to `null` by
 *     {@link UserDashboardLayoutService.get}). This is THE critical
 *     test in this spec because a regression here would silently break
 *     the new-user UX.
 *   - Rule 10 alternative path — auto-open catalog when the layout GET
 *     emits `{ items: [], version: 1 }` (genuinely empty saved layout,
 *     e.g., the user removed every module from the canvas).
 *   - Returning user — saved layout with non-empty `items` hydrates the
 *     `dashboard()` signal; the catalog does NOT auto-open in this
 *     path.
 *   - {@link GfDashboardCanvasComponent.removeItem} reduces the
 *     `dashboard()` count by one (reference-equality filter) and emits
 *     on the canvas's internal grid-state-change Subject (verified
 *     indirectly via the `bind(...)` argument's `changes$` stream).
 *   - {@link GfDashboardCanvasComponent.addModule} happy path — adds an
 *     item to `dashboard()` with `defaultCols`, `defaultRows`,
 *     `minItemCols`, and `minItemRows` projected from the descriptor
 *     (Rule 6 floor enforcement, AAP § 0.8.1.6).
 *   - {@link GfDashboardCanvasComponent.addModule} unknown name — silent
 *     no-op (defensive guard against stale catalog state).
 *   - Hydration with stale `LayoutItem` whose `moduleId` is unregistered
 *     skips that item rather than rendering an empty `<gridster-item>`
 *     slot (defensive — protects against persisted documents
 *     referencing removed module types).
 *   - Error path — non-404 GET error (e.g., 500) sets `hasError()` to
 *     `true`, clears `isLoading()`, and does NOT auto-open the catalog
 *     (the error path does NOT conflate with the empty-layout
 *     auto-open contract).
 *   - GridsterConfig invariants — `minCols === 12`, `maxCols === 12`,
 *     `minItemCols === 2`, `minItemRows === 2`, `fixedRowHeight === 64`.
 *     These pin the grid spec invariants (AAP § 0.6.1, § 0.6.3.3) so
 *     that future inadvertent edits to the `options` literal would
 *     surface as test failures.
 *   - {@link LayoutPersistenceService.bind} is invoked exactly once on
 *     `ngOnInit`, BEFORE the GET resolves, with the canvas's
 *     `gridStateChange$` stream and a layout-selector callback. This
 *     pins Rule 4 wiring (AAP § 0.8.1.4) at the ngOnInit boundary.
 *
 * **Testing pattern** (AAP § 0.6.1.4): the spec uses Angular's
 * `TestBed` with mocked service collaborators provided via `useValue`.
 * The {@link UserDashboardLayoutService} is replaced via `useValue` to
 * control the GET emission (200, 404 → null, error). The
 * {@link LayoutPersistenceService} is replaced with spies so we can
 * verify the `bind(...)` call without exercising the real 500 ms
 * debounce pipeline (covered by the sibling
 * `layout-persistence.service.spec.ts`).
 *
 * **Spying on `openCatalog()`**: the SUT's auto-open-catalog flow
 * (Rule 10) calls `this.matDialog.open(...)` inside `openCatalog()`.
 * Rather than mocking `MatDialog` (which is provided at the component-
 * level by the SUT's `imports: [MatDialogModule]` declaration and
 * therefore takes precedence over TestBed's `useValue` provider for
 * `inject(MatDialog)`), we spy on the SUT's own `openCatalog()` method
 * via `jest.spyOn(component, 'openCatalog').mockImplementation(...)`.
 * This neutralizes the real MatDialog call AND lets us assert
 * `openCatalog` was called from `hydrateFromLayout`. The pattern
 * mirrors how component spec files in this repository typically
 * neutralize side effects of the SUT's own methods (e.g.,
 * spying on `submit()` rather than mocking the form submission's
 * downstream side effects).
 *
 * **The {@link ModuleRegistryService} is the SOLE registry** consulted
 * by the canvas. To control the descriptor surface independent of the
 * production registrations in `dashboard.providers.ts`, we provide a
 * fake registry implementation (`FakeModuleRegistryService`) that
 * exposes the `register`, `getAll`, and `getByName` methods the canvas
 * (and its child directive) consume.
 *
 * **`Gridster` and `GridsterItem` standalone components**: these are
 * imported by the SUT but not directly exercised in unit tests. The
 * SUT declares `schemas: [CUSTOM_ELEMENTS_SCHEMA]`, which permits
 * elements to render as opaque custom elements without fully wiring
 * the gridster engine — sufficient for the behavioral assertions in
 * this spec.
 *
 * **Type strictness**: every test variable is strongly typed
 * (`LayoutData`, `Subject<LayoutData | null>`, `jest.Mock<...>`). No
 * `any` types are used.
 *
 * @see apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.ts —
 *   the System Under Test (SUT).
 * @see apps/client/src/app/dashboard/services/user-dashboard-layout.service.ts —
 *   the (mocked) HTTP wrapper.
 * @see apps/client/src/app/dashboard/services/layout-persistence.service.ts —
 *   the (mocked) debounced persistence orchestrator.
 * @see apps/client/src/app/dashboard/module-registry.service.ts —
 *   the (faked) module-type registry.
 * @see AAP § 0.6.1.4 — Frontend implementation approach.
 * @see AAP § 0.6.3.3 — Performance Targets (Validation Framework).
 * @see AAP § 0.8.1.3 — Rule 3 (Module registry sole add mechanism).
 * @see AAP § 0.8.1.4 — Rule 4 (Persistence triggered ONLY by grid events).
 * @see AAP § 0.8.1.6 — Rule 6 (Modules declare minimum cell dimensions).
 * @see AAP § 0.8.1.10 — Rule 10 (Catalog auto-opens on first visit).
 * @see AAP § 0.8.5 — Testing requirements (≥ 80 % line coverage,
 *   the auto-open-catalog scenario is one of the validation criteria).
 */

/**
 * Inline standalone test stubs for descriptor `component` references.
 * The SUT never instantiates these via `viewContainerRef.createComponent`
 * in the unit-test scope (the host directive's `ngOnInit` only runs
 * when the directive is actually placed in the live DOM and a matching
 * `<gridster-item>` is materialized — under `CUSTOM_ELEMENTS_SCHEMA` the
 * `<gridster-item>` element renders as an opaque custom element). The
 * stubs serve only as `Type<unknown>` references on the descriptor's
 * `component` field — this mirrors the pattern from
 * `module-registry.service.spec.ts`.
 */
@Component({
  selector: 'gf-test-canvas-stub-a',
  standalone: true,
  template: ''
})
class StubModuleAComponent {}

@Component({
  selector: 'gf-test-canvas-stub-b',
  standalone: true,
  template: ''
})
class StubModuleBComponent {}

/**
 * Module-scoped descriptor fixtures used across multiple tests. The
 * fixtures cover two distinct module types so tests can verify that
 * the canvas's behavior is keyed on the descriptor's `name` field
 * (NOT on a hard-coded module identifier — Rule 3 enforcement, AAP
 * § 0.8.1.3).
 *
 * `defaultCols` (6) and `defaultRows` (4) are deliberately distinct
 * from `minCols` (4) and `minRows` (3) so that the
 * {@link GfDashboardCanvasComponent.addModule} test can assert the
 * canvas uses `defaultCols`/`defaultRows` for the new item's
 * dimensions and `minCols`/`minRows` for the per-item gridster
 * floors.
 */
const PORTFOLIO_DESCRIPTOR: DashboardModuleDescriptor = {
  component: StubModuleAComponent as Type<unknown>,
  defaultCols: 6,
  defaultRows: 4,
  displayLabel: 'Portfolio Overview',
  iconName: 'analytics-outline',
  minCols: 4,
  minRows: 3,
  name: 'portfolio-overview'
};

const HOLDINGS_DESCRIPTOR: DashboardModuleDescriptor = {
  component: StubModuleBComponent as Type<unknown>,
  defaultCols: 8,
  defaultRows: 6,
  displayLabel: 'Holdings',
  iconName: 'pie-chart-outline',
  minCols: 4,
  minRows: 4,
  name: 'holdings'
};

/**
 * Fake {@link ModuleRegistryService} replacement used in the test
 * bed. Mirrors the production service's three-method public surface
 * (`register`, `getAll`, `getByName`) and stores descriptors in a
 * `Map` keyed on `name` so that the canvas's `getByName(name)`
 * lookup reflects production semantics.
 *
 * The fake stores descriptors in a `Map` so iteration order is
 * insertion order (matching the production `Map`-based registry).
 * Tests pre-populate the registry via the public `register()` method
 * (or the convenience `registerForTest()` helper that bypasses the
 * production validation rules — useful when stuffing the test
 * fixtures into the registry without re-asserting Rule 6 floors).
 */
class FakeModuleRegistryService {
  private readonly descriptors = new Map<string, DashboardModuleDescriptor>();

  public register(descriptor: DashboardModuleDescriptor): void {
    this.descriptors.set(descriptor.name, descriptor);
  }

  public registerForTest(descriptor: DashboardModuleDescriptor): void {
    this.descriptors.set(descriptor.name, descriptor);
  }

  public getByName(name: string): DashboardModuleDescriptor | undefined {
    return this.descriptors.get(name);
  }

  public getAll(): DashboardModuleDescriptor[] {
    return [...this.descriptors.values()];
  }
}

/**
 * Sample non-empty layout fixture — one portfolio-overview item placed
 * at the canvas origin. Used by hydration tests (returning user) to
 * verify the canvas projects the persisted shape onto the in-memory
 * `GridItem` shape (renaming `moduleId` → `name` and projecting
 * `descriptor.minCols → minItemCols`, `descriptor.minRows → minItemRows`
 * per Rule 6 enforcement at hydration time).
 *
 * Field values satisfy the server-side validation rules documented in
 * AAP § 0.6.1.7 (`version === 1`, `cols >= 2`, `rows >= 2`,
 * `x + cols <= 12`).
 */
const SAMPLE_LAYOUT: LayoutData = {
  items: [
    {
      cols: 6,
      moduleId: 'portfolio-overview',
      rows: 4,
      x: 0,
      y: 0
    }
  ],
  version: 1
};

/**
 * Layout fixture with a stale `moduleId` reference. Used by the
 * "skip unregistered" hydration test to verify the canvas's defensive
 * filter drops items whose `moduleId` does not resolve to a registered
 * descriptor (per the SUT's `flatMap`-based defensive filter at
 * `dashboard-canvas.component.ts:943-963`).
 */
const STALE_LAYOUT: LayoutData = {
  items: [
    {
      cols: 6,
      moduleId: 'unregistered-module',
      rows: 4,
      x: 0,
      y: 0
    },
    {
      cols: 4,
      moduleId: 'portfolio-overview',
      rows: 4,
      x: 6,
      y: 0
    }
  ],
  version: 1
};

/**
 * Structural shape of the binding object the SUT passes to
 * {@link LayoutPersistenceService.bind}. Mirrors the SUT-internal
 * `PersistenceBinding` interface declared in
 * `layout-persistence.service.ts:52` (which is `@internal` and thus
 * not exported). Re-declared here so test assertions on
 * `bindSpy.mock.calls[0][0]` are typed (avoiding `any` propagation
 * from `jest.Mock`'s untyped `mock.calls` field).
 */
interface PersistenceBindingArg {
  changes$: Observable<void>;
  layoutSelector: () => LayoutData;
}

describe('GfDashboardCanvasComponent', () => {
  let component: GfDashboardCanvasComponent;
  let fixture: ComponentFixture<GfDashboardCanvasComponent>;
  let userDashboardLayoutSubject: Subject<LayoutData | null>;
  let layoutGetSpy: jest.Mock<Observable<LayoutData | null>>;
  let bindSpy: jest.Mock<void, [PersistenceBindingArg, DestroyRef]>;
  let unbindSpy: jest.Mock<void>;
  let openCatalogSpy: jest.SpyInstance;
  let fakeRegistry: FakeModuleRegistryService;

  beforeEach(async () => {
    // ---- Mock UserDashboardLayoutService ------------------------------
    // The SUT's `ngOnInit` calls `userDashboardLayoutService.get()` and
    // subscribes to the result. We back the mock with a Subject so each
    // test can deterministically drive the emission (next/error) at the
    // moment that best exercises the behavior under test. A fresh
    // Subject per test prevents emission leakage between tests.
    userDashboardLayoutSubject = new Subject<LayoutData | null>();
    layoutGetSpy = jest.fn(() => userDashboardLayoutSubject.asObservable());

    // ---- Mock LayoutPersistenceService --------------------------------
    // The SUT's `ngOnInit` calls `layoutPersistenceService.bind(...)`
    // exactly once. We replace the production service with spies so
    // tests can verify the `bind` call signature without exercising the
    // real 500 ms debounce + switchMap pipeline (covered by
    // `layout-persistence.service.spec.ts`).
    bindSpy = jest.fn<void, [PersistenceBindingArg, DestroyRef]>();
    unbindSpy = jest.fn<void, []>();

    // ---- Fake ModuleRegistryService -----------------------------------
    // The SUT looks up descriptors via `moduleRegistry.getByName(...)`
    // in `addModule`, `hydrateFromLayout`, and the
    // `GfDashboardModuleHostDirective.ngOnInit`. The fake registry's
    // `getByName(name)` returns the descriptor pre-registered via
    // `registerForTest(...)` or `undefined` for unknown names.
    //
    // The fake is fresh per test to prevent state leakage.
    fakeRegistry = new FakeModuleRegistryService();
    fakeRegistry.registerForTest(PORTFOLIO_DESCRIPTOR);
    fakeRegistry.registerForTest(HOLDINGS_DESCRIPTOR);

    await TestBed.configureTestingModule({
      imports: [GfDashboardCanvasComponent, NoopAnimationsModule],
      providers: [
        {
          provide: UserDashboardLayoutService,
          useValue: { get: layoutGetSpy }
        },
        {
          provide: LayoutPersistenceService,
          useValue: { bind: bindSpy, unbind: unbindSpy }
        },
        {
          provide: ModuleRegistryService,
          useValue: fakeRegistry
        },
        // The real DashboardTelemetryService is used because it has no
        // observable side effects in the test environment (it
        // short-circuits to a no-op when `console.debug` is undefined,
        // which is the default Jest config).
        DashboardTelemetryService
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfDashboardCanvasComponent);
    component = fixture.componentInstance;

    // **Spy on `openCatalog()` BEFORE `detectChanges()`** so the
    // first ngOnInit run does NOT invoke the real MatDialog. The
    // SUT's `imports: [MatDialogModule]` declaration provides the
    // real `MatDialog` at the component-element-injector level —
    // which takes precedence over any TestBed-level `useValue`
    // provider for `inject(MatDialog)`. Spying on the SUT's own
    // method bypasses this resolution conflict entirely and lets
    // us assert the auto-open behavior at the SUT-method
    // granularity rather than at the MatDialog-call granularity.
    //
    // The mock implementation is a synchronous no-op (returns
    // `undefined`), matching the production return type. Tests
    // that need to verify the spy behavior assert call counts via
    // `openCatalogSpy.mock.calls.length` or
    // `expect(openCatalogSpy).toHaveBeenCalled()`.
    openCatalogSpy = jest
      .spyOn(component, 'openCatalog')
      .mockImplementation(() => {
        /* no-op — neutralizes real MatDialog interaction in unit tests */
      });
  });

  afterEach(() => {
    // Mandatory subject cleanup so an unresolved subscription does not
    // leak into the next test. The mocked layout service backs the GET
    // observable with a fresh Subject in every `beforeEach`, but
    // explicit completion in `afterEach` belt-and-suspenders against
    // any test that errored mid-emission.
    userDashboardLayoutSubject.complete();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  // ===========================================================
  // Test 1 — Smoke check: the canvas can be instantiated.
  // ===========================================================
  it('should be created', () => {
    // Trigger the initial `detectChanges` cycle so the gridster
    // standalone component's required `options` input gets its value
    // from the SUT's `[options]="options"` template binding. Without
    // this, gridster v21's `ngOnDestroy` would error on test cleanup
    // (`NG0950: Input "options" is required but no value is available
    // yet`) because the input binding never resolved. The mocked
    // `userDashboardLayoutService.get()` returns a Subject-backed
    // Observable that does NOT emit during this test, so the SUT's
    // `subscribe(...)` callback never fires — `isLoading()` remains
    // `true` (the documented initial state).
    fixture.detectChanges();

    // Smoke test that confirms the SUT instantiates with all the mocked
    // dependencies wired up. Failure here is almost certainly a
    // configuration issue (unresolved import, missing provider) rather
    // than a behavior bug.
    expect(component).toBeTruthy();

    // Initial state assertions — the SUT initializes `dashboard()` to
    // an empty array and `hasError()` to `false`. These are the
    // documented defaults at the SUT's `signal<...>(...)` initializer
    // expressions (`dashboard-canvas.component.ts:430, 441, 451`).
    // `isLoading()` remains `true` because the dormant Subject never
    // emits — verifying the initial loading state simultaneously.
    expect(component.dashboard()).toEqual([]);
    expect(component.isLoading()).toBe(true);
    expect(component.hasError()).toBe(false);
  });

  // ===========================================================
  // Test 2 — `bind(...)` is invoked once during ngOnInit.
  // ===========================================================
  // Pins Rule 4 wiring (AAP § 0.8.1.4): the SUT MUST bind the
  // persistence pipeline at the start of `ngOnInit`, BEFORE the GET
  // resolves. The pipeline must be ready to receive grid state-change
  // events as soon as the user can interact with the canvas (e.g.,
  // adding a module from the catalog).
  it('should bind the persistence pipeline exactly once on ngOnInit', () => {
    // `detectChanges` triggers `ngOnInit` (Angular's default lifecycle
    // execution timing). The SUT calls `layoutPersistenceService.bind`
    // FIRST in `ngOnInit` (before issuing the GET), so the bind must
    // be observable BEFORE the GET subject emits.
    fixture.detectChanges();

    // Exactly one `bind(...)` call — no leakage from re-init or
    // re-construction. The `bindSpy` would record extra calls if the
    // SUT inadvertently re-bound (e.g., on `ngAfterViewInit`).
    expect(bindSpy).toHaveBeenCalledTimes(1);

    // The bind argument is a structural binding object with `changes$`
    // (Observable) and `layoutSelector` (function). We assert the
    // structural shape rather than the exact identity to keep the
    // test robust to future internal refactors of the SUT's
    // `gridStateChange$` subject (e.g., a wrapper that adds telemetry
    // before forwarding).
    const bindArg: PersistenceBindingArg = bindSpy.mock.calls[0][0];
    expect(bindArg.changes$).toBeDefined();
    expect(typeof bindArg.layoutSelector).toBe('function');

    // The second argument is a `DestroyRef` — passed for the
    // `takeUntilDestroyed(destroyRef)` operator at the bottom of the
    // persistence pipeline. We assert truthiness only because
    // Angular's `DestroyRef` has private internal state we cannot
    // peer into structurally.
    expect(bindSpy.mock.calls[0][1]).toBeTruthy();
  });

  // ===========================================================
  // Test 3 — Rule 10: 404 → null path renders blank + auto-opens.
  // ===========================================================
  // This is THE critical test in this spec. Per AAP § 0.8.1.10
  // (Rule 10) the catalog auto-opens on first visit when no saved
  // layout exists for the authenticated user. The mechanism that
  // implements Rule 10 is the SUT's branch on `null` (the layout
  // service translates HTTP 404 to `null` per the contract verified
  // in `user-dashboard-layout.service.spec.ts`).
  it('should auto-open the catalog when the layout GET emits null (Rule 10, first visit)', () => {
    fixture.detectChanges();

    // Drive the layout GET to emit `null` (the 404 → null
    // translation). The SUT's `hydrateFromLayout(null)` MUST set
    // `dashboard()` to `[]` AND call `openCatalog()`.
    userDashboardLayoutSubject.next(null);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    // `dashboard()` is empty — the SUT renders a blank canvas.
    expect(component.dashboard()).toEqual([]);

    // The catalog is auto-opened — we assert the spy on the SUT's
    // own `openCatalog()` method captured the call. The mock
    // implementation is a no-op so the real MatDialog is never
    // touched in this unit test.
    expect(openCatalogSpy).toHaveBeenCalledTimes(1);

    // `isLoading()` is cleared — the GET has resolved (the SUT clears
    // the flag in `hydrateFromLayout` regardless of path).
    expect(component.isLoading()).toBe(false);

    // `hasError()` remains `false` — the 404 → null path is NOT an
    // error condition (it is the documented first-visit signal).
    expect(component.hasError()).toBe(false);
  });

  // ===========================================================
  // Test 4 — Rule 10 alt path: empty items array auto-opens too.
  // ===========================================================
  // The SUT's `hydrateFromLayout` collapses three null/empty paths
  // into a single guard (`!layout?.items?.length`):
  //   - HTTP 404 → null (test 3)
  //   - HTTP 200 with `{ items: [], version: 1 }` (this test)
  //   - HTTP 200 with `{ items: undefined }` (theoretical malformed
  //     payload — server-side DTO validation prevents this, but the
  //     SUT's defensive guard covers it).
  //
  // Test 4 covers the second path: a returning user who removed every
  // module from the canvas would have a saved layout with empty
  // `items`. The catalog must still auto-open.
  it('should auto-open the catalog when the layout GET emits empty items (Rule 10, empty saved layout)', () => {
    fixture.detectChanges();

    // Empty items array — represents the "user removed every module"
    // scenario. `version: 1` MUST be set so the payload validates
    // against the {@link LayoutData} interface.
    userDashboardLayoutSubject.next({ items: [], version: 1 });
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    // Same expectations as test 3 — the empty-items path mirrors the
    // null path's behavior verbatim per the SUT's
    // `!layout?.items?.length` collapse.
    expect(component.dashboard()).toEqual([]);
    expect(openCatalogSpy).toHaveBeenCalledTimes(1);
    expect(component.isLoading()).toBe(false);
    expect(component.hasError()).toBe(false);
  });

  // ===========================================================
  // Test 5 — Returning user: hydrate dashboard from saved layout.
  // ===========================================================
  // Per AAP § 0.6.3.2, a returning user with a non-empty saved layout
  // MUST see the saved layout on init. The catalog MUST NOT auto-open
  // — it remains accessible via the FAB.
  it('should hydrate the dashboard from a non-empty saved layout (returning user)', () => {
    fixture.detectChanges();

    // Drive the GET with the SAMPLE_LAYOUT (one portfolio-overview
    // item). The SUT's `hydrateFromLayout` must project `LayoutItem`
    // → `GridItem` (rename `moduleId` → `name`) and project
    // `descriptor.minCols → minItemCols`, `descriptor.minRows →
    // minItemRows` per Rule 6 enforcement.
    userDashboardLayoutSubject.next(SAMPLE_LAYOUT);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    // The dashboard contains exactly one item — the persisted item
    // hydrated successfully.
    expect(component.dashboard()).toHaveLength(1);

    // The hydrated item carries the persisted coordinates verbatim
    // (`x: 0, y: 0, cols: 6, rows: 4`) and the `name` discriminator
    // matches the persisted `moduleId` ('portfolio-overview').
    const hydrated = component.dashboard()[0];
    expect(hydrated.name).toBe('portfolio-overview');
    expect(hydrated.x).toBe(0);
    expect(hydrated.y).toBe(0);
    expect(hydrated.cols).toBe(6);
    expect(hydrated.rows).toBe(4);

    // Rule 6 (AAP § 0.8.1.6): the per-item gridster floors are
    // populated from the registered descriptor's minimums. The
    // PORTFOLIO_DESCRIPTOR declares `minCols: 4, minRows: 3` — these
    // values are bound to `<gridster-item [minItemCols]>` so the
    // gridster engine rejects user-initiated resize/move operations
    // that would shrink the item below this floor.
    expect(hydrated.minItemCols).toBe(PORTFOLIO_DESCRIPTOR.minCols);
    expect(hydrated.minItemRows).toBe(PORTFOLIO_DESCRIPTOR.minRows);

    // The catalog does NOT auto-open on the returning-user path — the
    // SUT's hydration code branches on the empty / non-empty
    // distinction, and the non-empty branch does NOT call
    // `openCatalog()`.
    expect(openCatalogSpy).not.toHaveBeenCalled();

    // `isLoading()` is cleared regardless of path.
    expect(component.isLoading()).toBe(false);
    expect(component.hasError()).toBe(false);
  });

  // ===========================================================
  // Test 6 — Hydration drops items with unregistered moduleId.
  // ===========================================================
  // Defensive: a saved layout might reference a moduleId that is no
  // longer registered (e.g., the user installed v1 of the dashboard,
  // saved a layout containing a 'beta-feature' module, then upgraded
  // to v2 of the dashboard which no longer registers that module).
  // The SUT's `flatMap`-based filter at
  // `dashboard-canvas.component.ts:943-963` drops such items rather
  // than rendering an empty `<gridster-item>` slot.
  it('should drop layout items whose moduleId is not registered (defensive filter)', () => {
    fixture.detectChanges();

    // STALE_LAYOUT contains TWO items — one with the unregistered
    // 'unregistered-module' moduleId, one with the registered
    // 'portfolio-overview'. The SUT's filter drops the unregistered
    // item; the registered item survives.
    userDashboardLayoutSubject.next(STALE_LAYOUT);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    // Exactly one item remains — the unregistered one was dropped.
    expect(component.dashboard()).toHaveLength(1);

    // The surviving item is the portfolio-overview one. The
    // unregistered moduleId has been silently filtered out.
    expect(component.dashboard()[0].name).toBe('portfolio-overview');

    // The catalog does NOT auto-open even though one item was
    // filtered — the surviving item makes `dashboard()` non-empty,
    // and the SUT's auto-open guard is on `dashboard()`, not on the
    // raw layout's item count.
    expect(openCatalogSpy).not.toHaveBeenCalled();
  });

  // ===========================================================
  // Test 7 — `addModule(name)` happy path (registered name).
  // ===========================================================
  it('should add a registered module to the dashboard with descriptor defaults and per-item floors', () => {
    fixture.detectChanges();

    // Drive the GET to emit `null` so `hydrateFromLayout(null)` runs
    // with empty dashboard. The SUT's `addModule` doesn't depend on
    // the GET having resolved, but it does depend on the registry
    // having entries — which we set up in `beforeEach`.
    userDashboardLayoutSubject.next(null);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    // Reset the openCatalog spy — the auto-open from the null path
    // would otherwise count as one of the spy's recorded calls. Tests
    // for `addModule` itself should be agnostic to whether the catalog
    // auto-opened beforehand.
    openCatalogSpy.mockClear();

    // Programmatically call `addModule('portfolio-overview')` with a
    // registered name. The SUT resolves the descriptor, projects the
    // `defaultCols` (6), `defaultRows` (4), `minCols` (4) →
    // `minItemCols`, `minRows` (3) → `minItemRows`, and adds the new
    // item to `dashboard()` at `x: 0, y: 0` (next available row).
    component.addModule('portfolio-overview');
    fixture.detectChanges();

    // Exactly one item added.
    expect(component.dashboard()).toHaveLength(1);

    // Assert all six fields are populated correctly. `defaultCols`
    // (6) and `defaultRows` (4) drive the new item's dimensions;
    // `minCols` (4) → `minItemCols`, `minRows` (3) → `minItemRows`
    // drive the per-item gridster floors (Rule 6, AAP § 0.8.1.6);
    // `x: 0, y: 0` is the canvas's "next available row" (`y === 0`
    // because no other items exist).
    const added = component.dashboard()[0];
    expect(added.name).toBe('portfolio-overview');
    expect(added.cols).toBe(PORTFOLIO_DESCRIPTOR.defaultCols);
    expect(added.rows).toBe(PORTFOLIO_DESCRIPTOR.defaultRows);
    expect(added.minItemCols).toBe(PORTFOLIO_DESCRIPTOR.minCols);
    expect(added.minItemRows).toBe(PORTFOLIO_DESCRIPTOR.minRows);
    expect(added.x).toBe(0);
    expect(added.y).toBe(0);
  });

  // ===========================================================
  // Test 8 — `addModule(name)` defensive: unknown name no-ops.
  // ===========================================================
  // The catalog emits names sourced from the SAME registry that the
  // canvas consults, so this path is unreachable in practice. But
  // the SUT's defensive guard at
  // `dashboard-canvas.component.ts:830-839` covers stale test
  // fixtures, hypothetical deep-links, and future "deep-link to add
  // module by URL" features.
  it('should silently no-op when addModule is called with an unregistered name', () => {
    fixture.detectChanges();
    userDashboardLayoutSubject.next(null);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();
    openCatalogSpy.mockClear();

    // Snapshot the dashboard count BEFORE the call so we can assert
    // it is unchanged AFTER.
    const beforeCount = component.dashboard().length;

    // Call with a name not registered in the fake registry.
    component.addModule('unregistered-name');
    fixture.detectChanges();

    // Dashboard count is unchanged — the SUT's defensive guard
    // returns early before reaching the `dashboard.update(...)` call.
    expect(component.dashboard().length).toBe(beforeCount);
  });

  // ===========================================================
  // Test 9 — `removeItem(item)` reduces dashboard count.
  // ===========================================================
  it('should remove the specified item from the dashboard via reference equality', () => {
    fixture.detectChanges();

    // Hydrate with SAMPLE_LAYOUT so the canvas has a known item to
    // remove.
    userDashboardLayoutSubject.next(SAMPLE_LAYOUT);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    expect(component.dashboard()).toHaveLength(1);

    // Capture the item reference. The SUT's `removeItem(item)` filter
    // uses reference equality (`existing !== item`), so the item we
    // pass MUST be the EXACT reference held in the dashboard array.
    const itemToRemove = component.dashboard()[0];

    component.removeItem(itemToRemove);
    fixture.detectChanges();

    // Dashboard is now empty — the item was filtered out.
    expect(component.dashboard()).toHaveLength(0);
  });

  // ===========================================================
  // Test 10 — Error path: non-404 errors set hasError + clear loading.
  // ===========================================================
  // The SUT's `catchError` handler at
  // `dashboard-canvas.component.ts:717-724` translates any error
  // (the layout service propagates 401, 403, 5xx, network failures
  // through unchanged — the 404 → null translation is the layout
  // service's responsibility, NOT this layer) into:
  //   1. `hasError()` set to `true`.
  //   2. `isLoading()` set to `false` (the GET is no longer in flight).
  //   3. A snackbar opened with the error message (NOT verified here
  //      because MatSnackBar is provided at the component-element-
  //      injector level by the SUT's `imports: [MatSnackBarModule]`
  //      declaration, which takes precedence over any TestBed
  //      `useValue` provider — the snackbar emission is a side effect
  //      verified at the e2e/integration scope).
  //   4. A fallback `null` emission so the subscribe block runs once
  //      (but its `if (this.hasError())` guard prevents
  //      `hydrateFromLayout` from running on the error path).
  //
  // Critically, the catalog MUST NOT auto-open on the error path —
  // the auto-open contract (Rule 10) is for the empty-layout
  // (first-visit OR genuinely empty) condition, NOT for transient
  // failures.
  it('should set hasError on non-404 layout GET error and avoid auto-opening the catalog', () => {
    fixture.detectChanges();

    // Drive the layout GET to error (e.g., a 500 propagated by the
    // layout service). The error reaches the SUT's `catchError`
    // handler before reaching the subscribe block.
    userDashboardLayoutSubject.error(
      new Error('Simulated 500 from /api/v1/user/layout')
    );
    fixture.detectChanges();

    // `hasError()` is set — the template can render the
    // `.gf-canvas-error` banner.
    expect(component.hasError()).toBe(true);

    // `isLoading()` is cleared — the progress bar disappears.
    expect(component.isLoading()).toBe(false);

    // The catalog does NOT auto-open on the error path — the SUT's
    // subscribe block guards `hydrateFromLayout` with
    // `if (this.hasError()) return;`.
    expect(openCatalogSpy).not.toHaveBeenCalled();

    // `dashboard()` remains empty — `hydrateFromLayout` did NOT run
    // on the error path.
    expect(component.dashboard()).toEqual([]);
  });

  // ===========================================================
  // Test 11 — GridsterConfig invariants pin the spec.
  // ===========================================================
  // AAP § 0.6.1 ("12 columns, fixed row height (constant px),
  // minimum module size 2×2 cells") and AAP § 0.6.3.3 are realized
  // by the SUT's `options: GridsterConfig` literal at
  // `dashboard-canvas.component.ts:517-546`. This test pins the
  // critical invariants so future inadvertent edits to the literal
  // surface as test failures.
  //
  // We assert ONLY the spec-mandated properties (12-col, 64-px,
  // 2 × 2 floor, drag-handle class, callbacks). The full
  // configuration includes additional properties (margin, pushItems,
  // swap, displayGrid, outerMargin*) whose values are sensible
  // defaults and not directly mandated by the AAP — leaving them
  // out of this test keeps it robust to future tuning.
  it('should configure the gridster engine with the AAP-mandated invariants', () => {
    fixture.detectChanges();

    // 12-column lock: `minCols === 12`, `maxCols === 12`. Realizes
    // AAP § 0.6.1's "12 columns" requirement.
    expect(component.options.minCols).toBe(12);
    expect(component.options.maxCols).toBe(12);

    // 2 × 2 minimum item size (Rule 6 floor, AAP § 0.8.1.6). Per-item
    // overrides via `<gridster-item [minItemCols]="...">` raise the
    // floor for individual modules; this is the GLOBAL floor.
    expect(component.options.minItemCols).toBe(2);
    expect(component.options.minItemRows).toBe(2);

    // Fixed row height (constant px) realizes AAP § 0.6.1's "fixed
    // row height (constant px)" requirement. The 64 px value is
    // documented at AAP § 0.5.3.2.
    expect(component.options.fixedRowHeight).toBe(64);

    // Drag handle class — wires the gridster engine to the wrapper's
    // `.gf-module-drag-handle` button (per
    // `module-wrapper.component.html:4`). Without this, drag would
    // initiate from anywhere on the wrapper — including form fields
    // and buttons inside the module body — which would be a UX bug.
    expect(component.options.draggable?.dragHandleClass).toBe(
      'gf-module-drag-handle'
    );

    // Callbacks for drag-stop (`itemChangeCallback`) and resize-stop
    // (`itemResizeCallback`). The SUT wires these to its internal
    // `onItemChange` / `onItemResize` private methods, which feed
    // the persistence pipeline. We assert the callback identity is
    // a function rather than the exact private method reference
    // (the SUT could refactor the methods without breaking the
    // contract).
    expect(typeof component.options.itemChangeCallback).toBe('function');
    expect(typeof component.options.itemResizeCallback).toBe('function');
  });

  // ===========================================================
  // Test 12 — Rule 4: addModule and removeItem feed gridStateChange$
  // (verified by observing the bind() argument).
  // ===========================================================
  // Per Rule 4 (AAP § 0.8.1.4), grid state changes (drag, resize,
  // add, remove) are the ONLY triggers for persistence. The SUT
  // routes all four through a private `gridStateChange$` Subject;
  // the persistence service binds to that stream and debounces.
  //
  // We cannot directly inspect the private Subject, but we CAN
  // observe it via the `bindSpy.mock.calls[0][0].changes$` argument
  // captured in test 2. Subscribing to that stream lets us count
  // emissions triggered by `addModule` and `removeItem` calls.
  it('should emit on gridStateChange$ for addModule and removeItem (Rule 4)', () => {
    fixture.detectChanges();
    userDashboardLayoutSubject.next(null);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    // Capture the changes$ observable from the `bind(...)` call.
    const bindArg: PersistenceBindingArg = bindSpy.mock.calls[0][0];

    let emissionCount = 0;
    const subscription = bindArg.changes$.subscribe(() => {
      emissionCount += 1;
    });

    // Initial emission count is zero — `bind(...)` does NOT emit
    // synchronously (its job is to subscribe to the stream and feed
    // it through the debounce pipeline, NOT to emit on its own).
    expect(emissionCount).toBe(0);

    // `addModule` emits once.
    component.addModule('portfolio-overview');
    expect(emissionCount).toBe(1);

    // `removeItem` emits once. We pass the actual item reference
    // from `dashboard()` so the reference-equality filter matches.
    const item = component.dashboard()[0];
    component.removeItem(item);
    expect(emissionCount).toBe(2);

    subscription.unsubscribe();
  });

  // ===========================================================
  // Test 13 — Layout selector returns canonical {version, items} shape.
  // ===========================================================
  // The persistence service invokes `binding.layoutSelector()`
  // INSIDE its `switchMap` callback (i.e., after the 500 ms
  // debounce), capturing the canvas's final state. The SUT's
  // `serializeLayout()` method projects the in-memory `dashboard()`
  // array onto the {@link LayoutData} wire shape: `{ version: 1,
  // items: LayoutItem[] }`. The discriminator is renamed `name` →
  // `moduleId` so the wire shape matches the API DTO field naming.
  //
  // We exercise the layout selector via the `bind(...)` argument
  // captured in test 2, then add a module and assert the selector's
  // return value reflects the new state.
  it('should serialize the dashboard to the canonical LayoutData wire shape via the bound layout selector', () => {
    fixture.detectChanges();
    userDashboardLayoutSubject.next(null);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();

    const bindArg: PersistenceBindingArg = bindSpy.mock.calls[0][0];
    const layoutSelector = bindArg.layoutSelector;

    // Initial state — empty dashboard, empty items, version 1.
    const initial = layoutSelector();
    expect(initial.version).toBe(1);
    expect(initial.items).toEqual([]);

    // Add a module and verify the selector reflects the addition.
    component.addModule('portfolio-overview');
    const afterAdd = layoutSelector();

    expect(afterAdd.version).toBe(1);
    expect(afterAdd.items).toHaveLength(1);

    // The serialized item carries the canonical wire shape:
    // `moduleId` (renamed from in-memory `name`), `cols`, `rows`,
    // `x`, `y`. The serialized shape has NO `minItemCols` /
    // `minItemRows` fields — those are gridster's per-item floor
    // hints, NOT part of the persisted contract (they are
    // re-derived at hydration time from `descriptor.minCols` /
    // `descriptor.minRows`).
    const item = afterAdd.items[0];
    expect(item.moduleId).toBe('portfolio-overview');
    expect(item.cols).toBe(PORTFOLIO_DESCRIPTOR.defaultCols);
    expect(item.rows).toBe(PORTFOLIO_DESCRIPTOR.defaultRows);
    expect(item.x).toBe(0);
    expect(item.y).toBe(0);
  });

  // ===========================================================
  // Test 14 — `addModule` places successive items at next available y.
  // ===========================================================
  // The SUT's `computeNextAvailableY()` returns the maximum
  // `y + rows` across all existing items — the row immediately
  // below the bottom-most item. Adding three items in sequence
  // should produce y values that stack: first at y=0, second at
  // y=4 (below the first 6×4 item), third at y=10 (below the
  // second 8×6 item — HOLDINGS_DESCRIPTOR has defaultRows=6).
  // Note: gridster's `pushItems: true` setting handles fine-grained
  // collision resolution if the heuristic picks an overlapping cell,
  // but the in-memory `dashboard()` reflects the canvas-computed
  // initial coordinates.
  it('should place successive added modules at the next available row (computeNextAvailableY)', () => {
    fixture.detectChanges();
    userDashboardLayoutSubject.next(null);
    userDashboardLayoutSubject.complete();
    fixture.detectChanges();
    openCatalogSpy.mockClear();

    // First item — empty dashboard, y=0.
    component.addModule('portfolio-overview');
    fixture.detectChanges();

    expect(component.dashboard()).toHaveLength(1);
    expect(component.dashboard()[0].y).toBe(0);

    // Second item — placed BELOW the first
    // (y === 0 + 4 === 4; PORTFOLIO_DESCRIPTOR has defaultRows=4).
    component.addModule('holdings');
    fixture.detectChanges();

    expect(component.dashboard()).toHaveLength(2);
    expect(component.dashboard()[1].y).toBe(4);

    // Third item — placed below the second
    // (y === 4 + 6 === 10; HOLDINGS_DESCRIPTOR has defaultRows=6).
    component.addModule('portfolio-overview');
    fixture.detectChanges();

    expect(component.dashboard()).toHaveLength(3);
    expect(component.dashboard()[2].y).toBe(10);
  });
});
