/**
 * Jest setup file for the `api` project.
 *
 * This file is referenced by `setupFiles` in `apps/api/jest.config.ts` and is
 * loaded by Jest **before** each test file is evaluated, ensuring that the
 * required environment variables exist on `process.env` prior to any code that
 * reads them being imported.
 *
 * Why this file exists
 * --------------------
 * Several portfolio-calculator unit specs directly instantiate
 * `new ConfigurationService()` in their `beforeEach` hook. The
 * `ConfigurationService` constructor calls
 * `cleanEnv(process.env, { ACCESS_TOKEN_SALT: str(), JWT_SECRET_KEY: str(), ... })`
 * (from the `envalid` package). When either `ACCESS_TOKEN_SALT` or
 * `JWT_SECRET_KEY` is absent on `process.env`, `envalid`'s default reporter
 * calls `process.exit(1)`, which Jest reports as
 * `Jest worker encountered 4 child process exceptions, exceeding retry limit`
 * for every spec that constructs a `ConfigurationService`. This breaks the
 * test suite even though the production code paths that depend on those
 * variables are never executed in unit tests.
 *
 * What this file does
 * -------------------
 * It sets safe, non-secret placeholder values for the mandatory variables on
 * `process.env` **only if they are not already set**. The fallback values are
 * clearly tagged with a `test-` prefix so they cannot be confused with
 * real production credentials, and the operator-supplied `process.env` always
 * wins (e.g. when CI exports its own values or when `dotenv` is configured at
 * the shell level).
 *
 * Scope
 * -----
 * This file is **test-only** infrastructure. It is never bundled into the
 * production build (the `api:build` webpack target excludes `*.spec.ts` and
 * `test-setup.ts`). Production runtime continues to require operator-supplied
 * `ACCESS_TOKEN_SALT` and `JWT_SECRET_KEY` exactly as before.
 */

// Required by `apps/api/src/services/configuration/configuration.service.ts`.
// `envalid.str()` (no default) demands a non-empty value; without these the
// constructor calls `process.exit(1)` during spec evaluation.
if (!process.env.ACCESS_TOKEN_SALT) {
  process.env.ACCESS_TOKEN_SALT = 'test-access-token-salt';
}

if (!process.env.JWT_SECRET_KEY) {
  process.env.JWT_SECRET_KEY = 'test-jwt-secret-key';
}

// `OIDC_*` variables are conditionally required when
// `ENABLE_FEATURE_AUTH_OIDC === true`. They have safe defaults in
// `ConfigurationService`, but exposing the disabled-by-default state defends
// against accidental enablement in shared CI environments.
if (!process.env.ENABLE_FEATURE_AUTH_OIDC) {
  process.env.ENABLE_FEATURE_AUTH_OIDC = 'false';
}
