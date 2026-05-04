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
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

/**
 * Path prefix scoped to the user-dashboard-layout REST endpoints introduced
 * by the modular dashboard refactor (AAP § 0.1.1, § 0.4.1, § 0.6.1.10).
 *
 * The Express middleware registered below this constant attaches the
 * `X-Correlation-ID` header AND a strict `Cache-Control: no-store, private`
 * header to every response on these routes — including HTTP 401 (unauthenticated),
 * HTTP 403 (forbidden), and HTTP 400 (validation error) responses — which
 * NestJS guards and pipes short-circuit BEFORE the controller body executes.
 *
 * Resolves QA Checkpoint 9 findings:
 *   - 1.6.3 — Cache-Control header missing on authenticated responses (MEDIUM).
 *   - AAP-Compliance #11 — X-Correlation-ID missing on 401/403/400 responses (LOW).
 *
 * The pattern is a literal path prefix because Express's mounted-middleware
 * `app.use(prefix, fn)` matches any request whose URL begins with the prefix,
 * which is exactly the semantic we need (matches `/api/v1/user/layout` AND any
 * future sub-routes such as `/api/v1/user/layout/:id`).
 */
const USER_DASHBOARD_LAYOUT_API_PATH = '/api/v1/user/layout';

/**
 * Defensive request-body size limit applied to PATCH /api/v1/user/layout per
 * AAP § 0.8.3 ("Defensive PATCH-body size limit at NestJS
 * `app.use(json({ limit: '512kb' }))`").
 *
 * The global JSON body parser (further below) keeps the 10 MB ceiling required
 * by the activities CSV import endpoint; this layout-specific parser is mounted
 * BEFORE the global parser so that requests targeting the layout API exhaust
 * this stricter limit FIRST and receive a proper HTTP 413 PayloadTooLargeError
 * response from `body-parser` rather than the loose 10 MB default.
 *
 * Resolves QA Checkpoint 9 finding AAP-Compliance #16 / Edge Case 19
 * ("11MB body returns 404 instead of 413") for the layout endpoints, by
 * tightening the limit to a value far below any legitimate layout payload
 * (a 50-item layout with verbose moduleIds is well under 50 KB).
 */
const USER_DASHBOARD_LAYOUT_BODY_LIMIT_BYTES = '512kb';

/**
 * Header value used by the layout-specific Cache-Control middleware.
 *
 * `no-store` forbids any cache from storing the response; `private` is an
 * additional defense for shared caches that nominally honor `no-store` but
 * historically have had implementation gaps. `must-revalidate` forces an
 * intermediate cache (if it ever did store) to revalidate before reuse.
 *
 * Per OWASP Secure Headers Project guidance for authenticated REST
 * responses returning user-specific data (here, the per-user
 * `UserDashboardLayout` record).
 */
const USER_DASHBOARD_LAYOUT_CACHE_CONTROL =
  'no-store, no-cache, must-revalidate, private';

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

  // ───────────────────────────────────────────────────────────────────────
  // Security hardening — applied to ALL responses
  // ───────────────────────────────────────────────────────────────────────
  //
  // Resolves QA Checkpoint 9 findings:
  //   - 1.5.1 (LOW)    — `X-Powered-By: Express` framework disclosure.
  //   - 1.6.1 (MEDIUM) — Missing `X-Content-Type-Options: nosniff`.
  //   - 1.6.2 (MEDIUM) — Missing `X-Frame-Options` (clickjacking).
  //
  // `app.disable('x-powered-by')` removes the default Express
  // framework-disclosure header so probes cannot fingerprint the server
  // technology from the response shape alone.
  //
  // `app.use(helmet({...}))` is now applied UNCONDITIONALLY (previously
  // gated on `ENABLE_FEATURE_SUBSCRIPTION === 'true'`). The minimal
  // configuration enables every helmet default that does not conflict
  // with the existing app surface (Storybook iframes, the Swagger UI
  // CDN-served bundle, the Internet-Identity Cross-Origin-Opener-Policy
  // requirement). Specifically:
  //   - `xContentTypeOptions: nosniff`         ← enabled (default).
  //   - `xFrameOptions: SAMEORIGIN`            ← enabled (default).
  //   - `strictTransportSecurity`              ← enabled (default).
  //   - `xDnsPrefetchControl`                  ← enabled (default).
  //   - `xDownloadOptions`                     ← enabled (default).
  //   - `xPermittedCrossDomainPolicies`        ← enabled (default).
  //   - `xXssProtection`                       ← enabled (default).
  //   - `referrerPolicy`                       ← enabled (default).
  //   - `originAgentCluster`                   ← enabled (default).
  //   - `contentSecurityPolicy: false`         ← DISABLED globally; CSP
  //                                              applied conditionally
  //                                              ONLY on subscription
  //                                              builds where Stripe is
  //                                              loaded into the page,
  //                                              because the Storybook
  //                                              build embeds a wide
  //                                              third-party-script
  //                                              surface that the
  //                                              default CSP would
  //                                              break.
  //   - `crossOriginOpenerPolicy: false`       ← DISABLED to preserve
  //                                              Internet-Identity flow
  //                                              (matches existing
  //                                              ENABLE_FEATURE_SUBSCRIPTION
  //                                              configuration).
  //   - `crossOriginResourcePolicy: false`     ← DISABLED so the
  //                                              browser-side Angular
  //                                              client and any CDN-
  //                                              served static assets
  //                                              continue to load.
  //   - `crossOriginEmbedderPolicy: false`     ← DISABLED to preserve
  //                                              the existing Swagger
  //                                              UI behavior which loads
  //                                              its CSS/JS via cross-
  //                                              origin script tags.
  //
  // The conditional CSP block further below (still gated on
  // ENABLE_FEATURE_SUBSCRIPTION) layers a Stripe-friendly CSP ONLY for
  // subscription builds. Helmet middleware is idempotent across paths
  // so re-running on subscription builds is safe.
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false
    })
  );

  // ───────────────────────────────────────────────────────────────────────
  // Layout-endpoint-specific middleware — runs BEFORE NestJS guards/pipes
  // ───────────────────────────────────────────────────────────────────────
  //
  // Resolves QA Checkpoint 9 findings:
  //   - 1.6.3 (MEDIUM) — Missing `Cache-Control: no-store` on authenticated
  //                       responses.
  //   - AAP-Compliance #11 (LOW) — `X-Correlation-ID` missing on 401 / 403 /
  //                       400 responses produced by AuthGuard / HasPermissionGuard /
  //                       ValidationPipe before the controller body runs.
  //
  // This middleware is mounted at the layout API path prefix so it runs ONLY
  // for `/api/v1/user/layout*` requests. NestJS's auth/permission guards and
  // its global ValidationPipe execute INSIDE the request lifecycle that this
  // middleware has already started, so the headers below are emitted on every
  // response from these routes — including the HTTP 401, 403, and 400 short-
  // circuits that previously omitted the correlation id and cache directive.
  //
  // The middleware also stashes the correlationId on the request so the
  // controller can reuse the SAME id (rather than generating a fresh UUID
  // that would diverge from the header value the client already received).
  // The fallback in the controller (a fresh UUID when `request.correlationId`
  // is undefined) preserves backward compatibility with unit tests that build
  // synthetic request objects without going through this middleware.
  //
  // We also accept a caller-supplied `X-Correlation-ID` request header so
  // that distributed-tracing systems (e.g., when the Angular client begins
  // forwarding its own correlationId) can propagate end-to-end ids through
  // the NestJS layer rather than having the server overwrite them.
  app.use(
    USER_DASHBOARD_LAYOUT_API_PATH,
    (req: Request, res: Response, next: NextFunction) => {
      const incomingCorrelationId =
        typeof req.headers['x-correlation-id'] === 'string'
          ? (req.headers['x-correlation-id'] as string)
          : undefined;
      const correlationId = incomingCorrelationId ?? randomUUID();
      res.setHeader('X-Correlation-ID', correlationId);
      res.setHeader('Cache-Control', USER_DASHBOARD_LAYOUT_CACHE_CONTROL);
      (req as Request & { correlationId?: string }).correlationId =
        correlationId;
      next();
    }
  );

  // Layout-endpoint-specific JSON body parser — mounted BEFORE the global
  // parser further below so layout requests exhaust the stricter limit
  // first and receive a proper HTTP 413 PayloadTooLargeError when violated.
  // Resolves QA Checkpoint 9 finding AAP-Compliance #16 / Edge Case 19.
  app.use(
    USER_DASHBOARD_LAYOUT_API_PATH,
    bodyParser.json({ limit: USER_DASHBOARD_LAYOUT_BODY_LIMIT_BYTES })
  );

  // Error-handling middleware for the layout endpoint to ensure
  // `body-parser` errors (e.g. `entity.too.large`, `entity.parse.failed`)
  // surface as proper HTTP status codes (413 / 400) rather than being
  // funneled into NestJS's default not-found handler that ignores the
  // upstream error and returns a confusing `404 — Cannot PATCH ...`
  // response.
  //
  // This Express-style error middleware (4-arg signature) is invoked ONLY
  // when an upstream middleware called `next(err)` with an Error. The
  // `err.type` field is set by `body-parser` to one of:
  //   - `entity.too.large`   → HTTP 413 PayloadTooLargeError.
  //   - `entity.parse.failed` → HTTP 400 BadRequest (malformed JSON).
  //   - other                → HTTP 400 (catch-all for body-parser errors).
  //
  // Setting `Content-Type: application/json` BEFORE writing ensures the
  // error response shape matches the rest of the API (NestJS uses JSON
  // by default). Returning the error JSON directly here is intentional —
  // we do NOT delegate to NestJS's exception filter because the request
  // has not yet entered NestJS's pipeline; calling `next(err)` would
  // bypass NestJS's filter entirely and Express's default handler returns
  // HTML, breaking JSON-only clients.
  //
  // Resolves QA Checkpoint 9 finding AAP-Compliance #16 / Edge Case 19
  // (LOW) — "11MB body returns 404 instead of 413".
  app.use(
    USER_DASHBOARD_LAYOUT_API_PATH,
    (
      err: Error & { type?: string; status?: number },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (!err) {
        next();
        return;
      }
      const errorType = err.type;
      let statusCode: number;
      let message: string;
      let httpError: string;
      if (errorType === 'entity.too.large') {
        statusCode = 413;
        message = 'Payload Too Large';
        httpError = 'Payload Too Large';
      } else if (
        errorType === 'entity.parse.failed' ||
        errorType === 'entity.verify.failed' ||
        errorType === 'charset.unsupported' ||
        errorType === 'encoding.unsupported'
      ) {
        statusCode = 400;
        message = 'Bad Request';
        httpError = 'Bad Request';
      } else {
        // Unknown error from body-parser or another upstream middleware.
        // Fall through to NestJS by calling `next(err)` so the global
        // exception filter can map it. The conditional ensures we do
        // not double-handle errors that NestJS already classifies.
        next(err);
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(statusCode).json({
        statusCode,
        message,
        error: httpError
      });
    }
  );

  // ───────────────────────────────────────────────────────────────────────
  // CORS configuration — env-var-driven origin allowlist
  // ───────────────────────────────────────────────────────────────────────
  //
  // Resolves QA Checkpoint 9 finding 1.7.1 (LOW) — wildcard CORS Allow-Origin.
  //
  // When `ALLOWED_ORIGINS` is set (comma-separated list of allowed origin
  // URLs), CORS is restricted to that allowlist. When unset (or empty),
  // we preserve the historical behavior of `app.enableCors()` (open CORS)
  // for backwards compatibility with local-development setups that do not
  // configure the env var. Production deployments MUST set
  // `ALLOWED_ORIGINS` per `.env.example`.
  //
  // `Access-Control-Allow-Credentials` is intentionally NOT set, so the
  // browser will refuse to send cookies and HTTP-only credentials cross-
  // origin even if the allowlist permits the origin — JWT bearer tokens
  // are explicitly attached by the client, not auto-forwarded by the
  // browser.
  const allowedOrigins = configService.get<string>('ALLOWED_ORIGINS');
  if (allowedOrigins && allowedOrigins.trim() !== '') {
    app.enableCors({
      origin: allowedOrigins.split(',').map((origin) => origin.trim()),
      credentials: false
    });
  } else {
    app.enableCors();
  }

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
