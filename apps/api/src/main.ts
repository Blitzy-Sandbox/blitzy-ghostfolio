import {
  BULL_BOARD_ROUTE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  STORYBOOK_PATH,
  SUPPORTED_LANGUAGE_CODES
} from '@ghostfolio/common/config';

import {
  HttpStatus,
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

  app.enableCors();

  // QA Issue #14 — security hardening (minimal, platform-safe subset).
  //
  // Two zero-/low-risk hardening measures applied globally to every response:
  //   • Remove the framework-fingerprinting `X-Powered-By: Express` header,
  //     which leaks the server technology to attackers.
  //   • Set `X-Content-Type-Options: nosniff` so browsers do not MIME-sniff
  //     response bodies (defense against content-type confusion attacks).
  //
  // Broader hardening — a full Helmet Content-Security-Policy, a non-wildcard
  // CORS allow-list, and per-endpoint `Cache-Control` — is a PLATFORM-WIDE
  // posture decision deliberately left out of this feature scope: the existing
  // Ghostfolio public API intentionally serves wildcard CORS for its public
  // consumers, and a strict CSP must be validated against the Angular client
  // (inline styles/scripts) before it can be enabled without breaking the SPA.
  // The two measures below are safe because they neither restrict origins nor
  // alter response bodies.
  app.disable('x-powered-by');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');

    next();
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

  // QA Issue #1 — map malformed-JSON request bodies to HTTP 400.
  //
  // The global JSON body parser (above) throws a `SyntaxError` tagged
  // `type: 'entity.parse.failed'` with `status: 400` when a request body is
  // not valid JSON (e.g. `{"layoutData":` or trailing garbage). Without an
  // explicit error-handling middleware that failure surfaced as a MISLEADING
  // HTTP 404 `Cannot <METHOD> <url>` (the parse error propagated past the Nest
  // router and fell through to the not-found handler) instead of a 400.
  //
  // This four-argument Express error-handling middleware (arity 4 marks it as
  // an error handler) intercepts ONLY body-parse failures and returns a clear
  // 400 with the standard Nest-style JSON error shape; every other error is
  // forwarded untouched via `next(error)` so existing exception handling is
  // unaffected. Registered immediately after the body parser so it sits in the
  // middleware stack to catch the parser's `next(error)`.
  app.use(
    (
      error: Error & { status?: number; statusCode?: number; type?: string },
      _request: Request,
      response: Response,
      next: NextFunction
    ) => {
      const isBodyParseError =
        error instanceof SyntaxError &&
        (error.type === 'entity.parse.failed' ||
          error.status === HttpStatus.BAD_REQUEST ||
          error.statusCode === HttpStatus.BAD_REQUEST);

      if (isBodyParseError) {
        return response.status(HttpStatus.BAD_REQUEST).json({
          error: 'Bad Request',
          message: 'Malformed JSON in request body',
          statusCode: HttpStatus.BAD_REQUEST
        });
      }

      return next(error);
    }
  );

  app.use(cookieParser());

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
