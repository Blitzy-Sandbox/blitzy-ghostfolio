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
});
