import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  inject,
  output,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { ModuleRegistryService } from '../module-registry.service';

// Module-scope `$localize` template literal — statically extractable for
// translation while compatible with the template's dynamic
// `[attr.aria-label]` property binding on the search input. Inline
// `i18n-aria-label="..."` template attributes are incompatible with
// dynamic property binding, so the canonical Angular i18n pattern for
// such cases is a module-scope `$localize` constant — see
// `apps/client/src/app/components/chat-panel/chat-panel.component.ts:22`
// (`STREAM_ERROR_MESSAGE = $localize\`...\``) and
// `apps/client/src/app/dashboard/module-wrapper/module-wrapper.component.ts:35-38`
// (`DRAG_ARIA_LABEL` / `REMOVE_ARIA_LABEL`) for the same pattern in
// peer components.
//
// Module-scope `$localize` calls depend on the global `$localize`
// function being installed at runtime by the `@angular/localize/init`
// side-effect import. The companion spec file is responsible for that
// import; the production runtime brings it in transitively via the
// Angular i18n bootstrap pipeline.
const SEARCH_ARIA_LABEL = $localize`Search modules`;

/**
 * Module catalog dialog — a searchable list of all registered dashboard
 * modules from `ModuleRegistryService`. Opened by `MatDialog` from the
 * dashboard canvas:
 *   - Programmatically on first visit when no saved layout exists
 *     (Rule 10, AAP § 0.8.1.10).
 *   - On user demand via the canvas FAB.
 *
 * Per Rule 3 (AAP § 0.8.1.3), the catalog is the user-facing entry
 * point that consumes the module registry as the SINGLE source of
 * available module types. The catalog does NOT import any module
 * wrapper component classes — it reads descriptor metadata
 * (`displayLabel`, `iconName`, `minCols`, `minRows`, `name`) from
 * `ModuleRegistryService.getAll()` and emits the descriptor `name`
 * on user-click for the canvas to resolve and instantiate via
 * `viewContainerRef.createComponent(descriptor.component)`.
 *
 * The two registered interaction paths per AAP § 0.0 (Intent
 * Clarification) are click-to-add and drag-to-place. v1 implements
 * click-to-add; drag-from-catalog is OUT OF SCOPE per the AAP folder
 * specification.
 *
 * **Rule compliance**:
 *   - Rule 1 (Module isolation, AAP § 0.8.1.1): NO imports from
 *     `dashboard-canvas/`, `module-wrapper/`, `modules/`, or
 *     `services/`. The catalog imports ONLY `ModuleRegistryService`,
 *     which is the SOLE permitted dependency for catalog discovery.
 *   - Rule 2 (Single source of truth, AAP § 0.8.1.2): the catalog has
 *     no layout-coordinate state. Position/size are owned by gridster
 *     (canvas).
 *   - Rule 3 (Registry is sole mechanism, AAP § 0.8.1.3): the catalog
 *     reads modules ONLY via `moduleRegistry.getAll()`.
 *   - Rule 4 (Persistence triggered ONLY by grid events,
 *     AAP § 0.8.1.4): the catalog does NOT call layout-save APIs. The
 *     `addModule` emission is consumed by the canvas, which triggers
 *     a grid-state-change event that flows through
 *     `LayoutPersistenceService`'s 500 ms debounce.
 *
 * **Output contract**: emits the descriptor's `name` (e.g., `'chat'`,
 * `'portfolio-overview'`) when the user clicks an Add button. The
 * canvas resolves the name to a descriptor via
 * `ModuleRegistryService.getByName(name)` and instantiates the
 * descriptor's `component` via `viewContainerRef.createComponent(...)`
 * at the next available cell position.
 *
 * @see ../module-registry.service.ts —
 *   {@link ModuleRegistryService} the SOLE dependency.
 * @see AAP § 0.5.2 — Component mapping (MatDialog + MatList +
 *   MatFormField + MatInput + MatButton + MatIcon).
 * @see AAP § 0.6.1.4 — Group 4 file contract.
 * @see AAP § 0.6.3.1 — first-visit catalog auto-open behavior
 *   (the canvas owns the auto-open trigger; this component is the
 *   dialog content).
 * @see AAP § 0.7.4 — Selector convention: `gf-module-catalog`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-module-catalog',
  styleUrls: ['./module-catalog.component.scss'],
  templateUrl: './module-catalog.component.html'
})
export class GfModuleCatalogComponent {
  /**
   * Output emitted when the user clicks an Add button on a catalog row.
   * The payload is the descriptor's stable `name` (e.g., `'chat'`,
   * `'portfolio-overview'`) — NOT the human-readable `displayLabel` —
   * so the canvas's listener can resolve the descriptor via
   * `ModuleRegistryService.getByName(name)` without ambiguity.
   *
   * Receivers (the canvas) bind `(addModule)="addModuleByName($event)"`
   * to capture the emission. The `output()` factory (Angular 21
   * standalone-only API) replaces the legacy `EventEmitter` /
   * `@Output()` decorator pattern — see
   * `apps/client/src/app/components/access-table/access-table.component.ts:55`
   * for the canonical repository precedent.
   */
  public readonly addModule = output<string>();

  /**
   * Backing writable signal for the search input's two-way binding
   * (`[ngModel]="searchTerm()"` paired with
   * `(ngModelChange)="searchTerm.set($event)"` in the template).
   *
   * Default value `''` is the empty-string sentinel that
   * {@link filteredModules} interprets as "show all modules". Tests
   * call `searchTerm.set(...)` directly to drive filter scenarios; the
   * computed signal recomputes synchronously per Angular's signal
   * graph evaluation rules.
   */
  public readonly searchTerm = signal<string>('');

  /**
   * Memoized derivation of the list of catalog rows to render. The
   * computed signal recomputes whenever {@link searchTerm} changes
   * (Angular's signal reactivity tracks the call to
   * `this.searchTerm()`).
   *
   * Filter semantics:
   *   - Empty / whitespace-only `searchTerm` returns the FULL
   *     {@link ModuleRegistryService.getAll} snapshot in registration
   *     order (Map insertion order — see the registry service's
   *     `getAll()` JSDoc).
   *   - Non-empty `searchTerm` performs a case-insensitive substring
   *     match against BOTH `displayLabel` (human-readable) AND `name`
   *     (kebab-case identifier). The two-field match lets users
   *     search by either form (e.g., typing `"holdings"` matches the
   *     descriptor whose `name` is `'holdings'`; typing `"Portfolio"`
   *     matches the descriptor whose `displayLabel` is
   *     `'Portfolio Overview'`).
   *
   * Computed signals are memoized — Angular only re-evaluates when a
   * tracked dependency changes. Inline template filtering would
   * re-evaluate on every change-detection cycle, which is inefficient
   * under OnPush. The `computed` is the canonical Angular 21
   * idiom — see
   * `apps/client/src/app/components/access-table/access-table.component.ts:61-69`
   * for the repository precedent.
   */
  public readonly filteredModules = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const all = this.moduleRegistry.getAll();

    if (term.length === 0) {
      return all;
    }

    return all.filter(
      (m) =>
        m.displayLabel.toLowerCase().includes(term) ||
        m.name.toLowerCase().includes(term)
    );
  });

  /**
   * Localized aria-label for the search input. Bound to the template's
   * `[attr.aria-label]="searchAriaLabel"` on the `<input matInput>`
   * inside the `<mat-form-field>`. `protected readonly` rather than
   * `public` follows Angular Standard Practice for template-only
   * fields — external consumers cannot read it, which discourages
   * downstream coupling to the catalog's localized strings.
   */
  protected readonly searchAriaLabel = SEARCH_ARIA_LABEL;

  /**
   * `DestroyRef` reserved per the AAP folder spec contract
   * (AAP § 0.6.1.4 enumerates `DestroyRef` among the catalog's
   * required injections). Unused in the v1 component body — there
   * are no RxJS subscriptions to tear down because the catalog is
   * fully reactive via signals — but kept as a future-proof hook for
   * v2 enhancements (e.g., subscribing to a registry change Observable
   * via `takeUntilDestroyed(this.destroyRef)`). Including it incurs
   * no runtime cost.
   *
   * Declared `protected` rather than `private` so TypeScript's
   * `noUnusedLocals` check (enabled in `tsconfig.base.json`) does not
   * flag the field as unused — `noUnusedLocals` flags unused private
   * class members but does NOT flag protected/public ones. The
   * effective visibility for the v1 catalog body is unchanged because
   * no caller currently dereferences the field.
   */
  protected readonly destroyRef = inject(DestroyRef);

  /**
   * Typed reference to the host `MatDialog` instance, narrowed via
   * the generic parameter so future enhancements that pass dialog
   * data via `MatDialogConfig.data` are correctly typed without
   * widening to `MatDialogRef<unknown>`. The pattern mirrors
   * `apps/client/src/app/components/account-detail-dialog/account-detail-dialog.component.ts:111`.
   *
   * The catalog never reads from the dialog ref — its only use is
   * `this.dialogRef.close()` in {@link onCloseDialog}. The canvas is
   * responsible for handling the dialog's `afterClosed()` lifecycle
   * (e.g., applying focus restoration); the catalog component does
   * NOT subscribe to it (anti-pattern for dialog content components).
   */
  private readonly dialogRef =
    inject<MatDialogRef<GfModuleCatalogComponent>>(MatDialogRef);

  /**
   * Synchronous handle on the SINGLE source of allowed module types
   * (Rule 3, AAP § 0.8.1.3). The catalog reads modules ONLY via
   * `this.moduleRegistry.getAll()` (consumed inside
   * {@link filteredModules}); it does NOT import any module wrapper
   * component classes, and does NOT instantiate components — the
   * canvas instantiates via
   * `viewContainerRef.createComponent(descriptor.component)`.
   */
  private readonly moduleRegistry = inject(ModuleRegistryService);

  /**
   * Builds a localized aria-label for a per-row Add button —
   * e.g., `"Add Holdings to canvas"`. The template binds
   * `[attr.aria-label]="getAddAriaLabel(module.displayLabel)"` on
   * each row's `<button mat-icon-button matListItemMeta>`.
   *
   * **Why a method (not a computed signal)**: the aria-label is a
   * string-construction function whose dependency is the per-call
   * `label` parameter — NOT any of the component's signals. A
   * `computed(...)` would be the wrong abstraction because the
   * computation depends on a per-row argument, not on tracked
   * reactive state.
   *
   * **Why the explicit translation key `:@@gfModuleCatalogAddAriaLabel:`**:
   * `$localize` template literals with interpolated values produce
   * source strings that vary per call. Without an explicit
   * translation key (the leading `:@@<key>:` syntax — Angular's
   * canonical i18n meaning marker), the i18n extractor may fail to
   * deduplicate the string. Pinning the translation unit ensures
   * translators see exactly one entry like `"Add {0} to canvas"`
   * rather than one entry per module's `displayLabel`.
   *
   * @param label The module's human-readable `displayLabel`
   *   (e.g., `'Holdings'`, `'Portfolio Overview'`).
   * @returns A localized aria-label string ready for binding to the
   *   row's Add button.
   */
  public getAddAriaLabel(label: string): string {
    return $localize`:@@gfModuleCatalogAddAriaLabel:Add ${label} to canvas`;
  }

  /**
   * Add-button click handler — emits the descriptor's stable `name`
   * via the {@link addModule} output for the canvas to consume.
   *
   * The method exists (rather than the template directly invoking
   * `addModule.emit(...)`) so the public API surface for tests is a
   * named method whose contract is verifiable in isolation, and so
   * future extensions (e.g., a telemetry call before the emission)
   * have a single seam to extend.
   *
   * @param name The descriptor's `name` field, passed through
   *   `(click)="onAddModule(module.name)"` from the template.
   */
  public onAddModule(name: string): void {
    this.addModule.emit(name);
  }

  /**
   * Close-button click handler — closes the dialog without a return
   * value. The canvas's `dialog.open(...)` site handles
   * `afterClosed()` lifecycle (e.g., restoring focus to the FAB);
   * this component intentionally does NOT subscribe to
   * `afterClosed()` because dialog content components owning their
   * own teardown is an anti-pattern.
   */
  public onCloseDialog(): void {
    this.dialogRef.close();
  }
}
