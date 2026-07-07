import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * `GfModuleShellComponent` renders the shared, grid-agnostic presentational
 * chrome that wraps every dashboard module. The chrome is a header bar
 * containing a drag handle, an optional leading Material icon, the module
 * title, a flexible spacer, and a remove action, followed by a projected body
 * (`<ng-content>`) that hosts the wrapped feature component.
 *
 * Design-system compliance (AAP § 0.3.2, Decision D-020):
 * - Uses the `gf` selector prefix (`gf-module-shell`).
 * - Header actions are Angular Material `mat-icon-button` + `<mat-icon>` with
 *   `matTooltip` affordances, backed by the three imported Material modules.
 * - All visual styling lives in the sibling `module-shell.component.scss`, which
 *   applies the mandated `var(--mat-sys-<token>, <fallback>)` pattern (Rule 7).
 *
 * Architectural constraints:
 * - **Rule 1 (isolation):** this component depends only on `@angular/core` and
 *   three `@angular/material/*` modules; it deliberately references nothing from
 *   the grid layer.
 * - **Rule 2 (single source of truth):** the shell holds no layout state;
 *   module positions and sizes are owned elsewhere.
 * - **Rule 4 (persistence trigger):** the shell only *emits* the `remove`
 *   event; it never calls a persistence API directly. The host component is
 *   responsible for wiring `(remove)` to the layout-state owner, which in turn
 *   triggers debounced persistence.
 *
 * The public surface (selector, class name, `title`, `icon`, `remove`) is a
 * LOCKED contract consumed verbatim by the dashboard host component; it must
 * not be renamed, extended, or reduced.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  selector: 'gf-module-shell',
  standalone: true,
  styleUrls: ['./module-shell.component.scss'],
  templateUrl: './module-shell.component.html'
})
export class GfModuleShellComponent {
  /**
   * Required display name for the module, rendered in the header title slot.
   * No initializer is needed because `strictPropertyInitialization` is disabled
   * in `tsconfig.base.json`; Angular enforces presence at runtime via the
   * `required: true` input option.
   */
  @Input({ required: true }) public title: string;

  /**
   * Optional Material icon ligature (e.g. `'dashboard'`) shown before the
   * title. When omitted, the leading icon slot is not rendered.
   */
  @Input() public icon?: string;

  /**
   * Emitted when the user activates the header's remove action. The shell only
   * emits — it never mutates layout state (Rule 4). The host component
   * subscribes and routes the event to the layout-state owner.
   */
  @Output() public readonly remove = new EventEmitter<void>();
}
