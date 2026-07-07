import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested
} from 'class-validator';

/**
 * Maximum permitted length, in UTF-16 code units, of a module `type` key
 * accepted by `PATCH /api/v1/user/layout`.
 *
 * Rationale (defense-in-depth — CWE-20, mirrors the `@MaxLength` hardening
 * already applied to `InvestmentGoalDto.label` in
 * `user-financial-profile/dtos/financial-profile.dto.ts`):
 *
 *   `UserDashboardLayout.layoutData` is persisted as a Prisma `Json` (JSONB)
 *   column whose row-level size is bounded only by the global Express
 *   body-parser limit (10 MB) and PostgreSQL's per-row TOAST ceiling. A
 *   module `type` is a machine-generated registry key (kebab-case
 *   identifiers such as `"portfolio-overview"`, `"fear-and-greed"`,
 *   `"ai-chat"` — the longest registered key is 18 characters). Without a
 *   per-field cap, an authenticated client could submit arbitrarily long
 *   `type` strings, inflating the stored JSONB payload and burdening
 *   downstream registry look-ups.
 *
 *   `64` is a generous ceiling for any conceivable registry key while
 *   firmly bounding the field. A `type` longer than 64 characters cannot
 *   match a real module in the client registry, so it is overwhelmingly
 *   likely to be accidental or adversarial and is rejected with HTTP 400 at
 *   the `ValidationPipe` boundary before reaching the persistence layer.
 */
const MODULE_TYPE_MAX_LENGTH = 64;

/**
 * Maximum permitted number of grid items in a single persisted layout
 * accepted by `PATCH /api/v1/user/layout`.
 *
 * Rationale (defense-in-depth — CWE-20):
 *
 *   The dashboard is composed from a fixed catalog of registered module
 *   types (12 at present). Even allowing multiple instances of the same
 *   module type, a realistic user-composed canvas contains at most a few
 *   dozen items. Without an upper bound, an authenticated client could
 *   submit an unbounded `items` array, producing an oversized JSONB row
 *   and degrading storage/serialization performance.
 *
 *   `100` is far beyond any plausible hand-composed dashboard yet caps the
 *   array so an oversized payload fails fast with HTTP 400 at the
 *   `ValidationPipe` boundary. An empty array remains valid (a new user's
 *   blank canvas, or a canvas from which every module has been removed), so
 *   NO minimum-size constraint is applied.
 */
const DASHBOARD_LAYOUT_MAX_ITEMS = 100;

/**
 * A single grid item in a persisted dashboard layout. Mirrors the shared
 * `DashboardLayoutItem` contract in `@ghostfolio/common/interfaces` and the
 * `angular-gridster2` `GridsterItem` shape.
 *
 * Rule 6 (minimum 2×2): `cols` and `rows` carry `@Min(2)` as server-side
 * defense-in-depth so a below-minimum module is rejected with HTTP 400,
 * complementing the client-side gridster `minItemCols`/`minItemRows` +
 * `itemValidateCallback` enforcement.
 *
 * Security (CWE-20): `type` is additionally constrained with `@IsNotEmpty()`
 * and `@MaxLength(MODULE_TYPE_MAX_LENGTH)` so it can never be an empty or
 * unbounded free-form string, closing the oversized-string payload vector
 * while the numeric grid fields keep their existing `@Min` bounds.
 */
export class DashboardLayoutItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MODULE_TYPE_MAX_LENGTH)
  type: string;

  @IsInt()
  @Min(0)
  x: number;

  @IsInt()
  @Min(0)
  y: number;

  @IsInt()
  @Min(2)
  cols: number;

  @IsInt()
  @Min(2)
  rows: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  minItemCols?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  minItemRows?: number;
}

/**
 * Request body for `PATCH /api/v1/user/layout`.
 *
 * SECURITY (Rule 8 / AAP § 0.7.3): intentionally has NO `userId` field — the
 * user id is always sourced from the JWT (`request.user.id`), never the body.
 *
 * Shape aligns with `DashboardLayoutPatchPayload` (`{ items: DashboardLayoutItem[] }`)
 * from `@ghostfolio/common/interfaces`.
 *
 * Security (CWE-20): `items` carries `@ArrayMaxSize(DASHBOARD_LAYOUT_MAX_ITEMS)`
 * so an authenticated client cannot submit an unbounded array that would
 * produce an oversized JSONB row. An empty array is intentionally permitted
 * (a new user's blank canvas), so no minimum-size constraint is applied.
 */
export class DashboardLayoutDto {
  @IsArray()
  @ArrayMaxSize(DASHBOARD_LAYOUT_MAX_ITEMS)
  @Type(() => DashboardLayoutItemDto)
  @ValidateNested({ each: true })
  items: DashboardLayoutItemDto[];
}
