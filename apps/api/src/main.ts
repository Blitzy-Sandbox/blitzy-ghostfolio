import {
  BULL_BOARD_ROUTE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  STORYBOOK_PATH,
  SUPPORTED_LANGUAGE_CODES
} from '@ghostfolio/common/config';

import {
  Logger,
  LogLevel,
  ValidationPipe,
  VersioningType
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

async function bootstrap() {
  const configApp = await NestFactory.create(AppModule);
  const configService = configApp.get<ConfigService>(ConfigService);
  let customLogLevels: LogLevel[];

  try {
    customLogLevels = JSON.parse(
      configService.get<string>('LOG_LEVELS')
    ) as LogLevel[];
  } catch {}

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      customLogLevels ??
      (environment.production
        ? ['error', 'log', 'warn']
        : ['debug', 'error', 'log', 'verbose', 'warn'])
  });

  // Hide the `X-Powered-By: Express` response header so the underlying
  // framework is not disclosed on any response (QA F5 Issue 2). `helmet`'s
  // `hidePoweredBy` (enabled by the base middleware below) also removes it;
  // disabling it at the Express app level guarantees it is never emitted
  // regardless of middleware ordering.
  app.disable('x-powered-by');

  // Restrict CORS to an explicit origin allowlist for authenticated-API
  // hardening (QA F5 Issue 3) rather than the previous permissive wildcard
  // (`Access-Control-Allow-Origin: *`). The allowlist defaults to the
  // application's own public origin (`ROOT_URL`, falling back to the build's
  // `environment.rootUrl`); an optional comma-separated `CORS_ORIGINS`
  // environment variable overrides it for deployments whose front-end is
  // served from one or more additional origins. `credentials` is disabled
  // because the API authenticates exclusively via the
  // `Authorization: Bearer <JWT>` header, never cookies.
  const corsOrigins = configService.get<string>('CORS_ORIGINS');
  const rootUrl = configService.get<string>('ROOT_URL') ?? environment.rootUrl;
  const allowedOrigins = (corsOrigins ? corsOrigins.split(',') : [rootUrl])
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.enableCors({
    credentials: false,
    origin: allowedOrigins
  });

  app.enableVersioning({
    defaultVersion: '1',
    type: VersioningType.URI
  });
  app.setGlobalPrefix('api', {
    exclude: [
      `${BULL_BOARD_ROUTE.substring(1)}{/*wildcard}`,
      'sitemap.xml',
      ...SUPPORTED_LANGUAGE_CODES.map((languageCode) => {
        // Exclude language-specific routes with an optional wildcard
        return `/${languageCode}{/*wildcard}`;
      })
    ]
  });

  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true
    })
  );

  // Refine PR Directive 7 — Swagger / OpenAPI documentation.
  //
  // Mounts the auto-generated OpenAPI spec at the top-level `/docs` route
  // (Swagger UI) and `/docs-json` (raw JSON). The directive explicitly
  // requires `/docs`, NOT `/api/docs`, so we set `useGlobalPrefix: false`
  // to bypass the `setGlobalPrefix('api')` registered above. The
  // `jsonDocumentUrl` is set to `'docs-json'` (without a leading slash)
  // so that the resolved URL is `/docs-json` per the directive.
  //
  // `addBearerAuth()` registers the project's existing JWT-bearer
  // authentication scheme as the default security definition for all
  // documented endpoints — operators can paste a JWT into the Swagger UI
  // "Authorize" dialog to exercise the four AAP-mandated endpoints
  // (`POST /api/v1/ai/chat`, `POST /api/v1/ai/rebalancing`,
  // `GET /api/v1/user/financial-profile`,
  // `PATCH /api/v1/user/financial-profile`) and the Snowflake admin
  // trigger from the same UI.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Ghostfolio API')
    .setDescription(
      'OpenAPI documentation for the Ghostfolio API, including the AI Portfolio Intelligence Layer endpoints (chat, rebalancing, financial profile).'
    )
    .setVersion(environment.version || '0.0.0')
    .addBearerAuth()
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup('docs', app, swaggerDocument, {
    jsonDocumentUrl: 'docs-json',
    useGlobalPrefix: false
  });

  // Support 10mb csv/json files for importing activities
  app.useBodyParser('json', { limit: '10mb' });

  app.use(cookieParser());

  // Apply baseline HTTP security-hardening headers UNCONDITIONALLY (QA F5
  // Issue 1). Previously `helmet` was wired only inside the subscription
  // branch below, so default (non-subscription) deployments shipped without
  // `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, or HSTS.
  // This base middleware enables `noSniff`, `frameguard` (X-Frame-Options:
  // SAMEORIGIN), `hidePoweredBy`, `referrerPolicy`, and `hsts` (honored only
  // under HTTPS) for every response on every endpoint.
  //
  // The Content-Security-Policy and the cross-origin isolation policies are
  // intentionally left OFF in this base layer: helmet's default CSP would
  // block Angular's inline styles/scripts and the Swagger UI at `/docs`, and
  // COOP/COEP/CORP would needlessly isolate the API and break cross-origin
  // asset loading. When `ENABLE_FEATURE_SUBSCRIPTION` is enabled, the
  // dedicated middleware below layers on the Stripe-aware CSP (and keeps
  // Cross-Origin-Opener-Policy disabled for Internet Identity).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false
    })
  );

  if (configService.get<string>('ENABLE_FEATURE_SUBSCRIPTION') === 'true') {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith(STORYBOOK_PATH)) {
        next();
      } else {
        helmet({
          contentSecurityPolicy: {
            directives: {
              connectSrc: ["'self'", 'https://js.stripe.com'], // Allow connections to Stripe
              frameSrc: ["'self'", 'https://js.stripe.com'], // Allow loading frames from Stripe
              scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com'], // Allow inline scripts and scripts from Stripe
              scriptSrcAttr: ["'self'", "'unsafe-inline'"], // Allow inline event handlers
              styleSrc: ["'self'", "'unsafe-inline'"] // Allow inline styles
            }
          },
          crossOriginOpenerPolicy: false // Disable Cross-Origin-Opener-Policy header (for Internet Identity)
        })(req, res, next);
      }
    });
  }

  const HOST = configService.get<string>('HOST') || DEFAULT_HOST;
  const PORT = configService.get<number>('PORT') || DEFAULT_PORT;

  await app.listen(PORT, HOST, () => {
    logLogo();

    let address = app.getHttpServer().address();

    if (typeof address === 'object') {
      const addressObject = address;
      let host = addressObject.address;

      if (addressObject.family === 'IPv6') {
        host = `[${addressObject.address}]`;
      }

      address = `${host}:${addressObject.port}`;
    }

    Logger.log(`Listening at http://${address}`);
    Logger.log('');
  });
}

function logLogo() {
  Logger.log('   ________               __  ____      ___');
  Logger.log('  / ____/ /_  ____  _____/ /_/ __/___  / (_)___');
  Logger.log(' / / __/ __ \\/ __ \\/ ___/ __/ /_/ __ \\/ / / __ \\');
  Logger.log('/ /_/ / / / / /_/ (__  ) /_/ __/ /_/ / / / /_/ /');
  Logger.log(
    `\\____/_/ /_/\\____/____/\\__/_/  \\____/_/_/\\____/ ${environment.version}`
  );
  Logger.log('');
}

bootstrap();
