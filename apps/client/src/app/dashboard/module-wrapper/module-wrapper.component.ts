import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  input,
  output
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

// Module-scope i18n string constants (AAP § 0.7.4 selector convention,
// AAP agent prompt Phase 2 — i18n String Constants).
//
// These four constants back the dynamic `[attr.aria-label]` and
// `[matTooltip]` bindings on the drag-handle and remove buttons inside
// the wrapper template (see `module-wrapper.component.html`). They are
// declared at module scope (NOT as class fields with default expressions)
// because:
//
// 1. Module-scope `$localize` template literals are statically extractable
//    by the Angular i18n extractor (`ng extract-i18n`) — the same pattern
//    used in `chat-panel.component.ts:22` (`STREAM_ERROR_MESSAGE = $localize`).
// 2. The drag-handle and remove buttons rely on dynamic property bindings
//    (`[attr.aria-label]`, `[matTooltip]`) which cannot use the static
//    `i18n-aria-label="..."` / `i18n-matTooltip="..."` template attributes
//    (those work only with hard-coded literal text). Module-scope
//    `$localize` template literals satisfy both extractability and dynamic
//    binding compatibility.
// 3. Module-scope `$localize` calls require the runtime
//    `@angular/localize/init` import in the spec file's `beforeAll` /
//    top-level imports — that companion import is declared in
//    `module-wrapper.component.spec.ts`, mirroring the
//    `chat-panel.component.spec.ts:11` pattern.
const DRAG_ARIA_LABEL = $localize`Drag to reposition module`;
const DRAG_TOOLTIP = $localize`Drag to reposition`;
const REMOVE_ARIA_LABEL = $localize`Remove module from canvas`;
const REMOVE_TOOLTIP = $localize`Remove module`;

/**
 * Generic module chrome wrapper rendered inside each `<gridster-item>` on
 * the dashboard canvas. Provides the unified header (drag handle + title +
 * remove button) and a content projection slot for the wrapped
 * presentation component.
 *
 * Per Rule 2 (AAP § 0.8.1.2), the wrapper has NO layout-coordinate
 * inputs/outputs — position (`x`, `y`) and size (`cols`, `rows`) live
 * exclusively on the gridster `dashboard` array owned by
 * `GfDashboardCanvasComponent`. The wrapper is intentionally pure
 * presentation chrome. It does NOT inject `ElementRef`, NOT bind any
 * `style.width` / `style.height` / `style.transform` / `style.position`
 * properties on the host, NOT subscribe to any RxJS streams, and does NOT
 * mutate the gridster state directly. The host element fills the cell
 * its parent `<gridster-item>` allocates via the `:host { width: 100%;
 * height: 100% }` rule in the sibling SCSS file.
 *
 * Per Rule 1 (AAP § 0.8.1.1), the wrapper does NOT import from any other
 * dashboard subfolder (`dashboard-canvas/`, `module-catalog/`, `modules/`,
 * `services/`). Its dependency surface is limited to `@angular/common`,
 * `@angular/core`, and the two Angular Material modules used in the
 * template. This keeps the wrapper independently testable and free from
 * circular grid-layer references.
 *
 * The header drag-handle button carries the `.gf-module-drag-handle` CSS
 * class, which is the gridster `draggable.handle` selector configured in
 * `dashboard-canvas.component.ts` (`dragHandleClass:
 * 'gf-module-drag-handle'`). Module wrappers in
 * `apps/client/src/app/dashboard/modules/<name>/` consume this wrapper
 * via the `gf-module-wrapper` selector and project their content
 * presentation component into `<ng-content />`.
 *
 * Public API surface:
 *
 * - `title` — signal-based input. Module title shown inside the header
 *   `<h2>` element. Default empty string.
 * - `iconName` — signal-based input. Ionicons name shown alongside the
 *   title in the header. Default `'apps-outline'`.
 * - `remove` — signal-based output of `void`. Emits when the user
 *   activates the remove button; the parent canvas listens and removes
 *   the corresponding gridster item.
 * - `onRemove()` — public method bound to the remove button's `(click)`
 *   handler. Emits the `remove` output.
 *
 * Reference: AAP § 0.6.1.4 (Group 4 — Angular Dashboard Feature) is the
 * canonical specification for this contract; AAP § 0.7.4 governs the
 * `gf-module-wrapper` selector convention.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatButtonModule, MatTooltipModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-module-wrapper',
  styleUrls: ['./module-wrapper.component.scss'],
  templateUrl: './module-wrapper.component.html'
})
export class GfModuleWrapperComponent {
  /**
   * Module title shown inside the header `<h2>` element. Defaults to an
   * empty string so a wrapper rendered without an explicit title displays
   * an empty heading rather than throwing or rendering `undefined`. In
   * practice the catalog and module wrappers always pass a meaningful
   * value (the registered descriptor's `displayLabel`).
   *
   * Bound in the template as `{{ title() }}` (signal call).
   */
  public readonly title = input<string>('');

  /**
   * Ionicons name shown alongside the title in the header (NOT the
   * drag-handle icon, which is a fixed `'reorder-three-outline'`).
   * Defaults to `'apps-outline'`, a generic 4-square grid icon
   * appropriate as a fallback. In practice the catalog and module
   * wrappers always override this via the registered descriptor's
   * `iconName`.
   *
   * Bound in the template as `<ion-icon [name]="iconName()" />`.
   */
  public readonly iconName = input<string>('apps-outline');

  /**
   * Emits `void` whenever the user activates the remove button. The
   * receiving canvas knows which item to remove because the `(remove)`
   * listener is bound per-item in the canvas template, so no payload is
   * required on this emission.
   *
   * Per Rule 2 (AAP § 0.8.1.2), the wrapper does NOT mutate the gridster
   * state itself; it merely signals user intent. The canvas owns the
   * `dashboard` array and is the sole authority on item removal.
   */
  public readonly remove = output<void>();

  /**
   * Localized `aria-label` for the drag-handle button. Visible to assistive
   * technology only; sighted users see the corresponding tooltip.
   */
  protected readonly dragAriaLabel = DRAG_ARIA_LABEL;

  /**
   * Localized Material tooltip text for the drag-handle button. Shown on
   * hover and on keyboard focus per Material 3 affordance guidelines.
   */
  protected readonly dragTooltip = DRAG_TOOLTIP;

  /**
   * Localized `aria-label` for the remove button. Visible to assistive
   * technology only; sighted users see the corresponding tooltip.
   */
  protected readonly removeAriaLabel = REMOVE_ARIA_LABEL;

  /**
   * Localized Material tooltip text for the remove button. Shown on hover
   * and on keyboard focus per Material 3 affordance guidelines.
   */
  protected readonly removeTooltip = REMOVE_TOOLTIP;

  /**
   * Bound to the remove button's `(click)` handler in the template.
   * Emits the {@link remove} output.
   *
   * The method indirection (rather than binding `(click)="remove.emit()"`
   * directly) provides:
   *
   * - A clean entry point for unit tests:
   *   `expect(component.onRemove).toEmit(remove)` style assertions.
   * - A natural extension point for future enhancements (e.g., wrapping
   *   the emission in a confirmation dialog) without touching the
   *   template.
   */
  public onRemove(): void {
    this.remove.emit();
  }
}
