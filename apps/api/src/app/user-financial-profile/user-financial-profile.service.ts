import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';
import { FinancialProfile, Prisma } from '@prisma/client';

import { FinancialProfileDto } from './dtos/financial-profile.dto';

/**
 * `UserFinancialProfileService` is the single canonical read/write path for
 * the per-user `FinancialProfile` record introduced by AAP § 0.1.1.
 *
 * It is exported by `UserFinancialProfileModule` and consumed by:
 * - `UserFinancialProfileController` (HTTP `GET` and `PATCH /api/user/financial-profile`)
 * - `AiChatService` (system-prompt personalization for Feature B)
 * - `RebalancingService` (goal data referenced from each `goalReference` in Feature C)
 *
 * The service is intentionally stateless beyond its injected `PrismaService`
 * dependency, so multiple consumer modules can safely inject the same
 * NestJS-managed singleton.
 *
 * SECURITY (AAP § 0.7.1.5 — Rule 5): Every Prisma operation on
 * `FinancialProfile` is scoped by `where: { userId }` using the JWT-verified
 * user identifier supplied by the caller. The caller (controller or
 * downstream service) is responsible for sourcing `userId` from
 * `request.user.id` — this service does NOT read any HTTP request context,
 * keeping it transport-agnostic.
 */
@Injectable()
export class UserFinancialProfileService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Reads the financial profile for the given authenticated user.
   *
   * Returns `null` when no record exists for the user (Prisma `findUnique`
   * does not throw in this case). The HTTP controller is responsible for
   * mapping `null` to HTTP 404 — never to HTTP 500 (per AAP § 0.7.5.2,
   * "Financial profile gate"). Surfacing a missing-record case as `null`
   * rather than a thrown exception preserves the controller's ability to
   * differentiate "no record yet" (first-time setup) from genuine errors.
   *
   * Rule 5 compliance: the `where: { userId }` clause is required and
   * sourced from the caller — never from the request body.
   */
  public async findByUserId(userId: string): Promise<FinancialProfile | null> {
    return this.prismaService.financialProfile.findUnique({
      where: { userId }
    });
  }

  /**
   * Creates or updates the financial profile for the given authenticated
   * user. The `userId` is the immutable primary key on `FinancialProfile`,
   * so a single `upsert` call is idempotent — re-running `PATCH` with the
   * same payload updates the record in place rather than producing a
   * duplicate row or a uniqueness violation.
   *
   * The `create` branch attaches the new row to the supplied `userId` (FK
   * to `User.id`, cascade delete). The `update` branch only writes the
   * non-key columns; `userId` itself is immutable on the existing row.
   *
   * Rule 5 compliance: every component of the upsert (`where`, `create`,
   * `update`) is scoped to the `userId` parameter, which the caller MUST
   * source from the JWT-verified user — never from the request body.
   *
   * @param userId Authenticated user id (from JWT, NEVER from request body).
   * @param dto    Validated `FinancialProfileDto` payload.
   * @returns      The persisted `FinancialProfile` row.
   */
  public async upsertForUser(
    userId: string,
    dto: FinancialProfileDto
  ): Promise<FinancialProfile> {
    try {
      const profileData = this.mapDtoToPrismaInput(dto);

      return await this.prismaService.financialProfile.upsert({
        create: {
          userId,
          ...profileData
        },
        update: profileData,
        where: { userId }
      });
    } catch (error) {
      Logger.error(error, 'UserFinancialProfileService');

      throw error;
    }
  }

  /**
   * Maps the validated `FinancialProfileDto` to the scalar columns of the
   * Prisma `FinancialProfile` model. The `userId` foreign key is supplied
   * by the caller and intentionally NOT included here — the upsert layer
   * adds it on the create branch and omits it from the update branch.
   *
   * The `investmentGoals` field is declared as `Json` in the Prisma schema
   * but typed as `InvestmentGoalDto[]` in the DTO; the cast through
   * `unknown` to `Prisma.InputJsonValue` is the documented Prisma 7 idiom
   * for narrowing typed arrays into the JSON column input shape.
   *
   * The return type `Omit<Prisma.FinancialProfileCreateInput, 'user'>` is
   * intentionally chosen so the same value satisfies both branches of the
   * upsert via Prisma's `XOR<>` input typing:
   *   - `create: { userId, ...profileData }` matches
   *     `FinancialProfileUncheckedCreateInput`.
   *   - `update: profileData` matches `FinancialProfileUpdateInput` (every
   *     required scalar value is a structural subtype of the field's
   *     optional `FieldUpdateOperationsInput | T` union).
   */
  private mapDtoToPrismaInput(
    dto: FinancialProfileDto
  ): Omit<Prisma.FinancialProfileCreateInput, 'user'> {
    return {
      investmentGoals: dto.investmentGoals as unknown as Prisma.InputJsonValue,
      monthlyDebtObligations: dto.monthlyDebtObligations,
      monthlyIncome: dto.monthlyIncome,
      retirementTargetAge: dto.retirementTargetAge,
      retirementTargetAmount: dto.retirementTargetAmount,
      riskTolerance: dto.riskTolerance,
      timeHorizonYears: dto.timeHorizonYears
    };
  }
}
