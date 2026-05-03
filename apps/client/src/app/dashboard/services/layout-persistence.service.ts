import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, Subscription } from 'rxjs';
import { catchError, debounceTime, switchMap } from 'rxjs/operators';

import { LayoutData } from '../interfaces/layout-data.interface';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Debounce window in milliseconds applied to bursts of grid state-change
 * events emitted by `GfDashboardCanvasComponent`. The constant is declared
 * at module scope (rather than as a class field) so that test files can
 * import it directly via `jest.advanceTimersByTime(PERSISTENCE_DEBOUNCE_MS)`
 * if the export is later promoted, and so that the value cannot be mutated
 * per-instance — there is exactly one debounce window for the entire
 * application.
 *
 * **Source of truth**: AAP § 0.6.3.3 ("Layout save (PATCH) after grid
 * state change ≥ 500 ms debounce") and AAP § 0.8.5 ("layout save fires
 * on drag/resize/add/remove within 500 ms debounce"). The 500 ms window
 * collapses bursts (e.g., a drag-then-resize sequence) into a single
 * `PATCH /api/v1/user/layout` call at the END of the burst, satisfying
 * Rule 4 (AAP § 0.8.1.4) without flooding the server with redundant
 * writes.
 */
const PERSISTENCE_DEBOUNCE_MS = 500;

/**
 * Internal contract describing how the dashboard canvas hands off its
 * grid state-change stream to the persistence service. Intentionally NOT
 * exported — the type is a private compile-time contract between
 * `GfDashboardCanvasComponent` (the binder) and {@link
 * LayoutPersistenceService} (the bound service). If a future caller needs
 * to bind a different change source, the contract must be promoted in a
 * deliberate PR review rather than via incidental import.
 *
 * **Why a `layoutSelector` callback instead of an `Observable<LayoutData>`?**
 * The selector is invoked at save time (inside the `switchMap` callback,
 * AFTER the 500 ms debounce window has elapsed), NOT at bind time. By the
 * time the debounce window fires, the canvas's `gridster.dashboard` array
 * has settled on the final state, and the selector captures that final
 * state by closure. Modeling this as an `Observable<LayoutData>` would
 * either (a) emit every interim state and rely on `debounceTime` to drop
 * intermediate values — wasteful — or (b) require the canvas to do its
 * own coalescing — duplicating responsibility. The function-reference
 * indirection keeps the contract minimal and the responsibility cleanly
 * partitioned: the canvas owns "when state changed" and "what the current
 * state is"; the service owns "when to persist".
 *
 * @internal
 */
interface PersistenceBinding {
  /**
   * Cold or hot Observable that emits whenever the canvas grid state has
   * changed (drag stop, resize stop, item added, item removed). Values are
   * `void` — the emission is a pure signal; the actual layout snapshot is
   * retrieved at save time via {@link PersistenceBinding.layoutSelector}.
   *
   * The canvas typically backs this with an RxJS `Subject<void>` that it
   * `.next()`s from the gridster `itemChangeCallback`, `itemResizeCallback`,
   * and from its own add/remove handlers. The service does NOT make any
   * assumption about the underlying type beyond the `Observable<void>`
   * shape — Subject internals are out of scope per AAP § 0.8.1.2 (Rule 2,
   * single source of truth).
   */
  changes$: Observable<void>;

  /**
   * Synchronous accessor that returns the current {@link LayoutData}
   * snapshot at the moment the debounce window fires.
   *
   * **Invocation timing**: the selector is called INSIDE the `switchMap`
   * operator (i.e., after the 500 ms debounce window has elapsed), NOT at
   * bind time. The selector captures the canvas's mutable
   * `gridster.dashboard` array by closure, projected to the {@link
   * LayoutData} wire shape (`{ version: 1, items: LayoutItem[] }`).
   *
   * **Idempotency**: the selector should be a pure projection of the
   * current canvas state — calling it twice in a row with no intervening
   * change should yield equivalent payloads. The persistence service does
   * NOT memoize the selector's return value; the server-side `upsert`
   * (Decision D-019) is idempotent so duplicate identical PATCHes are
   * safe.
   */
  layoutSelector: () => LayoutData;
}

/**
 * **Debounced persistence orchestrator** for the per-user dashboard
 * layout. This service is the SOLE caller of
 * {@link UserDashboardLayoutService.update} per Rule 4 (AAP § 0.8.1.4) —
 * module wrapper components MUST NOT inject this service or
 * `UserDashboardLayoutService` to issue layout writes.
 *
 * **Pipeline shape**:
 *
 * ```
 *   binding.changes$
 *     .pipe(
 *       debounceTime(PERSISTENCE_DEBOUNCE_MS),       // collapse bursts
 *       switchMap(() =>
 *         userDashboardLayoutService                 // latest-wins
 *           .update(binding.layoutSelector())        // capture final state
 *           .pipe(catchError(() => EMPTY))           // swallow inner err
 *       ),
 *       takeUntilDestroyed(destroyRef)               // auto-cleanup
 *     )
 *     .subscribe();                                  // no error handler
 * ```
 *
 * **Operator rationale**:
 *
 * - `debounceTime(500)` — collapses bursts of grid state-change events
 *   (drag-then-resize, multi-item rearrangement) into a single PATCH at
 *   the END of the burst. The 500 ms window is mandated by AAP § 0.6.3.3
 *   (and reaffirmed by AAP § 0.8.5).
 * - `switchMap` (NOT `mergeMap` or `concatMap`) — when a NEW debounced
 *   burst arrives while a previous PATCH is still in flight, `switchMap`
 *   CANCELS the in-flight PATCH and starts a new one with the latest
 *   layout. This is the correct semantic because the latest grid state is
 *   the authoritative one — out-of-order PATCH responses (mergeMap) or
 *   queued writes (concatMap) would either corrupt server state or stall
 *   the pipeline behind a slow request.
 * - `catchError(() => EMPTY)` is applied INSIDE the `switchMap` callback
 *   (i.e., on the inner `update(...)` Observable) rather than on the
 *   outer pipeline. This is the critical detail of the v1 error-handling
 *   contract: per default RxJS semantics, an error emitted by the inner
 *   Observable would propagate UP through `switchMap` to the outer
 *   subscription and TERMINATE it — so all subsequent debounced bursts
 *   would be silently lost until the canvas was rebuilt. Swallowing
 *   inside `switchMap` converts the inner error into a benign
 *   `EMPTY`-completion, leaving the outer pipeline live and ready to
 *   process the next debounced burst. This guarantees Rule 4 spirit
 *   (AAP § 0.8.1.4) holds end-to-end: a transient PATCH failure does
 *   NOT silently disable persistence for the rest of the session.
 * - `takeUntilDestroyed(destroyRef)` — placed LAST in the pipe chain so
 *   that all upstream operators tear down cleanly when the binder
 *   component (the canvas) is destroyed. The service is `providedIn:
 *   'root'` (singleton, app-lifetime), but the binding's lifetime is
 *   the canvas's lifetime — we therefore explicitly accept a
 *   `DestroyRef` as a `bind(...)` parameter rather than relying on the
 *   service's own injection context.
 *
 * **Lifecycle**:
 *
 * - {@link bind} is called once by `GfDashboardCanvasComponent.ngAfterViewInit`
 *   with the canvas's grid state-change stream and a layout-selector
 *   callback. Re-binding (a second `bind(...)` call) silently disposes
 *   the previous subscription before creating a new one — supporting
 *   re-bind during tests without leaking subscriptions.
 * - {@link unbind} is an explicit cancellation hook for tests and for
 *   future use cases (e.g., temporarily suspending persistence during a
 *   server-driven layout reset). In production, `takeUntilDestroyed`
 *   already disposes the subscription when the canvas is destroyed —
 *   `unbind()` is a redundant safety mechanism.
 *
 * **Error handling**: errors are swallowed inside the `switchMap`
 * callback via `catchError(() => EMPTY)` on the inner `update(...)`
 * Observable. This guarantees the outer pipeline survives transient
 * inner failures and continues to react to subsequent debounced bursts —
 * the next grid state-change event triggers a fresh PATCH attempt
 * automatically, no manual recovery is required. The outer
 * `.subscribe()` therefore needs NO `error` handler. Auto-retry of the
 * SAME failed payload is intentionally NOT implemented (it would create
 * a feedback loop: failed save → grid state unchanged → no new event →
 * no retry), and surfacing the failure to the user is the canvas's
 * responsibility (AAP § 0.6.3 places the `MatSnackBar` toast in the
 * canvas's chrome, not the service's).
 *
 * **Rule 4 compliance** (AAP § 0.8.1.4): the public API is exactly
 * `bind(binding, destroyRef): void` and `unbind(): void`. There is NO
 * public `save(...)` or `persist(...)` method, and there is NO way to
 * trigger a layout write without going through the debounce pipeline.
 * Module wrapper components have no path to invoke
 * `userDashboardLayoutService.update(...)` directly through this service
 * — and they MUST NOT inject `UserDashboardLayoutService` directly per
 * the static check `grep -rn "UserDashboardLayoutService"
 * apps/client/src/app/dashboard/modules/` enforced during PR review.
 *
 * **DI scope**: declared with `providedIn: 'root'` so the service is a
 * singleton across the entire application (root-injector scope). Auto-
 * discoverable across the dashboard tree without explicit module
 * registration.
 *
 * @see AAP § 0.6.1.4 — Frontend service shape (the `bind`/`unbind`
 *   contract is AAP-mandated).
 * @see AAP § 0.6.3.3 — Performance Targets (500 ms debounce window).
 * @see AAP § 0.8.1.4 — Rule 4 (Persistence triggered ONLY by grid events).
 * @see AAP § 0.8.5 — Testing Requirements (the 500 ms debounce is a
 *   validation-criterion test scenario).
 * @see UserDashboardLayoutService — the sibling HTTP wrapper whose
 *   `update(...)` method is the SOLE side-effect this service triggers.
 */
@Injectable({
  providedIn: 'root'
})
export class LayoutPersistenceService {
  /**
   * Sibling HTTP wrapper that issues the actual `PATCH /api/v1/user/layout`
   * request. Acquired via the modern Angular 21 `inject()` idiom (matching
   * the pattern in `user-dashboard-layout.service.ts:105` — the project's
   * `@angular-eslint/prefer-inject` rule is disabled, so both styles are
   * permitted; `inject()` is preferred for new code per the precedent set
   * by the sibling service).
   *
   * Per Rule 4 (AAP § 0.8.1.4), `userDashboardLayoutService.update(...)`
   * is invoked exclusively from inside the `switchMap` callback of this
   * service's persistence pipeline — never from `bind(...)` itself, never
   * from `unbind()`, and never from any module wrapper component.
   */
  private readonly userDashboardLayoutService = inject(
    UserDashboardLayoutService
  );

  /**
   * Active persistence subscription, if any. The field exists primarily
   * to support {@link unbind} — without it, the service would have no
   * handle to cancel the active subscription except through the
   * binder's `DestroyRef`.
   *
   * **Why `Subscription | undefined` (not `Subscription | null`)?**
   * `undefined` is the project's idiomatic "absent" value for class
   * fields that have no initial value (mirrors `chat-panel.component.ts`
   * and other repository-wide patterns); `null` is reserved for explicit
   * "value is null" semantics from external APIs (e.g., the GET endpoint's
   * 404 → null translation in `UserDashboardLayoutService.get()`).
   *
   * The field is initially `undefined`. After {@link bind} runs it holds
   * the active `Subscription`. After {@link unbind} runs it is reset to
   * `undefined`. Re-binding (a second `bind(...)` call) replaces the
   * field with a new `Subscription` after disposing the previous one.
   */
  private subscription: Subscription | undefined;

  /**
   * Wires up the debounced persistence stream. Called once by
   * `GfDashboardCanvasComponent.ngAfterViewInit` with the canvas's grid
   * state-change Observable and a layout-selector callback.
   *
   * **Pipeline**:
   *
   * 1. Subscribes to `binding.changes$` (the canvas-emitted void stream).
   * 2. Pipes through `debounceTime(500)` to collapse bursts.
   * 3. After the debounce window elapses, invokes
   *    `binding.layoutSelector()` to capture the FINAL layout snapshot
   *    and feeds it into `userDashboardLayoutService.update(...)`.
   * 4. `switchMap` cancels any in-flight PATCH if a NEW debounced burst
   *    arrives — the latest grid state is the authoritative one (AAP
   *    § 0.6.3.3 SLO).
   * 5. `takeUntilDestroyed(destroyRef)` tears down the subscription when
   *    the binder component (the canvas) is destroyed.
   *
   * **Re-bind semantics**: if {@link bind} is called a second time
   * before {@link unbind} has been called, the previous subscription is
   * silently disposed before the new one is created. This supports
   * tests that re-bind without explicitly tearing down (and supports
   * the rare production case of canvas hot-reload during HMR).
   *
   * **Per Rule 4 (AAP § 0.8.1.4)**: this is the ONLY way to trigger
   * `userDashboardLayoutService.update(...)`. Module wrapper components
   * MUST NOT inject this service and MUST NOT call this method.
   *
   * **`takeUntilDestroyed(destroyRef)` rationale**: the persistence
   * service is `providedIn: 'root'` (singleton, app-lifetime), but the
   * binding's natural lifetime is the canvas component's lifetime. The
   * canvas therefore explicitly passes its own `DestroyRef` so that the
   * RxJS pipeline tears down on canvas destroy, not on app teardown.
   * `takeUntilDestroyed` is placed LAST in the pipe chain so it
   * correctly tears down all upstream operators (the debounce timer,
   * the in-flight `switchMap` HTTP call) when the canvas is destroyed.
   *
   * **Error handling**: errors are swallowed INSIDE the `switchMap`
   * callback via `catchError(() => EMPTY)` on the inner `update(...)`
   * Observable — see the class-level JSDoc for rationale. The outer
   * subscription survives inner failures and continues to react to
   * subsequent debounced bursts; the next grid-state change will
   * trigger a fresh PATCH attempt automatically. The outer
   * `.subscribe()` therefore needs NO `error` handler.
   *
   * @param binding The canvas's grid state-change stream and layout-
   *   selector callback. The binding's `changes$` Observable is
   *   subscribed exactly once; the binding's `layoutSelector` callback
   *   is invoked once per debounce-window completion.
   * @param destroyRef The binder component's `DestroyRef` — used by
   *   `takeUntilDestroyed` to tear down the pipeline on component
   *   destroy. The canvas typically obtains this via
   *   `inject(DestroyRef)` and passes it through.
   */
  public bind(binding: PersistenceBinding, destroyRef: DestroyRef): void {
    // Re-bind safety: dispose any previous active subscription before
    // creating a new one. Without this, a second `bind(...)` call would
    // leak the prior subscription. This branch is silent — re-binding is
    // a supported lifecycle.
    this.subscription?.unsubscribe();

    this.subscription = binding.changes$
      .pipe(
        // Collapse bursts of grid state-change events into a single
        // emission at the END of the 500 ms quiet window. Per AAP
        // § 0.6.3.3 — the constant is module-scoped above so the value
        // cannot drift across the codebase.
        debounceTime(PERSISTENCE_DEBOUNCE_MS),
        // `switchMap` (NOT `mergeMap` or `concatMap`) cancels any
        // in-flight PATCH when a new debounced burst arrives — latest-
        // wins semantic. `binding.layoutSelector()` is invoked HERE,
        // inside switchMap, so the captured snapshot reflects the
        // canvas state AT save time (end of debounce window), not at
        // bind time.
        //
        // `catchError(() => EMPTY)` is applied to the INNER `update(...)`
        // Observable (i.e., inside the `switchMap` callback) — NOT to
        // the outer pipeline. This is the v1 error-handling contract
        // (AAP § 0.8.1.4 Rule 4 spirit): per default RxJS semantics, an
        // error emitted by the inner Observable would propagate UP
        // through `switchMap` and terminate the OUTER subscription, so
        // every subsequent debounced burst would be silently lost until
        // the canvas was rebuilt. Swallowing inside `switchMap`
        // converts the inner error into a benign `EMPTY`-completion,
        // leaving the outer pipeline live and ready for the next
        // debounced burst. The next user-driven grid change therefore
        // triggers a fresh PATCH attempt automatically — no manual
        // recovery, no feedback loop. Auto-retry of the SAME failed
        // payload is intentionally not implemented; surfacing the
        // failure to the user is the canvas's responsibility (the
        // `MatSnackBar` toast lives in the canvas chrome, not in this
        // service's API surface).
        switchMap(() =>
          this.userDashboardLayoutService
            .update(binding.layoutSelector())
            .pipe(catchError(() => EMPTY))
        ),
        // MUST be the LAST operator in the pipe chain so it correctly
        // tears down all upstream operators (debounce timer, in-flight
        // switchMap HTTP call) when the canvas is destroyed.
        takeUntilDestroyed(destroyRef)
      )
      .subscribe();
  }

  /**
   * Cancels the active persistence subscription. Safe to call when no
   * subscription is active (initial state, post-destroy state, or after a
   * prior `unbind()` call) — the optional-chain `unsubscribe()` is a
   * no-op against `undefined`.
   *
   * **Use cases**:
   *
   * - **Tests**: enables explicit verification of subscription disposal
   *   without destroying the test fixture (which would also fire
   *   `takeUntilDestroyed`, conflating two cancellation paths).
   * - **Future server-driven layout reset**: if a future enhancement
   *   needs to temporarily suspend persistence (e.g., while applying a
   *   server-pushed layout that should NOT be re-persisted), `unbind()`
   *   provides a clean cancellation point.
   *
   * In normal production flow, `unbind()` is NOT required:
   * `takeUntilDestroyed(destroyRef)` already disposes the subscription
   * when the binder component (the canvas) is destroyed. `unbind()`
   * exists as a redundant safety mechanism, NOT as a primary cleanup
   * path.
   *
   * After `unbind()` returns, the internal {@link subscription} field
   * is reset to `undefined`; a subsequent {@link bind} call will create
   * a fresh subscription as if the service were newly constructed.
   */
  public unbind(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }
}
