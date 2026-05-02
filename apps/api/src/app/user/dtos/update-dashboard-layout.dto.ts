import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from 'class-validator';

/**
 * Maximum permitted length, in UTF-16 code units, of a `moduleId` string
 * accepted by `PATCH /api/v1/user/layout`.
 *
 * Defense-in-depth ceiling; mirrors the `INVESTMENT_GOAL_LABEL_MAX_LENGTH = 200`
 * precedent in `apps/api/src/app/user-financial-profile/dtos/financial-profile.dto.ts`.
 *
 * Legitimate `moduleId` values are bound to the client-side
 * `ModuleRegistryService`'s registered names (currently five: `portfolio-overview`,
 * `holdings`, `transactions`, `analysis`, `chat`). Capping at 100 chars
 * rejects pathological payloads while preserving headroom for future module
 * names — without this cap, a single `moduleId` could be arbitrarily long,
 * wasting storage and inflating the persisted PostgreSQL `jsonb` column. The
 * limit is enforced at the DTO boundary so requests fail fast with a clear
 * validation error before reaching the persistence layer.
 */
const MODULE_ID_MAX_LENGTH = 100;

/**
 * Maximum permitted number of layout items per persisted `layoutData` payload.
 *
 * Per AAP § 0.8.3, "Maximum module count: 50 per user". This caps the array
 * length at the API boundary, preventing pathological-payload DoS vectors and
 * limiting JSON size growth in the persisted PostgreSQL `jsonb` column.
 *
 * Even if a malicious client crafts a body with 10,000 items, the global
 * Express body-parser limit (10 MB) and PostgreSQL's per-row TOAST ceiling
 * (~1 GB) would still permit excessive resource consumption without this
 * defensive cap. 50 items vastly exceeds any legitimate dashboard composition
 * (the reference grid is 12 cols × N rows; even a fully packed 12×12 canvas
 * would hold at most ~36 minimum-size 2×2 modules).
 */
const LAYOUT_ITEMS_MAX_COUNT = 50;

/**
 * Permitted `version` values for the `layoutData` payload schema.
 *
 * Currently only version `1` is supported. Future schema-breaking changes
 * extend this tuple AND require a service-layer normalizer for migration
 * (e.g., `if (data.version === 1) data = migrateV1ToV2(data);`).
 *
 * The `as const` assertion makes the values literal types so that the
 * `class-validator` `@IsIn` decorator's accepted-values whitelist matches
 * the TypeScript `version: 1` literal field type below.
 *
 * The `as unknown as number[]` cast at the decorator site is the documented
 * `class-validator` workaround for the type-signature mismatch between
 * TypeScript's `readonly [1]` tuple and `IsIn`'s `unknown[]` parameter.
 */
const SUPPORTED_LAYOUT_VERSIONS = [1] as const;

/**
 * Number of grid columns. Must match angular-gridster2's `minCols` and
 * `maxCols` config values in `apps/client/src/app/dashboard/dashboard-canvas/`
 * `dashboard-canvas.component.ts` (AAP § 0.1.2 — "Grid spec: 12 columns,
 * fixed row height (constant px), minimum module size 2×2 cells").
 *
 * Used as the upper bound for `cols` (full-width item) and as the basis for
 * the `(GRID_COLUMN_COUNT - 1)` upper bound of column origin
 * (`x ∈ [0, GRID_COLUMN_COUNT - 1]`).
 */
const GRID_COLUMN_COUNT = 12;

/**
 * Minimum cell extent (cols and rows) per layout item. Per AAP § 0.1.2,
 * "minimum module size 2×2 cells" — enforced at the grid-engine level via
 * angular-gridster2's `minItemCols: 2` and `minItemRows: 2` config, AND
 * defensively at the API boundary by this DTO so that a malicious or buggy
 * client cannot persist degenerate 1×1 (or smaller) items.
 */
const MIN_ITEM_CELLS = 2;

/**
 * Single layout item describing one module's grid placement.
 *
 * Per AAP § 0.6.1.7 contract:
 *   - `moduleId`: registered module name (string ≤ 100 chars).
 *   - `cols`, `rows`: cell-extent ≥ 2 (minimum module size per AAP § 0.1.2).
 *     - `cols` additionally ≤ 12 (full grid width).
 *     - `rows` has no upper bound (canvas is vertically scrollable).
 *   - `x`: column origin in [0, 11] (12-column grid).
 *   - `y`: row origin ≥ 0.
 *
 * NOTE on cross-field validation: The constraint `x + cols ≤ 12` (item must
 * fit horizontally) is NOT enforced at this DTO level — it requires
 * cross-field comparison which `class-validator` does not natively support
 * within a single class without custom validators.
 *
 * Per the AAP's accepted approach, the constraint is permitted at this layer;
 * the angular-gridster2 client engine clamps any overflow via its
 * `pushItems: true` config at render time. A future custom cross-field
 * validator may be added; until then, an overflowing payload is persisted
 * as-is and rendered correctly by gridster on the client.
 */
export class LayoutItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MODULE_ID_MAX_LENGTH)
  moduleId: string;

  @IsInt()
  @Min(MIN_ITEM_CELLS)
  @Max(GRID_COLUMN_COUNT)
  cols: number;

  @IsInt()
  @Min(MIN_ITEM_CELLS)
  rows: number;

  @IsInt()
  @Min(0)
  @Max(GRID_COLUMN_COUNT - 1)
  x: number;

  @IsInt()
  @Min(0)
  y: number;
}

/**
 * Top-level layout payload. Shape: `{ version: 1; items: LayoutItem[] }`.
 *
 * Per AAP § 0.6.1.7:
 *   - `version`: literal `1` (rejected by `@IsIn([1])` for any other value).
 *   - `items`: array of length 0..50; each element validated as `LayoutItemDto`.
 *
 * The `version` discriminator enables future schema migrations without
 * breaking the persisted Prisma column shape. When schema v2 is introduced,
 * `SUPPORTED_LAYOUT_VERSIONS` becomes `[1, 2] as const` and the field type
 * widens to `version: 1 | 2`.
 *
 * The `@Type(() => LayoutItemDto)` decorator from `class-transformer` is
 * REQUIRED so that incoming JSON array elements are materialized into
 * `LayoutItemDto` class instances; otherwise `@ValidateNested({ each: true })`
 * becomes a no-op because `class-validator` cannot recurse into plain objects
 * without a registered class type.
 */
export class LayoutDataPayload {
  @IsIn(SUPPORTED_LAYOUT_VERSIONS as unknown as number[])
  version: 1;

  @IsArray()
  @ArrayMaxSize(LAYOUT_ITEMS_MAX_COUNT)
  @ValidateNested({ each: true })
  @Type(() => LayoutItemDto)
  items: LayoutItemDto[];
}

/**
 * Request DTO for `PATCH /api/v1/user/layout`. The outer wrapper exists for
 * two distinct reasons:
 *
 *   1. Forward-compatibility: future PATCH-able layout fields can be added
 *      at the top level without breaking the persisted `layoutData` shape.
 *
 *   2. SECURITY DEFENSE-IN-DEPTH (AAP § 0.7.1.5 — Engineering Rule 5 /
 *      Decision D-012): Wrapping `layoutData` in an explicit DTO layer
 *      prevents auto-mapping of unintended top-level fields like a forged
 *      user-identifier from a malicious request body. NestJS's global
 *      `ValidationPipe` is configured with `whitelist: true`,
 *      `forbidNonWhitelisted: true` so unknown fields cause HTTP 400; this
 *      DTO's structural defense is independent of and complementary to that
 *      configuration.
 *
 * The DTO MUST NOT contain any user-identifier field. The authenticated
 * principal is sourced exclusively from `request.user.id` (JWT-derived) in
 * the controller per Engineering Rule 5 / Decision D-012. Any future change
 * adding such a field here is a security regression and a Rule 5 violation.
 */
export class UpdateDashboardLayoutDto {
  @IsObject()
  @ValidateNested()
  @Type(() => LayoutDataPayload)
  layoutData: LayoutDataPayload;
}
