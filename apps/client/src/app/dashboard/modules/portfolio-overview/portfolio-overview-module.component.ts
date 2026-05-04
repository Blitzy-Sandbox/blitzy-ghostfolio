import { GfHomeOverviewComponent } from '@ghostfolio/client/components/home-overview/home-overview.component';

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';

import { DashboardModuleDescriptor } from '../../interfaces/dashboard-module.interface';

// Module-scope i18n title constant.
//
// Declared at module scope (NOT as a class field with a default expression)
// so the value can be referenced by the
// {@link PORTFOLIO_OVERVIEW_MODULE_DESCRIPTOR.displayLabel} field below.
// The `$localize`-tagged constant is the single source of truth for the
// human-readable label that appears as the module catalog row title and
// (via the registry-mediated `resolveTitle(item.name)` helper on the
// canvas) as the module header title rendered by the canvas-owned outer
// `<gf-module-wrapper>`.
//
// Module-scope `$localize` template literals are statically extractable by
// the Angular i18n extractor (`ng extract-i18n`) — the same pattern used
// at `apps/client/src/app/components/chat-panel/chat-panel.component.ts:22`
// (`STREAM_ERROR_MESSAGE = $localize\`...\``) and at the sibling
// `apps/client/src/app/dashboard/modules/transactions/transactions-module.component.ts`
// (`TRANSACTIONS_TITLE = $localize\`Transactions\``).
//
// Module-scope `$localize` calls require the runtime to have evaluated
// `@angular/localize/init` BEFORE this file is imported. The production
// app bootstraps it via the `@angular/localize/init` import in
// `apps/client/src/main.ts`; the companion spec file imports it
// explicitly at the top of `portfolio-overview-module.component.spec.ts`,
// mirroring the `chat-panel.component.spec.ts:11` pattern.
const PORTFOLIO_OVERVIEW_TITLE = $localize`Portfolio Overview`;

/**
 * Portfolio Overview dashboard module wrapper.
 *
 * Wraps the existing `GfHomeOverviewComponent` (selector
 * `gf-home-overview`) from
 * `@ghostfolio/client/components/home-overview/home-overview.component`
 * as the inner content of a dashboard grid module. The CHROME (header,
 * drag handle, remove button, title icon, content slot) is provided by
 * the canvas-level outer `<gf-module-wrapper>` declared inside
 * `dashboard-canvas.component.html`; this component renders ONLY the
 * inner presentation content. Keeping the chrome at the canvas level
 * eliminates the double-wrapper DOM defect (QA Checkpoint 6 Issue #1)
 * that previously stacked two `<gf-module-wrapper>` instances per
 * grid cell, producing duplicated drag handles and titles.
 *
 * The wrapped `GfHomeOverviewComponent` is preserved UNCHANGED — it
 * declares no public inputs or outputs and self-loads portfolio
 * performance data via its internal `DataService` and `UserService`
 * dependencies. This wrapper has no service dependencies of its own
 * and performs no data fetching; it is pure orchestration glue. The
 * inner component handles its own RxJS subscriptions (piped through
 * `takeUntilDestroyed(destroyRef)` per AAP § 0.1.2), so destroying
 * this wrapper auto-disposes the inner subscriptions through Angular's
 * component-tree teardown — no manual cleanup is needed in the wrapper.
 *
 * Per Rule 1 (AAP § 0.8.1.1), this component MUST NOT import from
 * the dashboard-canvas, module-catalog, sibling modules, or
 * services subfolders. The only allowed dashboard imports are
 * the `interfaces` type definitions (`DashboardModuleDescriptor`).
 * The external imports are limited to `@angular/common`, `@angular/core`,
 * and the wrapped `GfHomeOverviewComponent` from
 * `@ghostfolio/client/components/...` — all of which are preserved
 * unchanged per the AAP boundaries section.
 *
 * Per Rule 2 (AAP § 0.8.1.2), this component MUST NOT declare
 * layout-coordinate inputs/outputs (`x`, `y`, `cols`, `rows`). The
 * wrapper does NOT inject `ElementRef`, NOT bind any `style.width` /
 * `style.height` / `style.transform` / `style.position` properties on
 * the host, and NOT mutate the gridster `dashboard` array directly.
 * Position and size are owned by gridster on the canvas; the wrapper
 * fills the cell its parent `<gridster-item>` allocates via the
 * `:host { display: block; height: 100% }` rule in the sibling SCSS
 * file.
 *
 * Per Rule 4 (AAP § 0.8.1.4), this component MUST NOT inject
 * `UserDashboardLayoutService` or `LayoutPersistenceService` — layout
 * persistence is triggered exclusively by grid state-change events
 * subscribed at the canvas level. The wrapper has no public outputs
 * because the canvas-level outer wrapper exposes the remove control;
 * the canvas listens to the canvas-level `<gf-module-wrapper>`
 * `(remove)` output via `(remove)="removeItem(item)"` per-item.
 *
 * Reference: AAP § 0.6.1.4 (Group 4 — Angular Dashboard Feature) is
 * the canonical specification for this contract; AAP § 0.7.4 governs
 * the `gf-portfolio-overview-module` selector convention; QA
 * Checkpoint 6 Issue #1 is the source of the wrapper-removal change.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, GfHomeOverviewComponent],
  selector: 'gf-portfolio-overview-module',
  styleUrls: ['./portfolio-overview-module.component.scss'],
  templateUrl: './portfolio-overview-module.component.html'
})
export class GfPortfolioOverviewModuleComponent {}

/**
 * Module descriptor for the Portfolio Overview module wrapper — the
 * Rule 3 self-registration mechanism per AAP § 0.8.1.3.
 *
 * Imported into the module-registry bootstrap (typically an
 * `APP_INITIALIZER` factory or a side-effect import in the dashboard
 * canvas's `imports` chain) and registered via
 * `ModuleRegistryService.register(PORTFOLIO_OVERVIEW_MODULE_DESCRIPTOR)`.
 * The registry is the single source of allowed grid-item component
 * types in the modular dashboard; the canvas
 * (`GfDashboardCanvasComponent`) resolves this descriptor by name when
 * hydrating a saved layout or processing a catalog `addModule` event,
 * then instantiates the descriptor's `component` reference via
 * `viewContainerRef.createComponent(...)`.
 *
 * Per Rule 6 (AAP § 0.8.1.6), `minCols` and `minRows` MUST be ≥ 2;
 * `defaultCols` MUST be ≥ `minCols` and `defaultRows` MUST be ≥
 * `minRows`. The values declared below — 4 × 3 minimum, 6 × 4 default
 * — reflect the home-overview's content density: a meaningful
 * presentation of the line chart + portfolio-performance summary
 * requires at least 4 columns wide and 3 rows tall to display the
 * chart without aggressive aspect-ratio distortion (the inner
 * `.chart-container` honors a 16:9 aspect ratio); the default 6 × 4
 * placement provides a comfortable initial size for most users on the
 * 12-column grid.
 *
 * Field invariants (cross-checked against
 * {@link DashboardModuleDescriptor} contract):
 *
 * - `name: 'portfolio-overview'` — kebab-case stable identifier. Used
 *   as the discriminator in `LayoutItem.moduleId` of persisted layout
 *   documents. MUST NOT be renamed without a layout-document migration
 *   step (renaming breaks every saved layout that references it).
 * - `displayLabel: PORTFOLIO_OVERVIEW_TITLE` — the catalog row label
 *   and (via the canvas's `resolveTitle(item.name)` helper) the
 *   module header title rendered by the canvas-owned outer
 *   `<gf-module-wrapper>`. The single `$localize`-tagged constant is
 *   the single source of truth so translations update both surfaces
 *   consistently.
 * - `iconName: 'analytics-outline'` — Ionicons 8.x standard icon name.
 * - `minCols: 4`, `minRows: 3` — both ≥ 2 (Rule 6 satisfied).
 * - `defaultCols: 6 ≥ minCols: 4`, `defaultRows: 4 ≥ minRows: 3` —
 *   default placement size respects the engine-enforced minimums.
 *
 * Field order is alphabetical, matching
 * {@link DashboardModuleDescriptor} interface field ordering for
 * readability consistency (TypeScript does not require field order to
 * match, but the lint-style convention encourages it).
 */
export const PORTFOLIO_OVERVIEW_MODULE_DESCRIPTOR: DashboardModuleDescriptor = {
  component: GfPortfolioOverviewModuleComponent,
  defaultCols: 6,
  defaultRows: 4,
  displayLabel: PORTFOLIO_OVERVIEW_TITLE,
  iconName: 'analytics-outline',
  minCols: 4,
  minRows: 3,
  name: 'portfolio-overview'
};
