// Local imports of the (mocked) DataService and UserService DI tokens.
// These imports MUST appear AFTER the `jest.mock(...)` registrations
// above so that the test bed wires the same DI tokens that the SUT
// resolves via its own constructor injection. The `@ghostfolio/ui/services`
// barrel re-exports `DataService`; importing it here gives the test
// bed a stable DI token to bind the mock implementation to via
// `useValue: mockDataService`.
//
// NOTE: `@ghostfolio/ui/services` is the actual location of `DataService`
// in this codebase (NOT `@ghostfolio/client/services/data.service` as
// the AAP's example imports suggest). The transactions-module spec uses
// the same `@ghostfolio/ui/services` path; mirroring it here keeps DI
// token identity consistent across all dashboard-module specs.
//
// `DataService` is NOT mocked at the module path because its barrel
// (`libs/ui/src/lib/services/data.service.ts`) imports only typed
// interfaces and `HttpClient`/`HttpParams`, which are safely parseable
// by the existing Jest transform pipeline.
import { DataService } from '@ghostfolio/ui/services';

import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `analysis-module.component.ts` declares a
// `$localize`-tagged template literal at module scope (the
// `ANALYSIS_TITLE` constant referenced by the
// `ANALYSIS_MODULE_DESCRIPTOR.displayLabel`). Without this side-effect
// import, simply importing the SUT class throws
// `ReferenceError: $localize is not defined` before any test even
// runs. Mirrors the canonical pattern from
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject, of } from 'rxjs';

import { UserService } from '../../../services/user/user.service';
import {
  ANALYSIS_MODULE_DESCRIPTOR,
  GfAnalysisModuleComponent
} from './analysis-module.component';

// Mock the benchmark-comparator component module BEFORE any imports
// are evaluated. This short-circuits the transitive ESM import chain
//   GfBenchmarkComparatorComponent
//     -> Chart.js (LinearScale, LineController, etc.)
//     -> @ionic/angular/standalone (IonIcon)
//        -> @ionic/core (publishes plain ESM `.js` files)
//     -> @ghostfolio/ui/premium-indicator
//     -> @ghostfolio/ui/chart (registerChartConfiguration)
//     -> ngx-skeleton-loader
// which Jest cannot parse under the project's existing
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (transformIgnorePatterns lives in `apps/client/jest.config.ts`,
// which is out of scope for this strictly-additive PR per AAP § 0.7.3).
//
// The replacement exports a bare `GfBenchmarkComparatorComponent`
// class symbol that serves only as an Angular component-import token
// at module load time — the actual DOM presence the SUT needs is
// provided by the `MockBenchmarkComparatorComponent` declared below,
// which carries the matching `gf-benchmark-comparator` selector and
// is injected into the SUT's standalone `imports` array via
// `TestBed.overrideComponent(...)`.
//
// `jest.mock()` calls are hoisted by jest-preset-angular's TS
// transformer above all import statements, so this mock applies to
// both the spec's potential indirect imports AND the SUT's direct
// import (the SUT imports
// `@ghostfolio/client/components/benchmark-comparator/benchmark-comparator.component`,
// which resolves to the same on-disk file as this relative path via
// the `tsconfig.base.json` path alias `@ghostfolio/client/* ->
// apps/client/src/app/*`). Jest tracks mocks by the resolved module
// path, so a single `jest.mock(...)` registration intercepts both
// imports.
//
// Mirrors the canonical pattern at
// `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.spec.ts:80-82`.
jest.mock(
  '../../../components/benchmark-comparator/benchmark-comparator.component',
  () => ({
    GfBenchmarkComparatorComponent: class GfBenchmarkComparatorComponentMock {}
  })
);

// Mock the investment-chart component module BEFORE any imports are
// evaluated. This short-circuits the transitive ESM import chain
//   GfInvestmentChartComponent
//     -> Chart.js (BarController, LinearScale, etc.)
//     -> @ghostfolio/common/chart-helper (transformTickToAbbreviation, etc.)
//     -> @ghostfolio/ui/chart (registerChartConfiguration)
// which can be parsed but is unnecessarily heavy for a unit test.
// Mocking via the same canonical pattern keeps the wrapper spec fast
// and isolated.
jest.mock(
  '../../../components/investment-chart/investment-chart.component',
  () => ({
    GfInvestmentChartComponent: class GfInvestmentChartComponentMock {}
  })
);

// Mock the @ghostfolio/ui/value barrel module BEFORE any imports are
// evaluated. This short-circuits the transitive ESM import chain
//   GfValueComponent
//     -> @ionic/angular/standalone (IonIcon)
//        -> @ionic/core (publishes plain ESM `.js` files)
//     -> @angular/cdk/clipboard (Clipboard)
//     -> @angular/material/snack-bar (MatSnackBar)
//     -> @angular/material/button (MatButtonModule)
//     -> ngx-skeleton-loader (NgxSkeletonLoaderModule)
//     -> ionicons (addIcons, copyOutline)
//     -> ms (millisecond formatting)
//     -> lodash (isNumber)
// which Jest cannot parse under the project's existing
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule.
//
// The replacement exports a bare `GfValueComponent` class symbol that
// serves only as an Angular component-import token at module load
// time — the actual DOM presence the SUT needs is provided by the
// `MockValueComponent` declared below, which carries the matching
// `gf-value` selector and is injected into the SUT's standalone
// `imports` array via `TestBed.overrideComponent(...)`.
jest.mock('@ghostfolio/ui/value', () => ({
  GfValueComponent: class GfValueComponentMock {}
}));

// Mock the UserService module BEFORE any imports are evaluated. This
// short-circuits the transitive ESM import chain
//   UserService
//     -> GfSubscriptionInterstitialDialogComponent
//       -> @ghostfolio/ui/membership-card (GfMembershipCardComponent)
//         -> @ionic/angular/standalone
//           -> @ionic/core (publishes plain ESM `.js` files)
// which Jest cannot parse under the project's existing
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (transformIgnorePatterns lives in `apps/client/jest.config.ts`,
// which is out of scope for this strictly-additive PR per AAP § 0.7.3).
//
// The replacement exports a bare `UserService` class symbol that serves
// only as a DI token — the actual runtime behavior (the `stateChanged`
// Observable) is supplied through `useValue: mockUserService` in
// `TestBed.providers` below. `jest.mock()` calls are hoisted by
// jest-preset-angular's TS transformer above all import statements, so
// this mock applies to both the spec's own import of `UserService` AND
// the transitive SUT import (the SUT imports
// `@ghostfolio/client/services/user/user.service`, which resolves to
// the same on-disk file as this relative path via the
// `tsconfig.base.json` path alias `@ghostfolio/client/* ->
// apps/client/src/app/*`). Jest tracks mocks by the resolved module
// path, so a single `jest.mock(...)` registration intercepts both
// imports and keeps their DI-token identity in sync.
//
// Mirrors the canonical pattern at
// `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.spec.ts:54-56`.
jest.mock('../../../services/user/user.service', () => ({
  UserService: class UserServiceMock {}
}));

/**
 * Inline test stub for {@link GfValueComponent}. The real component
 * (from `@ghostfolio/ui/value`) drags in a deep dependency graph
 * (Clipboard from `@angular/cdk/clipboard`, MatSnackBar from
 * `@angular/material/snack-bar`, IonIcon, ionicons, NgxSkeletonLoader,
 * lodash, and ms) which is brittle and slow inside a unit-test
 * sandbox. The stub:
 *
 * 1. Carries the real component's `gf-value` selector so the SUT's
 *    template binding (`<gf-value [value]="..." />` inside the three
 *    `<mat-card>` cards) resolves to this stub when the SUT's
 *    standalone `imports` array is overridden via
 *    `TestBed.overrideComponent(...)` below.
 * 2. Declares `@Input()` decorators ONLY for the inputs the SUT's
 *    template actively binds (verified against
 *    `analysis-module.component.html` lines 11-19, 27-37, 44-53):
 *    `colorizeSign`, `isCurrency`, `isPercent`, `locale`, `precision`,
 *    `size`, `unit`, `value`. Adding spurious inputs would reflect a
 *    misunderstanding of the real component's contract and risks
 *    silent drift from the production binding surface.
 *
 * The component is declared `standalone: true` (matches the real
 * component) with an empty template so it occupies the `gf-value`
 * selector slot without rendering anything.
 *
 * Per the AAP folder spec: deep behavioral testing of `GfValueComponent`
 * is OUT OF SCOPE here — its behaviors are covered by its own
 * dedicated spec under `libs/ui/src/lib/value/`. This spec focuses
 * exclusively on the wrapper contract: the bare presentation primitives
 * are rendered as the wrapper's only content (the canvas's outer
 * `<gf-module-wrapper>` provides the chrome) and the data-fetching
 * pipeline is correctly wired through `DataService` and `UserService`.
 */
@Component({
  selector: 'gf-value',
  standalone: true,
  template: ''
})
class MockValueComponent {
  @Input() public colorizeSign = false;
  @Input() public isCurrency = false;
  @Input() public isPercent = false;
  @Input() public locale?: string;
  @Input() public precision?: number;
  @Input() public size?: string;
  @Input() public unit?: string;
  @Input() public value: unknown;
}

/**
 * Inline test stub for {@link GfBenchmarkComparatorComponent}. The
 * real component (from
 * `@ghostfolio/client/components/benchmark-comparator/benchmark-comparator.component`)
 * drags in Chart.js, IonIcon, the premium-indicator UI library, the
 * chart-helper utilities, and FormsModule/ReactiveFormsModule — all
 * unnecessary for the wrapper spec contract. The stub:
 *
 * 1. Carries the real component's `gf-benchmark-comparator` selector
 *    so the SUT's template binding (`<gf-benchmark-comparator [...] />`)
 *    resolves to this stub when the SUT's standalone `imports` array
 *    is overridden via `TestBed.overrideComponent(...)` below.
 * 2. Declares `@Input()` decorators ONLY for the inputs the SUT's
 *    template actively binds (verified against
 *    `analysis-module.component.html` lines 62-73): `benchmark`,
 *    `benchmarkDataItems`, `benchmarks`, `colorScheme`, `isLoading`,
 *    `locale`, `performanceDataItems`, `user`. Note that the SUT
 *    additionally binds `(benchmarkChanged)` as an output, but
 *    outputs do not need to be declared on the stub for template
 *    compilation to succeed (Angular only validates input bindings
 *    against the declared `@Input()` properties).
 *
 * The component is declared `standalone: true` (matches the real
 * component) with an empty template so it occupies the
 * `gf-benchmark-comparator` selector slot without rendering anything.
 */
@Component({
  selector: 'gf-benchmark-comparator',
  standalone: true,
  template: ''
})
class MockBenchmarkComparatorComponent {
  @Input() public benchmark: unknown;
  @Input() public benchmarkDataItems: unknown[] = [];
  @Input() public benchmarks: unknown[] = [];
  @Input() public colorScheme: unknown;
  @Input() public isLoading = false;
  @Input() public locale?: string;
  @Input() public performanceDataItems: unknown[] = [];
  @Input() public user: unknown;
}

/**
 * Inline test stub for {@link GfInvestmentChartComponent}. The real
 * component (from
 * `@ghostfolio/client/components/investment-chart/investment-chart.component`)
 * drags in Chart.js (BarController, LinearScale, etc.) and the
 * chart-helper utilities — heavy and unnecessary for the wrapper spec
 * contract. The stub:
 *
 * 1. Carries the real component's `gf-investment-chart` selector so
 *    the SUT's template binding (`<gf-investment-chart [...] />`)
 *    resolves to this stub when the SUT's standalone `imports` array
 *    is overridden via `TestBed.overrideComponent(...)` below.
 * 2. Declares `@Input()` decorators ONLY for the inputs the SUT's
 *    template actively binds (verified against
 *    `analysis-module.component.html` lines 87-97): `benchmarkDataItems`,
 *    `benchmarkDataLabel`, `currency`, `historicalDataItems`,
 *    `isInPercentage`, `isLoading`, `locale`.
 *
 * The component is declared `standalone: true` (matches the real
 * component) with an empty template so it occupies the
 * `gf-investment-chart` selector slot without rendering anything.
 */
@Component({
  selector: 'gf-investment-chart',
  standalone: true,
  template: ''
})
class MockInvestmentChartComponent {
  @Input() public benchmarkDataItems: unknown[] = [];
  @Input() public benchmarkDataLabel?: string;
  @Input() public currency?: string;
  @Input() public historicalDataItems: unknown[] = [];
  @Input() public isInPercentage = false;
  @Input() public isLoading = false;
  @Input() public locale?: string;
}

/**
 * Builds a minimal mock {@link DataService} for each test. The default
 * behaviour is to synchronously emit minimal `PortfolioPerformanceResponse`
 * (chart=[], firstOrderDate=undefined, performance=zeroes) and an empty
 * benchmark response (`{ marketData: [] }`). Synchronous emission via
 * `of(...)` ensures the SUT's `subscribe(...)` callbacks fire inside
 * the same `detectChanges()` call that triggered `ngOnInit`, so no
 * `fakeAsync` / `tick` is required.
 *
 * `fetchInfo()` returns synchronously with an empty `benchmarks` list,
 * matching the SUT's synchronous call pattern (the singleton-cached
 * info payload that was fetched once at app bootstrap; no HTTP call
 * is made here in the production code).
 *
 * All return types use `as never` to bypass the strict generic typings
 * of the real `DataService` methods (which carry complex
 * `PortfolioPerformanceResponse`/`BenchmarkResponse` shapes that the
 * test only needs to satisfy at the field-level the SUT consumes).
 *
 * Each test gets its own mock instance (via the `beforeEach`
 * invocation) so call counts and `mockReturnValue` overrides do not
 * leak between tests.
 */
function createMockDataService() {
  return {
    fetchBenchmarkForUser: jest.fn(() => of({ marketData: [] } as never)),
    fetchInfo: jest.fn(() => ({ benchmarks: [] }) as never),
    fetchPortfolioPerformance: jest.fn(() =>
      of({
        chart: [],
        firstOrderDate: undefined,
        performance: {
          currentValueInBaseCurrency: 0,
          netPerformance: 0,
          netPerformancePercentage: 0,
          netPerformancePercentageWithCurrencyEffect: 0,
          netPerformanceWithCurrencyEffect: 0,
          totalInvestment: 0,
          totalInvestmentValueWithCurrencyEffect: 0
        }
      } as never)
    ),
    putUserSetting: jest.fn(() => of(undefined as never))
  };
}

/**
 * Builds a fresh mock {@link UserService} backed by a {@link BehaviorSubject}
 * for each test. The real service extends `ObservableStore<UserStoreState>`
 * with a much richer surface (`getState`, `setState`, lifecycle hooks,
 * the `stateChanged` Observable, plus many imperative methods). The
 * SUT consumes only `userService.stateChanged` via
 * `.pipe(takeUntilDestroyed(...)).subscribe(...)` and `userService.get(true)`
 * (called from `onChangeBenchmark`), so this minimal mock returns:
 *
 * 1. A `stateChanged` BehaviorSubject — initial value `null` so
 *    ngOnInit subscribes without firing the early-return branch
 *    (`if (!state?.user) { return; }`); individual tests then call
 *    `userStateChanged$.next({ user: {...} })` to drive the
 *    user-state-resolution path and trigger `update()` which fetches
 *    portfolio performance.
 * 2. A `get()` mock returning a synchronous Observable of an empty
 *    object (only used when `onChangeBenchmark` runs, which is not
 *    exercised by the required test cases — included for defensive
 *    coverage).
 *
 * The `BehaviorSubject` is exposed at the test scope so individual
 * test cases can publish a user via
 * `userStateChanged$.next({ user: { settings: {...} } })` and trigger
 * the subscription flow.
 */
function createMockUserService(
  userStateChanged$: BehaviorSubject<{ user: unknown } | null>
) {
  return {
    get: jest.fn(() => of({} as never)),
    stateChanged: userStateChanged$
  };
}

describe('GfAnalysisModuleComponent', () => {
  let component: GfAnalysisModuleComponent;
  let fixture: ComponentFixture<GfAnalysisModuleComponent>;
  let mockDataService: ReturnType<typeof createMockDataService>;
  let userStateChanged$: BehaviorSubject<{ user: unknown } | null>;

  beforeEach(async () => {
    userStateChanged$ = new BehaviorSubject<{ user: unknown } | null>(null);
    mockDataService = createMockDataService();
    const mockUserService = createMockUserService(userStateChanged$);

    await TestBed.configureTestingModule({
      imports: [GfAnalysisModuleComponent, NoopAnimationsModule],
      providers: [
        { provide: DataService, useValue: mockDataService },
        { provide: UserService, useValue: mockUserService }
      ]
    })
      .overrideComponent(GfAnalysisModuleComponent, {
        set: {
          imports: [
            MockBenchmarkComparatorComponent,
            MockInvestmentChartComponent,
            MockValueComponent
          ]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfAnalysisModuleComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Phase 5.1 — Component is created.
  // Smoke test that confirms the SUT instantiates with the mocked
  // dependency injection chain (DataService, UserService) and the
  // overridden imports list (the three Mock components). A failure
  // here is almost certainly a configuration issue (missing provider,
  // unresolved import, $localize not initialized) rather than a
  // behaviour bug.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // Phase 5.2 — Public class surface (defensive coverage of static
  // configuration). Asserts that `component.precision` exposes the
  // expected literal value (`2`) without requiring `detectChanges()`
  // to render the template. The `precision` field is bound via
  // `[precision]="precision"` on the first two `gf-value` cards
  // (Total amount, Change with currency effect); a regression in
  // this field would mean number formatting drifted out of spec.
  it('should expose precision as 2', () => {
    expect(component.precision).toBe(2);
  });

  // Phase 5.3 — Analysis content remains hidden until performance
  // data loads. Validates the `@if (performance() && user())` guard
  // in `analysis-module.component.html` line 1: no analysis
  // presentation primitives are rendered before both signals are
  // truthy. The default test bed initializes `userStateChanged$` to
  // `null`, so ngOnInit's early-return branch fires
  // (`if (!state?.user) { return; }`) and neither `user.set()` nor
  // `update()` is invoked — leaving `performance()` undefined and
  // the guard falsy.
  it('should NOT render analysis content before performance data loads', () => {
    fixture.detectChanges();

    const benchmarkComparator = fixture.nativeElement.querySelector(
      'gf-benchmark-comparator'
    );
    const investmentChart = fixture.nativeElement.querySelector(
      'gf-investment-chart'
    );
    const valueElements = fixture.nativeElement.querySelectorAll('gf-value');

    expect(benchmarkComparator).toBeNull();
    expect(investmentChart).toBeNull();
    expect(valueElements.length).toBe(0);
  });

  // Phase 5.4 — Analysis content renders once performance and user
  // data load. End-to-end data-flow chain exercised:
  //   1. `userStateChanged$.next({ user: {...} })` publishes a user
  //      state to the BehaviorSubject. Because `next(...)` is called
  //      BEFORE `fixture.detectChanges()`, the subject's current
  //      value is the new user state when ngOnInit subscribes.
  //   2. `fixture.detectChanges()` triggers the SUT's `ngOnInit`,
  //      which subscribes to `userService.stateChanged` and
  //      synchronously receives the published user state.
  //   3. The subscription callback sets `user.set(...)`, resolves
  //      the benchmark from `user.settings.benchmark` (none in this
  //      fixture so `benchmark` stays null), and calls `update()`.
  //   4. `update()` invokes `dataService.fetchPortfolioPerformance(...)`
  //      which (via the mock) emits synchronously through `of(...)`.
  //   5. The synchronous emission's callback sets
  //      `performance.set(performance)`, marking the OnPush
  //      component dirty.
  //   6. Within the same change-detection cycle, the template's
  //      `@if (performance() && user())` guard now evaluates truthy
  //      and the analysis content (3 gf-value cards, 1
  //      gf-benchmark-comparator, 1 gf-investment-chart) is rendered.
  //
  // The three `gf-value` cards correspond to the rendered template
  // (`analysis-module.component.html` lines 11-19, 27-37, 44-53):
  //   - Total amount (currentValueInBaseCurrency)
  //   - Change with currency effect (netPerformanceWithCurrencyEffect)
  //   - Performance with currency effect
  //     (netPerformancePercentageWithCurrencyEffect)
  it('should render analysis content (gf-value cards, gf-benchmark-comparator, gf-investment-chart) after performance data loads', () => {
    // Publish a user before the first detectChanges so ngOnInit's
    // subscription receives the user state synchronously.
    userStateChanged$.next({
      user: {
        settings: {
          baseCurrency: 'USD',
          colorScheme: 'LIGHT',
          isRestrictedView: false,
          locale: 'en-US'
        }
      }
    });

    fixture.detectChanges();

    const benchmarkComparator = fixture.nativeElement.querySelector(
      'gf-benchmark-comparator'
    );
    const investmentChart = fixture.nativeElement.querySelector(
      'gf-investment-chart'
    );
    const valueElements = fixture.nativeElement.querySelectorAll('gf-value');

    expect(benchmarkComparator).toBeTruthy();
    expect(investmentChart).toBeTruthy();
    // Three gf-value cards: Total amount, Change with currency effect,
    // Performance with currency effect.
    expect(valueElements.length).toBe(3);
  });

  // Phase 5.5 — `DataService.fetchInfo` is called from `ngOnInit`.
  // Confirms that the SUT captures the cached `benchmarks` list at
  // initialization. The synchronous `fetchInfo()` returns the
  // singleton-cached info payload that was fetched once at app
  // bootstrap; no HTTP call is made here.
  it('should call DataService.fetchInfo on init to capture benchmarks', () => {
    fixture.detectChanges();

    expect(mockDataService.fetchInfo).toHaveBeenCalled();
  });

  // Phase 5.6 — `DataService.fetchPortfolioPerformance` is called
  // when a user is published. Confirms that the
  // `userService.stateChanged` subscription correctly propagates
  // through to the `update()` method. Together with Phase 5.4 this
  // proves the full data-flow path: stateChanged subscription →
  // user.set() → update() → fetchPortfolioPerformance() →
  // performance.set() → @if guard truthy → DOM render.
  it('should call DataService.fetchPortfolioPerformance after a user state is published', () => {
    userStateChanged$.next({
      user: {
        settings: {
          baseCurrency: 'USD',
          colorScheme: 'LIGHT',
          isRestrictedView: false,
          locale: 'en-US'
        }
      }
    });

    fixture.detectChanges();

    expect(mockDataService.fetchPortfolioPerformance).toHaveBeenCalled();
  });

  // Phase 5.7 — No `fetchPortfolioPerformance` call before a user
  // is published. Defensive guard for the SUT's early-return branch
  // in the `userService.stateChanged` subscription
  // (`if (!state?.user) { return; }`). When the BehaviorSubject's
  // initial `null` value emits, the subscription MUST NOT trigger
  // `update()` — otherwise the SUT would issue a spurious portfolio
  // performance request before authentication state is known.
  it('should NOT call DataService.fetchPortfolioPerformance when user state is null', () => {
    fixture.detectChanges();

    expect(mockDataService.fetchPortfolioPerformance).not.toHaveBeenCalled();
  });

  // Phase 5.8 — The SUT does NOT render its own `<gf-module-wrapper>`.
  // Pins the architectural fix from QA Checkpoint 6 Issue #1 — the
  // module wrapper component renders ONLY the bare presentation
  // content; chrome (header, drag handle, remove button, content
  // slot) is rendered by the canvas-level outer `<gf-module-wrapper>`.
  // A regression that re-introduced the inner wrapper would surface
  // as a duplicated header at runtime; this test traps that
  // regression at the unit-test layer.
  it('should NOT render an inner <gf-module-wrapper> chrome', () => {
    // Publish a user so the @if guard evaluates truthy and the
    // analysis content renders — this maximizes coverage by
    // ensuring the assertion holds even when the module is
    // fully populated, not just in the empty-state.
    userStateChanged$.next({
      user: {
        settings: {
          baseCurrency: 'USD',
          colorScheme: 'LIGHT',
          isRestrictedView: false,
          locale: 'en-US'
        }
      }
    });

    fixture.detectChanges();

    const wrappers =
      fixture.nativeElement.querySelectorAll('gf-module-wrapper');

    expect(wrappers.length).toBe(0);
  });

  // Phase 5.9 — Descriptor's `iconName` is `'bar-chart-outline'`.
  // Defensive descriptor check that complements the wrapped-element
  // assertion. The descriptor's `iconName` is what the canvas's
  // `resolveIconName(item.name)` helper reads to bind onto the outer
  // `<gf-module-wrapper [iconName]>`, so any drift between the
  // descriptor and the catalog/header rendering would cascade through
  // the canvas — pinning the descriptor value here keeps the source
  // of truth honest.
  it('should expose iconName "bar-chart-outline" on the registry descriptor', () => {
    expect(ANALYSIS_MODULE_DESCRIPTOR.iconName).toBe('bar-chart-outline');
  });

  // Phase 5.10 — Descriptor's `displayLabel` is the localized
  // `'Analysis'` string. Mirrors the iconName assertion at the
  // descriptor level: the canvas's `resolveTitle(item.name)` reads
  // the descriptor's `displayLabel` and projects it onto the outer
  // `<gf-module-wrapper [title]>`. Pinning the value here ensures
  // the module-scope `ANALYSIS_TITLE = $localize`Analysis``
  // constant is wired through to the descriptor without translation
  // drift.
  it('should expose displayLabel as the localized "Analysis" string on the registry descriptor', () => {
    expect(ANALYSIS_MODULE_DESCRIPTOR.displayLabel).toBe('Analysis');
  });

  // Phase 5.11 — Descriptor's `name` is `'analysis'`. The stable
  // identifier discriminator used by `LayoutItem.moduleId` in
  // persisted layout documents and by
  // `ModuleRegistryService.getByName(name)` lookups. A rename here
  // would break every saved layout that references the analysis
  // module — pinning the value at the test layer prevents accidental
  // breakage.
  it('should expose name "analysis" on the registry descriptor', () => {
    expect(ANALYSIS_MODULE_DESCRIPTOR.name).toBe('analysis');
  });
});
