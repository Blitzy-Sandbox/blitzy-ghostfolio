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
  CUSTOM_ELEMENTS_SCHEMA,
  inject,
  OnInit,
  signal,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IonIcon } from '@ionic/angular/standalone';
import {
  Gridster,
  GridsterConfig,
  GridsterItem,
  GridType
} from 'angular-gridster2';
import { Chart } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { addIcons } from 'ionicons';
import { addOutline, alertCircleOutline, gridOutline } from 'ionicons/icons';
import ms from 'ms';

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
    IonIcon,
    MatButtonModule,
    MatTooltipModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
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
   * Latches to `true` once angular-gridster2 reports non-zero computed cell
   * dimensions (`curColWidth`/`curRowHeight`) after `initCallback` — see
   * {@link latchGridReadyWhenSized}, which polls per animation frame until the
   * engine has actually sized the cells (a single fixed frame is NOT enough,
   * because `initCallback` can fire before the column width is computed). The
   * template gates each module's `*ngComponentOutlet` content behind
   * `@if (isGridReady())` so module components — and the chart/SVG libraries
   * they embed — are created ONLY after their host cell has real dimensions.
   *
   * This is a defense-in-depth measure for QA Issue #6 ("InvalidStateError:
   * Failed to execute 'inverse' on 'SVGMatrix': The matrix is not invertible"),
   * emitted during all-12-module hydration by the Allocations module's world
   * map (svgmap, via `GfWorldMapChartComponent`). Mounting heavy chart/SVG
   * content only after the engine reports sized cells narrows the window in
   * which a chart can initialize against an unsized grid. It does NOT by itself
   * fully close that window, because angular-gridster2 applies each
   * `<gridster-item>`'s pixel size asynchronously a frame AFTER the mount
   * change-detection pass, while svgmap can construct synchronously within that
   * same pass (driven by async data) — so the definitive, timing-independent
   * fix is the width floor on `#svgMap` in the Allocations module wrapper
   * (`apps/client/src/app/dashboard/modules/allocations/allocations.component.ts`),
   * which guarantees a non-degenerate (invertible) viewport matrix regardless
   * of when svgmap reads it. Both the world map component (`libs/ui`) and the
   * Allocations page are out of scope, so each guard lives at an in-scope layer
   * (this canvas composition root and the in-scope module wrapper).
   *
   * It is a one-way latch (mounting content never changes a `VerticalFixed`
   * item's geometry, so it triggers no resize and no spurious persistence), and
   * it is independent of the persistence baseline — {@link loadLayout} and the
   * drag/resize callbacks operate on {@link dashboard} geometry regardless of
   * whether inner content has mounted.
   */
  public isGridReady = signal(false);

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
    // Fires once the grid is initialized; we then latch `isGridReady` (one
    // animation frame later) so module content mounts into already-sized cells
    // (QA Issue #6 — see {@link isGridReady}). Zero-param arrow: the engine
    // passes the grid instance, but the API is read via `viewChild(Gridster)`
    // instead, and naming an unused parameter would fail `noUnusedParameters`.
    initCallback: () => this.onGridInitialized(),
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
  private readonly snackBar = inject(MatSnackBar);

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

    // Register the Ionicons used by the canvas chrome (toolbar add control,
    // recoverable-error state, empty/first-visit state). Ghostfolio renders
    // icons via `<ion-icon>` (the Material icon *font* is not loaded), so each
    // component registers the named icons it references — mirroring the header.
    addIcons({ addOutline, alertCircleOutline, gridOutline });

    // Surface debounced-save failures to the user (QA Issue #7). The layout
    // service contains PATCH errors internally — a transient failure must NOT
    // disable future grid-event-driven saves — and re-emits them on
    // `saveError$`; without visible feedback an optimistic add/move/remove
    // LOOKS persisted but is silently lost on reload. A MatSnackBar is the
    // design-system-sanctioned transient-feedback surface (AAP § 0.5.2;
    // MatSnackBarModule is provided in main.ts). The canvas is the sole
    // persistence owner (it alone calls `queueSave`), so it is the correct
    // place to own this feedback. `takeUntilDestroyed()` is invoked here in the
    // constructor injection context and ties the subscription to this
    // component's lifetime.
    this.dashboardLayoutService.saveError$
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.snackBar.open(
          $localize`Couldn’t save your dashboard changes. Please try again.`,
          $localize`Dismiss`,
          { duration: ms('6 seconds') }
        );
      });
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
   * Entry point wired to angular-gridster2's `initCallback`. It is a one-way
   * latch, so a second `initCallback` (e.g. after an options reassignment)
   * short-circuits to a harmless no-op; otherwise it begins polling for real
   * cell dimensions via {@link latchGridReadyWhenSized}.
   */
  private onGridInitialized() {
    if (this.isGridReady()) {
      return;
    }

    this.latchGridReadyWhenSized(0);
  }

  /**
   * Polls (per animation frame, capped) until angular-gridster2 reports
   * non-zero computed cell dimensions (`curColWidth`/`curRowHeight`), then
   * latches {@link isGridReady} so the template mounts module content.
   *
   * Waiting for real cell dimensions — rather than a single fixed frame after
   * `initCallback` — is what actually closes the QA Issue #6 window.
   * `initCallback` can fire while the engine has not yet computed a column
   * width (observed during all-12-module hydration), so a fixed-frame latch
   * still mounted the Allocations world map (svgmap, via
   * `GfWorldMapChartComponent`) into a 0-width cell. A 0-width cell collapses
   * the map's `aspect-ratio: 16 / 9` container to 0 height, so svgmap's
   * pan/zoom engine (svg-pan-zoom) inverts a degenerate viewport CTM
   * (`viewport.getCTM().inverse()`) when it applies its initial zoom →
   * "InvalidStateError: Failed to execute 'inverse' on 'SVGMatrix': The matrix
   * is not invertible". Gating on `curColWidth > 0` guarantees the map only
   * ever constructs into a sized cell, eliminating the degenerate matrix. The
   * world map component (`libs/ui`) and the Allocations page are out of scope,
   * so the guard lives here at the canvas (composition root) level.
   *
   * The retry count is capped (~60 frames, ≈1s) so a pathological perpetual
   * zero-size can never leave the canvas blank: after the cap we latch anyway,
   * degrading at worst to the previous behavior, never worse.
   *
   * `requestAnimationFrame` is patched by zone.js (Ghostfolio is zone-based),
   * so each tick runs inside the Angular zone; the explicit `markForCheck`
   * keeps the OnPush view correct regardless.
   */
  private latchGridReadyWhenSized(attempt: number) {
    if (this.isGridReady()) {
      return;
    }

    const gridInstance = this.grid();
    const cellsAreSized =
      !!gridInstance &&
      gridInstance.curColWidth > 0 &&
      gridInstance.curRowHeight > 0;

    if (cellsAreSized || attempt >= 60) {
      this.isGridReady.set(true);
      this.changeDetectorRef.markForCheck();

      return;
    }

    requestAnimationFrame(() => this.latchGridReadyWhenSized(attempt + 1));
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
          // Hydrate the authoritative grid state from the persisted geometry.
          // The persisted payload is sanitized first (QA Issue #2): unknown
          // module keys are dropped and duplicate keys are de-duplicated. The
          // API now rejects such payloads at write time (DTO domain validation),
          // but rows persisted before that hardening — or any externally
          // tampered row — must still hydrate safely rather than rendering
          // duplicate modules (Angular NG0955) or empty/clipped chrome for an
          // unrenderable key.
          const persistedItems = layout.layoutData?.items ?? [];

          this.dashboard = this.sanitizePersistedItems(persistedItems);

          // QA Issue #3: a persisted layout whose items are ALL unknown or
          // duplicate (a corrupt or adversarial row) sanitizes to an empty
          // canvas. Treat that exactly like a first visit — auto-open the
          // catalog so the user has an actionable recovery path: adding any
          // module persists the clean layout on the next grid event, repairing
          // the corrupt row. A layout legitimately saved with zero modules is
          // NOT corrupt, so the catalog stays closed in that case.
          const hasCorruptItems =
            persistedItems.length > 0 && this.dashboard.length === 0;

          this.shouldAutoOpenCatalog.set(hasCorruptItems);
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
   * Sanitizes a persisted `LayoutData.items` array into clean, renderable
   * {@link DashboardItem}s before it becomes the authoritative grid state.
   *
   * Two defensive transforms run, both rooted in the registry as the single
   * authoritative module vocabulary (registry-only introduction):
   *
   *   1. Unknown-key filter — an item whose `moduleKey` is not registered
   *      cannot be resolved to a component, so it would render as empty/clipped
   *      chrome (or be "silently skipped"). Such items are dropped.
   *   2. Duplicate de-duplication — the template tracks `@for` by `moduleKey`;
   *      a repeated key triggers Angular `NG0955` and renders two copies of one
   *      module. Only the FIRST occurrence of each key is kept.
   *
   * Per-item minimum dimensions are re-derived from the registry so the engine
   * continues to enforce them after a reload. The method does NOT persist its
   * result: rule R4 mandates grid-event-driven persistence only, so the cleaned
   * layout is written back on the next real grid event (the caller baselines
   * {@link lastPersistedSnapshot} to the sanitized projection so that next
   * event correctly overwrites the corrupt row).
   */
  private sanitizePersistedItems(items: LayoutData['items']): DashboardItem[] {
    const seenKeys = new Set<string>();
    const sanitized: DashboardItem[] = [];

    for (const item of items) {
      if (!this.registry.has(item.moduleKey)) {
        continue;
      }

      if (seenKeys.has(item.moduleKey)) {
        continue;
      }

      seenKeys.add(item.moduleKey);

      const definition = this.registry.get(item.moduleKey);

      sanitized.push({
        cols: item.cols,
        minItemCols: definition?.minItemCols ?? MIN_ITEM_COLS,
        minItemRows: definition?.minItemRows ?? MIN_ITEM_ROWS,
        moduleKey: item.moduleKey,
        rows: item.rows,
        x: item.x,
        y: item.y
      });
    }

    return sanitized;
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
