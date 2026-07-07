import { GfFinancialProfileFormComponent } from '@ghostfolio/client/components/financial-profile-form/financial-profile-form.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

/**
 * Dashboard grid-module wrapper for the Financial Profile feature.
 *
 * Adapts the existing `GfFinancialProfileFormComponent` (selector
 * `gf-financial-profile-form`) so it can be mounted as a self-contained grid
 * module by the dashboard canvas via `NgComponentOutlet`. The wrapped
 * component self-fetches its profile through `FinancialProfileService` in its
 * own `ngOnInit`, so no inputs are required (Adapter/Facade pattern, AAP
 * § 0.4.3). Behavior is preserved — the feature component is reused unchanged.
 *
 * Rule 1: imports ONLY the wrapped feature component (plus the Angular
 *   Material dialog tokens below); it does NOT import the grid engine
 *   (`angular-gridster2`), the dashboard canvas, the module shell, the layout
 *   store, or the module registry.
 * Rule 2: holds NO layout state. Rule 4: never calls a layout save API.
 *
 * `GfFinancialProfileFormComponent` is a Material dialog component: its
 * constructor injects the REQUIRED `MAT_DIALOG_DATA` and `MatDialogRef`
 * tokens, which are normally supplied by `MatDialog.open()`. Because the
 * canvas renders this wrapper via `NgComponentOutlet` (not through a dialog),
 * those tokens are absent and the component would throw
 * `NullInjectorError: No provider for MatDialogRef!` at runtime. We therefore
 * provide inert stubs at this wrapper's injector: an empty `MAT_DIALOG_DATA`
 * (the component never reads `data`) and a `MatDialogRef` whose `close()` is a
 * no-op (a grid module must not close/disappear when the user saves).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfFinancialProfileFormComponent],
  providers: [
    { provide: MAT_DIALOG_DATA, useValue: {} },
    // Inert `MatDialogRef` stub: `close()` is a no-op that returns `undefined`
    // so the wrapped form's Save/Cancel cannot tear down the grid module. An
    // expression body (rather than an empty `{}` block) also satisfies the
    // repo's `@typescript-eslint/no-empty-function` rule without suppressions.
    { provide: MatDialogRef, useValue: { close: () => undefined } }
  ],
  selector: 'gf-financial-profile-module',
  standalone: true,
  styleUrls: ['./financial-profile.component.scss'],
  templateUrl: './financial-profile.component.html'
})
export class GfFinancialProfileModuleComponent {}
