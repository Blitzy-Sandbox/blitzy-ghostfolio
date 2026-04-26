export type RiskTolerance = 'LOW' | 'MEDIUM' | 'HIGH';

export interface InvestmentGoal {
  label: string;
  targetAmount: number;
  targetDate: string;
}

export interface FinancialProfile {
  userId: string;
  retirementTargetAge: number;
  retirementTargetAmount: number;
  timeHorizonYears: number;
  riskTolerance: RiskTolerance;
  monthlyIncome: number;
  monthlyDebtObligations: number;
  investmentGoals: InvestmentGoal[];
  createdAt: Date | string;
  updatedAt: Date | string;
}
