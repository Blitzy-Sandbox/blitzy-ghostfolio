import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserDashboardLayout } from '@prisma/client';

import { DashboardLayoutDto } from './dtos/dashboard-layout.dto';

/**
 * `UserDashboardLayoutService` is the single canonical read/write path for
 * the per-user `UserDashboardLayout` record introduced by AAP § 0.1.1
 * (single-canvas modular dashboard). It abstracts all Prisma access to the
 * `UserDashboardLayout` table behind a repository-style API.
 *
 * It is registered as a provider by `UserModule` and consumed by
 * `UserDashboardLayoutController` (HTTP `GET`/`PATCH /api/v1/user/layout`).
 *
 * The service is intentionally stateless beyond its injected `PrismaService`
 * dependency and is transport-agnostic: it reads NO HTTP request context.
 *
 * SECURITY (AAP § 0.7.3 — Rule 8): Every Prisma operation is scoped by
 * `where: { userId }` using the JWT-verified user identifier supplied by the
 * caller. The controller sources `userId` from `request.user.id`; this
 * service never reads it from a request body/query/param.
 *
 * OBSERVABILITY (AAP § 0.6.1 / § 0.8.4): Each public method accepts an
 * optional `correlationId` (UUID-shaped) generated at the controller
 * boundary and propagated into the structured `Logger` calls so a single
 * request can be traced end-to-end. When omitted (e.g. a unit test), log
 * lines are emitted without the `[<correlationId>]` prefix.
 */
@Injectable()
export class UserDashboardLayoutService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Reads the dashboard layout for the given authenticated user.
   *
   * Returns `null` when no record exists (Prisma `findUnique` does not throw
   * in this case). The controller maps `null` to HTTP 404 — never HTTP 500 —
   * so the client can distinguish a first-visit (no saved layout) from a
   * genuine error and map 404 → null on its side.
   *
   * Rule 8 compliance: the `where: { userId }` clause is required and sourced
   * from the caller (JWT-derived), never from the request body.
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
   * `userId` is the immutable primary key, so a single `upsert` is idempotent:
   * re-issuing `PATCH` with the same payload updates the row in place rather
   * than creating a duplicate or triggering a uniqueness violation.
   *
   * The `create` branch attaches the new row to the supplied `userId` (FK to
   * `User.id`, cascade delete). Both branches write the `layoutData` JSON
   * column. The `dto as unknown as Prisma.InputJsonValue` cast is the
   * documented Prisma 7 idiom for narrowing a typed DTO into a `Json` column
   * input (mirrors `mapDtoToPrismaInput` in the financial-profile service).
   *
   * Rule 8 compliance: every component of the upsert (`where`, `create`,
   * `update`) is scoped to the `userId` parameter (JWT-derived).
   */
  public async upsertForUser(
    userId: string,
    dto: DashboardLayoutDto,
    correlationId?: string
  ): Promise<UserDashboardLayout> {
    try {
      return await this.prismaService.userDashboardLayout.upsert({
        create: {
          userId,
          layoutData: dto as unknown as Prisma.InputJsonValue
        },
        update: {
          layoutData: dto as unknown as Prisma.InputJsonValue
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
   * returns the message unchanged — keeping the log format consistent with
   * the sibling `UserFinancialProfileService`.
   */
  private formatLogMessage(
    message: string,
    correlationId: string | undefined
  ): string {
    return correlationId ? `[${correlationId}] ${message}` : message;
  }
}
