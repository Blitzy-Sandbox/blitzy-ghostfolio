import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested
} from 'class-validator';

/**
 * A single grid item in a persisted dashboard layout. Mirrors the shared
 * `DashboardLayoutItem` contract in `@ghostfolio/common/interfaces` and the
 * `angular-gridster2` `GridsterItem` shape.
 *
 * Rule 6 (minimum 2×2): `cols` and `rows` carry `@Min(2)` as server-side
 * defense-in-depth so a below-minimum module is rejected with HTTP 400,
 * complementing the client-side gridster `minItemCols`/`minItemRows` +
 * `itemValidateCallback` enforcement.
 */
export class DashboardLayoutItemDto {
  @IsString()
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
 */
export class DashboardLayoutDto {
  @IsArray()
  @Type(() => DashboardLayoutItemDto)
  @ValidateNested({ each: true })
  items: DashboardLayoutItemDto[];
}
