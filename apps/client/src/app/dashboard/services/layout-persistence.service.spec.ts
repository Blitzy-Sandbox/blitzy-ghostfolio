import { DestroyRef } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Observable, Subject, of } from 'rxjs';

import { LayoutData } from '../interfaces/layout-data.interface';
import { LayoutPersistenceService } from './layout-persistence.service';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Unit-test spec for {@link LayoutPersistenceService} — the **debounced
 * persistence orchestrator** that is the SOLE caller of
 * {@link UserDashboardLayoutService.update} per Rule 4 (AAP § 0.8.1.4).
 *
 * **Coverage objectives** (AAP § 0.8.5 — ≥ 80 % line coverage):
 *
 *   - {@link LayoutPersistenceService.bind} happy path — 500 ms
 *     debounce window collapses bursts into a single PATCH (AAP
 *     § 0.6.3.3).
 *   - {@link LayoutPersistenceService.bind} burst-collapse semantics —
 *     a continuous emission stream over 1 second produces EXACTLY ONE
 *     PATCH at the end of the final quiet window.
 *   - No-save-without-changes — when no `changes$` emission occurs,
 *     `update(...)` is never invoked and the layout selector is never
 *     called.
 *   - `switchMap` cancellation — when a new debounced burst arrives
 *     while a previous PATCH is still in flight, the in-flight PATCH
 *     is canceled (latest-wins semantic per AAP § 0.6.3.3).
 *   - {@link LayoutPersistenceService.unbind} disposal — after
 *     `unbind()`, subsequent `changes$` emissions trigger no PATCH.
 *   - Layout-selector invocation timing — the selector is called at
 *     SAVE time (inside `switchMap`), NOT at bind time. This pins the
 *     contract that the selector captures the FINAL canvas state by
 *     closure rather than the bind-time state.
 *   - Re-bind safety — calling `bind(...)` a second time before
 *     `unbind()` silently disposes the previous subscription.
 *   - Error-recovery contract — a failing PATCH does NOT throw
 *     uncaught (the `subscribe({ error })` handler swallows it per
 *     v1 contract). The error handler is intentionally a no-op for v1.
 *   - Synchronous-update completion — the pipeline completes cleanly
 *     when {@link UserDashboardLayoutService.update} returns a
 *     synchronous Observable (e.g., `of(...)`) — exercises the
 *     non-cancellation happy path.
 *
 * **Testing pattern** (AAP § 0.6.1.4): the spec uses Angular's
 * `fakeAsync` + `tick(...)` virtual-time mechanism to deterministically
 * advance the 500 ms debounce window WITHOUT real-time waits. Every
 * time-dependent test is wrapped in `fakeAsync(() => { ... })` so that
 * `tick(500)` synchronously flushes the debounce timer.
 *
 * The SUT collaborator {@link UserDashboardLayoutService} is replaced
 * via `useValue: { update: updateSpy }` rather than the real HTTP
 * service. This decouples the spec from `HttpClient` and from the
 * `/api/v1/user/layout` endpoint — those are covered by the sibling
 * `user-dashboard-layout.service.spec.ts`. Here we exercise ONLY the
 * debounce/switchMap pipeline.
 *
 * The mocked `update(...)` returns a fresh `Subject<LayoutData>`'s
 * Observable form, so each test can `next(...)`, `complete(...)`, or
 * `error(...)` the underlying Subject to drive the in-flight PATCH
 * lifecycle. Synchronous Observable returns (`of(SAMPLE_LAYOUT)`) are
 * deliberately AVOIDED for cancellation tests because synchronous
 * Observables complete before `switchMap` has a chance to cancel them
 * — see anti-pattern guidance in the agent prompt.
 *
 * **Type strictness**: every test variable is strongly typed
 * (`LayoutData`, `Subject<LayoutData>`, `jest.Mock<Observable<...>>`,
 * `DestroyRef`). No `any` types are used — the SUT's structural API
 * gives us all the type information we need.
 *
 * **No `$localize` import**: the SUT does not declare any
 * `$localize`-tagged template literals (it is a pure RxJS pipeline),
 * so the side-effect import `'@angular/localize/init'` used by
 * component specs is intentionally omitted here.
 *
 * @see apps/client/src/app/dashboard/services/layout-persistence.service.ts —
 *   the System Under Test (SUT).
 * @see apps/client/src/app/dashboard/services/user-dashboard-layout.service.ts —
 *   the mocked collaborator whose `update(...)` is the SUT's sole
 *   side-effect.
 * @see apps/client/src/app/dashboard/interfaces/layout-data.interface.ts —
 *   the wire/storage contract for the layout payload.
 * @see AAP § 0.6.1.4 — Frontend implementation approach.
 * @see AAP § 0.6.3.3 — Performance Targets (500 ms debounce window).
 * @see AAP § 0.8.1.4 — Rule 4 (Persistence triggered ONLY by grid
 *   events).
 * @see AAP § 0.8.5 — Testing requirements (≥ 80 % line coverage).
 */

/**
 * Representative non-empty layout fixture used as the canonical return
 * value of the mocked `layoutSelector` callback. The single-item layout
 * is sufficient because this spec exercises the SUT's pipeline
 * orchestration, NOT the structural shape of {@link LayoutData} — that
 * is covered by `user-dashboard-layout.service.spec.ts`. A single item
 * keeps the fixture minimal and the test diagnostics readable.
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

describe('LayoutPersistenceService', () => {
  /**
   * The System Under Test (SUT). Resolved via `TestBed.inject(...)` in
   * `beforeEach` so the SUT's `inject(UserDashboardLayoutService)` call
   * (line 192 of the SUT) wires up to the mocked provider below.
   */
  let service: LayoutPersistenceService;

  /**
   * Strongly-typed spy for the mocked
   * {@link UserDashboardLayoutService.update} method. The generic
   * parameters mirror the real signature: `Observable<LayoutData>` is
   * the return type, `[LayoutData]` is the parameter tuple. Tests
   * assert call counts (`toHaveBeenCalledTimes`), call arguments
   * (`toHaveBeenCalledWith`), and the in-flight Observable lifecycle.
   */
  let updateSpy: jest.Mock<Observable<LayoutData>, [LayoutData]>;

  /**
   * Subject backing the default mocked `update(...)` return value.
   * Tests use `updateSubject.next(SAMPLE_LAYOUT); updateSubject.complete()`
   * to resolve in-flight PATCHes after the debounce fires; tests that
   * exercise `switchMap` cancellation re-implement `updateSpy` to
   * return distinct Subjects for each call.
   *
   * Re-created in every `beforeEach` so per-test state never leaks.
   */
  let updateSubject: Subject<LayoutData>;

  /**
   * Subject backing the canvas's `changes$` Observable — `next()`
   * emissions on this subject drive the SUT's debounce/switchMap
   * pipeline. Re-created in every `beforeEach` so per-test state never
   * leaks.
   *
   * Typed `Subject<void>` because `changes$` carries a pure signal
   * (the actual layout snapshot is captured at save time via the
   * `layoutSelector` callback) — see the SUT's
   * `PersistenceBinding.changes$` JSDoc for the rationale.
   */
  let changesSubject: Subject<void>;

  /**
   * Spy for the `layoutSelector` callback passed to `bind(...)`. The
   * generic parameters declare it as a zero-argument function returning
   * {@link LayoutData} — matching the SUT's
   * `PersistenceBinding.layoutSelector` contract. Tests assert that the
   * spy is called EXACTLY once per debounce-window completion (NOT at
   * bind time) and that its return value flows into
   * `updateSpy.toHaveBeenCalledWith(SAMPLE_LAYOUT)`.
   */
  let layoutSelectorSpy: jest.Mock<LayoutData, []>;

  /**
   * Minimal {@link DestroyRef} stub. The real Angular `DestroyRef` has
   * private internal state that cannot be constructed outside an
   * injection context, so we provide a structural-shape stub with a
   * jest-spy `onDestroy`. Tests rely on `service.unbind()` for explicit
   * teardown rather than triggering `destroyRef`'s `onDestroy`
   * callback — this is acceptable in unit-test scope because the
   * `takeUntilDestroyed(destroyRef)` operator's primary cleanup path
   * (component destruction) is exercised in the canvas component spec,
   * not here.
   *
   * The `onDestroy` spy returns `undefined` (Jest's default for a
   * `jest.fn()`), which `takeUntilDestroyed` accepts as a valid
   * "no-op teardown" — see the inline `Observable` factory in
   * `@angular/core/rxjs-interop`'s `takeUntilDestroyed` source.
   *
   * The `as unknown as DestroyRef` cast is required because the
   * structural-shape stub does NOT carry the private fields of the real
   * `DestroyRef`; `unknown` is the idiomatic two-step cast that bypasses
   * structural type-checking without resorting to `any`.
   */
  let destroyRef: DestroyRef;

  beforeEach(() => {
    // Fresh per-test state — every spy and subject is reconstructed so
    // assertions in one test never leak into another. The SUT is
    // `providedIn: 'root'` (singleton), but Angular's TestBed resets the
    // root injector tree between tests, so `TestBed.inject(...)` below
    // returns a fresh service instance for each test.
    updateSubject = new Subject<LayoutData>();

    // Strongly-typed mock: the implementation returns
    // `updateSubject.asObservable()` — an Observable form of the
    // Subject. Each subscription to the returned Observable adds an
    // observer to the underlying Subject, which lets tests verify
    // `switchMap` cancellation by inspecting `updateSubject.observed`.
    //
    // The factory function intentionally declares NO parameters even
    // though the production `update(...)` signature accepts a
    // `LayoutData` — Jest captures the call arguments via its own
    // mock-call introspection (`updateSpy.mock.calls[i][0]`), and the
    // outer `jest.Mock<Observable<LayoutData>, [LayoutData]>` type
    // cast preserves the parameter-tuple typing for
    // `toHaveBeenCalledWith(SAMPLE_LAYOUT)` assertions. Declaring an
    // unused `_layoutData` parameter would trigger the project's
    // `@typescript-eslint/no-unused-vars` rule (caughtErrors-only
    // config — underscore prefix does NOT escape the rule). This
    // mirrors the parameter-less spy pattern at
    // `chat-panel.component.spec.ts:37` and
    // `financial-profile-form.component.spec.ts:95`.
    updateSpy = jest.fn(() => updateSubject.asObservable()) as jest.Mock<
      Observable<LayoutData>,
      [LayoutData]
    >;

    TestBed.configureTestingModule({
      providers: [
        // Replace the real HTTP-backed service with a structural mock
        // that exposes ONLY the `update(...)` method (the only method
        // the SUT consumes). The `useValue` form is appropriate here
        // because the mock has no constructor-injected dependencies of
        // its own.
        {
          provide: UserDashboardLayoutService,
          useValue: { update: updateSpy }
        }
      ]
    });

    // Resolve the SUT through Angular DI. This exercises the SUT's
    // module-level `inject(UserDashboardLayoutService)` call and binds
    // the mock above to the SUT's private
    // `userDashboardLayoutService` field. Direct `new
    // LayoutPersistenceService()` would throw because `inject(...)`
    // requires an active injection context.
    service = TestBed.inject(LayoutPersistenceService);

    changesSubject = new Subject<void>();
    layoutSelectorSpy = jest.fn(() => SAMPLE_LAYOUT);

    // Structural stub — see the field-level JSDoc for rationale.
    destroyRef = { onDestroy: jest.fn() } as unknown as DestroyRef;
  });

  afterEach(() => {
    // Mandatory teardown: unbind any active subscription so the next
    // test starts from a clean state. Even though TestBed resets the
    // injector between tests, RxJS subscriptions are NOT automatically
    // canceled by Angular's testing framework, so an in-flight
    // subscription from a prior test could leak into the next one.
    // `service.unbind()` is the explicit cancellation hook documented
    // in the SUT's `unbind()` JSDoc.
    service.unbind();

    // Reset spy call history so cross-test contamination is impossible
    // even if a future refactor introduces module-level shared state.
    jest.clearAllMocks();
  });

  // ===========================================================
  // Test 4.1 — Smoke check: the service can be instantiated.
  // ===========================================================
  it('should be created', () => {
    // The TestBed-resolved instance is the single source of truth for
    // the SUT in every subsequent test. `toBeTruthy()` rejects both
    // `null` and `undefined` — the two failure modes for a
    // mis-registered injectable.
    expect(service).toBeTruthy();
  });

  // ===========================================================
  // Test 4.2 — Debounce window: 3 rapid emissions cause ONE PATCH.
  // ===========================================================
  // AAP § 0.6.3.3: "Layout save (PATCH) after grid state change ≥ 500
  // ms debounce". This test pins the central debounce contract: three
  // emissions within the 500 ms window collapse into a single
  // `update(...)` call after the final quiet window has elapsed.
  it('should debounce 3 rapid grid-state changes into a single PATCH', fakeAsync(() => {
    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    changesSubject.next();
    tick(100);
    changesSubject.next();
    tick(100);
    changesSubject.next();

    // No save yet — only 200 ms have elapsed since the FIRST emission
    // and 0 ms since the LAST emission; the 500 ms quiet window has not
    // yet completed.
    expect(updateSpy).not.toHaveBeenCalled();

    // Advance past the 500 ms quiet window — the debounce now fires,
    // `switchMap` invokes `layoutSelector()` and pipes the result into
    // `updateSpy(...)`.
    tick(500);

    // Exactly ONE PATCH — the central assertion of this test.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(SAMPLE_LAYOUT);

    // Complete the in-flight PATCH so the `fakeAsync` zone has no
    // pending tasks at test end. Without this, `fakeAsync` would throw
    // "1 periodic timer(s) still in the queue" at zone teardown.
    updateSubject.next(SAMPLE_LAYOUT);
    updateSubject.complete();
  }));

  // ===========================================================
  // Test 4.3 — Burst collapse: continuous emissions over 1 second.
  // ===========================================================
  // Stress-test variant of test 4.2: ten emissions every 100 ms across
  // 1 second still produce EXACTLY ONE PATCH at the end. This pins the
  // contract that `debounceTime` resets the timer on every new emission
  // — a single emission storm cannot trigger multiple PATCHes.
  it('should collapse a continuous burst into a single PATCH after the final quiet window', fakeAsync(() => {
    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    // 10 emissions spaced 100 ms apart — no inter-emission gap exceeds
    // the 500 ms debounce window, so the timer is continuously reset.
    for (let i = 0; i < 10; i++) {
      changesSubject.next();
      tick(100);
    }

    // After the 1-second burst, no save has fired — every prior
    // emission reset the debounce timer. Only 100 ms have elapsed since
    // the LAST emission; the 500 ms quiet window has not yet completed.
    expect(updateSpy).not.toHaveBeenCalled();

    // Advance past the 500 ms quiet window — the debounce now fires
    // exactly once, with the FINAL layout snapshot (which is identical
    // to all interim snapshots in this test because `layoutSelectorSpy`
    // returns the same `SAMPLE_LAYOUT` constant on every call).
    tick(500);

    expect(updateSpy).toHaveBeenCalledTimes(1);

    updateSubject.next(SAMPLE_LAYOUT);
    updateSubject.complete();
  }));

  // ===========================================================
  // Test 4.4 — No save without changes: idle subscription.
  // ===========================================================
  // The SUT MUST NOT issue a save unless `changes$` emits. A bind
  // without subsequent emissions is a no-op for the persistence
  // pipeline. This pins Rule 4 (AAP § 0.8.1.4): persistence is
  // triggered EXCLUSIVELY by grid state-change events.
  it('should not call update() when no grid-state change has been emitted', fakeAsync(() => {
    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    // Advance virtual time well past the debounce window — without an
    // emission on `changes$`, the upstream operators have nothing to
    // process.
    tick(2000);

    // Neither the `update(...)` PATCH nor the layout selector was
    // invoked — the pipeline is idle.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(layoutSelectorSpy).not.toHaveBeenCalled();
  }));

  // ===========================================================
  // Test 4.5 — switchMap cancellation: latest-wins semantics.
  // ===========================================================
  // AAP § 0.6.3.3: "switchMap (NOT mergeMap or concatMap) cancels any
  // in-flight PATCH when a new debounced burst arrives — latest-wins
  // semantic". This test pins the cancellation contract by inspecting
  // the underlying Subject's `observed` getter:
  //
  //   - After the FIRST debounce fires and `switchMap` subscribes to
  //     the first inner Observable, the first Subject MUST report
  //     `observed === true`.
  //   - After the SECOND debounce fires and `switchMap` switches to
  //     the second inner Observable, the first Subject MUST flip to
  //     `observed === false` (switchMap unsubscribes from the prior
  //     inner Observable). The second Subject MUST then report
  //     `observed === true`.
  //
  // Synchronous Observables (`of(...)`) cannot exercise this contract
  // because they complete before `switchMap` has a chance to cancel
  // them — see the agent prompt's anti-pattern guidance.
  it('should cancel an in-flight PATCH via switchMap when a new debounced change arrives', fakeAsync(() => {
    // Two distinct Subjects, one per in-flight PATCH, so we can inspect
    // each one's observer count independently. `mockImplementation` is
    // cleaner than chained `mockReturnValueOnce(...)` calls when the
    // returned values share a common factory pattern.
    const firstUpdateSubject = new Subject<LayoutData>();
    const secondUpdateSubject = new Subject<LayoutData>();
    let updateCallCount = 0;

    updateSpy.mockImplementation(() => {
      updateCallCount++;
      return updateCallCount === 1
        ? firstUpdateSubject.asObservable()
        : secondUpdateSubject.asObservable();
    });

    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    // First burst → first PATCH starts after the 500 ms debounce.
    changesSubject.next();
    tick(500);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    // First PATCH is still in-flight — switchMap has subscribed to its
    // inner Observable but the Subject has not yet emitted or
    // completed. `.observed` is the RxJS 7+ getter that returns `true`
    // when at least one observer is currently subscribed.
    expect(firstUpdateSubject.observed).toBe(true);
    expect(secondUpdateSubject.observed).toBe(false);

    // Second burst → second PATCH starts; switchMap unsubscribes from
    // the first inner Observable (cancellation) and subscribes to the
    // second.
    changesSubject.next();
    tick(500);

    expect(updateSpy).toHaveBeenCalledTimes(2);
    // First Subject has been unsubscribed by switchMap — this is the
    // central cancellation assertion. If switchMap were replaced with
    // mergeMap or concatMap, this assertion would fail (mergeMap keeps
    // BOTH inner subscriptions alive; concatMap queues the second).
    expect(firstUpdateSubject.observed).toBe(false);
    // Second Subject is the active in-flight subscription.
    expect(secondUpdateSubject.observed).toBe(true);

    // Complete the second to clean up the fakeAsync zone — first is
    // already unsubscribed so calling `next/complete` on it would be a
    // no-op anyway.
    secondUpdateSubject.next(SAMPLE_LAYOUT);
    secondUpdateSubject.complete();
  }));

  // ===========================================================
  // Test 4.6 — `unbind()` stops the stream.
  // ===========================================================
  // The `unbind()` method is the explicit cancellation hook documented
  // in the SUT's JSDoc. After unbind, the subscription is disposed and
  // subsequent `changes$` emissions MUST NOT trigger any PATCH —
  // critical for tests, and a redundant safety mechanism for the
  // future server-driven layout-reset use case.
  it('should stop persisting after unbind() is called', fakeAsync(() => {
    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    // Dispose the subscription BEFORE any emission — the canvas's add
    // listener has not yet fired.
    service.unbind();

    // Emit on the (now-disposed) changes$ stream and advance past the
    // debounce window. The debounce timer never started because the
    // upstream subscription was already canceled.
    changesSubject.next();
    tick(500);

    // No PATCH — unbind() severed the pipeline before the emission
    // could propagate.
    expect(updateSpy).not.toHaveBeenCalled();
  }));

  // ===========================================================
  // Test 4.7 — Layout selector is invoked at SAVE TIME, not bind time.
  // ===========================================================
  // The SUT's `PersistenceBinding.layoutSelector` callback contract:
  // the selector is invoked INSIDE `switchMap` (i.e., AFTER the 500 ms
  // debounce window), NOT at bind time. This pins the contract that
  // the canvas's mutable `gridster.dashboard` is captured at save time
  // by closure — calling `bind(...)` alone with a stale dashboard does
  // NOT cause the stale snapshot to be persisted.
  it('should invoke the layoutSelector at save time, not at bind time', fakeAsync(() => {
    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    // No selector call yet — bind alone does not trigger save. If the
    // SUT incorrectly invoked `layoutSelector` at bind time (e.g., to
    // capture an "initial" snapshot), this assertion would fail.
    expect(layoutSelectorSpy).not.toHaveBeenCalled();

    changesSubject.next();

    // Still no selector call — the debounce window has not elapsed.
    // The selector is INSIDE `switchMap`, so it runs only after the
    // outer emission propagates past `debounceTime`.
    expect(layoutSelectorSpy).not.toHaveBeenCalled();

    tick(500);

    // Now the selector was invoked — exactly once, at save time. Its
    // return value (`SAMPLE_LAYOUT`) flowed into `update(...)`.
    expect(layoutSelectorSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(SAMPLE_LAYOUT);

    updateSubject.next(SAMPLE_LAYOUT);
    updateSubject.complete();
  }));

  // ===========================================================
  // Test 4.8 — Re-binding replaces the previous subscription.
  // ===========================================================
  // The SUT's `bind(...)` method documents the re-bind safety contract:
  // calling `bind(...)` a second time before `unbind()` silently
  // disposes the previous subscription. This supports tests that
  // re-bind (and the rare HMR case in production). The test verifies
  // that emissions on the FIRST `changes$` Observable are ignored
  // after re-bind, while emissions on the SECOND are processed.
  it('should replace the previous subscription when bind() is called again', fakeAsync(() => {
    const firstChanges = new Subject<void>();
    const secondChanges = new Subject<void>();

    service.bind(
      {
        changes$: firstChanges.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );
    // Re-bind WITHOUT calling unbind in between. The SUT's
    // `this.subscription?.unsubscribe()` line MUST silently dispose the
    // first subscription before creating the second.
    service.bind(
      {
        changes$: secondChanges.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    // Emissions on the FIRST subject are ignored — its subscription
    // was disposed by the re-bind.
    firstChanges.next();
    tick(500);

    expect(updateSpy).not.toHaveBeenCalled();

    // Emissions on the SECOND subject ARE processed — the new
    // subscription is active.
    secondChanges.next();
    tick(500);

    expect(updateSpy).toHaveBeenCalledTimes(1);

    updateSubject.next(SAMPLE_LAYOUT);
    updateSubject.complete();
  }));

  // ===========================================================
  // Test 4.9 — Failed PATCH: error handler is a no-op for v1.
  // ===========================================================
  // The SUT's class-level JSDoc documents the v1 error-handling
  // contract: the `subscribe({ error: () => {} })` handler is
  // intentionally a no-op. After an error, the inner sequence
  // terminates per RxJS semantics. This test pins the contract that
  // the error does NOT escape the subscription as an uncaught
  // exception — the test would crash if the SUT lacked the error
  // handler.
  //
  // The agent prompt explicitly notes that this assertion is
  // intentionally permissive (`>= 1`) to accommodate future retry
  // semantics without churning the test. The KEY invariant is that
  // the first PATCH attempt fired AND the error did not propagate as
  // an uncaught exception.
  it('should keep the test alive after a failed PATCH (error handler swallows the error)', fakeAsync(() => {
    const firstUpdate = new Subject<LayoutData>();
    const secondUpdate = new Subject<LayoutData>();
    let callCount = 0;

    updateSpy.mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? firstUpdate.asObservable()
        : secondUpdate.asObservable();
    });

    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    // First save fires after the debounce window.
    changesSubject.next();
    tick(500);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // Error the first in-flight PATCH. The SUT's `error: () => {}`
    // handler swallows the error — the test does NOT crash with an
    // uncaught exception. If the SUT lacked the error handler, RxJS
    // would propagate the error as an unhandled exception via
    // `EmptyError` or similar, failing this test.
    firstUpdate.error(new Error('network down'));

    // Second emission. Per default RxJS semantics, an errored
    // subscription terminates the whole chain — so this second
    // emission does not necessarily reach `updateSpy`. The assertion
    // below is intentionally permissive (`>= 1`) to accommodate the
    // current "swallow + don't recover" v1 contract AND a hypothetical
    // future retry strategy without churning the test.
    changesSubject.next();
    tick(500);

    // The KEY invariant: at least one save attempt fired. The exact
    // count is implementation-defined per the agent prompt's guidance.
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Defensive cleanup — even if the second subscription was never
    // active, calling `next/complete` on a Subject with no observers
    // is a safe no-op. If the second PATCH did fire, this also drains
    // the fakeAsync zone.
    secondUpdate.next(SAMPLE_LAYOUT);
    secondUpdate.complete();
  }));

  // ===========================================================
  // Test 4.10 — Synchronous update() Observable completes cleanly.
  // ===========================================================
  // Coverage complement to test 4.5 (which used Subjects to exercise
  // `switchMap` cancellation). This test verifies the non-cancellation
  // happy path: when `update(...)` returns a synchronously-completing
  // Observable (e.g., `of(SAMPLE_LAYOUT)`), the pipeline still fires
  // the PATCH exactly once after the debounce window — no leaked
  // subscriptions, no double-firing.
  //
  // The synchronous-Observable variant exists in production whenever a
  // future caching layer or a test-double returns `of(...)`; pinning
  // this contract guards against a regression where `switchMap`'s
  // synchronous-completion semantics are subtly broken by future
  // refactors of the SUT pipeline.
  it('should complete the save pipeline cleanly when update() returns a synchronous Observable', fakeAsync(() => {
    // Replace the Subject-backed mock with a synchronous `of(...)` —
    // this completes immediately when subscribed, exercising the
    // non-cancellation path through `switchMap`.
    updateSpy.mockImplementation(() => of(SAMPLE_LAYOUT));

    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    changesSubject.next();
    tick(500);

    // Exactly one PATCH — the synchronous Observable completed inside
    // `switchMap` without leaking any pending tasks.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(SAMPLE_LAYOUT);
    expect(layoutSelectorSpy).toHaveBeenCalledTimes(1);
  }));

  // ===========================================================
  // Test 4.11 — `unbind()` is safe before any `bind()` call.
  // ===========================================================
  // Defensive coverage of the SUT's `unbind()` JSDoc: "Safe to call
  // when no subscription is active". The SUT uses optional-chaining
  // (`this.subscription?.unsubscribe()`) which is a no-op against
  // `undefined`. This test pins that contract so a future refactor
  // that removes the optional chain would surface as a test failure.
  it('should not throw when unbind() is called before any bind()', () => {
    expect(() => service.unbind()).not.toThrow();
  });

  // ===========================================================
  // Test 4.12 — `unbind()` is idempotent.
  // ===========================================================
  // Defensive coverage: calling `unbind()` twice in a row MUST NOT
  // throw, AND MUST leave the service in a re-bindable state. The SUT
  // resets `this.subscription = undefined` after each `unbind()`, so a
  // second call's optional-chain is a no-op. A subsequent `bind(...)`
  // creates a fresh subscription that processes emissions normally.
  it('should support a second unbind() and a subsequent bind()', fakeAsync(() => {
    service.bind(
      {
        changes$: changesSubject.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    service.unbind();
    // Second unbind: must not throw — the optional-chain is a no-op
    // against the now-undefined subscription field.
    expect(() => service.unbind()).not.toThrow();

    // Re-bind after a double-unbind — emissions are processed normally
    // because the SUT created a fresh subscription.
    const newChanges = new Subject<void>();
    service.bind(
      {
        changes$: newChanges.asObservable(),
        layoutSelector: layoutSelectorSpy
      },
      destroyRef
    );

    newChanges.next();
    tick(500);

    expect(updateSpy).toHaveBeenCalledTimes(1);

    updateSubject.next(SAMPLE_LAYOUT);
    updateSubject.complete();
  }));
});
