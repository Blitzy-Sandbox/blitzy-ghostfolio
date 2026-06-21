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
import { Chart } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';

// Fixed pixel row height for the grid (AAP § 0.1.1: "a fixed row height
// (constant pixel value)"). With `GridType.VerticalFixed` ONLY the row height
// is fixed at this constant; the 12 columns are sized to fit the container
// width (see `gridType` below), satisfying the full-viewport requirement.
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
   * Set to `true` when the initial layout load fails with a NON-404 error.
   * `DashboardLayoutService.get()` maps HTTP 404 to `null` (first visit) but
   * RE-THROWS every other error (401/500/network); without handling, that
   * unhandled subscription error would leave {@link isInitialized} `false` and
   * the canvas permanently blank. When this is `true` the template renders an
   * inline, recoverable error state (message + "Retry") instead of a blank
   * canvas, and {@link isInitialized} is still flipped so the surface renders.
   */
  public loadError = signal(false);

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
    // Full-viewport grid (AAP § 0.6.3): `VerticalFixed` keeps the fixed
    // `fixedRowHeight` (row height is the ONLY fixed dimension per § 0.1.1)
    // while sizing the 12 columns to fit the container width. `GridType.Fixed`
    // was used previously, but it ALSO fixes the column width (default 250px),
    // so 12 columns + margins computed to ~3120px and overflowed a 1280px
    // viewport — half the modules (x >= 6) rendered off-screen and a single
    // 6-column module was wider than the entire viewport (F3-001). With
    // `VerticalFixed` the columns fit the width with no horizontal overflow.
    gridType: GridType.VerticalFixed,
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
  // Serialized snapshot of the last `LayoutData` handed to `queueSave` (or the
  // baseline captured right after a load). Used to suppress redundant no-op
  // saves — most importantly the spurious PATCH that angular-gridster2 would
  // otherwise trigger when its `itemChangeCallback`/`itemResizeCallback` fire
  // during the post-hydration settle with geometry IDENTICAL to what was just
  // loaded (F2-001). Persistence must be driven ONLY by real grid state changes
  // (AAP R4 / § 0.1.1 "grid-event-driven only"), so a projection equal to this
  // snapshot is skipped. `null` until the first load baselines it.
  private lastPersistedSnapshot: string | null = null;
  // Memoizes the `*ngComponentOutlet` inputs object per item so OnPush change
  // detection does not observe a new reference every cycle (which would tear
  // down and re-create the rendered module). Entries are evicted on removal.
  private readonly outletInputsCache = new Map<
    DashboardItem,
    { removeModule: () => void }
  >();

  /**
   * The dashboard canvas is the composition root for every chart-bearing
   * feature module (it renders them all generically via `*ngComponentOutlet`),
   * making it the earliest deterministic point at which
   * `chartjs-plugin-annotation` can be registered BEFORE any module chart is
   * constructed.
   *
   * Root cause this addresses (the "Cannot set properties of undefined (setting
   * 'annotations')" TypeError seen on every canvas load): the annotation
   * plugin's `beforeInit` hook seeds the per-chart state map, and its
   * `beforeUpdate` hook then executes `state.annotations = []`. `beforeInit`
   * only runs for charts created AFTER the plugin is globally registered. The
   * plugin is otherwise registered lazily inside the `investment-chart` /
   * `benchmark-comparator` constructors, so any chart created earlier — notably
   * the doughnut `portfolio-proportion-chart`s embedded in the Allocations and
   * Analysis modules — has NO annotation state; when such a chart later
   * updates, `beforeUpdate` dereferences `undefined` and throws. On the
   * single-canvas dashboard all modules mount together and their creation order
   * is driven by the saved layout, so a proportion chart routinely mounts
   * before the first annotation-using chart, surfacing this latent ordering bug
   * as a burst of uncaught TypeErrors.
   *
   * Registering here (idempotently — `Chart.register` de-dupes, and the chart
   * components retain their own registration for non-dashboard contexts)
   * guarantees every chart composed under the canvas is created with the plugin
   * already registered, so `beforeInit` always runs and `state` is always
   * defined.
   */
  public constructor() {
    Chart.register(annotationPlugin);
  }

  public ngOnInit() {
    this.loadLayout();
  }

  /**
   * Re-attempts the initial layout load after a non-404 failure. Wired to the
   * inline error state's "Retry" button so a transient 500/network error is
   * fully recoverable without a full page reload.
   */
  public retryLoad() {
    this.loadLayout();
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
   * Loads the persisted layout and resolves the canvas's initial state.
   * Extracted from `ngOnInit` so {@link retryLoad} can re-run the exact same
   * sequence after a transient failure.
   *
   * Grid-event-driven persistence and first-visit detection both hinge on this
   * load. A `null` result (HTTP 404 mapped upstream) means "no saved layout
   * yet" -> blank canvas + auto-open catalog. `DashboardLayoutService.get()`
   * deliberately RE-THROWS every non-404 error (401/500/network), which the
   * `error` branch handles: it surfaces a recoverable error state and STILL
   * marks the canvas initialized so the template renders the inline error/retry
   * affordance rather than an unrecoverable blank canvas.
   */
  private loadLayout() {
    this.loadError.set(false);

    this.dashboardLayoutService.get().subscribe({
      error: () => {
        // Non-404 failure (404 is mapped to `null` upstream and handled in
        // `next`). Surface a recoverable error instead of a blank canvas.
        this.loadError.set(true);
        this.shouldAutoOpenCatalog.set(false);
        this.isInitialized.set(true);
        this.changeDetectorRef.markForCheck();
      },
      next: (layout) => {
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

        // Baseline the persistence snapshot to the just-loaded geometry so the
        // settle-time `itemChangeCallback`/`itemResizeCallback` events that
        // angular-gridster2 emits while it positions items during hydration
        // (carrying geometry IDENTICAL to what was loaded) are recognized as
        // no-ops by `persistLayout()` and do NOT fire a redundant PATCH on a
        // passive page load (F2-001). Captured here — after `this.dashboard`
        // is assigned but before the view renders the grid — so it is in place
        // before the engine's first callback. The empty/first-visit branch
        // baselines an empty projection, so the first real add still persists.
        this.lastPersistedSnapshot = JSON.stringify(this.projectLayoutData());

        this.loadError.set(false);
        this.isInitialized.set(true);
        this.changeDetectorRef.markForCheck();
      }
    });
  }

  /**
   * Projects the authoritative {@link dashboard} state into the versioned
   * `LayoutData` contract (the exact shape persisted as JSONB). Extracted so
   * both {@link persistLayout} and the post-load baseline in {@link loadLayout}
   * derive their snapshot from one source of truth, keeping the F2-001 no-op
   * comparison exact.
   */
  private projectLayoutData(): LayoutData {
    return {
      items: this.dashboard.map((item) => ({
        cols: item.cols,
        moduleKey: item.moduleKey,
        rows: item.rows,
        x: item.x,
        y: item.y
      })),
      schemaVersion: LAYOUT_SCHEMA_VERSION
    };
  }

  /**
   * Projects the authoritative {@link dashboard} state and hands it to the
   * layout service's debounced save. This is the ONLY persistence path; it is
   * called exclusively from grid state-change events (drag/resize end, add,
   * remove). Module components never call it.
   *
   * Redundant no-op saves are suppressed (F2-001): when the projected geometry
   * is byte-identical to the last persisted (or post-load baseline) snapshot,
   * there is no real state change to persist and the save is skipped. This is
   * what prevents the spurious PATCH that angular-gridster2's settle-time
   * `itemChangeCallback`/`itemResizeCallback` would otherwise fire on a passive
   * hydration, honoring the "grid-event-driven only" rule (AAP R4 / § 0.1.1).
   * The check is purely content-based (no timer), so it is robust regardless of
   * when the engine emits its callbacks.
   */
  private persistLayout() {
    const layoutData = this.projectLayoutData();
    const snapshot = JSON.stringify(layoutData);

    if (snapshot === this.lastPersistedSnapshot) {
      return;
    }

    this.lastPersistedSnapshot = snapshot;

    const payload: UserDashboardLayoutPatchPayload = { layoutData };

    this.dashboardLayoutService.queueSave(payload);
  }
}
