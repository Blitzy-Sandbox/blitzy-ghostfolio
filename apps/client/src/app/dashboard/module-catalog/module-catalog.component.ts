import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { DashboardLayoutStoreService } from '../dashboard-layout-store.service';
import { DashboardModuleDefinition } from '../dashboard-module.interface';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Searchable module catalog rendered as an Angular Material dialog overlay.
 *
 * - Lists ALL registered module types from `ModuleRegistryService.list()`;
 *   the registry is the ONLY source of module types (Rule 3).
 * - The visible list is a `computed` view filtered case-insensitively by the
 *   module `name` against a `signal`-backed search term.
 * - Clicking a module computes the next free grid position (stack at the
 *   bottom) and appends a new grid item to `DashboardLayoutStoreService`, with
 *   the per-module minimum cell dimensions sourced from the registry
 *   definition (Rule 6). The store owns the debounced persistence (Rule 4);
 *   this component never calls a save/HTTP API directly.
 *
 * The canvas opens this dialog on init when the hydrated layout is empty
 * (Rule 10 auto-open).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule
  ],
  selector: 'gf-module-catalog',
  styleUrls: ['./module-catalog.component.scss'],
  templateUrl: './module-catalog.component.html'
})
export class GfModuleCatalogComponent {
  public readonly searchTerm = signal<string>('');

  public readonly filteredModules = computed<DashboardModuleDefinition[]>(
    () => {
      const term = this.searchTerm().trim().toLowerCase();
      const modules = this.registry.list();

      if (!term) {
        return modules;
      }

      return modules.filter((definition) =>
        definition.name.toLowerCase().includes(term)
      );
    }
  );

  private readonly dialogRef =
    inject<MatDialogRef<GfModuleCatalogComponent>>(MatDialogRef);
  private readonly registry = inject(ModuleRegistryService);
  private readonly store = inject(DashboardLayoutStoreService);

  /**
   * Append the selected module to the grid at the next free position.
   *
   * The next Y is computed by stacking below the lowest existing item
   * (`max(item.y + item.rows)`), placed at column 0. The initial size uses the
   * registry `defaultCols`/`defaultRows`, falling back to the module minimums.
   * `minItemCols`/`minItemRows` are sourced from the registry definition so the
   * grid engine enforces the 2x2 minimum for this item (Rule 6).
   *
   * Pushing to the store triggers the store's debounced persist (Rule 4); the
   * catalog does NOT persist directly. The dialog is intentionally left open so
   * the user can add several modules in one session.
   */
  public onAddModule(definition: DashboardModuleDefinition): void {
    const items = this.store.items();
    const y = items.reduce((max, item) => Math.max(max, item.y + item.rows), 0);

    this.store.addItem({
      cols: definition.defaultCols ?? definition.minCols,
      minItemCols: definition.minCols,
      minItemRows: definition.minRows,
      rows: definition.defaultRows ?? definition.minRows,
      type: definition.id,
      x: 0,
      y
    });
  }

  /** Close the catalog dialog. */
  public onClose(): void {
    this.dialogRef.close();
  }
}
