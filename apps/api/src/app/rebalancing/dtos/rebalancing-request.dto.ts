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
 */
export class RebalancingRequestDto {
  @IsObject()
  @IsOptional()
  targetAllocation?: Record<string, number>;
}
