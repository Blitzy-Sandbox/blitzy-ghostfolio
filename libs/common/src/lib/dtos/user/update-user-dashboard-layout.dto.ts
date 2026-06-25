import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested
} from 'class-validator';

export class DashboardLayoutItemDto {
  @IsInt()
  @Min(0)
  cols: number;

  @IsNotEmpty()
  @IsString()
  moduleKey: string;

  @IsInt()
  @Min(0)
  rows: number;

  @IsInt()
  @Min(0)
  x: number;

  @IsInt()
  @Min(0)
  y: number;
}

export class UpdateUserDashboardLayoutDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardLayoutItemDto)
  layout: DashboardLayoutItemDto[];
}
