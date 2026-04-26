import { RiskTolerance } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
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

  @IsString()
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
