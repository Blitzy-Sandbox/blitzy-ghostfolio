import { GfHomeHoldingsComponent } from '@ghostfolio/client/components/home-holdings/home-holdings.component';

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';

import { DashboardModuleDescriptor } from '../../interfaces/dashboard-module.interface';

// Module-scope i18n title constant.
//
// Declared at module scope (NOT as a class field with a default expression)
// so the value can be referenced by the
// {@link HOLDINGS_MODULE_DESCRIPTOR.displayLabel} field below. The
// `$localize`-tagged constant is the single source of truth for the
// human-readable label that appears as the module catalog row title and
// (via the registry-mediated `resolveTitle(item.name)` helper on the
// canvas) as the module header title rendered by the canvas-owned outer
// `<gf-module-wrapper>`.
//
// Module-scope `$localize` template literals are statically extractable by
// the Angular i18n extractor (`ng extract-i18n`) — the same pattern used
// at `apps/client/src/app/components/chat-panel/chat-panel.component.ts:22`
// (`STREAM_ERROR_MESSAGE = $localize\`...\``) and at the sibling
// `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview-module.component.ts`
// (`PORTFOLIO_OVERVIEW_TITLE = $localize\`Portfolio Overview\``).
//
// Module-scope `$localize` calls require the runtime to have evaluated
// `@angular/localize/init` BEFORE this file is imported. The production
// app bootstraps it via the `@angular/localize/init` import in
// `apps/client/src/main.ts`; the companion spec file imports it
// explicitly at the top of `holdings-module.component.spec.ts`,
// mirroring the `chat-panel.component.spec.ts:11` pattern.
const HOLDINGS_TITLE = $localize`Holdings`;

/**
 * Holdings dashboard module wrapper.
 *
 * Wraps the existing `GfHomeHoldingsComponent` (selector
 * `gf-home-holdings`) from
 * `@ghostfolio/client/components/home-holdings/home-holdings.component`
 * as the inner content of a dashboard grid module. The CHROME (header,
 * drag handle, remove button, title icon, content slot) is provided by
 * the canvas-level outer `<gf-module-wrapper>` declared inside
 * `dashboard-canvas.component.html`; this component renders ONLY the
 * inner presentation content. Keeping the chrome at the canvas level
 * eliminates the double-wrapper DOM defect (QA Checkpoint 6 Issue #1)
 * that previously stacked two `<gf-module-wrapper>` instances per
 * grid cell, producing duplicated drag handles and titles.
 *
 * The wrapped `GfHomeHoldingsComponent` is preserved UNCHANGED — it
 * declares no public inputs or outputs and self-loads holdings data
 * via its internal `DataService`, `UserService`,
 * `ImpersonationStorageService`, `Router`, and `DeviceDetectorService`
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
 * and the wrapped `GfHomeHoldingsComponent` from
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
 * the `gf-holdings-module` selector convention; QA Checkpoint 6
 * Issue #1 is the source of the wrapper-removal change.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, GfHomeHoldingsComponent],
  selector: 'gf-holdings-module',
  styleUrls: ['./holdings-module.component.scss'],
  templateUrl: './holdings-module.component.html'
})
export class GfHoldingsModuleComponent {}

/**
 * Module descriptor for the Holdings module wrapper — the Rule 3
 * self-registration mechanism per AAP § 0.8.1.3.
 *
 * Imported into the module-registry bootstrap (typically an
 * `APP_INITIALIZER` factory or a side-effect import in the dashboard
 * canvas's `imports` chain) and registered via
 * `ModuleRegistryService.register(HOLDINGS_MODULE_DESCRIPTOR)`. The
 * registry is the single source of allowed grid-item component types
 * in the modular dashboard; the canvas (`GfDashboardCanvasComponent`)
 * resolves this descriptor by name when hydrating a saved layout or
 * processing a catalog `addModule` event, then instantiates the
 * descriptor's `component` reference via
 * `viewContainerRef.createComponent(...)`.
 *
 * Per Rule 6 (AAP § 0.8.1.6), `minCols` and `minRows` MUST be ≥ 2;
 * `defaultCols` MUST be ≥ `minCols` and `defaultRows` MUST be ≥
 * `minRows`. The values declared below — 4 × 4 minimum, 6 × 6 default
 * — reflect the home-holdings's content density: a meaningful
 * presentation of the treemap chart + holdings table requires at least
 * 4 columns wide and 4 rows tall to display the chart legend and a few
 * rows of the table without aggressive truncation; the default 6 × 6
 * provides a comfortable initial size that respects the treemap's
 * aspect ratio (the treemap algorithm packs rectangles to fill a
 * roughly square area) and shows multiple holdings rows when the user
 * toggles to the table view mode.
 *
 * Field invariants (cross-checked against
 * {@link DashboardModuleDescriptor} contract):
 *
 * - `name: 'holdings'` — kebab-case stable identifier. Used as the
 *   discriminator in `LayoutItem.moduleId` of persisted layout
 *   documents. MUST NOT be renamed without a layout-document migration
 *   step (renaming breaks every saved layout that references it).
 * - `displayLabel: HOLDINGS_TITLE` — the catalog row label and (via
 *   the canvas's `resolveTitle(item.name)` helper) the module header
 *   title rendered by the canvas-owned outer `<gf-module-wrapper>`.
 *   The single `$localize`-tagged constant is the single source of
 *   truth so translations update both surfaces consistently.
 * - `iconName: 'pie-chart-outline'` — Ionicons 8.x standard icon name.
 * - `minCols: 4`, `minRows: 4` — both ≥ 2 (Rule 6 satisfied).
 * - `defaultCols: 6 ≥ minCols: 4`, `defaultRows: 6 ≥ minRows: 4` —
 *   default placement size respects the engine-enforced minimums.
 *
 * Field order is alphabetical, matching
 * {@link DashboardModuleDescriptor} interface field ordering for
 * readability consistency (TypeScript does not require field order to
 * match, but the lint-style convention encourages it).
 */
export const HOLDINGS_MODULE_DESCRIPTOR: DashboardModuleDescriptor = {
  component: GfHoldingsModuleComponent,
  defaultCols: 6,
  defaultRows: 6,
  displayLabel: HOLDINGS_TITLE,
  iconName: 'pie-chart-outline',
  minCols: 4,
  minRows: 4,
  name: 'holdings'
};
