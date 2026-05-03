import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { LayoutData } from '../interfaces/layout-data.interface';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Unit-test spec for {@link UserDashboardLayoutService} — the
 * client-side `HttpClient` wrapper for the `GET` and `PATCH
 * /api/v1/user/layout` endpoints exposed by
 * `apps/api/src/app/user/user-dashboard-layout.controller.ts`.
 *
 * **Coverage objectives** (AAP § 0.8.5 — ≥ 80% line coverage):
 *
 *   - {@link UserDashboardLayoutService.get} happy path (HTTP 200).
 *   - {@link UserDashboardLayoutService.get} HTTP 404 → `null`
 *     translation — the contract that supports Rule 10 (catalog
 *     auto-opens on first visit, AAP § 0.8.1.10). This is the most
 *     important assertion in this spec because a regression here
 *     would silently break the new-user UX.
 *   - {@link UserDashboardLayoutService.get} non-404 error
 *     propagation — server errors are NOT translated to `null`. Two
 *     status codes are exercised distinctly: 500 (server-side) and
 *     401 (auth-side) so each error class has its own regression net.
 *   - {@link UserDashboardLayoutService.update} PATCH semantics —
 *     URL, method, body, and round-trip emission.
 *   - {@link UserDashboardLayoutService.update} edge case — empty
 *     `items` array (the "delete every module" scenario the canvas
 *     produces when the user removes all modules from the grid).
 *   - Observable laziness — neither `get()` nor `update(...)` issues
 *     an HTTP request before its returned Observable is subscribed.
 *     This guards the canvas's invariant that calling `service.get()`
 *     without subscribing is a no-op (e.g., when the canvas is
 *     short-circuited by a router-guard rejection before
 *     `ngOnInit`'s subscription fires).
 *
 * **Testing pattern** (AAP § 0.6.1.4): the spec uses the Angular 21
 * modern `provideHttpClient()` + `provideHttpClientTesting()`
 * functional providers in lieu of the legacy
 * `HttpClientTestingModule`. The legacy module is `@deprecated` per
 * the `@angular/common/http/testing` typings shipping with the
 * project's pinned `@angular/common@21.2.7`.
 *
 * **Type strictness**: every test variable is strongly typed
 * (`LayoutData | null | undefined`, `HttpErrorResponse | undefined`).
 * The `undefined` branch represents the "subscription has not yet
 * emitted" state and is distinct from `null` (which represents the
 * "service translated 404 to null" state); preserving the distinction
 * lets the 404 test (3.3) assert `received === null` AND the 500/401
 * tests (3.4 / 3.5) assert `received === undefined` — three
 * non-overlapping outcomes from the same `let received` declaration.
 *
 * **No `$localize` import**: the SUT does not declare any
 * `$localize`-tagged template literals (it is a pure HTTP wrapper),
 * so the side-effect import `'@angular/localize/init'` used by
 * `module-wrapper.component.spec.ts` and other component specs is
 * intentionally omitted here.
 *
 * @see apps/client/src/app/dashboard/services/user-dashboard-layout.service.ts —
 *   the System Under Test (SUT).
 * @see apps/client/src/app/dashboard/interfaces/layout-data.interface.ts —
 *   the wire/storage contract for the layout payload.
 * @see AAP § 0.6.1.4 — Frontend implementation approach (testing
 *   pattern requirement).
 * @see AAP § 0.8.1.10 — Rule 10 (the 404→null translation).
 * @see AAP § 0.8.5 — Testing requirements (≥ 80% line coverage).
 */

/**
 * Server endpoint URL — duplicated here as a test fixture rather
 * than imported from the SUT because the SUT keeps the constant
 * `LAYOUT_ENDPOINT` private at module scope (a deliberate
 * encapsulation choice). Duplicating it in the spec gives the test
 * an independent assertion point: if the SUT's URL ever drifts away
 * from `/api/v1/user/layout`, `httpMock.expectOne(ENDPOINT)` will
 * fail, surfacing the drift loudly. This mirrors the AAP § 0.6.1.4
 * test fixture pattern.
 */
const ENDPOINT = '/api/v1/user/layout';

/**
 * Representative non-empty layout fixture. Two items are sufficient
 * to verify that the service does NOT mutate the array order or the
 * per-item field shape during round-trip (it shouldn't — `HttpClient`
 * is a pass-through for typed JSON — but a two-item fixture pins the
 * invariant against future refactors that might inadvertently
 * introduce filtering or sorting).
 *
 * Field values are chosen to satisfy the server-side validation
 * rules documented in AAP § 0.6.1.7:
 *
 *   - `version === 1` (literal type enforced by the
 *     {@link LayoutData} interface).
 *   - `items.length` ≤ 50 (defensive cap).
 *   - Each `cols >= 2`, `rows >= 2` (global minimum item size).
 *   - Each `x + cols <= 12` (item fits within the 12-column grid).
 *
 * The two items are placed side-by-side on the top row at columns
 * `[0..6)` and `[6..12)` — a canonical "two-up" layout that mirrors
 * the canvas's blank-canvas-add-first-two-modules sequence.
 */
const SAMPLE_LAYOUT: LayoutData = {
  items: [
    {
      cols: 6,
      moduleId: 'portfolio-overview',
      rows: 4,
      x: 0,
      y: 0
    },
    {
      cols: 6,
      moduleId: 'holdings',
      rows: 4,
      x: 6,
      y: 0
    }
  ],
  version: 1
};

/**
 * Empty-layout fixture — represents the "delete every module on the
 * canvas" scenario. The {@link LayoutData.items} array is `[]` (length
 * 0) which satisfies the AAP § 0.6.1.7 lower-bound rule
 * (`items.length` ≥ 0). The `version` literal MUST still be `1` so
 * that the empty payload validates against the {@link LayoutData}
 * interface. Used by test 3.7 to verify the SUT does not short-circuit
 * the PATCH on an empty array (e.g., by returning a cached value).
 */
const EMPTY_LAYOUT: LayoutData = {
  items: [],
  version: 1
};

describe('UserDashboardLayoutService', () => {
  let service: UserDashboardLayoutService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    // Modern Angular 21 functional-provider testing pattern: the
    // legacy `HttpClientTestingModule` is `@deprecated` per the
    // typings shipped with `@angular/common@21.2.7`, and AAP § 0.6.1.4
    // explicitly mandates `provideHttpClient()` +
    // `provideHttpClientTesting()` for new specs. The order matters:
    // `provideHttpClient()` MUST be configured first so that the
    // testing provider can replace the runtime backend with the
    // mock.
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });

    // Resolve the SUT through Angular's dependency injection. This
    // exercises the SUT's `inject(HttpClient)` injection (line 105
    // of the SUT) — instantiating it via `new
    // UserDashboardLayoutService()` would bypass the DI tree and
    // fail because the `inject()` call requires an active injection
    // context.
    service = TestBed.inject(UserDashboardLayoutService);

    // Resolve the testing controller separately so individual tests
    // can call `httpMock.expectOne(...)`, `httpMock.expectNone(...)`,
    // and `httpMock.verify()`.
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Mandatory teardown: assert that every request issued during the
    // test was matched and resolved (`flush(...)` or `error(...)`).
    // An unmatched request indicates either (a) a test that subscribed
    // to a service Observable but forgot to flush, or (b) a SUT bug
    // that issued an unexpected secondary request. Both conditions
    // must surface as test failures, which `httpMock.verify()`
    // achieves by throwing on residual outstanding requests.
    httpMock.verify();
  });

  // ===========================================================
  // Test 3.1 — Smoke check: the service can be instantiated.
  // ===========================================================
  it('should be created', () => {
    // The TestBed-resolved instance is the single source of truth
    // for the SUT in every subsequent test. `toBeTruthy()` rejects
    // both `null` and `undefined` — the two failure modes for a
    // mis-registered injectable.
    expect(service).toBeTruthy();
  });

  // ===========================================================
  // Test 3.2 — `get()` happy path: HTTP 200 OK emits LayoutData.
  // ===========================================================
  it('should issue GET /api/v1/user/layout and emit the response body', () => {
    // The `received` declaration is `LayoutData | null | undefined`
    // because (a) `null` is a valid SUT emission (404 path), (b)
    // `undefined` represents the pre-emission state, and (c)
    // `LayoutData` is the happy-path emission. Distinguishing all
    // three states pins the assertion semantics for every `get()`
    // test in this file.
    let received: LayoutData | null | undefined;

    service.get().subscribe((value) => {
      received = value;
    });

    // The `expectOne` call asserts that EXACTLY one request was
    // issued to the endpoint. Two requests would indicate a SUT bug
    // (e.g., a duplicate subscription); zero requests would indicate
    // an Observable-laziness bug.
    const req = httpMock.expectOne(ENDPOINT);

    // Method-level assertion: the SUT MUST issue a GET, NOT a POST
    // / PATCH / etc. This is the contract with the server-side
    // `@Get()` decorator on `UserDashboardLayoutController`.
    expect(req.request.method).toBe('GET');

    // Resolve the request with HTTP 200 and the SAMPLE_LAYOUT body.
    // `flush()` synchronously delivers the body to the subscriber
    // (under jest-preset-angular's zone setup), so the `received`
    // variable is populated by the time control returns.
    req.flush(SAMPLE_LAYOUT);

    // The SUT MUST pass the body through unmodified. `toEqual` is a
    // structural deep-equality check (NOT reference equality) —
    // appropriate because `flush()` clones the body during JSON
    // serialization-deserialization.
    expect(received).toEqual(SAMPLE_LAYOUT);
  });

  // ===========================================================
  // Test 3.3 — `get()` 404 → null: supports Rule 10 auto-open.
  // ===========================================================
  // This is THE critical test in this spec. Per AAP § 0.8.1.10
  // (Rule 10) the catalog auto-opens on first visit when no saved
  // layout exists for the authenticated user. The mechanism that
  // implements Rule 10 is the SUT's 404→null translation — the
  // canvas branches on `null` to render a blank canvas AND open the
  // catalog. A regression here (e.g., the 404 starts propagating as
  // an error) would silently break the new-user UX without
  // necessarily breaking any other test, because the canvas would
  // simply emit an error state rather than the empty + auto-open
  // state.
  it('should translate HTTP 404 to null on get() (supports Rule 10 auto-open-catalog)', () => {
    let received: LayoutData | null | undefined;
    let errorReceived = false;

    service.get().subscribe({
      next: (value) => {
        received = value;
      },
      error: () => {
        // The error callback is wired up so that an accidental
        // error propagation surfaces as `errorReceived === true`,
        // which the assertion below explicitly rejects. This is a
        // stronger guarantee than just asserting on `received`,
        // because an Observable can in principle emit BOTH a value
        // AND an error (unlikely but possible if the SUT misuses
        // operators).
        errorReceived = true;
      }
    });

    const req = httpMock.expectOne(ENDPOINT);

    // Resolve the request as HTTP 404 with a `null` body. The SUT's
    // `catchError` operator catches the resulting `HttpErrorResponse`
    // and replaces the failed Observable with `of(null)`.
    req.flush(null, { status: 404, statusText: 'Not Found' });

    // The SUT MUST emit `null` (NOT throw). `toBeNull()` rejects
    // both `undefined` (pre-emission state — would indicate the
    // SUT swallowed the 404 silently) AND any non-null value (would
    // indicate the SUT mistakenly re-emitted the original error
    // body).
    expect(received).toBeNull();

    // The error callback MUST NOT have been invoked. If the SUT's
    // `catchError` were misconfigured (e.g., wrapped on the wrong
    // operator), the 404 would propagate as an error instead of
    // being translated to `null`. This assertion is the regression
    // tripwire for that scenario.
    expect(errorReceived).toBe(false);
  });

  // ===========================================================
  // Test 3.4 — `get()` 500 propagation: server errors NOT swallowed.
  // ===========================================================
  it('should propagate HTTP 500 errors on get()', () => {
    let received: LayoutData | null | undefined;
    let receivedError: HttpErrorResponse | undefined;

    service.get().subscribe({
      next: (value) => {
        received = value;
      },
      error: (err: HttpErrorResponse) => {
        // The argument is typed `HttpErrorResponse` so that the
        // assertions below can read `.status` without an `any` cast.
        // The SUT re-throws the original `HttpErrorResponse` via
        // `throwError(() => error)` so the error reaching this
        // callback IS the original Angular error envelope, not a
        // wrapped or transformed version.
        receivedError = err;
      }
    });

    const req = httpMock.expectOne(ENDPOINT);

    req.flush(null, { status: 500, statusText: 'Internal Server Error' });

    // The `next` callback MUST NOT have fired — the SUT MUST NOT
    // translate 500 to `null` (only 404 is translated). Asserting
    // `received === undefined` here pins the contract that the
    // 500 path does NOT collapse into the same branch as 404.
    expect(received).toBeUndefined();

    // The error MUST have been propagated. `toBeTruthy()` rejects
    // both `undefined` (pre-error state — would indicate the SUT
    // swallowed the 500) and `null` (would indicate the SUT
    // accidentally translated the 500 to `null` like the 404 path).
    expect(receivedError).toBeTruthy();

    // The propagated error MUST preserve the original 500 status.
    // The optional-chaining operator avoids a TypeScript error if
    // `receivedError` were `undefined`, but the prior `toBeTruthy()`
    // guarantees it is not.
    expect(receivedError?.status).toBe(500);
  });

  // ===========================================================
  // Test 3.5 — `get()` 401 propagation: auth errors are NOT
  // accidentally translated to null.
  // ===========================================================
  // The 401 case is asserted distinctly from 500 because the AAP
  // (§ 0.8.1.8 / Rule 8) requires that unauthenticated layout
  // requests return 401 to the caller. The canvas relies on this to
  // distinguish "no saved layout for this user" (404 → null →
  // auto-open catalog) from "user is not authenticated" (401 →
  // error → redirect to login). A regression that conflated 401
  // with 404 would silently log unauthenticated users into a
  // first-visit-style empty canvas — a security and UX bug.
  it('should propagate HTTP 401 errors on get() without translating to null', () => {
    let received: LayoutData | null | undefined;
    let receivedError: HttpErrorResponse | undefined;

    service.get().subscribe({
      next: (value) => {
        received = value;
      },
      error: (err: HttpErrorResponse) => {
        receivedError = err;
      }
    });

    const req = httpMock.expectOne(ENDPOINT);

    req.flush(null, { status: 401, statusText: 'Unauthorized' });

    // Same three-way invariant as test 3.4: `received` is
    // `undefined` (next callback NOT fired), `receivedError.status`
    // is exactly 401 (error propagated, status preserved).
    expect(received).toBeUndefined();
    expect(receivedError?.status).toBe(401);
  });

  // ===========================================================
  // Test 3.6 — `update()` happy path: PATCH issues correct request.
  // ===========================================================
  it('should issue PATCH /api/v1/user/layout with the supplied LayoutData body', () => {
    // `update()` returns `Observable<LayoutData>` (NOT
    // `LayoutData | null`) because there is no 404→null translation
    // on the PATCH path. Therefore `received` is typed as
    // `LayoutData | undefined` — only two states.
    let received: LayoutData | undefined;

    service.update(SAMPLE_LAYOUT).subscribe((value) => {
      received = value;
    });

    const req = httpMock.expectOne(ENDPOINT);

    // Method-level assertion: the SUT MUST issue a PATCH (NOT a
    // POST or PUT). PATCH semantics align with the server-side
    // idempotent upsert (Decision D-019 / AAP § 0.6.2.1) — the
    // server replaces the entire `layoutData` JSONB column on
    // every PATCH.
    expect(req.request.method).toBe('PATCH');

    // Body-level assertion: the SUT MUST forward the supplied
    // payload verbatim. A SUT bug that mutated, filtered, or
    // re-shaped the body before sending would surface here as a
    // structural inequality.
    expect(req.request.body).toEqual(SAMPLE_LAYOUT);

    // Resolve the PATCH with HTTP 200 and the (unchanged) body —
    // the server confirms the upserted document by echoing it back.
    req.flush(SAMPLE_LAYOUT);

    // Round-trip check: the SUT MUST emit the server's response
    // body. The server's contract is "PATCH returns the upserted
    // document on 200 OK" (AAP § 0.6.2.1).
    expect(received).toEqual(SAMPLE_LAYOUT);
  });

  // ===========================================================
  // Test 3.7 — `update()` empty layout: zero-item array is valid.
  // ===========================================================
  // The empty-array path is exercised distinctly because the AAP
  // § 0.6.1.7 server-side validation explicitly allows
  // `items.length === 0` (it is the lower bound of the `0..50`
  // range). The canvas produces an empty payload when the user
  // removes every module from the grid, and a regression that
  // short-circuits the PATCH on an empty array (e.g., a
  // "skip if empty" optimization) would silently break the
  // "delete all modules" UX.
  it('should issue PATCH with an empty layout (items array length 0)', () => {
    let received: LayoutData | undefined;

    service.update(EMPTY_LAYOUT).subscribe((value) => {
      received = value;
    });

    const req = httpMock.expectOne(ENDPOINT);

    expect(req.request.method).toBe('PATCH');

    // The body MUST contain the exact `EMPTY_LAYOUT` — most
    // importantly, an empty `items` array (length 0). A SUT bug
    // that sent `null`, `undefined`, or omitted the `items` field
    // entirely would surface here.
    expect(req.request.body).toEqual(EMPTY_LAYOUT);

    req.flush(EMPTY_LAYOUT);

    expect(received).toEqual(EMPTY_LAYOUT);
  });

  // ===========================================================
  // Test 3.8 — `get()` Observable laziness.
  // ===========================================================
  // RxJS Observables are cold by default — a `pipe(...)` chain
  // describes the request but does not execute it until subscribed.
  // The SUT relies on `HttpClient`, which is itself cold, so this
  // invariant should hold automatically. The test pins the contract
  // against a future refactor that might convert the SUT to a hot
  // observable (e.g., `shareReplay`, `BehaviorSubject`-backed) —
  // any such refactor would silently issue an HTTP request on
  // service injection, which would (a) violate the canvas's
  // assumption that `service.get()` without subscribing is a no-op
  // AND (b) trigger superfluous network traffic on every page
  // load.
  it('should NOT issue a request until the Observable is subscribed', () => {
    // Intentionally call `get()` and discard the returned
    // Observable — equivalent to "construct the request descriptor
    // but do not execute it". A correctly-implemented cold
    // Observable will issue zero HTTP requests in this scenario.
    service.get();

    // `expectNone` asserts that NO request was issued to the
    // endpoint. If the SUT were hot, this would throw with
    // "Expected zero matching requests, found 1". The afterEach's
    // `httpMock.verify()` is unaffected because it asserts on
    // *unmatched* requests — `expectNone` matches and rejects in
    // a single call.
    httpMock.expectNone(ENDPOINT);
  });

  // ===========================================================
  // Test 3.9 — `update()` Observable laziness.
  // ===========================================================
  // Same invariant as test 3.8 but for the PATCH path. Distinct
  // test case because PATCH and GET are independent operators on
  // `HttpClient` and a SUT bug could in principle affect one
  // without the other (e.g., a `tap(...)` operator added to
  // `update()` only). A separate test guards each operator.
  it('should NOT issue a PATCH request until the update() Observable is subscribed', () => {
    service.update(SAMPLE_LAYOUT);

    httpMock.expectNone(ENDPOINT);
  });
});
