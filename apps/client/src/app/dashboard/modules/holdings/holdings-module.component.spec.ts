import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `holdings-module.component.ts` declares a
// `$localize`-tagged template literal at module scope (the
// `HOLDINGS_TITLE` constant shared by the SUT's `title` field and the
// `HOLDINGS_MODULE_DESCRIPTOR.displayLabel`), and the transitively
// imported `module-wrapper.component.ts` declares `DRAG_ARIA_LABEL`,
// `DRAG_TOOLTIP`, `REMOVE_ARIA_LABEL`, and `REMOVE_TOOLTIP` at module
// scope. Without this side-effect import, simply importing the SUT
// class throws `ReferenceError: $localize is not defined` before any
// test even runs. Mirrors the canonical pattern from
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { GfModuleWrapperComponent } from '../../module-wrapper/module-wrapper.component';
import { GfHoldingsModuleComponent } from './holdings-module.component';

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
// `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview-module.component.spec.ts:52-54`
// and `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.spec.ts:54-56,80-82`.
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
 *    SUT's template binding (`<gf-home-holdings />` inside the
 *    `<gf-module-wrapper>` content slot) resolves to this stub when
 *    the SUT's standalone `imports` array is overridden via
 *    `TestBed.overrideComponent(...)` below.
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
 * exclusively on the wrapper contract: title rendering, icon binding,
 * remove emission propagation, and content-slot DOM presence.
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
          imports: [GfModuleWrapperComponent, MockHomeHoldingsComponent]
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
  // imports list (real GfModuleWrapperComponent + the
  // MockHomeHoldingsComponent stub). Because the SUT has zero service
  // dependencies (no constructor injection, no signals beyond the
  // signal-based output, no lifecycle hooks), a failure here is almost
  // certainly a configuration issue (unresolved import, $localize not
  // initialized) rather than a behaviour bug.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // Phase 4.2 — Title is rendered as 'Holdings' inside the module
  // wrapper. The SUT initializes its `title` field from the module-scope
  // `HOLDINGS_TITLE` constant (= $localize`Holdings`), binds it via
  // `[title]="title"` on the inner `<gf-module-wrapper>`, and the
  // wrapper renders `{{ title() }}` inside the
  // `<h2 class="gf-module-title">` element. This test asserts the
  // end-to-end binding chain so the catalog row label and the rendered
  // header label cannot drift from the `HOLDINGS_TITLE`
  // source-of-truth.
  it('should render the module title as "Holdings"', () => {
    fixture.detectChanges();

    const titleElement = fixture.nativeElement.querySelector(
      '.gf-module-title'
    ) as HTMLElement | null;

    expect(titleElement).toBeTruthy();
    expect(titleElement?.textContent?.trim()).toBe('Holdings');
  });

  // Phase 4.3 — Title icon name matches `'pie-chart-outline'`. The
  // SUT binds `[iconName]="iconName"` on the inner
  // `<gf-module-wrapper>`, which then renders
  // `<ion-icon [name]="iconName()" />` inside the
  // `.gf-module-title-icon` <span>.
  //
  // NOTE on property vs attribute: Angular's `[name]="iconName()"`
  // syntax compiles to `Renderer2.setProperty(element, 'name', value)`,
  // not `setAttribute(...)`. For native elements where `name` is a
  // reflected IDL attribute the property assignment is mirrored to the
  // attribute automatically by the browser; for custom elements like
  // `<ion-icon>` (registered at runtime by `@ionic/core`'s
  // `defineCustomElements()` rather than statically known to the
  // browser parser) the property is set on the element instance but
  // the framework does NOT mirror it into a `name="..."` attribute. In
  // the Jest test environment the ion-icon custom element is NOT
  // registered (it is only registered in the production browser bundle
  // via `provideIonicAngular()` and per-component `addIcons(...)`
  // calls), so `getAttribute('name')` would always return `null` here.
  // The property assertion below is the canonical contract check for
  // the binding because the property is what Angular actually drives,
  // regardless of whether the custom element is active. Mirrors the
  // pattern established by `module-wrapper.component.spec.ts:142-152`
  // and `portfolio-overview-module.component.spec.ts:177-186`.
  it('should bind iconName "pie-chart-outline" to the title-icon ion-icon', () => {
    fixture.detectChanges();

    const titleIcon = fixture.nativeElement.querySelector(
      '.gf-module-title-icon ion-icon'
    ) as (HTMLElement & { name?: string }) | null;

    expect(titleIcon).toBeTruthy();
    expect(titleIcon?.name).toBe('pie-chart-outline');
  });

  // Phase 4.4 — Remove emission propagates from the inner wrapper
  // through the SUT's own `remove` output. End-to-end emission chain
  // exercised:
  //   1. User clicks the `.gf-module-remove` button rendered by
  //      `GfModuleWrapperComponent`.
  //   2. Wrapper's `(click)="onRemove()"` handler fires.
  //   3. `onRemove()` calls `this.remove.emit()` on the wrapper.
  //   4. The wrapper's `(remove)` output emits.
  //   5. The SUT's template binds `(remove)="remove.emit()"` on the
  //      `<gf-module-wrapper>`, which forwards the event to the SUT's
  //      own `remove` output.
  //   6. The subscriber attached to `component.remove` increments the
  //      counter once.
  //
  // Subscribes via `.subscribe(...)` (the public OutputEmitterRef API)
  // rather than `jest.spyOn(component.remove, 'emit')` per AAP
  // anti-pattern checklist (the OutputEmitterRef's `emit` is internal
  // implementation detail with a different signature than rxjs
  // Subject.next). Mirrors the pattern established by
  // `module-wrapper.component.spec.ts:204-218` and
  // `portfolio-overview-module.component.spec.ts:209-223`.
  it('should emit the remove output exactly once when the wrapper remove button is clicked', () => {
    let emissions = 0;
    component.remove.subscribe(() => (emissions += 1));

    fixture.detectChanges();

    const removeBtn = fixture.nativeElement.querySelector(
      '.gf-module-remove'
    ) as HTMLButtonElement | null;
    expect(removeBtn).toBeTruthy();

    removeBtn?.click();

    expect(emissions).toBe(1);
  });

  // Phase 4.5 — `<gf-home-holdings>` element is present in the DOM.
  // Verifies the SUT's template renders the wrapped component selector
  // by checking for the `gf-home-holdings` element (resolved against
  // the `MockHomeHoldingsComponent` stub via the overridden `imports`
  // array). This is the minimal smoke test that the wrapped component
  // is mounted at all.
  it('should render the wrapped <gf-home-holdings> element in the DOM', () => {
    fixture.detectChanges();

    const homeHoldings =
      fixture.nativeElement.querySelector('gf-home-holdings');

    expect(homeHoldings).toBeTruthy();
  });

  // Phase 4.6 — `<gf-home-holdings>` is rendered INSIDE the wrapper's
  // content slot. Verifies the SUT's template structure
  // (`<gf-module-wrapper>...<gf-home-holdings /></gf-module-wrapper>`)
  // is correctly projected through the wrapper's `<ng-content />`
  // inside the `.gf-module-content` div. This guards against a
  // regression where the wrapped component might be rendered outside
  // the wrapper's chrome (e.g., if the template were accidentally
  // restructured) — the structural relationship is the contract.
  it('should render the <gf-home-holdings> element inside the .gf-module-content slot', () => {
    fixture.detectChanges();

    const contentSlot = fixture.nativeElement.querySelector(
      '.gf-module-content'
    ) as HTMLElement | null;
    expect(contentSlot).toBeTruthy();

    const homeHoldings = contentSlot?.querySelector('gf-home-holdings');

    expect(homeHoldings).toBeTruthy();
  });

  // Phase 4.7 — Public `iconName` field exposes `'pie-chart-outline'`.
  // Defensive class-surface check that complements Phase 4.3's DOM
  // assertion. A divergence between the class field and the rendered
  // attribute would indicate a template-binding regression. The class
  // field is a `readonly` static configuration value (NOT a signal)
  // because the icon name never changes after construction —
  // {@link HOLDINGS_MODULE_DESCRIPTOR.iconName} mirrors this value so
  // the catalog row icon and the module header icon stay in sync.
  it('should expose iconName as a static "pie-chart-outline" string', () => {
    expect(component.iconName).toBe('pie-chart-outline');
  });

  // Phase 4.8 — Public `title` field exposes `'Holdings'`. Defensive
  // class-surface check that complements Phase 4.2's DOM assertion. A
  // divergence between the class field and the rendered header text
  // would indicate a template-binding regression. The class field is
  // initialized from the module-scope
  // `HOLDINGS_TITLE = $localize`Holdings`` constant so the title
  // shares the exact same `$localize`-tagged value with
  // {@link HOLDINGS_MODULE_DESCRIPTOR.displayLabel} (the catalog row
  // label). A single source-of-truth constant prevents translation
  // drift between the two surfaces.
  it('should expose title as the localized "Holdings" string', () => {
    expect(component.title).toBe('Holdings');
  });
});
