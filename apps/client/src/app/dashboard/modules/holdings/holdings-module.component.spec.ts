import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `holdings-module.component.ts` declares a
// `$localize`-tagged template literal at module scope (the
// `HOLDINGS_TITLE` constant referenced by the
// `HOLDINGS_MODULE_DESCRIPTOR.displayLabel`). Without this side-effect
// import, simply importing the SUT class throws
// `ReferenceError: $localize is not defined` before any test even runs.
// Mirrors the canonical pattern from
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import {
  GfHoldingsModuleComponent,
  HOLDINGS_MODULE_DESCRIPTOR
} from './holdings-module.component';

// Mock the home-holdings component module BEFORE any imports are
// evaluated. This short-circuits the transitive ESM import chain
//   GfHomeHoldingsComponent
//     -> @ionic/angular/standalone (IonIcon)
//        -> @ionic/core (publishes plain ESM `.js` files)
//     -> ionicons (addIcons)
//        -> ionicons/icons (gridOutline, reorderFourOutline)
//     -> @ghostfolio/ui/treemap-chart (GfTreemapChartComponent)
//     -> @ghostfolio/ui/holdings-table (GfHoldingsTableComponent)
//     -> @ghostfolio/ui/toggle (GfToggleComponent)
//     -> @ghostfolio/ui/services (DataService)
//     -> @ghostfolio/client/services/impersonation-storage.service
//     -> @ghostfolio/client/services/user/user.service
//     -> ngx-device-detector (DeviceDetectorService)
// which Jest cannot parse under the project's existing
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (transformIgnorePatterns lives in `apps/client/jest.config.ts`,
// which is out of scope for this strictly-additive PR per AAP § 0.7.3).
//
// The replacement exports a bare `GfHomeHoldingsComponent` class
// symbol that serves only as an Angular component-import token at
// module load time — the actual DOM presence the SUT needs is
// provided by the `MockHomeHoldingsComponent` declared below, which
// carries the matching `gf-home-holdings` selector and is injected
// into the SUT's standalone `imports` array via
// `TestBed.overrideComponent(...)`.
//
// `jest.mock()` calls are hoisted by jest-preset-angular's TS
// transformer above all import statements, so this mock applies to
// both the spec's potential indirect imports AND the SUT's direct
// import (the SUT imports
// `@ghostfolio/client/components/home-holdings/home-holdings.component`,
// which resolves to the same on-disk file as this relative path via
// the `tsconfig.base.json` path alias `@ghostfolio/client/* ->
// apps/client/src/app/*`). Jest tracks mocks by the resolved module
// path, so a single `jest.mock(...)` registration intercepts both
// imports.
//
// Mirrors the canonical pattern at
// `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview-module.component.spec.ts`
// and `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.spec.ts`.
jest.mock('../../../components/home-holdings/home-holdings.component', () => ({
  GfHomeHoldingsComponent: class GfHomeHoldingsComponentMock {}
}));

/**
 * Inline test stub for {@link GfHomeHoldingsComponent}. The real
 * component (from
 * `@ghostfolio/client/components/home-holdings/home-holdings.component`)
 * drags in a deep dependency graph (DataService, UserService,
 * LayoutService, ImpersonationStorageService, DeviceDetectorService,
 * ChangeDetectorRef, Router, GfHoldingsTableComponent,
 * GfToggleComponent, GfTreemapChartComponent, MatButtonModule,
 * MatButtonToggleModule, ReactiveFormsModule, RouterModule, IonIcon,
 * ionicons, internalRoutes, hasPermission/permissions resolution, etc.)
 * which is brittle and slow inside a unit-test sandbox. The stub:
 *
 * 1. Carries the real component's `gf-home-holdings` selector so the
 *    SUT's template binding (the bare `<gf-home-holdings />`) resolves
 *    to this stub when the SUT's standalone `imports` array is
 *    overridden via `TestBed.overrideComponent(...)` below.
 * 2. Declares ZERO `@Input()` decorators because the real
 *    `GfHomeHoldingsComponent` declares ZERO public inputs (verified
 *    in `apps/client/src/app/components/home-holdings/home-holdings.component.ts`
 *    lines 53-71 — all public class members are state fields like
 *    `deviceType`, `hasImpersonationId`, `holdings`, `holdingType`,
 *    `holdingTypeOptions`, `routerLinkPortfolioActivities`, `user`,
 *    `viewModeFormControl`, NOT `@Input()`-decorated). The SUT's
 *    template binds NO inputs to `<gf-home-holdings />`, so the stub
 *    needs none.
 *
 * The component is declared `standalone: true` (matches the real
 * component) with an empty template so it occupies the
 * `gf-home-holdings` selector slot without rendering anything.
 *
 * Per the AAP folder spec: deep behavioral testing of
 * `GfHomeHoldingsComponent` is OUT OF SCOPE here — its behaviors are
 * covered by its own dedicated spec under
 * `apps/client/src/app/components/home-holdings/`. This spec focuses
 * exclusively on the wrapper contract: the bare presentation
 * component is rendered as the wrapper's only content (the canvas's
 * outer `<gf-module-wrapper>` provides the chrome). Header chrome
 * tests that previously asserted DOM elements like `.gf-module-title`
 * were removed when the inner `<gf-module-wrapper>` was eliminated to
 * fix the double-wrapper DOM defect (QA Checkpoint 6 Issue #1).
 */
@Component({
  selector: 'gf-home-holdings',
  standalone: true,
  template: ''
})
class MockHomeHoldingsComponent {}

describe('GfHoldingsModuleComponent', () => {
  let component: GfHoldingsModuleComponent;
  let fixture: ComponentFixture<GfHoldingsModuleComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GfHoldingsModuleComponent, NoopAnimationsModule]
    })
      .overrideComponent(GfHoldingsModuleComponent, {
        set: {
          imports: [MockHomeHoldingsComponent]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfHoldingsModuleComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Phase 4.1 — Component is created.
  // Smoke test that confirms the SUT instantiates with the overridden
  // imports list (the MockHomeHoldingsComponent stub). Because the SUT
  // has zero service dependencies (no constructor injection, no
  // signals, no lifecycle hooks, no inputs/outputs), a failure here
  // is almost certainly a configuration issue (unresolved import,
  // $localize not initialized) rather than a behaviour bug.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // Phase 4.2 — `<gf-home-holdings>` element is present in the DOM.
  // Verifies the SUT's template renders the wrapped component selector
  // by checking for the `gf-home-holdings` element (resolved against
  // the `MockHomeHoldingsComponent` stub via the overridden `imports`
  // array). The SUT's template (`<gf-home-holdings />`) reduced to a
  // single bare element so the canvas's outer `<gf-module-wrapper>`
  // can project the content into its `<ng-content>` slot without the
  // double-wrapper DOM defect (QA Checkpoint 6 Issue #1).
  it('should render the wrapped <gf-home-holdings> element in the DOM', () => {
    fixture.detectChanges();

    const homeHoldings =
      fixture.nativeElement.querySelector('gf-home-holdings');

    expect(homeHoldings).toBeTruthy();
  });

  // Phase 4.3 — The SUT does NOT render its own `<gf-module-wrapper>`.
  // Pins the architectural fix from QA Checkpoint 6 Issue #1 — the
  // module wrapper component renders ONLY the bare presentation
  // content; chrome (header, drag handle, remove button, content
  // slot) is rendered by the canvas-level outer `<gf-module-wrapper>`.
  // A regression that re-introduced the inner wrapper would surface
  // as a duplicated header at runtime; this test traps that
  // regression at the unit-test layer.
  it('should NOT render an inner <gf-module-wrapper> chrome', () => {
    fixture.detectChanges();

    const wrappers =
      fixture.nativeElement.querySelectorAll('gf-module-wrapper');

    expect(wrappers.length).toBe(0);
  });

  // Phase 4.4 — Descriptor's `iconName` is `'pie-chart-outline'`.
  // Defensive descriptor check that complements the wrapped-element
  // assertion. The descriptor's `iconName` is what the canvas's
  // `resolveIconName(item.name)` helper reads to bind onto the outer
  // `<gf-module-wrapper [iconName]>`, so any drift between the
  // descriptor and the catalog/header rendering would cascade through
  // the canvas — pinning the descriptor value here keeps the source
  // of truth honest.
  it('should expose iconName "pie-chart-outline" on the registry descriptor', () => {
    expect(HOLDINGS_MODULE_DESCRIPTOR.iconName).toBe('pie-chart-outline');
  });

  // Phase 4.5 — Descriptor's `displayLabel` is the localized
  // `'Holdings'` string. Mirrors the iconName assertion at the
  // descriptor level: the canvas's `resolveTitle(item.name)` reads the
  // descriptor's `displayLabel` and projects it onto the outer
  // `<gf-module-wrapper [title]>`. Pinning the value here ensures the
  // module-scope `HOLDINGS_TITLE = $localize`Holdings`` constant is
  // wired through to the descriptor without translation drift.
  it('should expose displayLabel as the localized "Holdings" string on the registry descriptor', () => {
    expect(HOLDINGS_MODULE_DESCRIPTOR.displayLabel).toBe('Holdings');
  });

  // Phase 4.6 — Descriptor's `name` is `'holdings'`. The stable
  // identifier discriminator used by `LayoutItem.moduleId` in
  // persisted layout documents and by
  // `ModuleRegistryService.getByName(name)` lookups. A rename here
  // would break every saved layout that references the holdings
  // module — pinning the value at the test layer prevents accidental
  // breakage.
  it('should expose name "holdings" on the registry descriptor', () => {
    expect(HOLDINGS_MODULE_DESCRIPTOR.name).toBe('holdings');
  });
});
