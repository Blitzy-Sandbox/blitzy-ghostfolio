import { Activity, User } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at
// runtime. The companion `transactions-module.component.ts` declares
// `$localize`-tagged template literals at module scope (the
// `TRANSACTIONS_TITLE` constant shared by the SUT's `title` field and
// the `TRANSACTIONS_MODULE_DESCRIPTOR.displayLabel`), and the
// transitively imported `module-wrapper.component.ts` declares
// `DRAG_ARIA_LABEL`, `DRAG_TOOLTIP`, `REMOVE_ARIA_LABEL`, and
// `REMOVE_TOOLTIP` at module scope. Without this side-effect import,
// simply importing the SUT class throws `ReferenceError: $localize is
// not defined` before any test even runs. Mirrors the canonical pattern
// from `apps/client/src/app/components/chat-panel/chat-panel.component.spec.ts:12`.
import '@angular/localize/init';
import { MatTableDataSource } from '@angular/material/table';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { of } from 'rxjs';

import { UserService } from '../../../services/user/user.service';
import { GfModuleWrapperComponent } from '../../module-wrapper/module-wrapper.component';
import { GfTransactionsModuleComponent } from './transactions-module.component';

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
          imports: [GfModuleWrapperComponent, MockActivitiesTableComponent]
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
  // overridden imports list (real GfModuleWrapperComponent + the
  // MockActivitiesTableComponent stub). A failure here is almost
  // certainly a configuration issue (missing provider, unresolved
  // import, $localize not initialized) rather than a behaviour bug.
  it('should be created', () => {
    fixture.detectChanges();

    expect(component).toBeTruthy();
  });

  // Phase 5.2 — Title is rendered as 'Transactions' inside the module
  // wrapper. The SUT initializes its `title` field from the
  // module-scope `TRANSACTIONS_TITLE` constant (= $localize`Transactions`),
  // binds it via `[title]="title"` on the inner
  // `<gf-module-wrapper>`, and the wrapper renders `{{ title() }}`
  // inside the `<h2 class="gf-module-title">` element. This test
  // asserts the end-to-end binding chain so the catalog row label and
  // the rendered header label cannot drift from the
  // `TRANSACTIONS_TITLE` source-of-truth.
  it('should render the module title as "Transactions"', () => {
    fixture.detectChanges();

    const titleElement = fixture.nativeElement.querySelector(
      '.gf-module-title'
    ) as HTMLElement | null;

    expect(titleElement).toBeTruthy();
    expect(titleElement?.textContent?.trim()).toBe('Transactions');
  });

  // Phase 5.3 — Title icon name matches `'list-outline'`. The SUT
  // binds `[iconName]="iconName"` on the inner `<gf-module-wrapper>`,
  // which then renders `<ion-icon [name]="iconName()" />` inside the
  // `.gf-module-title-icon` <span>.
  //
  // NOTE on property vs attribute: Angular's `[name]="iconName()"`
  // syntax compiles to `Renderer2.setProperty(element, 'name', value)`,
  // not `setAttribute(...)`. For native elements where `name` is a
  // reflected IDL attribute the property assignment is mirrored to the
  // attribute automatically by the browser; for custom elements like
  // `<ion-icon>` (registered at runtime by `@ionic/core`'s
  // `defineCustomElements()` rather than statically known to the
  // browser parser) the property is set on the element instance but
  // the framework does NOT mirror it into a `name="..."` attribute. In
  // the Jest test environment the ion-icon custom element is NOT
  // registered (it is only registered in the production browser bundle
  // via `provideIonicAngular()` and per-component `addIcons(...)`
  // calls), so `getAttribute('name')` would always return `null` here.
  // The property assertion below is the canonical contract check for
  // the binding because the property is what Angular actually drives,
  // regardless of whether the custom element is active. Mirrors the
  // pattern established by `module-wrapper.component.spec.ts:142-152`.
  it('should bind iconName "list-outline" to the title-icon ion-icon', () => {
    fixture.detectChanges();

    const titleIcon = fixture.nativeElement.querySelector(
      '.gf-module-title-icon ion-icon'
    ) as (HTMLElement & { name?: string }) | null;

    expect(titleIcon).toBeTruthy();
    expect(titleIcon?.name).toBe('list-outline');
  });

  // Phase 5.4 — Remove emission propagates from the inner wrapper
  // through the SUT's own `remove` output. End-to-end emission chain
  // exercised:
  //   1. User clicks the `.gf-module-remove` button rendered by
  //      `GfModuleWrapperComponent`.
  //   2. Wrapper's `(click)="onRemove()"` handler fires.
  //   3. `onRemove()` calls `this.remove.emit()` on the wrapper.
  //   4. The wrapper's `(remove)` output emits.
  //   5. The SUT's template binds `(remove)="remove.emit()"` on the
  //      `<gf-module-wrapper>`, which forwards the event to the SUT's
  //      own `remove` output.
  //   6. The subscriber attached to `component.remove` increments the
  //      counter once.
  //
  // Subscribes via `.subscribe(...)` (the public OutputEmitterRef API)
  // rather than `jest.spyOn(component.remove, 'emit')` per AAP
  // anti-pattern checklist (the OutputEmitterRef's `emit` is internal
  // implementation detail with a different signature than rxjs Subject.next).
  it('should emit the remove output exactly once when the wrapper remove button is clicked', () => {
    let emissions = 0;
    component.remove.subscribe(() => (emissions += 1));

    fixture.detectChanges();

    const removeBtn = fixture.nativeElement.querySelector(
      '.gf-module-remove'
    ) as HTMLButtonElement | null;
    expect(removeBtn).toBeTruthy();

    removeBtn?.click();

    expect(emissions).toBe(1);
  });

  // Phase 5.5 — `DataService.fetchActivities` is called from
  // `ngOnInit`. Confirms the SUT subscribes to the activities feed on
  // first render. The exact arguments are NOT asserted here (the SUT
  // calls `fetchActivities({})` with an empty options object as the
  // v1 read-only contract per AAP § 0.7.3 — a future change to add
  // pagination/sort would refactor this contract); only that the call
  // happens. Together with Phase 5.6 this proves the data-flow path
  // from service mock through the `activities` signal to the rendered
  // table.
  it('should call DataService.fetchActivities on init', () => {
    fixture.detectChanges();

    expect(mockDataService.fetchActivities).toHaveBeenCalled();
  });

  // Phase 5.6 — `<gf-activities-table>` element renders after data
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

  // Phase 5.7 — Before data loads, `<gf-activities-table>` does NOT
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
          imports: [GfModuleWrapperComponent, MockActivitiesTableComponent]
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

  // Phase 5.8 — Read-only flags propagate to the inner table.
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
});
