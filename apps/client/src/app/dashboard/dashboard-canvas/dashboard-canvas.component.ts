import { DashboardLayoutService } from '@ghostfolio/client/dashboard/dashboard-layout.service';
import { DashboardItem } from '@ghostfolio/client/dashboard/dashboard.types';
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

// Fixed pixel row height for the `GridType.Fixed` grid (AAP: "a fixed row
// height (constant pixel value)").
const FIXED_ROW_HEIGHT = 50;

// The grid is locked to exactly 12 columns (`minCols === maxCols`) per the AAP
// grid specification.
const GRID_COLUMNS = 12;

// Version stamped onto every persisted `LayoutData` payload so the JSONB schema
// can evolve with forward compatibility (AAP: "versioned JSONB layout schema").
const LAYOUT_SCHEMA_VERSION = 1;

// Global minimum module footprint (2x2 cells). Per-item minimums are sourced
// from the registry definition and fall back to these (always >= 2).
const MIN_ITEM_COLS = 2;
const MIN_ITEM_ROWS = 2;

/**
 * The single-canvas root grid component for the Ghostfolio modular dashboard.
 *
 * Lazy-loaded at the single `path: ''` route (the navigation-shell wiring does
 * `import('...dashboard-canvas.component').then((m) => m.GfDashboardCanvasComponent)`),
 * this component is the architectural heart of the feature and the sole
 * integration point of the four dashboard sibling contracts:
 *
 *   - {@link ModuleRegistryService} — resolves a module key to its wrapper
 *     component (the ONLY module-introduction mechanism; the canvas imports no
 *     wrapper and no feature component, which enforces module isolation).
 *   - {@link DashboardLayoutService} — `get()` loads the saved layout (404 is
 *     mapped to `null` upstream), and `queueSave()` is the SOLE persistence
 *     entrypoint (debounced 500ms internally).
 *   - {@link GfModuleCatalogComponent} — the searchable catalog whose
 *     `addModule` output drives {@link onAddModule}.
 *   - The shared `LayoutData` / `UserDashboardLayoutPatchPayload` contracts.
 *
 * Responsibilities:
 *   - Own the authoritative grid state ({@link dashboard}, a plain
 *     `DashboardItem[]`) — module components hold NO layout state.
 *   - Render each placed module's wrapper generically through
 *     `*ngComponentOutlet` (resolved via the registry in the template).
 *   - Drive grid-event-driven, debounced persistence: drag/resize end
 *     (`itemChangeCallback`/`itemResizeCallback`), add, and remove all funnel
 *     through {@link persistLayout} -> `queueSave`.
 *   - Auto-open the catalog on first visit (when `get()` resolves to `null`).
 *
 * Mirrors the OnPush / standalone / `inject()` style of
 * `chat-panel.component.ts`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
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
   * Single source of truth for module positions and sizes. A plain array (NOT
   * a signal) per the folder contract; because the component is OnPush, every
   * mutation REASSIGNS the reference and calls `markForCheck()`.
   */
  public dashboard: DashboardItem[] = [];

  /**
   * Flips to `true` once the asynchronous layout `get()` resolves. The template
   * gates the catalog behind `@if (isInitialized())` so the catalog is created
   * only AFTER the layout is known — its `ngOnInit` then reads the correct
   * `autoOpen` value (deterministic first-visit auto-open, Option B).
   */
  public isInitialized = signal(false);

  /**
   * Static `angular-gridster2` configuration. Declared as a field initializer
   * (not in a constructor) so the `itemChangeCallback`/`itemResizeCallback`
   * arrows capture `this`. Both callbacks are ZERO-PARAM arrows: the engine's
   * `(item, itemComponent)` arguments are intentionally omitted because the
   * authoritative geometry already lives on {@link dashboard}, and naming
   * unused parameters would fail the build (`noUnusedParameters: true`).
   */
  public options: GridsterConfig = {
    draggable: {
      // Dragging is initiated only from the module header handle (the wrapper
      // applies this class), never from module content.
      dragHandleClass: 'gf-module-drag-handle',
      enabled: true,
      ignoreContent: true
    },
    fixedRowHeight: FIXED_ROW_HEIGHT,
    gridType: GridType.Fixed,
    // Persist after a drag-end or resize-end. Zero-param arrows (see above).
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
   * Drives the catalog's `[autoOpen]` input. Set to `true` only on first visit
   * (no saved layout) so a brand-new user lands on a blank canvas with the
   * catalog already open.
   */
  public shouldAutoOpenCatalog = signal(false);

  // Exposed to the template (`registry.get(item.moduleKey)?.component`), so it
  // must be at least `protected`. The registry is the single, authoritative
  // module-introduction mechanism.
  protected readonly registry = inject(ModuleRegistryService);

  private readonly catalog = viewChild(GfModuleCatalogComponent);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dashboardLayoutService = inject(DashboardLayoutService);
  // Signal query for the `<gridster>` instance. In angular-gridster2 v21 the
  // grid API (`getNextPossiblePosition`, etc.) lives on the component INSTANCE
  // and is NOT attached to the `options` object (verified against v21.0.1), so
  // first-fit placement must read it from here (see {@link onAddModule}).
  private readonly grid = viewChild(Gridster);
  // Memoizes the `*ngComponentOutlet` inputs object per item so OnPush change
  // detection does not observe a new reference every cycle (which would tear
  // down and re-create the rendered module). Entries are evicted on removal.
  private readonly outletInputsCache = new Map<
    DashboardItem,
    { removeModule: () => void }
  >();

  public ngOnInit() {
    // Grid-event-driven persistence and first-visit detection both hinge on the
    // initial layout load. A `null` result (404 mapped upstream) means "no
    // saved layout yet" -> blank canvas + auto-open catalog.
    this.dashboardLayoutService.get().subscribe((layout) => {
      if (layout === null) {
        this.dashboard = [];
        this.shouldAutoOpenCatalog.set(true);
      } else {
        // Hydrate the authoritative grid state from the persisted geometry,
        // re-deriving per-item minimum dimensions from the registry so the
        // engine continues to enforce them after a reload.
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
   * Adds a module (by its registry key) to the canvas at the next available
   * grid position. Invoked by the catalog's `addModule` output.
   *
   * Guards:
   *   - Dedup: the template tracks `@for` by `moduleKey`, so duplicate keys
   *     would trigger Angular NG0955; a module already on the canvas is a
   *     no-op.
   *   - Unknown key: an unregistered key is ignored (registry-only
   *     introduction).
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

    // First-fit placement. In angular-gridster2 v21 the grid API is exposed on
    // the `<gridster>` component instance (AAP § 0.2.2: "grid API obtained via
    // initCallback / viewChild(Gridster).api"), NOT on the `options` object, so
    // it is read from the `viewChild(Gridster)` query. `getNextPossiblePosition`
    // MUTATES `newItem.x`/`newItem.y` in place to the next free 12-column slot.
    // The optional chaining keeps this null-safe before the grid has
    // initialized (e.g. in unit tests), where the item stays at `x: 0, y: 0`.
    this.grid()?.api?.getNextPossiblePosition?.(newItem);

    // Reassign (not mutate) the array reference for OnPush.
    this.dashboard = [...this.dashboard, newItem];

    this.changeDetectorRef.markForCheck();
    this.persistLayout();
  }

  /**
   * Opens the module catalog. Wired to the toolbar "Add module" button. The
   * catalog lives behind `@if (isInitialized())`, so the signal query may be
   * empty before initialization — hence the optional chaining.
   */
  public openCatalog() {
    this.catalog()?.open();
  }

  /**
   * Removes a placed module from the canvas. Invoked by the wrapper's
   * `removeModule` callback (see {@link getOutletInputs}).
   */
  public removeItem(item: DashboardItem) {
    // Reassign (not mutate) for OnPush; identity comparison is safe because the
    // wrapper invokes the exact item instance captured in the inputs cache.
    this.dashboard = this.dashboard.filter((current) => current !== item);
    this.outletInputsCache.delete(item);

    this.changeDetectorRef.markForCheck();
    this.persistLayout();
  }

  /**
   * Returns the memoized `*ngComponentOutlet` inputs for an item. The wrapper
   * declares `@Input() removeModule?: () => void` and invokes it to remove
   * itself (Angular 21 `NgComponentOutlet` supports input binding only, no
   * outputs). Returning a STABLE object reference per item keeps OnPush change
   * detection from re-instantiating the rendered module on every cycle.
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
   * Projects the authoritative {@link dashboard} state into the versioned
   * `LayoutData` contract and hands it to the layout service's debounced save.
   * This is the ONLY persistence path; it is called exclusively from grid
   * state-change events (drag/resize end, add, remove). Module components never
   * call it.
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
