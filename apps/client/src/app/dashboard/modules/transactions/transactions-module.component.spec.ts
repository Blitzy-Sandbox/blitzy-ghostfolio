import { Activity, User } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `transactions-module.component.ts` declares
// a `$localize`-tagged template literal at module scope (the
// `TRANSACTIONS_TITLE` constant referenced by the
// `TRANSACTIONS_MODULE_DESCRIPTOR.displayLabel`). Without this
// side-effect import, simply importing the SUT class throws
// `ReferenceError: $localize is not defined` before any test even
// runs. Mirrors the canonical pattern from
// `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { MatTableDataSource } from '@angular/material/table';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { of } from 'rxjs';

import { UserService } from '../../../services/user/user.service';
import {
  GfTransactionsModuleComponent,
  TRANSACTIONS_MODULE_DESCRIPTOR
} from './transactions-module.component';

// Mock the UserService module BEFORE any imports are evaluated. This
// short-circuits the transitive ESM import chain
//   UserService
//     -> GfSubscriptionInterstitialDialogComponent
//       -> @ghostfolio/ui/membership-card (GfMembershipCardComponent)
//         -> @ionic/angular/standalone
//           -> @ionic/core (publishes plain ESM `.js` files)
// which Jest cannot parse under the project's existing
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (transformIgnorePatterns lives in `apps/client/jest.config.ts`,
// which is out of scope for this strictly-additive PR per AAP § 0.7.3).
//
// The replacement exports a bare `UserService` class symbol that serves
// only as a DI token — the actual runtime behavior (the `stateChanged`
// Observable) is supplied through `useValue: mockUserService` in
// `TestBed.providers` below. `jest.mock()` calls are hoisted by
// jest-preset-angular's TS transformer above all import statements, so
// this mock applies to both the spec's own import of `UserService` AND
// the transitive SUT import (the SUT imports
// `@ghostfolio/client/services/user/user.service`, which resolves to
// the same on-disk file as this relative path via the
// `tsconfig.base.json` path alias `@ghostfolio/client/* ->
// apps/client/src/app/*`). Jest tracks mocks by the resolved module
// path, so a single `jest.mock(...)` registration intercepts both
// imports and keeps their DI-token identity in sync.
//
// Mirrors the canonical pattern at
// `apps/client/src/app/components/financial-profile-form/financial-profile-form.component.spec.ts:46-48`.
jest.mock('../../../services/user/user.service', () => ({
  UserService: class UserServiceMock {}
}));

// Mock the @ghostfolio/ui/activities-table module BEFORE the SUT is
// imported. The SUT (`transactions-module.component.ts`) declares
// `import { GfActivitiesTableComponent } from
// '@ghostfolio/ui/activities-table';` at module scope, and the real
// `activities-table` barrel pulls in `@ionic/angular/standalone` which
// then evaluates the un-transformable
// `@ionic/core/components/index.js` ESM file (same Jest parse-error
// path as the UserService chain documented above).
//
// The replacement exports a stand-in `GfActivitiesTableComponent`
// class that carries the same name as the real symbol. The class itself
// is never instantiated by the test bed because the SUT's
// `imports: [...]` array is overridden via
// `TestBed.overrideComponent(...)` below (the override replaces the
// real `GfActivitiesTableComponent` reference with the inline
// `MockActivitiesTableComponent` declared in this spec, which carries
// the matching `gf-activities-table` selector so the SUT's template
// binding still resolves at compile time).
//
// Without this mock, simply importing the SUT class throws
// `SyntaxError: Unexpected token 'export'` when Jest parses
// `@ionic/core/components/index.js` before any test even runs.
jest.mock('@ghostfolio/ui/activities-table', () => ({
  GfActivitiesTableComponent: class GfActivitiesTableComponentMock {}
}));

/**
 * Inline test stub for {@link GfActivitiesTableComponent}. The real
 * component (from `@ghostfolio/ui/activities-table`) drags in a deep
 * dependency graph (MatTable, MatSort, MatPaginator, NotificationService,
 * GfEntityLogoComponent, GfActivityTypeComponent,
 * GfNoTransactionsInfoComponent, GfValueComponent,
 * NgxSkeletonLoaderModule, ionicons, and more) which is brittle and slow
 * inside a unit-test sandbox. The stub:
 *
 * 1. Carries the real component's `gf-activities-table` selector so the
 *    SUT's template binding resolves to this stub when the SUT's
 *    standalone `imports` array is overridden via
 *    `TestBed.overrideComponent(...)` below.
 * 2. Declares every input the SUT binds to so Angular's template
 *    compiler accepts the bindings without throwing
 *    `Can't bind to '...' since it isn't a known property of
 *    'gf-activities-table'`. The SUT binds (per
 *    `transactions-module.component.html`):
 *      - `[dataSource]="activities()"`
 *      - `[hasPermissionToCreateActivity]="false"`
 *      - `[hasPermissionToDeleteActivity]="false"`
 *      - `[hasPermissionToExportActivities]="false"`
 *      - `[hasPermissionToFilterByType]="false"`
 *      - `[hasPermissionToOpenDetails]="false"`
 *      - `[showActions]="false"`
 *
 * The stub mirrors the real component's traditional `@Input()` decorator
 * pattern (verified in `libs/ui/src/lib/activities-table/activities-table.component.ts`
 * lines 106-121) rather than signal-based `input()` because tests do
 * not need to drive these inputs reactively — the bindings only need to
 * resolve at template-compile time. The `dataSource` field is typed as
 * `MatTableDataSource<Activity> | undefined` to match the real
 * component's `input.required<MatTableDataSource<Activity> | undefined>()`
 * declaration so TypeScript's strict mode does not reject the binding.
 */
@Component({
  selector: 'gf-activities-table',
  standalone: true,
  template: ''
})
class MockActivitiesTableComponent {
  @Input() public dataSource: MatTableDataSource<Activity> | undefined;
  @Input() public hasPermissionToCreateActivity = false;
  @Input() public hasPermissionToDeleteActivity = false;
  @Input() public hasPermissionToExportActivities = false;
  @Input() public hasPermissionToFilterByType = false;
  @Input() public hasPermissionToOpenDetails = false;
  @Input() public showActions = false;
}

/**
 * Builds a minimal {@link User} fixture for the `UserService` mock.
 *
 * The full `User` interface (defined in
 * `libs/common/src/lib/interfaces/user.interface.ts`) requires many
 * fields (`access`, `accounts`, `dateOfFirstActivity`, `id`,
 * `permissions`, `subscription`, `tags`) that this spec does not
 * exercise. The narrow shape returned here covers the only fields the
 * SUT could conceivably touch (`activitiesCount`, `settings`) — the SUT
 * itself does NOT consume the user signal in the v1 template (per AAP
 * § 0.7.3 OUT-OF-SCOPE: locale, base currency), so this fixture is
 * intentionally minimal.
 *
 * The `as unknown as User` double-cast is the canonical TypeScript
 * strict-mode pattern for narrow test fixtures — a single `as User`
 * cast would be rejected because the structural type does not satisfy
 * the full interface.
 */
function createMockUser(): User {
  return {
    activitiesCount: 0,
    settings: {
      baseCurrency: 'USD',
      locale: 'en-US'
    }
  } as unknown as User;
}

/**
 * Builds a fresh, isolated mock {@link DataService} for each test. The
 * default behaviour is to synchronously emit an empty
 * `ActivitiesResponse` (`{ activities: [], count: 0 }`). The synchronous
 * emission ensures the SUT's `subscribe(...)` callback fires inside the
 * same `detectChanges()` call that triggered `ngOnInit`, so no
 * `fakeAsync` / `tick` is required.
 *
 * Each test gets its own mock instance (via the `beforeEach` invocation)
 * so call counts and `mockReturnValue` overrides do not leak between
 * tests.
 */
function createMockDataService() {
  return {
    fetchActivities: jest
      .fn()
      .mockReturnValue(of({ activities: [] as Activity[], count: 0 }))
  };
}

/**
 * Builds a minimal mock {@link UserService}. The real service extends
 * `ObservableStore<UserStoreState>` with a much richer surface
 * (`getState`, `setState`, lifecycle hooks, the `stateChanged`
 * Observable, plus many imperative methods). The SUT consumes only
 * `userService.stateChanged` via `.pipe(takeUntilDestroyed(...)).subscribe(...)`,
 * so this minimal mock returns an Observable that synchronously emits
 * `{ user }` once and completes.
 *
 * Because `of(...)` produces a synchronous, completing Observable, the
 * SUT's `subscribe(...)` callback fires once during `detectChanges()`
 * and the subscription is automatically cleaned up by the surrounding
 * `takeUntilDestroyed(this.destroyRef)` operator without any additional
 * test plumbing.
 */
function createMockUserService(user: User | undefined) {
  return {
    stateChanged: of({ user })
  };
}

describe('GfTransactionsModuleComponent', () => {
  let component: GfTransactionsModuleComponent;
  let fixture: ComponentFixture<GfTransactionsModuleComponent>;
  let mockDataService: ReturnType<typeof createMockDataService>;
  let mockUserService: ReturnType<typeof createMockUserService>;

  beforeEach(async () => {
    mockDataService = createMockDataService();
    mockUserService = createMockUserService(createMockUser());

    await TestBed.configureTestingModule({
      imports: [GfTransactionsModuleComponent, NoopAnimationsModule],
      providers: [
        { provide: DataService, useValue: mockDataService },
        { provide: UserService, useValue: mockUserService }
      ]
    })
      .overrideComponent(GfTransactionsModuleComponent, {
        set: {
          imports: [MockActivitiesTableComponent]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfTransactionsModuleComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Phase 5.1 — Component is created.
  // Smoke test that confirms the SUT instantiates with the mocked
  // dependency injection chain (DataService, UserService) and the
  // overridden imports list (the MockActivitiesTableComponent stub).
  // A failure here is almost certainly a configuration issue (missing
  // provider, unresolved import, $localize not initialized) rather
  // than a behaviour bug.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // Phase 5.2 — `DataService.fetchActivities` is called from
  // `ngOnInit`. Confirms the SUT subscribes to the activities feed on
  // first render. The exact arguments are NOT asserted here (the SUT
  // calls `fetchActivities({})` with an empty options object as the
  // v1 read-only contract per AAP § 0.7.3 — a future change to add
  // pagination/sort would refactor this contract); only that the call
  // happens. Together with Phase 5.3 this proves the data-flow path
  // from service mock through the `activities` signal to the rendered
  // table.
  it('should call DataService.fetchActivities on init', () => {
    fixture.detectChanges();

    expect(mockDataService.fetchActivities).toHaveBeenCalled();
  });

  // Phase 5.3 — `<gf-activities-table>` element renders after data
  // loads. Verifies the `@if (activities()) { ... }` template guard
  // in `transactions-module.component.html`. Because the default
  // mock `fetchActivities` returns `of({ activities: [], count: 0 })`
  // synchronously, the SUT's subscribe callback fires inside the
  // `detectChanges()` call, sets the `activities` signal to a fresh
  // `MatTableDataSource<Activity>` instance, and the signal change
  // automatically marks the OnPush component dirty so the template
  // re-evaluates within the same change-detection cycle. The
  // `<gf-activities-table>` (resolved against the mock stub via the
  // overridden imports list) appears in the rendered DOM.
  it('should render the <gf-activities-table> element after activities data loads', () => {
    fixture.detectChanges();

    const activitiesTable = fixture.nativeElement.querySelector(
      'gf-activities-table'
    );

    expect(activitiesTable).toBeTruthy();
  });

  // Phase 5.4 — Before data loads, `<gf-activities-table>` does NOT
  // render. Verifies the `@if (activities()) { ... }` falsy-branch.
  // Drops the default fixture and rebuilds a fresh test bed where
  // `fetchActivities` returns an Observable that NEVER emits (`of()`
  // creates an Observable that completes immediately without emitting
  // any values), so the `activities` signal stays at its initial
  // `undefined` value and the `@if` block evaluates falsy.
  it('should NOT render <gf-activities-table> when activities signal is undefined', async () => {
    TestBed.resetTestingModule();

    const neverEmittingDataService = {
      fetchActivities: jest.fn().mockReturnValue(of())
    };
    const localUserService = createMockUserService(createMockUser());

    await TestBed.configureTestingModule({
      imports: [GfTransactionsModuleComponent, NoopAnimationsModule],
      providers: [
        { provide: DataService, useValue: neverEmittingDataService },
        { provide: UserService, useValue: localUserService }
      ]
    })
      .overrideComponent(GfTransactionsModuleComponent, {
        set: {
          imports: [MockActivitiesTableComponent]
        }
      })
      .compileComponents();

    const localFixture = TestBed.createComponent(GfTransactionsModuleComponent);
    localFixture.detectChanges();

    const activitiesTable = localFixture.nativeElement.querySelector(
      'gf-activities-table'
    );

    expect(activitiesTable).toBeNull();
  });

  // Phase 5.5 — Read-only flags propagate to the inner table.
  // Defensive guard for the AAP § 0.7.3 OUT-OF-SCOPE constraint that
  // the v1 wrapper renders the activities table strictly read-only:
  // no editing, deletion, export, filtering, or click-into-details.
  // The SUT's template hard-codes all six permission inputs to
  // `false`, plus `showActions = false`. This test queries the inner
  // mock instance via `fixture.debugElement.query(...)` and asserts
  // each input is the expected literal `false` — a regression here
  // would mean the contract drifted from the AAP boundary.
  it('should propagate read-only permission flags (all false) to the activities table', () => {
    fixture.detectChanges();

    const tableEl = fixture.debugElement.query(
      (n) => n.name === 'gf-activities-table'
    );
    expect(tableEl).toBeTruthy();

    const tableInstance =
      tableEl.componentInstance as MockActivitiesTableComponent;

    expect(tableInstance.showActions).toBe(false);
    expect(tableInstance.hasPermissionToCreateActivity).toBe(false);
    expect(tableInstance.hasPermissionToDeleteActivity).toBe(false);
    expect(tableInstance.hasPermissionToExportActivities).toBe(false);
    expect(tableInstance.hasPermissionToFilterByType).toBe(false);
    expect(tableInstance.hasPermissionToOpenDetails).toBe(false);
  });

  // Phase 5.6 — The SUT does NOT render its own `<gf-module-wrapper>`.
  // Pins the architectural fix from QA Checkpoint 6 Issue #1 — the
  // module wrapper component renders ONLY the bare presentation
  // content; chrome (header, drag handle, remove button, content
  // slot) is rendered by the canvas-level outer `<gf-module-wrapper>`.
  // A regression that re-introduced the inner wrapper would surface
  // as a duplicated header at runtime; this test traps that
  // regression at the unit-test layer.
  it('should NOT render an inner <gf-module-wrapper> chrome', () => {
    fixture.detectChanges();

    const wrappers =
      fixture.nativeElement.querySelectorAll('gf-module-wrapper');

    expect(wrappers.length).toBe(0);
  });

  // Phase 5.7 — Descriptor's `iconName` is `'list-outline'`. Defensive
  // descriptor check that complements the wrapped-element assertion.
  // The descriptor's `iconName` is what the canvas's
  // `resolveIconName(item.name)` helper reads to bind onto the outer
  // `<gf-module-wrapper [iconName]>`, so any drift between the
  // descriptor and the catalog/header rendering would cascade through
  // the canvas — pinning the descriptor value here keeps the source
  // of truth honest.
  it('should expose iconName "list-outline" on the registry descriptor', () => {
    expect(TRANSACTIONS_MODULE_DESCRIPTOR.iconName).toBe('list-outline');
  });

  // Phase 5.8 — Descriptor's `displayLabel` is the localized
  // `'Transactions'` string. Mirrors the iconName assertion at the
  // descriptor level: the canvas's `resolveTitle(item.name)` reads
  // the descriptor's `displayLabel` and projects it onto the outer
  // `<gf-module-wrapper [title]>`. Pinning the value here ensures
  // the module-scope `TRANSACTIONS_TITLE = $localize`Transactions``
  // constant is wired through to the descriptor without translation
  // drift.
  it('should expose displayLabel as the localized "Transactions" string on the registry descriptor', () => {
    expect(TRANSACTIONS_MODULE_DESCRIPTOR.displayLabel).toBe('Transactions');
  });

  // Phase 5.9 — Descriptor's `name` is `'transactions'`. The stable
  // identifier discriminator used by `LayoutItem.moduleId` in
  // persisted layout documents and by
  // `ModuleRegistryService.getByName(name)` lookups. A rename here
  // would break every saved layout that references the transactions
  // module — pinning the value at the test layer prevents accidental
  // breakage.
  it('should expose name "transactions" on the registry descriptor', () => {
    expect(TRANSACTIONS_MODULE_DESCRIPTOR.name).toBe('transactions');
  });
});
