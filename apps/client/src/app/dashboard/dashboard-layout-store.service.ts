import { DashboardLayoutItem } from '@ghostfolio/common/interfaces';

import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { GridsterItemConfig } from 'angular-gridster2';
import { Observable, Subject } from 'rxjs';
import { debounceTime, finalize, map } from 'rxjs/operators';

import { DashboardLayoutService } from './dashboard-layout.service';

/**
 * Debounce window (milliseconds) that coalesces a rapid burst of grid events
 * (a drag or resize fires many `itemChangeCallback` / `itemResizeCallback`
 * invocations) into a single `PATCH /api/v1/user/layout` request (Rule 4,
 * AAP § 0.7.2).
 */
const PERSIST_DEBOUNCE_MS = 500;

/**
 * Fallback minimum cell dimensions applied to a hydrated item that was
 * persisted without explicit per-item minimums. The floor of 2 enforces the
 * 2x2-minimum grid specification (Rule 6) even for legacy / hand-edited
 * layout payloads.
 */
const MINIMUM_ITEM_CELLS = 2;

/**
 * The canonical runtime shape held by the store: a `angular-gridster2`
 * {@link GridsterItemConfig} (which carries `x`/`y`/`cols`/`rows`, optional
 * `minItemCols`/`minItemRows`, and an open `[propName: string]: any` index
 * signature) narrowed with a required, string-typed `type` discriminator.
 *
 * `type` is the module-type key that maps 1:1 to a
 * `DashboardModuleDefinition.id` in `ModuleRegistryService`; the canvas
 * resolves the wrapper component to mount (via `NgComponentOutlet`) from this
 * key. Narrowing `type` to `string` (instead of inheriting `any` from the
 * gridster index signature) keeps the persistence conversions fully
 * type-safe. Every `DashboardGridItem` is structurally a `GridsterItemConfig`,
 * so items in this store bind directly to `<gridster-item [item]="...">`.
 */
type DashboardGridItem = GridsterItemConfig & { type: string };

/**
 * Signal-based single source of truth for the dashboard grid layout (Rule 2).
 *
 * Responsibilities:
 * - Owns the canonical, mutable `GridsterItemConfig[]` describing every module
 *   on the canvas (position + size + module-type key). Module wrapper
 *   components never hold layout state and never read/write this store's
 *   persistence path (Rule 1, Rule 4).
 * - Persistence is a strictly downstream side effect: the grid events
 *   add / remove / drag / resize schedule a ~500 ms debounced
 *   `PATCH /api/v1/user/layout` (Rule 4, AAP § 0.7.2). Hydration NEVER
 *   schedules a persist, so loading a saved layout does not immediately
 *   re-save it.
 * - Flushes any pending change on teardown so the final edit of a drag/resize
 *   burst is not lost when the user navigates away before the debounce window
 *   elapses (AAP § 0.7.2). Two teardown paths are covered:
 *     - In-app teardown (Angular destroy hooks) via {@link flush}: the canvas
 *       calls it from its own `ngOnDestroy` and the root `DestroyRef` backstop
 *       here calls it too. This issues the regular `HttpClient` `PATCH`.
 *     - Browser teardown (hard reload, tab close, bfcache eviction, tab
 *       backgrounding) via {@link flushOnUnload}, wired to `pagehide` /
 *       `visibilitychange` in {@link registerTeardownFlush}. The Angular hooks
 *       do NOT run in these cases, so this path uses a `keepalive` transport
 *       that survives the unloading document (fixes QA CP4-Issue1).
 *
 * The store is part of the grid layer (not a module wrapper), so importing the
 * gridster item type here is permitted — Rule 1 only forbids gridster imports
 * inside `modules/**` wrappers.
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardLayoutStoreService {
  /**
   * `true` while the canvas holds no modules. The canvas / catalog may read
   * this as a reactive alternative to the boolean emitted by {@link hydrate}
   * when deciding whether to auto-open the module catalog (Rule 10).
   */
  public readonly isEmpty = computed(() => this.itemsSignal().length === 0);

  private readonly dashboardLayoutService = inject(DashboardLayoutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly itemsSignal = signal<DashboardGridItem[]>([]);
  /**
   * `true` while the initial `GET /api/v1/user/layout` hydration request is in
   * flight. Backs the canvas's layout-fetch loading indicator (a
   * `MatProgressBar`), the affordance AAP § 0.3.2 anticipates for hydration
   * feedback. Set on entry to {@link hydrate} and cleared in that observable's
   * `finalize` (so it is reset on success, error, or unsubscribe).
   */
  private readonly loadingSignal = signal<boolean>(false);
  private readonly persistTrigger$ = new Subject<void>();

  /**
   * `true` once a grid event has mutated the layout but the debounced persist
   * has not yet completed. Guards {@link flush} / {@link persistNow} so that a
   * teardown flush is a no-op when nothing changed, and is re-raised if a save
   * fails so the change is retried on the next event or flush.
   */
  private hasPendingChange = false;

  /**
   * Serialized snapshot of the layout as the server currently has it — seeded by
   * {@link hydrate} to the freshly loaded layout and advanced by
   * {@link persistNow} on a successful save. It is the change-detection baseline
   * that makes persistence fire EXCLUSIVELY on genuine grid state changes
   * (Rule 4, AAP § 0.7.2).
   *
   * Rationale (fixes the hydration write-amplification, QA F-1): `angular-
   * gridster2` fires `itemChangeCallback` not only for user drags/resizes but
   * ALSO while it lays out the hydrated grid on load and whenever it reflows
   * (e.g. as asynchronous wrapped-module data arrives). Those callbacks carry
   * the SAME geometry the layout was hydrated with, so routing every one
   * straight to a debounced PATCH re-saved an unchanged layout on every page
   * load (churning `updatedAt`, up to ~6 redundant writes per load).
   * {@link syncFromGrid} now schedules a persist only when the serialized
   * layout actually differs from this baseline, so hydration/reflow are inert
   * while real edits (which change `x`/`y`/`cols`/`rows`) still persist.
   */
  private lastPersistedLayoutSnapshot: string | null = null;

  /**
   * Read-only view of the canonical grid items for the canvas to iterate and
   * bind to `<gridster-item [item]="...">`. Consumers MUST NOT mutate the
   * array or its items directly — all changes flow through {@link addItem},
   * {@link removeItem}, and {@link syncFromGrid} so persistence stays correct
   * (Rule 2). Declared after `itemsSignal` because the initializer eagerly
   * reads it (field initializers run in declaration order).
   */
  public readonly items = this.itemsSignal.asReadonly();

  /**
   * Read-only view of {@link loadingSignal} for the canvas to bind its
   * layout-fetch loading indicator to (`@if (store.loading())`). Declared after
   * `loadingSignal` because the initializer eagerly reads it (field
   * initializers run in declaration order).
   */
  public readonly loading = this.loadingSignal.asReadonly();

  public constructor() {
    // Single debounced persistence pipeline: every scheduled grid event pushes
    // onto `persistTrigger$`; `debounceTime` coalesces a drag/resize burst into
    // one PATCH (Rule 4). `takeUntilDestroyed()` (called here in the injection
    // context, so no explicit DestroyRef argument is required) tears the
    // subscription down with the service.
    this.persistTrigger$
      .pipe(debounceTime(PERSIST_DEBOUNCE_MS), takeUntilDestroyed())
      .subscribe(() => this.persistNow());

    // Backstop flush at (root) teardown so an edit made inside the final
    // debounce window is not lost; the canvas also flushes from its own
    // ngOnDestroy for component-level teardown / navigation (AAP § 0.7.2).
    this.destroyRef.onDestroy(() => this.flush());

    // Browser-teardown backstop (fixes QA CP4-Issue1). The Angular hooks above
    // do NOT fire on a hard browser reload or tab close, and the canvas is
    // hard-mounted so it is never destroyed in-app; a change made inside the
    // final debounce window before such an unload was therefore lost. Listen
    // for the browser lifecycle events that DO fire at teardown and flush via
    // a keepalive transport that survives the unload (see {@link flushOnUnload}).
    this.registerTeardownFlush();
  }

  /**
   * Appends a fully-formed grid item to the canvas and schedules persistence
   * (Rule 4). The module catalog builds the item from a registry definition
   * (id -> `type`, defaults -> `cols`/`rows`, minimums -> `minItemCols`/
   * `minItemRows`) and computes the next free position before calling this.
   */
  public addItem(item: DashboardGridItem): void {
    this.itemsSignal.set([...this.itemsSignal(), item]);
    this.schedulePersist();
  }

  /**
   * Immediately persists any pending change, bypassing the debounce. Called on
   * teardown / navigation (by the root `DestroyRef` backstop and by the
   * canvas's `ngOnDestroy`) so the final edit of a drag/resize burst survives
   * (AAP § 0.7.2). A no-op when nothing is pending.
   */
  public flush(): void {
    if (this.hasPendingChange) {
      this.persistNow();
    }
  }

  /**
   * Persists any pending change during page teardown (hard reload, tab close,
   * bfcache eviction, or the tab being backgrounded) using a transport that
   * survives the unloading document (fixes QA CP4-Issue1).
   *
   * Unlike {@link flush} — which issues the regular asynchronous `HttpClient`
   * `PATCH` the browser cancels the moment the document starts unloading — this
   * routes through {@link DashboardLayoutService.persistOnTeardown}, a
   * `keepalive fetch` the browser is allowed to complete after the page is
   * gone. It is invoked from the `pagehide` / `visibilitychange` listeners
   * registered in {@link registerTeardownFlush}.
   *
   * A no-op when nothing is pending. When a change is pending, the pending flag
   * is cleared and the persistence baseline advanced OPTIMISTICALLY (the
   * response cannot be observed during unload, so success is assumed) — but
   * ONLY if the request was actually dispatched. If `persistOnTeardown` reports
   * a no-op (e.g. unauthenticated), the change is left pending so the debounced
   * pipeline or a later flush still retries it. This mirrors the
   * clear-optimistically / re-raise-on-failure contract of {@link persistNow}.
   */
  public flushOnUnload(): void {
    if (!this.hasPendingChange) {
      return;
    }

    // Build the payload once so the body sent to the server and the snapshot
    // recorded as the new baseline are guaranteed identical (mirrors
    // `persistNow`).
    const items = this.toLayoutItems();
    const snapshot = JSON.stringify(items);

    if (this.dashboardLayoutService.persistOnTeardown({ items })) {
      // The keepalive request is in flight and will complete during unload;
      // adopt the sent layout as the baseline and clear the pending flag so a
      // subsequent teardown event (e.g. `visibilitychange` then `pagehide`)
      // and the still-pending debounce timer both become no-ops — avoiding a
      // duplicate save.
      this.hasPendingChange = false;
      this.lastPersistedLayoutSnapshot = snapshot;
    }
  }

  /**
   * Loads the authenticated user's persisted layout into the signal.
   *
   * Emits `true` when a saved layout existed (returning user — the canvas
   * renders the hydrated modules) and `false` for a first-visit user with no
   * saved layout (the canvas renders a blank grid and auto-opens the module
   * catalog, Rule 10). Hydration MUST NOT schedule a persist (Rule 4), so a
   * freshly loaded layout is never immediately re-saved.
   *
   * While the `GET /api/v1/user/layout` request is in flight, {@link loading}
   * is `true` so the canvas can render a layout-fetch loading indicator
   * (AAP § 0.3.2); it is cleared when the request settles (success, error, or
   * unsubscribe).
   */
  public hydrate(): Observable<boolean> {
    // F-2: raise the loading flag before the GET and lower it in `finalize`
    // (fires on success, error, or unsubscribe) so the canvas shows a
    // MatProgressBar during hydration (AAP § 0.3.2).
    this.loadingSignal.set(true);

    return this.dashboardLayoutService.get().pipe(
      map((layout) => {
        const items = layout?.items ?? [];
        this.itemsSignal.set(items.map((item) => this.toGridsterItem(item)));
        // Seed the persistence baseline to the freshly hydrated layout so the
        // `itemChangeCallback` gridster fires while laying out (and later
        // reflowing) this exact layout is recognized as "no change" and does
        // NOT schedule a persist (Rule 4, AAP § 0.7.2 — hydration must not
        // re-save). Genuine later edits change `x`/`y`/`cols`/`rows` and so
        // diverge from this baseline. Hydration itself still never calls
        // schedulePersist() (fixes the hydration write-amplification, QA F-1).
        this.lastPersistedLayoutSnapshot = this.serializeLayout();

        return items.length > 0;
      }),
      finalize(() => this.loadingSignal.set(false))
    );
  }

  /**
   * Publishes an in-place grid mutation to signal consumers WITHOUT scheduling
   * persistence. This is the non-persisting counterpart to {@link syncFromGrid}
   * and exists specifically for gridster's `itemInitCallback`, which fires as
   * each grid item is initialized during first render / hydration.
   *
   * Rule 4 requires layout persistence to be triggered EXCLUSIVELY by genuine
   * grid state-change events (drag, resize, add, remove). Item initialization
   * is neither — it is part of rendering a layout the store already holds — so
   * routing it through {@link syncFromGrid} would schedule a spurious debounced
   * `PATCH`, re-saving an unchanged layout on every page load and churning
   * `updatedAt` for returning users. This method therefore refreshes the signal
   * (so any position gridster resolved at init is reflected to consumers)
   * without marking the layout dirty or touching the persistence pipeline.
   */
  public publishFromGridWithoutPersist(): void {
    this.itemsSignal.set([...this.itemsSignal()]);
  }

  /**
   * Removes a module from the canvas and schedules persistence (Rule 4). The
   * canvas maps the module-shell remove action to this method, passing the
   * exact item reference it is currently rendering so identity-based removal
   * is reliable.
   */
  public removeItem(item: DashboardGridItem): void {
    this.itemsSignal.set(
      this.itemsSignal().filter((current) => current !== item)
    );
    this.schedulePersist();
  }

  /**
   * Publishes an in-place grid mutation to signal consumers and schedules
   * persistence ONLY when the layout actually changed (Rule 4). Called by the
   * canvas from gridster's `itemChangeCallback` / `itemResizeCallback` /
   * `itemRemovedCallback`.
   *
   * gridster mutates the bound item objects in place (updating `x`/`y`/`cols`/
   * `rows` during drag/resize), so a new ARRAY reference is published to
   * notify signal consumers while the SAME item object references are retained
   * — gridster keeps its two-way binding to those exact objects, and removal
   * by reference in {@link removeItem} continues to work.
   *
   * Persistence guard (Rule 4, AAP § 0.7.2, QA F-1): gridster fires
   * `itemChangeCallback` not only for user drags/resizes but ALSO while it lays
   * out the hydrated grid on load and whenever it reflows (e.g. as asynchronous
   * wrapped-module data arrives). Those callbacks carry the geometry the layout
   * was hydrated/last-saved with, so persisting unconditionally re-saved an
   * unchanged layout on every load. This method therefore schedules a persist
   * only when the serialized layout diverges from {@link lastPersistedLayoutSnapshot}:
   * hydration/reflow are inert (identical geometry), while a genuine edit
   * (changed `x`/`y`/`cols`/`rows`) diverges and persists.
   */
  public syncFromGrid(): void {
    this.itemsSignal.set([...this.itemsSignal()]);

    if (this.serializeLayout() !== this.lastPersistedLayoutSnapshot) {
      this.schedulePersist();
    }
  }

  /**
   * Sends the current layout to the server. Clears the pending flag optimistically
   * so concurrent grid events schedule a fresh save, advances the persistence
   * baseline ({@link lastPersistedLayoutSnapshot}) on success so later
   * hydration/reflow callbacks with the same geometry stay inert, and re-raises
   * the pending flag on failure (leaving the baseline unchanged) so the change
   * is retried on the next grid event or flush. HTTP errors are swallowed here;
   * surfacing them to the user (e.g. a `MatSnackBar`) is the canvas/shell's
   * concern, not the store's.
   */
  private persistNow(): void {
    if (!this.hasPendingChange) {
      return;
    }

    this.hasPendingChange = false;
    // Build the payload once so the body sent to the server and the snapshot
    // recorded as the new baseline are guaranteed identical.
    const items = this.toLayoutItems();
    const snapshot = JSON.stringify(items);
    this.dashboardLayoutService.patch({ items }).subscribe({
      next: () => {
        // The server now holds this layout — adopt it as the change-detection
        // baseline so subsequent identical grid callbacks do not re-persist
        // (Rule 4).
        this.lastPersistedLayoutSnapshot = snapshot;
      },
      error: () => {
        // Leave the baseline unchanged (the server still holds the previous
        // layout) and re-flag so a later grid event or flush retries the save.
        this.hasPendingChange = true;
      }
    });
  }

  /**
   * Registers the browser-lifecycle listeners that trigger a teardown flush
   * (fixes QA CP4-Issue1). Called once from the constructor. The listeners are
   * detached via the root `DestroyRef` so they never leak (e.g. across test
   * runs). No-op outside a browser (guards the DOM globals for SSR/unit tests).
   */
  private registerTeardownFlush(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    // `pagehide` is the reliable modern teardown signal: it fires on hard
    // reload, tab/window close, and bfcache eviction — the cases where the
    // Angular destroy hooks do NOT run. (`beforeunload` is unreliable and a
    // legacy `unload` listener would disqualify the page from the bfcache.)
    const onPageHide = () => this.flushOnUnload();

    // `visibilitychange` -> hidden covers backgrounding / app-switch teardown
    // (notably on mobile, where `pagehide` may not fire). It also fires just
    // before `pagehide` on a reload, which is harmless: `flushOnUnload` is
    // guarded by `hasPendingChange` and clears it on dispatch, so the paired
    // `pagehide` becomes a no-op rather than a duplicate save.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        this.flushOnUnload();
      }
    };

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    this.destroyRef.onDestroy(() => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  /**
   * Marks the layout dirty and pushes onto the debounced persistence pipeline.
   * Invoked exclusively by the grid-event mutators ({@link addItem},
   * {@link removeItem}, {@link syncFromGrid}) — never by {@link hydrate}
   * (Rule 4).
   */
  private schedulePersist(): void {
    this.hasPendingChange = true;
    this.persistTrigger$.next();
  }

  /**
   * Serializes the current layout to its JSON persistence shape for
   * change detection. Uses the same {@link toLayoutItems} projection sent in
   * the `PATCH` body, so the resulting string is directly comparable to
   * {@link lastPersistedLayoutSnapshot}. The projection emits a stable key
   * order and gridster mutates only `x`/`y`/`cols`/`rows` on reflow (never the
   * `type` / min-dimension fields), so two callbacks describing the same
   * geometry always produce byte-identical strings.
   */
  private serializeLayout(): string {
    return JSON.stringify(this.toLayoutItems());
  }

  /**
   * Maps a persisted {@link DashboardLayoutItem} to the runtime grid item,
   * defaulting `minItemCols` / `minItemRows` to the 2-cell floor (Rule 6) when
   * the payload omits them (e.g. legacy or hand-edited layouts).
   */
  private toGridsterItem(item: DashboardLayoutItem): DashboardGridItem {
    return {
      cols: item.cols,
      minItemCols: item.minItemCols ?? MINIMUM_ITEM_CELLS,
      minItemRows: item.minItemRows ?? MINIMUM_ITEM_CELLS,
      rows: item.rows,
      type: item.type,
      x: item.x,
      y: item.y
    };
  }

  /**
   * Projects the canonical grid items down to the JSON-serializable
   * {@link DashboardLayoutItem} persistence shape, dropping gridster's internal
   * runtime fields so only the layout-relevant properties are sent in the
   * `PATCH` body.
   */
  private toLayoutItems(): DashboardLayoutItem[] {
    return this.itemsSignal().map((item) => ({
      cols: item.cols,
      minItemCols: item.minItemCols,
      minItemRows: item.minItemRows,
      rows: item.rows,
      type: item.type,
      x: item.x,
      y: item.y
    }));
  }
}
