/**
 * Persisted dashboard layout payload contract — the canonical TypeScript
 * shape exchanged between the client `UserDashboardLayoutService`
 * (`HttpClient.get<LayoutData>(...)` / `HttpClient.patch<LayoutData>(...)`)
 * and the API `UserDashboardLayoutController` at `GET` and `PATCH
 * /api/v1/user/layout`.
 *
 * This file is the bottom of the dashboard dependency stack: it declares
 * pure structural types only — no runtime code, no Angular decorators,
 * no classes, and no imports. The same shape is mirrored on the server
 * by `apps/api/src/app/user/dtos/update-dashboard-layout.dto.ts` (which
 * adds `class-validator` runtime checks); any drift between the two
 * surfaces would cause TypeScript-OK / runtime-fail bugs and is
 * forbidden.
 *
 * Reference: AAP § 0.6.1.7 (persistence payload shape) is the canonical
 * specification for this contract. The persisted column on PostgreSQL
 * (`UserDashboardLayout.layoutData`) is `jsonb`; the document stored in
 * that column MUST validate against the {@link LayoutData} interface.
 */

/**
 * Persisted dashboard layout payload — the canonical wire and storage
 * contract for a single user's saved canvas state.
 *
 * The document is exchanged in both directions on the layout endpoints:
 *
 * - `GET  /api/v1/user/layout` returns this shape on `200 OK` (when a row
 *   exists) and HTTP `404 Not Found` (when no row exists for the
 *   authenticated user — first-visit semantics per AAP § 0.6.3.1). The
 *   client maps the 404 to a "blank canvas + auto-open catalog" state per
 *   Rule 10 (AAP § 0.8.1.10); it does NOT model "missing layout" as a
 *   `null` payload.
 * - `PATCH /api/v1/user/layout` accepts this shape as the request body
 *   and returns the upserted document on `200 OK`. The PATCH is
 *   idempotent (Decision D-019) — the server-side handler invokes
 *   `prisma.userDashboardLayout.upsert(...)` keyed on `userId`.
 *
 * **Server-side validation rules** (enforced by class-validator
 * decorators on `update-dashboard-layout.dto.ts`; the client interface
 * mirrors the rules in JSDoc but does NOT enforce them at compile time):
 *
 * - {@link LayoutData.version} MUST equal `1`.
 * - {@link LayoutData.items} MUST be an array of length 0..50 (defensive
 *   cap per AAP § 0.6.3.3 — mitigates pathological JSON payload sizes).
 * - Each {@link LayoutItem.moduleId} MUST be a non-empty string of at
 *   most 100 characters.
 * - Each of {@link LayoutItem.cols}, {@link LayoutItem.rows},
 *   {@link LayoutItem.x}, and {@link LayoutItem.y} MUST be a
 *   non-negative integer; additionally `cols >= 2`, `rows >= 2`, and
 *   `x + cols <= 12`.
 *
 * **Forward-compatibility note**: when this schema evolves (for example,
 * adding a top-level `theme` field or per-item module configuration),
 * the protocol is to bump {@link LayoutData.version} from `1` to `2` and
 * add an explicit migration step in the canvas's hydration logic. DO NOT
 * add fields to {@link LayoutData} or {@link LayoutItem} without bumping
 * the version — silent schema drift would corrupt persisted documents
 * across rolling deployments. The literal type `1` on
 * {@link LayoutData.version} is intentional: it is a forward-compatibility
 * tripwire that forces every consumer to be migrated deliberately when
 * the version is bumped.
 */
export interface LayoutData {
  /**
   * Ordered list of grid items currently on the canvas. An empty array
   * means "blank canvas" and renders the empty state; `null` and
   * `undefined` are NOT valid values. The "no record exists" condition
   * is signaled at the HTTP layer by a `404 Not Found` response from
   * `GET /api/v1/user/layout`, NOT by a `null` payload.
   *
   * The array is server-validated to be at most 50 entries long
   * (defensive cap per AAP § 0.6.3.3); the TypeScript type itself does
   * not encode the length constraint.
   */
  items: LayoutItem[];

  /**
   * Schema version for the persisted layout document. Always `1` for the
   * v1 dashboard refactor.
   *
   * The literal type `1` (not `number`) is intentional: when this schema
   * evolves, bumping the version to `2` will produce compile-time errors
   * at every consumer that hardcoded `version: 1`, forcing a deliberate
   * migration. This is preferable to silent schema drift across rolling
   * deployments.
   */
  version: 1;
}

/**
 * A single grid item on the dashboard canvas — describes which module
 * type to render, where on the 12-column grid to place it, and how many
 * cells it occupies.
 *
 * **Rule 2 (Single source of truth, AAP § 0.8.1.2)**: the position
 * (`x`, `y`) and size (`cols`, `rows`) fields are owned exclusively by
 * the canvas's gridster engine. Module wrapper components MUST NOT hold
 * layout state; they MUST NOT declare `@Input()` or `@Output()`
 * properties for these coordinates and MUST NOT mutate them via direct
 * DOM manipulation. The persisted document is the durable projection of
 * the in-memory `gridster.dashboard` array maintained by
 * `GfDashboardCanvasComponent`.
 *
 * **Coordinate field naming**: the `x`, `y`, `cols`, and `rows` field
 * names intentionally match `angular-gridster2`'s `GridsterItem` shape
 * so that {@link LayoutItem} objects can be assigned directly into
 * `gridster.dashboard` without translation. This file does NOT, however,
 * import from `angular-gridster2` — keeping the contract independent of
 * the grid engine permits future engine swaps without rewriting the
 * persistence shape.
 *
 * **Cross-reference**: the {@link LayoutItem.moduleId} value MUST equal
 * the `name` field of a `DashboardModuleDescriptor` registered with the
 * `ModuleRegistryService`. The canvas resolves each persisted item via
 * `moduleRegistry.getByName(item.moduleId)` at hydration time and skips
 * items whose `moduleId` does not resolve to a registered descriptor
 * (defensive — protects against stale persisted documents referencing
 * removed module types).
 */
export interface LayoutItem {
  /**
   * Width of the item measured in grid columns. Server-side validation
   * enforces `cols >= 2` (the global minimum item size per AAP § 0.6.1)
   * and `x + cols <= 12` (item must fit within the 12-column grid).
   * TypeScript cannot encode the integer / range constraints; they are
   * runtime invariants enforced exclusively by the server-side DTO.
   */
  cols: number;

  /**
   * Module type identifier — matches the `name` field of a registered
   * `DashboardModuleDescriptor` (see `ModuleRegistryService`). Validated
   * server-side as a non-empty string with at most 100 characters.
   *
   * `moduleId` is intentionally a plain `string` rather than a literal
   * union: modules are registered dynamically at application bootstrap,
   * so the compile-time union of registered names is unknown. Resolution
   * to a concrete component happens at canvas hydration time.
   */
  moduleId: string;

  /**
   * Height of the item measured in grid rows. Server-side validation
   * enforces `rows >= 2` (the global minimum item size per AAP § 0.6.1).
   * TypeScript cannot encode the integer / minimum constraints; they are
   * runtime invariants enforced exclusively by the server-side DTO.
   */
  rows: number;

  /**
   * Horizontal position of the item on the grid (0-indexed, leftmost
   * column is `0`). Server-side validation enforces `x >= 0` (integer)
   * and `x + cols <= 12` (item must fit within the 12-column grid).
   * TypeScript cannot encode the integer / non-negative constraint; it
   * is a runtime invariant enforced exclusively by the server-side DTO.
   */
  x: number;

  /**
   * Vertical position of the item on the grid (0-indexed, topmost row is
   * `0`). Server-side validation enforces `y >= 0` (integer); the grid
   * has no explicit row-count cap and grows downward as items are added.
   * TypeScript cannot encode the integer / non-negative constraint; it
   * is a runtime invariant enforced exclusively by the server-side DTO.
   */
  y: number;
}
