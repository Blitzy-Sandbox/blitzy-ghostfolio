import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import { Module } from '@nestjs/common';

import { UserFinancialProfileController } from './user-financial-profile.controller';
import { UserFinancialProfileService } from './user-financial-profile.service';

/**
 * `UserFinancialProfileModule` is the NestJS feature module that owns the
 * per-user `FinancialProfile` data API introduced by AAP § 0.1.1. It mounts
 * the HTTP endpoints
 *
 *     GET   /api/v1/user/financial-profile
 *     PATCH /api/v1/user/financial-profile
 *
 * via `UserFinancialProfileController`, persists data through
 * `UserFinancialProfileService` (the single canonical read/write path for
 * `FinancialProfile` rows), and is wired into the application root via the
 * `imports` array of `apps/api/src/app/app.module.ts` per AAP § 0.4.1.1.
 *
 * RULE 1 (Module Isolation, AAP § 0.7.1.1): `UserFinancialProfileService`
 * is intentionally re-listed in the `exports` array so that
 * `AiChatModule` and `RebalancingModule` can resolve it via NestJS's DI
 * container without ever importing the service file by direct path.
 * AAP § 0.1.2.1 names this service as the single explicit cross-module
 * exception: it is the only provider of this module that is exposed
 * outside of it. The `UserFinancialProfileController` is intentionally
 * NOT exported — it is an HTTP transport boundary, never a callable
 * dependency of another module.
 *
 * GLOBAL SCOPE: This module is deliberately NOT decorated with
 * `@Global()`. AAP § 0.7.1.1 (Rule 1) requires consumer modules to
 * explicitly import `UserFinancialProfileModule` so the cross-module
 * dependency edge is visible in the Nx project graph and ESLint module
 * boundary checks. Making the module global would silently expose the
 * service everywhere and obscure the dependency contract.
 *
 * SCOPE: The provider is registered with NestJS's default singleton
 * scope, so `UserFinancialProfileService` resolves to a single shared
 * instance across `UserFinancialProfileController` (in this module),
 * `AiChatService` (in `AiChatModule`), and `RebalancingService` (in
 * `RebalancingModule`). All three consumers therefore share the same
 * `PrismaService` connection pool transitively.
 */
@Module({
  controllers: [UserFinancialProfileController],
  exports: [UserFinancialProfileService],
  imports: [PrismaModule],
  providers: [UserFinancialProfileService]
})
export class UserFinancialProfileModule {}
