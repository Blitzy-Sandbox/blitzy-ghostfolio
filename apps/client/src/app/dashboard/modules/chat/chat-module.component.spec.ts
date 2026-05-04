import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `chat-module.component.ts` declares a
// `$localize`-tagged template literal at module scope (the
// `CHAT_TITLE` constant referenced by the
// `CHAT_MODULE_DESCRIPTOR.displayLabel`). Without this side-effect
// import, simply importing the SUT class throws
// `ReferenceError: $localize is not defined` before any test even runs.
// Mirrors the canonical pattern from
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import {
  CHAT_MODULE_DESCRIPTOR,
  GfChatModuleComponent
} from './chat-module.component';

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
 *    `gf-chat-panel` — so the SUT's template binding (the bare
 *    `<app-chat-panel></app-chat-panel>`) resolves to this stub when
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
 * This spec focuses exclusively on the wrapper contract: the bare
 * `<app-chat-panel>` is rendered as the wrapper's only content (the
 * canvas's outer `<gf-module-wrapper>` provides the chrome), and the
 * DEVIATION POINT selector regression guard. Header chrome tests that
 * previously asserted DOM elements like `.gf-module-title` were
 * removed when the inner `<gf-module-wrapper>` was eliminated to fix
 * the double-wrapper DOM defect (QA Checkpoint 6 Issue #1).
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
          imports: [MockChatPanelComponent]
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
  // imports list (the MockChatPanelComponent stub). Because the SUT
  // has zero service dependencies (no constructor injection, no
  // signals, no lifecycle hooks, no inputs/outputs), a failure here
  // is almost certainly a configuration issue (unresolved import,
  // $localize not initialized) rather than a behaviour bug.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // Phase 4.2 — `<app-chat-panel>` element is present in the DOM
  // (DEVIATION POINT — the chat panel preserves its `app-chat-panel`
  // selector per AAP § 0.7.4 selector convention exception). The
  // SUT's template (`<app-chat-panel></app-chat-panel>`) reduced to a
  // single bare element so the canvas's outer `<gf-module-wrapper>`
  // can project the content into its `<ng-content>` slot without the
  // double-wrapper DOM defect (QA Checkpoint 6 Issue #1).
  it('should render the wrapped <app-chat-panel> element in the DOM (DEVIATION POINT — chat selector is intentionally unprefixed)', () => {
    fixture.detectChanges();

    const chatPanel = fixture.nativeElement.querySelector('app-chat-panel');

    expect(chatPanel).toBeTruthy();
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

  // Phase 4.4 — DEVIATION POINT regression guard: the SUT MUST NOT
  // render a `<gf-chat-panel>` element. Per AAP § 0.7.4, the chat
  // panel retains its existing `app-chat-panel` selector — a refactor
  // that accidentally renamed the selector to `gf-chat-panel` would
  // break this assertion AND break the existing
  // `ChatPanelComponent` (which declares `selector: 'app-chat-panel'`
  // verbatim in `chat-panel.component.ts:53`).
  it('should NOT render any <gf-chat-panel> element (DEVIATION POINT — selector remains app-chat-panel)', () => {
    fixture.detectChanges();

    const wrongSelector = fixture.nativeElement.querySelector('gf-chat-panel');

    expect(wrongSelector).toBeNull();
  });

  // Phase 4.5 — Descriptor's `iconName` is `'chatbubbles-outline'`.
  // Defensive descriptor check that complements the wrapped-element
  // assertion. The descriptor's `iconName` is what the canvas's
  // `resolveIconName(item.name)` helper reads to bind onto the outer
  // `<gf-module-wrapper [iconName]>`, so any drift between the
  // descriptor and the catalog/header rendering would cascade through
  // the canvas — pinning the descriptor value here keeps the source
  // of truth honest.
  it('should expose iconName "chatbubbles-outline" on the registry descriptor', () => {
    expect(CHAT_MODULE_DESCRIPTOR.iconName).toBe('chatbubbles-outline');
  });

  // Phase 4.6 — Descriptor's `displayLabel` is the localized
  // `'AI Chat'` string. Mirrors the iconName assertion at the
  // descriptor level: the canvas's `resolveTitle(item.name)` reads
  // the descriptor's `displayLabel` and projects it onto the outer
  // `<gf-module-wrapper [title]>`. Pinning the value here ensures
  // the module-scope `CHAT_TITLE = $localize`AI Chat`` constant is
  // wired through to the descriptor without translation drift.
  it('should expose displayLabel as the localized "AI Chat" string on the registry descriptor', () => {
    expect(CHAT_MODULE_DESCRIPTOR.displayLabel).toBe('AI Chat');
  });

  // Phase 4.7 — Descriptor's `name` is `'chat'`. The stable
  // identifier discriminator used by `LayoutItem.moduleId` in
  // persisted layout documents and by
  // `ModuleRegistryService.getByName(name)` lookups. A rename here
  // would break every saved layout that references the chat module —
  // pinning the value at the test layer prevents accidental breakage.
  it('should expose name "chat" on the registry descriptor', () => {
    expect(CHAT_MODULE_DESCRIPTOR.name).toBe('chat');
  });
});
