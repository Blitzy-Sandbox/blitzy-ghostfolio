import { SnowflakeClientFactory } from '@ghostfolio/api/app/snowflake-sync/snowflake-client.factory';

import { Injectable, Logger } from '@nestjs/common';

/**
 * SnowflakeHealthIndicator
 *
 * Lightweight readiness probe for the Snowflake analytical backend that
 * supports the Snowflake Sync layer (Feature A, AAP § 0.1.1) and the
 * `query_history` chat-agent tool (Feature B, AAP § 0.5.1.5). The
 * indicator issues a static `SELECT 1` query through the centralized
 * `SnowflakeClientFactory` to verify connectivity, authentication, and
 * basic warehouse responsiveness without consuming meaningful Snowflake
 * credits.
 *
 * Hard rules enforced by this class (see AAP § 0.7):
 *
 * - Rule 1 (Module Isolation — § 0.7.1.1): The only cross-module
 *   dependency is `SnowflakeClientFactory`, which is registered in
 *   `SnowflakeSyncModule.providers` and re-exported via
 *   `SnowflakeSyncModule.exports`. No deeper imports into the
 *   `snowflake-sync` directory are made; the `snowflake-sdk` package is
 *   NOT imported here — the factory encapsulates the SDK.
 *
 * - Rule 2 (Parameterized Queries — § 0.7.1.2): The probe issues the
 *   STATIC string literal `'SELECT 1'` with an EXPLICIT empty `binds: []`
 *   array. No template literal, no string concatenation, and no variable
 *   interpolation is ever adjacent to the SQL string.
 *
 * - Rule 3 (Credential Access — § 0.7.1.3): No `SNOWFLAKE_*` environment
 *   variable is read in this file. All credential handling is
 *   encapsulated inside `SnowflakeClientFactory.getConnection()`, which
 *   reads through the injected `ConfigService`. Direct `process.env`
 *   access is prohibited and absent.
 *
 * - Logging redaction (§ 0.7.3): On any failure, only `error.message`
 *   (or a safe non-Error fallback) is emitted to the per-class
 *   `Logger`. The `binds: []` array is empty by construction; the
 *   `sqlText` is the literal `'SELECT 1'`; no credential value is ever
 *   in scope at this layer.
 *
 * - Inline callback bridge (§ 0.7.3): The callback-based
 *   `connection.execute({ sqlText, binds, complete })` API is wrapped
 *   in a `Promise` constructor inline; the `snowflake-promise`
 *   external package is intentionally NOT introduced.
 *
 * - Fail-closed contract: Mirrors the existing
 *   `HealthService.isDatabaseHealthy()` and
 *   `HealthService.isRedisCacheHealthy()` convention
 *   (`apps/api/src/app/health/health.service.ts`). Returns
 *   `Promise<boolean>` and never throws — every exceptional path
 *   (factory rejection, network timeout, authentication failure, SQL
 *   execution failure, malformed SDK response) is funneled through the
 *   single catch block to `false`.
 *
 * Module registration: This class is delivered as a stand-alone
 * injectable provider. Wiring it into `HealthModule.providers` and
 * exposing a `/api/v1/health/snowflake` route from `HealthController`
 * are deferred to a later checkpoint (the final wiring checkpoint of
 * the AI feature delivery, AAP § 0.5.1.2). The probe is listed in
 * AAP § 0.5.1.2 as an additive health indicator intended for
 * `HealthModule` registration; it is NOT permanently out of scope. No
 * further changes to this file are required at registration time —
 * only the host `HealthModule` and `HealthController` will gain new
 * entries.
 */
@Injectable()
export class SnowflakeHealthIndicator {
  private readonly logger = new Logger(SnowflakeHealthIndicator.name);

  public constructor(
    private readonly snowflakeClientFactory: SnowflakeClientFactory
  ) {}

  /**
   * Performs a lightweight readiness probe of the Snowflake analytical
   * backend.
   *
   * Behavior:
   *   1. Acquires a `snowflake.Connection` via
   *      `SnowflakeClientFactory.getConnection()`. The factory is
   *      responsible for lazy initialization, credential resolution
   *      through `ConfigService`, and connection caching with
   *      `clientSessionKeepAlive` semantics. If the factory cannot
   *      establish a connection (missing env vars, network failure,
   *      authentication failure), its rejection propagates to the
   *      outer catch.
   *   2. Issues the STATIC SQL literal `'SELECT 1'` with an explicit
   *      empty `binds: []` array via the SDK's callback-based
   *      `connection.execute({ sqlText, binds, complete })` method.
   *      The callback is bridged into a `Promise` inline — no
   *      `snowflake-promise` external package is used (AAP § 0.7.3).
   *   3. Resolves to `true` once the SDK's `complete` callback fires
   *      without an error.
   *
   * Fail-closed handling (AAP § 0.7.3 logging redaction):
   *   - Any error from `getConnection()` or `execute()` is caught.
   *   - Only the `error.message` field is logged via
   *     `this.logger.warn(...)`. For non-`Error` rejections (e.g., a
   *     plain string or an object lacking `.message`) a safe fallback
   *     string is substituted. The `binds` array (always empty) and
   *     the `sqlText` literal (always `'SELECT 1'`) are never logged.
   *   - The method returns `false` on every exceptional path; it
   *     never re-throws. This matches the
   *     `HealthService.isDatabaseHealthy()` / `isRedisCacheHealthy()`
   *     convention so the future `HealthController` route can map
   *     boolean → HTTP 200 / 503 without additional error handling.
   *
   * Configuration-only probe characteristics:
   *   - `SELECT 1` is the LIGHTEST POSSIBLE query — it returns a
   *     single integer literal without reading any user data, any
   *     analytical table, or any system view. No credit is consumed
   *     beyond the trivial round-trip overhead.
   *   - Connection re-use: because `SnowflakeClientFactory` caches a
   *     single shared connection across calls, repeated invocations
   *     of this method (e.g., from a frequently-polled
   *     `/health/snowflake` endpoint) do not establish a new
   *     connection per request.
   *
   * @returns `true` when a Snowflake connection is acquired and
   *          `SELECT 1` returns successfully; `false` on any failure
   *          path (with a redacted warning logged).
   */
  public async isHealthy(): Promise<boolean> {
    try {
      const connection = await this.snowflakeClientFactory.getConnection();

      await new Promise<void>((resolve, reject) => {
        connection.execute({
          binds: [],
          complete: (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          },
          sqlText: 'SELECT 1'
        });
      });

      return true;
    } catch (error: unknown) {
      // Redaction (AAP § 0.7.3): emit only the SDK's own `error.message`
      // (or a safe fallback for non-Error throwables). No credential
      // value is in scope at this layer; even so, the message string is
      // the only field surfaced to the log line.
      let errorMessage: string;

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else {
        errorMessage = '<non-Error throwable>';
      }

      this.logger.warn(`Snowflake health probe failed: ${errorMessage}`);

      return false;
    }
  }
}
