import { RiskTolerance } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from 'class-validator';

/**
 * Maximum permitted length, in UTF-16 code units, of an investment-goal
 * `label` string accepted by `PATCH /api/v1/user/financial-profile`.
 *
 * Rationale (defense-in-depth — QA Checkpoint 14, Issue #3):
 *
 *   `FinancialProfile.investmentGoals` is persisted as a Prisma `Json`
 *   column whose row-level size is bounded only by the global Express
 *   body-parser limit (10 MB) and PostgreSQL's per-row TOAST ceiling
 *   (~1 GB). Without a per-field cap, a single label can be arbitrarily
 *   long — wasting storage, inflating downstream Snowflake mirror payload
 *   sizes, and burdening UI rendering of the Angular goal-list.
 *
 *   `200` is a generous ceiling for human-meaningful goal labels such as
 *   `"Retirement"`, `"Down Payment on House"`, or `"Children's Education
 *   Fund"`. A label longer than 200 characters is overwhelmingly likely
 *   to be either accidental (a copy-paste mistake) or adversarial (a
 *   denial-of-service probe). The limit is enforced at the DTO boundary
 *   so requests fail fast with a clear validation error before reaching
 *   the persistence layer.
 */
const INVESTMENT_GOAL_LABEL_MAX_LENGTH = 200;

export class InvestmentGoalDto {
  @IsString()
  @MaxLength(INVESTMENT_GOAL_LABEL_MAX_LENGTH)
  label: string;

  @IsNumber()
  @Min(0)
  targetAmount: number;

  /**
   * ISO-8601 date string representing the target completion date for the goal.
   *
   * Validated as an ISO-8601 date string (per AAP § 0.5.1.1 contract for
   * `investmentGoals[].targetDate`) so callers cannot submit arbitrary text
   * such as `"foo"`. The decorator accepts both date-only (`2030-12-31`) and
   * full date-time forms (`2030-12-31T00:00:00Z`).
   */
  @IsDateString()
  targetDate: string;
}

export class FinancialProfileDto {
  @IsArray()
  @Type(() => InvestmentGoalDto)
  @ValidateNested({ each: true })
  investmentGoals: InvestmentGoalDto[];

  @IsNumber()
  @Min(0)
  monthlyDebtObligations: number;

  @IsNumber()
  @Min(0)
  monthlyIncome: number;

  @IsInt()
  @Max(100)
  @Min(18)
  retirementTargetAge: number;

  @IsNumber()
  @Min(0)
  retirementTargetAmount: number;

  @IsEnum(RiskTolerance)
  riskTolerance: RiskTolerance;

  @IsInt()
  @Min(1)
  timeHorizonYears: number;
}
