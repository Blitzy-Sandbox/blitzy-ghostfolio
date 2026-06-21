import {
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_MODULE_KEYS
} from '@ghostfolio/common/interfaces';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsString,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface
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
 * `INVESTMENT_GOAL_LABEL_MAX_LENGTH = 200` precedent rationale. Retained as a
 * defense-in-depth backstop alongside the stricter `@IsIn` allow-list below.
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

/**
 * Returns `true` when the two grid rectangles occupy any shared cell.
 *
 * Each item occupies the half-open column range `[x, x + cols)` and the
 * half-open row range `[y, y + rows)`. Two axis-aligned rectangles intersect
 * iff they overlap on BOTH axes (standard separating-axis test). Adjacent
 * (edge-touching) items do not overlap.
 */
function dashboardItemsOverlap(
  a: DashboardLayoutItemDto,
  b: DashboardLayoutItemDto
): boolean {
  return (
    a.x < b.x + b.cols &&
    b.x < a.x + a.cols &&
    a.y < b.y + b.rows &&
    b.y < a.y + a.rows
  );
}

/**
 * Collects every DOMAIN-level violation in a layout `items` array.
 *
 * Domain validation goes beyond the per-field shape checks (which the
 * item-level `class-validator` decorators already enforce) and rejects
 * layouts that are structurally well-formed but semantically corrupt — the
 * exact class of payloads that previously persisted with HTTP 200 and then
 * broke client-side hydration (QA Issue #2: duplicate, off-grid, and
 * overlapping items producing Angular `NG0955` and Gridster out-of-bounds
 * warnings):
 *
 *   1. Duplicate `moduleKey` — a module type may appear at most once.
 *   2. Off-grid geometry — every item must satisfy `x >= 0` and
 *      `x + cols <= DASHBOARD_GRID_COLUMNS` (the fixed 12-column grid).
 *   3. Overlapping items — no two modules may occupy the same grid cells.
 *
 * Unknown / empty `moduleKey` values are intentionally NOT re-checked here:
 * they are rejected at the item level by `@IsIn(DASHBOARD_MODULE_KEYS)`, so
 * re-reporting them would only duplicate the validation message.
 *
 * Only structurally-valid geometry participates in the bounds/overlap checks
 * so that malformed items (non-integer or below-minimum dimensions) are not
 * double-reported — their per-field decorators own those messages.
 *
 * The function is pure and stateless, which lets the (singleton) validator
 * constraint reuse it for both the boolean verdict and the human-readable
 * `defaultMessage` without sharing mutable state across concurrent requests.
 */
function collectDashboardLayoutViolations(value: unknown): string[] {
  const violations: string[] = [];

  if (!Array.isArray(value)) {
    // Non-array values are reported by `@IsArray` on the `items` property;
    // surfacing a domain message here would be misleading.
    return violations;
  }

  const items = value as DashboardLayoutItemDto[];

  // 1) Duplicate module keys.
  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();

  for (const item of items) {
    const moduleKey = item?.moduleKey;

    if (typeof moduleKey === 'string' && moduleKey.length > 0) {
      if (seenKeys.has(moduleKey)) {
        duplicateKeys.add(moduleKey);
      } else {
        seenKeys.add(moduleKey);
      }
    }
  }

  if (duplicateKeys.size > 0) {
    violations.push(
      `duplicate moduleKey(s) are not allowed: ${Array.from(duplicateKeys).join(
        ', '
      )}`
    );
  }

  // Restrict geometric checks to items whose geometry is structurally valid.
  const geometricItems = items.filter(
    (item) =>
      item != null &&
      Number.isInteger(item.x) &&
      Number.isInteger(item.y) &&
      Number.isInteger(item.cols) &&
      Number.isInteger(item.rows)
  );

  // 2) Off-grid geometry.
  const offGridItems = geometricItems.filter(
    (item) =>
      item.x < 0 || item.cols < 0 || item.x + item.cols > DASHBOARD_GRID_COLUMNS
  );

  if (offGridItems.length > 0) {
    violations.push(
      `off-grid geometry (each item must satisfy x >= 0 and x + cols <= ${DASHBOARD_GRID_COLUMNS}): ${offGridItems
        .map(
          (item) => `${item.moduleKey ?? '?'}@(x:${item.x}, cols:${item.cols})`
        )
        .join(', ')}`
    );
  }

  // 3) Overlapping items (bounded message to cap payload size).
  let overlapPairs = 0;
  const overlapExamples: string[] = [];

  for (let i = 0; i < geometricItems.length; i++) {
    for (let j = i + 1; j < geometricItems.length; j++) {
      if (dashboardItemsOverlap(geometricItems[i], geometricItems[j])) {
        overlapPairs++;

        if (overlapExamples.length < 3) {
          overlapExamples.push(
            `${geometricItems[i].moduleKey ?? '?'} & ${
              geometricItems[j].moduleKey ?? '?'
            }`
          );
        }
      }
    }
  }

  if (overlapPairs > 0) {
    violations.push(
      `overlapping items are not allowed (${overlapPairs} pair(s)): ${overlapExamples.join(
        ', '
      )}${overlapPairs > overlapExamples.length ? ', …' : ''}`
    );
  }

  return violations;
}

/**
 * Class-level `class-validator` constraint enforcing the dashboard layout
 * DOMAIN invariants (uniqueness, in-bounds geometry, non-overlap) that the
 * per-field item decorators cannot express. Applied to `LayoutDataDto.items`
 * via `@Validate(...)`. Follows the in-repo `IsAfter1970Constraint` precedent
 * (`libs/common/src/lib/validator-constraints/is-after-1970.ts`).
 */
@ValidatorConstraint({ async: false, name: 'dashboardLayoutItemsValid' })
export class DashboardLayoutItemsConstraint implements ValidatorConstraintInterface {
  public defaultMessage(args: ValidationArguments): string {
    const violations = collectDashboardLayoutViolations(args?.value);

    return violations.length > 0
      ? `layoutData.items failed domain validation — ${violations.join('; ')}`
      : 'layoutData.items failed domain validation';
  }

  public validate(value: unknown): boolean {
    return collectDashboardLayoutViolations(value).length === 0;
  }
}

export class DashboardLayoutItemDto {
  /**
   * Stable module-type identifier.
   *
   * `@IsIn(DASHBOARD_MODULE_KEYS)` rejects unknown AND empty-string keys with
   * HTTP 400 using the SAME shared contract the client module registry uses to
   * render modules (`libs/common` `DASHBOARD_MODULE_KEYS`). This closes QA
   * Issue #2: previously any string passed `@IsString`, so unknown/empty keys
   * persisted with 200 and then silently disappeared (or warned) during client
   * hydration. `@MaxLength` is retained as a defense-in-depth DoS backstop.
   */
  @IsString()
  @IsIn([...DASHBOARD_MODULE_KEYS])
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

  /**
   * The ordered list of placed modules.
   *
   * Two layers of validation apply:
   *   • Per-item shape — `@ValidateNested` + `@Type` run every
   *     `DashboardLayoutItemDto` decorator (key allow-list, integer geometry,
   *     2×2 minimums).
   *   • Cross-item domain — `@Validate(DashboardLayoutItemsConstraint)`
   *     rejects duplicate keys, off-grid geometry, and overlapping items
   *     (QA Issue #2). `@ArrayMaxSize` bounds the payload (DoS defense).
   */
  @IsArray()
  @ArrayMaxSize(MAX_MODULES)
  @ValidateNested({ each: true })
  @Type(() => DashboardLayoutItemDto)
  @Validate(DashboardLayoutItemsConstraint)
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
