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
import { debounceTime, map } from 'rxjs/operators';

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
 *   elapses (AAP § 0.7.2). The canvas additionally calls {@link flush} from
 *   its own `ngOnDestroy`; the root `DestroyRef` backstop here covers
 *   application teardown.
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
  private readonly persistTrigger$ = new Subject<void>();

  /**
   * `true` once a grid event has mutated the layout but the debounced persist
   * has not yet completed. Guards {@link flush} / {@link persistNow} so that a
   * teardown flush is a no-op when nothing changed, and is re-raised if a save
   * fails so the change is retried on the next event or flush.
   */
  private hasPendingChange = false;

  /**
   * Read-only view of the canonical grid items for the canvas to iterate and
   * bind to `<gridster-item [item]="...">`. Consumers MUST NOT mutate the
   * array or its items directly — all changes flow through {@link addItem},
   * {@link removeItem}, and {@link syncFromGrid} so persistence stays correct
   * (Rule 2). Declared after `itemsSignal` because the initializer eagerly
   * reads it (field initializers run in declaration order).
   */
  public readonly items = this.itemsSignal.asReadonly();

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
   * Loads the authenticated user's persisted layout into the signal.
   *
   * Emits `true` when a saved layout existed (returning user — the canvas
   * renders the hydrated modules) and `false` for a first-visit user with no
   * saved layout (the canvas renders a blank grid and auto-opens the module
   * catalog, Rule 10). Hydration MUST NOT schedule a persist (Rule 4), so a
   * freshly loaded layout is never immediately re-saved.
   */
  public hydrate(): Observable<boolean> {
    return this.dashboardLayoutService.get().pipe(
      map((layout) => {
        const items = layout?.items ?? [];
        this.itemsSignal.set(items.map((item) => this.toGridsterItem(item)));

        return items.length > 0;
      })
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
   * persistence (Rule 4). Called by the canvas from gridster's
   * `itemChangeCallback` / `itemResizeCallback`.
   *
   * gridster mutates the bound item objects in place (updating `x`/`y`/`cols`/
   * `rows` during drag/resize), so a new ARRAY reference is published to
   * notify signal consumers while the SAME item object references are retained
   * — gridster keeps its two-way binding to those exact objects, and removal
   * by reference in {@link removeItem} continues to work.
   */
  public syncFromGrid(): void {
    this.itemsSignal.set([...this.itemsSignal()]);
    this.schedulePersist();
  }

  /**
   * Sends the current layout to the server. Clears the pending flag optimistically
   * so concurrent grid events schedule a fresh save, and re-raises it on failure
   * so the change is retried on the next grid event or flush. HTTP errors are
   * swallowed here; surfacing them to the user (e.g. a `MatSnackBar`) is the
   * canvas/shell's concern, not the store's.
   */
  private persistNow(): void {
    if (!this.hasPendingChange) {
      return;
    }

    this.hasPendingChange = false;
    this.dashboardLayoutService
      .patch({ items: this.toLayoutItems() })
      .subscribe({
        error: () => {
          this.hasPendingChange = true;
        }
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
