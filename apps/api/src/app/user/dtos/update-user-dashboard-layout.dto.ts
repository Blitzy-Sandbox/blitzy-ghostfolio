import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
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
  /**
   * Versioned dashboard layout payload — the sole top-level field of the
   * `PATCH /api/v1/user/layout` request body.
   *
   * Rationale (input-validation hardening / CWE-20): `@IsDefined()` makes
   * `layoutData` REQUIRED at the validation boundary. `@ValidateNested()`
   * alone only validates a value when it is present and silently skips an
   * omitted or `undefined` value, so without `@IsDefined()` a malformed body
   * such as `{}` (or `{ layoutData: undefined }`) would pass the global
   * `ValidationPipe` (`whitelist` / `transform` / `forbidNonWhitelisted`) and
   * reach the controller and service. With `@IsDefined()` first, such bodies
   * fail fast with a clear HTTP 400 before any persistence logic runs. The
   * decorator order matters: `@IsDefined()` (presence) → `@ValidateNested()`
   * (shape) → `@Type()` (class-transformer instantiation for nested
   * validation).
   */
  @IsDefined()
  @ValidateNested()
  @Type(() => LayoutDataDto)
  layoutData: LayoutDataDto;
}
