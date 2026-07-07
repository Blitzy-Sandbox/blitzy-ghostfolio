import { Type } from '@angular/core';

/**
 * Metadata contract describing a single dashboard module type registered
 * with `ModuleRegistryService`. The registry is the ONLY mechanism for
 * introducing module types (Rule 3) and is the declaration source for each
 * module's minimum cell dimensions (Rule 6).
 *
 * `id` is the module-type key persisted in each `DashboardLayoutItem.type`
 * (`@ghostfolio/common/interfaces`); the canvas resolves the wrapper
 * component to render via `registry.resolve(item.type).component` and mounts
 * it with `NgComponentOutlet`.
 */
export interface DashboardModuleDefinition {
  /** Wrapper component `Type` rendered dynamically via `NgComponentOutlet`. */
  component: Type<any>;
  /** Default width in grid cells applied when the module is first added. */
  defaultCols?: number;
  /** Default height in grid cells applied when the module is first added. */
  defaultRows?: number;
  /** Optional display icon hint for the module catalog (Material ligature). */
  icon?: string;
  /** Module-type key; MUST equal the persisted `DashboardLayoutItem.type`. */
  id: string;
  /** Minimum width in grid cells; floor of 2 per Rule 6 (2x2 minimum). */
  minCols: number;
  /** Minimum height in grid cells; floor of 2 per Rule 6 (2x2 minimum). */
  minRows: number;
  /** Human-readable name shown in the module catalog. */
  name: string;
}
