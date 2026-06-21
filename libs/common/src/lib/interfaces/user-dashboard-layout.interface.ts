/**
 * The single, authoritative set of stable dashboard module keys.
 *
 * This array is the shared module-key contract referenced by BOTH the client
 * module registry ({@link ModuleRegistryService}) and the server-side layout
 * DTO validator. Persisting it here (in `libs/common`) — rather than
 * duplicating string literals on each side — guarantees the API and the client
 * agree on exactly which `moduleKey` values are legitimate, so the server can
 * reject unknown/empty keys with HTTP 400 using the same vocabulary the client
 * uses to render modules.
 *
 * Ordering mirrors the catalog registration order in `ModuleRegistryService`.
 * Declared `as const` so the literal union `DashboardModuleKey` can be derived.
 */
export const DASHBOARD_MODULE_KEYS = [
  'portfolio-overview',
  'holdings',
  'summary',
  'markets',
  'watchlist',
  'portfolio-summary',
  'transactions',
  'allocations',
  'analysis',
  'fire',
  'x-ray',
  'ai-chat'
] as const;

/**
 * Literal union of every legitimate dashboard module key, derived from
 * {@link DASHBOARD_MODULE_KEYS}. Adding a key to the array above automatically
 * widens this type — there is no second list to keep in sync.
 */
export type DashboardModuleKey = (typeof DASHBOARD_MODULE_KEYS)[number];

/**
 * Total number of columns in the dashboard grid.
 *
 * The `angular-gridster2` canvas is configured with a fixed 12-column grid
 * (`minCols === maxCols === 12`). Persisted layout geometry must therefore
 * satisfy `x >= 0` and `x + cols <= DASHBOARD_GRID_COLUMNS`; the server-side
 * DTO validator rejects off-grid items with HTTP 400 using this constant.
 */
export const DASHBOARD_GRID_COLUMNS = 12;

export interface DashboardLayoutItem {
  moduleKey: string;
  x: number;
  y: number;
  cols: number;
  rows: number;
}

export interface LayoutData {
  schemaVersion: number;
  items: DashboardLayoutItem[];
}

export interface UserDashboardLayout {
  userId: string;
  layoutData: LayoutData;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Client-to-server payload shape for `PATCH /api/v1/user/layout`.
 *
 * Server-only fields (`userId`, `createdAt`, `updatedAt`) are omitted —
 * those are sourced authoritatively by the server: `userId` is read from
 * the JWT, `createdAt` is set by the database default on first upsert, and
 * `updatedAt` is set by the `@updatedAt` Prisma directive.
 */
export type UserDashboardLayoutPatchPayload = Omit<
  UserDashboardLayout,
  'createdAt' | 'updatedAt' | 'userId'
>;
