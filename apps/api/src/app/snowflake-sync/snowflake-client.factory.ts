import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as snowflake from 'snowflake-sdk';

/**
 * SnowflakeClientFactory
 *
 * Foundational infrastructure provider for the Snowflake Sync layer
 * (Feature A, AAP § 0.1.1). Wraps `snowflake-sdk.createConnection({...})`
 * with a lazy single-connection pool and exposes the connection to sibling
 * services (`SnowflakeSyncService`, `SnowflakeHealthIndicator`) through the
 * `getConnection()` accessor.
 *
 * Hard rules enforced by this class (see AAP § 0.7):
 *
 * - Rule 3 (Credential Access): All six `SNOWFLAKE_*` environment variables
 *   are read EXCLUSIVELY through the injected `ConfigService`. Direct
 *   `process.env.SNOWFLAKE_*` access is prohibited and absent from this file.
 *
 * - Rule 1 (Module Isolation): This factory has no sibling-file imports;
 *   it is exported by `SnowflakeSyncModule` and consumed across modules
 *   only through that public export.
 *
 * - Observability (§ 0.7.2): All connection lifecycle events are emitted via
 *   the static NestJS `Logger`. NO credential value (account, username,
 *   password, etc.) is ever included in a log line — only the SDK's own
 *   `err.message` is surfaced on failure.
 *
 * - Inline callback bridge (§ 0.7.3): The callback-based `connection.connect`
 *   and `connection.destroy` APIs are wrapped in `Promise` constructors
 *   inline; the `snowflake-promise` external package is intentionally NOT
 *   introduced.
 *
 * Global SDK log-level configuration (QA Checkpoint 14, Issue #2):
 *
 *   The `snowflake-sdk@^1.x` driver emits INFO-level log lines at connection
 *   construction time that include connection metadata such as the account
 *   identifier, username, database, schema, and warehouse (the actual
 *   password value is masked by the SDK with the literal string
 *   `"password is provided"`). While no credential VALUE leaks, the
 *   connection-metadata names are excessive log noise for a Ghostfolio
 *   self-host deployment and were flagged as an INFO observation by the
 *   QA security audit.
 *
 *   We mitigate this by invoking `snowflake.configure({ logLevel: 'WARN' })`
 *   exactly once across the application lifetime, on the first construction
 *   of `SnowflakeClientFactory`. The static `globalConfigured` guard makes
 *   the call idempotent so that test harnesses or future multi-instance
 *   wiring cannot trigger redundant SDK reconfiguration.
 *
 *   `'WARN'` was chosen (not `'ERROR'` and not `'OFF'`) so genuine driver
 *   warnings — which surface real operational issues such as deprecated
 *   parameters or session-keep-alive failures — continue to reach the
 *   process stdout. Connection-metadata `'INFO'` logs are suppressed
 *   while diagnostic signal is preserved.
 */
@Injectable()
export class SnowflakeClientFactory {
  /**
   * One-shot guard around the global `snowflake.configure(...)` call.
   *
   * `snowflake.configure(...)` mutates module-level driver state (the
   * Snowflake driver maintains its log configuration in a singleton
   * inside `node_modules/snowflake-sdk/lib/global_config.js`). Even
   * though calling it repeatedly with identical options is harmless,
   * an idempotent guard keeps the call site honest and makes the
   * intent explicit to readers — the global configuration is set
   * exactly once and never mutated again.
   *
   * Test isolation: this static field is reset to `false` only by the
   * Node module reloader between test runs (or by an explicit reset
   * helper if a test ever needs to re-exercise the configuration code
   * path). Production code never resets it.
   */
  private static globalConfigured = false;

  /**
   * Cached connection — populated after the first successful `connect()`
   * callback resolves. Reset to `null` on `disconnect()` or after a stale
   * connection is detected by `isAlive(...)`.
   */
  private connection: snowflake.Connection | null = null;

  /**
   * In-flight connection attempt. Prevents concurrent `connect()` calls
   * when multiple service methods race during cold start: the first caller
   * initiates the promise; subsequent callers `await` the same instance
   * until it settles, after which the field is reset to `null` so the next
   * cache-miss can retry cleanly.
   */
  private connectionPromise: Promise<snowflake.Connection> | null = null;

  public constructor(private readonly configService: ConfigService) {
    // Configure the global snowflake-sdk log level once per process to
    // suppress connection-metadata INFO lines emitted by the driver
    // (QA Checkpoint 14, Issue #2 — defense-in-depth log-noise reduction).
    //
    // The `try/catch` is defensive: a malformed `logLevel` would normally
    // throw `ERR_GLOBAL_CONFIGURE_INVALID_LOG_LEVEL` (403001), but we use
    // a known-good literal `'WARN'`. The catch-and-warn behavior here
    // ensures that any SDK-version-driven contract change in
    // `configure(...)` cannot crash the application during bootstrap; the
    // worst case is a verbose log stream that the operator can address
    // with a follow-up SDK upgrade.
    if (!SnowflakeClientFactory.globalConfigured) {
      try {
        snowflake.configure({ logLevel: 'WARN' });
        SnowflakeClientFactory.globalConfigured = true;
      } catch (err) {
        Logger.warn(
          `snowflake.configure(logLevel: 'WARN') failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          'SnowflakeClientFactory'
        );
      }
    }
  }

  /**
   * Lazily acquires a Snowflake connection.
   *
   * Behavior:
   *   1. If a cached connection exists and `isAlive(...)` returns `true`,
   *      return the cached value immediately.
   *   2. Otherwise, if another caller already initiated a connection
   *      attempt, return that in-flight promise so concurrent callers
   *      coalesce to a single underlying connect.
   *   3. Otherwise, initiate a new connect via `createAndConnect()`,
   *      cache the resolved connection, and return it.
   *
   * Errors:
   *   - Throws `Error` with a descriptive message when any of the six
   *     required `SNOWFLAKE_*` environment variables is missing
   *     (Gate 10 — env var binding).
   *   - Propagates the `snowflake-sdk` connect error verbatim if the
   *     underlying network/authentication call fails.
   */
  public async getConnection(): Promise<snowflake.Connection> {
    if (this.connection !== null && this.isAlive(this.connection)) {
      return this.connection;
    }

    if (this.connectionPromise !== null) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.createAndConnect();

    try {
      this.connection = await this.connectionPromise;

      return this.connection;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Gracefully tears down the cached Snowflake connection.
   *
   * Idempotent — safe to invoke multiple times or on a never-connected
   * instance (returns immediately when `connection` is `null`).
   *
   * Intended consumers:
   *   - NestJS lifecycle hook in `SnowflakeSyncService.onModuleDestroy()`
   *   - Test teardown in `snowflake-sync.service.spec.ts`
   *
   * Logs failures via the static `Logger` but does NOT re-throw — a
   * teardown failure must not block application shutdown.
   */
  public async disconnect(): Promise<void> {
    if (!this.connection) {
      return;
    }

    const connection = this.connection;
    this.connection = null;

    await new Promise<void>((resolve) => {
      connection.destroy((err) => {
        if (err) {
          Logger.error(
            `Snowflake disconnect failed: ${err.message}`,
            'SnowflakeClientFactory'
          );
        } else {
          Logger.log('Snowflake connection closed', 'SnowflakeClientFactory');
        }

        resolve();
      });
    });
  }

  /**
   * Reads all six `SNOWFLAKE_*` env vars via `ConfigService`, validates
   * that none are empty, constructs the connection through
   * `snowflake.createConnection({...})`, and resolves once the SDK's
   * callback-based `connect()` succeeds.
   *
   * `clientSessionKeepAlive: true` is the `ConnectionOptions`-level field
   * that delivers "the SDK's keepAlive semantics" referenced in AAP
   * § 0.5.1.1 for long-running services: it instructs Snowflake to keep
   * the session alive indefinitely so the daily cron and event-driven
   * sync paths both benefit from a persistent session between bursts of
   * MERGE statements without hitting the default 4-hour idle timeout.
   * (Socket-level keep-alive — controlled by the SDK's separate
   * `configure({ keepAlive })` global option — is enabled by default.)
   *
   * NO credential value is logged at any point.
   */
  private async createAndConnect(): Promise<snowflake.Connection> {
    const account = this.configService.get<string>('SNOWFLAKE_ACCOUNT');
    const username = this.configService.get<string>('SNOWFLAKE_USER');
    const password = this.configService.get<string>('SNOWFLAKE_PASSWORD');
    const database = this.configService.get<string>('SNOWFLAKE_DATABASE');
    const warehouse = this.configService.get<string>('SNOWFLAKE_WAREHOUSE');
    const schema = this.configService.get<string>('SNOWFLAKE_SCHEMA');

    if (
      !account ||
      !username ||
      !password ||
      !database ||
      !warehouse ||
      !schema
    ) {
      throw new Error(
        'SnowflakeClientFactory: missing required SNOWFLAKE_* environment variables. ' +
          'Ensure SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD, ' +
          'SNOWFLAKE_DATABASE, SNOWFLAKE_WAREHOUSE, and SNOWFLAKE_SCHEMA are set.'
      );
    }

    const connection = snowflake.createConnection({
      account,
      clientSessionKeepAlive: true,
      database,
      password,
      schema,
      username,
      warehouse
    });

    return new Promise<snowflake.Connection>((resolve, reject) => {
      connection.connect((err, conn) => {
        if (err) {
          Logger.error(
            `Snowflake connection failed: ${err.message}`,
            'SnowflakeClientFactory'
          );

          reject(err);
        } else {
          Logger.log(
            'Snowflake connection established',
            'SnowflakeClientFactory'
          );

          resolve(conn);
        }
      });
    });
  }

  /**
   * Defensive liveness check. The behavior matches the actual implementation
   * below precisely:
   *
   * - If `Connection.isUp` is **missing** (e.g., older or newer minor SDK
   *   versions that omit the helper), the method short-circuits to `true`
   *   and treats the cached connection as alive. The lazy cache then
   *   forwards the connection to the caller; any underlying transport
   *   failure surfaces on the next `execute(...)` call instead of
   *   triggering an immediate reconnect.
   *
   * - If `Connection.isUp` is **present and runs cleanly**, its boolean
   *   return value is forwarded directly: `true` means alive (cache is
   *   reused), `false` means dead (caller will rebuild a fresh
   *   connection in `getConnection()`).
   *
   * - If `Connection.isUp` is **present but throws** (e.g., the SDK's
   *   internal state machine has been corrupted by a prior network blip),
   *   the `try`/`catch` here returns `false` and forces the next
   *   `getConnection()` call to construct a fresh connection. This
   *   prevents a permanent stuck-state in which the cached connection
   *   has been silently terminated by the server but the SDK refuses
   *   to acknowledge it.
   *
   * This three-way handling keeps the lazy cache lenient toward SDK
   * version drift while remaining strict about transport-level failure
   * recovery.
   */
  private isAlive(connection: snowflake.Connection): boolean {
    try {
      return typeof connection.isUp === 'function' ? connection.isUp() : true;
    } catch {
      return false;
    }
  }
}
