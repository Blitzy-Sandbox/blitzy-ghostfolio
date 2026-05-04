import { ChatPanelComponent } from '@ghostfolio/client/components/chat-panel/chat-panel.component';

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';

import { DashboardModuleDescriptor } from '../../interfaces/dashboard-module.interface';

// Module-scope i18n title constant.
//
// Declared at module scope (NOT as a class field with a default expression)
// so the value can be referenced by the
// {@link CHAT_MODULE_DESCRIPTOR.displayLabel} field below. The
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
// `apps/client/src/app/dashboard/modules/holdings/holdings-module.component.ts`
// (`HOLDINGS_TITLE = $localize\`Holdings\``) and
// `apps/client/src/app/dashboard/modules/portfolio-overview/portfolio-overview-module.component.ts`
// (`PORTFOLIO_OVERVIEW_TITLE = $localize\`Portfolio Overview\``).
//
// Module-scope `$localize` calls require the runtime to have evaluated
// `@angular/localize/init` BEFORE this file is imported. The production
// app bootstraps it via the `@angular/localize/init` import in
// `apps/client/src/main.ts`; the companion spec file imports it
// explicitly at the top of `chat-module.component.spec.ts`, mirroring the
// `chat-panel.component.spec.ts:11` pattern.
const CHAT_TITLE = $localize`AI Chat`;

/**
 * AI Chat dashboard module wrapper — DEVIATION POINT (AAP § 0.7.2).
 *
 * Wraps the existing `ChatPanelComponent` (selector `app-chat-panel`)
 * from `@ghostfolio/client/components/chat-panel/chat-panel.component`
 * as the inner content of a dashboard grid module. The CHROME (header,
 * drag handle, remove button, title icon, content slot) is provided by
 * the canvas-level outer `<gf-module-wrapper>` declared inside
 * `dashboard-canvas.component.html`; this component renders ONLY the
 * inner presentation content. Keeping the chrome at the canvas level
 * eliminates the double-wrapper DOM defect (QA Checkpoint 6 Issue #1)
 * that previously stacked two `<gf-module-wrapper>` instances per
 * grid cell, producing duplicated drag handles and titles.
 *
 * **DEVIATION POINT**: Per AAP § 0.7.2, this refactor explicitly deviates
 * from the existing tech spec's definition of `ChatPanelComponent` as
 * embedded within `portfolio-page.html:32`. The chat panel MUST be
 * treated as a standalone grid module co-equal with all other modules.
 * This deviation is intentional and recorded in the project's decision
 * log at `docs/decisions/agent-action-plan-decisions.md`.
 *
 * The wrapped `ChatPanelComponent` is preserved UNCHANGED — it declares
 * no public inputs or outputs and self-loads chat streaming via its
 * internal `AiChatService` and `DestroyRef` dependencies. Its internal
 * signals (`errorMessage`, `inputText`, `isStreaming`, `messages`,
 * `isCollapsed`, `panelWidth`), constants (`MAX_CLIENT_TRANSMITTED_MESSAGES
 * = 5`, `COLLAPSED_WIDTH_REM = '2.75rem'`, `DEFAULT_EXPANDED_WIDTH_PX
 * = 280`, `MIN_EXPANDED_WIDTH_PX = 200`, `MAX_EXPANDED_WIDTH_PX = 600`),
 * and SSE handling all remain UNCHANGED. This wrapper has no service
 * dependencies of its own and performs no data fetching; it is pure
 * orchestration glue. The inner component handles its own RxJS
 * subscriptions (piped through `takeUntilDestroyed(destroyRef)` per
 * AAP § 0.1.2) and implements `OnDestroy` to call
 * `aiChatService.closeStream()`, so destroying this wrapper auto-disposes
 * the inner subscriptions through Angular's component-tree teardown — no
 * manual cleanup is needed in the wrapper.
 *
 * **Selector convention exception**: Per AAP § 0.7.4, the wrapper itself
 * uses the `gf-chat-module` selector (project-wide `gf-` prefix), but
 * the wrapped component retains its existing `app-chat-panel` selector
 * (NOT `gf-chat-panel`). This is an intentional legacy exception
 * documented in the AAP and annotated with an `eslint-disable` comment
 * inside `chat-panel.component.ts:53`.
 *
 * Per Rule 1 (AAP § 0.8.1.1), this component MUST NOT import from
 * the dashboard-canvas, module-catalog, sibling modules, or
 * services subfolders. The only allowed dashboard imports are
 * the `interfaces` type definitions (`DashboardModuleDescriptor`).
 * The external imports are limited to `@angular/common`, `@angular/core`,
 * and the wrapped `ChatPanelComponent` from
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
 * Note: the wrapped `ChatPanelComponent` itself uses
 * `@HostBinding('style.width')` to manage its OWN host element's
 * collapsed/expanded width (`COLLAPSED_WIDTH_REM = '2.75rem'` /
 * `panelWidth()` px). That binding is on the INNER component, NOT this
 * wrapper, and it controls a UX state (collapse/expand toggle) — NOT a
 * grid-coordinate state. Gridster owns the OUTER cell's dimensions; the
 * chat panel controls its own width WITHIN that cell. The two layouts
 * compose naturally and Rule 2 is satisfied for this wrapper.
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
 * the canonical specification for this contract; AAP § 0.7.2 records
 * the DEVIATION POINT; AAP § 0.7.4 governs the `gf-chat-module`
 * selector convention; QA Checkpoint 6 Issue #1 is the source of the
 * wrapper-removal change.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatPanelComponent, CommonModule],
  selector: 'gf-chat-module',
  styleUrls: ['./chat-module.component.scss'],
  templateUrl: './chat-module.component.html'
})
export class GfChatModuleComponent {}

/**
 * Module descriptor for the AI Chat module wrapper — the Rule 3
 * self-registration mechanism per AAP § 0.8.1.3 (DEVIATION POINT per
 * AAP § 0.7.2).
 *
 * Imported into the module-registry bootstrap (typically an
 * `APP_INITIALIZER` factory or a side-effect import in the dashboard
 * canvas's `imports` chain) and registered via
 * `ModuleRegistryService.register(CHAT_MODULE_DESCRIPTOR)`. The
 * registry is the single source of allowed grid-item component types
 * in the modular dashboard; the canvas (`GfDashboardCanvasComponent`)
 * resolves this descriptor by name when hydrating a saved layout or
 * processing a catalog `addModule` event, then instantiates the
 * descriptor's `component` reference via
 * `viewContainerRef.createComponent(...)`.
 *
 * Per Rule 6 (AAP § 0.8.1.6), `minCols` and `minRows` MUST be ≥ 2;
 * `defaultCols` MUST be ≥ `minCols` and `defaultRows` MUST be ≥
 * `minRows`. The values declared below — 2 × 4 minimum, 3 × 6 default
 * — reflect the chat panel's content density and intrinsic aspect
 * ratio: the chat panel is naturally a sidebar-shaped UI (taller than
 * wide). A meaningful conversation view requires at least 2 columns
 * wide (matches the chat panel's collapsed-strip width affordance —
 * `COLLAPSED_WIDTH_REM = '2.75rem'` ≈ less than 1 grid column at
 * typical column widths, but a 2-column-wide cell preserves usability
 * even when expanded back to the default `DEFAULT_EXPANDED_WIDTH_PX =
 * 280` ≈ 17.5 rem at default font size, which corresponds well to
 * roughly 3 grid columns) and 4 rows tall to display the header + a
 * few message bubbles + the input field; the default 3 × 6 provides a
 * comfortable initial size for a usable chat experience with a visible
 * message history and composer.
 *
 * **Decision D-036** (`docs/decisions/agent-action-plan-decisions.md`)
 * formally records the `defaultCols = 3` choice. The Checkpoint 4
 * scope description suggested `defaultCols = 4`; the implementation
 * reconciles to `3` because the wrapped `ChatPanelComponent`'s
 * `DEFAULT_EXPANDED_WIDTH_PX = 280` corresponds to roughly three
 * grid columns at the canvas's typical column widths (with a 1280
 * × 800 desktop viewport and `fixedRowHeight = 64`, each column is
 * about 95 px gross before margins; 280 ÷ 95 ≈ 2.95 ≈ 3 cols). The
 * 3-column default preserves first-paint UX (no empty horizontal
 * whitespace inside the cell) while still satisfying every Rule 6
 * invariant. See D-036 for the full alternatives-considered analysis
 * and the verification evidence cross-references.
 *
 * Field invariants (cross-checked against
 * {@link DashboardModuleDescriptor} contract):
 *
 * - `name: 'chat'` — kebab-case stable identifier (single-word,
 *   lowercase). Used as the discriminator in `LayoutItem.moduleId` of
 *   persisted layout documents. MUST NOT be renamed without a
 *   layout-document migration step (renaming breaks every saved layout
 *   that references it).
 * - `displayLabel: CHAT_TITLE` — the catalog row label and (via the
 *   canvas's `resolveTitle(item.name)` helper) the module header
 *   title rendered by the canvas-owned outer `<gf-module-wrapper>`.
 *   The single `$localize`-tagged constant is the single source of
 *   truth so translations update both surfaces consistently.
 * - `iconName: 'chatbubbles-outline'` — Ionicons 8.x standard icon name.
 * - `minCols: 2`, `minRows: 4` — both ≥ 2 (Rule 6 satisfied).
 *   `minRows: 4` is above the global 2-row floor because the chat
 *   panel's three-section layout (header, message log, composer)
 *   becomes cramped below 4 rows. With 4 rows the header takes ~1
 *   row, the message log ~2 rows, and the composer ~1 row — usable
 *   but tight; lower would be unusable.
 * - `defaultCols: 3 ≥ minCols: 2`, `defaultRows: 6 ≥ minRows: 4` —
 *   default placement size respects the engine-enforced minimums.
 *
 * Field order is alphabetical, matching
 * {@link DashboardModuleDescriptor} interface field ordering for
 * readability consistency (TypeScript does not require field order to
 * match, but the lint-style convention encourages it).
 */
export const CHAT_MODULE_DESCRIPTOR: DashboardModuleDescriptor = {
  component: GfChatModuleComponent,
  defaultCols: 3,
  defaultRows: 6,
  displayLabel: CHAT_TITLE,
  iconName: 'chatbubbles-outline',
  minCols: 2,
  minRows: 4,
  name: 'chat'
};
