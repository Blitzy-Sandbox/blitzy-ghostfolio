import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { PortfolioChangedEvent } from '@ghostfolio/api/events/portfolio-changed.event';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  OnModuleInit
} from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import ms from 'ms';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  OrdersHistoryRow,
  PerformanceMetricRow,
  PortfolioSnapshotRow
} from './interfaces/snowflake-rows.interface';
import { SnowflakeClientFactory } from './snowflake-client.factory';

/**
 * SnowflakeSyncService
 *
 * Feature A core service that mirrors Ghostfolio's operational data
 * (portfolio snapshots, trade history, performance metrics) into Snowflake
 * as an append-only analytical backend. See AAP § 0.1.1 (Feature A) for
 * the high-level intent, § 0.4.3 for the event-driven sync flow diagram,
 * and § 0.5.1.1 for the file-by-file responsibility breakdown.
 *
 * Responsibilities:
 *   1. Bootstrap the Snowflake DDL on application start (`bootstrap()`).
 *   2. Run the daily sync at `02:00 UTC` (`runDailySync()`).
 *   3. Listen for `PortfolioChangedEvent` and re-sync the affected user's
 *      orders within the same request lifecycle (`handlePortfolioChanged()`).
 *   4. Provide an admin-driven manual sync entry point that re-throws on
 *      failure for HTTP-layer error mapping (`triggerManualSync()`).
 *   5. Expose a parameterized read-only Snowflake query path consumed by
 *      the Claude chat agent's `query_history` tool (`queryHistory()`).
 *
 * Hard rules enforced by this class (see AAP § 0.7):
 *
 *  - Rule 1 (Module Isolation): the service injects only services that
 *    are explicitly exported by their source modules — `MetricsService`,
 *    `PrismaService`, `PortfolioService`, and the sibling
 *    `SnowflakeClientFactory`. No imports reach into other feature
 *    module directories.
 *
 *  - Rule 2 (Parameterized Snowflake Queries): every SQL string is a
 *    static string literal containing only `?` placeholders. Variable
 *    values are passed via the `binds` array. NO template literal or
 *    `+` operator interpolates a caller-controlled value into a SQL
 *    string anywhere in this file.
 *
 *  - Rule 3 (Credential Access via ConfigService): SNOWFLAKE_* env vars
 *    are read EXCLUSIVELY through `SnowflakeClientFactory`. This file
 *    never references the Snowflake env vars directly via the global
 *    `process` object and never reads the Snowflake credentials directly.
 *
 *  - Rule 7 (Snowflake Sync Idempotency): every write uses a MERGE
 *    statement keyed on the unique constraint of the target table.
 *    Running the sync twice for the same date range leaves row counts
 *    unchanged.
 *
 *  - Observability (§ 0.7.2): every cron / event / manual-sync invocation
 *    generates a `correlationId` via `randomUUID()` and embeds it in
 *    every structured `Logger.log` / `Logger.error` line. `binds` arrays
 *    are NEVER logged.
 */
@Injectable()
export class SnowflakeSyncService implements OnModuleInit {
  /**
   * Hard cap applied by `queryHistory()` on the row count returned to
   * the chat-agent tool. The limit wraps the LLM-supplied SQL in an
   * outer `SELECT * FROM (<sql>) LIMIT N` so even an unbounded inner
   * query cannot exhaust memory by streaming millions of rows back
   * to the chat handler.
   *
   * The constant is `private static readonly` so the value cannot be
   * mutated at runtime and is a fixed compile-time number — the
   * interpolation of this value into the limited-SQL string is the
   * sole template-literal interpolation in this file and is permitted
   * by Rule 2 because the value is not caller-controlled.
   */
  private static readonly QUERY_HISTORY_ROW_LIMIT = 1000;

  /**
   * Static fallback DDL inlined verbatim from `sql/bootstrap.sql`.
   *
   * The runtime preference is to load the DDL from the on-disk
   * `sql/bootstrap.sql` file via `fs.readFile(...)` so the source-of-
   * truth for the Snowflake schema is the SQL file. However, when the
   * compiled bundle does not co-locate the SQL asset (e.g., when
   * `nx build api` runs without an asset-copy entry for the file),
   * the on-disk read raises `ENOENT`. This inlined constant guarantees
   * that the bootstrap DDL is always available even if the asset is
   * missing from `dist/`.
   *
   * This is NOT a Rule 2 violation: the array contains only static SQL
   * keyword/clause text — no caller-controlled value is interpolated.
   */
  private static readonly FALLBACK_BOOTSTRAP_STATEMENTS: string[] = [
    'CREATE TABLE IF NOT EXISTS portfolio_snapshots (' +
      'snapshot_date DATE NOT NULL, ' +
      'user_id STRING NOT NULL, ' +
      'asset_class STRING NOT NULL, ' +
      'allocation_pct FLOAT, ' +
      'total_value_usd FLOAT, ' +
      'CONSTRAINT pk_portfolio_snapshots PRIMARY KEY (snapshot_date, user_id, asset_class)' +
      ')',
    'CREATE TABLE IF NOT EXISTS orders_history (' +
      'order_id STRING NOT NULL, ' +
      'user_id STRING NOT NULL, ' +
      'date DATE NOT NULL, ' +
      'type STRING NOT NULL, ' +
      'ticker STRING, ' +
      'quantity FLOAT, ' +
      'unit_price FLOAT, ' +
      'fee FLOAT, ' +
      'currency STRING, ' +
      'synced_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(), ' +
      'CONSTRAINT pk_orders_history PRIMARY KEY (order_id)' +
      ')',
    'CREATE TABLE IF NOT EXISTS performance_metrics (' +
      'metric_date DATE NOT NULL, ' +
      'user_id STRING NOT NULL, ' +
      'twr FLOAT, ' +
      'volatility FLOAT, ' +
      'sharpe_ratio FLOAT, ' +
      'CONSTRAINT pk_performance_metrics PRIMARY KEY (metric_date, user_id)' +
      ')'
  ];

  /**
   * Debounce delay for `PortfolioChangedEvent`-driven Snowflake syncs.
   *
   * Mirrors the canonical 5-second window established by the existing
   * `apps/api/src/events/portfolio-changed.listener.ts`. Burst events
   * caused by bulk-import operations or rapid-fire CRUD activity coalesce
   * into a single per-user sync invocation, avoiding `N` parallel MERGE
   * statements per user when only a single full mirror is required (per
   * AAP § 0.4.3 and review feedback for this checkpoint).
   */
  private static readonly EVENT_DEBOUNCE_DELAY_MS = ms('5 seconds');

  /**
   * Allow-list pattern for the leading SQL keyword in `queryHistory()`.
   *
   * The chat agent's `query_history` tool is a READ-ONLY surface — DML
   * (`INSERT`/`UPDATE`/`DELETE`/`MERGE`) and DDL (`CREATE`/`DROP`/`ALTER`/
   * `TRUNCATE`) statements MUST be rejected. The semicolon detector
   * (`containsSemicolonOutsideStringLiterals`) already prevents statement
   * batching, but a single-statement DML/DDL query without a trailing
   * semicolon would otherwise pass through.
   *
   * The regex anchors to the first non-comment, non-whitespace token of
   * the query and admits only `SELECT` and `WITH` (case-insensitive).
   * Comments are stripped via `stripSqlComments` before this check is
   * applied, so a leading `/* ... *\/` or `-- ...` does not bypass it.
   */
  private static readonly READ_ONLY_LEADING_KEYWORD_PATTERN =
    /^\s*(SELECT|WITH)\b/i;

  /**
   * Per-userId debounce timer registry. The map is private and keyed on
   * the JWT-authenticated user id supplied by `PortfolioChangedEvent`.
   * Re-arming the timer for an in-flight userId clears the prior timer
   * via `clearTimeout` to coalesce burst events into a single MERGE.
   */
  private readonly eventDebounceTimers = new Map<string, NodeJS.Timeout>();

  public constructor(
    private readonly metricsService: MetricsService,
    private readonly moduleRef: ModuleRef,
    private readonly prismaService: PrismaService,
    private readonly snowflakeClientFactory: SnowflakeClientFactory
  ) {
    // Register Prometheus help descriptions once per process start. The
    // metrics registry is a singleton, so subsequent `registerHelp` calls
    // for the same name are no-ops; doing this in the constructor keeps
    // the metric definitions co-located with their first emission.
    this.metricsService.registerHelp(
      'snowflake_sync_runs_total',
      'Total Snowflake sync invocations partitioned by trigger and outcome'
    );
    this.metricsService.registerHelp(
      'snowflake_sync_latency_seconds',
      'Latency of a Snowflake sync invocation in seconds'
    );
  }

  /**
   * Daily Snowflake sync cron, scheduled at `02:00 UTC` exactly.
   *
   * The decorator deliberately specifies BOTH the cron expression
   * (`0 2 * * *`) AND the `timeZone` option (`UTC`) so that operator
   * changes to the host system timezone do not silently shift the
   * schedule (per AAP § 0.7.3). The named cron `snowflake-daily-sync`
   * surfaces in the NestJS scheduler logs and lets the operator
   * verify cron registration at startup (Snowflake sync gate of
   * § 0.7.5.2).
   *
   * Sync behavior:
   *   1. Generate a fresh `correlationId` per invocation.
   *   2. Enumerate all Ghostfolio user IDs via Prisma.
   *   3. For each user, run the three sync routines in sequence:
   *      `syncOrders` → `syncSnapshots` → `syncMetrics`. Per-user
   *      failures are caught locally so a single user's failure does
   *      not abort the entire daily sync.
   *
   * Observability (AAP § 0.7.2): the cron records:
   *   - `snowflake_sync_runs_total{trigger="cron", outcome=...}` counter
   *     for each per-user attempt (success/failure).
   *   - `snowflake_sync_latency_seconds{trigger="cron"}` histogram for
   *     the total wall-clock time of the daily run.
   */
  @Cron('0 2 * * *', {
    name: 'snowflake-daily-sync',
    timeZone: 'UTC'
  })
  public async runDailySync(): Promise<void> {
    const correlationId = randomUUID();
    const startTime = Date.now();

    Logger.log(
      `[${correlationId}] Daily Snowflake sync started`,
      'SnowflakeSyncService'
    );

    try {
      const today = this.getIsoDate(new Date());
      const users = await this.prismaService.user.findMany({
        select: { id: true }
      });

      let succeeded = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await this.syncOrders(user.id);
          await this.syncSnapshots(user.id, today);
          await this.syncMetrics(user.id, today);
          succeeded += 1;
          this.metricsService.incrementCounter('snowflake_sync_runs_total', 1, {
            outcome: 'success',
            trigger: 'cron'
          });
        } catch (error) {
          failed += 1;
          this.metricsService.incrementCounter('snowflake_sync_runs_total', 1, {
            outcome: 'failure',
            trigger: 'cron'
          });
          Logger.error(
            `[${correlationId}] Failed to sync user ${user.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'SnowflakeSyncService'
          );
        }
      }

      Logger.log(
        `[${correlationId}] Daily Snowflake sync completed (` +
          `total=${users.length}, succeeded=${succeeded}, failed=${failed})`,
        'SnowflakeSyncService'
      );
    } catch (error) {
      Logger.error(
        `[${correlationId}] Daily Snowflake sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'SnowflakeSyncService'
      );
    } finally {
      this.metricsService.observeHistogram(
        'snowflake_sync_latency_seconds',
        (Date.now() - startTime) / 1000,
        { trigger: 'cron' }
      );
    }
  }

  /**
   * `PortfolioChangedEvent` handler.
   *
   * The handler subscribes to the existing `PortfolioChangedEvent` class
   * (re-using `PortfolioChangedEvent.getName()` rather than a literal
   * string for type safety per AAP § 0.4.3 — Event-Driven Sync Flow).
   * The event is emitted by `ActivitiesService` on every Order CRUD
   * operation; this listener mirrors the affected user's order history
   * to Snowflake within the same request lifecycle.
   *
   * Per-user 5-second debounce (AAP § 0.4.3): bursts of events from the
   * same user (e.g., bulk-import, rapid-fire CRUD) are coalesced into a
   * single `syncOrders(userId)` invocation. The debounce mirrors the
   * existing `PortfolioChangedListener` pattern: each new event clears
   * the prior timer for that userId and schedules a fresh one. The
   * MERGE-based idempotency (Rule 7) ensures correctness regardless of
   * coalescing — debouncing simply avoids redundant Snowflake round
   * trips.
   *
   * Errors emitted by the deferred sync are caught and logged but NOT
   * re-thrown — this is an event handler, not a request handler.
   * Re-throwing would bubble into the `EventEmitter2` "uncaughtException"
   * path and is not the right failure boundary for a background sync.
   *
   * Observability (AAP § 0.7.2): records:
   *   - `snowflake_sync_runs_total{trigger="event", outcome=...}` counter
   *     for each deferred per-user invocation.
   *   - `snowflake_sync_latency_seconds{trigger="event"}` histogram of
   *     the deferred sync duration (excludes the 5-second debounce
   *     window).
   */
  @OnEvent(PortfolioChangedEvent.getName())
  public handlePortfolioChanged(event: PortfolioChangedEvent): void {
    const userId = event.getUserId();

    const existingTimer = this.eventDebounceTimers.get(userId);

    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.eventDebounceTimers.set(
      userId,
      setTimeout(() => {
        this.eventDebounceTimers.delete(userId);

        void this.processDebouncedEventSync(userId);
      }, SnowflakeSyncService.EVENT_DEBOUNCE_DELAY_MS)
    );
  }

  /**
   * NestJS lifecycle hook fired immediately after the dependency-injection
   * container has resolved every provider in the module graph. Delegates
   * to `bootstrap()` so the three Snowflake tables are guaranteed to exist
   * before the daily cron, the event listener, or the manual trigger
   * issues its first MERGE.
   *
   * Errors are caught and logged but NOT re-thrown — Snowflake may be
   * temporarily unavailable on cold start (e.g., the warehouse is
   * suspended and resuming) and a transient failure must not crash the
   * NestJS application bootstrap.
   *
   * `bootstrap()` is intentionally fire-and-forget here: this method
   * does NOT `await` it. The reason is that `snowflake-sdk` does not
   * apply a default timeout to `connection.execute({...})`, so a
   * Snowflake warehouse that is suspended, unreachable, or
   * unresponsive (e.g., placeholder credentials in a non-production
   * environment) would otherwise block `OnModuleInit` indefinitely
   * and prevent NestJS from invoking `app.listen(...)`. By detaching
   * the bootstrap promise from the lifecycle hook, the HTTP server
   * comes up immediately, the cron and event listener register on
   * the static-tree provider as designed, and the bootstrap result
   * is reported asynchronously via the `.then()` / `.catch()` log
   * lines below. This honors the stated guarantee in this method's
   * JSDoc that "a transient failure must not crash the NestJS
   * application bootstrap" — a hang is a transient failure too.
   */
  public onModuleInit(): void {
    this.bootstrap()
      .then(() => {
        Logger.log('Snowflake bootstrap completed', 'SnowflakeSyncService');
      })
      .catch((error) => {
        Logger.error(
          `Snowflake bootstrap failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'SnowflakeSyncService'
        );
      });
  }

  /**
   * Idempotent Snowflake DDL bootstrap.
   *
   * Reads the three `CREATE TABLE IF NOT EXISTS` statements from
   * `sql/bootstrap.sql` (relative to the runtime `__dirname`) and
   * executes them sequentially. The split-on-`;\n` parser is intentional
   * and safe with respect to Rule 2: the bootstrap statements are static
   * DDL committed alongside the source code — no caller-controlled value
   * is interpolated into the SQL strings, and the `binds` array is empty
   * for every statement.
   *
   * If the on-disk file cannot be read (e.g., the asset is not copied
   * into the compiled `dist/` output by `nx build api`), the method
   * falls back to the inlined `FALLBACK_BOOTSTRAP_STATEMENTS` constant
   * defined on the class. This guarantees `bootstrap()` always has a
   * concrete set of DDL statements to execute regardless of build-time
   * asset configuration.
   */
  public async bootstrap(): Promise<void> {
    const statements = await this.loadBootstrapStatements();

    for (const statement of statements) {
      await this.executeQuery(statement, []);
    }
  }

  /**
   * Manual sync entry point exposed to admin operators through the
   * `POST /api/v1/snowflake-sync/trigger` endpoint.
   *
   * Inputs:
   *   - `callerUserId`: JWT-authenticated user id of the caller.
   *   - `correlationId` (optional): per-request id generated by the
   *     controller boundary so the value emitted as the
   *     `X-Correlation-ID` HTTP response header on the success/error
   *     paths matches the value embedded in this service's structured
   *     log lines and the `BadGatewayException` message body
   *     (Observability rule, AAP § 0.7.2; QA Checkpoint 13 Issue #1
   *     fix). When omitted (e.g., direct service-level invocation
   *     from a future internal caller, or a legacy unit test without
   *     a controller boundary), this method falls back to
   *     `crypto.randomUUID()` so the historical contract — "a fresh
   *     correlationId is always present in the returned envelope" —
   *     remains intact for backward compatibility.
   *   - `overrideUserId` (optional): admin override to sync a specific
   *     other user. The DTO's class-validator schema is the authoritative
   *     gate that this is only populated for admin callers.
   *   - `overrideDate` (optional): ISO-8601 (`YYYY-MM-DD`) override of
   *     the snapshot/metric date. Defaults to today (UTC).
   *
   * Output:
   *   - A small JSON envelope including the resolved `correlationId`
   *     (echoing the caller-supplied value when provided), the
   *     resolved `userId`, the `date` used, and a `success: true`
   *     marker. Errors are re-thrown so the global NestJS exception
   *     filter maps them to an HTTP 500 (or whatever HTTP code the
   *     caller's controller chooses to surface).
   */
  public async triggerManualSync({
    callerUserId,
    correlationId: providedCorrelationId,
    overrideUserId,
    overrideDate
  }: {
    callerUserId: string;
    correlationId?: string;
    overrideUserId?: string;
    overrideDate?: string;
  }): Promise<{
    correlationId: string;
    date: string;
    success: boolean;
    userId: string;
  }> {
    const correlationId = providedCorrelationId ?? randomUUID();
    const targetUserId = overrideUserId ?? callerUserId;
    const targetDate = overrideDate ?? this.getIsoDate(new Date());
    const startTime = Date.now();

    Logger.log(
      `[${correlationId}] Manual sync triggered by ${callerUserId} for ` +
        `user=${targetUserId} date=${targetDate}`,
      'SnowflakeSyncService'
    );

    try {
      await this.syncOrders(targetUserId);
      await this.syncSnapshots(targetUserId, targetDate);
      await this.syncMetrics(targetUserId, targetDate);

      this.metricsService.incrementCounter('snowflake_sync_runs_total', 1, {
        outcome: 'success',
        trigger: 'manual'
      });

      Logger.log(
        `[${correlationId}] Manual sync completed for user=${targetUserId}`,
        'SnowflakeSyncService'
      );

      return {
        correlationId,
        date: targetDate,
        success: true,
        userId: targetUserId
      };
    } catch (error) {
      this.metricsService.incrementCounter('snowflake_sync_runs_total', 1, {
        outcome: 'failure',
        trigger: 'manual'
      });
      Logger.error(
        `[${correlationId}] Manual sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'SnowflakeSyncService'
      );

      // Translate raw upstream/driver errors (e.g., the
      // `snowflake-sdk` `RequestFailedError`, network/DNS failures,
      // bootstrap DDL failures) to a graceful HTTP 502 so the controller
      // returns "Bad Gateway" rather than the default HTTP 500
      // "Internal server error" that would otherwise be produced by the
      // global NestJS exception filter for non-HttpException throwables.
      //
      // This matches:
      //  - AAP § 0.7.4 ("Service errors are translated to NestJS HTTP
      //    exceptions in controllers (NotFoundException,
      //    BadRequestException, BadGatewayException for upstream
      //    Anthropic/Snowflake failures)").
      //  - The QA Checkpoint 9 CRITICAL #1 expected outcome
      //    ("Or, if Snowflake is unreachable, a graceful HTTP 502 from
      //    upstream error handling.").
      //  - The identical pattern already established in
      //    `RebalancingService` (4 BadGatewayException sites: lines
      //    328 / 350 / 376 / 421) for Anthropic upstream failures.
      //
      // `HttpException` instances thrown deeper in the call chain (e.g.,
      // a `BadRequestException` from a future input-validation guard)
      // are re-thrown unchanged so their original status codes survive.
      if (error instanceof HttpException) {
        throw error;
      }

      throw new BadGatewayException(
        'Snowflake sync failed: upstream Snowflake driver returned an ' +
          'error. The portfolio data layer is operating normally; the ' +
          'failure is isolated to the analytical mirror. See server ' +
          `logs for correlationId=${correlationId}.`
      );
    } finally {
      this.metricsService.observeHistogram(
        'snowflake_sync_latency_seconds',
        (Date.now() - startTime) / 1000,
        { trigger: 'manual' }
      );
    }
  }

  /**
   * Mirrors the user's Order rows to the Snowflake `orders_history`
   * table via a parameterized MERGE statement keyed on `(order_id)`
   * (the table's unique constraint per `bootstrap.sql`).
   *
   * The Prisma query is scoped by `where: { userId }` so the per-user
   * data isolation guaranteed by the JWT-authenticated user id at the
   * controller boundary is preserved end-to-end. The Prisma `select`
   * deliberately includes only the columns required for the Snowflake
   * row — no extra PII is read.
   *
   * MERGE shape (Rule 7 — idempotency):
   *   - Source row built from a `SELECT ?, ?, ...` clause with one
   *     placeholder per Snowflake column.
   *   - `WHEN MATCHED` updates every non-key column.
   *   - `WHEN NOT MATCHED` inserts every column.
   *   - Re-running for the same user leaves the table row counts
   *     unchanged.
   *
   * Returns the number of orders processed (one MERGE per order).
   */
  public async syncOrders(userId: string): Promise<number> {
    const orders = await this.prismaService.order.findMany({
      select: {
        currency: true,
        date: true,
        fee: true,
        id: true,
        quantity: true,
        SymbolProfile: { select: { symbol: true } },
        type: true,
        unitPrice: true
      },
      where: { userId }
    });

    const sqlText =
      'MERGE INTO orders_history t ' +
      'USING (SELECT ? AS order_id, ? AS user_id, TO_DATE(?) AS date, ' +
      '? AS type, ? AS ticker, ? AS quantity, ? AS unit_price, ' +
      '? AS fee, ? AS currency, CURRENT_TIMESTAMP() AS synced_at) s ' +
      'ON t.order_id = s.order_id ' +
      'WHEN MATCHED THEN UPDATE SET ' +
      'user_id = s.user_id, date = s.date, type = s.type, ' +
      'ticker = s.ticker, quantity = s.quantity, ' +
      'unit_price = s.unit_price, fee = s.fee, ' +
      'currency = s.currency, synced_at = s.synced_at ' +
      'WHEN NOT MATCHED THEN INSERT (' +
      'order_id, user_id, date, type, ticker, quantity, ' +
      'unit_price, fee, currency, synced_at' +
      ') VALUES (' +
      's.order_id, s.user_id, s.date, s.type, s.ticker, ' +
      's.quantity, s.unit_price, s.fee, s.currency, s.synced_at' +
      ')';

    for (const order of orders) {
      // Compile-time row contract — guarantees the bind array matches the
      // Snowflake column ordering. The interface lives in
      // `interfaces/snowflake-rows.interface.ts` and is the single source
      // of truth for the `orders_history` row shape.
      const row: OrdersHistoryRow = {
        currency: order.currency ?? null,
        date: this.getIsoDate(order.date),
        fee:
          order.fee !== null && order.fee !== undefined
            ? Number(order.fee)
            : null,
        order_id: order.id,
        quantity:
          order.quantity !== null && order.quantity !== undefined
            ? Number(order.quantity)
            : null,
        // `synced_at` is computed by Snowflake via CURRENT_TIMESTAMP() in
        // the MERGE source, so the row is built without a client-side
        // value here — null is the type-safe placeholder.
        synced_at: null,
        ticker: order.SymbolProfile?.symbol ?? null,
        type: String(order.type),
        unit_price:
          order.unitPrice !== null && order.unitPrice !== undefined
            ? Number(order.unitPrice)
            : null,
        user_id: userId
      };

      await this.executeQuery(sqlText, [
        row.order_id,
        row.user_id,
        row.date,
        row.type,
        row.ticker,
        row.quantity,
        row.unit_price,
        row.fee,
        row.currency
      ]);
    }

    return orders.length;
  }

  /**
   * Mirrors the user's per-asset-class allocation snapshot for `date`
   * to the Snowflake `portfolio_snapshots` table.
   *
   * Delegates to the existing exported `PortfolioService.getDetails(...)`
   * to compute holdings — the new code does NOT replicate any portfolio
   * computation logic (Rule 1 — Module Isolation; cross-module access
   * is allowed only through the public `exports` array of the source
   * module, and `PortfolioService` is exported by `PortfolioModule`).
   *
   * Aggregation:
   *   - Group `details.holdings` by `assetClass` (defaulting to
   *     `'UNKNOWN'` for entries missing the field).
   *   - Compute the total portfolio value across all holdings.
   *   - For each asset class, compute its allocation percentage
   *     `value / totalValue * 100`.
   *
   * MERGE shape (Rule 7):
   *   - Keyed on the unique tuple `(snapshot_date, user_id, asset_class)`.
   *   - One MERGE per asset class — running twice for the same `date`
   *     leaves row counts unchanged.
   *
   * Returns the number of asset-class rows merged.
   */
  public async syncSnapshots(userId: string, date: string): Promise<number> {
    // Lazy-resolve `PortfolioService` per invocation to avoid
    // promoting this service to REQUEST scope. The `userId` argument
    // is forwarded so a synthetic REQUEST provider with a matching
    // `request.user.id` is registered under the synthetic contextId
    // — this is required because `PortfolioService` transitively
    // injects `ImpersonationService`, which dereferences
    // `this.request.user` unconditionally inside
    // `validateImpersonationId(...)`. See `resolvePortfolioService()`
    // for the full rationale.
    const portfolioService = await this.resolvePortfolioService(userId);
    // `impersonationId: undefined` mirrors the existing controller pattern
    // when no `x-impersonation-id` header is present. `validateImpersonationId`
    // falls back to its default `aId = ''`, which Prisma accepts. Passing
    // `null` here is rejected by Prisma 7 (`Argument 'id' must not be null`)
    // because `Access.id` is a non-nullable string column. See QA Checkpoint 9
    // CRITICAL #1 follow-on (Prisma rejection after the synthetic-REQUEST
    // provider unblocks `this.request.user` access).
    const details = await portfolioService.getDetails({
      dateRange: 'max',
      impersonationId: undefined,
      userId,
      withMarkets: false,
      withSummary: false
    });

    const holdings = details?.holdings ?? {};

    let totalValue = 0;
    const allocationsByAssetClass: Record<string, number> = {};

    for (const holding of Object.values(holdings)) {
      const value = Number(holding?.valueInBaseCurrency);

      if (!Number.isFinite(value)) {
        continue;
      }

      totalValue += value;

      const assetClass: string = holding?.assetClass
        ? String(holding.assetClass)
        : 'UNKNOWN';

      allocationsByAssetClass[assetClass] =
        (allocationsByAssetClass[assetClass] ?? 0) + value;
    }

    const sqlText =
      'MERGE INTO portfolio_snapshots t ' +
      'USING (SELECT TO_DATE(?) AS snapshot_date, ? AS user_id, ' +
      '? AS asset_class, ? AS allocation_pct, ' +
      '? AS total_value_usd) s ' +
      'ON t.snapshot_date = s.snapshot_date ' +
      'AND t.user_id = s.user_id ' +
      'AND t.asset_class = s.asset_class ' +
      'WHEN MATCHED THEN UPDATE SET ' +
      'allocation_pct = s.allocation_pct, ' +
      'total_value_usd = s.total_value_usd ' +
      'WHEN NOT MATCHED THEN INSERT (' +
      'snapshot_date, user_id, asset_class, ' +
      'allocation_pct, total_value_usd' +
      ') VALUES (' +
      's.snapshot_date, s.user_id, s.asset_class, ' +
      's.allocation_pct, s.total_value_usd' +
      ')';

    let rowsMerged = 0;

    for (const [assetClass, value] of Object.entries(allocationsByAssetClass)) {
      const allocationPct = totalValue > 0 ? (value / totalValue) * 100 : 0;

      // Compile-time row contract for the `portfolio_snapshots` table.
      const row: PortfolioSnapshotRow = {
        allocation_pct: allocationPct,
        asset_class: assetClass,
        snapshot_date: date,
        total_value_usd: totalValue,
        user_id: userId
      };

      await this.executeQuery(sqlText, [
        row.snapshot_date,
        row.user_id,
        row.asset_class,
        row.allocation_pct,
        row.total_value_usd
      ]);

      rowsMerged += 1;
    }

    return rowsMerged;
  }

  /**
   * Mirrors the user's performance metrics for `date` to the Snowflake
   * `performance_metrics` table.
   *
   * Delegates to the existing exported `PortfolioService.getPerformance(...)`
   * (Rule 1) and reads the `netPerformancePercentage` field as the TWR
   * value (Time-Weighted Return). The Ghostfolio `PortfolioPerformance`
   * interface does NOT expose `volatility` or `sharpeRatio` at this
   * boundary, so these columns are written as `null` — the column
   * definitions in `bootstrap.sql` allow `NULL` for both fields,
   * matching the type definitions in `interfaces/snowflake-rows.interface.ts`
   * (`number | null` for `volatility` and `sharpe_ratio`).
   *
   * MERGE shape (Rule 7):
   *   - Keyed on the unique tuple `(metric_date, user_id)`.
   *   - Running twice for the same `date` leaves row counts unchanged.
   */
  public async syncMetrics(userId: string, date: string): Promise<void> {
    // Lazy-resolve `PortfolioService` per invocation to avoid
    // promoting this service to REQUEST scope. The `userId` argument
    // is forwarded so a synthetic REQUEST provider with a matching
    // `request.user.id` is registered under the synthetic contextId
    // — this is required because `PortfolioService` transitively
    // injects `ImpersonationService`, which dereferences
    // `this.request.user` unconditionally inside
    // `validateImpersonationId(...)`. See `resolvePortfolioService()`
    // for the full rationale.
    const portfolioService = await this.resolvePortfolioService(userId);
    // `impersonationId: undefined` (not `null`) — see `syncSnapshots` for the
    // full Prisma-rejection rationale (QA Checkpoint 9 CRITICAL #1 follow-on).
    const performance = await portfolioService.getPerformance({
      dateRange: 'max',
      impersonationId: undefined,
      userId
    });

    const twrValue = performance?.performance?.netPerformancePercentage;
    const twr = Number.isFinite(twrValue) ? Number(twrValue) : null;
    // Volatility and Sharpe ratio are not currently surfaced by
    // `PortfolioService.getPerformance(...)`. Per AAP Phase 9 guidance,
    // these are written as `null` placeholders. A `Logger.warn` call is
    // intentionally avoided because the missing data is a known structural
    // gap rather than a runtime anomaly.
    const volatility: number | null = null;
    const sharpeRatio: number | null = null;

    const sqlText =
      'MERGE INTO performance_metrics t ' +
      'USING (SELECT TO_DATE(?) AS metric_date, ? AS user_id, ' +
      '? AS twr, ? AS volatility, ? AS sharpe_ratio) s ' +
      'ON t.metric_date = s.metric_date AND t.user_id = s.user_id ' +
      'WHEN MATCHED THEN UPDATE SET ' +
      'twr = s.twr, volatility = s.volatility, ' +
      'sharpe_ratio = s.sharpe_ratio ' +
      'WHEN NOT MATCHED THEN INSERT (' +
      'metric_date, user_id, twr, volatility, sharpe_ratio' +
      ') VALUES (' +
      's.metric_date, s.user_id, s.twr, s.volatility, s.sharpe_ratio' +
      ')';

    // Compile-time row contract for the `performance_metrics` table.
    const row: PerformanceMetricRow = {
      metric_date: date,
      sharpe_ratio: sharpeRatio,
      twr,
      user_id: userId,
      volatility
    };

    await this.executeQuery(sqlText, [
      row.metric_date,
      row.user_id,
      row.twr,
      row.volatility,
      row.sharpe_ratio
    ]);
  }

  /**
   * Read-only Snowflake query path consumed by the Claude chat agent's
   * `query_history` tool.
   *
   * The chat agent supplies an LLM-generated `sql` string and a typed
   * `binds` array. This method:
   *   1. Validates that `sql` is a non-empty string.
   *   2. Strips comments and verifies the leading non-whitespace token
   *      is `SELECT` or `WITH` (case-insensitive). DML (`INSERT`,
   *      `UPDATE`, `DELETE`, `MERGE`) and DDL (`CREATE`, `DROP`,
   *      `ALTER`, `TRUNCATE`) statements are rejected — `query_history`
   *      is a READ-ONLY tool surface (defense-in-depth on top of the
   *      Snowflake account-level permissions configured for the
   *      `SNOWFLAKE_USER` principal).
   *   3. Rejects any `sql` containing a `;` outside string literals via
   *      a hand-rolled state machine that tracks single- and double-
   *      quote nesting (defense-in-depth against the LLM batching
   *      multiple statements into a single tool invocation per AAP
   *      § 0.5.1.5).
   *   4. Wraps the LLM-supplied `sql` in an outer `SELECT * FROM (<sql>)
   *      LIMIT N` to cap the row count at `QUERY_HISTORY_ROW_LIMIT`.
   *      The numeric limit is interpolated from a constant static class
   *      field — this is the only template-literal interpolation in
   *      this file and is permitted by Rule 2 because the value is
   *      not caller-controlled.
   *   5. Forwards the `binds` array unchanged to `executeQuery(...)`.
   *      The `snowflake-sdk` driver handles bind escaping at the
   *      transport layer, so no string-level escaping is performed
   *      here.
   *
   * The `userId` parameter is logged for traceability. Per AAP § 0.7.3,
   * the chat-agent service is responsible for prepending the JWT-
   * authenticated `userId` to the `binds` array as needed; this method
   * does NOT inject `userId` into the SQL or binds because it cannot
   * know the LLM-generated SQL's parameter ordering.
   *
   * @returns Up to `QUERY_HISTORY_ROW_LIMIT` rows from the underlying
   *          Snowflake query.
   * @throws {Error} when `sql` is empty, is not a SELECT/WITH query, or
   *                 contains a top-level semicolon.
   */
  public async queryHistory(
    userId: string,
    sql: string,
    binds: (string | number | boolean | null)[]
  ): Promise<unknown[]> {
    if (typeof sql !== 'string' || sql.length === 0) {
      throw new Error('queryHistory: sql must be a non-empty string');
    }

    // Strip comments BEFORE the leading-keyword check so that a comment
    // prefix (e.g., `-- explain\nSELECT ...` or `/* note */ SELECT ...`)
    // does not mask the leading SELECT/WITH token.
    const sqlWithoutComments = this.stripSqlComments(sql);

    if (
      !SnowflakeSyncService.READ_ONLY_LEADING_KEYWORD_PATTERN.test(
        sqlWithoutComments
      )
    ) {
      throw new Error(
        'queryHistory: only SELECT or WITH queries are permitted'
      );
    }

    if (this.containsSemicolonOutsideStringLiterals(sql)) {
      throw new Error(
        'queryHistory: SQL containing a semicolon outside string literals is rejected'
      );
    }

    const safeBinds = Array.isArray(binds) ? binds : [];
    const correlationId = randomUUID();

    Logger.log(
      `[${correlationId}] queryHistory called by user=${userId} ` +
        `(binds=${safeBinds.length})`,
      'SnowflakeSyncService'
    );

    // The numeric limit is interpolated from a constant static class
    // field — permitted by Rule 2 because the value is not
    // caller-controlled. Caller-supplied content (`sql`) is wrapped
    // unmodified inside the outer SELECT, and caller-supplied values
    // travel via `safeBinds`.
    const limitedSql = `SELECT * FROM (${sql}) LIMIT ${SnowflakeSyncService.QUERY_HISTORY_ROW_LIMIT}`;

    return this.executeQuery(limitedSql, safeBinds);
  }

  /**
   * Lazily resolves a per-invocation `PortfolioService` instance for
   * the supplied `userId`.
   *
   * Why lazy resolution instead of constructor injection?
   *
   *   `PortfolioService` injects `@Inject(REQUEST)` (per
   *   `apps/api/src/app/portfolio/portfolio.service.ts`), which forces
   *   it to REQUEST scope. NestJS's scope-bubble-up rules
   *   (https://docs.nestjs.com/fundamentals/injection-scopes#scope-hierarchy)
   *   then promote any DEFAULT-scoped class that constructor-injects
   *   `PortfolioService` to REQUEST scope as well — i.e., the entire
   *   `SnowflakeSyncService` becomes a non-static provider in the DI
   *   tree. The `@nestjs/schedule` `ScheduleExplorer` rejects
   *   `@Cron(...)` decorators on non-static providers with the warning
   *   "Cannot register cron job ... because it is defined in a non
   *   static provider", because the scheduler needs a singleton method
   *   reference to bind to a CronJob instance — there is no incoming
   *   request to derive a request scope from when the cron timer
   *   fires. The same restriction applies to `@OnEvent(...)` handlers,
   *   which run outside any HTTP request lifecycle.
   *
   * The fix is to break the static-tree dependency: this service no
   * longer constructor-injects `PortfolioService`. Instead, the daily
   * cron, the event-driven sync, and the manual-trigger paths all
   * call this helper, which uses `ModuleRef.resolve(...)` with a
   * fresh `ContextIdFactory.create()` to instantiate a `PortfolioService`
   * for the synthetic context.
   *
   * Why the synthetic REQUEST registration?
   *
   *   Earlier iterations of this method deliberately omitted any
   *   `registerRequestByContextId(...)` call on the assumption that
   *   `PortfolioService.getDetails(...)` and `getPerformance(...)`
   *   accept `userId` explicitly and therefore do not rely on
   *   `this.request.user.id`. That assumption was INCORRECT at runtime.
   *   `PortfolioService` invokes
   *   `await this.impersonationService.validateImpersonationId(...)`
   *   inside its private `getUserId(impersonationId, userId)` helper
   *   (which the public `getDetails`/`getPerformance` calls reach into
   *   even when `impersonationId === null`), and
   *   `ImpersonationService.validateImpersonationId(...)` dereferences
   *   `this.request.user` unconditionally on its first line. With no
   *   REQUEST provider bound to the synthetic contextId, `this.request`
   *   is `undefined` — and the cron, the daily sync, AND the admin
   *   manual-trigger code paths all fail with
   *   `TypeError: Cannot read properties of undefined (reading 'user')`.
   *   See QA Test Report — Checkpoint 9 (CRITICAL Issue #1) for the
   *   confirmed reproduction.
   *
   *   `ModuleRef.registerRequestByContextId({...}, contextId)` binds a
   *   plain object as the `REQUEST` provider for the duration of the
   *   resolved-context lifetime. The injected `request.user.id` matches
   *   the JWT-authoritative `userId` passed to this helper, so any
   *   subsequent access permission lookups inside `ImpersonationService`
   *   (e.g., `this.prismaService.access.findFirst({...granteeUserId:
   *   this.request.user.id})`) operate on behalf of the correct user
   *   and never bleed across user boundaries. The `permissions` array is
   *   intentionally empty: the only branch that consults
   *   `request.user.permissions` is the `impersonateAllUsers` check,
   *   and the cron/event/manual-sync paths NEVER call `getDetails(...)`
   *   with a non-null `impersonationId`, so the impersonation branch is
   *   structurally unreachable here.
   *
   * The `strict: false` flag instructs `ModuleRef.resolve()` to search
   * the entire module hierarchy rather than only the host module's
   * injector, since `PortfolioService` is exported by `PortfolioModule`
   * (which is imported transitively, not directly, by this module —
   * `SnowflakeSyncModule.imports` lists `PortfolioModule` per
   * AAP § 0.5.1.1, but the resolve API is more robust to module-graph
   * reorganization).
   *
   * Each call creates a NEW context id and therefore a NEW
   * `PortfolioService` instance. The instances are short-lived (one
   * per snapshot or metrics sync) and garbage-collected after the
   * MERGE completes. This is intentionally identical in spirit to
   * the per-request lifecycle that `PortfolioService` was designed
   * for — the cron just synthesizes a context rather than receiving
   * one from an HTTP layer.
   *
   * @param userId JWT-authoritative user id whose portfolio data the
   *               resolved `PortfolioService` will compute. The id is
   *               also used to populate the synthetic `request.user.id`
   *               so that REQUEST-scoped collaborators (e.g.,
   *               `ImpersonationService`) can access it without a
   *               TypeError.
   */
  private async resolvePortfolioService(
    userId: string
  ): Promise<PortfolioService> {
    const contextId = ContextIdFactory.create();

    // Register a synthetic REQUEST provider for this contextId BEFORE
    // resolving any REQUEST-scoped collaborators. The shape mirrors
    // the runtime `RequestWithUser` envelope expected by
    // `ImpersonationService` (which only reads `request.user.id` and
    // `request.user.permissions`). The empty `permissions` array is
    // safe here because the cron / event / manual-sync paths never
    // invoke `getDetails(...)` with a non-null `impersonationId`, so
    // the `hasPermission(..., impersonateAllUsers)` branch is
    // structurally unreachable.
    this.moduleRef.registerRequestByContextId(
      {
        user: {
          id: userId,
          permissions: []
        }
      },
      contextId
    );

    return this.moduleRef.resolve(PortfolioService, contextId, {
      strict: false
    });
  }

  /**
   * Deferred body of the `PortfolioChangedEvent` handler that fires
   * after the 5-second debounce window. Generates its own correlation
   * id (since the original event handler returns immediately and the
   * sync runs asynchronously) and emits the matching latency/outcome
   * metrics.
   */
  private async processDebouncedEventSync(userId: string): Promise<void> {
    const correlationId = randomUUID();
    const startTime = Date.now();

    Logger.log(
      `[${correlationId}] Debounced PortfolioChangedEvent firing for user ${userId}`,
      'SnowflakeSyncService'
    );

    try {
      const rowsMerged = await this.syncOrders(userId);
      this.metricsService.incrementCounter('snowflake_sync_runs_total', 1, {
        outcome: 'success',
        trigger: 'event'
      });
      Logger.log(
        `[${correlationId}] Order sync triggered by event for user ${userId} ` +
          `(rowsMerged=${rowsMerged})`,
        'SnowflakeSyncService'
      );
    } catch (error) {
      this.metricsService.incrementCounter('snowflake_sync_runs_total', 1, {
        outcome: 'failure',
        trigger: 'event'
      });
      Logger.error(
        `[${correlationId}] Event-driven sync failed for user ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'SnowflakeSyncService'
      );
    } finally {
      this.metricsService.observeHistogram(
        'snowflake_sync_latency_seconds',
        (Date.now() - startTime) / 1000,
        { trigger: 'event' }
      );
    }
  }

  /**
   * Loads the bootstrap DDL statements.
   *
   * Strategy:
   *   1. Resolve `sql/bootstrap.sql` relative to `__dirname` and read
   *      it via `fs.readFile(...)`. The `node:path.join(...)` call is
   *      used to assemble the path in a cross-platform way (Phase 3
   *      of the agent prompt).
   *   2. If the read succeeds, split the file content on `;\s*\n` and
   *      return the trimmed, non-empty fragments. The split-on-`;\n`
   *      parser is intentional and safe because the SQL file is a
   *      static, version-controlled DDL script — no caller-controlled
   *      value is interpolated.
   *   3. If the read fails (e.g., the SQL asset is not co-located with
   *      the compiled bundle), fall back to the inlined static
   *      `FALLBACK_BOOTSTRAP_STATEMENTS` constant. This keeps
   *      `bootstrap()` always able to issue the three CREATE TABLE
   *      statements regardless of the build-time asset configuration.
   */
  private async loadBootstrapStatements(): Promise<string[]> {
    const sqlPath = join(__dirname, 'sql', 'bootstrap.sql');

    try {
      const sqlSource = await fs.readFile(sqlPath, 'utf-8');
      const statements = sqlSource
        .split(/;\s*\n/)
        .map((s) => this.stripSqlComments(s).trim())
        .filter((s) => s.length > 0);

      if (statements.length > 0) {
        return statements;
      }

      // The on-disk file was readable but contained no executable
      // statements after stripping comments — fall through to the
      // inlined fallback rather than executing nothing.
      Logger.warn(
        `Snowflake bootstrap SQL file at ${sqlPath} contained no statements; ` +
          `falling back to inlined DDL`,
        'SnowflakeSyncService'
      );
    } catch (error) {
      Logger.warn(
        `Snowflake bootstrap SQL file not readable at ${sqlPath} ` +
          `(${error instanceof Error ? error.message : String(error)}); ` +
          `falling back to inlined DDL`,
        'SnowflakeSyncService'
      );
    }

    return [...SnowflakeSyncService.FALLBACK_BOOTSTRAP_STATEMENTS];
  }

  /**
   * Strips line comments (`-- ...`) and block comments (`/* ... *\/`)
   * from a SQL fragment. Used by `loadBootstrapStatements()` so that
   * a comment-only segment between two DDL statements does not produce
   * a spurious empty `executeQuery(...)` call.
   *
   * Note: this is a permissive comment stripper appropriate for the
   * static, version-controlled `bootstrap.sql` asset. It is NOT a
   * general SQL tokenizer and MUST NOT be used to sanitize
   * caller-controlled SQL — the `queryHistory` path uses its own
   * defense-in-depth checks (`containsSemicolonOutsideStringLiterals`).
   */
  private stripSqlComments(sql: string): string {
    let result = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    result = result
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--');
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join('\n');
    return result;
  }

  /**
   * State-machine SQL semicolon detector.
   *
   * Walks the input string character-by-character tracking whether the
   * cursor is currently inside a single-quoted (`'`) or double-quoted
   * (`"`) string literal. Returns `true` if a `;` is encountered at
   * the top level (i.e., outside both quote contexts), `false`
   * otherwise.
   *
   * The detector is sufficient for AAP § 0.5.1.5 defense-in-depth —
   * the goal is to reject the LLM batching multiple statements into a
   * single `query_history` tool call, not to perform full SQL parsing.
   * Edge cases:
   *   - Escaped single quote (`''`) inside a single-quoted literal is
   *     handled correctly because the inner `'` flips the
   *     `inSingleQuote` flag twice in succession, leaving the cursor
   *     inside the literal.
   *   - SQL backslash-escaped quotes (`\'`) are NOT specially handled.
   *     This is acceptable for the chat-agent path because Snowflake's
   *     default SQL dialect uses doubled-quote escaping rather than
   *     backslash escaping.
   */
  private containsSemicolonOutsideStringLiterals(sql: string): boolean {
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (const ch of sql) {
      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      } else if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
        return true;
      }
    }

    return false;
  }

  /**
   * Returns the ISO-8601 calendar date (`YYYY-MM-DD`) for `date` in UTC.
   *
   * Used wherever a SQL `DATE` column is bound — `Date.toISOString()`
   * always emits UTC, so the resulting string is unambiguous regardless
   * of host timezone configuration. This complements the explicit
   * `timeZone: 'UTC'` option on the daily cron decorator (AAP § 0.7.3).
   */
  private getIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  /**
   * Promise-wrapped Snowflake bridge.
   *
   * Acquires the shared connection from `SnowflakeClientFactory` (lazy
   * pool with keep-alive) and issues the parameterized `execute(...)`
   * call. The callback API is wrapped inline — NO external
   * `snowflake-promise` package is introduced (per AAP § 0.7.3).
   *
   * Errors are logged WITHOUT the `binds` array (binds may carry
   * sensitive values such as user identifiers passed through the chat
   * tool). Only the SDK's own `err.message` is surfaced.
   */
  private async executeQuery(
    sqlText: string,
    binds: (string | number | boolean | null | Date)[]
  ): Promise<unknown[]> {
    const connection = await this.snowflakeClientFactory.getConnection();

    return new Promise<unknown[]>((resolve, reject) => {
      // The `snowflake-sdk` `Bind` type definition is conservatively
      // narrowed to `string | number` in `@types/snowflake-sdk`, but
      // the runtime driver accepts `boolean`, `null`, and `Date` values
      // and serializes them appropriately for the SQL bind protocol.
      // The `unknown[]` cast bridges the type gap without weakening
      // the public method signature, which preserves callers' type
      // safety.
      connection.execute({
        binds: binds as unknown as (string | number)[],
        complete: (err, _stmt, rows) => {
          if (err) {
            const errorMessage =
              err instanceof Error ? err.message : 'unknown error';
            Logger.error(
              `Snowflake query error: ${errorMessage}`,
              'SnowflakeSyncService'
            );
            reject(err);
          } else {
            resolve(rows ?? []);
          }
        },
        sqlText
      });
    });
  }
}
