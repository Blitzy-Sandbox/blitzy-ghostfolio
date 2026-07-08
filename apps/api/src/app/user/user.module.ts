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

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutObservabilityMiddleware } from './user-dashboard-layout.middleware';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

/**
 * `UserModule` wires the user domain — including the additive dashboard-layout
 * slice (AAP § 0.1.1) — into the application DI graph.
 *
 * OBSERVABILITY (AAP § 0.6.1 / § 0.8.4): `MetricsModule` is imported so that
 * `UserDashboardLayoutObservabilityMiddleware` can inject the shared
 * `MetricsService` singleton and record the `dashboard_layout_requests_total`
 * counter and `dashboard_layout_latency_seconds` histogram consumed by
 * `ops/dashboards/dashboard-layout.json`. The middleware — rather than the
 * controller/service — owns metric + correlation-id emission because it runs
 * BEFORE the guard/pipe boundary, so it also observes guard-rejected `401`/
 * `403` responses (recorded as `outcome=unauthorized`) and stamps the
 * `X-Correlation-ID` header on every terminal outcome. This keeps the
 * controller (2-arg) and service (1-arg) constructors unchanged.
 */
@Module({
  controllers: [UserController, UserDashboardLayoutController],
  exports: [UserService],
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
   * Applies the dashboard-layout observability middleware to exactly the two
   * layout routes (`GET`/`PATCH /api/v1/user/layout`). Scoping to the
   * controller keeps the `dashboard_layout_*` metrics limited to layout
   * traffic and avoids instrumenting the unrelated `UserController` routes.
   */
  public configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(UserDashboardLayoutObservabilityMiddleware)
      .forRoutes(UserDashboardLayoutController);
  }
}
