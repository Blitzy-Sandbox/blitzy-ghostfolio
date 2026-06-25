/**
 * Shared contract for a single user's dashboard layout.
 *
 * Each item mirrors the angular-gridster2 `GridsterItem` grid coordinates
 * (`x`, `y`, `cols`, `rows`) plus the `moduleKey` that maps the cell to a
 * module type registered in the client `ModuleRegistryService`. The grid is
 * the single source of truth for positions/sizes (no module holds layout
 * state). The `layout` array carried by `UserDashboardLayout` serializes
 * cleanly to ONE PostgreSQL JSONB column (`UserDashboardLayout.layoutData`),
 * matching the `FinancialProfile.investmentGoals Json` precedent.
 */
export interface DashboardLayoutItem {
  cols: number;
  moduleKey: string;
  rows: number;
  x: number;
  y: number;
}

export interface UserDashboardLayout {
  layout: DashboardLayoutItem[];
}
