import { ModuleDefinition } from '@ghostfolio/client/dashboard/dashboard.types';
import { ModuleRegistryService } from '@ghostfolio/client/dashboard/module-registry.service';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
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
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, closeOutline } from 'ionicons/icons';

/**
 * Custom `DataTransfer` MIME type that carries ONLY a module's stable registry
 * `key` during a drag-to-add gesture. Using a feature-specific type (rather
 * than `text/plain`) lets the drop handler ignore unrelated drags (text
 * selections, files, other apps) and keeps the contract self-describing.
 * Exported so the co-located spec can assert the exact payload that is set on
 * `dragstart` and read on `drop`.
 */
export const MODULE_KEY_DATA_TRANSFER_TYPE = 'application/x-gf-module-key';

/**
 * Searchable, auto-opening module catalog for the dashboard canvas.
 *
 * The catalog is the pure, isolated "introduce a module" surface: it renders
 * the metadata of every module type registered with {@link ModuleRegistryService}
 * (its SOLE source of modules — see AAP registry-only-introduction rule),
 * filters them client-side by a case-insensitive search term, and emits the
 * selected module's stable `key` UPWARD via {@link addModule}. A module can be
 * added two ways — clicking a row ({@link onAddModule}) OR dragging a row onto
 * the canvas ({@link onModuleDragStart} → {@link onCatalogDrop}) — and BOTH
 * paths funnel through the single `addModule` output, carrying only the
 * `string` key. It deliberately knows nothing about the grid canvas, layout
 * persistence, or the underlying feature components, which structurally
 * enforces the AAP module-isolation rule — additions only ever flow up as a
 * `string` key.
 *
 * The component owns its own open/close state (the {@link opened} signal plus
 * the {@link openedChange} output) so the canvas can drive first-visit
 * auto-open (via {@link autoOpen}) from a toolbar AND stay in sync with
 * user-driven closes (backdrop click / ESC) that originate inside the
 * `MatSidenav`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    IonIcon,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatListModule,
    MatSidenavModule,
    MatTooltipModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-module-catalog',
  styleUrls: ['./module-catalog.component.scss'],
  templateUrl: './module-catalog.component.html'
})
export class GfModuleCatalogComponent implements OnInit {
  /**
   * When `true`, the catalog opens itself once on initialization. The canvas
   * sets this to `true` on first visit (when the layout `get()` resolves to
   * `null`) so a brand-new user lands on a blank canvas with the catalog
   * already open. This input must NOT read storage or call any API.
   */
  @Input() public autoOpen = false;

  /**
   * Emits the stable `key` of the module the user chose to add. Carrying only
   * the key (never a component reference) keeps the catalog decoupled from the
   * canvas and the feature modules.
   */
  @Output() public addModule = new EventEmitter<string>();

  /**
   * Mirrors every transition of the internal open/close state so the parent
   * canvas can react to user-driven closes (backdrop / ESC) as well as to
   * programmatic open/close calls.
   */
  @Output() public openedChange = new EventEmitter<boolean>();

  /** Authoritative open/close state of the catalog drawer. */
  public opened = signal<boolean>(false);

  /** Current free-text search term bound to the catalog search input. */
  public searchTerm = signal<string>('');

  /**
   * The registry's module definitions filtered by the current search term.
   * Empty term returns every registered module; otherwise modules whose
   * `displayName` contains the term (case-insensitive) are retained.
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

  public constructor() {
    // Register the catalog's own chrome icons (the close-drawer control and the
    // per-row "add" affordance). The 12 per-module icons rendered via
    // `<ion-icon [name]="module.icon">` are registered by ModuleRegistryService
    // alongside their name declarations, so the catalog only owns its chrome.
    addIcons({ addOutline, closeOutline });
  }

  public ngOnInit(): void {
    if (this.autoOpen) {
      this.open();
    }
  }

  /** Closes the catalog drawer (no-op when already closed). */
  public close(): void {
    this.setOpened(false);
  }

  /** Relays a catalog-item selection upward as the chosen module key. */
  public onAddModule(key: string): void {
    this.addModule.emit(key);
  }

  /**
   * `dragover` handler on the catalog overlay. The browser only fires `drop`
   * when the preceding `dragover` calls `preventDefault()`, so this enables the
   * drop target — but ONLY for our own module-key drags (identified by
   * {@link MODULE_KEY_DATA_TRANSFER_TYPE} in `dataTransfer.types`), leaving
   * unrelated drags (text, files, other apps) to fall through untouched.
   */
  public onCatalogDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(MODULE_KEY_DATA_TRANSFER_TYPE)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  /**
   * `drop` handler completing a drag-to-add gesture. Reads the module `key`
   * carried in {@link MODULE_KEY_DATA_TRANSFER_TYPE} and, when it resolves to a
   * registered module, emits it through the SAME {@link addModule} output as a
   * click — so the canvas places it at the next available position. The
   * `has()` guard enforces the registry-only-introduction rule: a spoofed or
   * foreign payload that is not a known key emits nothing.
   */
  public onCatalogDrop(event: DragEvent): void {
    const key = event.dataTransfer?.getData(MODULE_KEY_DATA_TRANSFER_TYPE);

    if (!key || !this.moduleRegistryService.has(key)) {
      return;
    }

    event.preventDefault();
    this.addModule.emit(key);
  }

  /**
   * `dragstart` handler on a catalog row. Writes ONLY the module's stable
   * registry `key` into the drag's `dataTransfer` (never a component reference)
   * and marks the operation as a copy, preserving the catalog's isolation — the
   * drop side learns nothing about the catalog beyond the key it must add.
   */
  public onModuleDragStart(key: string, event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.setData(MODULE_KEY_DATA_TRANSFER_TYPE, key);
    event.dataTransfer.effectAllowed = 'copy';
  }

  /**
   * Relays the `MatSidenav`'s own open-state changes (e.g. backdrop click or
   * ESC) into the internal state so {@link opened} stays authoritative.
   */
  public onSidenavOpenedChange(value: boolean): void {
    this.setOpened(value);
  }

  /** Opens the catalog drawer (no-op when already open). */
  public open(): void {
    this.setOpened(true);
  }

  /** Toggles the catalog drawer between open and closed. */
  public toggle(): void {
    this.setOpened(!this.opened());
  }

  /**
   * Single mutation point for the open/close state. The equality guard
   * prevents redundant `openedChange` emissions and avoids a feedback loop
   * with the `MatSidenav`'s own `(openedChange)` relay.
   */
  private setOpened(value: boolean): void {
    if (this.opened() === value) {
      return;
    }

    this.opened.set(value);
    this.openedChange.emit(value);
  }
}
