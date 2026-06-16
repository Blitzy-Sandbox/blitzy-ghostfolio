/**
 * The complete, authoritative allowlist of dashboard module keys recognized by
 * the Modular Dashboard feature — one stable key per registered module. This
 * MUST stay in lockstep with the keys registered in
 * `apps/client/src/app/dashboard/module-registry.service.ts` (the client-side
 * `ModuleRegistryService`), which is the single UI introduction mechanism for
 * module types (AAP § 0.8.1, "Registry-only introduction").
 *
 * It exists as a shared, server-consumable contract so the layout DTO
 * (`apps/api/src/app/user/dtos/update-user-dashboard-layout.dto.ts`) can enforce
 * `@IsIn(DASHBOARD_MODULE_KEYS)` on every persisted `moduleKey`. Without this,
 * `PATCH /api/v1/user/layout` would accept arbitrary/unknown/adversarial keys
 * (stale, SQL-ish, or markup strings) into the JSONB layout column, violating
 * the registry-only-introduction rule and persisting untrusted layout data
 * (QA F9 Issue 2). Unregistered keys are now rejected with HTTP 400 at the
 * request boundary.
 *
 * Declared `as const` so it doubles as the source for the `DashboardModuleKey`
 * union type below.
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
 * Union type of every valid dashboard module key, derived from
 * `DASHBOARD_MODULE_KEYS`. Use this where a value is known to be a registered
 * module key; the persisted `DashboardLayoutItem.moduleKey` remains a plain
 * `string` because it is hydrated from opaque persisted JSON and is validated
 * at the DTO boundary rather than by the structural interface.
 */
export type DashboardModuleKey = (typeof DASHBOARD_MODULE_KEYS)[number];

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
