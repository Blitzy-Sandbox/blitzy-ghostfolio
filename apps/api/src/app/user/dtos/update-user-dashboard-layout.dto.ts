import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateNested
} from 'class-validator';

/**
 * Maximum permitted length, in UTF-16 code units, of a dashboard module's
 * stable `moduleKey` identifier accepted by `PATCH /api/v1/user/layout`.
 *
 * Rationale (defense-in-depth / DoS bound): module keys are short, stable
 * registry identifiers (e.g. `"portfolio-overview"`, `"holdings"`,
 * `"ai-chat"`). `100` is a generous ceiling for any legitimate key; a longer
 * value is overwhelmingly likely to be accidental (copy-paste) or adversarial
 * (a DoS probe). Enforced at the DTO boundary so requests fail fast with a
 * clear HTTP 400 before reaching the persistence layer. Mirrors the
 * `INVESTMENT_GOAL_LABEL_MAX_LENGTH = 200` precedent rationale.
 */
const MODULE_KEY_MAX_LENGTH = 100;

/**
 * Maximum number of module entries permitted in a single layout payload.
 *
 * Rationale (defense-in-depth / DoS bound): the module catalog ships ~12
 * module types; `50` allows comfortable headroom (including repeated modules)
 * while bounding the JSONB row size and the per-request validation work. A
 * larger `items` array is rejected with HTTP 400 by the global ValidationPipe
 * before any persistence occurs.
 */
const MAX_MODULES = 50;

export class DashboardLayoutItemDto {
  @IsString()
  @MaxLength(MODULE_KEY_MAX_LENGTH)
  moduleKey: string;

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
}

export class LayoutDataDto {
  @IsInt()
  schemaVersion: number;

  @IsArray()
  @ArrayMaxSize(MAX_MODULES)
  @ValidateNested({ each: true })
  @Type(() => DashboardLayoutItemDto)
  items: DashboardLayoutItemDto[];
}

export class UpdateUserDashboardLayoutDto {
  @ValidateNested()
  @Type(() => LayoutDataDto)
  layoutData: LayoutDataDto;
}
