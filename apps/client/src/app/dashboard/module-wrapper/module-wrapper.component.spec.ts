import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `module-wrapper.component.ts` declares
// `$localize`-tagged template literals at module scope (DRAG_ARIA_LABEL,
// DRAG_TOOLTIP, REMOVE_ARIA_LABEL, REMOVE_TOOLTIP), and the companion
// `module-wrapper.component.html` template uses dynamic
// `[attr.aria-label]` / `[matTooltip]` bindings that are populated from
// those module-scope $localize literals. Without this side-effect
// import, simply importing the SUT class throws
// `ReferenceError: $localize is not defined` before any test even runs.
// Mirrors the pattern established at
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { GfModuleWrapperComponent } from './module-wrapper.component';

/**
 * Standalone test host component used to exercise the SUT's content
 * projection slot. Angular's TestBed cannot directly project content
 * into the SUT's `<ng-content />` element without a host wrapper that
 * declares the projected children inside its template. The host's
 * `<gf-module-wrapper>` element renders an inner `<span
 * data-testid="projected-child">` that the projection-related test
 * cases (Phase 5.1, 5.2) query and assert against.
 *
 * Inputs and the `(remove)` listener mirror the public API surface of
 * the SUT (Phase 5.2, 5.3, 5.4 cases), enabling the spec to verify the
 * end-to-end binding contract from a parent component's perspective.
 *
 * The component is declared `standalone` (the implicit default in
 * Angular 21) so it can be added directly to TestBed's `imports`
 * array — no NgModule declaration boilerplate is required.
 */
@Component({
  imports: [GfModuleWrapperComponent],
  selector: 'gf-test-host',
  template: `
    <gf-module-wrapper
      [iconName]="iconName"
      [title]="title"
      (remove)="onRemove()"
    >
      <span data-testid="projected-child">Hello from projected content</span>
    </gf-module-wrapper>
  `
})
class TestHostComponent {
  public iconName = 'alarm-outline';
  public removeCount = 0;
  public title = 'Test Title';

  public onRemove(): void {
    this.removeCount += 1;
  }
}

describe('GfModuleWrapperComponent', () => {
  describe('standalone', () => {
    let component: GfModuleWrapperComponent;
    let fixture: ComponentFixture<GfModuleWrapperComponent>;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [GfModuleWrapperComponent, NoopAnimationsModule]
      }).compileComponents();

      fixture = TestBed.createComponent(GfModuleWrapperComponent);
      component = fixture.componentInstance;
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    // Phase 4.1 — Component is created.
    it('should be created', () => {
      fixture.detectChanges();

      expect(component).toBeTruthy();
    });

    // Phase 4.2 — Title input renders inside `.gf-module-title`.
    it('should render the title input value inside the header h2 element', () => {
      fixture.componentRef.setInput('title', 'Holdings');
      fixture.detectChanges();

      const h2 = fixture.nativeElement.querySelector(
        '.gf-module-title'
      ) as HTMLElement;

      expect(h2).toBeTruthy();
      expect(h2.textContent?.trim()).toBe('Holdings');
    });

    // Phase 4.3 — Title input updates re-render the heading. Verifies
    // that subsequent `setInput` calls flow through OnPush change
    // detection and the rendered heading text reflects the latest
    // value.
    it('should update the rendered title when the title input changes', () => {
      fixture.componentRef.setInput('title', 'First');
      fixture.detectChanges();

      let h2 = fixture.nativeElement.querySelector(
        '.gf-module-title'
      ) as HTMLElement;
      expect(h2.textContent?.trim()).toBe('First');

      fixture.componentRef.setInput('title', 'Second');
      fixture.detectChanges();

      h2 = fixture.nativeElement.querySelector(
        '.gf-module-title'
      ) as HTMLElement;
      expect(h2.textContent?.trim()).toBe('Second');
    });

    // Phase 4.4 — `iconName` input is forwarded to the title-icon
    // `<ion-icon>` element's `name` property. The wrapper template
    // binds `<ion-icon [name]="iconName()" />` inside the
    // `.gf-module-title-icon` <span>.
    //
    // NOTE on property vs attribute: Angular's `[name]="iconName()"`
    // syntax is a PROPERTY binding (it calls
    // `Renderer2.setProperty(element, 'name', value)`), not an
    // attribute binding. For native browser elements the property
    // assignment is the canonical way to drive value into the DOM;
    // for custom elements (like `<ion-icon>`, which is registered at
    // runtime by `@ionic/core`'s `defineCustomElements()` rather than
    // statically known to the browser parser) the property is set on
    // the element instance, but the framework does NOT mirror that
    // value into a `name="..."` attribute. In the Jest test
    // environment the ion-icon custom element is NOT registered (it
    // is only registered in the production browser bundle via
    // `provideIonicAngular()` and the per-component `addIcons(...)`
    // calls), so `getAttribute('name')` would always return `null`
    // here. The property assertion below is the correct contract
    // check for the binding because the property is what Angular
    // actually drives, regardless of whether the custom element is
    // active.
    it('should apply the iconName input to the title-icon ion-icon name property', () => {
      fixture.componentRef.setInput('iconName', 'pie-chart-outline');
      fixture.detectChanges();

      const titleIcon = fixture.nativeElement.querySelector(
        '.gf-module-title-icon ion-icon'
      ) as (HTMLElement & { name?: string }) | null;

      expect(titleIcon).toBeTruthy();
      expect(titleIcon?.name).toBe('pie-chart-outline');
    });

    // Phase 4.5 — Default `iconName` is `'apps-outline'`. When no
    // explicit `iconName` is supplied via `setInput`, the SUT's
    // signal-based input default (declared at component class level)
    // should propagate to the rendered DOM. See the property-vs-attribute
    // note on test 4.4 — the property is the canonical assertion target.
    it('should default the title-icon name to "apps-outline" when iconName is not set', () => {
      fixture.detectChanges();

      const titleIcon = fixture.nativeElement.querySelector(
        '.gf-module-title-icon ion-icon'
      ) as (HTMLElement & { name?: string }) | null;

      expect(titleIcon?.name).toBe('apps-outline');
    });

    // Phase 4.6 — `.gf-module-drag-handle` element is present. This
    // CSS class is the gridster integration point: the canvas
    // configures gridster's `draggable.handle = '.gf-module-drag-handle'`
    // so the marker class on this element controls whether the user
    // can initiate a drag from the wrapper header.
    it('should render an element with the .gf-module-drag-handle CSS class (gridster integration)', () => {
      fixture.detectChanges();

      const dragHandle = fixture.nativeElement.querySelector(
        '.gf-module-drag-handle'
      );

      expect(dragHandle).toBeTruthy();
    });

    // Phase 4.7 — Drag handle is a `<button>` element. A `<button>`
    // can receive keyboard focus via `Tab`, satisfying WCAG 2.1
    // keyboard-accessibility requirements for interactive controls.
    it('should render the drag handle as a <button> element for keyboard accessibility', () => {
      fixture.detectChanges();

      const dragHandle = fixture.nativeElement.querySelector(
        '.gf-module-drag-handle'
      ) as HTMLElement | null;

      expect(dragHandle).toBeTruthy();
      expect(dragHandle?.tagName.toLowerCase()).toBe('button');
    });

    // Phase 4.8 — Remove button click emits the `remove` output
    // exactly once. Subscribes to the OutputEmitterRef directly via
    // `.subscribe(...)` (the public API exposed by signal-based
    // outputs) — see AAP "Anti-Pattern Check": do NOT spy on
    // `.emit(...)` because the OutputEmitterRef's emit is implementation
    // detail with a different signature than rxjs Subject.next.
    it('should emit the remove output exactly once when the remove button is clicked', () => {
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

    // Phase 4.9 — Remove button click can fire multiple times.
    // Verifies the OutputEmitterRef is not single-shot and does not
    // get torn down after the first emission.
    it('should emit remove on each successive click', () => {
      let emissions = 0;
      component.remove.subscribe(() => (emissions += 1));

      fixture.detectChanges();

      const removeBtn = fixture.nativeElement.querySelector(
        '.gf-module-remove'
      ) as HTMLButtonElement;
      removeBtn.click();
      removeBtn.click();
      removeBtn.click();

      expect(emissions).toBe(3);
    });

    // Phase 4.10 — Header element renders with `.gf-module-header`
    // class and contains the three structural children: the drag
    // handle, the title, and the remove button. This guards the
    // header structure as a single DOM contract that gridster and
    // module wrappers (across all five module types) depend on.
    it('should render the header element with the .gf-module-header CSS class', () => {
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector(
        '.gf-module-header'
      ) as HTMLElement | null;

      expect(header).toBeTruthy();
      // The header is the structural element hosting drag handle,
      // title, and remove — all three must be queryable from inside
      // the header sub-tree.
      expect(header?.querySelector('.gf-module-drag-handle')).toBeTruthy();
      expect(header?.querySelector('.gf-module-title')).toBeTruthy();
      expect(header?.querySelector('.gf-module-remove')).toBeTruthy();
    });

    // Phase 4.11 — Content slot element `.gf-module-content` exists.
    // This element wraps `<ng-content />` and is the projection
    // anchor that Phase 5.1 verifies projected children land inside.
    it('should render a .gf-module-content element to host projected children', () => {
      fixture.detectChanges();

      const content = fixture.nativeElement.querySelector('.gf-module-content');

      expect(content).toBeTruthy();
    });

    // Phase 4.12 — `onRemove()` method directly emits remove output.
    // Verifies the documented public contract that callers (notably
    // unit tests and any future imperative call site) can trigger
    // the same emission as the click handler. Provides line coverage
    // of the `onRemove()` method body independent of DOM events.
    it('should emit the remove output when onRemove() is invoked directly', () => {
      let emissions = 0;
      component.remove.subscribe(() => (emissions += 1));

      component.onRemove();

      expect(emissions).toBe(1);
    });
  });

  describe('with host (content projection)', () => {
    let host: TestHostComponent;
    let hostFixture: ComponentFixture<TestHostComponent>;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TestHostComponent, NoopAnimationsModule]
      }).compileComponents();

      hostFixture = TestBed.createComponent(TestHostComponent);
      host = hostFixture.componentInstance;
      hostFixture.detectChanges();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    // Phase 5.1 — Projected child is rendered inside the content
    // slot. Confirms the wrapper's `<ng-content />` placement is
    // INSIDE `.gf-module-content` and NOT inside the header (which
    // would break visual layout and accessibility).
    it('should render projected children inside the .gf-module-content slot', () => {
      const projected = hostFixture.nativeElement.querySelector(
        '[data-testid="projected-child"]'
      ) as HTMLElement | null;

      expect(projected).toBeTruthy();
      expect(projected?.textContent).toContain('Hello from projected content');

      // Verify the projected child is INSIDE `.gf-module-content`
      // and NOT elsewhere in the wrapper sub-tree. `.contains(...)`
      // walks the descendant tree, so a successful match means the
      // element is anywhere inside the content slot — which is the
      // exact projection guarantee required.
      const contentSlot = hostFixture.nativeElement.querySelector(
        '.gf-module-content'
      ) as HTMLElement | null;
      expect(contentSlot?.contains(projected)).toBe(true);
    });

    // Phase 5.2 — Host-bound `(remove)` invokes the host handler.
    // Verifies the end-to-end emission chain from the rendered
    // remove button through the wrapper's `(click) -> onRemove() ->
    // remove.emit()` and into the parent host's `onRemove()`
    // listener. The host increments a counter so the test asserts
    // exactly one emission per click.
    it('should invoke the host (remove) listener when the wrapper remove button is clicked', () => {
      expect(host.removeCount).toBe(0);

      const removeBtn = hostFixture.nativeElement.querySelector(
        '.gf-module-remove'
      ) as HTMLButtonElement;
      removeBtn.click();
      hostFixture.detectChanges();

      expect(host.removeCount).toBe(1);
    });

    // Phase 5.3 — Host-bound `[title]` is reflected in the rendered
    // DOM. Verifies the parent-to-child input binding contract for
    // the `title` signal-based input through Angular's standard
    // template-binding plumbing.
    it('should reflect the host-bound [title] input in the rendered title element', () => {
      host.title = 'Updated From Host';
      hostFixture.detectChanges();

      const h2 = hostFixture.nativeElement.querySelector(
        '.gf-module-title'
      ) as HTMLElement;

      expect(h2.textContent?.trim()).toBe('Updated From Host');
    });

    // Phase 5.4 — Host-bound `[iconName]` is reflected in the
    // title-icon. Verifies the parent-to-child input binding
    // contract for the `iconName` signal-based input flows through
    // to the `<ion-icon>` element's `name` property. See the
    // property-vs-attribute note on standalone test 4.4 — Angular's
    // `[name]="iconName()"` is a property binding, so the canonical
    // assertion target is the JS property rather than the DOM
    // attribute (which is not mirrored when the ion-icon custom
    // element is not registered, as in the Jest test environment).
    it('should reflect the host-bound [iconName] input in the title-icon name property', () => {
      host.iconName = 'cash-outline';
      hostFixture.detectChanges();

      const titleIcon = hostFixture.nativeElement.querySelector(
        '.gf-module-title-icon ion-icon'
      ) as HTMLElement & { name?: string };

      expect(titleIcon.name).toBe('cash-outline');
    });
  });
});
