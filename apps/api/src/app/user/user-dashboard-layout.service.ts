import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, UserDashboardLayout } from '@prisma/client';

import { UpdateUserDashboardLayoutDto } from './dtos/update-user-dashboard-layout.dto';

/**
 * `UserDashboardLayoutService` is the single canonical read/write path for the
 * per-user `UserDashboardLayout` record introduced by the Modular Dashboard
 * feature (AAP § 0.1.1). It is registered + exported by `UserModule` and
 * consumed by `UserDashboardLayoutController` (HTTP `GET`/`PATCH
 * /api/v1/user/layout`).
 *
 * The service is intentionally stateless beyond its injected `PrismaService`
 * dependency. It mirrors `UserFinancialProfileService` but is simpler: the
 * layout payload is an opaque JSON blob, so there is NO business validation
 * and NO DTO→Prisma column mapping — `layoutData` is forwarded directly.
 *
 * SECURITY: Every Prisma operation is scoped by `where: { userId }` using the
 * JWT-verified user id supplied by the caller. The caller (the controller)
 * sources `userId` from `request.user.id` — this service NEVER reads HTTP
 * request context, keeping it transport-agnostic.
 *
 * OBSERVABILITY: Every public method accepts an optional `correlationId`
 * generated at the controller boundary and propagated to the structured
 * `Logger` so a single request can be traced end-to-end. When omitted (e.g.
 * unit tests), log lines are emitted without the `[<correlationId>]` prefix.
 */
@Injectable()
export class UserDashboardLayoutService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Reads the dashboard layout for the given authenticated user.
   *
   * Returns `null` when no record exists (Prisma `findUnique` does not throw
   * on a miss). The HTTP controller maps `null` to HTTP 404 — never HTTP 500 —
   * so a first-time user (no saved layout) is distinguishable from an error.
   *
   * @param userId        Authenticated user id (from JWT, NEVER request body).
   * @param correlationId Optional request-scoped correlation id for log tracing.
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
   * `userId` is the immutable primary key, so a single `upsert` is idempotent —
   * re-running `PATCH` with the same payload updates the row in place rather
   * than producing a duplicate or a uniqueness violation.
   *
   * `layoutData` is a Prisma `Json` column; the `as unknown as
   * Prisma.InputJsonValue` cast is the documented Prisma 7 idiom for narrowing
   * the typed DTO shape into the JSON column input.
   *
   * @param userId        Authenticated user id (from JWT, NEVER request body).
   * @param dto           Validated `UpdateUserDashboardLayoutDto` payload.
   * @param correlationId Optional request-scoped correlation id for log tracing.
   */
  public async upsertForUser(
    userId: string,
    dto: UpdateUserDashboardLayoutDto,
    correlationId?: string
  ): Promise<UserDashboardLayout> {
    try {
      return await this.prismaService.userDashboardLayout.upsert({
        create: {
          userId,
          layoutData: dto.layoutData as unknown as Prisma.InputJsonValue
        },
        update: {
          layoutData: dto.layoutData as unknown as Prisma.InputJsonValue
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
   * returns the message unchanged. Mirrors the precedent
   * `UserFinancialProfileService.formatLogMessage(...)`.
   */
  private formatLogMessage(message: string, correlationId?: string): string {
    return correlationId ? `[${correlationId}] ${message}` : message;
  }
}
