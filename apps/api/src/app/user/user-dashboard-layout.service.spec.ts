import { MetricsService } from '@ghostfolio/api/app/metrics/metrics.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { UserDashboardLayout } from '@prisma/client';

import { UserDashboardLayoutService } from './user-dashboard-layout.service';

/**
 * Replaces the real `PrismaService` constructor with a minimal mock that
 * exposes only the two `userDashboardLayout` delegate methods consumed by
 * `UserDashboardLayoutService` (`findUnique` and `upsert`). All other
 * Prisma methods are intentionally absent so any production-code regression
 * that introduces an unscoped query — e.g. `findFirst({})`, `findMany({})`,
 * or `create({})` instead of `upsert({...})` — fails this spec immediately
 * with a clear `TypeError: ... is not a function` rather than silently
 * passing.
 *
 * The mock is declared with `jest.mock(...)` at module-scope rather than
 * within `beforeEach` so it is hoisted above the import that resolves
 * `PrismaService`. This mirrors the established Ghostfolio convention used
 * in `apps/api/src/app/user-financial-profile/user-financial-profile.service.spec.ts`
 * and `apps/api/src/services/data-provider/data-enhancer/yahoo-finance/yahoo-finance.service.spec.ts`.
 */
jest.mock('@ghostfolio/api/services/prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => {
      return {
        userDashboardLayout: {
          findUnique: jest.fn(),
          upsert: jest.fn()
        }
      };
    })
  };
});

/**
 * Replaces the real `MetricsService` constructor with a minimal mock that
 * exposes only the three public methods consumed by
 * `UserDashboardLayoutService`: `registerHelp`, `incrementCounter`, and
 * `observeHistogram`. The stub deliberately omits the internal `Map`-based
 * registry of the real service — counters and histograms accumulate as
 * jest call records, not as Prometheus exposition state.
 *
 * Each `new MetricsService(...)` call returns a fresh stub instance; the
 * `beforeEach` block re-instantiates the service so call history never
 * leaks between `it(...)` blocks. This mirrors the convention established
 * by `apps/api/src/app/snowflake-sync/snowflake-sync.service.spec.ts`
 * (which is the canonical precedent for testing services that emit
 * Prometheus counters and histograms via `MetricsService`).
 */
jest.mock('@ghostfolio/api/app/metrics/metrics.service', () => {
  return {
    MetricsService: jest.fn().mockImplementation(() => {
      return {
        incrementCounter: jest.fn(),
        observeHistogram: jest.fn(),
        registerHelp: jest.fn()
      };
    })
  };
});

/**
 * Unit tests for `UserDashboardLayoutService`.
 *
 * Source-of-truth references:
 *   - AAP § 0.6.1.3 — service shape: `findByUserId(userId)` and
 *     `upsertForUser(userId, layoutData)` backed by `PrismaService` with
 *     idempotent `upsert` keyed on `userId` (Decision D-019).
 *   - AAP § 0.6.1.10 — observability metrics: `registerHelp` for four
 *     metrics in the constructor; `incrementCounter` for outcomes; and
 *     `observeHistogram` for request latency.
 *   - AAP § 0.8.1.5 (Rule 5 — JWT-Authoritative Identity) — every Prisma
 *     call's `where: { userId }` clause uses the explicitly-passed userId,
 *     never a request-body-derived value.
 *   - AAP § 0.8.1.4 + Decision D-019 — idempotent PATCH via Prisma upsert
 *     keyed on the userId primary key; multiple calls with the same payload
 *     do not produce duplicate rows.
 *   - AAP § 0.8.5 — ≥ 80 % line coverage required on the service file.
 *
 * Hard rules verified by this spec:
 *   - Rule 5 (JWT-Authoritative Identity / authorization isolation): every
 *     Prisma call assertion verifies `where: { userId }` scoping using the
 *     explicitly passed `userId` argument.
 *   - Rule 4 (Persistence Triggered Only by Grid State Events): on the
 *     server side the rule manifests as idempotent `upsert` so that
 *     debounced 500 ms PATCH bursts collapse to a single steady-state
 *     row — verified by the "is idempotent" test below.
 *   - Observability rule (AAP § 0.8.2.1): metrics counters and histogram
 *     emission verified across success, not_found, and error paths.
 *
 * Test-pattern anchors (Ghostfolio convention):
 *   - `apps/api/src/app/user-financial-profile/user-financial-profile.service.spec.ts`
 *     — canonical structural template (per AAP § 0.6.1.3): `jest.mock(...)`
 *     factory at module scope; direct `new Service(prismaService, ...)`
 *     instantiation in `beforeEach`; per-test
 *     `(prismaService.X.method as jest.Mock).mockResolvedValueOnce(...)`.
 *   - `apps/api/src/app/snowflake-sync/snowflake-sync.service.spec.ts` —
 *     precedent for `MetricsService` interactions (counter increments,
 *     histogram observations) with the same `jest.fn()` stub shape.
 *
 * The tests use direct service instantiation with mocked `PrismaService`
 * and `MetricsService`, deliberately bypassing the NestJS DI container; the
 * service is a pure stateless wrapper around `prismaService.userDashboardLayout.*`
 * and `metricsService.*` and does not require any other framework
 * infrastructure.
 */
describe('UserDashboardLayoutService', () => {
  /**
   * Two distinct user identifiers: `USER_1_ID` is the canonical "current
   * authenticated user" in success-path tests, and `USER_2_ID` is used to
   * verify Rule 5's authorization-isolation guarantee — that the service
   * never widens, aliases, or replaces the explicitly-passed `userId` with
   * any other user's identifier.
   */
  const USER_1_ID = 'user-1-uuid';
  const USER_2_ID = 'user-2-uuid';

  let prismaService: PrismaService;
  let metricsService: MetricsService;
  let service: UserDashboardLayoutService;

  beforeEach(() => {
    // Re-create all collaborators per test so that mock call history is
    // never carried across `it(...)` blocks. Each test exercises fresh
    // jest.fn() spies for `findUnique`, `upsert`, `registerHelp`,
    // `incrementCounter`, and `observeHistogram`.
    //
    // `new PrismaService(null)` passes `null` for the constructor's
    // `configService` parameter. The mock factory ignores constructor
    // arguments, so this is safe and matches the precedent set in
    // `user-financial-profile.service.spec.ts`. The double cast on
    // `MetricsService as any` is required because the mock factory's
    // constructor signature is `() => instance` rather than the real
    // `() => MetricsService` shape — this matches the
    // `snowflake-sync.service.spec.ts` precedent.
    prismaService = new PrismaService(null);
    metricsService =
      new (MetricsService as unknown as new () => MetricsService)();
    service = new UserDashboardLayoutService(prismaService, metricsService);
  });

  // -------------------------------------------------------------------------
  // Constructor — registerHelp emissions (AAP § 0.6.1.10 Observability)
  // -------------------------------------------------------------------------

  it('registers help text for all four metrics in its constructor', () => {
    // Constructor was already invoked by `beforeEach`; verify the four
    // expected `registerHelp` calls were made with their canonical metric
    // names per AAP § 0.6.1.10. The descriptions are not pinned (we use
    // `expect.any(String)`) so future tweaks to the human-readable
    // descriptions don't break this structural assertion.
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      'dashboard_layout_get_total',
      expect.any(String)
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      'dashboard_layout_patch_total',
      expect.any(String)
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      'dashboard_layout_save_failures_total',
      expect.any(String)
    );
    expect(metricsService.registerHelp).toHaveBeenCalledWith(
      'dashboard_layout_request_duration_seconds',
      expect.any(String)
    );
    // Sanity: at least four calls were made (one per metric); additional
    // calls are tolerated — the registry is idempotent on duplicate names.
    expect(
      (metricsService.registerHelp as jest.Mock).mock.calls.length
    ).toBeGreaterThanOrEqual(4);
  });

  // -------------------------------------------------------------------------
  // findByUserId — Rule 5 (Prisma scoping) + 404 contract
  // -------------------------------------------------------------------------

  it('scopes findByUserId to where: { userId } using the passed userId', async () => {
    const record: UserDashboardLayout = {
      createdAt: new Date(),
      layoutData: {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(record);

    await service.findByUserId(USER_1_ID);

    // Rule 5: every Prisma operation on `UserDashboardLayout` MUST include
    // `where: { userId }`. Verify the clause is present, scoped to the
    // exact userId argument, and the call was made exactly once.
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledTimes(
      1
    );
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
  });

  it('returns null when no layout exists for the user', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    const result = await service.findByUserId(USER_1_ID);

    // The controller is contractually obligated to map `null` to HTTP 404
    // (per AAP § 0.8.1.10's "blank canvas" first-visit semantics), so the
    // service MUST resolve with `null` rather than throw on a missing row.
    expect(result).toBeNull();
  });

  it("does not return another user's row when called with the authenticated user's ID", async () => {
    // Simulate Prisma correctly returning null when querying user-1 even
    // though user-2 has a record in the real database. The service must
    // never widen the `where` clause to read user-2's row when called with
    // user-1's ID.
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.findByUserId(USER_1_ID);

    // The query was scoped to USER_1_ID and never USER_2_ID — confirming
    // Rule 5's authorization-isolation guarantee.
    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
    expect(
      prismaService.userDashboardLayout.findUnique
    ).not.toHaveBeenCalledWith({
      where: { userId: USER_2_ID }
    });
  });

  // -------------------------------------------------------------------------
  // findByUserId — Observability counter emissions (AAP § 0.6.1.10)
  // -------------------------------------------------------------------------

  it('increments dashboard_layout_get_total{outcome=found} counter on success-with-row', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    });

    await service.findByUserId(USER_1_ID);

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'dashboard_layout_get_total',
      1,
      { outcome: 'found' }
    );
  });

  it('increments dashboard_layout_get_total{outcome=not_found} counter on null result', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.findByUserId(USER_1_ID);

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'dashboard_layout_get_total',
      1,
      { outcome: 'not_found' }
    );
  });

  it('increments dashboard_layout_get_total{outcome=error} counter and rethrows on Prisma error', async () => {
    const dbError = new Error('database connection lost');
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockRejectedValueOnce(dbError);

    // The error MUST be rethrown unmodified so the controller's exception
    // filter can render a consistent HTTP 500. The service has no retry,
    // backoff, or wrapping logic for the read path.
    await expect(service.findByUserId(USER_1_ID)).rejects.toBe(dbError);

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'dashboard_layout_get_total',
      1,
      { outcome: 'error' }
    );
  });

  // -------------------------------------------------------------------------
  // findByUserId — Histogram observations on success and error paths
  // -------------------------------------------------------------------------

  it('records latency in dashboard_layout_request_duration_seconds histogram on success', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    });

    await service.findByUserId(USER_1_ID);

    // The histogram observation runs in `finally` so it fires on every
    // code path — success, not_found, and error. The latency value is a
    // non-negative number (in seconds) computed from `Date.now()` deltas;
    // the assertion uses `expect.any(Number)` so the test is not coupled
    // to a specific runtime duration.
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      'dashboard_layout_request_duration_seconds',
      expect.any(Number),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('records latency in dashboard_layout_request_duration_seconds histogram even on error', async () => {
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockRejectedValueOnce(new Error('db failure'));

    await expect(service.findByUserId(USER_1_ID)).rejects.toThrow();

    // Because the histogram observation lives in `finally`, the error
    // path is also measured — the latency series therefore reflects every
    // request including failures. This is required by the AAP § 0.6.1.10
    // observability contract: dashboards must surface error latency, not
    // just success latency, so SREs can spot retry storms.
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      'dashboard_layout_request_duration_seconds',
      expect.any(Number),
      expect.objectContaining({ method: 'GET' })
    );
  });

  // -------------------------------------------------------------------------
  // upsertForUser — Rule 5 (Prisma scoping + shape) + return value passthrough
  // -------------------------------------------------------------------------

  it('calls prisma.userDashboardLayout.upsert with where: { userId } scoped to the authenticated user', async () => {
    const layoutData = {
      version: 1,
      items: [{ moduleId: 'holdings', cols: 6, rows: 4, x: 0, y: 0 }]
    };
    const upsertedRecord: UserDashboardLayout = {
      createdAt: new Date(),
      layoutData: layoutData as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    };
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce(upsertedRecord);

    const result = await service.upsertForUser(
      USER_1_ID,
      layoutData as unknown as UserDashboardLayout['layoutData']
    );

    // The persisted row is returned to the caller verbatim — the service
    // is a pure pass-through wrapper around Prisma `upsert`.
    expect(result).toBe(upsertedRecord);
    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    // Rule 5: the `where` clause is scoped to the JWT-derived userId.
    expect(upsertArgs.where).toEqual({ userId: USER_1_ID });
    // The `create` branch carries both userId (FK + PK) and layoutData.
    expect(upsertArgs.create).toEqual({ userId: USER_1_ID, layoutData });
    // The `update` branch deliberately omits `userId` because (a) it is
    // immutable on existing rows and (b) it is already implied by the
    // `where` clause; including it again would be redundant and could
    // mask a future bug where `update.userId` is set from request body.
    expect(upsertArgs.update).toEqual({ layoutData });
  });

  it('is idempotent — calling upsertForUser twice with same input does not duplicate (uses prisma upsert, not create)', async () => {
    const layoutData = { version: 1, items: [] };
    (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mockResolvedValueOnce({
        createdAt: new Date(),
        layoutData: layoutData as unknown as UserDashboardLayout['layoutData'],
        updatedAt: new Date(),
        userId: USER_1_ID
      } as UserDashboardLayout)
      .mockResolvedValueOnce({
        createdAt: new Date(),
        layoutData: layoutData as unknown as UserDashboardLayout['layoutData'],
        updatedAt: new Date(),
        userId: USER_1_ID
      } as UserDashboardLayout);

    const first = await service.upsertForUser(
      USER_1_ID,
      layoutData as unknown as UserDashboardLayout['layoutData']
    );
    const second = await service.upsertForUser(
      USER_1_ID,
      layoutData as unknown as UserDashboardLayout['layoutData']
    );

    // Idempotency (AAP § 0.8.1.4 + Decision D-019): both calls succeed and
    // both delegate to `prisma.userDashboardLayout.upsert`, never `create`.
    // Because the mock `userDashboardLayout` delegate exposes only `upsert`
    // (and `findUnique`), any attempt by the service to fall back to
    // `prisma.userDashboardLayout.create({...})` would throw `TypeError:
    // prismaService.userDashboardLayout.create is not a function` and fail
    // the test — making this assertion a structural guarantee that the
    // service path for an existing row is `upsert`, not `create`. This is
    // the server-side enforcement of the client's debounced 500 ms PATCH
    // burst pattern: multiple concurrent PATCH requests with the same
    // payload collapse to a single steady-state row.
    expect(prismaService.userDashboardLayout.upsert).toHaveBeenCalledTimes(2);
    expect(
      (prismaService.userDashboardLayout as { create?: unknown }).create
    ).toBeUndefined();
    expect(first.userId).toBe(USER_1_ID);
    expect(second.userId).toBe(USER_1_ID);
  });

  it("scopes upsertForUser to where: { userId } using the explicitly passed userId, never another user's ID", async () => {
    const layoutData = { version: 1, items: [] };
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: layoutData as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_2_ID
    });

    await service.upsertForUser(
      USER_2_ID,
      layoutData as unknown as UserDashboardLayout['layoutData']
    );

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    // Authorization-isolation: the upsert must be scoped to USER_2_ID
    // (the explicitly-passed argument) and NEVER to USER_1_ID.
    expect(upsertArgs.where).toEqual({ userId: USER_2_ID });
    expect(upsertArgs.where).not.toEqual({ userId: USER_1_ID });
    expect(upsertArgs.create.userId).toBe(USER_2_ID);
  });

  it('forwards layoutData byte-identical to both create and update branches of the Prisma call', async () => {
    const complexLayout = {
      version: 1,
      items: [
        { moduleId: 'portfolio-overview', cols: 6, rows: 4, x: 0, y: 0 },
        { moduleId: 'holdings', cols: 6, rows: 4, x: 6, y: 0 },
        { moduleId: 'transactions', cols: 12, rows: 6, x: 0, y: 4 }
      ]
    };
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: complexLayout as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    });

    await service.upsertForUser(
      USER_1_ID,
      complexLayout as unknown as UserDashboardLayout['layoutData']
    );

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    // Verify every nested item from the complex layout is forwarded to
    // both the `create` and `update` branches of the upsert. Drift between
    // the DTO and Prisma input — e.g., a renamed key or a missing field —
    // would surface here as a deep-equality failure.
    expect(upsertArgs.create.layoutData).toEqual(complexLayout);
    expect(upsertArgs.update.layoutData).toEqual(complexLayout);
  });

  // -------------------------------------------------------------------------
  // upsertForUser — Observability counter emissions (AAP § 0.6.1.10)
  // -------------------------------------------------------------------------

  it('increments dashboard_layout_patch_total{outcome=success} counter on successful upsert', async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    });

    await service.upsertForUser(USER_1_ID, {
      version: 1,
      items: []
    } as unknown as UserDashboardLayout['layoutData']);

    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'dashboard_layout_patch_total',
      1,
      { outcome: 'success' }
    );
  });

  it('increments error counters and rethrows on Prisma error', async () => {
    const dbError = new Error('unique constraint violation');
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockRejectedValueOnce(dbError);

    await expect(
      service.upsertForUser(USER_1_ID, {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'])
    ).rejects.toBe(dbError);

    // BOTH counters fire on the error path:
    //   1. dashboard_layout_patch_total{outcome=error} (in `finally`).
    //   2. dashboard_layout_save_failures_total{reason=db_error} (in
    //      `catch`, BEFORE rethrow).
    // The save_failures counter is in addition to the outcome counter so
    // dashboards can alert on the failure-counter rate without re-deriving
    // it from the outcome partition.
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'dashboard_layout_patch_total',
      1,
      { outcome: 'error' }
    );
    expect(metricsService.incrementCounter).toHaveBeenCalledWith(
      'dashboard_layout_save_failures_total',
      1,
      { reason: 'db_error' }
    );
  });

  it('records latency in dashboard_layout_request_duration_seconds histogram on PATCH', async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    });

    await service.upsertForUser(USER_1_ID, {
      version: 1,
      items: []
    } as unknown as UserDashboardLayout['layoutData']);

    // The histogram method label distinguishes GET from PATCH so latency
    // dashboards can render two separate lines.
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      'dashboard_layout_request_duration_seconds',
      expect.any(Number),
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('records latency in dashboard_layout_request_duration_seconds histogram even on PATCH error', async () => {
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockRejectedValueOnce(new Error('db failure'));

    await expect(
      service.upsertForUser(USER_1_ID, {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'])
    ).rejects.toThrow();

    // Mirrors the GET-path test above: the latency histogram is observed
    // in `finally` so error paths are measured and surfaced to dashboards.
    expect(metricsService.observeHistogram).toHaveBeenCalledWith(
      'dashboard_layout_request_duration_seconds',
      expect.any(Number),
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  // -------------------------------------------------------------------------
  // Cross-method assertions — Defensive structural guarantees
  // -------------------------------------------------------------------------

  it('does NOT call create on the Prisma userDashboardLayout delegate on the upsert path', async () => {
    // Defense-in-depth: the mock `userDashboardLayout` delegate exposes
    // only `findUnique` and `upsert`. The absence of `create` means any
    // production-code regression that introduces an unconditional create
    // call would throw `TypeError: ... is not a function` here.
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: {
        version: 1,
        items: []
      } as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    });

    await service.upsertForUser(USER_1_ID, {
      version: 1,
      items: []
    } as unknown as UserDashboardLayout['layoutData']);

    expect(
      (prismaService.userDashboardLayout as { create?: unknown }).create
    ).toBeUndefined();
    expect(
      (prismaService.userDashboardLayout as { findMany?: unknown }).findMany
    ).toBeUndefined();
    expect(
      (prismaService.userDashboardLayout as { findFirst?: unknown }).findFirst
    ).toBeUndefined();
  });

  it('accepts an optional correlationId for findByUserId without affecting Prisma scoping', async () => {
    // The service signature is `findByUserId(userId, correlationId?)` —
    // the correlationId is propagated to structured log lines but MUST NOT
    // alter the Prisma `where` clause. This regression test pins that
    // contract.
    (
      prismaService.userDashboardLayout.findUnique as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.findByUserId(USER_1_ID, 'correlation-id-abc-123');

    expect(prismaService.userDashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_1_ID }
    });
  });

  it('accepts an optional correlationId for upsertForUser without affecting Prisma scoping', async () => {
    // The service signature is `upsertForUser(userId, layoutData,
    // correlationId?)` — the correlationId is propagated to structured log
    // lines but MUST NOT alter the Prisma `where`/`create`/`update` clauses.
    const layoutData = { version: 1, items: [] };
    (
      prismaService.userDashboardLayout.upsert as jest.Mock
    ).mockResolvedValueOnce({
      createdAt: new Date(),
      layoutData: layoutData as unknown as UserDashboardLayout['layoutData'],
      updatedAt: new Date(),
      userId: USER_1_ID
    });

    await service.upsertForUser(
      USER_1_ID,
      layoutData as unknown as UserDashboardLayout['layoutData'],
      'correlation-id-xyz-789'
    );

    const upsertArgs = (prismaService.userDashboardLayout.upsert as jest.Mock)
      .mock.calls[0][0];

    expect(upsertArgs.where).toEqual({ userId: USER_1_ID });
    expect(upsertArgs.create).toEqual({ userId: USER_1_ID, layoutData });
    expect(upsertArgs.update).toEqual({ layoutData });
  });
});
