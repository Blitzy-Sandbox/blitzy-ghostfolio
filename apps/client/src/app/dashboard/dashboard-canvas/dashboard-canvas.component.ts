import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  inject
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { IonIcon } from '@ionic/angular/standalone';
import {
  DisplayGrid,
  Gridster,
  GridsterConfig,
  GridsterItem,
  GridsterItemConfig,
  GridType
} from 'angular-gridster2';
import { addIcons } from 'ionicons';
import { addOutline } from 'ionicons/icons';

import { DashboardLayoutStoreService } from '../dashboard-layout-store.service';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { ModuleRegistryService } from '../module-registry.service';
import { GfModuleShellComponent } from '../module-shell/module-shell.component';

/**
 * `GfDashboardCanvasComponent` is the root single-canvas grid host for the
 * refactored modular dashboard. It is rendered at the root route `/` and
 * supersedes the former route-per-screen navigation (AAP § 0.4.1, § 0.4.4).
 *
 * Responsibilities:
 * - Hosts a single `angular-gridster2` grid configured to the LOCKED grid
 *   specification (12 columns, constant-pixel row height, 2x2 minimum module
 *   size — Rule 6, AAP § 0.6).
 * - Renders each grid item's wrapped feature component dynamically via
 *   `NgComponentOutlet`, resolving the component `Type` from
 *   `ModuleRegistryService` by module-type key (Rule 3). Each rendered module
 *   is framed by the shared `GfModuleShellComponent` chrome.
 * - Drives layout hydration and debounced persistence entirely through
 *   `DashboardLayoutStoreService` — the single source of truth for module
 *   positions and sizes (Rule 2). Every grid-engine event routes to the store,
 *   which owns the ~500 ms debounced `PATCH` (Rule 4). This component never
 *   calls the HTTP layout service directly.
 * - Auto-opens the module catalog on first visit when no saved layout exists
 *   (Rule 10) and exposes a persistent add-module affordance for returning
 *   users.
 *
 * Design-system compliance: Angular Material 3 with the `gf` selector prefix
 * (Decision D-020). All grid-chrome styling lives in the sibling
 * `dashboard-canvas.component.scss`, which applies the mandated
 * `var(--mat-sys-<token>, <fallback>)` pattern (Rule 7).
 *
 * Change detection: `OnPush`. Reading the store's `items` signal in the
 * template registers the template as a signal consumer, so the view refreshes
 * automatically when the store publishes a new array — no manual
 * `ChangeDetectorRef` plumbing is required. AAP § 0.7.1 confirms
 * `angular-gridster2` v21 is compatible with the app's
 * `provideZoneChangeDetection()` bootstrap.
 *
 * The public surface (class name `GfDashboardCanvasComponent` and selector
 * `gf-dashboard-canvas`) is a LOCKED cross-folder contract consumed verbatim
 * by `app.component.ts`, `app.component.html`, and `app.routes.ts`; it must not
 * be renamed.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfModuleShellComponent,
    Gridster,
    GridsterItem,
    IonIcon,
    MatButtonModule,
    MatDialogModule,
    MatProgressBarModule,
    NgComponentOutlet
  ],
  selector: 'gf-dashboard-canvas',
  standalone: true,
  styleUrls: ['./dashboard-canvas.component.scss'],
  templateUrl: './dashboard-canvas.component.html'
})
export class GfDashboardCanvasComponent implements OnDestroy, OnInit {
  // LOCKED grid specification (AAP § 0.6, Rule 6):
  //  - Fixed 12-column grid (minCols === maxCols === 12).
  //  - Constant-pixel row height (fixedRowHeight: 40) via GridType.VerticalFixed
  //    (rows are a fixed px height; columns fit the available viewport width).
  //  - Drag ONLY from the module shell's `.gf-module-drag-handle` button:
  //    gridster's Draggable interface has NO `handle` property, so the correct
  //    handle-only API is `dragHandleClass` (class name WITHOUT the leading dot)
  //    combined with `ignoreContent: true`.
  //  - Rule 6 minimum 2x2 is enforced redundantly: a global item floor
  //    (minItemCols/minItemRows), per-item minimums carried on each grid item
  //    by the store, AND itemValidateCallback rejecting anything below 2x2.
  //  - Rules 2/4: drag/resize/remove route to the store's syncFromGrid(),
  //    which is the single source of truth and owns the debounced persistence;
  //    module components never persist directly. itemInitCallback is the sole
  //    exception: initialization/hydration is NOT a state-change event, so it
  //    routes to publishFromGridWithoutPersist() (signal refresh only, no
  //    PATCH) to satisfy Rule 4 (persist EXCLUSIVELY on drag/resize/add/remove).
  //  - angular-gridster2 v21 mapping (verified against the installed
  //    node_modules types): the grid component is `Gridster` (selector
  //    `gridster`), the item component is `GridsterItem` (selector
  //    `gridster-item`), and the item DATA shape is `GridsterItemConfig`
  //    (carrying `x`/`y`/`cols`/`rows`, optional `minItemCols`/`minItemRows`,
  //    and an open index signature). To change options at runtime you assign a
  //    NEW GridsterConfig object (`api.optionsChanged()` was removed); this
  //    canvas never mutates its options.
  protected readonly options: GridsterConfig = {
    displayGrid: DisplayGrid.OnDragAndResize,
    draggable: {
      dragHandleClass: 'gf-module-drag-handle',
      enabled: true,
      ignoreContent: true
    },
    fixedRowHeight: 40,
    gridType: GridType.VerticalFixed,
    itemChangeCallback: () => this.store.syncFromGrid(),
    itemInitCallback: () => this.store.publishFromGridWithoutPersist(),
    itemRemovedCallback: () => this.store.syncFromGrid(),
    itemResizeCallback: () => this.store.syncFromGrid(),
    itemValidateCallback: (item: GridsterItemConfig) =>
      item.cols >= 2 && item.rows >= 2,
    maxCols: 12,
    minCols: 12,
    minItemCols: 2,
    minItemRows: 2,
    pushItems: true,
    resizable: {
      enabled: true
    }
  };

  protected readonly registry = inject(ModuleRegistryService);

  protected readonly store = inject(DashboardLayoutStoreService);

  private readonly destroyRef = inject(DestroyRef);

  private readonly dialog = inject(MatDialog);

  public constructor() {
    // Register the FAB's ionicons glyph (`add-outline`). Ghostfolio standardized
    // on ionicons (`<ion-icon>` + `addIcons`) rather than the Material Icons
    // glyph font (not bundled), so the add-module FAB renders a bundled ionicons
    // SVG for cohesion with the rest of the app.
    addIcons({ addOutline });
  }

  public ngOnInit() {
    // Rule 10: hydrate the persisted layout, then auto-open the module catalog
    // on first visit (when no saved layout exists). hydrate() emits `true` when
    // a saved layout with items was loaded, `false` for a first visit.
    this.store
      .hydrate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((hasLayout) => {
        if (!hasLayout) {
          this.openCatalog();
        }
      });
  }

  public ngOnDestroy() {
    // § 0.7.2 flush-on-destroy: force the store to persist any pending debounced
    // change so the final drag/resize/add/remove is not lost on teardown.
    this.store.flush();
  }

  protected onRemove(item: GridsterItemConfig & { type: string }) {
    // Rule 4: removal is a grid-level action routed through the store (which
    // schedules the debounced persist). The shell only emits `remove`. The
    // parameter carries the module-type key alongside the grid geometry so it
    // matches the store's canonical item shape consumed by `removeItem`.
    this.store.removeItem(item);
  }

  protected openCatalog() {
    this.dialog.open(GfModuleCatalogComponent, {
      autoFocus: false,
      maxWidth: '90vw',
      restoreFocus: false,
      width: '32rem'
    });
  }
}
