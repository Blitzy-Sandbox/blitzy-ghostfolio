import { UserService } from '@ghostfolio/client/services/user/user.service';
import { Activity, User } from '@ghostfolio/common/interfaces';
import { GfActivitiesTableComponent } from '@ghostfolio/ui/activities-table';
import { DataService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  output,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatTableDataSource } from '@angular/material/table';

import { DashboardModuleDescriptor } from '../../interfaces/dashboard-module.interface';
import { GfModuleWrapperComponent } from '../../module-wrapper/module-wrapper.component';

// Module-scope i18n title constant (AAP agent prompt Phase 2 — i18n
// String Constants).
//
// Declared at module scope (NOT as a class field) so the value can be
// shared between the SUT's `title` field (rendered inside the module
// header by `<gf-module-wrapper>`) and the exported
// `TRANSACTIONS_MODULE_DESCRIPTOR.displayLabel` (rendered as the catalog
// row label by `<gf-module-catalog>`). A single shared constant
// guarantees that translation updates propagate to both surfaces
// consistently — there is no risk of the header label drifting from
// the catalog label because both are wired to the same
// `$localize`-tagged template literal.
//
// Module-scope `$localize` template literals are statically extractable
// by the Angular i18n extractor (`ng extract-i18n`), the same pattern
// used in the canonical `chat-panel.component.ts:22`
// (`STREAM_ERROR_MESSAGE = $localize`). Module-scope `$localize` calls
// require the runtime `@angular/localize/init` import in the spec
// file's top-level imports — that companion import is declared in
// `transactions-module.component.spec.ts`, mirroring the
// `chat-panel.component.spec.ts:11` and
// `module-wrapper.component.spec.ts:13` patterns.
const TRANSACTIONS_TITLE = $localize`Transactions`;

/**
 * Transactions (a.k.a. Activities) dashboard module wrapper.
 *
 * Wraps the existing `GfActivitiesTableComponent` from
 * `@ghostfolio/ui/activities-table` inside the unified
 * `GfModuleWrapperComponent` chrome and renders it as a self-contained
 * grid module on the dashboard canvas. On `ngOnInit`, the wrapper
 * fetches activities once via `DataService.fetchActivities({})` and
 * pipes the resulting array into a `MatTableDataSource<Activity>` for
 * the inner table.
 *
 * Per AAP § 0.7.3 (Out-of-scope), this wrapper exposes a strictly
 * read-only view of activities — all editing, deletion, export,
 * filtering, sorting, pagination, and click-into-details flows are
 * disabled by binding the table's permission flags and `showActions`
 * to `false` in the template (see
 * `transactions-module.component.html`). The legacy page-level
 * orchestration that lived in
 * `apps/client/src/app/pages/portfolio/activities/activities-page.component.ts`
 * (route shell removed per AAP § 0.7.1.7) is intentionally NOT
 * reproduced here.
 *
 * Per Rule 1 (AAP § 0.8.1.1), this component MUST NOT import from the
 * dashboard-canvas, module-catalog, sibling modules, or services
 * subfolders. The only allowed dashboard imports are the sibling
 * `module-wrapper` chrome (`GfModuleWrapperComponent`) and the
 * `interfaces` type definitions (`DashboardModuleDescriptor`). Data
 * flows exclusively through the existing `DataService` (from
 * `@ghostfolio/ui/services`) and `UserService` (from
 * `@ghostfolio/client/services/user/user.service`); both are preserved
 * unchanged per the AAP boundaries section.
 *
 * Per Rule 2 (AAP § 0.8.1.2), this component MUST NOT declare
 * layout-coordinate inputs/outputs (`x`, `y`, `cols`, `rows`) and MUST
 * NOT mutate host element layout style properties. Position and size
 * are owned by the gridster `dashboard` array on
 * `GfDashboardCanvasComponent`.
 *
 * Per Rule 4 (AAP § 0.8.1.4), this component MUST NOT inject
 * `UserDashboardLayoutService` or `LayoutPersistenceService` — layout
 * persistence is triggered exclusively by grid state-change events
 * subscribed at the canvas level. The wrapper merely emits a `remove`
 * event when the user activates the wrapper's remove button; the
 * canvas reconciles the gridster `dashboard` array and the persistence
 * pipeline observes that mutation through gridster's change callbacks.
 *
 * Public API surface:
 *
 * - `remove` — signal-based output of `void`. Emits when the inner
 *   `<gf-module-wrapper>` propagates its remove event (the user has
 *   activated the remove button in the module header). The receiving
 *   canvas listens via `(remove)="..."` per-item.
 * - `iconName` — readonly string field bound to
 *   `[iconName]="iconName"` on `<gf-module-wrapper>`. Carries the
 *   Ionicons name for the module header icon.
 * - `title` — readonly string field initialized from the module-scope
 *   `TRANSACTIONS_TITLE` constant; bound to `[title]="title"` on
 *   `<gf-module-wrapper>`.
 * - `activities` — signal of `MatTableDataSource<Activity> |
 *   undefined`; populated by the `dataService.fetchActivities({})`
 *   subscription in `ngOnInit`. The template guards rendering on
 *   `@if (activities()) { ... }` so the inner `<gf-activities-table>`
 *   does not mount until data has resolved.
 * - `user` — signal of `User | undefined`; updated by the
 *   `userService.stateChanged` subscription in `ngOnInit`. While the
 *   v1 template does NOT consume the user signal (per AAP § 0.7.3
 *   OUT-OF-SCOPE: locale, base currency), the field is retained
 *   because the AAP folder spec lists it as a required class member.
 *   Future enhancements may bind it (e.g., `[locale]="user()?.settings?.locale"`).
 *
 * Reference: AAP § 0.6.1.4 (Group 4 — Angular Dashboard Feature) is
 * the canonical specification for this contract; AAP § 0.7.4 governs
 * the `gf-transactions-module` selector convention.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, GfActivitiesTableComponent, GfModuleWrapperComponent],
  selector: 'gf-transactions-module',
  styleUrls: ['./transactions-module.component.scss'],
  templateUrl: './transactions-module.component.html'
})
export class GfTransactionsModuleComponent implements OnInit {
  /**
   * Emits `void` whenever the inner `<gf-module-wrapper>` propagates
   * its remove event. The template binds
   * `(remove)="remove.emit()"` on the wrapper element to forward the
   * event up to whichever canvas instance has subscribed.
   *
   * Per Rule 2 (AAP § 0.8.1.2), this output is the wrapper's ONLY
   * coupling point to the canvas — the wrapper does NOT mutate the
   * gridster `dashboard` array and does NOT call any layout-save APIs.
   */
  public readonly remove = output<void>();

  /**
   * Ionicons icon name shown alongside the title in the module header.
   * Must exist in the Ionicons 8.x catalog; `'list-outline'` is a
   * standard icon. Mirrors the value of
   * {@link TRANSACTIONS_MODULE_DESCRIPTOR.iconName} so the icon shown
   * in the module header matches the icon shown in the module catalog
   * row.
   *
   * Bound in the template as `[iconName]="iconName"` (NOT a signal —
   * `<gf-module-wrapper>`'s `iconName` input accepts a plain string,
   * Angular handles the binding without explicit signal call syntax).
   */
  public readonly iconName = 'list-outline';

  /**
   * Module title shown in the header. Initialized from the
   * module-scope {@link TRANSACTIONS_TITLE} constant so the title
   * shares the exact same `$localize`-tagged value with
   * {@link TRANSACTIONS_MODULE_DESCRIPTOR.displayLabel} (the catalog
   * row label). A single source-of-truth constant prevents translation
   * drift between the two surfaces.
   *
   * Bound in the template as `[title]="title"` on `<gf-module-wrapper>`.
   */
  public readonly title = TRANSACTIONS_TITLE;

  /**
   * Component state for the inner `<gf-activities-table>` data source.
   *
   * The signal starts as `undefined` so the template guard
   * `@if (activities()) { ... }` evaluates falsy on first render — the
   * inner table is NOT mounted until data has resolved. After
   * `dataService.fetchActivities({})` resolves, the subscription wraps
   * the returned `Activity[]` in a fresh `MatTableDataSource<Activity>`
   * and assigns it via `this.activities.set(...)`; the signal update
   * triggers OnPush change detection automatically and the inner table
   * mounts with the populated data source.
   *
   * The `MatTableDataSource` wrapper is required because
   * `GfActivitiesTableComponent.dataSource` is typed
   * `input.required<MatTableDataSource<Activity> | undefined>()` — the
   * data source also enables the table's internal
   * `MatPaginator`/`MatSort` wiring at `ngAfterViewInit` time, even
   * though the wrapper does not bind a paginator or sort from outside.
   */
  public readonly activities = signal<MatTableDataSource<Activity> | undefined>(
    undefined
  );

  /**
   * Component state for the authenticated user, sourced from
   * `userService.stateChanged`. Currently NOT bound in the v1 template
   * (per AAP § 0.7.3 OUT-OF-SCOPE: locale, base currency), but
   * retained because the AAP folder spec lists `user` as a required
   * class member. The signal is exposed as `public readonly` so future
   * enhancements (e.g., `[locale]="user()?.settings?.locale"`) can
   * consume it without requiring a follow-up code change to introduce
   * the field.
   */
  public readonly user = signal<User | undefined>(undefined);

  /**
   * `DataService` from `@ghostfolio/ui/services` — the shared HTTP
   * client wrapper for the Ghostfolio REST API. The wrapper consumes
   * exactly one method: `fetchActivities({})`.
   *
   * Injected via the modern Angular 21 `inject(...)` field-level idiom
   * (see canonical example at `chat-panel.component.ts:81–82`). Marked
   * `private readonly` because the service reference is internal to
   * the component and never reassigned.
   */
  private readonly dataService = inject(DataService);

  /**
   * `DestroyRef` token used by `takeUntilDestroyed(this.destroyRef)`
   * to auto-unsubscribe from RxJS streams when the component is
   * destroyed. Replaces the manual `ngOnDestroy` + `Subject.next() /
   * complete()` teardown pattern used in pre-Angular-17 code.
   *
   * Per AAP § 0.1.2, every Observable subscription in this codebase
   * MUST be piped through `takeUntilDestroyed(destroyRef)` for cleanup.
   */
  private readonly destroyRef = inject(DestroyRef);

  /**
   * `UserService` from `@ghostfolio/client/services/user/user.service`
   * — extends `ObservableStore<UserStoreState>` and exposes
   * `stateChanged: Observable<UserStoreState>` with shape
   * `{ user?: User }`. The wrapper subscribes to this stream in
   * `ngOnInit` to keep the {@link user} signal in sync with the
   * authenticated user state.
   */
  private readonly userService = inject(UserService);

  /**
   * Lifecycle hook called once after the component's data-bound
   * properties have been initialized. Wires both observable
   * subscriptions:
   *
   * 1. `userService.stateChanged` — updates the {@link user} signal
   *    when a non-null user is present in the store. The defensive
   *    `state?.user` guard handles the initialization case where the
   *    store has been seeded with `{ user: undefined }` (see
   *    `user.service.ts` constructor) before the user has authenticated.
   *
   * 2. `dataService.fetchActivities({})` — fetches the first page of
   *    activities with all defaults (no filters, no range, no skip, no
   *    take, default sort). The empty argument object activates the
   *    method's parameter destructuring with all-undefined values; this
   *    is the v1 read-only contract (per AAP § 0.7.3 OUT-OF-SCOPE:
   *    pagination, sorting, filtering, range selection). The
   *    destructuring `({ activities })` discards the `count` property
   *    (count is a pagination total, which is not surfaced in the v1
   *    read-only view).
   *
   * Both subscriptions are piped through
   * `takeUntilDestroyed(this.destroyRef)` so they auto-dispose when
   * the gridster canvas removes this module's `<gridster-item>` (no
   * manual `ngOnDestroy` required).
   *
   * NOTE on no manual change-detection nudges: this component uses
   * signals exclusively for state, and signal updates trigger OnPush
   * change detection automatically. The legacy
   * `activities-page.component.ts` (since deleted) called
   * `changeDetectorRef.markForCheck()` after each subscription
   * callback because it used non-signal class fields — that
   * pre-Angular-17 pattern is intentionally NOT reproduced here.
   *
   * NOTE on no error handling: errors from
   * `dataService.fetchActivities` are surfaced by the global
   * `http-response.interceptor.ts` (preserved per AAP § 0.4.1.2).
   * Adding component-level `catchError` would duplicate concerns.
   */
  public ngOnInit(): void {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user.set(state.user);
        }
      });

    this.dataService
      .fetchActivities({})
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ activities }) => {
        this.activities.set(new MatTableDataSource<Activity>(activities));
      });
  }
}

/**
 * Module descriptor for the Transactions module wrapper — the Rule 3
 * self-registration mechanism per AAP § 0.8.1.3.
 *
 * Imported into the module-registry bootstrap (typically an
 * `APP_INITIALIZER` factory or a side-effect import in the dashboard
 * canvas's `imports` chain) and registered via
 * `ModuleRegistryService.register(TRANSACTIONS_MODULE_DESCRIPTOR)`.
 * The registry is the single source of allowed grid-item component
 * types in the modular dashboard; the canvas
 * (`GfDashboardCanvasComponent`) resolves this descriptor by name when
 * hydrating a saved layout or processing a catalog `addModule` event,
 * then instantiates the descriptor's `component` reference via
 * `viewContainerRef.createComponent(...)`.
 *
 * Per Rule 6 (AAP § 0.8.1.6), `minCols` and `minRows` MUST be ≥ 2;
 * `defaultCols` MUST be ≥ `minCols` and `defaultRows` MUST be ≥
 * `minRows`. The values declared below — 4 × 4 minimum, 8 × 6 default
 * — reflect the activities table's content density: a meaningful
 * read-only view of transactions requires at least 4 columns wide and
 * 4 rows tall to display a few activity rows alongside the table
 * header without aggressive truncation; the default 8 × 6 placement
 * provides a comfortable initial size for most users on the 12-column
 * grid.
 *
 * Field invariants (cross-checked against
 * {@link DashboardModuleDescriptor} contract):
 *
 * - `name: 'transactions'` — kebab-case stable identifier. Used as
 *   the discriminator in `LayoutItem.moduleId` of persisted layout
 *   documents. MUST NOT be renamed without a layout-document migration
 *   step (renaming breaks every saved layout that references it).
 * - `displayLabel: TRANSACTIONS_TITLE` — shares the same
 *   `$localize`-tagged constant with {@link GfTransactionsModuleComponent.title}
 *   so translations update both the catalog row and the module header
 *   consistently.
 * - `iconName: 'list-outline'` — Ionicons 8.x standard icon name;
 *   matches {@link GfTransactionsModuleComponent.iconName}.
 */
export const TRANSACTIONS_MODULE_DESCRIPTOR: DashboardModuleDescriptor = {
  component: GfTransactionsModuleComponent,
  defaultCols: 8,
  defaultRows: 6,
  displayLabel: TRANSACTIONS_TITLE,
  iconName: 'list-outline',
  minCols: 4,
  minRows: 4,
  name: 'transactions'
};
