import { Type } from '@angular/core';
import { GridsterItemConfig } from 'angular-gridster2';

export type {
  DashboardLayoutItem,
  LayoutData
} from '@ghostfolio/common/interfaces';

/**
 * `DataTransfer` type key carrying a module's registry `key` during a
 * catalog-to-canvas drag-add. The catalog (drag source) writes the key under
 * this type on `dragstart`; the canvas (drop target) reads it on `drop`.
 * Declared here — a layer both sides already depend on — so the catalog and
 * canvas share the contract without importing each other (module isolation).
 */
export const MODULE_DRAG_DATA_TYPE = 'application/x-gf-dashboard-module';

/**
 * Metadata describing a single module type that the dashboard can render.
 * Registered exclusively through `ModuleRegistryService` (the sole module-
 * introduction mechanism). `component` is the thin wrapper component that
 * embeds the underlying feature component and adds the MatCard grid chrome.
 */
export interface ModuleDefinition {
  key: string;
  displayName: string;
  component: Type<unknown>;
  minItemCols: number;
  minItemRows: number;
  icon?: string;
}

/**
 * A placed grid item. Extends the `angular-gridster2` `GridsterItemConfig`
 * geometry (`x`, `y`, `cols`, `rows`, plus optional engine fields) with the
 * `moduleKey` that identifies which registered module renders in this cell.
 * The canvas's `DashboardItem[]` is the single source of truth for layout.
 */
export interface DashboardItem extends GridsterItemConfig {
  moduleKey: string;
}
