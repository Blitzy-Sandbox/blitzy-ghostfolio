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
  Min,
  ValidateNested
} from 'class-validator';

export class InvestmentGoalDto {
  @IsString()
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
