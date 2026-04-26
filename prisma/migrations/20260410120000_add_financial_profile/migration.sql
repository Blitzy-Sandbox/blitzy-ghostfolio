-- CreateEnum
CREATE TYPE "public"."RiskTolerance" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "public"."FinancialProfile" (
    "userId" TEXT NOT NULL,
    "retirementTargetAge" INTEGER NOT NULL,
    "retirementTargetAmount" DOUBLE PRECISION NOT NULL,
    "timeHorizonYears" INTEGER NOT NULL,
    "riskTolerance" "public"."RiskTolerance" NOT NULL,
    "monthlyIncome" DOUBLE PRECISION NOT NULL,
    "monthlyDebtObligations" DOUBLE PRECISION NOT NULL,
    "investmentGoals" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialProfile_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "public"."FinancialProfile" ADD CONSTRAINT "FinancialProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
