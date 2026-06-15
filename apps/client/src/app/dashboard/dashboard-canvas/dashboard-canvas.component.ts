import { DashboardLayoutService } from '@ghostfolio/client/dashboard/dashboard-layout.service';
import {
  DashboardItem,
  MODULE_DRAG_DATA_TYPE
} from '@ghostfolio/client/dashboard/dashboard.types';
import { GfModuleCatalogComponent } from '@ghostfolio/client/dashboard/module-catalog/module-catalog.component';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';
import {
  LayoutData,
  UserDashboardLayoutPatchPayload
} from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  OnInit,
  signal,
  viewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  Gridster,
  GridsterConfig,
  GridsterItem,
  GridType
} from 'angular-gridster2';

/**
 * Fixed pixel height of a single grid row. Paired with `GridType.Fixed`, it
 * yields a deterministic, non-responsive cell size.
 */
const FIXED_ROW_HEIGHT = 50;

/**
 * The canvas is a fixed 12-column grid. `minCols` and `maxCols` are both pinned
 * to this value so the grid never reflows to a different column count.
 */
const GRID_COLUMNS = 12;

/**
 * Schema version stamped onto every persisted {@link LayoutData} payload so the
 * stored JSONB layout can evolve without ambiguity on read-back.
 */
const LAYOUT_SCHEMA_VERSION = 1;

/**
 * Global minimum module width and height in grid cells (a 2×2 floor). The grid
 * engine enforces these and rejects below-minimum resize attempts. A module's
 * registry definition may raise (never lower) these per-item minimums.
 */
const MIN_ITEM_COLS = 2;
const MIN_ITEM_ROWS = 2;

/**
 * `GfDashboardCanvasComponent` — the single-canvas root grid component for the
 * Ghostfolio modular dashboard.
 *
 * Lazy-loaded at the single `path: ''` route, it is the architectural heart of
 * the feature and the integration point of the four sibling contracts
 * (`DashboardLayoutService`, `ModuleRegistryService`, `GfModuleCatalogComponent`
 * and the shared `LayoutData` interfaces). Responsibilities:
 *
 * - **Owns the authoritative grid state.** {@link dashboard} (a plain
 *   `DashboardItem[]`) is the single source of truth for module positions and
 *   sizes; the placed module components hold no layout state of their own.
 * - **Renders modules generically.** Each grid item is rendered through
 *   `*ngComponentOutlet`, resolving the wrapper component at runtime via
 *   {@link ModuleRegistryService.get}. The canvas imports no wrapper and no
 *   feature component, preserving module isolation.
 * - **Drives grid-event-driven persistence.** Drag, resize, add and remove are
 *   the only events that persist the layout, always through
 *   {@link DashboardLayoutService.queueSave} (debounced 500 ms upstream). No
 *   other code path saves, and module components never call save directly.
 * - **Handles first-visit onboarding.** When the persisted layout `get()`
 *   resolves to `null`, the canvas starts blank and auto-opens the catalog.
 *
 * The component is `OnPush`; because {@link dashboard} is a plain array (not a
 * signal), every mutation reassigns the array reference and calls
 * `markForCheck()` so the view re-renders deterministically.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(dragover)': 'onDragOver($event)',
    '(drop)': 'onDrop($event)'
  },
  imports: [
    CommonModule,
    GfModuleCatalogComponent,
    Gridster,
    GridsterItem,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule
  ],
  selector: 'gf-dashboard-canvas',
  styleUrls: ['./dashboard-canvas.component.scss'],
  templateUrl: './dashboard-canvas.component.html'
})
export class GfDashboardCanvasComponent implements OnInit {
  /**
   * Single source of truth for the placed modules and their geometry. Rendered
   * by the template's `@for` loop (tracked by `moduleKey`). Always reassigned —
   * never mutated in place — so the `OnPush` view picks up changes.
   */
  public dashboard: DashboardItem[] = [];

  /**
   * Becomes `true` once the asynchronous layout `get()` resolves. The template
   * gates the catalog behind `@if (isInitialized())`, so the catalog is created
   * only after {@link shouldAutoOpenCatalog} holds its final value — making the
   * first-visit auto-open deterministic in both production (async HTTP) and unit
   * tests (synchronous `of(...)`).
   */
  public isInitialized = signal(false);

  /**
   * Static `angular-gridster2` configuration: a fixed 12-column grid with a
   * constant row height, a global 2×2 minimum item size, and drag/resize
   * enabled. Both drag-end ({@link GridsterConfig.itemChangeCallback}) and
   * resize-end ({@link GridsterConfig.itemResizeCallback}) are wired to
   * {@link persistLayout} via zero-parameter arrows so they capture `this`.
   * Dragging is initiated only from the module header handle
   * (`gf-module-drag-handle`); `ignoreContent` keeps the wrapped feature
   * component interactive.
   */
  public options: GridsterConfig = {
    draggable: {
      dragHandleClass: 'gf-module-drag-handle',
      enabled: true,
      ignoreContent: true
    },
    fixedRowHeight: FIXED_ROW_HEIGHT,
    gridType: GridType.Fixed,
    itemChangeCallback: () => this.persistLayout(),
    itemResizeCallback: () => this.persistLayout(),
    maxCols: GRID_COLUMNS,
    minCols: GRID_COLUMNS,
    minItemCols: MIN_ITEM_COLS,
    minItemRows: MIN_ITEM_ROWS,
    resizable: {
      enabled: true
    }
  };

  /**
   * Drives the catalog's first-visit auto-open. Set to `true` only when the
   * persisted layout is absent (`get()` → `null`) and bound to the catalog's
   * `[autoOpen]` input, which the catalog reads in its own `ngOnInit`.
   */
  public shouldAutoOpenCatalog = signal(false);

  /**
   * The centralized module registry. Declared `protected` (rather than
   * `private`) because the template resolves each item's component through
   * `registry.get(item.moduleKey)?.component`, and Angular templates can read
   * `protected`/`public` members.
   */
  protected readonly registry = inject(ModuleRegistryService);

  private readonly catalog = viewChild(GfModuleCatalogComponent);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dashboardLayoutService = inject(DashboardLayoutService);

  /**
   * The live `angular-gridster2` grid instance, queried once the view renders.
   * Its {@link Gridster.api} exposes `getNextPossiblePosition`, used by
   * {@link onAddModule} to place a new module in the next free slot. Resolves
   * to `undefined` until the grid view is initialized.
   */
  private readonly grid = viewChild(Gridster);

  /**
   * Memoizes the `*ngComponentOutlet` `inputs` object per placed item so the
   * `OnPush` change detector receives a stable reference each cycle (a fresh
   * object literal every render would defeat outlet input change detection).
   * Entries are evicted in {@link removeItem}.
   */
  private readonly outletInputsCache = new Map<
    DashboardItem,
    { removeModule: () => void }
  >();

  /**
   * Loads the persisted layout on init. A `null` result is the first-visit
   * case: the canvas stays blank and flags the catalog to auto-open. Otherwise
   * the saved geometry is hydrated into {@link dashboard}, re-deriving each
   * item's per-module minimum cell dimensions from the registry (falling back
   * to the global 2×2 floor when a stored module key is no longer registered).
   */
  public ngOnInit() {
    this.dashboardLayoutService.get().subscribe((layout) => {
      if (layout === null) {
        this.dashboard = [];
        this.shouldAutoOpenCatalog.set(true);
      } else {
        this.dashboard = layout.layoutData.items.map((item) => {
          const definition = this.registry.get(item.moduleKey);

          return {
            cols: item.cols,
            minItemCols: definition?.minItemCols ?? MIN_ITEM_COLS,
            minItemRows: definition?.minItemRows ?? MIN_ITEM_ROWS,
            moduleKey: item.moduleKey,
            rows: item.rows,
            x: item.x,
            y: item.y
          };
        });
        this.shouldAutoOpenCatalog.set(false);
      }

      this.isInitialized.set(true);
      this.changeDetectorRef.markForCheck();
    });
  }

  /**
   * Adds a module to the canvas from the catalog. Enforces uniqueness (the
   * template tracks `@for` by `moduleKey`, so duplicate keys would raise
   * NG0955), resolves the module's registry definition for its minimum cell
   * dimensions, asks the grid engine for the next free slot, and persists the
   * resulting layout. Unknown keys and already-placed modules are no-ops.
   *
   * @param key - The stable registry key emitted by the catalog.
   */
  public onAddModule(key: string) {
    if (this.dashboard.some((item) => item.moduleKey === key)) {
      return;
    }

    const definition = this.registry.get(key);

    if (!definition) {
      return;
    }

    const newItem: DashboardItem = {
      cols: definition.minItemCols,
      minItemCols: definition.minItemCols,
      minItemRows: definition.minItemRows,
      moduleKey: key,
      rows: definition.minItemRows,
      x: 0,
      y: 0
    };

    // First-fit placement: the grid API mutates `x`/`y` in place to the next
    // free slot before the item is added and persisted. Optional chaining keeps
    // this null-safe until the grid view has initialized.
    this.grid()?.api?.getNextPossiblePosition?.(newItem);

    this.dashboard = [...this.dashboard, newItem];

    this.changeDetectorRef.markForCheck();
    this.persistLayout();
  }

  /**
   * Drag-over handler for the canvas drop target. When the drag carries a
   * module key (a catalog drag-add), `preventDefault()` marks the canvas as a
   * valid drop target and the cursor reflects a copy. Drags without the module
   * data type are ignored, leaving unrelated drags unaffected.
   *
   * @param event - The native `dragover` event on the canvas host.
   */
  public onDragOver(event: DragEvent) {
    if (event.dataTransfer?.types.includes(MODULE_DRAG_DATA_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  /**
   * Drop handler for the canvas drop target. Reads the dragged module key from
   * the {@link MODULE_DRAG_DATA_TYPE} data and adds it through
   * {@link onAddModule} (which applies first-fit placement and persistence).
   * No-ops for drags that carry no module key.
   *
   * @param event - The native `drop` event on the canvas host.
   */
  public onDrop(event: DragEvent) {
    const key = event.dataTransfer?.getData(MODULE_DRAG_DATA_TYPE);

    if (key) {
      event.preventDefault();
      this.onAddModule(key);
    }
  }

  /**
   * Opens the module catalog overlay (the toolbar "Add module" affordance). The
   * catalog query resolves only while it is rendered (`@if (isInitialized())`),
   * so the call is guarded with optional chaining.
   */
  public openCatalog() {
    this.catalog()?.open();
  }

  /**
   * Removes a placed module from the canvas, evicts its memoized outlet inputs,
   * and persists the updated layout.
   *
   * @param item - The placed grid item to remove.
   */
  public removeItem(item: DashboardItem) {
    this.dashboard = this.dashboard.filter((current) => current !== item);
    this.outletInputsCache.delete(item);

    this.changeDetectorRef.markForCheck();
    this.persistLayout();
  }

  /**
   * Returns the memoized `*ngComponentOutlet` inputs for a placed item. The
   * wrapper component declares `@Input() removeModule?: () => void` and invokes
   * it from its header's remove action (Angular's `NgComponentOutlet` supports
   * input binding only, so removal is wired as an input callback rather than an
   * output).
   *
   * @param item - The placed grid item whose outlet inputs are requested.
   * @returns A stable inputs object reused across change-detection cycles.
   */
  protected getOutletInputs(item: DashboardItem) {
    let inputs = this.outletInputsCache.get(item);

    if (!inputs) {
      inputs = { removeModule: () => this.removeItem(item) };
      this.outletInputsCache.set(item, inputs);
    }

    return inputs;
  }

  /**
   * Projects the current {@link dashboard} state into a versioned
   * {@link LayoutData} payload and queues it for debounced persistence. This is
   * the sole persistence path; it is invoked only from grid state-change
   * handlers ({@link options} drag/resize callbacks, {@link onAddModule} and
   * {@link removeItem}).
   */
  private persistLayout() {
    const layoutData: LayoutData = {
      items: this.dashboard.map((item) => ({
        cols: item.cols,
        moduleKey: item.moduleKey,
        rows: item.rows,
        x: item.x,
        y: item.y
      })),
      schemaVersion: LAYOUT_SCHEMA_VERSION
    };

    const payload: UserDashboardLayoutPatchPayload = { layoutData };

    this.dashboardLayoutService.queueSave(payload);
  }
}
