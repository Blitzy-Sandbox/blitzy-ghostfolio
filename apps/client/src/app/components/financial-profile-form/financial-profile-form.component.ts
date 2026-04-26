import {
  FinancialProfile,
  FinancialProfilePatchPayload,
  InvestmentGoal,
  RiskTolerance
} from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Inject,
  OnInit,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { FinancialProfileService } from '../../services/financial-profile.service';
import { UserService } from '../../services/user/user.service';

/**
 * Material dialog form for editing the authenticated user's
 * {@link FinancialProfile} per AAP § 0.5.3.
 *
 * Loading workflow:
 *   1. On open the component invokes {@link FinancialProfileService.get}.
 *   2. If a record exists, the form is pre-populated.
 *   3. If the server returns 404 (translated to `null` by the service),
 *      the form is left empty for first-time setup.
 *   4. The Save action calls {@link FinancialProfileService.patch}.
 *
 * Authorization: per AAP Rule 5 (§ 0.7.1.5) the request body MUST NOT
 * influence the server's `userId` scoping — the server reads the user
 * identity from the JWT. The PATCH payload constructed below is typed
 * as {@link FinancialProfilePatchPayload}, which intentionally OMITS
 * the three server-controlled fields (`userId`, `createdAt`,
 * `updatedAt`). The server-side `FinancialProfileDto` is configured
 * with `forbidNonWhitelisted: true`, so any of those fields appearing
 * in the request body would be REJECTED with HTTP 400 — which is why
 * we do not send placeholder values for them. `userId` is sourced
 * authoritatively by the server from the JWT; `createdAt` is set by
 * the Prisma `@default(now())` directive on first upsert; `updatedAt`
 * is maintained by the Prisma `@updatedAt` directive.
 *
 * Save error handling: the `.subscribe()` call provides BOTH `next:`
 * and `error:` handlers. On a successful PATCH the dialog closes with
 * a `true` result so the host page can refresh. On a failed PATCH a
 * non-empty `saveError` signal is set, the template renders a visible
 * alert region, and the dialog stays open so the user can correct
 * their input and retry. Without an `error:` handler RxJS routes HTTP
 * failures to the global error handler (which only logs to the
 * console), leading to a silent failure with no user-visible feedback.
 *
 * Custom validator: `retirementAgeAboveCurrentAgeValidator` is a closure
 * over `this`, so the form's `retirementTargetAge` control re-runs its
 * check whenever `currentUserAgeYears` is updated. We trigger
 * `updateValueAndValidity({ emitEvent: false })` after the user state
 * arrives to apply the new floor without firing a value-change event.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ReactiveFormsModule
  ],
  selector: 'gf-financial-profile-form',
  styleUrls: ['./financial-profile-form.component.scss'],
  templateUrl: './financial-profile-form.component.html'
})
export class GfFinancialProfileFormComponent implements OnInit {
  public form: FormGroup;
  /**
   * Reactive signal-bound flag that indicates whether a PATCH request
   * is currently in flight. The template binds the Save button's
   * `[disabled]` attribute to `(form.invalid || isSubmitting())` so the
   * user cannot trigger overlapping save attempts while the previous
   * request is still pending. Reset to `false` in BOTH the `next:` and
   * `error:` callbacks of the PATCH subscription so the user can retry
   * after a transient failure.
   */
  public isSubmitting = signal<boolean>(false);
  public riskToleranceOptions: readonly RiskTolerance[] = [
    'LOW',
    'MEDIUM',
    'HIGH'
  ];
  /**
   * Reactive signal-bound error message rendered in the template's
   * dedicated alert region (`role="alert"`) whenever the latest PATCH
   * attempt has failed. Empty string -> no error displayed; non-empty
   * string -> alert region is shown to the user. The signal is reset
   * to `''` at the START of every {@link onSubmit} attempt so a stale
   * error message from a prior failure does not persist after the
   * user has corrected their input and clicked Save again. Per AAP
   * § 0.5.3 (UX requirements) the dialog MUST surface save failures
   * to the user — a silent failure with no UI state change is
   * prohibited.
   */
  public saveError = signal<string>('');

  private currentUserAgeYears: number | null = null;

  public constructor(
    @Inject(MAT_DIALOG_DATA) public data: any,
    public dialogRef: MatDialogRef<GfFinancialProfileFormComponent>,
    private destroyRef: DestroyRef,
    private financialProfileService: FinancialProfileService,
    private formBuilder: FormBuilder,
    private userService: UserService
  ) {
    this.form = this.formBuilder.group({
      retirementTargetAge: [
        null as number | null,
        [
          Validators.required,
          Validators.min(18),
          Validators.max(100),
          this.retirementAgeAboveCurrentAgeValidator()
        ]
      ],
      retirementTargetAmount: [
        null as number | null,
        [Validators.required, Validators.min(0)]
      ],
      timeHorizonYears: [
        null as number | null,
        [Validators.required, Validators.min(1)]
      ],
      riskTolerance: [null as RiskTolerance | null, [Validators.required]],
      monthlyIncome: [
        null as number | null,
        [Validators.required, Validators.min(0)]
      ],
      monthlyDebtObligations: [
        null as number | null,
        [Validators.required, Validators.min(0)]
      ],
      investmentGoals: this.formBuilder.array([])
    });
  }

  /**
   * Typed accessor for the dynamic `investmentGoals` `FormArray`. Used by
   * the template's `@for` loop and by the spec to assert array length /
   * goal entries after `populateForm()`.
   */
  public get investmentGoalsArray(): FormArray {
    return this.form.get('investmentGoals') as FormArray;
  }

  public ngOnInit(): void {
    // Subscribe to user state to read dateOfBirth for the age validator.
    // `userService.stateChanged` is a BehaviorSubject and delivers the
    // current value synchronously upon subscription, so
    // `currentUserAgeYears` is set BEFORE the financial-profile load.
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        // `UserSettings` does not currently expose a `dateOfBirth` field,
        // so we type-cast to `{ dateOfBirth?: ... }` rather than `any`
        // for slightly tighter typing while still bypassing the missing
        // declaration. The cast is safe because at runtime the field
        // either exists (set by a future server-side schema extension)
        // or is `undefined`.
        const settings = state?.user?.settings as
          | { dateOfBirth?: string | Date | null }
          | undefined;
        const dateOfBirth = settings?.dateOfBirth ?? null;

        this.currentUserAgeYears = this.computeAgeYears(dateOfBirth);

        // Re-run the validator now that the reference age is known.
        // `emitEvent: false` keeps this off the value-change stream so
        // it does not retrigger downstream observers and risk an
        // infinite-loop subscription chain.
        this.form.get('retirementTargetAge')?.updateValueAndValidity({
          emitEvent: false
        });
      });

    // Load the existing profile (if any). The service translates HTTP
    // 404 to `null` so the form-empty-on-first-open semantics are a
    // simple null-check at this layer.
    this.financialProfileService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (profile) => {
          if (profile) {
            this.populateForm(profile);
          }
        }
      });
  }

  /**
   * Appends a goal `FormGroup` to {@link investmentGoalsArray}. When
   * called from the template's "Add Goal" button no argument is passed,
   * producing an empty row. When invoked from {@link populateForm} a
   * server-supplied {@link InvestmentGoal} hydrates the controls.
   */
  public addInvestmentGoal(goal?: InvestmentGoal): void {
    this.investmentGoalsArray.push(
      this.formBuilder.group({
        label: [goal?.label ?? '', [Validators.required]],
        targetAmount: [
          goal?.targetAmount ?? null,
          [Validators.required, Validators.min(0)]
        ],
        targetDate: [goal?.targetDate ?? null, [Validators.required]]
      })
    );
  }

  /**
   * Removes the goal at the supplied index. The bound template handler
   * passes `$index` from the `@for` loop.
   */
  public removeInvestmentGoal(index: number): void {
    this.investmentGoalsArray.removeAt(index);
  }

  public onCancel(): void {
    this.dialogRef.close();
  }

  /**
   * Submits the form. Aborts early if invalid (the disabled submit
   * button prevents this in normal UX, but a programmatic Enter key in
   * an input field can still attempt submission). On success the dialog
   * resolves with `true` so the host page can refresh its state. On
   * failure the `saveError` signal is set to a user-readable message,
   * the dialog stays open, and `isSubmitting` is reset so the user can
   * correct their input and retry.
   *
   * Payload typing: the constructed `payload` is typed as
   * {@link FinancialProfilePatchPayload}, which intentionally OMITS
   * the three server-controlled fields (`userId`, `createdAt`,
   * `updatedAt`). The server-side `FinancialProfileDto` is configured
   * with `forbidNonWhitelisted: true`, which causes those fields to
   * trigger an HTTP 400 rejection if they appear in the request body
   * — even with placeholder values. The tightened type at the
   * service boundary (`FinancialProfileService.patch(p:
   * FinancialProfilePatchPayload)`) makes accidental inclusion of
   * those fields a compile-time error, providing defense-in-depth
   * against the silent regression that would otherwise occur if the
   * full `FinancialProfile` shape were used here.
   */
  public onSubmit(): void {
    if (this.form.invalid || this.isSubmitting()) {
      return;
    }

    // Reset any error message from a prior failed save attempt so the
    // template's alert region is hidden during the new attempt. The
    // alert will be re-rendered if the new attempt also fails.
    this.saveError.set('');
    this.isSubmitting.set(true);

    const raw = this.form.value as {
      retirementTargetAge: number;
      retirementTargetAmount: number;
      timeHorizonYears: number;
      riskTolerance: RiskTolerance;
      monthlyIncome: number;
      monthlyDebtObligations: number;
      investmentGoals: {
        label: string;
        targetAmount: number;
        targetDate: string | Date | null;
      }[];
    };

    // Construct the PATCH payload as a `FinancialProfilePatchPayload`
    // — i.e., the `Omit<FinancialProfile, 'userId' | 'createdAt' |
    // 'updatedAt'>` type defined in `financial-profile.interface.ts`.
    // The three omitted fields are server-controlled:
    //   * `userId` is sourced authoritatively from the JWT.
    //   * `createdAt` is set by Prisma `@default(now())`.
    //   * `updatedAt` is set by Prisma `@updatedAt`.
    // Sending placeholder values for any of these would trip the
    // `forbidNonWhitelisted: true` server-side ValidationPipe and
    // trigger HTTP 400 with messages like "property userId should not
    // exist". Coercing numeric fields via `Number(...)` defends
    // against HTML number inputs that may return string values.
    const payload: FinancialProfilePatchPayload = {
      retirementTargetAge: Number(raw.retirementTargetAge),
      retirementTargetAmount: Number(raw.retirementTargetAmount),
      timeHorizonYears: Number(raw.timeHorizonYears),
      riskTolerance: raw.riskTolerance,
      monthlyIncome: Number(raw.monthlyIncome),
      monthlyDebtObligations: Number(raw.monthlyDebtObligations),
      investmentGoals: (raw.investmentGoals ?? []).map((g) => ({
        label: g.label,
        targetAmount: Number(g.targetAmount),
        targetDate: this.normalizeDateToString(g.targetDate)
      }))
    };

    this.financialProfileService
      .patch(payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error) => {
          // Surface the failure to the user via the signal-bound alert
          // region in the template. The dialog stays open so the user
          // can correct their input and retry; `isSubmitting` is reset
          // so the Save button becomes clickable again.
          this.isSubmitting.set(false);
          this.saveError.set(this.buildSaveErrorMessage(error));
        },
        next: () => {
          this.isSubmitting.set(false);
          this.dialogRef.close(true);
        }
      });
  }

  /**
   * Translates an HTTP error from the PATCH call into a user-readable
   * string for the alert region. The branching mirrors the actual
   * response shapes returned by the NestJS backend:
   *
   *   * 400 Bad Request — the global `ValidationPipe`
   *     (`whitelist: true`, `forbidNonWhitelisted: true`) returns
   *     `{ message: string[] | string, error, statusCode }`. We
   *     surface the joined `message` so validation feedback (e.g.,
   *     "retirementTargetAge must not be less than 18") is shown
   *     verbatim to the user.
   *   * Other status codes — surface a generic localized fallback so
   *     the user knows the save failed without exposing implementation
   *     details (network errors, 500s, etc.).
   *
   * The function NEVER returns an empty string — Rule-6-equivalent
   * UX ensures the alert region is always rendered when an error has
   * occurred. A defensive non-empty fallback handles edge cases (e.g.,
   * a non-`HttpErrorResponse` thrown from a synchronous transformer).
   */
  private buildSaveErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as
        | { message?: string | string[] }
        | undefined
        | null;

      if (body?.message) {
        if (Array.isArray(body.message) && body.message.length > 0) {
          return body.message.join(', ');
        }

        if (typeof body.message === 'string' && body.message.length > 0) {
          return body.message;
        }
      }

      if (typeof error.message === 'string' && error.message.length > 0) {
        return error.message;
      }
    }

    return $localize`Unable to save your financial profile. Please try again.`;
  }

  /**
   * Hydrates the form from a persisted {@link FinancialProfile}. The
   * existing FormArray is fully cleared before the new goals are pushed
   * so stale rows from a previous open do not leak into the next render.
   */
  private populateForm(profile: FinancialProfile): void {
    this.form.patchValue({
      retirementTargetAge: profile.retirementTargetAge,
      retirementTargetAmount: profile.retirementTargetAmount,
      timeHorizonYears: profile.timeHorizonYears,
      riskTolerance: profile.riskTolerance,
      monthlyIncome: profile.monthlyIncome,
      monthlyDebtObligations: profile.monthlyDebtObligations
    });

    while (this.investmentGoalsArray.length > 0) {
      this.investmentGoalsArray.removeAt(0);
    }

    for (const goal of profile.investmentGoals ?? []) {
      this.addInvestmentGoal(goal);
    }
  }

  /**
   * Constructs the closure-based validator for `retirementTargetAge`.
   * The returned function captures `this` so it always reads the most
   * recent value of {@link currentUserAgeYears}; we trigger
   * `updateValueAndValidity({ emitEvent: false })` after the age field
   * is updated to apply the new floor without firing a value-change
   * event.
   *
   * Validation branches:
   *   - input value missing -> `Validators.required` already reports
   *     the missing-value error; this validator is a no-op.
   *   - `currentUserAgeYears` unknown -> defer to `Validators.min(18)`
   *     which is already attached to the control.
   *   - value <= currentUserAgeYears -> emit
   *     `retirementAgeBelowCurrentAge` with `current` and `target` for
   *     the template to render a precise error message.
   */
  private retirementAgeAboveCurrentAgeValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;

      if (value == null || value === '') {
        return null;
      }

      if (this.currentUserAgeYears == null) {
        // No reference age available; let the built-in min/max validators
        // handle bounds checking.
        return null;
      }

      if (Number(value) <= this.currentUserAgeYears) {
        return {
          retirementAgeBelowCurrentAge: {
            current: this.currentUserAgeYears,
            target: Number(value)
          }
        };
      }

      return null;
    };
  }

  /**
   * Computes the user's whole-year age from a `dateOfBirth` value. The
   * 365.25 millisecond-per-year constant accounts for leap years; the
   * `Math.floor` truncation matches the conventional way a user-facing
   * "age" is displayed (i.e., the number of full years since birth).
   * Returns `null` for missing or malformed inputs.
   */
  private computeAgeYears(
    dateOfBirth: string | Date | null | undefined
  ): number | null {
    if (!dateOfBirth) {
      return null;
    }

    const dob = new Date(dateOfBirth);

    if (isNaN(dob.getTime())) {
      return null;
    }

    const now = new Date();
    const millisecondsPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const ageYears = (now.getTime() - dob.getTime()) / millisecondsPerYear;

    return Math.floor(ageYears);
  }

  /**
   * Normalizes a date control value to an ISO-8601 string for transport.
   * `MatDatepicker` writes a `Date` object into the FormControl when
   * the user picks a date; persisted values from the API arrive as
   * strings. Both forms are coerced into a single string shape so the
   * server-side `InvestmentGoalDto.targetDate: string` contract is
   * satisfied.
   */
  private normalizeDateToString(value: string | Date | null): string {
    if (value == null) {
      return '';
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return String(value);
  }
}
