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

/**
 * Fixed grid width (columns). The canvas binds this to both `minCols` and
 * `maxCols`, so a valid column index is `[0, DASHBOARD_GRID_COLUMNS - 1]` and a
 * valid column span is `[DASHBOARD_MIN_CELL_DIMENSION, DASHBOARD_GRID_COLUMNS]`.
 */
export const DASHBOARD_GRID_COLUMNS = 12;

/** Minimum cell footprint per module on each axis (2×2 minimum, Rule 6). */
export const DASHBOARD_MIN_CELL_DIMENSION = 2;

/**
 * Upper bound for a single module's row span. A module spanning this many rows
 * is already far taller than any viewport (fixed row height ≈ 120 px), so this
 * is a generous-but-bounded operational cap that keeps a persisted layout from
 * declaring an unbounded module height.
 */
export const DASHBOARD_MAX_ROW_SPAN = 100;

/**
 * Upper bound for a module's top row index (`y`). Bounds how far down the grid a
 * module may be anchored, preventing an out-of-grid / unbounded vertical offset.
 */
export const DASHBOARD_MAX_GRID_ROW_INDEX = 1000;

/**
 * Maximum number of items a persisted layout may contain. Bounds the size of the
 * `layoutData` JSONB document; comfortably exceeds the registered module count.
 */
export const DASHBOARD_MAX_LAYOUT_ITEMS = 50;

/**
 * The authoritative set of module keys a persisted layout may reference. MUST
 * mirror the keys registered in the client `ModuleRegistryService`. Used as the
 * server-side whitelist for `DashboardLayoutItem.moduleKey` so a direct API
 * caller cannot persist an unknown module key (see decision D-104).
 */
export const DASHBOARD_MODULE_KEYS = [
  'portfolio-overview',
  'holdings',
  'summary',
  'watchlist',
  'market',
  'ai-chat',
  'analysis',
  'activities',
  'allocations',
  'fire',
  'x-ray',
  'rebalancing'
] as const;

/** Union of the registered dashboard module keys. */
export type DashboardModuleKey = (typeof DASHBOARD_MODULE_KEYS)[number];
