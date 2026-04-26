import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { PortfolioChangedEvent } from '@ghostfolio/api/events/portfolio-changed.event';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SnowflakeClientFactory } from './snowflake-client.factory';
import { SnowflakeSyncService } from './snowflake-sync.service';

/**
 * Unit tests for `SnowflakeSyncService`.
 *
 * Source-of-truth references:
 *   - AAP § 0.2.4.2 — "cron registration, event handler, MERGE bind-variable
 *     usage (no template literals), idempotency (running twice does not
 *     duplicate rows)".
 *   - AAP § 0.5.1.4 — adds "query_history parameter validation" and explicit
 *     regex assertion that no `${...}` template appears within MERGE SQL.
 *   - AAP § 0.7.5 (Snowflake sync gate) — cron registration, event-driven
 *     same-request-lifecycle sync, idempotent re-runs.
 *   - AAP § 0.7.5.2 (Security sweep gate) — Rule 2 (no string concatenation
 *     adjacent to SQL strings) and Rule 3 (no `process.env.SNOWFLAKE_*`).
 *
 * Hard rules verified by this spec (all per AAP § 0.7):
 *   - Rule 2 (Parameterized Snowflake Queries) — Test 3 asserts MERGE
 *     statements emitted by the service contain neither template-literal
 *     interpolation (`${...}`) nor SQL-string concatenation patterns, and
 *     accompany every `?` placeholder with a `binds` array entry.
 *   - Rule 3 (Credential Access via ConfigService) — Test 6 asserts the
 *     service-source file does NOT reference `process.env.SNOWFLAKE_*`
 *     or `process.env.ANTHROPIC_API_KEY`. Per the Checkpoint C remediation,
 *     `SnowflakeSyncService` no longer reads any configuration directly —
 *     all SNOWFLAKE_* env vars are read inside `SnowflakeClientFactory`,
 *     which is the only consumer of `ConfigService` in this feature module.
 *   - Rule 7 (Snowflake Sync Idempotency) — Test 4 asserts running
 *     `syncOrders(...)` twice never produces an `INSERT INTO orders_history`
 *     statement outside of a MERGE block.
 *
 * Test-pattern anchors (Ghostfolio convention):
 *   - `apps/api/src/services/data-provider/data-enhancer/yahoo-finance/yahoo-finance.service.spec.ts`
 *     — `jest.mock(...)` factory pattern at module scope.
 *   - `apps/api/src/services/benchmark/benchmark.service.spec.ts` — direct
 *     instantiation `new Service(null, null, ...)` per test.
 *   - `apps/api/src/app/portfolio/current-rate.service.spec.ts` — multi-mock
 *     pattern, one `jest.mock(...)` factory per dependency.
 *   - `apps/api/src/app/user-financial-profile/user-financial-profile.service.spec.ts`
 *     — Sibling Feature B/C spec demonstrating the same mock-and-instantiate
 *     pattern adopted here.
 */

/**
 * Mocks the global `ConfigService` from `@nestjs/config` at module-load
 * time. The mock returns a stub instance whose `get(key)` resolves the six
 * `SNOWFLAKE_*` env vars from a static lookup table.
 *
 * `ConfigService` is consumed by the sibling `SnowflakeClientFactory` (which
 * reads the SNOWFLAKE_* values when constructing the snowflake-sdk
 * connection); `SnowflakeSyncService` itself no longer takes a
 * `ConfigService` dependency post-Checkpoint-C remediation. This mock
 * therefore exists exclusively to satisfy the factory's typed constructor
 * signature when the factory is instantiated in `beforeEach`.
 */
jest.mock('@nestjs/config', () => {
  return {
    ConfigService: jest.fn().mockImplementation(() => ({
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          SNOWFLAKE_ACCOUNT: 'test-account',
          SNOWFLAKE_DATABASE: 'TEST_DB',
          SNOWFLAKE_PASSWORD: 'test-password',
          SNOWFLAKE_SCHEMA: 'TEST_SCHEMA',
          SNOWFLAKE_USER: 'test-user',
          SNOWFLAKE_WAREHOUSE: 'TEST_WH'
        };
        return values[key];
      })
    }))
  };
});

/**
 * Mocks `MetricsService` so `SnowflakeSyncService.constructor`,
 * `runDailySync`, `processDebouncedEventSync`, and `triggerManualSync` can
 * record their counter and histogram observations without touching the
 * real in-process registry.
 *
 * The mock implementation returns a fresh stub instance per
 * `new MetricsService()` call. Each stub exposes the three public methods
 * that the production service consumes (`registerHelp`, `incrementCounter`,
 * `observeHistogram`) as `jest.fn()` spies; tests can introspect
 * `mock.calls` to verify counter/histogram emission, although the
 * Checkpoint C review feedback only requires WIRING (constructor injection),
 * not assertion-level behavioral coverage of metric labels.
 *
 * The stub deliberately omits the internal Map-based registry of the real
 * service — counters and histograms accumulate as jest call records, not
 * as Prometheus exposition state.
 */
jest.mock('@ghostfolio/api/app/metrics/metrics.service', () => {
  return {
    MetricsService: jest.fn().mockImplementation(() => ({
      incrementCounter: jest.fn(),
      observeHistogram: jest.fn(),
      registerHelp: jest.fn()
    }))
  };
});

/**
 * Mocks the sibling `SnowflakeClientFactory` so every SQL invocation made
 * by `SnowflakeSyncService.executeQuery(...)` lands in a per-instance
 * `__executedQueries` capture array — the test-only collection inspected
 * by Tests 3 (Rule 2 MERGE bind-variable usage), 4 (Rule 7 idempotency),
 * 5 (queryHistory parameter validation), and 7 (bootstrap DDL).
 *
 * The mock implementation is a closure: each `new SnowflakeClientFactory(...)`
 * call constructs a fresh `executedQueries` array, a fresh `getConnection`
 * jest.fn(), and a fresh `execute` jest.fn(). This is intentional —
 * `beforeEach` re-instantiates the factory per test so call history never
 * carries across `it(...)` blocks.
 *
 * The `complete` callback is invoked synchronously with `(err=undefined,
 * stmt={getNumRows: () => 0}, rows=[])` so the service's promise-wrapped
 * `executeQuery(...)` resolves with `[]` and tests can run end-to-end.
 */
jest.mock('./snowflake-client.factory', () => {
  return {
    SnowflakeClientFactory: jest.fn().mockImplementation(() => {
      const executedQueries: {
        sqlText: string;
        binds?: unknown[];
      }[] = [];

      const execute = jest.fn(
        ({
          binds,
          complete,
          sqlText
        }: {
          binds?: unknown[];
          complete?: (
            err: Error | undefined,
            stmt: { getNumRows: () => number },
            rows: unknown[]
          ) => void;
          sqlText: string;
        }) => {
          executedQueries.push({ binds, sqlText });

          if (complete) {
            complete(undefined, { getNumRows: () => 0 }, []);
          }
        }
      );

      const connection = { execute };

      return {
        __executedQueries: executedQueries,
        disconnect: jest.fn().mockResolvedValue(undefined),
        getConnection: jest.fn().mockResolvedValue(connection)
      };
    })
  };
});

/**
 * Mocks the global `PrismaService` so the spec never touches a real
 * PostgreSQL instance. `order.findMany` resolves to a single canonical
 * order row sufficient to drive the `MERGE INTO orders_history` path
 * (Test 3 / Test 4 require at least one order to exist for a MERGE
 * statement to be emitted).
 *
 * `user.findMany` resolves to a one-element list so `runDailySync()`
 * has at least one user to iterate. `financialProfile` is provided as a
 * defensive stub in case the implementation evolves to read it.
 */
jest.mock('@ghostfolio/api/services/prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => ({
      financialProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(null)
      },
      order: {
        findMany: jest.fn().mockResolvedValue([
          {
            currency: 'USD',
            date: new Date('2025-01-15T00:00:00.000Z'),
            fee: 1.99,
            id: 'order-test-uuid-1',
            quantity: 10,
            SymbolProfile: { symbol: 'AAPL' },
            type: 'BUY',
            unitPrice: 150.5
          }
        ])
      },
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'user-test-uuid' }])
      }
    }))
  };
});

/**
 * Mocks `PortfolioService` so `syncSnapshots(...)` and `syncMetrics(...)`
 * (invoked by `runDailySync()` and `triggerManualSync(...)`) execute
 * end-to-end without resolving the real 13-argument constructor or its
 * deep dependency tree (PortfolioCalculator, BenchmarkService, etc.).
 *
 * `getDetails` returns a single-asset-class holdings map so
 * `syncSnapshots` emits exactly one `MERGE INTO portfolio_snapshots`
 * statement. `getPerformance` returns a fully-populated performance
 * envelope so `syncMetrics` emits exactly one `MERGE INTO
 * performance_metrics` statement.
 */
jest.mock('@ghostfolio/api/app/portfolio/portfolio.service', () => {
  return {
    PortfolioService: jest.fn().mockImplementation(() => ({
      getDetails: jest.fn().mockResolvedValue({
        accounts: {},
        holdings: {
          AAPL: {
            assetClass: 'EQUITY',
            valueInBaseCurrency: 1500
          }
        },
        markets: {}
      }),
      getPerformance: jest.fn().mockResolvedValue({
        chart: [],
        performance: {
          netPerformance: 0,
          netPerformanceInPercentage: 0,
          netPerformanceInPercentageWithCurrencyEffect: 0,
          netPerformancePercentage: 0.075,
          netPerformanceWithCurrencyEffect: 0,
          netWorth: 1500
        }
      })
    }))
  };
});

describe('SnowflakeSyncService', () => {
  /**
   * The single test user identifier reused across every it(...) block.
   * Using a stable UUID-shaped string makes failure logs easier to read
   * and signals "this is a test fixture, not a real user".
   */
  const TEST_USER_ID = 'user-test-uuid';

  let configService: ConfigService;
  let factory: SnowflakeClientFactory;
  let metricsService: MetricsService;
  let portfolioService: PortfolioService;
  let prismaService: PrismaService;
  let service: SnowflakeSyncService;

  beforeEach(() => {
    // Reset jest.fn() call history but preserve the mock factory
    // implementations registered above. Each `new ...` call below
    // constructs a fresh closure with its own `executedQueries` array.
    jest.clearAllMocks();

    // `ConfigService` is no longer a dependency of `SnowflakeSyncService`
    // (post-Checkpoint-C remediation). The instance is retained here
    // exclusively to satisfy the typed constructor signature of the
    // sibling `SnowflakeClientFactory`, which still reads the
    // SNOWFLAKE_* env vars via the injected `ConfigService.get(...)`.
    configService = new ConfigService();

    // Fresh `MetricsService` stub per test (see `jest.mock(...)` block
    // at module scope above). The stub exposes `registerHelp`,
    // `incrementCounter`, and `observeHistogram` as `jest.fn()` spies.
    metricsService = new MetricsService();

    // PrismaService's real constructor takes a single ConfigService
    // argument — passing `null` bypasses the real Prisma adapter
    // initialization since the class itself is replaced by the mock
    // factory above.
    prismaService = new PrismaService(null);

    // The real PortfolioService constructor takes 13 dependencies. The
    // mock factory ignores all arguments, so passing 13 nulls is a
    // self-documenting placeholder that matches the actual signature
    // verified at compile time by `tsc`.
    portfolioService = new PortfolioService(
      null, // accountBalanceService
      null, // accountService
      null, // activitiesService
      null, // benchmarkService
      null, // calculatorFactory
      null, // dataProviderService
      null, // exchangeRateDataService
      null, // i18nService
      null, // impersonationService
      null, // request (REQUEST scope)
      null, // rulesService
      null, // symbolProfileService
      null // userService
    );

    factory = new SnowflakeClientFactory(configService);

    // Constructor signature post-Checkpoint-C remediation:
    // `(metricsService, prismaService, portfolioService, snowflakeClientFactory)`.
    // The previous `configService` first-argument was removed because the
    // service body no longer reads any configuration directly.
    service = new SnowflakeSyncService(
      metricsService,
      prismaService,
      portfolioService,
      factory
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — @Cron decorator metadata (cron registration)
  // -------------------------------------------------------------------------

  it('decorates runDailySync with @Cron at "0 2 * * *" UTC named "snowflake-daily-sync" (AAP § 0.7.5 Snowflake sync gate)', () => {
    // The @nestjs/schedule @Cron decorator stores its metadata on the
    // decorated function (descriptor.value) via Reflect.defineMetadata.
    // The metadata keys are the string constants exported by
    // `@nestjs/schedule/dist/schedule.constants` — using the literal
    // strings here avoids a fragile deep import path that varies by
    // SDK version (the public `@nestjs/schedule` index does not re-
    // export these constants).
    const cronTarget = (
      SnowflakeSyncService.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >
    ).runDailySync;

    expect(typeof cronTarget).toBe('function');

    const schedulerName: unknown = Reflect.getMetadata(
      'SCHEDULER_NAME',
      cronTarget
    );
    const cronOptions: unknown = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      cronTarget
    );

    expect(schedulerName).toBe('snowflake-daily-sync');
    expect(cronOptions).toMatchObject({
      cronTime: '0 2 * * *',
      name: 'snowflake-daily-sync',
      timeZone: 'UTC'
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — @OnEvent listener invokes syncOrders (event handler dispatch)
  // -------------------------------------------------------------------------

  it('invokes syncOrders when handlePortfolioChanged receives a PortfolioChangedEvent (AAP § 0.4.3 event-driven sync flow)', async () => {
    // Per Checkpoint C remediation, `handlePortfolioChanged` is a
    // synchronous void method that schedules the actual `syncOrders`
    // call via a 5-second debounce timer (mirroring the existing
    // `PortfolioChangedListener` pattern). The test therefore uses
    // Jest fake timers to advance past the debounce window and
    // verifies the deferred dispatch.
    jest.useFakeTimers();

    try {
      // Spy on the public `syncOrders` method to verify the event
      // handler delegates to it with the user ID extracted from the
      // event payload. Returning a sentinel value `7` proves the
      // deferred dispatch reaches the production code path.
      const syncOrdersSpy = jest
        .spyOn(service, 'syncOrders')
        .mockResolvedValue(7);

      const event = new PortfolioChangedEvent({ userId: TEST_USER_ID });

      service.handlePortfolioChanged(event);

      // Before the 5-second debounce window elapses, syncOrders is
      // not yet invoked.
      expect(syncOrdersSpy).not.toHaveBeenCalled();

      // Advance past the debounce window (5 seconds). The deferred
      // callback fires synchronously inside `advanceTimersByTime`.
      jest.advanceTimersByTime(5000);

      // The deferred body of `handlePortfolioChanged` is async — its
      // body runs `await this.syncOrders(...)`. The `syncOrders` call
      // itself happens before the first `await`, so it is observable
      // immediately after timer advancement; the awaited resolution
      // chains onto the microtask queue.
      expect(syncOrdersSpy).toHaveBeenCalledTimes(1);
      expect(syncOrdersSpy).toHaveBeenCalledWith(TEST_USER_ID);

      // Flush the microtask queue so the deferred async path
      // (logger calls, metric emission) completes before the test
      // ends; this prevents unhandled-promise warnings on Jest exit.
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('decorates handlePortfolioChanged with @OnEvent("portfolio.changed") (AAP § 0.4.3 wiring)', () => {
    // Reflect-metadata-based assertion: the @OnEvent decorator from
    // `@nestjs/event-emitter` stores its registration metadata under
    // the `EVENT_LISTENER_METADATA` key on the decorated function.
    // The metadata is an array of `{event, options}` entries — one
    // for each @OnEvent application — because the same method may
    // legally subscribe to multiple events.
    const handlerTarget = (
      SnowflakeSyncService.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >
    ).handlePortfolioChanged;

    expect(typeof handlerTarget).toBe('function');

    const listenerMeta = Reflect.getMetadata(
      'EVENT_LISTENER_METADATA',
      handlerTarget
    ) as { event: string }[] | undefined;

    expect(Array.isArray(listenerMeta)).toBe(true);
    expect(listenerMeta).toContainEqual(
      expect.objectContaining({ event: PortfolioChangedEvent.getName() })
    );
    // Sanity: the canonical event name is `'portfolio.changed'` per
    // `apps/api/src/events/portfolio-changed.event.ts`.
    expect(PortfolioChangedEvent.getName()).toBe('portfolio.changed');
  });

  it('handlePortfolioChanged swallows downstream syncOrders failures (event listener boundary)', async () => {
    // Per the service's documented contract, the deferred body of the
    // event handler logs and re-throws nothing — re-throwing would
    // surface inside the EventEmitter2 "uncaughtException" path, which
    // is the wrong failure boundary for a background sync.
    //
    // Post-Checkpoint-C remediation, the handler returns synchronous
    // `void` and schedules the actual sync inside a 5-second
    // debounce timer. The test therefore advances fake timers past
    // the debounce window and asserts that the deferred async body
    // completes without throwing.
    jest.useFakeTimers();

    try {
      jest
        .spyOn(service, 'syncOrders')
        .mockRejectedValueOnce(new Error('snowflake unavailable'));

      const event = new PortfolioChangedEvent({ userId: TEST_USER_ID });

      // Synchronous-void return; calling does not throw and does not
      // need to be awaited.
      expect(service.handlePortfolioChanged(event)).toBeUndefined();

      // Fire the debounced callback. The deferred async body
      // `processDebouncedEventSync(...)` will catch the rejection
      // from `syncOrders(...)`, log it, and increment the failure
      // counter — but MUST NOT propagate the error.
      jest.advanceTimersByTime(5000);

      // Flush microtasks so the deferred async body finishes
      // (the `try/catch/finally` inside `processDebouncedEventSync`).
      // If the failure path re-threw, this `await` would surface an
      // unhandled rejection and fail the test.
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3 — MERGE statements use bind-variable syntax (Rule 2)
  // -------------------------------------------------------------------------

  it('emits MERGE statements with bind-variable placeholders, never template literals or string concatenation (AAP § 0.7.1.2 Rule 2)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    await service.syncOrders(TEST_USER_ID);

    // Find every MERGE INTO statement that traversed the mocked
    // Snowflake driver. The Prisma mock returns one canonical order
    // row, so syncOrders should emit exactly one MERGE per call.
    const mergeStatements = executedQueries.filter((q) =>
      /\bMERGE\s+INTO\b/i.test(q.sqlText)
    );
    expect(mergeStatements.length).toBeGreaterThan(0);

    for (const q of mergeStatements) {
      // Rule 2: NO template-literal interpolation in any SQL string.
      // The pattern matches `${anything}` — the syntactic marker of
      // a runtime-injected value inside a JS template literal.
      expect(q.sqlText).not.toMatch(/\$\{[^}]*\}/);

      // Rule 2 (defense-in-depth): NO string-concatenation pattern
      // adjacent to a SQL string. The regex hunts for the
      // `'... '+ identifier` shape that betrays
      // `'SELECT * FROM table_' + tableName + ' WHERE ...'`-style
      // injection. Static SQL strings concatenated at compile time
      // (e.g. multi-line literals joined with `+`) are not caught
      // here because they evaluate to constant strings before
      // execute(...) is called.
      expect(q.sqlText).not.toMatch(/'\s*\+\s*[a-zA-Z_]/);
    }

    // Rule 2 (positive verification): every `?` placeholder must be
    // accompanied by a non-empty `binds` array. Snowflake-sdk requires
    // the bind count to match the placeholder count — an absent or
    // empty `binds` array on a `?`-placeholder SQL is a runtime error
    // and a Rule 2 violation simultaneously.
    const mergeWithPlaceholders = mergeStatements.filter((q) =>
      q.sqlText.includes('?')
    );
    expect(mergeWithPlaceholders.length).toBeGreaterThan(0);

    for (const q of mergeWithPlaceholders) {
      expect(q.binds).toBeDefined();
      expect(Array.isArray(q.binds)).toBe(true);
      expect(q.binds.length).toBeGreaterThan(0);
    }
  });

  it('binds the order MERGE values in the documented column order (Rule 2 type-safety)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    await service.syncOrders(TEST_USER_ID);

    const orderMerges = executedQueries.filter((q) =>
      /\bMERGE\s+INTO\s+orders_history\b/i.test(q.sqlText)
    );
    expect(orderMerges.length).toBeGreaterThan(0);

    // Per snowflake-sync.service.ts the bind ordering is
    // [order_id, user_id, date, type, ticker, quantity,
    //  unit_price, fee, currency]. The test asserts the second
    // bind (index 1) is the JWT-authenticated TEST_USER_ID — proving
    // the service does NOT trust any caller-supplied user_id and
    // uses the explicit `userId` argument instead.
    const firstMerge = orderMerges[0];
    expect(firstMerge.binds).toBeDefined();
    expect(firstMerge.binds[1]).toBe(TEST_USER_ID);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Idempotency: running sync twice does NOT duplicate rows (Rule 7)
  // -------------------------------------------------------------------------

  it('uses MERGE — never raw INSERT — when running syncOrders repeatedly (AAP § 0.7.1.7 Rule 7)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    await service.syncOrders(TEST_USER_ID);
    await service.syncOrders(TEST_USER_ID);

    // A standalone `INSERT INTO orders_history` outside a MERGE block
    // would be the canonical Rule 7 violation: re-running on the same
    // dataset would duplicate every row. Such a statement must NOT
    // appear in the executed-query log.
    const insertOnly = executedQueries.filter(
      (q) =>
        /\bINSERT\s+INTO\s+orders_history\b/i.test(q.sqlText) &&
        !/\bMERGE\b/i.test(q.sqlText)
    );
    expect(insertOnly).toHaveLength(0);

    // Positive verification: each invocation emitted at least one
    // MERGE INTO orders_history. Two calls must produce at least two
    // MERGE statements (one per order per call).
    const mergeOrders = executedQueries.filter((q) =>
      /\bMERGE\s+INTO\s+orders_history\b/i.test(q.sqlText)
    );
    expect(mergeOrders.length).toBeGreaterThanOrEqual(2);
  });

  it('emits MERGE statements for portfolio_snapshots and performance_metrics with the unique-constraint key columns (Rule 7 cross-table)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    const today = '2025-04-15';

    await service.syncSnapshots(TEST_USER_ID, today);
    await service.syncMetrics(TEST_USER_ID, today);

    // portfolio_snapshots MERGE — keyed on
    // (snapshot_date, user_id, asset_class) per bootstrap.sql.
    const snapshotMerges = executedQueries.filter((q) =>
      /\bMERGE\s+INTO\s+portfolio_snapshots\b/i.test(q.sqlText)
    );
    expect(snapshotMerges.length).toBeGreaterThan(0);
    expect(snapshotMerges[0].sqlText).toMatch(
      /ON\s+t\.snapshot_date\s*=\s*s\.snapshot_date/i
    );

    // performance_metrics MERGE — keyed on (metric_date, user_id).
    const metricMerges = executedQueries.filter((q) =>
      /\bMERGE\s+INTO\s+performance_metrics\b/i.test(q.sqlText)
    );
    expect(metricMerges.length).toBeGreaterThan(0);
    expect(metricMerges[0].sqlText).toMatch(
      /ON\s+t\.metric_date\s*=\s*s\.metric_date/i
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 — queryHistory parameter validation (chat-agent tool safety)
  // -------------------------------------------------------------------------

  it('rejects queryHistory with empty or non-string sql (AAP § 0.5.1.5 input validation)', async () => {
    await expect(service.queryHistory(TEST_USER_ID, '', [])).rejects.toThrow();

    await expect(
      service.queryHistory(TEST_USER_ID, null as unknown as string, [])
    ).rejects.toThrow();
  });

  it('rejects queryHistory SQL containing top-level semicolons (AAP § 0.5.1.5 multi-statement defense)', async () => {
    // The service's defense-in-depth check rejects any SQL containing
    // a `;` outside a string literal. This blocks the LLM from
    // batching multiple statements (e.g.,
    // `SELECT 1; DROP TABLE users;`) into a single tool invocation.
    await expect(
      service.queryHistory(TEST_USER_ID, 'SELECT 1; DROP TABLE users;', [])
    ).rejects.toThrow(/semicolon/i);

    await expect(
      service.queryHistory(
        TEST_USER_ID,
        'SELECT * FROM orders_history; SELECT 2',
        []
      )
    ).rejects.toThrow(/semicolon/i);
  });

  it('allows queryHistory SQL whose only semicolon sits inside a string literal (parser correctness)', async () => {
    // The state-machine semicolon detector treats `'a;b'` as a single
    // string literal containing a semicolon — this is NOT a Rule
    // violation because Snowflake parses it as a single statement.
    const sql =
      "SELECT * FROM portfolio_snapshots WHERE asset_class = 'EQUITY;FOREX'";

    await expect(
      service.queryHistory(TEST_USER_ID, sql, [])
    ).resolves.toBeDefined();
  });

  it('passes queryHistory binds straight through to the Snowflake driver without interpolation (Rule 2)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    const sql =
      'SELECT * FROM portfolio_snapshots WHERE user_id = ? AND snapshot_date >= ?';
    const binds: (string | number | boolean | null)[] = [
      TEST_USER_ID,
      '2025-01-01'
    ];

    await service.queryHistory(TEST_USER_ID, sql, binds);

    // Find the wrapped query — the service prepends
    // `SELECT * FROM (...) LIMIT N` to enforce the row-count cap.
    const queryHistoryCalls = executedQueries.filter((q) =>
      q.sqlText.includes(sql)
    );
    expect(queryHistoryCalls.length).toBeGreaterThan(0);

    const call = queryHistoryCalls[0];

    // The caller-supplied binds must travel through untouched —
    // their position, type, and value must match what was passed in.
    // String interpolation of the bind values into the SQL would
    // cause `?` placeholders to disappear from the wrapped sql, which
    // is the inverse of what we're asserting here.
    expect(call.binds).toEqual(binds);

    // Defense-in-depth: the wrapping layer adds `LIMIT N` for a
    // numeric `N` (the static class field
    // `QUERY_HISTORY_ROW_LIMIT`); this is the sole template-literal
    // interpolation in the service file and is permitted by Rule 2
    // because the value is not caller-controlled.
    expect(call.sqlText).toMatch(/LIMIT\s+\d+/i);
  });

  it('does not modify caller-supplied binds when the SQL has no placeholders (passes empty binds verbatim)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    const sql = 'SELECT COUNT(*) FROM orders_history';

    await service.queryHistory(TEST_USER_ID, sql, []);

    const queryHistoryCalls = executedQueries.filter((q) =>
      q.sqlText.includes(sql)
    );
    expect(queryHistoryCalls.length).toBeGreaterThan(0);
    expect(queryHistoryCalls[0].binds).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 6 — NO process.env.SNOWFLAKE_* access (Rule 3)
  //
  // The historical "behavioral" Test 6 verified that `runDailySync()`
  // exercised `configService.get(...)` at least once. Post-Checkpoint-C
  // remediation, `SnowflakeSyncService` no longer injects `ConfigService`
  // — the only consumer of SNOWFLAKE_* values is the sibling
  // `SnowflakeClientFactory` (which has its own spec coverage). The
  // behavioral assertion is therefore no longer applicable to this
  // class. Rule 3 remains fully verified by the static-source checks
  // below, which match the AAP § 0.7.5.2 Security sweep gate ("Grep for
  // `process.env.SNOWFLAKE` in new modules returns zero results").
  // -------------------------------------------------------------------------

  it('contains no `process.env.SNOWFLAKE_*` reference in the service source file (AAP § 0.7.1.3 Rule 3 — static)', () => {
    // Static source-level verification: the service file MUST NOT
    // contain any `process.env.SNOWFLAKE_*` substring. This is the
    // unit-test analog of AAP § 0.7.5.2's Security sweep gate
    // ("Grep for `process.env.SNOWFLAKE` in new modules returns zero
    // results"). Reading the .ts file at test time ensures the
    // assertion catches violations even if the runtime code path is
    // not exercised by any other test.
    const servicePath = join(__dirname, 'snowflake-sync.service.ts');
    const source = readFileSync(servicePath, 'utf8');

    // The static check uses a literal substring search (case-sensitive)
    // — `process.env.SNOWFLAKE_` would catch every variant of
    // `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, etc.
    expect(source).not.toMatch(/process\.env\.SNOWFLAKE_/);
    // Defense-in-depth: also reject bracket-notation access patterns
    // like `process.env['SNOWFLAKE_ACCOUNT']` or
    // `process.env["SNOWFLAKE_USER"]`.
    expect(source).not.toMatch(/process\.env\s*\[\s*['"]SNOWFLAKE_/);
  });

  it('contains no `process.env.ANTHROPIC_API_KEY` reference in the service source file (AAP § 0.7.1.3 Rule 3 — static)', () => {
    // The same static check applies to the Anthropic credential.
    // Although `ANTHROPIC_API_KEY` is consumed by `AiChatService` and
    // `RebalancingService` (not this service), Rule 3 forbids any
    // `process.env.ANTHROPIC_*` access in any new module.
    const servicePath = join(__dirname, 'snowflake-sync.service.ts');
    const source = readFileSync(servicePath, 'utf8');

    expect(source).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
    expect(source).not.toMatch(/process\.env\s*\[\s*['"]ANTHROPIC_API_KEY/);
  });

  // -------------------------------------------------------------------------
  // Test 7 — bootstrap creates the three Snowflake tables (AAP § 0.5.1.1)
  // -------------------------------------------------------------------------

  it('runs CREATE TABLE IF NOT EXISTS for all three Snowflake tables on bootstrap (AAP § 0.5.1.1)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    await service.bootstrap();

    // Three idempotent DDL statements — one per Snowflake table —
    // covering every analytical sink the sync layer writes to.
    const createStatements = executedQueries.filter((q) =>
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(q.sqlText)
    );
    expect(createStatements.length).toBeGreaterThanOrEqual(3);

    // Per-table assertions — every table named in the user's prompt
    // (AAP § 0.1.2.4) must appear in the bootstrap output exactly
    // once.
    expect(
      executedQueries.some((q) => /portfolio_snapshots/i.test(q.sqlText))
    ).toBe(true);
    expect(executedQueries.some((q) => /orders_history/i.test(q.sqlText))).toBe(
      true
    );
    expect(
      executedQueries.some((q) => /performance_metrics/i.test(q.sqlText))
    ).toBe(true);
  });

  it('bootstrap binds are empty arrays for all DDL statements (Rule 2)', async () => {
    const executedQueries = (
      factory as unknown as {
        __executedQueries: { sqlText: string; binds?: unknown[] }[];
      }
    ).__executedQueries;

    await service.bootstrap();

    const createStatements = executedQueries.filter((q) =>
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(q.sqlText)
    );

    // DDL statements take no parameters — every CREATE TABLE call must
    // travel with an empty binds array. A non-empty binds array on a
    // DDL statement would be a Rule 2 violation in spirit (binds are
    // for caller-controlled values, and DDL has none).
    for (const q of createStatements) {
      expect(q.binds).toBeDefined();
      expect(q.binds).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Test 8 — Manual trigger entry point (admin-driven sync)
  // -------------------------------------------------------------------------

  it('triggerManualSync delegates to the three sync routines and returns a structured envelope', async () => {
    const result = await service.triggerManualSync({
      callerUserId: TEST_USER_ID,
      overrideDate: '2025-04-15'
    });

    expect(result).toMatchObject({
      date: '2025-04-15',
      success: true,
      userId: TEST_USER_ID
    });
    // The correlationId is generated via crypto.randomUUID() — verify
    // that it's a non-empty string without asserting an exact value.
    expect(typeof result.correlationId).toBe('string');
    expect(result.correlationId.length).toBeGreaterThan(0);
  });

  it('triggerManualSync re-throws underlying sync failures (HTTP error mapping)', async () => {
    // Unlike the event-handler boundary (which swallows errors),
    // the manual-trigger entry point re-throws so the global NestJS
    // exception filter can map the error to an HTTP status code on
    // the controller side.
    jest
      .spyOn(service, 'syncOrders')
      .mockRejectedValueOnce(new Error('snowflake unavailable'));

    await expect(
      service.triggerManualSync({
        callerUserId: TEST_USER_ID
      })
    ).rejects.toThrow(/snowflake unavailable/);
  });
});
