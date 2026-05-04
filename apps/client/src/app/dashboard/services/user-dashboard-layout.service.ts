import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { UserDashboardLayout } from '@prisma/client';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { LayoutData } from '../interfaces/layout-data.interface';

/**
 * Server endpoint for the per-user dashboard layout document.
 *
 * Per AAP § 0.1.1 the global versioning prefix `/api/v1` and the
 * controller-level decorator `@Controller('user/layout')` on the new
 * `UserDashboardLayoutController` (`apps/api/src/app/user/user-dashboard-layout.controller.ts`)
 * compose to the absolute path `/api/v1/user/layout`. The constant is
 * declared at module scope (mirroring the `REBALANCING_ENDPOINT` pattern
 * at `apps/client/src/app/services/rebalancing.service.ts:33`) so that
 * both the `get()` and `update()` methods reference a single source of
 * truth — making any future endpoint relocation a single-line change.
 */
const LAYOUT_ENDPOINT = '/api/v1/user/layout';

/**
 * Client-side wrapper for the `GET` and `PATCH /api/v1/user/layout`
 * endpoint pair exposed by the new `UserDashboardLayoutController`
 * (`apps/api/src/app/user/user-dashboard-layout.controller.ts`).
 *
 * The service is the **sole entry point** for dashboard layout HTTP
 * communication on the client. It is a typed wrapper around
 * `HttpClient.get<UserDashboardLayout>(...)` and
 * `HttpClient.patch<UserDashboardLayout>(...)` that performs two
 * coordinated bridging duties between the wire format and the
 * canvas-facing public contract, plus the dashboard-specific
 * `404 Not Found` → `null` translation on the GET path that supports
 * the canvas's auto-open-catalog flow on first visit (Rule 10, AAP
 * § 0.8.1.10).
 *
 * **Wire format vs. public contract — bridging duties**:
 *
 * The server-side `UserDashboardLayoutController`
 * (`apps/api/src/app/user/user-dashboard-layout.controller.ts`)
 * exchanges the full `UserDashboardLayout` Prisma row on the wire (i.e.,
 * `{ userId, layoutData, createdAt, updatedAt }`) for both the GET
 * response and the PATCH response, and the `UpdateDashboardLayoutDto`
 * (`apps/api/src/app/user/dtos/update-dashboard-layout.dto.ts`)
 * requires the request body to be wrapped as `{ layoutData: ... }` so
 * the wrapper can be extended with future top-level PATCH-able fields
 * without breaking the persisted `layoutData` shape (defense-in-depth
 * per AAP § 0.7.1.5 / Decision D-012). The canvas, in contrast, has
 * always operated against the unwrapped {@link LayoutData} shape — its
 * `hydrateFromLayout(layout: LayoutData | null)` and `serializeLayout():
 * LayoutData` methods (in `dashboard-canvas.component.ts`) know nothing
 * about the row metadata. To keep the canvas's public surface stable
 * while honoring the server's wire format, this service:
 *
 *   - Types the inbound HTTP body as the full `UserDashboardLayout`
 *     row, then `map(...)`s it to `row.layoutData` BEFORE catchError —
 *     so subscribers (the canvas) see only the unwrapped {@link
 *     LayoutData}, never the row metadata.
 *   - On `update(...)`, accepts the unwrapped {@link LayoutData} from
 *     the caller (the persistence service), wraps it as
 *     `{ layoutData }` for the request body, and `map(...)`s the
 *     returned row back to its `layoutData` field — symmetrical
 *     unwrap.
 *
 * This bridging is internal to the service. The PUBLIC method
 * signatures `get(): Observable<LayoutData | null>` and
 * `update(layoutData: LayoutData): Observable<LayoutData>` remain
 * exactly what AAP § 0.6.1.4 mandates, so the canvas and persistence
 * code do NOT need to know about the wire format. A regression that
 * leaks the wire row to the canvas (e.g., dropping the `map(...)`)
 * would silently break Rule 10's returning-user hydration path
 * because `hydrateFromLayout` checks `layout?.items?.length` — and
 * the wire row does not have a top-level `items` field.
 *
 * **Structural template**: this service mirrors the shape of
 * `apps/client/src/app/services/financial-profile.service.ts` (the
 * explicit AAP-cited reference at § 0.6.1.4) for the 404→null
 * translation pattern, with the additional `map(row => row.layoutData)`
 * transform stage required by the dashboard endpoint's wire-format
 * contract. The constant-based endpoint URL pattern mirrors
 * `apps/client/src/app/services/rebalancing.service.ts`.
 *
 * **DI scope**: declared with `providedIn: 'root'` so the service is a
 * singleton across the entire application (root-injector scope). It is
 * therefore auto-discoverable across the dashboard tree without any
 * explicit module registration.
 *
 * **Authentication**: the existing `AuthInterceptor` at
 * `apps/client/src/app/core/auth.interceptor.ts` automatically attaches
 * the `Authorization: Bearer <token>` header to every `HttpClient`
 * request, so this service does NOT manage tokens manually. The
 * `HttpResponseInterceptor` at
 * `apps/client/src/app/core/http-response.interceptor.ts` handles
 * global error response side-effects (e.g., snackbar notifications for
 * 401, 403, 5xx) — this service's `catchError` handles only the
 * dashboard-specific 404→null mapping.
 *
 * **Rule 4 contract (AAP § 0.8.1.4 — Persistence triggered ONLY by
 * grid events)**: the {@link UserDashboardLayoutService.update}
 * method MUST be called exclusively by `LayoutPersistenceService` (a
 * sibling file under `apps/client/src/app/dashboard/services/`) after
 * its 500 ms debounce window collapses bursts of grid state-change
 * events. Module wrapper components MUST NOT inject
 * `UserDashboardLayoutService` and MUST NOT call `update(...)`
 * directly. Static check during PR review:
 * `grep -rn "UserDashboardLayoutService"
 * apps/client/src/app/dashboard/modules/` MUST produce zero matches.
 *
 * **Rule 10 contract (AAP § 0.8.1.10 — Catalog auto-opens on first
 * visit)**: the {@link UserDashboardLayoutService.get} method
 * translates HTTP 404 to a `null` emission so that
 * `GfDashboardCanvasComponent.ngOnInit` can use the `null` signal to
 * branch into the empty-canvas-with-auto-open-catalog flow. Other
 * HTTP errors propagate so the canvas can render the appropriate
 * error UI.
 *
 * @see apps/client/src/app/services/financial-profile.service.ts —
 *   structural template for the 404→null translation pattern.
 * @see apps/client/src/app/services/rebalancing.service.ts —
 *   structural template for the module-scoped endpoint URL constant
 *   pattern.
 * @see apps/client/src/app/dashboard/interfaces/layout-data.interface.ts —
 *   canonical wire and storage contract for the layout payload.
 * @see AAP § 0.6.1.4 — Backend service contract (HTTP method, URL,
 *   payload shape).
 * @see AAP § 0.6.1.7 — Persistence payload shape.
 * @see AAP § 0.8.1.4 — Rule 4 (Persistence triggered ONLY by grid
 *   events).
 * @see AAP § 0.8.1.10 — Rule 10 (Catalog auto-opens on first visit).
 */
@Injectable({
  providedIn: 'root'
})
export class UserDashboardLayoutService {
  /**
   * Typed Angular HTTP client — the registered `AuthInterceptor`
   * automatically attaches the JWT bearer token to every outbound
   * request, so this service does not manage authentication state.
   *
   * Acquired via the modern Angular 21 `inject()` idiom (matching the
   * pattern in `apps/client/src/app/app.component.ts:67-80`) rather
   * than constructor injection — the project's
   * `@angular-eslint/prefer-inject` rule is disabled, so both styles
   * are permitted; `inject()` is preferred for new code per the
   * `app.component.ts` precedent.
   */
  private readonly httpClient = inject(HttpClient);

  /**
   * Retrieves the authenticated user's saved dashboard layout from
   * `GET /api/v1/user/layout`.
   *
   * **Wire format vs. emitted shape**: the server-side controller
   * (`apps/api/src/app/user/user-dashboard-layout.controller.ts`)
   * returns the full `UserDashboardLayout` Prisma row
   * (`{ userId, layoutData, createdAt, updatedAt }`) on `200 OK`.
   * This method unwraps the row's `layoutData` field via a `map(...)`
   * operator BEFORE the `catchError` operator, so subscribers
   * (specifically `GfDashboardCanvasComponent.hydrateFromLayout`) see
   * only the unwrapped {@link LayoutData} document. The row metadata
   * (`userId`, `createdAt`, `updatedAt`) is intentionally discarded:
   * the canvas does not consume any of those fields, and the JWT
   * already authoritatively identifies the user. A regression that
   * leaks the row to the canvas would silently break Rule 10's
   * returning-user hydration path because `hydrateFromLayout` checks
   * `layout?.items?.length` — the row does not have a top-level
   * `items` field, so the canvas would always enter the empty-canvas
   * branch and re-open the catalog despite a populated DB row.
   *
   * **Return semantics**:
   *
   * - On HTTP `200 OK`: emits the unwrapped {@link LayoutData}
   *   document (the row's `layoutData` field). The canvas hydrates
   *   `gridster.dashboard` from `LayoutData.items` and renders the
   *   saved layout.
   * - On HTTP `404 Not Found`: emits `null` (NOT a thrown error).
   *   This is the "no record exists for this user" condition — i.e.,
   *   the user is visiting the dashboard for the first time. The
   *   canvas branches on `null` to render a blank canvas AND
   *   immediately invoke `MatDialog.open(GfModuleCatalogComponent,
   *   ...)` per Rule 10 (AAP § 0.8.1.10).
   * - On any other HTTP error (401, 403, 5xx, network failure, etc.):
   *   the error is re-thrown via `throwError(() => error)` so that
   *   downstream subscribers can render the appropriate error UI.
   *   Global error handling (e.g., snackbar notifications) is owned
   *   by `HttpResponseInterceptor` and is unaffected by this method's
   *   contract.
   *
   * **Operator ordering matters**: `map(row => row.layoutData)` MUST
   * appear BEFORE `catchError` in the pipe chain. If `catchError`
   * preceded `map`, a 200-with-malformed-body response would feed
   * `undefined` into `catchError` (which only inspects
   * `HttpErrorResponse`), bypassing the safety net entirely. Placing
   * `map` first guarantees the unwrap is part of the success path
   * only — error paths (404 → null, others → throw) operate on the
   * raw `HttpErrorResponse` exactly as before.
   *
   * **Why 404 → `null` (not thrown)**: collapsing the "happy path"
   * (saved layout present) and the "first visit" (no row yet) into a
   * single Observable that emits either a {@link LayoutData} or
   * `null` lets the canvas treat both as expected outcomes via a
   * trivial `if (layout === null)` branch. Throwing a 404 would force
   * the canvas to add an `errorHandler` solely to catch the expected
   * "no row" condition, conflating it with genuine error states.
   *
   * **Authentication**: the request is automatically authenticated
   * via the JWT bearer token attached by the registered
   * `AuthInterceptor`. Unauthenticated requests are rejected by the
   * server's `AuthGuard('jwt')` with HTTP `401 Unauthorized`, which
   * is propagated to the subscriber via `throwError(() => error)`
   * (it is NOT translated to `null` — only the 404 case is).
   *
   * @returns Cold Observable that, when subscribed, issues a single
   *   GET request to `/api/v1/user/layout` and emits exactly one of:
   *   the unwrapped {@link LayoutData} (extracted from the row's
   *   `layoutData` field on 200), or `null` (on 404), or an error
   *   (on any other failure).
   *
   * @see AAP § 0.8.1.10 — Rule 10 (the 404→null translation is the
   *   mechanism that supports the auto-open-catalog behavior).
   */
  public get(): Observable<LayoutData | null> {
    return this.httpClient.get<UserDashboardLayout>(LAYOUT_ENDPOINT).pipe(
      // The server returns the full UserDashboardLayout Prisma row;
      // unwrap to the canvas-facing LayoutData shape BEFORE catchError
      // so the success path emits only `LayoutData` and the error path
      // (404 → null, others → throw) is unaffected by the unwrap.
      // The cast `row.layoutData as LayoutData` reflects the runtime
      // contract: the server-side `UserDashboardLayoutService.upsertForUser`
      // persists exactly the `LayoutData` shape (validated by
      // `update-dashboard-layout.dto.ts` class-validator decorators), so
      // every persisted row's `layoutData` field IS a `LayoutData`
      // document. The `Prisma.JsonValue` static type is widened by the
      // JSON-column generator and cannot be narrowed at compile time
      // without a runtime guard — runtime validation is the server's
      // responsibility per AAP § 0.8.4 (defense-in-depth).
      map((row) => row.layoutData as unknown as LayoutData),
      catchError((error: HttpErrorResponse) => {
        if (error.status === 404) {
          // First-visit semantics per AAP § 0.6.3.1: no row exists
          // for this user yet. Emit `null` so the canvas can render
          // a blank canvas and auto-open the catalog (Rule 10).
          return of(null);
        }

        // Any other error (401, 403, 5xx, network failure, etc.) is
        // a genuine error condition that must propagate to the
        // subscriber. Use the factory form `() => error` per the
        // RxJS 7+ convention for `throwError`.
        return throwError(() => error);
      })
    );
  }

  /**
   * Persists the supplied dashboard layout via `PATCH /api/v1/user/layout`.
   *
   * **Wire format vs. accepted/emitted shape**: the server-side
   * `UpdateDashboardLayoutDto`
   * (`apps/api/src/app/user/dtos/update-dashboard-layout.dto.ts`)
   * requires the request body to be wrapped as `{ layoutData: ... }`
   * — NOT the unwrapped {@link LayoutData}. The wrapper exists for
   * forward-compatibility (future PATCH-able layout fields can be
   * added at the top level without breaking the persisted `layoutData`
   * shape) and for security defense-in-depth per AAP § 0.7.1.5 /
   * Decision D-012 (the wrapper prevents auto-mapping of unintended
   * top-level fields like a forged `userId` from a malicious request
   * body — though NestJS's `whitelist: true, forbidNonWhitelisted:
   * true` ValidationPipe configuration would also reject such fields
   * with HTTP 400). On the response side, the server returns the
   * upserted full `UserDashboardLayout` Prisma row
   * (`{ userId, layoutData, createdAt, updatedAt }`).
   *
   * This method bridges the wire format and the canvas-facing
   * contract symmetrically with {@link UserDashboardLayoutService.get}:
   *
   *   - The caller (`LayoutPersistenceService` per Rule 4) supplies
   *     the unwrapped {@link LayoutData}; this method wraps it as
   *     `{ layoutData }` for the request body.
   *   - The HTTP response is typed as the full `UserDashboardLayout`
   *     row; this method `map(...)`s it to its `layoutData` field
   *     and emits only the unwrapped {@link LayoutData} so the
   *     public emission shape matches the input shape.
   *
   * Wrapping vs. unwrapping is internal to this method — neither the
   * persistence service nor any other caller observes the wire row.
   * A regression that drops the `{ layoutData }` wrap would produce
   * HTTP 400 on every save (the DTO's `@IsObject() layoutData` field
   * would be missing), and would be silently swallowed by
   * `LayoutPersistenceService`'s `catchError(() => EMPTY)` operator —
   * the canvas would appear to work in-session but no data would
   * persist. The unit tests in `user-dashboard-layout.service.spec.ts`
   * pin BOTH the wrap-on-send and the unwrap-on-receive contracts so
   * a future refactor cannot regress without surfacing as a test
   * failure.
   *
   * **Idempotency contract** (Decision D-019, AAP § 0.6.2.1): the
   * server-side handler invokes `prisma.userDashboardLayout.upsert(...)`
   * keyed on `userId` (sourced authoritatively from the JWT — Engineering
   * Constraint Rule 5), so repeated PATCHes with the same payload
   * are safe and produce the same database row state. The PATCH does
   * NOT have a 404→null translation because a 404 from this endpoint
   * would indicate a server bug (the upsert always succeeds for an
   * authenticated user), not the "no record" condition that the GET's
   * 404 handles.
   *
   * **Rule 4 contract (AAP § 0.8.1.4 — Persistence triggered ONLY by
   * grid events)**: this method MUST be called **exclusively** by
   * `LayoutPersistenceService` after its 500 ms `debounceTime(...)`
   * window has collapsed a burst of grid state-change events
   * (drag-stop, resize-stop, item-added, item-removed) into a single
   * save. Module wrapper components MUST NOT inject this service and
   * MUST NOT call `update(...)` directly. Direct calls from module
   * wrappers would (a) bypass the debounce window — flooding the
   * server with redundant writes — and (b) couple module-internal
   * state to layout persistence, violating Rule 2 (grid state is the
   * single source of truth for module positions and sizes).
   *
   * **Authentication**: the request is automatically authenticated via
   * the JWT bearer token attached by the registered `AuthInterceptor`.
   * Unauthenticated requests are rejected by the server's
   * `AuthGuard('jwt')` with HTTP `401 Unauthorized`; permission-failed
   * requests (DEMO/INACTIVE roles per AAP § 0.4.1.5) are rejected with
   * HTTP `403 Forbidden`. Both errors propagate to the subscriber.
   *
   * **Payload validation**: client-side TypeScript only enforces the
   * structural shape of {@link LayoutData}; the server-side
   * `update-dashboard-layout.dto.ts` is the authoritative validator and
   * applies the per-field constraints documented in AAP § 0.6.1.7
   * (`version === 1`, `items.length <= 50`, `cols >= 2`, `rows >= 2`,
   * `x + cols <= 12`, etc.). The client DOES NOT duplicate or
   * re-validate the payload — that is the server's responsibility
   * (defense-in-depth posture per AAP § 0.8.4).
   *
   * @param layoutData The complete layout document to persist. The
   *   PATCH semantics are "replace the entire `layoutData` JSONB
   *   column", NOT "merge the supplied fields"; callers are expected
   *   to send the full {@link LayoutData} document on every save.
   * @returns Cold Observable that, when subscribed, issues a single
   *   PATCH request to `/api/v1/user/layout` (with the body wrapped
   *   as `{ layoutData }`) and emits the unwrapped upserted
   *   {@link LayoutData} document on `200 OK` (extracted from the
   *   server's row response), or an error on any failure.
   *
   * @see AAP § 0.6.1.7 — Persistence payload shape (server-side
   *   validation rules).
   * @see AAP § 0.8.1.4 — Rule 4 (this method is called ONLY by
   *   `LayoutPersistenceService`).
   * @see AAP § 0.6.2.1 — Backend service contract (idempotent upsert
   *   semantics).
   */
  public update(layoutData: LayoutData): Observable<LayoutData> {
    // Wrap the payload to match `UpdateDashboardLayoutDto`'s
    // `{ layoutData: LayoutDataPayload }` shape, then unwrap the
    // returned UserDashboardLayout row to the canvas-facing
    // LayoutData shape — symmetrical bridging with `get()` above.
    return this.httpClient
      .patch<UserDashboardLayout>(LAYOUT_ENDPOINT, { layoutData })
      .pipe(map((row) => row.layoutData as unknown as LayoutData));
  }
}
