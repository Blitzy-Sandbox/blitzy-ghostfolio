import { ChatMessage } from '@ghostfolio/common/interfaces';

import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `chat-panel.component.ts` declares
// `const STREAM_ERROR_MESSAGE = $localize\`...\`` at module scope, and
// the companion `chat-panel.component.html` template uses `i18n`
// attributes which the Angular compiler lowers to `$localize` tagged
// template calls. Without this side-effect import, simply importing
// the SUT class throws `ReferenceError: $localize is not defined`
// before any test even runs.
import '@angular/localize/init';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Observable, Subject } from 'rxjs';

import { AiChatService } from '../../services/ai-chat.service';
import { ChatPanelComponent } from './chat-panel.component';

/**
 * Test-double for {@link AiChatService}. Internally maintains a
 * `streamSubject` that is recreated on every `openStream(...)` call,
 * giving each individual test deterministic, synchronous control over
 * the SSE-stream lifecycle by invoking `streamSubject.next(...)`,
 * `streamSubject.error(...)`, or `streamSubject.complete()` directly.
 *
 * The Jest spies (`openStreamSpy`, `closeStreamSpy`) allow individual
 * tests to assert call counts and (via `openStreamSpy.mock.calls[i][0]`)
 * the messages payload sent by the component-under-test. The spies
 * deliberately omit a declared parameter to avoid
 * `@typescript-eslint/no-unused-vars` while still capturing call
 * arguments through Jest's built-in argument-capture machinery — this
 * mirrors the pattern established by the sibling
 * `financial-profile-form.component.spec.ts` file.
 */
class MockAiChatService {
  public closeStreamSpy = jest.fn();
  public openStreamSpy = jest.fn((): Observable<ChatMessage> => {
    this.streamSubject = new Subject<ChatMessage>();
    return this.streamSubject.asObservable();
  });
  public streamSubject: Subject<ChatMessage> = new Subject<ChatMessage>();

  public closeStream(): void {
    this.closeStreamSpy();
  }

  public openStream(messages: ChatMessage[]): Observable<ChatMessage> {
    return this.openStreamSpy(messages);
  }
}

describe('ChatPanelComponent', () => {
  let component: ChatPanelComponent;
  let fixture: ComponentFixture<ChatPanelComponent>;
  let mockAiChatService: MockAiChatService;

  beforeEach(async () => {
    mockAiChatService = new MockAiChatService();

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, NoopAnimationsModule],
      providers: [{ provide: AiChatService, useValue: mockAiChatService }]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be created', () => {
    expect(component).toBeTruthy();
  });

  it('should not render the reconnect button when errorMessage is empty', () => {
    expect(component.errorMessage()).toBe('');

    const reconnectButton = fixture.nativeElement.querySelector(
      'button[data-testid="reconnect-button"]'
    );

    expect(reconnectButton).toBeNull();
  });

  // Rule 6 (AAP § 0.7.1.6) — Test (a): Stream error handler sets
  // errorMessage to a truthy non-empty string.
  it('should set errorMessage to a non-empty string when the SSE stream errors', () => {
    component.inputText.set('Hello');
    component.onSend();

    expect(mockAiChatService.openStreamSpy).toHaveBeenCalled();

    mockAiChatService.streamSubject.error(new Error('Network failure'));
    fixture.detectChanges();

    expect(component.errorMessage()).toBeTruthy();
    expect(component.errorMessage().length).toBeGreaterThan(0);
    expect(component.isStreaming()).toBe(false);
  });

  // Rule 6 (AAP § 0.7.1.6) — Test (b): Reconnect button is conditionally
  // rendered ONLY when errorMessage is truthy.
  it('should render the reconnect button only when errorMessage is non-empty', () => {
    // Initially no error
    let reconnectButton = fixture.nativeElement.querySelector(
      'button[data-testid="reconnect-button"]'
    );
    expect(reconnectButton).toBeNull();

    // Trigger an SSE error to populate errorMessage
    component.inputText.set('Hello');
    component.onSend();
    mockAiChatService.streamSubject.error(new Error('Network failure'));
    fixture.detectChanges();

    reconnectButton = fixture.nativeElement.querySelector(
      'button[data-testid="reconnect-button"]'
    );
    expect(reconnectButton).not.toBeNull();
  });

  // Rule 6 (AAP § 0.7.1.6) — Test (c): Clicking the reconnect button
  // re-invokes aiChatService.openStream(...) and clears errorMessage on a
  // successful new stream open.
  it('should re-invoke openStream and clear errorMessage when reconnect is clicked', () => {
    // Drive the component into the error state
    component.inputText.set('Hello');
    component.onSend();
    mockAiChatService.streamSubject.error(new Error('Network failure'));
    fixture.detectChanges();

    expect(component.errorMessage()).toBeTruthy();

    const callsBeforeReconnect =
      mockAiChatService.openStreamSpy.mock.calls.length;

    // Locate the reconnect button rendered by the @if (errorMessage()) block
    const reconnectButton = fixture.nativeElement.querySelector(
      'button[data-testid="reconnect-button"]'
    ) as HTMLButtonElement;
    expect(reconnectButton).not.toBeNull();

    reconnectButton.click();
    fixture.detectChanges();

    // openStream MUST be called again
    expect(mockAiChatService.openStreamSpy.mock.calls.length).toBe(
      callsBeforeReconnect + 1
    );

    // errorMessage MUST be cleared on a successful new stream open
    expect(component.errorMessage()).toBe('');
  });

  it('should append the user message to the messages signal and clear inputText on send', () => {
    component.inputText.set('How are my holdings doing?');
    component.onSend();

    const messages = component.messages();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[messages.length - 1].role).toBe('user');
    expect(messages[messages.length - 1].content).toBe(
      'How are my holdings doing?'
    );
    expect(component.inputText()).toBe('');
  });

  it('should cap the messages array at 5 entries (4 prior turns + 1 new user turn) before sending', () => {
    // Seed with 5 prior messages — a 6th send should drop the oldest entry
    component.messages.set([
      { content: 'turn-1', role: 'user' },
      { content: 'turn-2', role: 'assistant' },
      { content: 'turn-3', role: 'user' },
      { content: 'turn-4', role: 'assistant' },
      { content: 'turn-5', role: 'user' }
    ]);
    component.inputText.set('turn-6');
    component.onSend();

    const messages = component.messages();
    // Per AAP § 0.5.1.1: client sends at most 5 entries (4 prior + new user turn)
    expect(messages.length).toBeLessThanOrEqual(5);
    // The new user turn MUST be the last entry
    expect(messages[messages.length - 1].content).toBe('turn-6');
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('should call aiChatService.closeStream when the component is destroyed', () => {
    fixture.destroy();
    expect(mockAiChatService.closeStreamSpy).toHaveBeenCalled();
  });

  // QA Checkpoint 11 Issue 2 regression guard — ensure non-assistant chunks
  // are NEVER appended to the messages signal. Without this defense, any
  // future protocol regression that allows the AiChatService to emit a raw
  // SSE frame (e.g. {type:'error',...}) would re-introduce the cascading
  // HTTP 400 bug where a malformed entry pollutes the conversation history
  // and is forwarded to the backend on the next user send, triggering
  // class-validator rejection.
  it('should ignore stream chunks that are not assistant ChatMessages', () => {
    component.inputText.set('Hello');
    component.onSend();

    const messageCountBeforeChunk = component.messages().length;

    // Simulate the buggy pre-fix behavior: the service emits a raw
    // discriminated-union frame instead of a translated ChatMessage. The
    // component MUST NOT append it to the messages signal.
    mockAiChatService.streamSubject.next({
      correlationId: 'fake-uuid',
      message: 'fake-error-payload',
      type: 'error'
    } as unknown as ChatMessage);

    fixture.detectChanges();

    expect(component.messages().length).toBe(messageCountBeforeChunk);

    // Also reject entries with a missing role or non-string content.
    mockAiChatService.streamSubject.next({} as unknown as ChatMessage);
    mockAiChatService.streamSubject.next({
      content: null
    } as unknown as ChatMessage);
    mockAiChatService.streamSubject.next({
      content: 'some text',
      role: 'user'
    } as ChatMessage);

    fixture.detectChanges();

    expect(component.messages().length).toBe(messageCountBeforeChunk);
  });

  it('should append a valid assistant chunk and merge subsequent chunks', () => {
    component.inputText.set('How are my holdings doing?');
    component.onSend();

    const userTurnIndex = component.messages().length - 1;

    // First assistant chunk creates a new entry
    mockAiChatService.streamSubject.next({
      content: 'Your portfolio ',
      role: 'assistant'
    });
    fixture.detectChanges();

    expect(component.messages().length).toBe(userTurnIndex + 2);
    expect(component.messages()[userTurnIndex + 1].content).toBe(
      'Your portfolio '
    );
    expect(component.messages()[userTurnIndex + 1].role).toBe('assistant');

    // Second assistant chunk merges into the existing assistant turn
    mockAiChatService.streamSubject.next({
      content: 'is up 4.2%.',
      role: 'assistant'
    });
    fixture.detectChanges();

    expect(component.messages().length).toBe(userTurnIndex + 2);
    expect(component.messages()[userTurnIndex + 1].content).toBe(
      'Your portfolio is up 4.2%.'
    );
  });

  // ------------------------------------------------------------------
  // Refine PR Directive 6 — Collapse / expand toggle.
  // ------------------------------------------------------------------

  describe('Directive 6 — collapse/expand toggle', () => {
    it('should default isCollapsed to false on instantiation', () => {
      expect(component.isCollapsed()).toBe(false);
    });

    it('should default panelWidth to 280 on instantiation', () => {
      expect(component.panelWidth()).toBe(280);
    });

    it('should expose hostWidth as `${panelWidth()}px` when expanded and `2.75rem` when collapsed', () => {
      // Default expanded state — host width should be the panelWidth in px.
      expect(component.hostWidth).toBe('280px');

      // Collapsed state — host width MUST be exactly '2.75rem' per the
      // directive's mandatory string contract.
      component.isCollapsed.set(true);
      expect(component.hostWidth).toBe('2.75rem');
    });

    it('should toggle isCollapsed between true and false on toggleCollapsed()', () => {
      expect(component.isCollapsed()).toBe(false);

      component.toggleCollapsed();
      expect(component.isCollapsed()).toBe(true);

      component.toggleCollapsed();
      expect(component.isCollapsed()).toBe(false);
    });

    it('should always render the toggle button (in both expanded and collapsed states)', () => {
      // Expanded state — button is rendered
      let toggleButton = fixture.nativeElement.querySelector(
        'button[data-testid="toggle-button"]'
      );
      expect(toggleButton).not.toBeNull();

      // Collapsed state — button MUST remain rendered (otherwise the user
      // could not re-expand the panel).
      component.isCollapsed.set(true);
      fixture.detectChanges();

      toggleButton = fixture.nativeElement.querySelector(
        'button[data-testid="toggle-button"]'
      );
      expect(toggleButton).not.toBeNull();
    });

    it('should hide all chat content (message list, input row, error banner) when collapsed', () => {
      // Sanity: in expanded state, the message list and input row are visible.
      let messageList = fixture.nativeElement.querySelector(
        '[data-testid="message-list"]'
      );
      let chatInput = fixture.nativeElement.querySelector(
        '[data-testid="chat-input"]'
      );
      expect(messageList).not.toBeNull();
      expect(chatInput).not.toBeNull();

      // Collapse the panel — chat content MUST be removed from the DOM.
      component.isCollapsed.set(true);
      fixture.detectChanges();

      messageList = fixture.nativeElement.querySelector(
        '[data-testid="message-list"]'
      );
      chatInput = fixture.nativeElement.querySelector(
        '[data-testid="chat-input"]'
      );
      expect(messageList).toBeNull();
      expect(chatInput).toBeNull();
    });

    it('should toggle isCollapsed when the toggle button is clicked', () => {
      const toggleButton = fixture.nativeElement.querySelector(
        'button[data-testid="toggle-button"]'
      ) as HTMLButtonElement;
      expect(toggleButton).not.toBeNull();

      expect(component.isCollapsed()).toBe(false);

      toggleButton.click();
      fixture.detectChanges();

      expect(component.isCollapsed()).toBe(true);

      toggleButton.click();
      fixture.detectChanges();

      expect(component.isCollapsed()).toBe(false);
    });

    it('should render a left-pointing chevron when collapsed and a right-pointing chevron when expanded', () => {
      // Expanded — chevron-right class is applied
      let chevron = fixture.nativeElement.querySelector('.chevron');
      expect(chevron).not.toBeNull();
      expect(chevron.classList.contains('chevron-right')).toBe(true);
      expect(chevron.classList.contains('chevron-left')).toBe(false);

      // Collapsed — chevron-left class is applied
      component.isCollapsed.set(true);
      fixture.detectChanges();

      chevron = fixture.nativeElement.querySelector('.chevron');
      expect(chevron).not.toBeNull();
      expect(chevron.classList.contains('chevron-left')).toBe(true);
      expect(chevron.classList.contains('chevron-right')).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Refine PR Directive 6 — Drag-resize handlers.
  // ------------------------------------------------------------------

  describe('Directive 6 — drag-to-resize', () => {
    it('should render the resize handle in expanded state', () => {
      const handle = fixture.nativeElement.querySelector(
        '[data-testid="resize-handle"]'
      );
      expect(handle).not.toBeNull();
    });

    it('should NOT render the resize handle in collapsed state', () => {
      component.isCollapsed.set(true);
      fixture.detectChanges();

      const handle = fixture.nativeElement.querySelector(
        '[data-testid="resize-handle"]'
      );
      expect(handle).toBeNull();
    });

    it('should update panelWidth when a drag is performed (mousedown -> mousemove)', () => {
      // Initial width is 280px. The chat panel sits on the right side of the
      // sidebar, so a leftward cursor delta INCREASES the panel width.
      expect(component.panelWidth()).toBe(280);

      component.onMouseDown(new MouseEvent('mousedown', { clientX: 1000 }));

      // Move the cursor 100px to the left → width grows by 100 → 380.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }));

      expect(component.panelWidth()).toBe(380);
    });

    it('should clamp panelWidth to a minimum of 200px during drag', () => {
      component.onMouseDown(new MouseEvent('mousedown', { clientX: 500 }));

      // Move the cursor 1000px to the right → naive width 280 - 1000 =
      // -720, clamped to 200.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1500 }));

      expect(component.panelWidth()).toBe(200);
    });

    it('should clamp panelWidth to a maximum of 600px during drag', () => {
      component.onMouseDown(new MouseEvent('mousedown', { clientX: 500 }));

      // Move the cursor 1000px to the left → naive width 280 + 1000 = 1280,
      // clamped to 600.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: -500 }));

      expect(component.panelWidth()).toBe(600);
    });

    it('should stop updating panelWidth after mouseup', () => {
      component.onMouseDown(new MouseEvent('mousedown', { clientX: 1000 }));

      // Drag to 380
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }));
      expect(component.panelWidth()).toBe(380);

      // Release the mouse — subsequent mousemove events MUST NOT update
      // panelWidth.
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: 900 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));

      // panelWidth MUST stay at 380 (unchanged after mouseup).
      expect(component.panelWidth()).toBe(380);
    });

    it('should NOT start a drag when the panel is collapsed (defense in depth)', () => {
      component.isCollapsed.set(true);

      const initialWidth = component.panelWidth();
      component.onMouseDown(new MouseEvent('mousedown', { clientX: 1000 }));

      // Even with a mousemove event, panelWidth must not update because
      // onMouseDown short-circuits when isCollapsed is true.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }));

      expect(component.panelWidth()).toBe(initialWidth);
    });

    it('should detach mousemove and mouseup listeners on component destroy (no-leak)', () => {
      // Start a drag to attach listeners
      component.onMouseDown(new MouseEvent('mousedown', { clientX: 1000 }));

      // Destroy the component — ngOnDestroy must call endDrag() to detach
      // the document-level listeners.
      fixture.destroy();

      // Subsequent mousemove events on the document MUST NOT throw or
      // affect the (now-destroyed) component's state.
      const widthBeforeMove = component.panelWidth();
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
      expect(component.panelWidth()).toBe(widthBeforeMove);
    });
  });

  // ------------------------------------------------------------------
  // Refine PR Directive 6 — No-persistence rule.
  // ------------------------------------------------------------------

  describe('Directive 6 — no persistence (component-instance scope only)', () => {
    it('should NOT read from localStorage on initialization', () => {
      // Even if localStorage contains a stale `isCollapsed = true` entry,
      // the new component instance must initialize with isCollapsed = false.
      try {
        localStorage.setItem('chat-panel.isCollapsed', 'true');
        localStorage.setItem('chatPanel.isCollapsed', 'true');
        localStorage.setItem('isCollapsed', 'true');
      } catch {
        // jsdom localStorage MAY not be available in all environments —
        // skip if so. The test assertion below remains valid regardless.
      }

      // Re-instantiate the component to simulate "navigating away and
      // returning" — Angular tears down and recreates the component on
      // each route change.
      const freshFixture = TestBed.createComponent(ChatPanelComponent);
      freshFixture.detectChanges();

      expect(freshFixture.componentInstance.isCollapsed()).toBe(false);
    });

    it('should NOT write to localStorage on toggleCollapsed()', () => {
      const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

      component.toggleCollapsed();
      component.toggleCollapsed();

      // setItem MUST NOT have been called with any chat-panel-related key.
      const calls = setItemSpy.mock.calls;
      const collapseRelatedCalls = calls.filter(([key]) => {
        return (
          typeof key === 'string' &&
          /chat[-.]?panel|isCollapsed|panelWidth/i.test(key)
        );
      });

      expect(collapseRelatedCalls.length).toBe(0);

      setItemSpy.mockRestore();
    });

    it('should NOT write to sessionStorage on toggleCollapsed()', () => {
      const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

      component.toggleCollapsed();
      component.toggleCollapsed();

      const calls = setItemSpy.mock.calls;
      const collapseRelatedCalls = calls.filter(([key]) => {
        return (
          typeof key === 'string' &&
          /chat[-.]?panel|isCollapsed|panelWidth/i.test(key)
        );
      });

      expect(collapseRelatedCalls.length).toBe(0);

      setItemSpy.mockRestore();
    });

    it('should reset isCollapsed to false on a fresh component instance (simulating re-navigation)', () => {
      // Collapse the current instance
      component.toggleCollapsed();
      expect(component.isCollapsed()).toBe(true);

      // Destroy and re-create — simulates navigating away from /portfolio
      // and back. The fresh instance MUST reset to expanded.
      fixture.destroy();

      const freshFixture = TestBed.createComponent(ChatPanelComponent);
      freshFixture.detectChanges();

      expect(freshFixture.componentInstance.isCollapsed()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Refine PR Directive 6 — No icon-font dependency.
  // ------------------------------------------------------------------

  describe('Directive 6 — pure CSS chevron (no icon font)', () => {
    it('should render the chevron as a <span> element (NOT <mat-icon> or <ion-icon>)', () => {
      const chevron = fixture.nativeElement.querySelector('.chevron');
      expect(chevron).not.toBeNull();
      expect(chevron.tagName.toLowerCase()).toBe('span');
    });

    it('should NOT contain any <mat-icon> elements anywhere in the template', () => {
      const matIcons = fixture.nativeElement.querySelectorAll('mat-icon');
      expect(matIcons.length).toBe(0);
    });

    it('should NOT contain any <ion-icon> elements anywhere in the template', () => {
      const ionIcons = fixture.nativeElement.querySelectorAll('ion-icon');
      expect(ionIcons.length).toBe(0);
    });
  });
});
