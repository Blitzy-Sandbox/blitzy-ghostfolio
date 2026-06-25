import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { DashboardLayoutItem } from '@ghostfolio/common/interfaces';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserDashboardLayout } from '@prisma/client';

/**
 * `UserDashboardLayoutService` is the single canonical read/upsert path for
 * the per-user `UserDashboardLayout` record introduced by the single-canvas
 * modular-dashboard refactor (AAP § 0.1.1).
 *
 * It is registered as a provider in `UserModule` and consumed exclusively by
 * `UserDashboardLayoutController` (HTTP `GET` and `PATCH /api/v1/user/layout`).
 *
 * SECURITY (Rule 8): every Prisma operation is scoped by `where: { userId }`
 * using the JWT-verified user identifier supplied by the caller. The caller
 * (controller) sources `userId` from `request.user.id` — this service does
 * NOT read any HTTP request context, keeping it transport-agnostic.
 *
 * OBSERVABILITY (AAP § 0.7.2): every public method accepts an optional
 * `correlationId` generated at the controller boundary and propagated through
 * to the structured `Logger` calls so a single request can be traced
 * end-to-end. When the caller omits `correlationId` (e.g. a unit test), log
 * lines are emitted without the `[<correlationId>]` prefix.
 */
@Injectable()
export class UserDashboardLayoutService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Reads the dashboard layout for the given authenticated user.
   *
   * Returns `null` when no record exists (Prisma `findUnique` does not throw
   * in this case). The HTTP controller maps `null` to HTTP 404, which the
   * client `DashboardLayoutService` translates to `null` to drive the
   * blank-canvas / catalog-auto-open first-visit experience (Rule 10).
   *
   * @param userId        Authenticated user id (from JWT, NEVER from request body).
   * @param correlationId Optional request-scoped correlation id propagated
   *                      from the controller boundary for end-to-end tracing.
   */
  public async findByUserId(
    userId: string,
    correlationId?: string
  ): Promise<UserDashboardLayout | null> {
    try {
      return await this.prismaService.userDashboardLayout.findUnique({
        where: { userId }
      });
    } catch (error) {
      Logger.error(
        this.formatLogMessage(
          `Failed to read UserDashboardLayout for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

      throw error;
    }
  }

  /**
   * Creates or updates the dashboard layout for the given authenticated user.
   * `userId` is the immutable primary key on `UserDashboardLayout`, so a
   * single `upsert` is idempotent — re-running `PATCH` with the same payload
   * updates the row in place rather than producing a duplicate.
   *
   * The validated `layout` array (`dto.layout`) is persisted into the
   * `layoutData` JSONB column. The `as unknown as Prisma.InputJsonValue` cast
   * is the documented Prisma 7 idiom for narrowing a typed array into a JSON
   * column input.
   *
   * @param userId        Authenticated user id (from JWT, NEVER from request body).
   * @param layout        Validated grid-item array from `dto.layout`.
   * @param correlationId Optional request-scoped correlation id for tracing.
   */
  public async upsertForUser(
    userId: string,
    layout: DashboardLayoutItem[],
    correlationId?: string
  ): Promise<UserDashboardLayout> {
    try {
      const layoutData = layout as unknown as Prisma.InputJsonValue;

      return await this.prismaService.userDashboardLayout.upsert({
        create: {
          userId,
          layoutData
        },
        update: {
          layoutData
        },
        where: { userId }
      });
    } catch (error) {
      Logger.error(
        this.formatLogMessage(
          `Failed to upsert UserDashboardLayout for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          correlationId
        ),
        'UserDashboardLayoutService'
      );

      throw error;
    }
  }

  /**
   * Prefixes a structured log message with `[<correlationId>] ` when a
   * non-empty correlation id was propagated from the caller, otherwise
   * returns the message unchanged. Copied verbatim from the
   * `UserFinancialProfileService` template for cross-cutting log consistency.
   */
  private formatLogMessage(
    message: string,
    correlationId: string | undefined
  ): string {
    return correlationId ? `[${correlationId}] ${message}` : message;
  }
}
