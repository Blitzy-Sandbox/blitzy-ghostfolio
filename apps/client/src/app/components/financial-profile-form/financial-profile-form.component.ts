import { FinancialProfileService } from '@ghostfolio/client/services/financial-profile.service';
import {
  FinancialProfile,
  InvestmentGoal,
  RiskTolerance
} from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';

/**
 * Conservative fallback floor for `retirementTargetAge` when the
 * authenticated user's actual age is unknown (the existing `User` model
 * does not expose a date of birth — see `libs/common/src/lib/interfaces/user.interface.ts`).
 *
 * Per AAP § 0.5.3, when age cannot be determined the validator falls back
 * to the documented minimum of 18.
 */
const FALLBACK_MIN_RETIREMENT_AGE = 18;

/**
 * Material dialog form for editing the authenticated user's
 * {@link FinancialProfile}.
 *
 * **Loading workflow** (per AAP § 0.5.3):
 *
 * 1. On open, the component calls
 *    {@link FinancialProfileService.get | financialProfileService.get()}.
 * 2. If a record exists, the form is pre-populated from the response.
 * 3. If the server returns 404 (translated to `null` by the service), the
 *    form is left empty for first-time setup.
 * 4. The Save action calls {@link FinancialProfileService.patch}.
 *
 * **Authorization**: the request body MUST NOT include `userId` —
 * the server scopes by JWT-derived user ID per Rule 5. The submitted
 * payload uses an empty-string placeholder for `userId` which the server
 * ignores.
 *
 * **Custom validator**: `retirementAgeAboveCurrentAgeValidator` is a
 * closure over `this` so the form's `retirementTargetAge` control re-runs
 * its check whenever `currentUserAgeYears` is updated. We trigger
 * `updateValueAndValidity({ emitEvent: false })` after the user state
 * arrives to apply the new floor without firing a value-change event.
 *
 * **Class name**: `GfFinancialProfileFormComponent` retains the `Gf`
 * prefix per AAP § 0.7.4 (Material dialogs in the Ghostfolio codebase use
 * the prefix consistently — see `GfCreateOrUpdatePlatformDialogComponent`,
 * `GfLoginWithAccessTokenDialogComponent`).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'h-100' },
  imports: [
    CommonModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    ReactiveFormsModule
  ],
  selector: 'gf-financial-profile-form',
  styleUrls: ['./financial-profile-form.component.scss'],
  templateUrl: './financial-profile-form.component.html'
})
export class GfFinancialProfileFormComponent implements OnInit {
  /**
   * `true` while the initial GET is in flight or while a PATCH is being
   * processed. Drives the disabled state of the submit button.
   */
  public readonly isLoading = signal<boolean>(false);

  /**
   * Most recent error encountered during load or save. Cleared on the next
   * successful operation.
   */
  public readonly errorMessage = signal<string | null>(null);

  /**
   * Cached current age of the authenticated user in years, when known.
   * Drives the dynamic floor on `retirementTargetAge` per AAP § 0.5.3.
   * `null` falls back to {@link FALLBACK_MIN_RETIREMENT_AGE}.
   */
  public readonly currentUserAgeYears = signal<number | null>(null);

  /**
   * Available risk-tolerance values. Mirrors the server-side
   * {@link RiskTolerance} enum so the `<mat-select>` options stay in sync
   * with the Prisma model.
   */
  public readonly riskToleranceOptions: readonly RiskTolerance[] = [
    'LOW',
    'MEDIUM',
    'HIGH'
  ];

  public profileForm: FormGroup;

  private readonly destroyRef = inject(DestroyRef);

  public constructor(
    private readonly dialogRef: MatDialogRef<GfFinancialProfileFormComponent>,
    private readonly financialProfileService: FinancialProfileService,
    private readonly formBuilder: FormBuilder
  ) {
    this.profileForm = this.buildForm();
  }

  /**
   * Convenience accessor for the `investmentGoals` `FormArray`. Used by the
   * template to render a row per goal.
   */
  public get investmentGoals(): FormArray<FormGroup> {
    return this.profileForm.get('investmentGoals') as FormArray<FormGroup>;
  }

  public ngOnInit(): void {
    this.loadProfile();
  }

  /**
   * Appends an empty investment-goal row to the form array. The row's
   * controls share the same validators as goals loaded from the server.
   */
  public addInvestmentGoal(): void {
    this.investmentGoals.push(this.buildGoalGroup());
  }

  /**
   * Removes the goal at the supplied index. Bails out silently for an
   * out-of-range index so accidental double-clicks cannot throw.
   */
  public removeInvestmentGoal(index: number): void {
    if (index < 0 || index >= this.investmentGoals.length) {
      return;
    }

    this.investmentGoals.removeAt(index);
  }

  public onCancel(): void {
    this.dialogRef.close();
  }

  /**
   * Submits the form. Aborts early if the form is invalid (touches every
   * control first so error states render). On success the dialog closes
   * and resolves with the persisted profile so the host page can refresh.
   */
  public onSubmit(): void {
    if (this.profileForm.invalid) {
      this.profileForm.markAllAsTouched();

      return;
    }

    const payload = this.toFinancialProfile(this.profileForm.value);

    this.isLoading.set(true);
    this.errorMessage.set(null);

    this.financialProfileService
      .patch(payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.isLoading.set(false);
          this.errorMessage.set(this.deriveErrorMessage(error));
        },
        next: (profile) => {
          this.isLoading.set(false);
          this.dialogRef.close(profile);
        }
      });
  }

  /**
   * Builds the root reactive form group. The `retirementTargetAge` control
   * uses the closure-based validator so the floor automatically updates
   * when {@link currentUserAgeYears} changes.
   */
  private buildForm(): FormGroup {
    return this.formBuilder.group({
      investmentGoals: this.formBuilder.array<FormGroup>([]),
      monthlyDebtObligations: new FormControl<number | null>(null, [
        Validators.required,
        Validators.min(0)
      ]),
      monthlyIncome: new FormControl<number | null>(null, [
        Validators.required,
        Validators.min(0)
      ]),
      retirementTargetAge: new FormControl<number | null>(null, [
        Validators.required,
        Validators.min(FALLBACK_MIN_RETIREMENT_AGE),
        Validators.max(120),
        this.retirementAgeAboveCurrentAgeValidator()
      ]),
      retirementTargetAmount: new FormControl<number | null>(null, [
        Validators.required,
        Validators.min(0)
      ]),
      riskTolerance: new FormControl<RiskTolerance | null>(null, [
        Validators.required
      ]),
      timeHorizonYears: new FormControl<number | null>(null, [
        Validators.required,
        Validators.min(1)
      ])
    });
  }

  private buildGoalGroup(goal?: InvestmentGoal): FormGroup {
    return this.formBuilder.group({
      label: new FormControl<string>(goal?.label ?? '', [Validators.required]),
      targetAmount: new FormControl<number | null>(goal?.targetAmount ?? null, [
        Validators.required,
        Validators.min(0)
      ]),
      targetDate: new FormControl<Date | string | null>(
        goal ? this.parseDate(goal.targetDate) : null,
        [Validators.required]
      )
    });
  }

  /**
   * Issues the GET, hydrates the form on success, and leaves the form
   * untouched on a `null` response (server 404, indicating first-time
   * setup per AAP § 0.5.3).
   */
  private loadProfile(): void {
    this.isLoading.set(true);
    this.errorMessage.set(null);

    this.financialProfileService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.isLoading.set(false);
          this.errorMessage.set(this.deriveErrorMessage(error));
        },
        next: (profile) => {
          this.isLoading.set(false);

          if (profile !== null) {
            this.populateForm(profile);
          }
        }
      });
  }

  private populateForm(profile: FinancialProfile): void {
    this.profileForm.patchValue({
      monthlyDebtObligations: profile.monthlyDebtObligations,
      monthlyIncome: profile.monthlyIncome,
      retirementTargetAge: profile.retirementTargetAge,
      retirementTargetAmount: profile.retirementTargetAmount,
      riskTolerance: profile.riskTolerance,
      timeHorizonYears: profile.timeHorizonYears
    });

    // Replace the entire goals array so stale rows from a previous open
    // don't persist into the next render.
    this.investmentGoals.clear();

    for (const goal of profile.investmentGoals ?? []) {
      this.investmentGoals.push(this.buildGoalGroup(goal));
    }

    // Re-run the closure-based validator so the floor reflects whatever
    // age value we may have learned in the meantime.
    this.profileForm
      .get('retirementTargetAge')
      ?.updateValueAndValidity({ emitEvent: false });
  }

  /**
   * Constructs the closure-based validator for `retirementTargetAge`. The
   * returned function captures `this` so it always reads the most recent
   * value of {@link currentUserAgeYears}; we trigger
   * `updateValueAndValidity({ emitEvent: false })` after the age signal is
   * updated to apply the new floor without firing a value-change event.
   */
  private retirementAgeAboveCurrentAgeValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      // `AbstractControl.value` is typed as `any` by Angular Forms, so we
      // narrow it to `unknown` here before applying explicit `typeof`
      // checks. This eliminates the implicit-`any` propagation while
      // preserving the runtime semantics: only numeric strings or numbers
      // are converted; anything else falls through to the
      // `retirementAgeInvalid` branch.
      const value: unknown = control.value;

      if (value === null || value === undefined || value === '') {
        // `Validators.required` reports the missing-value error.
        return null;
      }

      const numericValue = typeof value === 'number' ? value : Number(value);

      if (Number.isNaN(numericValue)) {
        return { retirementAgeInvalid: true };
      }

      const currentAge = this.currentUserAgeYears();
      const floor = currentAge ?? FALLBACK_MIN_RETIREMENT_AGE;

      if (numericValue <= floor) {
        return {
          retirementAgeBelowCurrent: {
            actual: numericValue,
            min: floor + 1
          }
        };
      }

      return null;
    };
  }

  /**
   * Normalizes the form's date controls (which receive `Date` instances
   * from `MatDatepicker`) into ISO-8601 date strings for transport. The
   * server-side `InvestmentGoalDto.targetDate` is decorated with
   * `@IsDateString()` per AAP § 0.5.1.1 and accepts either a date-only or
   * full date-time form; we emit full ISO-8601 to match the JSDoc on the
   * server DTO.
   */
  private normalizeDateToString(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === 'string') {
      return value;
    }

    return '';
  }

  /**
   * Parses a server-supplied date string back into a `Date` instance for
   * `MatDatepicker` to consume. Returns `null` for empty strings so the
   * datepicker shows an empty field rather than `Invalid Date`.
   */
  private parseDate(value: string | null | undefined): Date | null {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed;
  }

  /**
   * Converts the raw form value into a {@link FinancialProfile} payload
   * suitable for `patch()`. Per Rule 5 the `userId` field is set to an
   * empty string here — the server ignores it and uses the JWT-verified
   * user ID. Non-data fields (`createdAt`, `updatedAt`) are likewise
   * placeholders that the server overrides.
   */
  private toFinancialProfile(value: {
    investmentGoals?: {
      label?: string;
      targetAmount?: number | null;
      targetDate?: Date | string | null;
    }[];
    monthlyDebtObligations?: number | null;
    monthlyIncome?: number | null;
    retirementTargetAge?: number | null;
    retirementTargetAmount?: number | null;
    riskTolerance?: RiskTolerance | null;
    timeHorizonYears?: number | null;
  }): FinancialProfile {
    const now = new Date().toISOString();

    return {
      createdAt: now,
      investmentGoals: (value.investmentGoals ?? []).map((goal) => ({
        label: goal.label ?? '',
        targetAmount:
          typeof goal.targetAmount === 'number' ? goal.targetAmount : 0,
        targetDate: this.normalizeDateToString(goal.targetDate)
      })),
      monthlyDebtObligations: value.monthlyDebtObligations ?? 0,
      monthlyIncome: value.monthlyIncome ?? 0,
      retirementTargetAge: value.retirementTargetAge ?? 0,
      retirementTargetAmount: value.retirementTargetAmount ?? 0,
      riskTolerance: value.riskTolerance ?? 'MEDIUM',
      timeHorizonYears: value.timeHorizonYears ?? 0,
      updatedAt: now,
      // Empty placeholder — the server scopes by JWT-derived user ID and
      // ignores any `userId` value supplied in the request body (Rule 5).
      userId: ''
    };
  }

  private deriveErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
      return error.message;
    }

    if (typeof error === 'string' && error.length > 0) {
      return error;
    }

    return 'The financial profile request failed. Please try again.';
  }
}
