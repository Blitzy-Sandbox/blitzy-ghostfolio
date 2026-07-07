/**
 * Persisted, JSON-serializable dashboard layout contract shared by the client
 * and the server for the single-canvas dashboard.
 *
 * `DashboardLayout` is stored verbatim in the Prisma
 * `UserDashboardLayout.layoutData` JSONB column and is the request/response
 * body shape for `GET` / `PATCH /api/v1/user/layout`.
 *
 * JSON-serializability constraint: every field MUST be a JSON-safe primitive,
 * array, or plain object (string, number, arrays thereof). Do NOT use `Big`,
 * `Map`, `Set`, class instances, or any other non-serializable type — the
 * object is persisted as JSONB and round-trips through HTTP JSON.
 *
 * `updatedAt` is server-authoritative (set by the Prisma `@updatedAt`
 * directive on upsert) and is OMITTED from client-sent PATCH bodies. It is
 * typed `Date | string` to mirror the FinancialProfile timestamp convention:
 * a `Date` server-side and a `string` once JSON-serialized over HTTP.
 */

export interface DashboardLayoutItem {
  type: string; // module-type key matching a ModuleRegistryService definition id
  x: number; // grid column origin (0-based)
  y: number; // grid row origin (0-based)
  cols: number; // width in grid cells (>= 2 per the 2x2 minimum, Rule 6)
  rows: number; // height in grid cells (>= 2 per the 2x2 minimum, Rule 6)
  minItemCols?: number; // optional per-item minimum width (sourced from the registry)
  minItemRows?: number; // optional per-item minimum height (sourced from the registry)
}

export interface DashboardLayout {
  items: DashboardLayoutItem[];
  updatedAt?: Date | string;
}

/**
 * Client-to-server payload shape for `PATCH /api/v1/user/layout`.
 *
 * The server-authoritative `updatedAt` field is omitted — it is set by the
 * `@updatedAt` Prisma directive on upsert. Mirrors `FinancialProfilePatchPayload`.
 */
export type DashboardLayoutPatchPayload = Omit<DashboardLayout, 'updatedAt'>;
