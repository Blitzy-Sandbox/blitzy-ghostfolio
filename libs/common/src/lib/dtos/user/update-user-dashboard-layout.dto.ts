import {
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_MAX_GRID_ROW_INDEX,
  DASHBOARD_MAX_LAYOUT_ITEMS,
  DASHBOARD_MAX_ROW_SPAN,
  DASHBOARD_MIN_CELL_DIMENSION,
  DASHBOARD_MODULE_KEYS
} from '@ghostfolio/common/interfaces';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested
} from 'class-validator';

/**
 * One grid item in a `PATCH /api/v1/user/layout` body. Bounds keep a persisted
 * layout inside the 12-column grid and at/above the 2×2 minimum, and restrict
 * `moduleKey` to the registered module set, so a direct API caller cannot
 * persist an out-of-grid, zero-size, oversized, or unknown-module layout that
 * the canvas UI would never produce.
 */
export class DashboardLayoutItemDto {
  // Column span: at least the 2×2 minimum, at most the full grid width.
  @IsInt()
  @Min(DASHBOARD_MIN_CELL_DIMENSION)
  @Max(DASHBOARD_GRID_COLUMNS)
  cols: number;

  // Module type; must be one of the registered module keys.
  @IsNotEmpty()
  @IsString()
  @IsIn(DASHBOARD_MODULE_KEYS)
  moduleKey: string;

  // Row span: at least the 2×2 minimum, bounded by the operational row cap.
  @IsInt()
  @Min(DASHBOARD_MIN_CELL_DIMENSION)
  @Max(DASHBOARD_MAX_ROW_SPAN)
  rows: number;

  // Column index: inside the 12-column grid (0 .. columns - 1).
  @IsInt()
  @Min(0)
  @Max(DASHBOARD_GRID_COLUMNS - 1)
  x: number;

  // Row index: non-negative and bounded by the operational row-index cap.
  @IsInt()
  @Min(0)
  @Max(DASHBOARD_MAX_GRID_ROW_INDEX)
  y: number;
}

export class UpdateUserDashboardLayoutDto {
  // Bounded array of validated grid items persisted into the `layoutData` JSONB
  // column; `@ArrayMaxSize` caps the document size.
  @IsArray()
  @ArrayMaxSize(DASHBOARD_MAX_LAYOUT_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => DashboardLayoutItemDto)
  layout: DashboardLayoutItemDto[];
}
