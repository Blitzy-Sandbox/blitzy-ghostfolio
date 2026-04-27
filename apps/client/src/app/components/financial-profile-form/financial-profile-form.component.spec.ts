import {
  FinancialProfile,
  FinancialProfilePatchPayload
} from '@ghostfolio/common/interfaces';

import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `financial-profile-form.component.html`
// template uses `i18n` attributes which the Angular compiler lowers
// to `$localize` tagged template calls in the component's compiled
// `consts` block. Without this side-effect import, instantiating the
// component via TestBed throws `ReferenceError: $localize is not
// defined`.
import '@angular/localize/init';
import { provideNativeDateAdapter } from '@angular/material/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';

import { FinancialProfileService } from '../../services/financial-profile.service';
import { UserService } from '../../services/user/user.service';
import { GfFinancialProfileFormComponent } from './financial-profile-form.component';

// Mock the UserService module BEFORE any imports. This short-circuits
// the transitive ESM import chain
//   UserService
//     -> GfSubscriptionInterstitialDialogComponent
//       -> @ghostfolio/ui/membership-card (GfMembershipCardComponent)
//         -> @ionic/angular/standalone
//           -> @ionic/core (publishes plain ESM `.js` files)
// which Jest cannot parse under the project's existing
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (transformIgnorePatterns lives in `apps/client/jest.config.ts`,
// which is out of scope for this strictly-additive PR per AAP § 0.6).
//
// The replacement exports a bare `UserService` class symbol that
// serves only as a DI token — the actual runtime behavior (the
// `stateChanged` BehaviorSubject) is supplied through `useValue:
// mockUserService` in TestBed.providers below. `jest.mock()` calls
// are hoisted by jest-preset-angular's TS transformer above all
// import statements, so this mock applies to both the spec's own
// import of `UserService` AND the transitive component's import,
// keeping their DI-token identity in sync.
jest.mock('../../services/user/user.service', () => ({
  UserService: class UserServiceMock {}
}));

/**
 * Test-double for {@link FinancialProfileService} that exposes per-test
 * configurable `getReturnValue` / `patchReturnValue` Observables. Each
 * AAP-required test case re-assigns these BEFORE `fixture.detectChanges()`
 * to drive component behavior:
 *   - test (a) leaves `getReturnValue = of(null)` (the default), modeling
 *     an HTTP 404 already translated to `null` by the service's
 *     internal `catchError`.
 *   - test (b) re-assigns `getReturnValue = of(SAMPLE_PROFILE)` to
 *     model an HTTP 200.
 *   - test (d) re-assigns both `getReturnValue` and `patchReturnValue`
 *     to drive the full happy-path PATCH flow.
 *   - tests (e) / (f) assert the error path — `patchReturnValue` is
 *     replaced with a `throwError(...)` and the test verifies that the
 *     dialog stays open AND the component's `saveError` signal is
 *     populated with a non-empty user-readable message.
 *
 * The Jest spies (`getSpy`, `patchSpy`) allow individual tests to
 * assert call counts and call arguments after the component-under-test
 * has interacted with the mock.
 *
 * Type-correctness of the `patch(...)` mock signature: the parameter
 * type is `FinancialProfilePatchPayload` — IDENTICAL to the production
 * `FinancialProfileService.patch(...)` signature. Using
 * `FinancialProfilePatchPayload` here (instead of the wider
 * `FinancialProfile`) ensures that if the component were ever to
 * regress to constructing a payload of the full `FinancialProfile`
 * shape (which would include the server-rejected `userId`,
 * `createdAt`, `updatedAt` fields), the TypeScript compiler would
 * reject the call at unit-test time — preventing a recurrence of the
 * "spec passes / runtime fails with HTTP 400" scenario captured in QA
 * Issue #1.
 */
class MockFinancialProfileService {
  public getReturnValue: Observable<FinancialProfile | null> = of(null);
  public patchReturnValue: Observable<FinancialProfile> = of(
    {} as FinancialProfile
  );
  public getSpy = jest.fn(() => this.getReturnValue);
  // The spy receives the argument from `patch(p)` below via Jest's
  // built-in argument capture; we deliberately omit a declared
  // parameter to avoid `@typescript-eslint/no-unused-vars` while
  // still allowing call-argument introspection through
  // `patchSpy.mock.calls[i][0]` if a future test wants to assert
  // payload shape.
  public patchSpy = jest.fn(() => this.patchReturnValue);

  public get(): Observable<FinancialProfile | null> {
    return this.getSpy();
  }

  public patch(p: FinancialProfilePatchPayload): Observable<FinancialProfile> {
    return this.patchSpy(p);
  }
}

/**
 * Test-double for {@link UserService}. The production class extends
 * `ObservableStore<UserStoreState>` which contributes a `stateChanged`
 * Observable; this mock re-creates that surface as a plain
 * {@link BehaviorSubject} so tests can deterministically push state
 * BEFORE `fixture.detectChanges()`. A `BehaviorSubject` delivers its
 * current value synchronously to new subscribers, which is the
 * mechanism that makes test (c) deterministic without `fakeAsync`.
 *
 * The subject is typed `<any>` because the production `UserSettings`
 * interface does NOT declare a `dateOfBirth` field — the validator the
 * spec exercises reads the field at runtime via a defensive cast in
 * the component, so the mock intentionally side-steps strict typing.
 */
class MockUserService {
  public stateChanged = new BehaviorSubject<any>({ user: null });
}

/**
 * Test-double for the injected {@link MatDialogRef}. Captures
 * {@link close} invocations so test (d) can verify the AAP § 0.7.5.2
 * gate "successful PATCH closes the dialog" — specifically that
 * `dialogRef.close(true)` is called (note the `true` payload, which
 * signals the parent that the form was saved successfully).
 */
class MockMatDialogRef {
  public close = jest.fn();
}

/**
 * Produces an ISO-8601 date string for a date `years` years before
 * the current test runtime. Used by test (c) so the validator
 * assertion is independent of the year the test is executed in.
 */
const buildIsoDateYearsAgo = (years: number): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
};

/**
 * Complete `FinancialProfile` literal that exercises every top-level
 * field plus one nested {@link InvestmentGoal} entry. The values are
 * chosen so that the form is valid for test (d): `retirementTargetAge`
 * 65 satisfies `Validators.min(18)` / `Validators.max(100)`, all
 * monetary fields are non-negative, `timeHorizonYears` >= 1, and
 * `riskTolerance` is one of the allowed string-union members.
 */
const SAMPLE_PROFILE: FinancialProfile = {
  userId: 'u1',
  retirementTargetAge: 65,
  retirementTargetAmount: 1_000_000,
  timeHorizonYears: 25,
  riskTolerance: 'MEDIUM',
  monthlyIncome: 5_000,
  monthlyDebtObligations: 1_000,
  investmentGoals: [
    {
      label: 'House Down Payment',
      targetAmount: 100_000,
      targetDate: '2030-01-01'
    }
  ],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z'
};

describe('GfFinancialProfileFormComponent', () => {
  let component: GfFinancialProfileFormComponent;
  let fixture: ComponentFixture<GfFinancialProfileFormComponent>;
  let mockFinancialProfileService: MockFinancialProfileService;
  let mockUserService: MockUserService;
  let mockMatDialogRef: MockMatDialogRef;

  beforeEach(async () => {
    mockFinancialProfileService = new MockFinancialProfileService();
    mockUserService = new MockUserService();
    mockMatDialogRef = new MockMatDialogRef();

    await TestBed.configureTestingModule({
      imports: [
        GfFinancialProfileFormComponent,
        NoopAnimationsModule,
        ReactiveFormsModule
      ],
      providers: [
        // `MatDatepickerModule` (imported by the component under test)
        // requires a registered `DateAdapter`. The native-date adapter
        // is the lightest option and avoids pulling in moment / luxon.
        provideNativeDateAdapter(),
        {
          provide: FinancialProfileService,
          useValue: mockFinancialProfileService
        },
        { provide: UserService, useValue: mockUserService },
        { provide: MatDialogRef, useValue: mockMatDialogRef },
        { provide: MAT_DIALOG_DATA, useValue: {} }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfFinancialProfileFormComponent);
    component = fixture.componentInstance;
  });

  it('(a) HTTP 404 (returned as null) leaves the form empty', () => {
    // Default `getReturnValue = of(null)` simulates the
    // FinancialProfileService.get() 404-to-null translation.
    mockFinancialProfileService.getReturnValue = of(null);

    fixture.detectChanges(); // triggers ngOnInit

    // None of the form controls should be pre-populated when no
    // profile record exists for the authenticated user.
    expect(component.form.get('retirementTargetAge')?.value).toBeNull();
    expect(component.form.get('retirementTargetAmount')?.value).toBeNull();
    expect(component.form.get('timeHorizonYears')?.value).toBeNull();
    expect(component.form.get('riskTolerance')?.value).toBeNull();
    expect(component.form.get('monthlyIncome')?.value).toBeNull();
    expect(component.form.get('monthlyDebtObligations')?.value).toBeNull();
    expect(component.investmentGoalsArray.length).toBe(0);
  });

  it('(b) HTTP 200 pre-populates the form with the persisted FinancialProfile', () => {
    mockFinancialProfileService.getReturnValue = of(SAMPLE_PROFILE);

    fixture.detectChanges(); // triggers ngOnInit

    // Every top-level scalar field on the FormGroup should reflect the
    // SAMPLE_PROFILE values verbatim after `populateForm()`.
    expect(component.form.get('retirementTargetAge')?.value).toBe(65);
    expect(component.form.get('retirementTargetAmount')?.value).toBe(1_000_000);
    expect(component.form.get('timeHorizonYears')?.value).toBe(25);
    expect(component.form.get('riskTolerance')?.value).toBe('MEDIUM');
    expect(component.form.get('monthlyIncome')?.value).toBe(5_000);
    expect(component.form.get('monthlyDebtObligations')?.value).toBe(1_000);

    // The dynamic `investmentGoals` FormArray should contain exactly
    // one row mirroring the sole entry in SAMPLE_PROFILE.investmentGoals.
    expect(component.investmentGoalsArray.length).toBe(1);
    expect(component.investmentGoalsArray.at(0).get('label')?.value).toBe(
      'House Down Payment'
    );
    expect(
      component.investmentGoalsArray.at(0).get('targetAmount')?.value
    ).toBe(100_000);
    expect(component.investmentGoalsArray.at(0).get('targetDate')?.value).toBe(
      '2030-01-01'
    );
  });

  it('(c) Validator rejects retirementTargetAge less than current age', () => {
    // Push a user with a known dateOfBirth (40 years ago) BEFORE
    // ngOnInit subscribes. Because `stateChanged` is a BehaviorSubject,
    // it will deliver this latest value synchronously on subscribe.
    mockUserService.stateChanged.next({
      user: { settings: { dateOfBirth: buildIsoDateYearsAgo(40) } }
    });

    fixture.detectChanges(); // triggers ngOnInit

    // Set retirementTargetAge below the user's current age (40). The
    // custom validator should emit the `retirementAgeBelowCurrentAge`
    // error and the overall form should be invalid.
    component.form.get('retirementTargetAge')?.setValue(35);

    expect(
      component.form
        .get('retirementTargetAge')
        ?.hasError('retirementAgeBelowCurrentAge')
    ).toBe(true);
    expect(component.form.invalid).toBe(true);

    // Bumping the age above the current age clears the custom error
    // (other validators may still report errors on unrelated fields,
    // but the specific custom code must no longer be set).
    component.form.get('retirementTargetAge')?.setValue(65);

    expect(
      component.form
        .get('retirementTargetAge')
        ?.hasError('retirementAgeBelowCurrentAge')
    ).toBe(false);
  });

  it('(d) Successful PATCH closes the dialog', () => {
    mockFinancialProfileService.getReturnValue = of(SAMPLE_PROFILE);
    mockFinancialProfileService.patchReturnValue = of(SAMPLE_PROFILE);

    fixture.detectChanges();

    // Pre-populated SAMPLE_PROFILE must yield a valid form. The mock
    // user state is `{ user: null }` (no dateOfBirth), so the custom
    // validator is a no-op and only the built-in
    // `Validators.required / min / max` rules apply.
    expect(component.form.valid).toBe(true);

    component.onSubmit();

    // The component MUST call patch(...) and, on the synchronous
    // `of(SAMPLE_PROFILE)` resolution, call `dialogRef.close(true)`
    // — the `true` is the AAP-mandated success signal to the parent.
    expect(mockFinancialProfileService.patchSpy).toHaveBeenCalled();
    expect(mockMatDialogRef.close).toHaveBeenCalledWith(true);
  });

  it('(e) PATCH payload omits server-controlled fields (userId, createdAt, updatedAt)', () => {
    // Per QA Issue #1: the prior implementation typed the payload as
    // the full `FinancialProfile` and included placeholder values for
    // `userId`, `createdAt`, `updatedAt`. The server-side
    // ValidationPipe (`forbidNonWhitelisted: true`) rejected the
    // request with HTTP 400. This test verifies the fix: the
    // component constructs a `FinancialProfilePatchPayload` whose
    // shape matches `Omit<FinancialProfile, 'userId' | 'createdAt' |
    // 'updatedAt'>`.
    mockFinancialProfileService.getReturnValue = of(SAMPLE_PROFILE);
    mockFinancialProfileService.patchReturnValue = of(SAMPLE_PROFILE);

    fixture.detectChanges();

    component.onSubmit();

    // Payload arg captured from the spy must NOT include any of the
    // three server-controlled keys.
    const sentPayload = mockFinancialProfileService.patchSpy.mock.calls[0][0];
    expect(sentPayload).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(sentPayload, 'userId')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(sentPayload, 'createdAt')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(sentPayload, 'updatedAt')).toBe(
      false
    );

    // And the in-scope user-controlled fields ARE present and carry
    // values from the populated form.
    expect(sentPayload.retirementTargetAge).toBe(65);
    expect(sentPayload.retirementTargetAmount).toBe(1_000_000);
    expect(sentPayload.timeHorizonYears).toBe(25);
    expect(sentPayload.riskTolerance).toBe('MEDIUM');
    expect(sentPayload.monthlyIncome).toBe(5_000);
    expect(sentPayload.monthlyDebtObligations).toBe(1_000);
    expect(Array.isArray(sentPayload.investmentGoals)).toBe(true);
  });

  it('(f) Failed PATCH sets saveError and keeps the dialog open', () => {
    // Per QA Issue #2: the prior `.subscribe({ next })` call had no
    // `error:` handler, so save failures were silent. This test
    // verifies the fix: on PATCH error the component sets a
    // non-empty `saveError` signal AND does NOT close the dialog.
    mockFinancialProfileService.getReturnValue = of(SAMPLE_PROFILE);

    // Construct a realistic NestJS-style 400 response body so the
    // component's error-message extraction path is exercised end-to-end.
    const httpError = new HttpErrorResponse({
      error: {
        error: 'Bad Request',
        message: [
          'property userId should not exist',
          'property createdAt should not exist'
        ],
        statusCode: 400
      },
      status: 400,
      statusText: 'Bad Request'
    });

    mockFinancialProfileService.patchReturnValue = throwError(() => httpError);

    fixture.detectChanges();

    expect(component.form.valid).toBe(true);

    component.onSubmit();

    // saveError signal MUST be populated with a non-empty string —
    // this is the data flowing into the `<div role="alert">` in the
    // template. The exact joined message proves the component
    // surfaced the server's validation feedback verbatim.
    expect(component.saveError().length).toBeGreaterThan(0);
    expect(component.saveError()).toContain('property userId should not exist');
    expect(component.saveError()).toContain(
      'property createdAt should not exist'
    );

    // dialogRef.close MUST NOT have been called — the dialog stays
    // open so the user can retry. This is the inverse assertion of
    // test (d) and is the central UX guarantee for save failures.
    expect(mockMatDialogRef.close).not.toHaveBeenCalled();

    // isSubmitting MUST be reset to false so the Save button becomes
    // enabled again and the user can retry.
    expect(component.isSubmitting()).toBe(false);
  });

  it('(g) Failed PATCH falls back to a localized message when the response has no body', () => {
    // Defensive coverage: not every backend failure produces a typed
    // `{message, error, statusCode}` body — network failures, gateway
    // timeouts, and 5xx errors may carry no body at all. The
    // component MUST still render a non-empty alert so the user knows
    // the save did not succeed.
    mockFinancialProfileService.getReturnValue = of(SAMPLE_PROFILE);

    const opaqueError = new HttpErrorResponse({
      error: null,
      status: 500,
      statusText: 'Internal Server Error'
    });

    mockFinancialProfileService.patchReturnValue = throwError(
      () => opaqueError
    );

    fixture.detectChanges();

    component.onSubmit();

    expect(component.saveError().length).toBeGreaterThan(0);
    expect(mockMatDialogRef.close).not.toHaveBeenCalled();
  });
});
