import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `chat-module.component.ts` declares a
// `$localize`-tagged template literal at module scope (the
// `CHAT_TITLE` constant shared by the SUT's `title` field and the
// `CHAT_MODULE_DESCRIPTOR.displayLabel`), and the transitively
// imported `module-wrapper.component.ts` declares `DRAG_ARIA_LABEL`,
// `DRAG_TOOLTIP`, `REMOVE_ARIA_LABEL`, and `REMOVE_TOOLTIP` at module
// scope. Without this side-effect import, simply importing the SUT
// class throws `ReferenceError: $localize is not defined` before any
// test even runs. Mirrors the canonical pattern from
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { GfModuleWrapperComponent } from '../../module-wrapper/module-wrapper.component';
import { GfChatModuleComponent } from './chat-module.component';

/**
 * Inline test stub for {@link ChatPanelComponent} — the DEVIATION POINT
 * (AAP § 0.7.2) wrapped child component. The real `ChatPanelComponent`
 * (from `@ghostfolio/client/components/chat-panel/chat-panel.component`)
 * drags in a deep dependency graph (`AiChatService` with HTTP + SSE
 * machinery, `MatButtonModule`, `MatFormFieldModule`, `MatInputModule`,
 * `MatProgressBarModule`, `FormsModule`, `ChatMessage` interface,
 * `TokenStorageService`, drag-resize listeners, `@HostBinding` width
 * computation, etc.) which is brittle and slow inside a unit-test
 * sandbox. The stub:
 *
 * 1. Carries the real component's `app-chat-panel` selector — NOT
 *    `gf-chat-panel` — so the SUT's template binding
 *    (`<app-chat-panel></app-chat-panel>` inside the
 *    `<gf-module-wrapper>` content slot) resolves to this stub when
 *    the SUT's standalone `imports` array is overridden via
 *    `TestBed.overrideComponent(...)` below. This intentional
 *    deviation from the project-wide `gf-` selector prefix is the
 *    DEVIATION POINT contract per AAP § 0.7.4: the existing chat
 *    panel embed at `apps/client/src/app/pages/portfolio/portfolio-page.html:32`
 *    was literally `<app-chat-panel></app-chat-panel>`, and the AAP
 *    mandates the wrapper preserve that selector verbatim so existing
 *    component implementations remain unchanged.
 * 2. Declares ZERO `@Input()` decorators because the real
 *    `ChatPanelComponent` declares ZERO public inputs (verified in
 *    `apps/client/src/app/components/chat-panel/chat-panel.component.ts`
 *    lines 58-130 — all public class members are SIGNALS like
 *    `errorMessage`, `inputText`, `isStreaming`, `messages`,
 *    `isCollapsed`, `panelWidth`, NOT `@Input()`-decorated). The
 *    SUT's template binds NO inputs to `<app-chat-panel>`, so the
 *    stub needs none.
 * 3. Declares ZERO `@Output()` decorators because the real
 *    `ChatPanelComponent` exposes NO public outputs — its
 *    interactivity is entirely self-contained (sending messages via
 *    the internal `AiChatService` SSE stream, toggling collapse via
 *    `toggleCollapsed()`, drag-resize via `onMouseDown(...)`).
 *
 * The `eslint-disable-next-line @angular-eslint/component-selector`
 * annotation is REQUIRED — without it, the project's eslint config
 * flags the test file as a Rule violation ("Selector should be
 * prefixed with 'gf'"). This mirrors the annotation on the real
 * component at `chat-panel.component.ts:53`.
 *
 * The component is declared `standalone: true` (matches the real
 * component) with an empty template so it occupies the
 * `app-chat-panel` selector slot without rendering anything.
 *
 * Per the AAP folder spec: deep behavioral testing of
 * `ChatPanelComponent` is OUT OF SCOPE here — its behaviors (SSE
 * stream lifecycle, message capping, reconnect flow, drag-resize,
 * collapse/expand) are covered by its own dedicated spec at
 * `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts`.
 * This spec focuses exclusively on the wrapper contract: title
 * rendering, icon binding, remove emission propagation, content-slot
 * DOM presence, and the DEVIATION POINT selector regression guard.
 */
@Component({
  // The 'app-chat-panel' selector intentionally deviates from the
  // project-wide 'gf' prefix — this matches the REAL ChatPanelComponent's
  // selector verbatim per AAP § 0.7.4 selector convention exception.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-chat-panel',
  standalone: true,
  template: ''
})
class MockChatPanelComponent {}

describe('GfChatModuleComponent', () => {
  let component: GfChatModuleComponent;
  let fixture: ComponentFixture<GfChatModuleComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GfChatModuleComponent, NoopAnimationsModule]
    })
      .overrideComponent(GfChatModuleComponent, {
        set: {
          imports: [GfModuleWrapperComponent, MockChatPanelComponent]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfChatModuleComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Phase 4.1 — Component is created.
  // Smoke test that confirms the SUT instantiates with the overridden
  // imports list (real GfModuleWrapperComponent + the
  // MockChatPanelComponent stub). Because the SUT has zero service
  // dependencies (no constructor injection, no signals beyond the
  // signal-based output, no lifecycle hooks), a failure here is almost
  // certainly a configuration issue (unresolved import, $localize not
  // initialized) rather than a behaviour bug. Per AAP § 0.6.1.4, this
  // wrapper is structurally identical to the holdings and
  // portfolio-overview wrappers — a thin presentation shell with no
  // injected dependencies.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // Phase 4.2 — Title is rendered as 'AI Chat' inside the module
  // wrapper. The SUT initializes its `title` field from the module-scope
  // `CHAT_TITLE` constant (= $localize`AI Chat`), binds it via
  // `[title]="title"` on the inner `<gf-module-wrapper>`, and the
  // wrapper renders `{{ title() }}` inside the
  // `<h2 class="gf-module-title">` element. This test asserts the
  // end-to-end binding chain so the catalog row label and the rendered
  // header label cannot drift from the `CHAT_TITLE` source-of-truth.
  it('should render the module title as "AI Chat"', () => {
    fixture.detectChanges();

    const titleElement = fixture.nativeElement.querySelector(
      '.gf-module-title'
    ) as HTMLElement | null;

    expect(titleElement).toBeTruthy();
    expect(titleElement?.textContent?.trim()).toBe('AI Chat');
  });

  // Phase 4.3 — Title icon name matches `'chatbubbles-outline'`. The
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
  // pattern established by `module-wrapper.component.spec.ts:142-152`,
  // `holdings-module.component.spec.ts:191-200`, and
  // `portfolio-overview-module.component.spec.ts:177-186`.
  it('should bind iconName "chatbubbles-outline" to the title-icon ion-icon', () => {
    fixture.detectChanges();

    const titleIcon = fixture.nativeElement.querySelector(
      '.gf-module-title-icon ion-icon'
    ) as (HTMLElement & { name?: string }) | null;

    expect(titleIcon).toBeTruthy();
    expect(titleIcon?.name).toBe('chatbubbles-outline');
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
  // `module-wrapper.component.spec.ts:204-218`,
  // `holdings-module.component.spec.ts:223-237`, and
  // `portfolio-overview-module.component.spec.ts:209-223`.
  //
  // Per Rule 4 (AAP § 0.8.1.4), the wrapper does NOT call
  // `UserDashboardLayoutService.update(...)` or any other layout-save
  // API. The `remove` emission is a pure intent signal — the canvas
  // owns the gridster `dashboard` array mutation and the persistence
  // pipeline observes that mutation through gridster's change
  // callbacks. This test verifies the intent signal propagates;
  // downstream persistence behavior is tested at the canvas level.
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

  // Phase 4.5 — `<app-chat-panel>` element is present in the DOM
  // (DEVIATION POINT verification per AAP § 0.7.2).
  //
  // Verifies the SUT's template renders the wrapped chat panel selector
  // by checking for the `app-chat-panel` element (resolved against the
  // `MockChatPanelComponent` stub via the overridden `imports` array).
  // This is the minimal smoke test that the wrapped component is
  // mounted at all.
  //
  // The selector is INTENTIONALLY UNPREFIXED (`app-chat-panel`, NOT
  // `gf-chat-panel`) per AAP § 0.7.4 — the chat panel retains its
  // legacy selector as a deliberate exception to the project-wide
  // `gf-` prefix convention. This deviation preserves backward
  // compatibility with the existing `ChatPanelComponent` whose
  // internal implementation, signals (errorMessage, inputText,
  // isStreaming, messages, isCollapsed, panelWidth), constants
  // (MAX_CLIENT_TRANSMITTED_MESSAGES = 5, COLLAPSED_WIDTH_REM =
  // '2.75rem', DEFAULT_EXPANDED_WIDTH_PX = 280, MIN_EXPANDED_WIDTH_PX
  // = 200, MAX_EXPANDED_WIDTH_PX = 600), and SSE handling all remain
  // UNCHANGED. The DEVIATION is recorded in the project's decision
  // log at `docs/decisions/agent-action-plan-decisions.md`.
  it('should render the wrapped <app-chat-panel> element in the DOM (DEVIATION POINT — chat selector is intentionally unprefixed)', () => {
    fixture.detectChanges();

    const chatPanel = fixture.nativeElement.querySelector('app-chat-panel');

    expect(chatPanel).toBeTruthy();
  });

  // Phase 4.6 — `<app-chat-panel>` is rendered INSIDE the wrapper's
  // content slot. Verifies the SUT's template structure
  // (`<gf-module-wrapper>...<app-chat-panel></app-chat-panel></gf-module-wrapper>`)
  // is correctly projected through the wrapper's `<ng-content />`
  // inside the `.gf-module-content` div. This guards against a
  // regression where the wrapped component might be rendered outside
  // the wrapper's chrome (e.g., if the template were accidentally
  // restructured) — the structural relationship is the contract.
  //
  // The combination of Phase 4.5 (presence) and Phase 4.6 (placement)
  // ensures the chat panel renders both at all and in the correct
  // structural location relative to the module header.
  it('should render the <app-chat-panel> element inside the .gf-module-content slot', () => {
    fixture.detectChanges();

    const contentSlot = fixture.nativeElement.querySelector(
      '.gf-module-content'
    ) as HTMLElement | null;
    expect(contentSlot).toBeTruthy();

    const chatPanel = contentSlot?.querySelector('app-chat-panel');

    expect(chatPanel).toBeTruthy();
  });

  // Phase 4.7 — Public `iconName` field exposes `'chatbubbles-outline'`.
  // Defensive class-surface check that complements Phase 4.3's DOM
  // assertion. A divergence between the class field and the rendered
  // attribute would indicate a template-binding regression. The class
  // field is a `readonly` static configuration value (NOT a signal)
  // because the icon name never changes after construction —
  // {@link CHAT_MODULE_DESCRIPTOR.iconName} mirrors this value so the
  // catalog row icon and the module header icon stay in sync.
  it('should expose iconName as a static "chatbubbles-outline" string', () => {
    expect(component.iconName).toBe('chatbubbles-outline');
  });

  // Phase 4.8 — Public `title` field exposes `'AI Chat'`. Defensive
  // class-surface check that complements Phase 4.2's DOM assertion. A
  // divergence between the class field and the rendered header text
  // would indicate a template-binding regression. The class field is
  // initialized from the module-scope `CHAT_TITLE = $localize`AI Chat``
  // constant so the title shares the exact same `$localize`-tagged
  // value with {@link CHAT_MODULE_DESCRIPTOR.displayLabel} (the catalog
  // row label). A single source-of-truth constant prevents translation
  // drift between the two surfaces.
  it('should expose title as the localized "AI Chat" string', () => {
    expect(component.title).toBe('AI Chat');
  });

  // Phase 4.9 — `gf-chat-panel` selector is NOT used (DEVIATION POINT
  // regression test per AAP § 0.7.2 and § 0.7.4).
  //
  // This test is a regression guard against accidentally renaming the
  // chat panel selector to fit the project-wide `gf-` prefix
  // convention. The chat panel intentionally retains its
  // `app-chat-panel` selector per AAP § 0.7.4 — renaming the SUT's
  // template to `<gf-chat-panel></gf-chat-panel>` would silently break
  // the contract with the existing `ChatPanelComponent` whose
  // `@Component({ selector: 'app-chat-panel' })` declaration is
  // explicitly preserved (with its own
  // `eslint-disable-next-line @angular-eslint/component-selector`
  // annotation) at `chat-panel.component.ts:53-54`.
  //
  // Without this regression guard, a future agent following the
  // project-wide `gf-` prefix rule could "fix" the selector and the
  // existing tests (4.5, 4.6) would still pass because the mock could
  // be renamed to match. By explicitly asserting the `gf-chat-panel`
  // selector is ABSENT, this test forces any such rename to also
  // touch this spec — surfacing the deviation contract for review.
  //
  // This guard is unique to the chat module spec — no other module
  // wrapper has a `gf-` mismatched selector concern because every
  // other wrapped component (GfHomeOverviewComponent,
  // GfHomeHoldingsComponent, GfActivitiesTableComponent) already uses
  // the `gf-` prefix natively.
  it('should NOT render any <gf-chat-panel> element (DEVIATION POINT — selector remains app-chat-panel)', () => {
    fixture.detectChanges();

    const wrongSelector = fixture.nativeElement.querySelector('gf-chat-panel');

    expect(wrongSelector).toBeNull();
  });
});
