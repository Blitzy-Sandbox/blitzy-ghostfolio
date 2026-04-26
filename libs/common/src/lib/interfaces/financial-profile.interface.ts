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

/**
 * Client-to-server payload shape for `PATCH /api/v1/user/financial-profile`.
 *
 * Server-only fields (`userId`, `createdAt`, `updatedAt`) are omitted —
 * those are sourced authoritatively by the server: `userId` is read from
 * the JWT, `createdAt` is set by the database default on first upsert, and
 * `updatedAt` is set by the `@updatedAt` Prisma directive.
 *
 * The form component constructs a payload of this exact shape (no
 * placeholder values for omitted fields). The server-side
 * `FinancialProfileDto` validates the payload via `class-validator`; any
 * client-supplied `userId`/`createdAt`/`updatedAt` would be discarded by
 * the DTO, but the tightened type prevents them from being sent in the
 * first place.
 */
export type FinancialProfilePatchPayload = Omit<
  FinancialProfile,
  'createdAt' | 'updatedAt' | 'userId'
>;
