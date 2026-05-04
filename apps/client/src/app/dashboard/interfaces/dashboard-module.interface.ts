import { Type } from '@angular/core';

/**
 * Module type descriptor — the canonical TypeScript contract for every
 * dashboard module type registered with `ModuleRegistryService`.
 *
 * This file is the bottom of the dashboard dependency stack: it declares
 * a pure structural type only — no runtime code, no Angular decorators,
 * no classes, and no value-level exports. The single non-`@angular/core`
 * value referenced in this file is `Type` (a compile-time class-reference
 * type from `@angular/core`); the file does NOT import from any other
 * dashboard subfolder (e.g., `dashboard-canvas/`, `module-catalog/`,
 * `modules/`, `services/`) so the descriptor contract remains
 * independently consumable.
 *
 * **Rule 3 (Module registry is the sole mechanism, AAP § 0.8.1.3)**: the
 * registry — keyed on {@link DashboardModuleDescriptor.name} — is the
 * ONLY mechanism for introducing new module types into the canvas;
 * ad-hoc component insertion is prohibited. Every consumer of the
 * canvas (`GfDashboardCanvasComponent` for instantiation,
 * `GfModuleCatalogComponent` for browsing) resolves a module via a
 * descriptor obtained from `ModuleRegistryService`.
 *
 * **Rule 6 (Modules declare minimum cell dimensions, AAP § 0.8.1.6)**:
 * every descriptor MUST declare {@link DashboardModuleDescriptor.minCols}
 * and {@link DashboardModuleDescriptor.minRows} (both ≥ 2 per the
 * global 2 × 2 minimum item-size spec). The grid engine
 * (angular-gridster2 v21.0.1) enforces these per-item floors via
 * `<gridster-item [minItemCols]="descriptor.minCols"
 * [minItemRows]="descriptor.minRows">`; the catalog Add flow refuses to
 * place a module whose default cell footprint is below its declared
 * minimum.
 *
 * **Forward-compatibility note**: the {@link DashboardModuleDescriptor.name}
 * field is BOTH the registry lookup key AND the persistence
 * discriminator (it must equal `LayoutItem.moduleId` in saved layout
 * documents — see {@link ./layout-data.interface.ts}). Renaming
 * {@link DashboardModuleDescriptor.name} is a breaking change for users
 * with persisted layouts and MUST be accompanied by a layout-document
 * migration step. This is the same forward-compatibility tripwire
 * described on `LayoutData.version`.
 *
 * **Runtime invariants (NOT enforceable at compile time)**: the registry
 * service performs the following defensive checks at registration time
 * and rejects descriptors that violate any of them:
 *
 * - `name.length > 0` and contains no whitespace (conventionally
 *   lowercase kebab-case, e.g., `'portfolio-overview'`, `'chat'`).
 * - `minCols >= 2`, `minRows >= 2` (Rule 6 — global 2 × 2 minimum item
 *   size per AAP § 0.6.1).
 * - `defaultCols >= minCols`, `defaultRows >= minRows` (the default
 *   placement size cannot be smaller than the engine-enforced minimum).
 *
 * TypeScript cannot encode these constraints at compile time (numeric
 * lower bounds and non-empty-string checks live in the value domain);
 * the descriptor type is therefore a STRUCTURAL contract whose runtime
 * companion is `ModuleRegistryService.validate(metadata)`.
 *
 * Reference: AAP § 0.6.1.4 (Group 4 — Angular Dashboard Feature) is the
 * canonical specification for this contract.
 */
export interface DashboardModuleDescriptor {
  /**
   * Angular standalone component class to instantiate inside a
   * `<gridster-item>` for this module type. Must be the class
   * symbol — NOT an instance.
   *
   * The generic parameter is `unknown` (NOT `any`, NOT a specific
   * component base class) to permit any standalone component (e.g.,
   * `GfChatModuleComponent`, `GfHoldingsModuleComponent`,
   * `GfPortfolioOverviewModuleComponent`) to be registered while
   * preserving compile-time guarantees that the value is a
   * constructable Angular component reference.
   */
  component: Type<unknown>;

  /**
   * Default column count when the user adds the module via the
   * catalog. Must be ≥ {@link DashboardModuleDescriptor.minCols}.
   *
   * The catalog's Add flow seeds the new `<gridster-item>` with these
   * dimensions; the user can subsequently resize the module within the
   * minimum/maximum bounds enforced by the grid engine.
   */
  defaultCols: number;

  /**
   * Default row count when the user adds the module via the catalog.
   * Must be ≥ {@link DashboardModuleDescriptor.minRows}.
   */
  defaultRows: number;

  /**
   * Human-readable label shown in the catalog and the module
   * wrapper's header. Must be wrapped with `$localize` at the
   * call site to support i18n.
   *
   * The CALL SITE (the registration code in each module wrapper file —
   * NOT this interface) is responsible for wrapping the value with
   * `$localize` template literals so the existing `LanguageService` /
   * extract-i18n pipeline picks up the string. Hard-coding an
   * English-only literal here is a bug.
   */
  displayLabel: string;

  /**
   * Ionicons icon name (e.g., `'analytics-outline'`,
   * `'chatbubbles-outline'`). Renders inside `<ion-icon>` elements.
   *
   * Ionicons names are not strongly typed in the existing repository
   * (see `<ion-icon name="...">` usages across the codebase), so this
   * field is a plain `string`. The catalog and module-wrapper headers
   * project the value directly into the `name` attribute of an
   * `<ion-icon>` element.
   */
  iconName: string;

  /**
   * Minimum column count. Per Rule 6 (AAP § 0.8.1.6), MUST be ≥ 2.
   *
   * Bound to `<gridster-item [minItemCols]="descriptor.minCols">` so
   * the gridster engine rejects user-initiated resize / move
   * operations that would shrink the item below this floor.
   */
  minCols: number;

  /**
   * Minimum row count. Per Rule 6 (AAP § 0.8.1.6), MUST be ≥ 2.
   *
   * Bound to `<gridster-item [minItemRows]="descriptor.minRows">` so
   * the gridster engine rejects user-initiated resize / move
   * operations that would shrink the item below this floor.
   */
  minRows: number;

  /**
   * Stable identifier (e.g., `'chat'`, `'holdings'`,
   * `'portfolio-overview'`). Used as the discriminator in
   * `LayoutItem.moduleId` and as the lookup key in
   * `ModuleRegistryService.getByName(name)`.
   *
   * MUST be a non-empty string with no whitespace; conventionally
   * lowercase kebab-case. Renaming this value is a BREAKING change for
   * users with persisted layouts because saved `LayoutItem.moduleId`
   * values reference it; any rename MUST be accompanied by a layout
   * document migration step.
   */
  name: string;
}
