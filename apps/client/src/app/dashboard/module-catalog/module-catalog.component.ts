import {
  MODULE_DRAG_DATA_TYPE,
  ModuleDefinition
} from '@ghostfolio/client/dashboard/dashboard.types';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * Searchable, auto-opening module catalog (the "introduce a module" surface).
 *
 * Renders the metadata of every registered module — obtained from
 * {@link ModuleRegistryService.getAll} — as a searchable list, and relays the
 * `key` of the chosen module upward via {@link addModule}, either on click
 * ({@link onAddModule}) or when a row is dragged onto the canvas
 * ({@link onDragStart}). The parent canvas owns the actual placement of the
 * module on the grid. The component imports neither the canvas layer nor any
 * feature/wrapper component; additions flow upward as a plain `string` key.
 *
 * The component owns its own open/close state (the {@link opened} signal) so
 * the canvas can drive first-visit auto-open through {@link autoOpen} while
 * still reacting to user-driven closes (backdrop click / ESC) relayed by the
 * `MatSidenav` through {@link onSidenavOpenedChange} and surfaced on
 * {@link openedChange}.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
    MatSidenavModule,
    MatTooltipModule
  ],
  selector: 'gf-module-catalog',
  styleUrls: ['./module-catalog.component.scss'],
  templateUrl: './module-catalog.component.html'
})
export class GfModuleCatalogComponent implements OnInit {
  /**
   * When `true`, the catalog opens itself in {@link ngOnInit}. The canvas sets
   * this on first visit (when the persisted layout `get()` resolves to `null`)
   * so a brand-new user lands on a blank canvas with the catalog already open.
   * The component performs no storage reads and no API calls to decide this —
   * the decision is made upstream and handed in as a plain input.
   */
  @Input() public autoOpen = false;

  /**
   * Emits the stable `key` of the module the user chose to add. Kept a plain
   * `string` (never a component reference) so the catalog stays decoupled from
   * the grid and the feature components.
   */
  @Output() public addModule = new EventEmitter<string>();

  /**
   * Mirrors the catalog's open/close state to the parent so the canvas can
   * keep its own "is the catalog open" view in sync with user-driven closes
   * (backdrop / ESC), not just programmatic {@link open}/{@link close} calls.
   */
  @Output() public openedChange = new EventEmitter<boolean>();

  /**
   * Authoritative open/close state of the catalog overlay. Read in the
   * template's `@if (opened())` guard so the entire `MatSidenav` is created
   * only while the catalog is open.
   */
  public opened = signal<boolean>(false);

  /**
   * The current search term, two-way bound to the search input via
   * `[ngModel]="searchTerm()"` + `(ngModelChange)="searchTerm.set($event)"`.
   */
  public searchTerm = signal<string>('');

  /**
   * The registered modules filtered by {@link searchTerm}. Recomputed
   * automatically whenever the search term changes (signal-driven). The match
   * is a case-insensitive substring test against each module's `displayName`;
   * an empty/whitespace-only term returns every registered module. The element
   * type is stated explicitly (`ModuleDefinition[]`) to satisfy lint strictness
   * and document the catalog's row contract.
   */
  public readonly filteredModules = computed<ModuleDefinition[]>(() => {
    const searchTerm = this.searchTerm().trim().toLowerCase();
    const modules = this.moduleRegistryService.getAll();

    if (!searchTerm) {
      return modules;
    }

    return modules.filter((module) =>
      module.displayName.toLowerCase().includes(searchTerm)
    );
  });

  private readonly moduleRegistryService = inject(ModuleRegistryService);

  /**
   * Honors {@link autoOpen}: opens the catalog on first render when the canvas
   * has flagged this as a first visit.
   */
  public ngOnInit(): void {
    if (this.autoOpen) {
      this.open();
    }
  }

  /**
   * Closes the catalog overlay (programmatic close, e.g. the header close
   * button or after a module is added).
   */
  public close(): void {
    this.setOpened(false);
  }

  /**
   * Relays a user-selected module's `key` to the parent canvas. The canvas is
   * responsible for placing it at the next available grid position; this
   * component never touches the grid itself.
   *
   * @param key - The stable registry key of the chosen module.
   */
  public onAddModule(key: string): void {
    this.addModule.emit(key);
  }

  /**
   * Begins a drag-add: writes the module `key` onto the drag's `DataTransfer`
   * under {@link MODULE_DRAG_DATA_TYPE} and marks the operation as a copy, so
   * the canvas drop handler can read the key and place the module. The catalog
   * performs no placement itself — dropping on the canvas drives
   * {@link addModule} through the canvas.
   *
   * @param event - The native `dragstart` event for the catalog row.
   * @param key - The stable registry key of the dragged module.
   */
  public onDragStart(event: DragEvent, key: string): void {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.setData(MODULE_DRAG_DATA_TYPE, key);
    event.dataTransfer.effectAllowed = 'copy';
  }

  /**
   * Relays the `MatSidenav`'s own open-state changes (backdrop click / ESC /
   * programmatic) back into the component's {@link opened} state, keeping the
   * drawer and the signal in lockstep.
   *
   * @param value - The sidenav's new open state.
   */
  public onSidenavOpenedChange(value: boolean): void {
    this.setOpened(value);
  }

  /**
   * Opens the catalog overlay (e.g. from the canvas's "Add module" toolbar
   * control or on first-visit auto-open).
   */
  public open(): void {
    this.setOpened(true);
  }

  /**
   * Toggles the catalog overlay between open and closed.
   */
  public toggle(): void {
    this.setOpened(!this.opened());
  }

  /**
   * Single, guarded mutation path for {@link opened}. The early return when the
   * value is unchanged prevents redundant {@link openedChange} emissions and,
   * critically, breaks the feedback loop that would otherwise occur between
   * {@link onSidenavOpenedChange} (sidenav -> component) and the template's
   * `[opened]` binding (component -> sidenav).
   *
   * On every open transition the {@link searchTerm} is reset to an empty
   * string so the catalog always presents the full, unfiltered module list
   * when it (re)opens. Because the catalog is hidden by the `MatSidenav`
   * rather than destroyed, a search term typed before a close would otherwise
   * persist and leave the list filtered (or showing "No modules found.") on
   * the next open (QA finding F2-05). The reset is placed after the
   * unchanged-value guard, so it fires exactly once per open transition and
   * never while the catalog is already open and being interacted with.
   *
   * @param value - The desired open state.
   */
  private setOpened(value: boolean): void {
    if (this.opened() === value) {
      return;
    }

    if (value) {
      this.searchTerm.set('');
    }

    this.opened.set(value);
    this.openedChange.emit(value);
  }
}
