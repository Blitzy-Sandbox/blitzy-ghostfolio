import { IsObject, IsOptional } from 'class-validator';

/**
 * Request body for `POST /api/v1/ai/rebalancing`.
 *
 * Per AAP § 0.5.1.1, the only field is the optional `targetAllocation`
 * override. Concrete rebalancing logic lives in `RebalancingService`,
 * which sources its primary inputs from injected services
 * (`PortfolioService`, `UserFinancialProfileService`); this DTO carries
 * only optional overrides supplied by the caller.
 *
 * Validation depth note: `@IsObject()` ensures the value is a plain
 * object but does NOT validate that inner record values are numbers.
 * Per AAP § 0.5.1.1 ("Optional override fields (e.g., `targetAllocation`)"),
 * the contract is intentionally lenient — a richer typed shape (e.g.,
 * `Array<{ symbol: string; percentage: number }>` validated with
 * `@ValidateNested({ each: true })`) can be introduced when the public
 * contract for `targetAllocation` is finalized. Until that point, the
 * server-side `RebalancingService` is the authoritative coercion layer:
 * it casts numeric expectations and rejects malformed values with a
 * `BadRequestException`.
 *
 * Per-field length validation note (QA Checkpoint 14, Issue #3):
 *
 *   The QA security audit recommends `@MaxLength` on string DTO fields
 *   as a defense-in-depth measure against denial-of-service-style
 *   payloads. This DTO has **no top-level string fields** — `IsObject`
 *   covers the only declared field, and the keys of `Record<string,
 *   number>` are object property names that `class-validator` cannot
 *   constrain via `@MaxLength` (which targets string-typed values, not
 *   property keys).
 *
 *   Defense-in-depth for this DTO is provided by:
 *     1. The global Express body-parser limit (`useBodyParser('json',
 *        { limit: '10mb' })` in `apps/api/src/main.ts`), which caps the
 *        entire request payload size.
 *     2. `@IsObject()` rejects non-object types (string, number, array,
 *        etc.) before the body reaches the service layer.
 *     3. `@IsOptional()` allows the field to be omitted entirely; an
 *        absent `targetAllocation` is the canonical happy path and
 *        does not exercise the upstream `RebalancingService` override
 *        wiring.
 *
 *   When the typed object shape for `targetAllocation` is finalized,
 *   any newly-introduced string field (e.g., a `symbol` property on a
 *   nested `TargetAllocationEntryDto`) MUST be decorated with
 *   `@MaxLength(...)` at that point — the principle expressed in
 *   `chat-request.dto.ts` and `financial-profile.dto.ts` applies to
 *   every string-typed DTO field across the new modules.
 */
export class RebalancingRequestDto {
  @IsObject()
  @IsOptional()
  targetAllocation?: Record<string, number>;
}
