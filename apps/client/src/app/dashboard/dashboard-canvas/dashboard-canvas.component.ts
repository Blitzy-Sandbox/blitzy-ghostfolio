import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  Directive,
  inject,
  Input,
  NgZone,
  OnInit,
  signal,
  ViewContainerRef
} from '@angular/core';
import {
  outputToObservable,
  takeUntilDestroyed
} from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import {
  CompactType,
  Gridster,
  GridsterItem,
  GridType
} from 'angular-gridster2';
import type { GridsterConfig, GridsterItemConfig } from 'angular-gridster2';
import { catchError, of, Subject } from 'rxjs';

import { LayoutData, LayoutItem } from '../interfaces/layout-data.interface';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { ModuleRegistryService } from '../module-registry.service';
import { GfModuleWrapperComponent } from '../module-wrapper/module-wrapper.component';
import { DashboardTelemetryService } from '../services/dashboard-telemetry.service';
import { LayoutPersistenceService } from '../services/layout-persistence.service';
import { UserDashboardLayoutService } from '../services/user-dashboard-layout.service';

// =============================================================================
// Module-scope `$localize` constants (AAP § 0.1.2 — repository convention).
// =============================================================================
//
// Static i18n strings declared at module scope are statically extractable by
// the Angular i18n extractor (`ng extract-i18n`) — the same pattern used by
// the canonical `chat-panel.component.ts:22` (`STREAM_ERROR_MESSAGE = $localize`).
//
// Strings are declared at module scope (NOT as class fields with default
// expressions) because:
//   1. Module-scope `$localize` literals are statically extractable.
//   2. The strings are bound dynamically in the template via
//      `[attr.aria-label]="addModuleLabel"` — inline `i18n-aria-label="..."`
//      template attributes are incompatible with dynamic property bindings,
//      so a module-scope `$localize` constant is the canonical Angular i18n
//      pattern for such cases (see `module-wrapper.component.ts:35-38`).
//   3. Module-scope `$localize` calls require the runtime
//      `@angular/localize/init` import. The companion spec file is
//      responsible for that import; the production runtime brings it in via
//      `apps/client/src/main.ts` and the Angular i18n bootstrap pipeline.

/**
 * Localized aria-label and visible label fragment for the canvas FAB that
 * opens the module catalog dialog. Bound to the FAB via
 * `[attr.aria-label]="addModuleLabel"` and (optionally) projected as the
 * visible label of the extended Material FAB.
 *
 * The `:Aria label for the Add module FAB|...:` syntax declares an
 * extraction meaning + description per the Angular i18n extractor guide;
 * the trailing literal `Add module` is the source string.
 */
const ADD_MODULE_LABEL = $localize`:Aria label for the Add module FAB|Spoken label for the floating action button that opens the module catalog:Add module`;

/**
 * Snack-bar message displayed when `GET /api/v1/user/layout` fails (any
 * non-404 error). The 404 case is the documented first-visit signal and is
 * NOT an error condition (see {@link UserDashboardLayoutService.get} —
 * 404→null translation in the service); other failures (401, 403, 5xx,
 * network) bubble through `catchError` and surface this snack-bar.
 */
const COULD_NOT_LOAD_LABEL = $localize`:Snack-bar message when the layout failed to load|Shown when GET /api/v1/user/layout fails:Could not load your dashboard layout`;

/**
 * Action button label for the layout-error snack-bar. Clicking the action
 * dismisses the snack-bar; no recovery side-effect is performed because
 * the next user-driven grid event will trigger a fresh PATCH (per
 * `LayoutPersistenceService` semantics — the canvas does not auto-retry).
 */
const DISMISS_LABEL = $localize`:Snack-bar dismiss button label|Action button label on the layout-error snack-bar:Dismiss`;

// =============================================================================
// Local discriminated GridItem type.
// =============================================================================

/**
 * Local extension of angular-gridster2's `GridsterItemConfig` adding the
 * required `name` discriminator. The type is intentionally NOT exported —
 * grid item layout is the canvas's private concern (Rule 2,
 * AAP § 0.8.1.2). Callers outside this file see only the {@link LayoutData}
 * / {@link LayoutItem} contracts (the persisted shape) and never a raw
 * gridster item.
 *
 * **Why a local type rather than reusing `LayoutItem` directly?** The
 * persistence shape ({@link LayoutItem}) uses `moduleId` for the
 * discriminator (matches the API DTO field naming), whereas the gridster
 * engine's items conventionally use `name` (an arbitrary plain field —
 * `GridsterItemConfig` permits arbitrary `[propName: string]: any`
 * extensions). The canvas converts `moduleId` ↔ `name` at the persistence
 * boundary in {@link GfDashboardCanvasComponent.serializeLayout} and
 * {@link GfDashboardCanvasComponent.hydrateFromLayout}. The two-name
 * convention keeps the wire shape stable while letting the in-memory
 * representation align with gridster's idiomatic field naming.
 *
 * **Why `cols`, `rows`, `x`, `y` are explicitly required here?**
 * `GridsterItemConfig` declares all four fields as optional in v21.0.1
 * (since gridster supports auto-placement with missing coordinates); the
 * canvas's hydration and persistence flows require all four fields, so the
 * intersection narrows them to `number` (non-optional).
 *
 * **Why `minItemCols` / `minItemRows` are explicitly carried per-item?**
 * angular-gridster2 v21.0.1's `GridsterItemConfig` declares both fields
 * as optional `number | undefined`; the engine reads them via
 * `<gridster-item [minItemCols]="item.minItemCols">` bindings on the
 * template and falls back to the global floor on `GridsterConfig`
 * (`options.minItemCols`, `options.minItemRows`) when the per-item value
 * is missing. Per Rule 6 (AAP § 0.8.1.6), each module declares its own
 * minimum cell dimensions in its registry descriptor, and the canvas MUST
 * propagate those declarations into per-item bindings — otherwise the
 * gridster engine would only enforce the global 2 × 2 floor and a user
 * could shrink (e.g.) the Holdings module (descriptor `minCols: 4`,
 * `minRows: 4`) below its declared minimum. {@link addModule} and
 * {@link hydrateFromLayout} are the two entry points that produce
 * `GridItem` instances; both look up the descriptor via
 * {@link ModuleRegistryService.getByName} and project
 * `descriptor.minCols → minItemCols`, `descriptor.minRows → minItemRows`
 * onto the resulting `GridItem`. The fields are kept OPTIONAL in this
 * type so future entry points (e.g., a hypothetical "blank placeholder
 * item" used during async load) can omit them and inherit the global
 * floor — current production code always populates them.
 */
type GridItem = GridsterItemConfig & {
  cols: number;
  minItemCols?: number;
  minItemRows?: number;
  name: string;
  rows: number;
  x: number;
  y: number;
};

// =============================================================================
// Module-host directive (Rule 3 enforcement, AAP § 0.8.1.3).
// =============================================================================

/**
 * Structural directive that resolves a registered module by name (via
 * `ModuleRegistryService.getByName(name)`) and dynamically instantiates
 * its component class as a sibling of the directive's host element via
 * `ViewContainerRef.createComponent(...)`.
 *
 * **Rule 3 enforcement (AAP § 0.8.1.3)**: this directive is the SOLE
 * mechanism by which the canvas projects a module's component into a
 * `<gridster-item>`. There are NO hard-coded `switch (item.name) { case
 * 'chat': return ChatModule; }` lookups anywhere in `dashboard-canvas.component.ts`.
 * The registry holds `Type<unknown>` references; the directive defers
 * resolution to runtime, so the registry is the single source of allowed
 * grid-item component types. Adding a new module type is a matter of
 * registering its descriptor with `ModuleRegistryService.register(...)` —
 * no canvas code changes are needed.
 *
 * **Why a directive (not `<ng-container *ngComponentOutlet="...">`)?**
 * `*ngComponentOutlet` is a viable alternative but renders the resolved
 * component as the FIRST child of its host element, which subtly conflicts
 * with the wrapper's `<ng-content>` projection slot ordering. The custom
 * directive uses `ViewContainerRef.createComponent(...)` and renders the
 * component as a SIBLING of the directive's host element — a cleaner fit
 * for `<ng-content>` projection inside `<gf-module-wrapper>`. The
 * directive is also a more explicit Rule 3 enforcement point: the only
 * way for a component to land in the canvas is via this directive's
 * registry-mediated resolution.
 *
 * **Defensive `undefined` handling**: if the registry returns `undefined`
 * for the supplied name, the directive renders nothing (it does NOT throw,
 * does NOT log, does NOT instantiate any fallback). This is a
 * belt-and-suspenders guard — the canvas's `hydrateFromLayout` already
 * filters items with unregistered `moduleId` values out of the dashboard
 * before this directive sees them — but the defense protects against
 * future refactors that might bypass the filter (e.g., direct
 * `dashboard.set(...)` writes from an alternate code path).
 *
 * **Selector**: `[gfDashboardModuleHost]` — Angular conventional bracket
 * syntax for an attribute selector. The `gf-` prefix matches the Engineering
 * Constraint Selector Naming Convention (AAP § 0.7.4 + `apps/client/project.json`
 * line 6 `"prefix": "gf"`).
 *
 * **Lifecycle**: `ngOnInit` performs the registry lookup once. The directive
 * does NOT subscribe to registry-change observables — the registry is
 * append-only at bootstrap, never mutated at runtime, so a one-time
 * resolution is correct.
 *
 * @see ../module-registry.service.ts — `ModuleRegistryService.getByName`.
 * @see ../interfaces/dashboard-module.interface.ts — `DashboardModuleDescriptor`.
 * @see AAP § 0.8.1.3 — Rule 3 (registry is the sole mechanism for
 *   introducing module types into the canvas).
 */
@Directive({
  selector: '[gfDashboardModuleHost]',
  standalone: true
})
export class GfDashboardModuleHostDirective implements OnInit {
  /**
   * Module name to resolve via the registry. Required input — the directive
   * makes no sense without a target name. The directive's selector matches
   * the template binding `[gfDashboardModuleHost]="item.name"`, so the
   * input's name matches the selector exactly (Angular conventions for
   * attribute-selector directives).
   */
  @Input({ required: true }) public gfDashboardModuleHost!: string;

  /**
   * Synchronous handle on the SINGLE source of allowed module types
   * (Rule 3, AAP § 0.8.1.3). Acquired via the modern Angular 21
   * `inject()` factory rather than constructor injection to match the
   * repository convention established by sibling dashboard files
   * (`module-catalog.component.ts:232`, `layout-persistence.service.ts:192`).
   */
  private readonly moduleRegistry = inject(ModuleRegistryService);

  /**
   * Host's view container — the slot into which the resolved module
   * component is dynamically instantiated. Angular auto-provides the
   * directive's own `ViewContainerRef` via DI; the directive renders
   * the component as a sibling of its host element, NOT as a child.
   */
  private readonly viewContainerRef = inject(ViewContainerRef);

  /**
   * Resolves the descriptor for {@link gfDashboardModuleHost} via the
   * registry and instantiates `descriptor.component` once on directive
   * initialization. The created component is a sibling of the directive's
   * host element (per `ViewContainerRef.createComponent` semantics).
   *
   * **Defensive null-check**: if the registry has no descriptor for the
   * supplied name, the directive renders nothing rather than throwing.
   * This is a belt-and-suspenders guard — `hydrateFromLayout` already
   * filters unregistered items out of `dashboard()` before the directive
   * is ever instantiated.
   *
   * **Idempotency**: the call to `viewContainerRef.clear()` before
   * `createComponent(...)` defends against a hypothetical re-init scenario
   * (Angular's lifecycle does not normally re-invoke `ngOnInit`, but
   * `viewContainerRef.clear()` makes the directive safe-by-construction
   * against future framework changes that might).
   */
  public ngOnInit(): void {
    const descriptor = this.moduleRegistry.getByName(
      this.gfDashboardModuleHost
    );

    if (!descriptor) {
      // Defensive: registry rejected this name. Render nothing rather
      // than throwing — `hydrateFromLayout` already filters such items
      // out of `dashboard()` before this directive runs.
      return;
    }

    this.viewContainerRef.clear();
    this.viewContainerRef.createComponent(descriptor.component);
  }
}

// =============================================================================
// Dashboard canvas component (the central orchestrator).
// =============================================================================

/**
 * Dashboard canvas — the central orchestrator component of the modular
 * dashboard refactor (AAP § 0.6.1.4). Rendered as the body of the single
 * application root route (`path: ''`), the canvas:
 *
 * 1. Embeds an `angular-gridster2` v21.0.1 grid engine configured for
 *    a 12-column, 64-px fixed-row-height grid with a global 2 × 2 minimum
 *    module size (per the AAP § 0.6.1 spec and Rule 6).
 * 2. On `ngOnInit`, calls `UserDashboardLayoutService.get()` to load the
 *    persisted layout. On HTTP 404 (translated to `null` by the service),
 *    renders a blank canvas AND auto-opens the module catalog dialog (Rule
 *    10, AAP § 0.8.1.10). On 200 with non-empty `items`, hydrates the
 *    gridster `dashboard()` signal from the persisted items (skipping any
 *    item whose `moduleId` is not registered).
 * 3. Routes drag-stop, resize-stop, add, and remove events into a
 *    `Subject<void>` and feeds it to `LayoutPersistenceService` for
 *    debounced (500 ms) persistence (Rule 4, AAP § 0.8.1.4). The canvas
 *    NEVER calls `userDashboardLayoutService.update(...)` directly —
 *    persistence is exclusively orchestrated by `LayoutPersistenceService`.
 * 4. Resolves module components EXCLUSIVELY via the
 *    {@link GfDashboardModuleHostDirective}, which delegates to
 *    `ModuleRegistryService.getByName(name)` (Rule 3, AAP § 0.8.1.3). There
 *    are NO hard-coded `case 'chat': return ChatModule` switch lookups
 *    anywhere in this file.
 * 5. Owns ALL grid layout state (positions, sizes, item lifecycle) via the
 *    `dashboard()` signal (Rule 2, AAP § 0.8.1.2). Module wrapper
 *    components MUST NOT (and DO NOT) hold layout coordinates.
 *
 * **Selector**: `gf-dashboard-canvas` — `gf-` prefix per Engineering
 * Constraint Selector Naming Convention (AAP § 0.7.4 + `apps/client/project.json`
 * line 6).
 *
 * **Change detection**: `OnPush`. State is exposed via signals
 * (`dashboard`, `hasError`, `isLoading`) so signal updates automatically
 * mark the view dirty without manual `markForCheck` calls. Per the
 * repository convention established by `chat-panel.component.ts:39`,
 * OnPush + signals is the canonical Angular 21 pattern.
 *
 * **Standalone**: `true` (Angular 21 default; the explicit declaration is
 * optional but the codebase uses explicit `standalone: true` for clarity
 * per the chat-panel pattern). The canvas's `imports: [...]` array
 * intentionally OMITS every module-wrapper component (analysis, chat,
 * holdings, portfolio-overview, transactions). Per Rule 3 (AAP § 0.8.1.3),
 * the canvas MUST NOT contain hard-coded `import { GfHoldingsModuleComponent }`
 * statements; the registry indirection is the SOLE mechanism by which
 * module-wrapper classes participate in the canvas. Module wrappers are
 * imported and registered exclusively in `dashboard.providers.ts` (the
 * `provideAppInitializer(...)` factory that calls
 * `moduleRegistry.register(HOLDINGS_MODULE_DESCRIPTOR)` etc. at
 * application bootstrap), making the registration site the SINGLE place
 * the wrapper classes are referenced by name. The
 * registry-mediated `viewContainerRef.createComponent(descriptor.component)`
 * inside {@link GfDashboardModuleHostDirective} works without any compile-
 * time import of the resolved class because Angular standalone components
 * are dynamically instantiable as long as the class symbol is reachable
 * via at least one import in the application's bootstrap graph
 * (`dashboard.providers.ts` provides that reachability).
 *
 * **Zone integration**: angular-gridster2 v21 internally invokes
 * `NgZone.run` / `NgZone.runOutsideAngular` for its drag/resize math (per
 * the v21 release notes). The host application uses
 * `provideZoneChangeDetection()` (`apps/client/src/main.ts:87`), so
 * gridster's zone integration works automatically and satisfies the
 * < 100 ms drag/resize SLO from AAP § 0.6.3.3 without explicit
 * `ngZone.runOutsideAngular(...)` wrapping in this file. The canvas's
 * own `itemChangeCallback` / `itemResizeCallback` handlers
 * ({@link onItemChange}, {@link onItemResize}) wrap their bodies in
 * `ngZone.run(...)` as forward-compatible defense-in-depth: a
 * hypothetical future gridster regression that invokes the callback
 * OUTSIDE the zone would otherwise cause signal updates and the
 * persistence Subject emission inside the callbacks to skip change
 * detection — with the wrapper, the < 100 ms SLO is preserved
 * regardless. See the {@link ngZone} field JSDoc for the full
 * defense-in-depth rationale.
 *
 * **Rule compliance summary**:
 *   - **Rule 2** (Single source of truth, AAP § 0.8.1.2): the canvas owns
 *     `dashboard()`. Module wrappers do NOT receive `x`, `y`, `cols`,
 *     `rows` as inputs.
 *   - **Rule 3** (Registry sole mechanism, AAP § 0.8.1.3): module
 *     resolution is exclusively via `ModuleRegistryService.getByName`
 *     inside {@link GfDashboardModuleHostDirective} and {@link addModule}.
 *   - **Rule 4** (Persistence triggered ONLY by grid events, AAP § 0.8.1.4):
 *     `gridStateChange$.next()` is the SOLE side-effect that drives
 *     persistence; the canvas never invokes
 *     `userDashboardLayoutService.update(...)` directly.
 *   - **Rule 6** (Module min cell dimensions, AAP § 0.8.1.6): per-item
 *     minimums come from `descriptor.minCols / minRows`; gridster's
 *     global `minItemCols: 2`, `minItemRows: 2` is the floor.
 *   - **Rule 10** (Catalog auto-open on first visit, AAP § 0.8.1.10):
 *     {@link hydrateFromLayout} calls {@link openCatalog} when the layout
 *     is null OR has empty `items`.
 *
 * @see ../module-registry.service.ts — `ModuleRegistryService` (Rule 3).
 * @see ../services/user-dashboard-layout.service.ts — HTTP wrapper.
 * @see ../services/layout-persistence.service.ts — debounced persistence.
 * @see ../services/dashboard-telemetry.service.ts — < 100 ms SLO telemetry.
 * @see ../module-catalog/module-catalog.component.ts — catalog dialog.
 * @see ../module-wrapper/module-wrapper.component.ts — chrome wrapper.
 * @see AAP § 0.6.1.4 — Group 4 file contract (canvas + sibling files).
 * @see AAP § 0.6.2.2 — Frontend Approach (Registry → Layout Service →
 *   Canvas → Modules → Catalog implementation order).
 * @see AAP § 0.6.3 — User Interface Design (canvas chrome layout).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    // Per Rule 3 (AAP § 0.8.1.3), the five module-wrapper components
    // (GfAnalysisModuleComponent, GfChatModuleComponent,
    // GfHoldingsModuleComponent, GfPortfolioOverviewModuleComponent,
    // GfTransactionsModuleComponent) are intentionally OMITTED from
    // this list. Module-wrapper classes are imported and registered
    // exclusively in `dashboard.providers.ts` via the
    // `provideAppInitializer(...)` factory; that file is the SINGLE
    // place the wrapper classes are referenced by name. The
    // registry-mediated dynamic instantiation in
    // `GfDashboardModuleHostDirective` resolves the descriptor at
    // runtime — no compile-time import of the resolved class is needed.
    CommonModule,
    GfDashboardModuleHostDirective,
    GfModuleCatalogComponent,
    GfModuleWrapperComponent,
    Gridster,
    GridsterItem,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatProgressBarModule,
    MatSnackBarModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-dashboard-canvas',
  standalone: true,
  styleUrls: ['./dashboard-canvas.component.scss'],
  templateUrl: './dashboard-canvas.component.html'
})
export class GfDashboardCanvasComponent implements OnInit, AfterViewInit {
  /**
   * Authoritative grid state — the gridster engine binds directly to the
   * underlying array via `<gridster-item [item]="item">` per row, so
   * mutations to the signal must produce a NEW array reference (use
   * `.set(...)` or `.update((items) => [...])`, NEVER `.push(...)`).
   *
   * **Rule 2 (Single source of truth, AAP § 0.8.1.2)**: this signal is
   * the SOLE owner of grid item positions and sizes. Module wrapper
   * components do NOT receive `x`, `y`, `cols`, `rows` as inputs; they
   * read NOTHING from this signal (the wrapper's `[gfDashboardModuleHost]`
   * directive instantiates the wrapped component but does not project
   * layout coordinates into it).
   *
   * The `GridItem` extension type adds the `name` discriminator that the
   * directive uses to resolve the registered descriptor.
   */
  public readonly dashboard = signal<GridItem[]>([]);

  /**
   * Surfaces the layout-fetch error state to the template. When `true`,
   * the template renders the M3 `error-container` banner (per the
   * `.gf-canvas-error` SCSS rule) AND prevents `hydrateFromLayout` from
   * running for the current emission. The flag is set by the
   * `catchError` handler in {@link ngOnInit}; it is NEVER cleared
   * (a returning user who experiences a transient failure must reload
   * the page to retry — auto-recovery would mask genuine outages).
   */
  public readonly hasError = signal<boolean>(false);

  /**
   * Loading flag for the indeterminate `MatProgressBar` rendered at the
   * top of the canvas during the initial GET. Cleared in
   * {@link hydrateFromLayout} (success path) and in the `catchError`
   * handler in {@link ngOnInit} (error path). The flag is initially
   * `true` — the canvas paints with the progress bar visible immediately
   * on mount, before the GET resolves.
   */
  public readonly isLoading = signal<boolean>(true);

  /**
   * Localized aria-label for the canvas FAB that opens the catalog
   * dialog. Bound in the template via
   * `[attr.aria-label]="addModuleLabel"` on the `<button mat-fab>` —
   * inline `i18n-aria-label="..."` template attributes are incompatible
   * with dynamic property bindings, so a module-scope `$localize`
   * constant is the canonical pattern (mirrors
   * `module-wrapper.component.ts:35-38`).
   *
   * Exposed as a public field (NOT a getter) so the template binding
   * resolves cleanly without invoking a function on every change-
   * detection cycle.
   */
  public readonly addModuleLabel = ADD_MODULE_LABEL;

  /**
   * Frozen `GridsterConfig` literal — the engine's configuration. The
   * literal is immutable (`readonly`) because gridster v21 removed the
   * legacy `gridster.api.optionsChanged()` mutation API in favor of
   * "set a new object on input options when there is a change" (per the
   * v21 release notes). Since this canvas does not need to vary the
   * configuration at runtime, the readonly pattern is correct.
   *
   * **Configuration rationale** (AAP § 0.6.1, § 0.6.2.2):
   *
   * - `gridType: GridType.Fixed` + `fixedRowHeight: 64` realizes the
   *   spec's "12 columns, fixed row height (constant px)" requirement.
   *   Per AAP § 0.5.3.2 the row height is exactly 64 px.
   * - `fixedColWidth: 80` provides a stable visual unit for the
   *   12-column layout. Combined with `4`-px margins, the canvas
   *   occupies a predictable 12 × 80 + 13 × 4 ≈ 1012 px nominal width;
   *   gridster scales the cells to fit the actual viewport width.
   * - `minCols: 12`, `maxCols: 12` lock the column count to 12 (per
   *   the AAP § 0.6.1 grid spec).
   * - `minItemCols: 2`, `minItemRows: 2` enforce the global 2 × 2 floor
   *   (Rule 6, AAP § 0.8.1.6). Per-item `[minItemCols]` / `[minItemRows]`
   *   bindings on individual `<gridster-item>` elements override this
   *   floor when a registered descriptor declares a higher per-module
   *   minimum.
   * - `pushItems: true`, `swap: true` produce natural drag-rearrange
   *   behavior (AAP § 0.0 web-search research).
   * - `compactType: CompactType.None` disables auto-compaction so
   *   dragged items don't snap to the top of the grid; the user's spatial
   *   intent is preserved (AAP § 0.6.2.2).
   * - `displayGrid: 'always'` renders the cell-grid backdrop expected of
   *   dashboards (AAP § 0.0 web-search research).
   * - `draggable.dragHandleClass: 'gf-module-drag-handle'` — the wrapper's
   *   drag-handle button carries this CSS class (per
   *   `module-wrapper.component.html:6`). `ignoreContent: true` prevents
   *   drag from initiating on form fields, buttons, etc., inside the
   *   module body.
   * - `resizable.enabled: true` enables resize handles on each item.
   *   gridster styles the handles itself; the SCSS file applies
   *   `--mat-sys-outline` / `--mat-sys-primary-container` overrides via
   *   the `::ng-deep gridster-preview { ... }` rule.
   * - `itemChangeCallback` and `itemResizeCallback` are invoked by
   *   gridster at drag-stop and resize-stop boundaries; both feed the
   *   {@link gridStateChange$} stream. The arrow-function syntax captures
   *   `this` correctly (no manual `.bind(this)` needed).
   *
   * The `outerMargin*` properties produce a 4-px gutter around the
   * canvas perimeter so items don't touch the canvas edge — visually
   * cleaner than the default `0`.
   */
  public readonly options: GridsterConfig = {
    compactType: CompactType.None,
    defaultItemCols: 4,
    defaultItemRows: 4,
    displayGrid: 'always',
    draggable: {
      dragHandleClass: 'gf-module-drag-handle',
      enabled: true,
      ignoreContent: true
    },
    fixedColWidth: 80,
    fixedRowHeight: 64,
    gridType: GridType.Fixed,
    itemChangeCallback: () => this.onItemChange(),
    itemResizeCallback: () => this.onItemResize(),
    margin: 4,
    maxCols: 12,
    maxRows: 200,
    minCols: 12,
    minItemCols: 2,
    minItemRows: 2,
    minRows: 0,
    outerMarginBottom: 4,
    outerMarginLeft: 4,
    outerMarginRight: 4,
    outerMarginTop: 4,
    pushItems: true,
    resizable: { enabled: true },
    swap: true
  };

  /**
   * Component's `DestroyRef` — used to terminate RxJS subscriptions on
   * destroy via `takeUntilDestroyed(this.destroyRef)`. Acquired via
   * `inject()` rather than constructor parameter per the modern Angular
   * 21 idiom (matches the chat-panel pattern at
   * `chat-panel.component.ts:82`).
   *
   * Also passed to {@link LayoutPersistenceService.bind} as the
   * binding's destruction signal — when the canvas is destroyed, the
   * persistence service tears down its 500 ms debounce + switchMap
   * pipeline cleanly.
   */
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Material dialog service — used by {@link openCatalog} to programmatically
   * open the {@link GfModuleCatalogComponent} dialog. The catalog dialog is
   * the user's entry point for adding modules to the canvas; it auto-opens
   * on first visit (Rule 10, AAP § 0.8.1.10) and on FAB click.
   */
  private readonly matDialog = inject(MatDialog);

  /**
   * Material snack-bar service — used in the `catchError` branch of
   * {@link ngOnInit} to surface a transient failure toast when the
   * initial layout GET fails. The snack-bar's 4-second duration matches
   * Material 3 guidance for non-actionable failure notices.
   */
  private readonly matSnackBar = inject(MatSnackBar);

  /**
   * Centralized module registry — the SOLE source of allowed module
   * types per Rule 3 (AAP § 0.8.1.3). The canvas calls `getByName(...)`
   * in {@link addModule} (to resolve descriptor metadata for newly-added
   * items) and in {@link hydrateFromLayout} (to filter out persisted
   * items whose `moduleId` is no longer registered). The
   * {@link GfDashboardModuleHostDirective} also calls `getByName(...)`
   * in its own `ngOnInit` to instantiate the resolved component.
   */
  private readonly moduleRegistry = inject(ModuleRegistryService);

  /**
   * Angular `NgZone` — used by {@link onItemChange} and
   * {@link onItemResize} to wrap their telemetry-then-persistence
   * sequence in `ngZone.run(...)`.
   *
   * **Defense-in-depth rationale**: angular-gridster2 v21 currently
   * invokes its `itemChangeCallback` / `itemResizeCallback` INSIDE the
   * Angular zone (verified against
   * `node_modules/angular-gridster2/fesm2022/angular-gridster2.mjs`),
   * so the host's `provideZoneChangeDetection()` setup
   * (`apps/client/src/main.ts:87`) already triggers change detection
   * naturally — the explicit `ngZone.run(...)` wrapper is a no-op in
   * the current v21 line. The wrapper exists to guard against a
   * hypothetical future gridster regression that invokes the callback
   * OUTSIDE the zone (e.g., from a `NgZone.runOutsideAngular`-bracketed
   * RAF tick): without the wrapper, signal updates and the persistence
   * `Subject` emission inside the callbacks would NOT mark the view
   * dirty, and the < 100 ms drag/resize SLO from AAP § 0.6.3.3 could
   * be missed silently. The `ngZone.run(...)` wrapper documents the
   * canvas's zone-awareness intent (per the AAP § 0.6.3.3
   * "validate zone/zoneless interaction with angular-gridster2 v21's
   * NgZone calls" requirement) and is forward-compatible.
   */
  private readonly ngZone = inject(NgZone);

  /**
   * HTTP wrapper for `GET /api/v1/user/layout`. The canvas calls
   * {@link UserDashboardLayoutService.get} ONCE in {@link ngOnInit} for
   * the initial hydration. Per Rule 4 (AAP § 0.8.1.4), the canvas does
   * NOT call `update(...)` — that responsibility belongs exclusively to
   * {@link LayoutPersistenceService}. Static check during PR review:
   * `grep -n "userDashboardLayoutService.update" dashboard-canvas.component.ts`
   * MUST produce zero matches.
   */
  private readonly userDashboardLayoutService = inject(
    UserDashboardLayoutService
  );

  /**
   * Debounced persistence orchestrator — the SOLE caller of
   * `userDashboardLayoutService.update(...)` per Rule 4 (AAP § 0.8.1.4).
   * The canvas calls {@link LayoutPersistenceService.bind} ONCE in
   * {@link ngOnInit} to wire {@link gridStateChange$} through a 500 ms
   * `debounceTime` + `switchMap` pipeline that issues
   * `PATCH /api/v1/user/layout` with the latest serialized layout
   * snapshot. The canvas never calls the service's `update` method
   * directly.
   */
  private readonly layoutPersistenceService = inject(LayoutPersistenceService);

  /**
   * Lightweight client telemetry for measuring drag/resize visual
   * completion latency against the < 100 ms SLO (AAP § 0.6.3.3). The
   * canvas calls `measureChange()` in {@link onItemChange} and
   * `measureResize()` in {@link onItemResize} BEFORE triggering the
   * persistence pipeline.
   */
  private readonly dashboardTelemetryService = inject(
    DashboardTelemetryService
  );

  /**
   * Subject driving the persistence pipeline — emits `void` from
   * {@link addModule}, {@link removeItem}, {@link onItemChange}, and
   * {@link onItemResize}. The persistence service binds to this stream
   * via {@link LayoutPersistenceService.bind} and pipes the emissions
   * through the 500 ms debounce + switchMap flow.
   *
   * **Why `Subject<void>` (not `Subject<GridItem>`)?** The persistence
   * service does NOT need per-event item details — it always serializes
   * the FULL current dashboard via `layoutSelector()`. Using `void`
   * keeps the contract minimal and prevents accidental coupling between
   * the canvas's grid state model and the persistence shape.
   *
   * **Why a `Subject` (not `BehaviorSubject` or `ReplaySubject`)?** The
   * pipeline is purely event-driven: a state change triggers exactly
   * one downstream debounced PATCH. There is no replay semantic, no
   * "current value" semantic — the canvas's `dashboard()` signal
   * already serves as the authoritative state, and the persistence
   * service captures the snapshot via `layoutSelector()` AT save time.
   */
  private readonly gridStateChange$ = new Subject<void>();

  /**
   * On init:
   *
   * 1. Bind the persistence pipeline (FIRST, before the GET) so any
   *    subsequent grid events route through the persistence pipeline.
   *    The persistence service handles the 500 ms debounce internally;
   *    the canvas's only job is to expose `changes$` and a synchronous
   *    `layoutSelector` callback.
   * 2. Issue `GET /api/v1/user/layout`. On success, hand off to
   *    {@link hydrateFromLayout}. On 404 (translated to `null` by the
   *    service), {@link hydrateFromLayout} renders a blank canvas AND
   *    auto-opens the catalog (Rule 10, AAP § 0.8.1.10). On other
   *    errors, set {@link hasError} and surface a snack-bar.
   *
   * **Order matters**: `bind(...)` is called BEFORE the GET so that if
   * the user manages to trigger a grid event while the initial fetch
   * is in flight (e.g., a very fast user clicking the FAB before the
   * GET resolves), the persistence pipeline is already wired up.
   *
   * **Why catchError before takeUntilDestroyed?** The order matters
   * subtly: `catchError` must run BEFORE `takeUntilDestroyed` so that
   * the swallowed error (replaced by `of(null)`) propagates to the
   * subscriber. If the order were swapped, `takeUntilDestroyed`
   * wouldn't change the outcome (subscriptions are torn down on the
   * `complete` and `error` notifications regardless of position) but
   * the operator chain would be less idiomatic.
   *
   * **catchError → of(null)**: emits a fallback `null` after an error
   * so the subsequent subscribe block always receives a typed
   * `LayoutData | null` (no `error` callback needed). The `hasError()`
   * guard inside `subscribe` then prevents `hydrateFromLayout` from
   * running on the error path.
   */
  public ngOnInit(): void {
    this.layoutPersistenceService.bind(
      {
        changes$: this.gridStateChange$,
        layoutSelector: () => this.serializeLayout()
      },
      this.destroyRef
    );

    this.userDashboardLayoutService
      .get()
      .pipe(
        catchError(() => {
          this.hasError.set(true);
          this.isLoading.set(false);
          this.matSnackBar.open(COULD_NOT_LOAD_LABEL, DISMISS_LABEL, {
            duration: 4000
          });
          return of<LayoutData | null>(null);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((layout: LayoutData | null) => {
        if (this.hasError()) {
          // Error path already handled inside catchError. Don't run
          // hydration on the fallback `null` emission.
          return;
        }
        this.hydrateFromLayout(layout);
      });
  }

  /**
   * Reserved for future zone-related work. angular-gridster2 v21
   * internally invokes `NgZone.run` / `NgZone.runOutsideAngular` for
   * its drag math (per the v21 release notes), so the host's
   * `provideZoneChangeDetection()` setup
   * (`apps/client/src/main.ts:87`) is sufficient to satisfy the
   * < 100 ms drag/resize SLO from AAP § 0.6.3.3.
   *
   * No explicit `ngZone.runOutsideAngular(...)` wrapping is required
   * here because gridster owns its per-frame work. This lifecycle hook
   * is reserved for future viewport-relative `fixedColWidth`
   * recomputation if v2 ever needs it.
   */
  public ngAfterViewInit(): void {
    // Intentionally empty. Reserved for future viewport-relative
    // `fixedColWidth` recomputation. See class-level JSDoc and AAP
    // § 0.6.3.3 for rationale.
  }

  /**
   * Opens the {@link GfModuleCatalogComponent} dialog, subscribes to its
   * `addModule` output, and forwards each emission to {@link addModule}.
   * After a successful add, the dialog is closed (v1 simple flow — multi-
   * add is out of scope).
   *
   * **Why `outputToObservable()`?** Angular 17+ signal-based outputs
   * (`output<T>()`) return an `OutputRef<T>` that does NOT have a
   * `.pipe(...)` method directly. To compose with RxJS operators
   * (`takeUntilDestroyed`), the output must first be converted to an
   * Observable via `outputToObservable()` from `@angular/core/rxjs-interop`.
   * This is the canonical Angular 17+ idiom for output-to-RxJS interop.
   *
   * **Subscription cleanup**: `takeUntilDestroyed(this.destroyRef)`
   * tears down the subscription if the canvas itself is destroyed
   * before the dialog is closed. Material's `MatDialog` already
   * destroys the catalog component when the dialog closes (which
   * naturally terminates the underlying output emitter), but the
   * `takeUntilDestroyed` is a defense-in-depth that handles the rare
   * canvas-destroyed-while-dialog-open case.
   *
   * **Dialog config** (AAP § 0.5.2, § 0.5.3.2):
   *   - `width: '720px'` — Material 3 dialog `medium` size.
   *   - `maxHeight: '80vh'` — prevents the dialog from overflowing tall
   *     viewports while preserving the catalog list scrollability.
   *   - `autoFocus: 'first-tabbable'` — Material 3 default for modal
   *     accessibility (focus moves into the search input on open).
   */
  public openCatalog(): void {
    const ref = this.matDialog.open(GfModuleCatalogComponent, {
      autoFocus: 'first-tabbable',
      maxHeight: '80vh',
      width: '720px'
    });

    outputToObservable(ref.componentInstance.addModule)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((moduleId: string) => {
        this.addModule(moduleId);
        ref.close();
      });
  }

  /**
   * Adds a module to the canvas at the next available grid position.
   *
   * 1. Resolve the descriptor via the registry (Rule 3,
   *    AAP § 0.8.1.3). If the name is not registered, the call is a
   *    silent no-op (defensive — protects against stale catalog state
   *    or test mocks).
   * 2. Create a new {@link GridItem} at `x: 0, y: <next available row>`
   *    sized at the descriptor's `defaultCols` × `defaultRows`. The
   *    gridster engine's `pushItems: true` setting handles fine-grained
   *    collision resolution if `x: 0` would overlap an existing item.
   * 3. Project `descriptor.minCols → minItemCols` and
   *    `descriptor.minRows → minItemRows` onto the new item so the
   *    gridster engine enforces the per-module Rule 6 floor (AAP
   *    § 0.8.1.6) — without this, only the global 2 × 2 floor would
   *    apply and a user could shrink the new item below its declared
   *    minimum. The bindings are read by gridster via
   *    `<gridster-item [minItemCols]="item.minItemCols"
   *    [minItemRows]="item.minItemRows">` on the template.
   * 4. Update the `dashboard()` signal with a NEW array reference (per
   *    OnPush + signal semantics — `.update((items) => [...items, item])`,
   *    NEVER `.push(...)`).
   * 5. Emit on {@link gridStateChange$} to trigger the persistence
   *    pipeline (Rule 4, AAP § 0.8.1.4).
   *
   * **Public API**: this method is the canvas's only programmatic way
   * to add a module. Callers (the catalog dialog via
   * {@link openCatalog}) emit the descriptor name; the canvas
   * resolves and inserts.
   */
  public addModule(name: string): void {
    const descriptor = this.moduleRegistry.getByName(name);

    if (!descriptor) {
      // Unknown module name — silent no-op. Defensive: the catalog
      // emits names sourced from the SAME registry, so this path is
      // unreachable in practice, but stale test fixtures or a
      // hypothetical future "deep-link to add module by URL" feature
      // could trigger it.
      return;
    }

    // Project descriptor minimums onto the per-item gridster fields so
    // the engine rejects user-initiated resize/move operations that
    // would shrink THIS item below the declared per-module floor.
    // Without these projections, only the global `options.minItemCols
    // = 2`, `options.minItemRows = 2` floor would apply and (e.g.) the
    // Holdings module (descriptor `minCols: 4`, `minRows: 4`) could be
    // resized to 2 × 2 — a Rule 6 violation per AAP § 0.8.1.6.
    const newItem: GridItem = {
      cols: descriptor.defaultCols,
      minItemCols: descriptor.minCols,
      minItemRows: descriptor.minRows,
      name: descriptor.name,
      rows: descriptor.defaultRows,
      x: 0,
      y: this.computeNextAvailableY()
    };

    // Use `.update((items) => [...items, newItem])` to create a NEW
    // array reference for OnPush change detection — `.push(...)` would
    // mutate in place and skip change detection.
    this.dashboard.update((items) => [...items, newItem]);
    this.gridStateChange$.next();
  }

  /**
   * Removes a module from the canvas. The wrapper's `(remove)` output
   * passes the exact item reference back, so reference-equality
   * filtering is sufficient (no need to match by `name` or coordinates).
   *
   * Triggers persistence (Rule 4, AAP § 0.8.1.4).
   */
  public removeItem(item: GridItem): void {
    this.dashboard.update((items) =>
      items.filter((existing) => existing !== item)
    );
    this.gridStateChange$.next();
  }

  /**
   * Hydrates the canvas from a persisted layout document (or renders
   * blank + auto-opens catalog on null/empty input — Rule 10,
   * AAP § 0.8.1.10).
   *
   * **Path A — null / empty layout** (first visit OR genuinely empty
   * saved state): set `dashboard()` to `[]` and call {@link openCatalog}.
   * The combined check `!layout || !layout.items || layout.items.length === 0`
   * covers all three null/empty paths:
   *   - HTTP 404 → service emits `null`.
   *   - HTTP 200 with `{ items: [] }` (genuinely empty saved layout).
   *   - Defensive: `{ items: undefined }` (theoretical malformed
   *     payload — server-side DTO validation prevents this in practice,
   *     but the guard is cheap insurance).
   *
   * **Path B — non-empty saved layout** (returning user): map
   * {@link LayoutItem} entries → {@link GridItem} entries (rename
   * `moduleId` → `name`), skip items whose `moduleId` is not
   * registered (defensive — protects against stale layouts referencing
   * removed module types), and project the resolved descriptor's
   * `minCols` / `minRows` onto each `GridItem` as `minItemCols` /
   * `minItemRows` so the gridster engine enforces the per-module
   * Rule 6 floor (AAP § 0.8.1.6) on resize/move attempts.
   *
   * **Why filter unregistered items?** A `LayoutItem` with an unknown
   * `moduleId` would cause {@link GfDashboardModuleHostDirective} to
   * render nothing (its defensive null-check), leaving an empty
   * `<gridster-item>` slot on the canvas. Filtering at hydration time
   * is cleaner — the slot doesn't appear at all rather than rendering
   * a phantom empty cell. We use a single `flatMap` rather than
   * `filter` + `map` so each `LayoutItem` is resolved through the
   * registry exactly once (versus the previous two-pass `filter` then
   * `map` which would call `getByName` twice per surviving item).
   *
   * Always clears {@link isLoading} regardless of path (the GET has
   * resolved either way; the progress bar disappears).
   */
  private hydrateFromLayout(layout: LayoutData | null): void {
    this.isLoading.set(false);

    if (!layout?.items?.length) {
      // Path A — first visit or empty saved layout. The optional-
      // chain expression collapses three equivalent guards into one:
      //   - `layout` is null/undefined (HTTP 404 translated by the
      //     UserDashboardLayoutService to `null`)
      //   - `layout.items` is null/undefined (defensive against
      //     malformed payloads)
      //   - `layout.items.length === 0` (genuinely empty saved
      //     layout — e.g., user removed every module)
      // All three paths render blank and auto-open the catalog per
      // Rule 10 (AAP § 0.8.1.10).
      this.dashboard.set([]);
      this.openCatalog();
      return;
    }

    // Path B — non-empty saved layout. For each persisted LayoutItem,
    // resolve its descriptor through the registry: missing descriptors
    // (stale layouts referencing removed modules) yield an empty array
    // and are dropped by `flatMap`; resolved descriptors yield a
    // single-element array containing the projected GridItem with
    // per-module `minItemCols` / `minItemRows` populated from
    // `descriptor.minCols` / `descriptor.minRows` so gridster enforces
    // the per-module Rule 6 floor (AAP § 0.8.1.6).
    const items: GridItem[] = layout.items.flatMap<GridItem>((item) => {
      const descriptor = this.moduleRegistry.getByName(item.moduleId);

      if (!descriptor) {
        // Stale layout — module no longer registered. Drop the item
        // rather than render an empty `<gridster-item>` slot.
        return [];
      }

      return [
        {
          cols: item.cols,
          minItemCols: descriptor.minCols,
          minItemRows: descriptor.minRows,
          name: item.moduleId,
          rows: item.rows,
          x: item.x,
          y: item.y
        }
      ];
    });

    this.dashboard.set(items);
  }

  /**
   * Drag-stop callback invoked by gridster at the end of a drag
   * gesture. Records SLO telemetry against the < 100 ms target
   * (AAP § 0.6.3.3) BEFORE triggering the persistence pipeline (Rule 4,
   * AAP § 0.8.1.4).
   *
   * **NgZone defense-in-depth**: angular-gridster2 v21 currently invokes
   * `itemChangeCallback` INSIDE the Angular zone (after gridster's own
   * `zone.run(() => updateGrid())` re-entry — verified against
   * `node_modules/angular-gridster2/fesm2022/angular-gridster2.mjs`).
   * Wrapping the body in `ngZone.run(...)` is a no-op in current v21
   * but provides forward-compatible defense against a hypothetical
   * future gridster regression that invokes the callback OUTSIDE the
   * zone — without the wrapper, signal updates and the persistence
   * Subject emission would NOT trigger change detection, and the < 100 ms
   * SLO from AAP § 0.6.3.3 could be missed silently. The wrapper
   * documents the canvas's zone-awareness intent (per the AAP § 0.6.3.3
   * "validate zone/zoneless interaction with angular-gridster2 v21's
   * NgZone calls" requirement).
   *
   * The `item` argument (gridster's view of the moved item) is
   * intentionally NOT received here — v1 telemetry is dimension-
   * agnostic, and the persistence pipeline always serializes the
   * FULL dashboard via {@link serializeLayout}. If future enhancements
   * need item-specific telemetry dimensions, the gridster
   * `itemChangeCallback` can pass `(item) => this.onItemChange(item)`
   * and this method's signature can be widened — without changing
   * the gridster API surface.
   */
  private onItemChange(): void {
    this.ngZone.run(() => {
      this.dashboardTelemetryService.measureChange();
      this.gridStateChange$.next();
    });
  }

  /**
   * Resize-stop callback invoked by gridster at the end of a resize
   * gesture. Behavior identical to {@link onItemChange} — telemetry
   * THEN persistence event. Distinct method so future RUM telemetry
   * can differentiate drag latency from resize latency without
   * conflating the two.
   *
   * The `ngZone.run(...)` wrapping mirrors {@link onItemChange} — see
   * that method's JSDoc for the defense-in-depth rationale.
   */
  private onItemResize(): void {
    this.ngZone.run(() => {
      this.dashboardTelemetryService.measureResize();
      this.gridStateChange$.next();
    });
  }

  /**
   * Projects the in-memory `dashboard()` array to the {@link LayoutData}
   * wire shape for persistence. Called by
   * {@link LayoutPersistenceService} inside the `switchMap` callback
   * AFTER the 500 ms debounce window has elapsed (per the persistence
   * service's contract — `layoutSelector` is invoked at save time, not
   * at bind time).
   *
   * Maps `GridItem.name` → `LayoutItem.moduleId` (the discriminator
   * rename ensures the persisted shape matches the API DTO field
   * naming). Returns a fresh object on every call — the persistence
   * service must NOT mutate the result.
   *
   * `version: 1` is the schema version (a literal type in the
   * {@link LayoutData} interface — when the schema evolves, bumping
   * this value to `2` will produce compile-time errors at every
   * consumer that hardcoded `version: 1`, forcing a deliberate
   * migration).
   */
  private serializeLayout(): LayoutData {
    return {
      items: this.dashboard().map<LayoutItem>((item) => ({
        cols: item.cols,
        moduleId: item.name,
        rows: item.rows,
        x: item.x,
        y: item.y
      })),
      version: 1
    };
  }

  /**
   * Computes the next available `y` coordinate for a newly-added item.
   * Returns `0` when the dashboard is empty; otherwise returns the
   * maximum (`y + rows`) across all existing items — i.e., the row
   * immediately below the bottom-most item.
   *
   * **Why not use gridster's `getNextPossiblePosition`?** gridster v21
   * exposes `getNextPossiblePosition` on its API surface, but invoking
   * it requires a reference to the gridster component instance, which
   * the canvas doesn't hold (the engine binds via `[options]` not via
   * an `@ViewChild` reference). A simple "place at the bottom"
   * heuristic is sufficient because gridster's `pushItems: true`
   * setting handles fine-grained collision resolution if the heuristic
   * picks an overlapping cell.
   *
   * The method is private and stateless — pure function of
   * `dashboard()`.
   */
  private computeNextAvailableY(): number {
    const items = this.dashboard();

    if (items.length === 0) {
      return 0;
    }

    return items.reduce((max, item) => Math.max(max, item.y + item.rows), 0);
  }
}
