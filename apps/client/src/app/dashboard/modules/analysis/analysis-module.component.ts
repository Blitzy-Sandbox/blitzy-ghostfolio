import { GfBenchmarkComparatorComponent } from '@ghostfolio/client/components/benchmark-comparator/benchmark-comparator.component';
import { GfInvestmentChartComponent } from '@ghostfolio/client/components/investment-chart/investment-chart.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  HistoricalDataItem,
  InvestmentItem,
  PortfolioPerformance,
  User
} from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';
import { GfValueComponent } from '@ghostfolio/ui/value';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  inject,
  OnInit,
  output,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { DataSource, SymbolProfile } from '@prisma/client';

import { DashboardModuleDescriptor } from '../../interfaces/dashboard-module.interface';
import { GfModuleWrapperComponent } from '../../module-wrapper/module-wrapper.component';

// Module-scope i18n title constant (AAP agent prompt Phase 2 — i18n
// String Constants).
//
// Declared at module scope (NOT as a class field with a default
// expression) so the value can be referenced by BOTH the SUT's `title`
// field AND the {@link ANALYSIS_MODULE_DESCRIPTOR.displayLabel} field
// below. A single shared `$localize`-tagged constant is the single
// source of truth for the human-readable label that appears in two
// surfaces:
//
// 1. The module header rendered by `<gf-module-wrapper [title]="title">`
//    inside `analysis-module.component.html`.
// 2. The module catalog row rendered by `<gf-module-catalog>` from the
//    descriptor's `displayLabel` (the catalog reads the registered
//    descriptor via `ModuleRegistryService.getAll()`).
//
// Module-scope `$localize` template literals are statically extractable
// by the Angular i18n extractor (`ng extract-i18n`) — the same pattern
// used in `chat-panel.component.ts:22` (`STREAM_ERROR_MESSAGE =
// $localize`) and at the sibling
// `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.ts`
// (`TRANSACTIONS_TITLE = $localize\`Transactions\``).
//
// Module-scope `$localize` calls require the runtime to have evaluated
// `@angular/localize/init` BEFORE this file is imported. The production
// app bootstraps it via the `@angular/localize/init` import in
// `apps/client/src/main.ts`; the companion spec file imports it
// explicitly at the top of `analysis-module.component.spec.ts`,
// mirroring the `chat-panel.component.spec.ts:11` pattern.
const ANALYSIS_TITLE = $localize`Analysis`;

/**
 * Analysis dashboard module wrapper.
 *
 * Wraps the existing analysis presentation primitives —
 * {@link GfBenchmarkComparatorComponent}, {@link GfInvestmentChartComponent},
 * and {@link GfValueComponent} — inside the unified
 * {@link GfModuleWrapperComponent} chrome and renders them as a
 * self-contained grid module on the dashboard canvas. The wrapper
 * orchestrates data fetching for the wrapped primitives via
 * {@link DataService} and {@link UserService}.
 *
 * Per AAP § 0.7.3, the wrapper EXCLUDES the source page's
 * experimental-features menu, AI prompt copy-to-clipboard, Duck.ai
 * integration, snackbar feedback, performance details breakdown,
 * top/bottom 3 holdings lists, investment timeline (separate from
 * portfolio evolution), dividend timeline, streaks, and group-by
 * toggle. The simplified module renders only the three required
 * presentation primitives over the user's portfolio performance data:
 *
 * 1. Three `gf-value` cards (total amount, change with currency
 *    effect, performance with currency effect).
 * 2. A `gf-benchmark-comparator` (with benchmark switching support).
 * 3. A `gf-investment-chart` (Portfolio Evolution).
 *
 * Per Rule 1 (AAP § 0.8.1.1), this component MUST NOT import from
 * the dashboard-canvas, module-catalog, sibling modules, or
 * services subfolders. The only allowed dashboard imports are
 * the sibling `module-wrapper` chrome ({@link GfModuleWrapperComponent})
 * and the `interfaces` type definitions
 * ({@link DashboardModuleDescriptor}). External imports are limited
 * to the wrapped presentation components, the existing data-fetching
 * services (preserved unchanged per the AAP boundaries section),
 * `@angular/common`, `@angular/core`, `@angular/material/card`, and
 * the Prisma type bindings.
 *
 * Per Rule 2 (AAP § 0.8.1.2), this component MUST NOT declare
 * layout-coordinate inputs/outputs (`x`, `y`, `cols`, `rows`).
 * Position and size are owned by gridster on the canvas. The
 * wrapper does NOT inject `ElementRef`, NOT bind any `style.width`
 * / `style.height` / `style.transform` / `style.position` properties
 * on the host, and NOT mutate the gridster `dashboard` array
 * directly.
 *
 * Per Rule 4 (AAP § 0.8.1.4), this component MUST NOT inject
 * `UserDashboardLayoutService` or `LayoutPersistenceService` —
 * persistence is triggered exclusively by grid state-change events
 * subscribed at the canvas level. The {@link onChangeBenchmark}
 * method calls `dataService.putUserSetting(...)` which is a
 * USER-PREFERENCE save (the user's selected benchmark profile)
 * and is conceptually distinct from the dashboard's grid-layout
 * persistence — it is therefore allowed under Rule 4.
 *
 * Public API surface (members enumerated in the schema's
 * `exports.members_exposed` list):
 *
 * - `remove` — signal-based output of `void`. Emits when the inner
 *   `<gf-module-wrapper>` propagates its remove event (the user has
 *   activated the remove button in the module header).
 * - `iconName`, `precision`, `title` — readonly static configuration
 *   bound to the inner wrapper / value components.
 * - `benchmark`, `benchmarkDataItems`, `benchmarks`, `investments`,
 *   `isLoadingBenchmarkComparator`, `isLoadingInvestmentChart`,
 *   `performance`, `performanceDataItems`,
 *   `performanceDataItemsInPercentage`, `user` — reactive `signal`
 *   state surfaces consumed by the template via signal-call syntax
 *   (`benchmark()`, `user()?.settings?.locale`, etc.).
 * - `ngOnInit()` — wires the `userService.stateChanged` subscription
 *   that drives all subsequent data refreshes.
 * - `onChangeBenchmark(symbolProfileId)` — handler for the
 *   `(benchmarkChanged)` output of `gf-benchmark-comparator`.
 *
 * **Implementation deviations from the AAP agent prompt that are
 * required to compile and behave correctly**:
 *
 * - The `DataService` is imported from `@ghostfolio/ui/services`
 *   (NOT `@ghostfolio/client/services/data.service` as the AAP
 *   prompt states). `data.service.ts` lives in
 *   `libs/ui/src/lib/services/data.service.ts` and is exported via
 *   the `@ghostfolio/ui/services` barrel — this is the path used by
 *   all sibling consumers (e.g., `transactions-module.component.ts`,
 *   `home-overview.component.ts`).
 * - `dataService.fetchPortfolioPerformance(...)` requires a `range`
 *   parameter (not optional in its method signature). The wrapper
 *   passes `range: this.user()?.settings?.dateRange` — the same
 *   pattern used by `home-overview.component.ts`.
 * - `dataService.fetchBenchmarkForUser(...)` requires both `range`
 *   and `startDate`. The wrapper captures `firstOrderDate` from the
 *   performance response into a private field and uses it as the
 *   benchmark `startDate` (with `new Date()` as a fallback for new
 *   users with no order history) — the same pattern used by the
 *   source `analysis-page.component.ts`.
 * - The benchmark resolution matches `benchmark.id ===
 *   user.settings.benchmark` (the source page's pattern) instead
 *   of `getAssetProfileIdentifier(...)` proposed by the AAP.
 *   `gf-benchmark-comparator`'s template binds
 *   `[value]="benchmark?.id"` on the `<mat-option>` and emits
 *   `benchmarkChanged` with that `id`, so `user.settings.benchmark`
 *   is the SymbolProfile UUID `id` — not a `<dataSource>-<symbol>`
 *   identifier.
 * - The benchmark refresh in {@link onChangeBenchmark} uses
 *   `userService.get(true)` to force a re-fetch (the source page's
 *   pattern). The AAP's proposed `userService.remove()` does not
 *   exist on the `UserService` class.
 *
 * Reference: AAP § 0.6.1.4 (Group 4 — Angular Dashboard Feature) is
 * the canonical specification for this contract; AAP § 0.7.4 governs
 * the `gf-analysis-module` selector convention.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfBenchmarkComparatorComponent,
    GfInvestmentChartComponent,
    GfModuleWrapperComponent,
    GfValueComponent,
    MatCardModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-analysis-module',
  styleUrls: ['./analysis-module.component.scss'],
  templateUrl: './analysis-module.component.html'
})
export class GfAnalysisModuleComponent implements OnInit {
  /**
   * Emits `void` whenever the inner `<gf-module-wrapper>` propagates
   * its remove event. The template binds
   * `(remove)="remove.emit()"` on the wrapper element to forward the
   * event up to whichever canvas instance has subscribed.
   *
   * Per Rule 2 (AAP § 0.8.1.2), this output is the wrapper's ONLY
   * coupling point to the canvas — the wrapper does NOT mutate the
   * gridster `dashboard` array and does NOT call any layout-save
   * APIs.
   *
   * The signal-based `output<void>()` factory is used (per AAP
   * § 0.1.2) instead of the legacy `EventEmitter<void>` decorator
   * pattern.
   */
  public readonly remove = output<void>();

  /**
   * Ionicons icon name shown alongside the title in the module
   * header. `'bar-chart-outline'` is a standard Ionicons 8.x icon
   * appropriate for an analysis surface. Mirrors the value of
   * {@link ANALYSIS_MODULE_DESCRIPTOR.iconName} so the icon shown
   * in the module header matches the icon shown in the module
   * catalog row.
   *
   * Bound in the template as `[iconName]="iconName"` (NOT a signal
   * — `<gf-module-wrapper>`'s `iconName` input accepts a plain
   * string).
   */
  public readonly iconName = 'bar-chart-outline';

  /**
   * Number of fraction digits for currency formatting in the inner
   * `gf-value` components. The source page additionally adjusts
   * this to `0` on mobile when amounts exceed 1M
   * (`NUMERICAL_PRECISION_THRESHOLD_6_FIGURES`); the wrapper
   * hard-codes `2` because the device-detector and threshold logic
   * are out of scope per AAP § 0.7.3.
   */
  public readonly precision = 2;

  /**
   * Module title shown in the header. Initialized from the
   * module-scope {@link ANALYSIS_TITLE} constant so the title shares
   * the exact same `$localize`-tagged value with
   * {@link ANALYSIS_MODULE_DESCRIPTOR.displayLabel} (the catalog row
   * label). A single source-of-truth constant prevents translation
   * drift between the two surfaces.
   *
   * Bound in the template as `[title]="title"` on
   * `<gf-module-wrapper>`.
   */
  public readonly title = ANALYSIS_TITLE;

  // ----- State signals -----

  /**
   * Currently-selected benchmark for the comparator. Resolved from
   * `user.settings.benchmark` (a SymbolProfile UUID `id`) against
   * the {@link benchmarks} list, or `null` if the user has not
   * selected a benchmark.
   *
   * `Partial<SymbolProfile>` is used because the benchmarks
   * returned by `dataService.fetchInfo()` contain only the fields
   * the API exposes (`id`, `dataSource`, `symbol`, `name`,
   * `currency`) — not the full Prisma `SymbolProfile` row.
   */
  public readonly benchmark = signal<Partial<SymbolProfile> | null>(null);

  /**
   * Benchmark market-data series rendered as the comparison line in
   * `gf-benchmark-comparator`. Empty until
   * {@link updateBenchmarkDataItems} resolves a benchmark response.
   */
  public readonly benchmarkDataItems = signal<HistoricalDataItem[]>([]);

  /**
   * All available benchmark options. Captured from
   * `dataService.fetchInfo().benchmarks` on `ngOnInit`. The
   * synchronous `fetchInfo()` call returns the singleton-cached
   * info payload that was fetched once at app bootstrap; no HTTP
   * call is made here.
   */
  public readonly benchmarks = signal<Partial<SymbolProfile>[]>([]);

  /**
   * Investment series rendered as the primary line in the
   * Portfolio Evolution `gf-investment-chart`. Each entry has
   * `{ date, investment }`; the value is sourced from the
   * `netWorth` field of the corresponding chart entry.
   */
  public readonly investments = signal<InvestmentItem[]>([]);

  /**
   * Loading flag for the benchmark comparator section. Toggled by
   * {@link updateBenchmarkDataItems} on/off around the
   * `dataService.fetchBenchmarkForUser(...)` call. Bound to the
   * comparator's `[isLoading]` input (which renders a skeleton
   * placeholder while truthy).
   */
  public readonly isLoadingBenchmarkComparator = signal<boolean>(false);

  /**
   * Loading flag for the investment-chart section. Toggled by
   * {@link update} on/off around the
   * `dataService.fetchPortfolioPerformance(...)` call. Bound to
   * the chart's `[isLoading]` input.
   */
  public readonly isLoadingInvestmentChart = signal<boolean>(false);

  /**
   * Aggregated portfolio performance figures. Populated from the
   * `performance` field of the `fetchPortfolioPerformance(...)`
   * response. Used by the three `gf-value` cards at the top of the
   * module: total amount, change with currency effect, performance
   * with currency effect.
   */
  public readonly performance = signal<PortfolioPerformance | undefined>(
    undefined
  );

  /**
   * Performance series in absolute terms (used as the primary line
   * in the investment chart's `historicalDataItems` input). Each
   * entry is `{ date, value }` where `value` is the corresponding
   * chart entry's `netPerformanceInPercentage`.
   */
  public readonly performanceDataItems = signal<HistoricalDataItem[]>([]);

  /**
   * Performance series with currency effect applied (used as the
   * primary line in the benchmark comparator's
   * `performanceDataItems` input). Each entry is `{ date, value }`
   * where `value` is the corresponding chart entry's
   * `netPerformanceInPercentageWithCurrencyEffect`.
   */
  public readonly performanceDataItemsInPercentage = signal<
    HistoricalDataItem[]
  >([]);

  /**
   * Authenticated user state. Updated by the
   * `userService.stateChanged` subscription in {@link ngOnInit}.
   * Used by the template to read user settings (locale,
   * baseCurrency, colorScheme, benchmark, dateRange,
   * isRestrictedView) for the inner presentation components.
   */
  public readonly user = signal<User | undefined>(undefined);

  /**
   * `DataService` from `@ghostfolio/ui/services` — the shared HTTP
   * client wrapper for the Ghostfolio REST API. The wrapper consumes
   * four methods: `fetchInfo()`, `fetchPortfolioPerformance(...)`,
   * `fetchBenchmarkForUser(...)`, and `putUserSetting(...)`.
   *
   * Injected via the modern Angular 21 `inject(...)` field-level
   * idiom (see canonical example at `chat-panel.component.ts:81–82`).
   * Marked `private readonly` because the service reference is
   * internal to the component and never reassigned.
   */
  private readonly dataService = inject(DataService);

  /**
   * `DestroyRef` token used by `takeUntilDestroyed(this.destroyRef)`
   * to auto-unsubscribe from RxJS streams when the component is
   * destroyed. Replaces the manual `ngOnDestroy` + `Subject.next() /
   * complete()` teardown pattern used in pre-Angular-17 code.
   *
   * Per AAP § 0.1.2, every Observable subscription in this codebase
   * MUST be piped through `takeUntilDestroyed(destroyRef)` for
   * cleanup.
   */
  private readonly destroyRef = inject(DestroyRef);

  /**
   * `UserService` from
   * `@ghostfolio/client/services/user/user.service` — extends
   * `ObservableStore<UserStoreState>` and exposes
   * `stateChanged: Observable<UserStoreState>` with shape
   * `{ user?: User }`. The wrapper subscribes to this stream in
   * `ngOnInit` to keep the {@link user} signal in sync with the
   * authenticated user state and to trigger a data refresh whenever
   * the user (or any of their settings, including the selected
   * benchmark) changes.
   */
  private readonly userService = inject(UserService);

  /**
   * Earliest portfolio order date for the authenticated user.
   *
   * Captured from the `firstOrderDate` field on
   * `PortfolioPerformanceResponse` (the response of
   * `dataService.fetchPortfolioPerformance(...)`) and used as the
   * `startDate` parameter on `dataService.fetchBenchmarkForUser(...)`
   * so the benchmark line shown in the comparator covers the user's
   * actual portfolio history (not just from today onward). Defaults
   * to `undefined` until the first performance response resolves;
   * {@link updateBenchmarkDataItems} falls back to `new Date()` if
   * no first-order date has been captured (the case for brand-new
   * users with no orders yet).
   *
   * This field is `private` because it is an internal implementation
   * detail — the schema's exported public surface does NOT include
   * `firstOrderDate`. The field is required for the benchmark
   * `startDate` parameter, which the source page also tracks.
   */
  private firstOrderDate: Date | undefined = undefined;

  /**
   * Lifecycle hook called once after the component's data-bound
   * properties have been initialized. Wires:
   *
   * 1. The {@link benchmarks} signal — captured synchronously from
   *    `dataService.fetchInfo()` (singleton-cached info payload).
   *
   * 2. The `userService.stateChanged` subscription — updates the
   *    {@link user} signal, resolves the {@link benchmark} signal
   *    from `user.settings.benchmark`, and triggers the data
   *    refresh via {@link update}. Auto-cleaned via
   *    `takeUntilDestroyed(this.destroyRef)` on component
   *    destruction.
   *
   * NOTE on no manual change-detection nudges: this component uses
   * signals exclusively for state, and signal updates trigger
   * OnPush change detection automatically. The legacy
   * `analysis-page.component.ts` (since deleted) called
   * `changeDetectorRef.markForCheck()` after each subscription
   * callback because it used non-signal class fields — that
   * pre-Angular-17 pattern is intentionally NOT reproduced here.
   *
   * NOTE on no error handling: errors from `DataService` calls are
   * surfaced by the global `http-response.interceptor.ts`
   * (preserved per AAP § 0.4.1.2). Adding component-level
   * `catchError` would duplicate concerns.
   */
  public ngOnInit(): void {
    // Capture the cached benchmarks list. `dataService.fetchInfo()`
    // returns synchronously from the singleton-cached info payload
    // that was fetched once at app bootstrap; no HTTP call is made
    // here.
    this.benchmarks.set(this.dataService.fetchInfo().benchmarks ?? []);

    // Subscribe to user state. When the user changes (login,
    // settings update, or benchmark change), refresh the analysis
    // data.
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (!state?.user) {
          return;
        }

        this.user.set(state.user);

        // Resolve the currently-selected benchmark from
        // `user.settings.benchmark` (the SymbolProfile UUID `id`).
        // Match by `id` because the benchmark-comparator template
        // binds `[value]="benchmark?.id"` and emits that id via
        // `(benchmarkChanged)`, which in turn is persisted via
        // `dataService.putUserSetting({ benchmark: id })`. If found,
        // pin it to the local signal; otherwise leave it null (the
        // comparator will show no comparison line).
        const benchmarkSetting = state.user.settings?.benchmark;
        if (benchmarkSetting) {
          const found = this.benchmarks().find(({ id }) => {
            return id === benchmarkSetting;
          });
          this.benchmark.set(found ?? null);
        } else {
          this.benchmark.set(null);
        }

        this.update();
      });
  }

  /**
   * Handler for the `(benchmarkChanged)` output of
   * `gf-benchmark-comparator`. Persists the new benchmark selection
   * via `dataService.putUserSetting(...)`, then forces a refetch of
   * the user state via `userService.get(true)`. The refetch's
   * resulting `setState({ user })` publishes via `stateChanged`,
   * which the SUT is already subscribed to in {@link ngOnInit};
   * that handler resolves the new benchmark and re-runs
   * {@link update}.
   *
   * Per Rule 4 (AAP § 0.8.1.4), this method calls a USER-PREFERENCE
   * save — distinct from the dashboard's grid-layout persistence
   * pipeline (which is owned by the canvas). The wrapper does NOT
   * inject the layout-persistence services; only the existing
   * `dataService.putUserSetting(...)` is invoked.
   *
   * Both the persist call and the refetch call are piped through
   * `takeUntilDestroyed(this.destroyRef)` so they auto-dispose if
   * the canvas removes this module's `<gridster-item>` mid-flight.
   *
   * @param symbolProfileId The SymbolProfile UUID emitted by
   *   `gf-benchmark-comparator` when the user selects a different
   *   benchmark.
   */
  public onChangeBenchmark(symbolProfileId: string): void {
    this.dataService
      .putUserSetting({ benchmark: symbolProfileId })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Force a refetch of the user state so the rest of the app
        // (and our own `stateChanged` subscription) sees the
        // updated benchmark setting. `userService.get(true)`
        // bypasses the in-memory cache and re-issues
        // `GET /api/v1/user`. The publication on `stateChanged`
        // will flow back into our ngOnInit subscription and
        // re-trigger the analysis update.
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();
      });
  }

  /**
   * Refreshes the portfolio performance data and derived chart
   * series. Called from the `userService.stateChanged` subscription
   * in {@link ngOnInit} and from the post-persist refetch path in
   * {@link onChangeBenchmark}.
   *
   * Sequence:
   * 1. Set {@link isLoadingInvestmentChart} truthy.
   * 2. Fetch performance data via
   *    `dataService.fetchPortfolioPerformance({ range })`. The
   *    `range` parameter is required by the method signature; the
   *    user's preferred range is read from
   *    `user.settings.dateRange` (matching the
   *    `home-overview.component.ts` pattern).
   * 3. Capture `firstOrderDate` from the response into the private
   *    {@link firstOrderDate} field for use as the benchmark
   *    `startDate`.
   * 4. Iterate the `chart` array to build three parallel series:
   *    {@link investments} (for the investment chart's primary
   *    line), {@link performanceDataItems} (raw performance for the
   *    investment chart's `historicalDataItems` input), and
   *    {@link performanceDataItemsInPercentage} (currency-effect
   *    performance for the comparator's primary line).
   * 5. Set {@link isLoadingInvestmentChart} falsy.
   * 6. Trigger the benchmark refresh via
   *    {@link updateBenchmarkDataItems}.
   */
  private update(): void {
    this.isLoadingInvestmentChart.set(true);

    this.dataService
      .fetchPortfolioPerformance({
        range: this.user()?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ chart, firstOrderDate, performance }) => {
        // Capture firstOrderDate for the benchmark `startDate`
        // parameter. Falls back to `new Date()` for new users
        // without any portfolio orders.
        this.firstOrderDate = firstOrderDate ?? new Date();

        this.performance.set(performance);

        const investments: InvestmentItem[] = [];
        const performanceDataItems: HistoricalDataItem[] = [];
        const performanceDataItemsInPercentage: HistoricalDataItem[] = [];

        for (const entry of chart ?? []) {
          investments.push({
            date: entry.date,
            investment: entry.netWorth
          });
          performanceDataItems.push({
            date: entry.date,
            value: entry.netPerformanceInPercentage
          });
          performanceDataItemsInPercentage.push({
            date: entry.date,
            value: entry.netPerformanceInPercentageWithCurrencyEffect
          });
        }

        this.investments.set(investments);
        this.performanceDataItems.set(performanceDataItems);
        this.performanceDataItemsInPercentage.set(
          performanceDataItemsInPercentage
        );
        this.isLoadingInvestmentChart.set(false);

        this.updateBenchmarkDataItems();
      });
  }

  /**
   * Refreshes the benchmark comparison line. Called from
   * {@link update} after the performance response resolves.
   *
   * Sequence:
   * 1. Clear {@link benchmarkDataItems} so the comparator's old
   *    line disappears immediately on benchmark change.
   * 2. Read the user's benchmark setting and the resolved benchmark
   *    profile from local signals.
   * 3. Early-return if the user has no benchmark selected OR if the
   *    resolved profile lacks the required `dataSource`/`symbol`
   *    fields — the comparator simply renders no comparison line.
   * 4. Set {@link isLoadingBenchmarkComparator} truthy.
   * 5. Fetch benchmark market data via
   *    `dataService.fetchBenchmarkForUser({ dataSource, range,
   *    startDate, symbol })`. The `range` and `startDate`
   *    parameters are required by the method signature; `range`
   *    comes from `user.settings.dateRange` and `startDate` comes
   *    from the captured {@link firstOrderDate} (or `new Date()`
   *    fallback for users with no order history).
   * 6. Map the returned `marketData` to `HistoricalDataItem[]` and
   *    publish via {@link benchmarkDataItems}.
   * 7. Set {@link isLoadingBenchmarkComparator} falsy.
   *
   * The local `dataSource: DataSource` annotation is used to honor
   * the file-schema's required `@prisma/client.DataSource` import.
   * The early-return guard above already narrows
   * `Partial<SymbolProfile>.dataSource` (typed
   * `DataSource | undefined`) so the call site can pass it directly;
   * the explicit type annotation is purely documentary.
   */
  private updateBenchmarkDataItems(): void {
    this.benchmarkDataItems.set([]);

    const benchmark = this.benchmark();
    const userSetting = this.user()?.settings?.benchmark;

    if (!userSetting || !benchmark?.dataSource || !benchmark?.symbol) {
      return;
    }

    this.isLoadingBenchmarkComparator.set(true);

    const dataSource: DataSource = benchmark.dataSource;

    this.dataService
      .fetchBenchmarkForUser({
        dataSource,
        range: this.user()?.settings?.dateRange,
        startDate: this.firstOrderDate ?? new Date(),
        symbol: benchmark.symbol
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ marketData }) => {
        this.benchmarkDataItems.set(
          marketData.map(({ date, value }) => ({ date, value }))
        );
        this.isLoadingBenchmarkComparator.set(false);
      });
  }
}

/**
 * Module descriptor for the Analysis module wrapper — the Rule 3
 * self-registration mechanism per AAP § 0.8.1.3.
 *
 * Imported into the module-registry bootstrap (typically an
 * `APP_INITIALIZER` factory or a side-effect import in the dashboard
 * canvas's `imports` chain) and registered via
 * `ModuleRegistryService.register(ANALYSIS_MODULE_DESCRIPTOR)`. The
 * registry is the single source of allowed grid-item component
 * types in the modular dashboard; the canvas
 * (`GfDashboardCanvasComponent`) resolves this descriptor by name
 * when hydrating a saved layout or processing a catalog `addModule`
 * event, then instantiates the descriptor's `component` reference
 * via `viewContainerRef.createComponent(...)`.
 *
 * Per Rule 6 (AAP § 0.8.1.6), `minCols` and `minRows` MUST be ≥ 2;
 * `defaultCols` MUST be ≥ `minCols` and `defaultRows` MUST be ≥
 * `minRows`. The values declared below — 6 × 4 minimum, 8 × 6
 * default — reflect the analysis content density: the 3-card row
 * + benchmark comparator + investment chart need at least 6 grid
 * columns to render the cards side-by-side without aggressive
 * truncation, and at least 4 rows to fit the chart canvases without
 * extreme vertical compression. The default 8 × 6 placement
 * provides a comfortable initial size for most users on the
 * 12-column grid.
 *
 * Field invariants (cross-checked against
 * {@link DashboardModuleDescriptor} contract):
 *
 * - `name: 'analysis'` — kebab-case stable identifier. Used as the
 *   discriminator in `LayoutItem.moduleId` of persisted layout
 *   documents. MUST NOT be renamed without a layout-document
 *   migration step (renaming breaks every saved layout that
 *   references it).
 * - `displayLabel: ANALYSIS_TITLE` — shares the same
 *   `$localize`-tagged constant with
 *   {@link GfAnalysisModuleComponent.title} so translations update
 *   both the catalog row and the module header consistently.
 * - `iconName: 'bar-chart-outline'` — Ionicons 8.x standard icon
 *   name; matches {@link GfAnalysisModuleComponent.iconName}.
 * - `minCols: 6`, `minRows: 4` — both ≥ 2 (Rule 6 satisfied).
 * - `defaultCols: 8 ≥ minCols: 6`, `defaultRows: 6 ≥ minRows: 4` —
 *   default placement size respects the engine-enforced minimums.
 *
 * Field order is alphabetical, matching
 * {@link DashboardModuleDescriptor} interface field ordering for
 * readability consistency.
 */
export const ANALYSIS_MODULE_DESCRIPTOR: DashboardModuleDescriptor = {
  component: GfAnalysisModuleComponent,
  defaultCols: 8,
  defaultRows: 6,
  displayLabel: ANALYSIS_TITLE,
  iconName: 'bar-chart-outline',
  minCols: 6,
  minRows: 4,
  name: 'analysis'
};
