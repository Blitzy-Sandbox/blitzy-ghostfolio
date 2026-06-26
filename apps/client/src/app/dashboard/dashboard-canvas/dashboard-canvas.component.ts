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

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dashboardLayoutService = inject(DashboardLayoutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly moduleRegistryService = inject(ModuleRegistryService);

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
      // Drag and resize completion persist the layout via onLayoutChanged().
      itemChangeCallback: () => {
        this.onLayoutChanged();
      },
      itemResizeCallback: () => {
        this.onLayoutChanged();
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
      .subscribe((response: UserDashboardLayout | null) => {
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
   * Persists the current arrangement. The single entry point through which every
   * grid-state change (drag, resize, add, remove, keyboard move/resize) is saved.
   */
  public onLayoutChanged() {
    this.dashboardLayoutService.save(this.serializeLayout());
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
