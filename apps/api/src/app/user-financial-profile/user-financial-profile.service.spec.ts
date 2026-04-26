import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { FinancialProfile, RiskTolerance } from '@prisma/client';

import { FinancialProfileDto } from './dtos/financial-profile.dto';
import { UserFinancialProfileService } from './user-financial-profile.service';

/**
 * Replaces the real `PrismaService` constructor with a minimal mock that
 * exposes only the two `financialProfile` delegate methods consumed by
 * `UserFinancialProfileService` (`findUnique` and `upsert`). All other
 * Prisma methods are intentionally absent so any production-code regression
 * that introduces an unscoped query — e.g. `findFirst({})`, `findMany({})`,
 * or `create({})` instead of `upsert({...})` — fails this spec immediately
 * with a clear `TypeError: ... is not a function` rather than silently
 * passing.
 *
 * The mock is declared with `jest.mock(...)` at module-scope rather than
 * within `beforeEach` so it is hoisted above the import that resolves
 * `PrismaService`. This mirrors the established Ghostfolio convention used
 * in `apps/api/src/services/data-provider/data-enhancer/yahoo-finance/yahoo-finance.service.spec.ts`.
 */
jest.mock('@ghostfolio/api/services/prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => {
      return {
        financialProfile: {
          findUnique: jest.fn(),
          upsert: jest.fn()
        }
      };
    })
  };
});

/**
 * Unit tests for `UserFinancialProfileService`.
 *
 * The spec verifies the three security-critical guarantees enumerated in
 * AAP § 0.5.1.4 and AAP § 0.7.1.5 (Rule 5 — FinancialProfile Authorization):
 *
 *   1. Every Prisma call observed contains `where: { userId }` scoped to
 *      the explicit `userId` argument supplied to the service method.
 *   2. User-1 cannot read user-2's row — the service never widens the
 *      `where` clause to omit, alias, or replace the caller-supplied
 *      `userId`.
 *   3. `upsertForUser` is idempotent — re-running the upsert with the same
 *      payload uses Prisma's `upsert` API (not `create`) and therefore does
 *      not produce duplicate rows or a uniqueness violation.
 *
 * The tests use direct service instantiation with a mocked `PrismaService`
 * (per Ghostfolio convention in `apps/api/src/services/benchmark/benchmark.service.spec.ts`),
 * deliberately bypassing the NestJS DI container; the service is a pure
 * stateless wrapper around `prismaService.financialProfile.*` and does not
 * require any other framework infrastructure.
 */
describe('UserFinancialProfileService', () => {
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';

  let prismaService: PrismaService;
  let service: UserFinancialProfileService;

  beforeEach(() => {
    // Re-create both collaborators per test so that mock call history is
    // never carried across `it(...)` blocks. Each test exercises a fresh
    // jest.fn() spy for `findUnique` and `upsert`.
    prismaService = new PrismaService(null);
    service = new UserFinancialProfileService(prismaService);
  });

  // -------------------------------------------------------------------------
  // findByUserId — Rule 5 + 404 handling
  // -------------------------------------------------------------------------

  it('returns null when no financial profile exists for the user', async () => {
    (
      prismaService.financialProfile.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    const result = await service.findByUserId(USER_1_ID);

    // The controller is contractually obligated to map `null` to HTTP 404
    // (per AAP § 0.7.5.2 "Financial profile gate"), so the service MUST
    // resolve with `null` rather than throw on a missing record.
    expect(result).toBeNull();
    expect(prismaService.financialProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
  });

  it('scopes findByUserId to where: { userId } using the passed userId', async () => {
    const record: FinancialProfile = {
      createdAt: new Date(),
      investmentGoals: [] as any,
      monthlyDebtObligations: 1500,
      monthlyIncome: 8000,
      retirementTargetAge: 65,
      retirementTargetAmount: 1_000_000,
      riskTolerance: 'MEDIUM' as RiskTolerance,
      timeHorizonYears: 30,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (
      prismaService.financialProfile.findUnique as jest.Mock
    ).mockResolvedValueOnce(record);

    await service.findByUserId(USER_1_ID);

    // Rule 5: every Prisma operation on `FinancialProfile` MUST include
    // `where: { userId }`. Verify the clause is present, scoped to the
    // exact userId argument, and the call was made exactly once.
    expect(prismaService.financialProfile.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaService.financialProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
  });

  it("does not return another user's row when called with the authenticated user's ID", async () => {
    // Simulate Prisma correctly returning null when querying user-1 even
    // though user-2 has a record in the real database. The service must
    // never widen the `where` clause to read user-2's row when called with
    // user-1's ID.
    (
      prismaService.financialProfile.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    const result = await service.findByUserId(USER_1_ID);

    expect(result).toBeNull();
    // The query was scoped to USER_1_ID and never USER_2_ID — confirming
    // Rule 5's authorization-isolation guarantee.
    expect(prismaService.financialProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
    expect(prismaService.financialProfile.findUnique).not.toHaveBeenCalledWith({
      where: { userId: USER_2_ID }
    });
  });

  // -------------------------------------------------------------------------
  // upsertForUser — Rule 5 + idempotency
  // -------------------------------------------------------------------------

  it('calls prisma.financialProfile.upsert with where: { userId } scoped to the authenticated user', async () => {
    const dto: FinancialProfileDto = {
      investmentGoals: [
        {
          label: 'Retirement',
          targetAmount: 1_000_000,
          targetDate: '2055-01-01'
        }
      ],
      monthlyDebtObligations: 1500,
      monthlyIncome: 8000,
      retirementTargetAge: 65,
      retirementTargetAmount: 1_000_000,
      riskTolerance: 'MEDIUM' as RiskTolerance,
      timeHorizonYears: 30
    };
    const upsertedRecord: FinancialProfile = {
      createdAt: new Date(),
      investmentGoals: dto.investmentGoals as any,
      monthlyDebtObligations: dto.monthlyDebtObligations,
      monthlyIncome: dto.monthlyIncome,
      retirementTargetAge: dto.retirementTargetAge,
      retirementTargetAmount: dto.retirementTargetAmount,
      riskTolerance: dto.riskTolerance,
      timeHorizonYears: dto.timeHorizonYears,
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (prismaService.financialProfile.upsert as jest.Mock).mockResolvedValueOnce(
      upsertedRecord
    );

    const result = await service.upsertForUser(USER_1_ID, dto);

    // The persisted row is returned to the caller verbatim.
    expect(result).toBe(upsertedRecord);
    expect(prismaService.financialProfile.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = (prismaService.financialProfile.upsert as jest.Mock).mock
      .calls[0][0];

    // Rule 5: the `where` clause is scoped to the JWT-derived userId.
    expect(upsertArgs.where).toEqual({ userId: USER_1_ID });
    // The `create` branch MUST attach the row to the authenticated userId
    // because `userId` is the foreign-key + primary-key on the new row.
    expect(upsertArgs.create.userId).toBe(USER_1_ID);
    // The `update` branch deliberately omits `userId` because (a) it is
    // immutable on existing rows and (b) it is already implied by the
    // `where` clause; including it again would be redundant and could
    // mask a future bug where `update.userId` is set from request body.
    expect(upsertArgs.update.userId).toBeUndefined();
  });

  it('is idempotent — calling upsertForUser twice with same input does not duplicate (uses prisma upsert, not create)', async () => {
    const dto: FinancialProfileDto = {
      investmentGoals: [],
      monthlyDebtObligations: 1500,
      monthlyIncome: 8000,
      retirementTargetAge: 65,
      retirementTargetAmount: 1_000_000,
      riskTolerance: 'MEDIUM' as RiskTolerance,
      timeHorizonYears: 30
    };
    const baseRecord = {
      investmentGoals: [] as any,
      monthlyDebtObligations: dto.monthlyDebtObligations,
      monthlyIncome: dto.monthlyIncome,
      retirementTargetAge: dto.retirementTargetAge,
      retirementTargetAmount: dto.retirementTargetAmount,
      riskTolerance: dto.riskTolerance,
      timeHorizonYears: dto.timeHorizonYears,
      userId: USER_1_ID
    };
    (prismaService.financialProfile.upsert as jest.Mock)
      .mockResolvedValueOnce({
        ...baseRecord,
        createdAt: new Date(),
        updatedAt: new Date()
      } as FinancialProfile)
      .mockResolvedValueOnce({
        ...baseRecord,
        createdAt: new Date(),
        updatedAt: new Date()
      } as FinancialProfile);

    const first = await service.upsertForUser(USER_1_ID, dto);
    const second = await service.upsertForUser(USER_1_ID, dto);

    // Idempotency (AAP § 0.7.1.7 / § 0.7.5.2): both calls succeed and
    // both delegate to `prisma.financialProfile.upsert`, never `create`.
    // Because the mock `financialProfile` delegate exposes only `upsert`
    // (and `findUnique`), any attempt by the service to fall back to
    // `prisma.financialProfile.create({...})` would throw `TypeError:
    // prismaService.financialProfile.create is not a function` and fail
    // the test — making this assertion a structural guarantee that the
    // service path for an existing row is `upsert`, not `create`.
    expect(prismaService.financialProfile.upsert).toHaveBeenCalledTimes(2);
    expect((prismaService.financialProfile as any).create).toBeUndefined();
    expect(first.userId).toBe(USER_1_ID);
    expect(second.userId).toBe(USER_1_ID);
  });

  it("scopes upsertForUser to where: { userId } using the explicitly passed userId, never another user's ID", async () => {
    const dto: FinancialProfileDto = {
      investmentGoals: [],
      monthlyDebtObligations: 3000,
      monthlyIncome: 12_000,
      retirementTargetAge: 70,
      retirementTargetAmount: 2_000_000,
      riskTolerance: 'HIGH' as RiskTolerance,
      timeHorizonYears: 40
    };
    (prismaService.financialProfile.upsert as jest.Mock).mockResolvedValueOnce({
      createdAt: new Date(),
      investmentGoals: [] as any,
      monthlyDebtObligations: dto.monthlyDebtObligations,
      monthlyIncome: dto.monthlyIncome,
      retirementTargetAge: dto.retirementTargetAge,
      retirementTargetAmount: dto.retirementTargetAmount,
      riskTolerance: dto.riskTolerance,
      timeHorizonYears: dto.timeHorizonYears,
      updatedAt: new Date(),
      userId: USER_2_ID
    } as FinancialProfile);

    await service.upsertForUser(USER_2_ID, dto);

    const upsertArgs = (prismaService.financialProfile.upsert as jest.Mock).mock
      .calls[0][0];

    // Authorization-isolation: the upsert must be scoped to USER_2_ID
    // (the explicitly-passed argument) and NEVER to USER_1_ID.
    expect(upsertArgs.where).toEqual({ userId: USER_2_ID });
    expect(upsertArgs.where).not.toEqual({ userId: USER_1_ID });
    expect(upsertArgs.create.userId).toBe(USER_2_ID);
  });

  it('passes all DTO fields into the prisma upsert create and update branches', async () => {
    const dto: FinancialProfileDto = {
      investmentGoals: [
        {
          label: 'House Down Payment',
          targetAmount: 100_000,
          targetDate: '2030-06-01'
        }
      ],
      monthlyDebtObligations: 1800,
      monthlyIncome: 9000,
      retirementTargetAge: 67,
      retirementTargetAmount: 1_500_000,
      riskTolerance: 'LOW' as RiskTolerance,
      timeHorizonYears: 35
    };
    (prismaService.financialProfile.upsert as jest.Mock).mockResolvedValueOnce({
      createdAt: new Date(),
      investmentGoals: dto.investmentGoals as any,
      monthlyDebtObligations: dto.monthlyDebtObligations,
      monthlyIncome: dto.monthlyIncome,
      retirementTargetAge: dto.retirementTargetAge,
      retirementTargetAmount: dto.retirementTargetAmount,
      riskTolerance: dto.riskTolerance,
      timeHorizonYears: dto.timeHorizonYears,
      updatedAt: new Date(),
      userId: USER_1_ID
    } as FinancialProfile);

    await service.upsertForUser(USER_1_ID, dto);

    const upsertArgs = (prismaService.financialProfile.upsert as jest.Mock).mock
      .calls[0][0];

    // Verify every scalar field from the DTO is forwarded to the `create`
    // branch. Drift between DTO and Prisma input — e.g., a renamed column
    // or a missing field — would surface here as a mismatched assertion.
    expect(upsertArgs.create.retirementTargetAge).toBe(67);
    expect(upsertArgs.create.retirementTargetAmount).toBe(1_500_000);
    expect(upsertArgs.create.timeHorizonYears).toBe(35);
    expect(upsertArgs.create.riskTolerance).toBe('LOW');
    expect(upsertArgs.create.monthlyIncome).toBe(9000);
    expect(upsertArgs.create.monthlyDebtObligations).toBe(1800);
    expect(upsertArgs.create.investmentGoals).toEqual(dto.investmentGoals);

    // The `update` branch carries the same scalar payload (minus `userId`,
    // which is immutable on existing rows). Verifying that update mirrors
    // create guarantees that re-running `PATCH` actually persists the new
    // values rather than silently no-op'ing.
    expect(upsertArgs.update.retirementTargetAge).toBe(67);
    expect(upsertArgs.update.retirementTargetAmount).toBe(1_500_000);
    expect(upsertArgs.update.timeHorizonYears).toBe(35);
    expect(upsertArgs.update.riskTolerance).toBe('LOW');
    expect(upsertArgs.update.monthlyIncome).toBe(9000);
    expect(upsertArgs.update.monthlyDebtObligations).toBe(1800);
    expect(upsertArgs.update.investmentGoals).toEqual(dto.investmentGoals);
  });
});
