import { ActivitiesModule } from '@ghostfolio/api/app/activities/activities.module';
import { MetricsModule } from '@ghostfolio/api/app/metrics/metrics.module';
import { SubscriptionModule } from '@ghostfolio/api/app/subscription/subscription.module';
import { RedactValuesInResponseModule } from '@ghostfolio/api/interceptors/redact-values-in-response/redact-values-in-response.module';
import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { I18nModule } from '@ghostfolio/api/services/i18n/i18n.module';
import { ImpersonationModule } from '@ghostfolio/api/services/impersonation/impersonation.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';
import { PropertyModule } from '@ghostfolio/api/services/property/property.module';
import { TagModule } from '@ghostfolio/api/services/tag/tag.module';

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

/**
 * Functional middleware that stamps every response on the dashboard-layout
 * endpoints (`GET`/`PATCH /api/v1/user/layout`) with an `X-Correlation-ID` and
 * `Cache-Control: no-store` header.
 *
 * Middleware runs BEFORE the route's guards and pipes, so these headers are
 * present even on the short-circuit error responses produced by
 * `AuthGuard('jwt')` (401), `HasPermissionGuard` (403), and the global
 * `ValidationPipe` (400) — not only on the controller-executed 200/404 paths
 * that previously set them (QA F9 Issue 4). The generated correlation id is set
 * on the response header; the controller reads it back (via
 * `response.getHeader('X-Correlation-ID')`) and reuses it for its own
 * header + service-log propagation, so a single id correlates the middleware,
 * guards, controller, and service end-to-end. It is scoped to
 * `UserDashboardLayoutController` only (see `configure` below), so no other
 * endpoint's headers change.
 */
export function layoutResponseHeadersMiddleware(
  _request: Request,
  response: Response,
  next: NextFunction
): void {
  response.setHeader('X-Correlation-ID', randomUUID());
  // Authenticated, user-specific layout data must never be cached by the
  // browser or any shared/intermediary cache (QA F5 Issue 1 / F9 Issue 4).
  response.setHeader('Cache-Control', 'no-store');
  next();
}

@Module({
  controllers: [UserController, UserDashboardLayoutController],
  exports: [UserDashboardLayoutService, UserService],
  imports: [
    ActivitiesModule,
    ConfigurationModule,
    I18nModule,
    ImpersonationModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET_KEY,
      signOptions: { expiresIn: '30 days' }
    }),
    MetricsModule,
    PrismaModule,
    PropertyModule,
    RedactValuesInResponseModule,
    SubscriptionModule,
    TagModule
  ],
  providers: [UserDashboardLayoutService, UserService]
})
export class UserModule implements NestModule {
  /**
   * Applies `layoutResponseHeadersMiddleware` to every route declared by
   * `UserDashboardLayoutController`. Passing the controller class (rather than a
   * literal path string) makes Nest resolve the middleware mount point from the
   * controller's fully-qualified routes — including the global `api` prefix and
   * the `v1` URI version — so it correctly targets `/api/v1/user/layout` for
   * both `GET` and `PATCH`, and ONLY those routes (QA F9 Issue 4).
   */
  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(layoutResponseHeadersMiddleware)
      .forRoutes(UserDashboardLayoutController);
  }
}
