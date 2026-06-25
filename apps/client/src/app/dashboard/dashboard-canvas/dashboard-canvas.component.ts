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
 * Hard floor for a module footprint when the registry cannot resolve a
 * persisted item's `moduleKey` (AAP Rule 6: 2×2 minimum). The registry already
 * clamps every registered module's `minCols`/`minRows` to `>= 2`, so this only
 * guards the defensive `createGridsterItem` fallback path.
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
 * renders inside an outlined `MatCard`. Responsibilities:
 * - Load the persisted layout on init; a `null` result (HTTP 404) is the
 *   first-visit signal that blanks the canvas and auto-opens the catalog
 *   (Rule 10).
 * - Hold the authoritative `items` array — the grid is the single source of
 *   truth for module positions/sizes; modules never hold layout state (Rule 2).
 * - Resolve each module's component exclusively through `ModuleRegistryService`
 *   (Rule 3) — this canvas imports none of the 12 module wrappers.
 * - Persist layout changes through `DashboardLayoutService.save(...)`, triggered
 *   ONLY by the four grid-state events (drag, resize, add, remove); the service
 *   owns the 500 ms debounce and the PATCH (Rule 4).
 *
 * All grid chrome (header, drag handle, resize handles, drop-zone indicators)
 * is styled in the co-located SCSS via the load-bearing
 * `var(--mat-sys-<token>, <fallback>)` pattern, and glyphs use `<ion-icon>`
 * web components (hence `CUSTOM_ELEMENTS_SCHEMA`) per Rule 7 / Decision D-020.
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
   * The single source of truth for module positions and sizes (Rule 2).
   * angular-gridster2 mutates each item's `x`/`y`/`cols`/`rows` in place during
   * drag and resize, so reading this array always reflects the latest geometry.
   */
  public items: DashboardGridsterItem[] = [];

  /** Gridster engine configuration; built once in the constructor. */
  public options: GridsterConfig;

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dashboardLayoutService = inject(DashboardLayoutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly moduleRegistryService = inject(ModuleRegistryService);

  public constructor() {
    this.options = {
      draggable: {
        // Only the header drag-handle initiates a drag, so interacting with the
        // module body or its buttons never moves the tile.
        dragHandleClass: 'dashboard-module__drag-handle',
        enabled: true,
        ignoreContent: true
      },
      fixedRowHeight: FIXED_ROW_HEIGHT,
      gridType: GridType.VerticalFixed,
      // Two of the four save triggers (Rule 4). Arrow functions bind `this` to
      // the component so `onLayoutChanged` reaches the injected service.
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
    // Activate the debounced PATCH pipeline (Rule 4). The service owns the
    // 500 ms debounce and the actual PATCH; subscribing here exactly once is
    // what makes every subsequent `save(...)` actually persist. The stream is
    // long-lived (root-scoped service) so it is torn down with the component.
    this.dashboardLayoutService.savedLayout$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();

    // Load the persisted layout. A `null` response (HTTP 404) is the canonical
    // new-user signal: blank the canvas and auto-open the catalog (Rule 10).
    this.dashboardLayoutService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((response: UserDashboardLayout | null) => {
        if (response === null) {
          this.items = [];
          this.openCatalog();
        } else {
          // `UserDashboardLayout` is the `{ layout }` envelope, so read
          // `response.layout`. Filter out any item whose `moduleKey` is no
          // longer registered (defends against a removed module type leaving an
          // empty, untitled card behind).
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
   * Resolves the wrapper component for a placed module (Rule 3). Fed to the
   * template's `*ngComponentOutlet`. Returns `undefined` only if the key is
   * unregistered, which the load-time filter already prevents.
   */
  public getModuleComponent(moduleKey: string): Type<unknown> | undefined {
    return this.moduleRegistryService.get(moduleKey)?.component;
  }

  /** Resolves the human-readable module title for the header and aria-label. */
  public getModuleName(moduleKey: string): string {
    return this.moduleRegistryService.get(moduleKey)?.name ?? '';
  }

  /**
   * Persists the current arrangement. The single funnel for all four grid-state
   * triggers (drag, resize, add, remove); modules never call save (Rule 4).
   */
  public onLayoutChanged() {
    this.dashboardLayoutService.save(this.serializeLayout());
  }

  /**
   * Opens the searchable module catalog overlay. Used both for the first-visit
   * auto-open (Rule 10) and the toolbar "Add module" button. On a non-empty
   * result the chosen module is added; dismissal resolves `undefined` and is a
   * no-op.
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
   * Removes a placed module (one of the four save triggers, Rule 4). Compares by
   * reference so only the targeted tile is dropped, then persists.
   */
  public removeModule(item: DashboardGridsterItem) {
    this.items = this.items.filter((existingItem) => existingItem !== item);

    this.changeDetectorRef.markForCheck();
    this.onLayoutChanged();
  }

  /**
   * Places a new module on the canvas (one of the four save triggers, Rule 4).
   *
   * Guards: an unregistered key is ignored, and a duplicate key is rejected so
   * `moduleKey` stays unique for the template's `track item.moduleKey`. The new
   * tile stacks directly below the lowest existing item at column 0, sized to
   * the registry minimum (already `>= 2`), and carries `minItemCols`/
   * `minItemRows` so the engine never shrinks it below that footprint (Rule 6).
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
   * enforces the floor going forward (Rule 6).
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
   * `minItemRows` and any gridster internals so only the documented contract is
   * persisted.
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
