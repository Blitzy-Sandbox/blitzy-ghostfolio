import {
  DashboardLayoutItem,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';

import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  inject,
  NgZone,
  OnInit,
  Type
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  Gridster,
  GridsterApi,
  GridsterConfig,
  GridsterItem,
  GridsterItemConfig,
  GridType
} from 'angular-gridster2';
import { take } from 'rxjs/operators';

import { DashboardLayoutService } from '../dashboard-layout.service';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Fixed 12-column layout (AAP §0.1.1: "fixed 12-column layout"). Bound to both
 * `minCols` and `maxCols` so the grid never reflows to a different column count.
 */
const GRID_COLUMNS = 12;

/**
 * Constant pixel row height (AAP §0.1.1: "a constant pixel row height"). With
 * `GridType.VerticalFixed` every row renders at exactly this height and the
 * canvas scrolls vertically once the modules overflow the viewport.
 */
const FIXED_ROW_HEIGHT = 120;

/** Pixel gap between modules and around the outer edge of the grid. */
const GRID_MARGIN = 16;

/**
 * Hard floor (2 cells) for a module footprint when the registry cannot resolve
 * a persisted item's `moduleKey`. The registry already clamps every registered
 * module's `minCols`/`minRows` to `>= 2`, so this only guards the defensive
 * `createGridsterItem` fallback path.
 */
const FALLBACK_MIN_CELL_DIMENSION = 2;

/** Width of the module-catalog overlay dialog. */
const CATALOG_DIALOG_WIDTH = '32rem';

/** Maximum height of the module-catalog overlay dialog. */
const CATALOG_DIALOG_MAX_HEIGHT = '80vh';

/**
 * A single placed grid cell. Extends the angular-gridster2 item-data contract
 * (`GridsterItemConfig`: `x`, `y`, `cols`, `rows`, plus the optional
 * `minItemCols`/`minItemRows` constraints the engine enforces) with the
 * `moduleKey` that maps the cell to a module type registered in
 * `ModuleRegistryService`.
 *
 * NOTE (angular-gridster2 v21): the item *data* type is `GridsterItemConfig`;
 * the symbol `GridsterItem` is the item *component* (selector `gridster-item`).
 * Earlier majors exported the data type as `GridsterItem`, so this extends
 * `GridsterItemConfig` to match the installed v21.0.1 public API.
 */
interface DashboardGridsterItem extends GridsterItemConfig {
  moduleKey: string;
}

/**
 * Root dashboard grid canvas rendered at the single `/` route.
 *
 * Hosts an `angular-gridster2` v21 drag/resize grid in which each placed module
 * renders inside an outlined `MatCard`. Behaviour:
 * - Loads the persisted layout on init; a `null` result (HTTP 404) blanks the
 *   canvas and auto-opens the catalog (first-visit experience).
 * - Holds the authoritative `items` array — the grid owns module
 *   positions/sizes; modules hold no layout state.
 * - Resolves each module's component through `ModuleRegistryService`; this
 *   canvas imports none of the module wrappers.
 * - Persists layout changes through `DashboardLayoutService.save(...)` on every
 *   grid-state change (drag, resize, add, remove, keyboard move/resize); the
 *   service owns the 500 ms debounce and the PATCH.
 * - Offers keyboard-operable move/resize controls (via the module menu) as a
 *   pointer-free alternative to gridster's drag/resize, which has no built-in
 *   keyboard support.
 *
 * All grid chrome is styled via the `var(--mat-sys-<token>, <fallback>)` pattern
 * and glyphs use `<ion-icon>` web components (hence `CUSTOM_ELEMENTS_SCHEMA`).
 * Design rationale is recorded in
 * `docs/decisions/dashboard-refactor-decisions.md`: module isolation,
 * grid-as-single-source-of-truth, the registry introduction mechanism, and the
 * event-driven persistence funnel (D-008); the `var(--mat-sys-*, <fallback>)`
 * token discipline (D-006); the enforced 2x2 minimum cell dimensions (D-009);
 * and the first-visit catalog auto-open over a blank canvas (D-010).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Gridster,
    GridsterItem,
    MatButtonModule,
    MatCardModule,
    MatMenuModule,
    MatTooltipModule,
    NgComponentOutlet
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-dashboard-canvas',
  standalone: true,
  styleUrls: ['./dashboard-canvas.component.scss'],
  templateUrl: './dashboard-canvas.component.html'
})
export class GfDashboardCanvasComponent implements OnInit {
  /**
   * Holds module positions and sizes. angular-gridster2 mutates each item's
   * `x`/`y`/`cols`/`rows` in place during drag and resize, so reading this array
   * always reflects the latest geometry.
   */
  public items: DashboardGridsterItem[] = [];

  /** Gridster engine configuration; built once in the constructor. */
  public options: GridsterConfig;

  /**
   * Grid API captured from `initCallback`; used to re-render the grid after a
   * programmatic (keyboard) item change. Undefined until the grid initializes.
   */
  private gridsterApi?: GridsterApi;

  /**
   * Gates persistence to genuine, post-load grid-state changes (QA F2-LOW-01).
   *
   * angular-gridster2 invokes `itemResizeCallback` for every item during its
   * initial placement and `itemChangeCallback` whenever its deferred
   * `calculateLayout` repositions items (e.g. when `pushItems` normalizes an
   * overlapping persisted layout). Those load-time invocations are
   * indistinguishable from a user drag/resize at the callback site, so without
   * this flag the canvas would PATCH the layout on every page load — violating
   * Rule 4 ("persistence is event-driven only") and silently re-persisting a
   * gridster-normalized arrangement on read. The flag is flipped to `true`
   * exactly once, after the first `NgZone.onStable` following the layout load,
   * by which point gridster's deferred layout pass has settled.
   */
  private isLayoutInitialized = false;

  /**
   * Serialized snapshot (`JSON.stringify` of the grid items) of the most
   * recently persisted — or freshly loaded — layout. `persistLayout()`
   * deep-compares against this before issuing a PATCH, so an idempotent
   * gridster re-fire (e.g. a window resize that does not change any geometry)
   * does not produce a redundant save. `null` until the first load settles.
   */
  private lastPersistedLayout: string | null = null;

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dashboardLayoutService = inject(DashboardLayoutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly moduleRegistryService = inject(ModuleRegistryService);
  private readonly ngZone = inject(NgZone);

  public constructor() {
    this.options = {
      draggable: {
        // Drag is initiated only from the header drag-handle element.
        dragHandleClass: 'dashboard-module__drag-handle',
        enabled: true,
        ignoreContent: true
      },
      fixedRowHeight: FIXED_ROW_HEIGHT,
      gridType: GridType.VerticalFixed,
      // Capture the grid API so keyboard move/resize can re-render the grid.
      initCallback: (_gridster, gridsterApi) => {
        this.gridsterApi = gridsterApi;
      },
      // Drag and resize completion route through the gated handler so only
      // genuine, post-load changes persist (QA F2-LOW-01); gridster also fires
      // these during initial placement and collision normalization.
      itemChangeCallback: () => {
        this.onGridItemChanged();
      },
      itemResizeCallback: () => {
        this.onGridItemChanged();
      },
      margin: GRID_MARGIN,
      maxCols: GRID_COLUMNS,
      minCols: GRID_COLUMNS,
      outerMargin: true,
      pushItems: true,
      resizable: { enabled: true }
    };
  }

  public ngOnInit() {
    // Subscribe once to activate the service's debounced PATCH pipeline; the
    // subscription is torn down with the component.
    this.dashboardLayoutService.savedLayout$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();

    // Load the persisted layout. A `null` response (HTTP 404) blanks the canvas
    // and auto-opens the catalog (first-visit experience).
    this.dashboardLayoutService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response: UserDashboardLayout | null) => {
          if (response === null) {
            this.items = [];
            this.openCatalog();
          } else {
            // Read the `{ layout }` envelope and drop any item whose `moduleKey`
            // is no longer registered (avoids an empty, untitled card).
            this.items = response.layout
              .filter((layoutItem) =>
                Boolean(this.moduleRegistryService.get(layoutItem.moduleKey))
              )
              .map((layoutItem) => this.createGridsterItem(layoutItem));
          }

          // OnPush + async resolution: request a check so the grid renders.
          this.changeDetectorRef.markForCheck();

          // Only now arm persistence: gridster's initial placement and any
          // collision normalization fire their callbacks before the grid
          // settles, and must NOT be persisted (Rule 4 / QA F2-LOW-01).
          this.armLayoutPersistence();
        },
        error: () => {
          // A failed layout load must not strand the canvas with an unhandled
          // error. This is reached when the layout GET resolves to a status
          // other than 404 — most notably the 401 an unauthenticated visitor
          // receives now that the preserved AuthGuard allows them onto the
          // single root route `/` (QA F2-HIGH-01), but also any transient
          // server/network failure. Render a safe, empty grid and request a
          // check. Deliberately do NOT auto-open the catalog: unlike the 404
          // "first-visit" path (Rule 10), a load FAILURE is not a confirmed
          // "no saved layout" signal, so surfacing the catalog would be
          // misleading.
          this.items = [];
          this.changeDetectorRef.markForCheck();

          // Arm persistence on the failure path too, so any later user action
          // still persists; the baseline snapshot reflects the empty grid.
          this.armLayoutPersistence();
        }
      });
  }

  /**
   * Resolves the wrapper component for a placed module, fed to the template's
   * `*ngComponentOutlet`. Returns `undefined` for an unregistered key (the
   * load-time filter already prevents that).
   */
  public getModuleComponent(moduleKey: string): Type<unknown> | undefined {
    return this.moduleRegistryService.get(moduleKey)?.component;
  }

  /** Resolves the human-readable module title for the header and aria-label. */
  public getModuleName(moduleKey: string): string {
    return this.moduleRegistryService.get(moduleKey)?.name ?? '';
  }

  /**
   * Action-oriented accessible label for a module's overflow-menu trigger (e.g.
   * "Open actions for Holdings"), so assistive technology announces the
   * button's action rather than only the module name.
   */
  public getModuleMenuLabel(moduleKey: string): string {
    return $localize`Open actions for ${this.getModuleName(moduleKey)}`;
  }

  /**
   * Persists the current arrangement for every EXPLICIT, user-driven grid-state
   * change (add, remove, keyboard move/resize). Pointer drag/resize instead
   * arrive through the gated `onGridItemChanged()`; both funnel into the
   * deduplicating `persistLayout()`, the single persistence entry point (Rule 4).
   */
  public onLayoutChanged() {
    this.persistLayout();
  }

  /**
   * Keyboard-accessible reposition: shifts a module by `(dx, dy)` grid cells,
   * clamped so the module stays within the grid (column index in
   * `[0, columns - cols]`, row index `>= 0`), then re-renders and persists.
   * Provides a pointer-free alternative to gridster drag, which ships no
   * keyboard support.
   */
  public moveModule(item: DashboardGridsterItem, dx: number, dy: number) {
    const cols = item.cols ?? FALLBACK_MIN_CELL_DIMENSION;

    item.x = Math.min(Math.max(item.x + dx, 0), GRID_COLUMNS - cols);
    item.y = Math.max(item.y + dy, 0);

    this.applyProgrammaticItemChange();
  }

  /**
   * Keyboard-accessible resize: grows/shrinks a module by `(dCols, dRows)` grid
   * cells, clamped to the module's minimum footprint and the remaining grid
   * width, then re-renders and persists. Pointer-free alternative to gridster
   * resize.
   */
  public resizeModule(
    item: DashboardGridsterItem,
    dCols: number,
    dRows: number
  ) {
    const minCols = item.minItemCols ?? FALLBACK_MIN_CELL_DIMENSION;
    const minRows = item.minItemRows ?? FALLBACK_MIN_CELL_DIMENSION;
    // Upper bound never drops below the minimum even for an edge-anchored item.
    const maxCols = Math.max(GRID_COLUMNS - item.x, minCols);

    item.cols = Math.min(Math.max(item.cols + dCols, minCols), maxCols);
    item.rows = Math.max(item.rows + dRows, minRows);

    this.applyProgrammaticItemChange();
  }

  /**
   * Opens the searchable module catalog overlay. Used both for the first-visit
   * auto-open and the toolbar "Add module" button. On a non-empty result the
   * chosen module is added; dismissal resolves `undefined` and is a no-op.
   */
  public openCatalog() {
    const dialogRef = this.dialog.open<
      GfModuleCatalogComponent,
      undefined,
      string
    >(GfModuleCatalogComponent, {
      autoFocus: false,
      maxHeight: CATALOG_DIALOG_MAX_HEIGHT,
      panelClass: 'gf-dashboard-module-catalog-dialog',
      width: CATALOG_DIALOG_WIDTH
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((moduleKey) => {
        if (moduleKey) {
          this.addModule(moduleKey);
        }
      });
  }

  /**
   * Removes a placed module, comparing by reference so only the targeted tile is
   * dropped, then persists.
   */
  public removeModule(item: DashboardGridsterItem) {
    this.items = this.items.filter((existingItem) => existingItem !== item);

    this.changeDetectorRef.markForCheck();
    this.onLayoutChanged();
  }

  /**
   * Arms layout persistence exactly once, after the grid has finished its first
   * render (QA F2-LOW-01).
   *
   * `NgZone.onStable` emits when the Angular zone has no further pending work.
   * By the time it first fires after the layout load, angular-gridster2 has
   * completed its deferred `calculateLayout` pass — including the per-item
   * `itemResizeCallback`s of initial placement and any `itemChangeCallback`s
   * from `pushItems` collision normalization. Flipping `isLayoutInitialized`
   * here therefore lets those load-time callbacks no-op (they run while the
   * flag is still `false`) while every genuine, user-driven change afterward
   * persists. The snapshot of the settled layout becomes the deep-compare
   * baseline so the first real change is detected correctly.
   *
   * `take(1)` makes this a strict one-shot; `takeUntilDestroyed` ties the
   * subscription's lifetime to the component.
   */
  private armLayoutPersistence() {
    this.ngZone.onStable
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.isLayoutInitialized = true;
        this.lastPersistedLayout = JSON.stringify(this.serializeLayout());
      });
  }

  /**
   * Entry point for angular-gridster2 pointer callbacks (drag/resize
   * completion), gated to genuine post-load changes (QA F2-LOW-01).
   *
   * gridster also invokes `itemChangeCallback`/`itemResizeCallback` during its
   * initial item placement and `pushItems` collision normalization. Those fire
   * while `isLayoutInitialized` is still `false` (it flips only after the first
   * `NgZone.onStable` post-load), so they no-op here — preventing a redundant
   * load-time PATCH and the silent re-persistence of a normalized layout on
   * read. Once the grid has settled, real drag/resize changes funnel into
   * `persistLayout()`.
   */
  private onGridItemChanged() {
    if (!this.isLayoutInitialized) {
      return;
    }

    this.persistLayout();
  }

  /**
   * Deduplicating persistence funnel.
   *
   * Serializes the current grid items and compares them against the last
   * persisted/loaded snapshot. An unchanged layout — e.g. an idempotent gridster
   * re-fire from a window resize that moved nothing — is skipped, so only real
   * geometry changes reach the debounced PATCH pipeline. On a genuine change the
   * snapshot is advanced BEFORE delegating to the service, so a follow-up
   * gridster callback for that same change deduplicates instead of issuing a
   * second save.
   */
  private persistLayout() {
    const serializedLayout = JSON.stringify(this.serializeLayout());

    if (serializedLayout === this.lastPersistedLayout) {
      return;
    }

    this.lastPersistedLayout = serializedLayout;
    this.dashboardLayoutService.save(this.serializeLayout());
  }

  /**
   * Re-renders the grid after an in-place (keyboard) item mutation and persists.
   * Reassigns `items` for OnPush change detection, asks gridster to recompute
   * item positions, then routes through the single persistence entry point.
   */
  private applyProgrammaticItemChange() {
    this.items = [...this.items];

    this.changeDetectorRef.markForCheck();
    this.gridsterApi?.calculateLayout();
    this.onLayoutChanged();
  }

  /**
   * Places a new module on the canvas and persists.
   *
   * Guards: an unregistered key is ignored, and a duplicate key is rejected so
   * `moduleKey` stays unique for the template's `track item.moduleKey`. The new
   * tile stacks directly below the lowest existing item at column 0, sized to
   * the registry minimum, and carries `minItemCols`/`minItemRows` so the engine
   * never shrinks it below that footprint.
   */
  private addModule(moduleKey: string) {
    const definition = this.moduleRegistryService.get(moduleKey);

    if (!definition) {
      return;
    }

    if (this.items.some((item) => item.moduleKey === moduleKey)) {
      return;
    }

    const nextY = this.items.reduce(
      (maxY, item) => Math.max(maxY, item.y + item.rows),
      0
    );

    const newItem: DashboardGridsterItem = {
      cols: definition.minCols,
      minItemCols: definition.minCols,
      minItemRows: definition.minRows,
      moduleKey,
      rows: definition.minRows,
      x: 0,
      y: nextY
    };

    this.items = [...this.items, newItem];

    this.changeDetectorRef.markForCheck();
    this.onLayoutChanged();
  }

  /**
   * Builds a grid item from a persisted layout entry, clamping `cols`/`rows` up
   * to the current registry minimum (a module's minimum may have grown since the
   * layout was saved) and stamping `minItemCols`/`minItemRows` so the engine
   * enforces the floor going forward.
   */
  private createGridsterItem(
    layoutItem: DashboardLayoutItem
  ): DashboardGridsterItem {
    const definition = this.moduleRegistryService.get(layoutItem.moduleKey);
    const minCols = definition?.minCols ?? FALLBACK_MIN_CELL_DIMENSION;
    const minRows = definition?.minRows ?? FALLBACK_MIN_CELL_DIMENSION;

    return {
      cols: Math.max(layoutItem.cols, minCols),
      minItemCols: minCols,
      minItemRows: minRows,
      moduleKey: layoutItem.moduleKey,
      rows: Math.max(layoutItem.rows, minRows),
      x: layoutItem.x,
      y: layoutItem.y
    };
  }

  /**
   * Projects the live grid items down to the shared `DashboardLayoutItem` wire
   * shape (`{ cols, moduleKey, rows, x, y }`), stripping `minItemCols`/
   * `minItemRows` and any gridster internals so only the persisted contract
   * leaves the canvas.
   */
  private serializeLayout(): DashboardLayoutItem[] {
    return this.items.map(({ cols, moduleKey, rows, x, y }) => ({
      cols,
      moduleKey,
      rows,
      x,
      y
    }));
  }
}
