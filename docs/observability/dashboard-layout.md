# User Dashboard Layout — Observability Dashboard

## Overview

Operator dashboard for the **per-user dashboard-layout persistence**
endpoints `GET /api/v1/user/layout` and `PATCH /api/v1/user/layout`,
served by `UserDashboardLayoutController` and backed by
`UserDashboardLayoutService` (registered in `UserModule`). The
dashboard tracks the two Prometheus metrics that
`UserDashboardLayoutService` **emits** (verified on this branch — see
the implementation-status note below), exposed at
`GET /api/v1/metrics`:

1. `user_dashboard_layout_requests_total` — terminal-outcome counter
   for every layout request, labelled by `operation`
   (`read` | `write`) and `outcome` (`success` | `not_found` |
   `error`).
2. `user_dashboard_layout_latency_seconds` — histogram of end-to-end
   wall-clock latency of the layout read/upsert operation, labelled by
   `operation` (`read` | `write`).

The dashboard is intentionally scoped to **only** the metrics defined
by the layout endpoints' observability contract. Finer signals —
per-grid-item counts, layout payload byte sizes, the JSONB column
size, distinct Prisma/Postgres error classes — are **not** part of
this version of the contract. Operators who require those dimensions
must either extend `UserDashboardLayoutService` to register additional
metrics or inspect the structured logs (every line is prefixed with
`[UserDashboardLayoutService] [<correlationId>]`).

> **Implementation status / source-of-truth note.**
> ✅ **Current status (verified by reading the source on this branch):
> the layout endpoints emit both metrics.**
> `UserDashboardLayoutService` injects `MetricsService` (alongside
> `PrismaService`), declares the two static metric-name constants,
> calls `registerHelp(...)` for each in its constructor, and emits
> `incrementCounter(user_dashboard_layout_requests_total, 1, { operation, outcome })`
> plus
> `observeHistogram(user_dashboard_layout_latency_seconds, elapsedSeconds, { operation })`
> from a `finally` block in both `findByUserId` (`operation: 'read'`)
> and `upsertForUser` (`operation: 'write'`), so a metric fires on
> every return path — `success`, `not_found` (read only), and `error`
> alike. This follows the established repository convention
> (`<feature>_requests_total` outcome-labelled counter +
> `<feature>_latency_seconds` histogram, e.g. `RebalancingService`,
> `SnowflakeSyncService`). `MetricsModule` is imported by `UserModule`
> so the singleton `MetricsService` is injectable. Treat
> `apps/api/src/app/user/user-dashboard-layout.service.ts` as the
> **authoritative source of truth**: if the implemented metric name
> strings, label keys, label-value sets, or HELP text ever change,
> reconcile every section below (Overview list, Emitted Metrics table,
> Outcome semantics, all panel PromQL, all alert `expr`, the runbook
> `grep` patterns, the Grafana JSON `expr` fields, and the Metric Names
> list) against the names actually emitted, and record any non-trivial
> divergence in the decision log
> (`docs/decisions/dashboard-refactor-decisions.md`, D-102). Metric
> labels are deliberately restricted to the fixed-cardinality
> `operation`/`outcome` dimensions (never `userId` or `correlationId`)
> so the `MetricsService` cardinality guard never drops a series.

### Reused vs Added

Per the AAP §0.8.2 Observability rule, this feature **reuses**
Ghostfolio's existing observability spine and **adds** only the
layout-specific signals on top of it:

- **REUSED (unchanged):** the existing `HealthModule`
  (readiness/health checks; `apps/api/src/app/health/`, registered in
  `apps/api/src/app/app.module.ts` L54, L128) and the existing
  `MetricsModule` / `MetricsService`
  (`apps/api/src/app/app.module.ts` L58, L133; the in-process registry
  plus the `GET /api/v1/metrics` scrape endpoint). No new metrics
  library and no new metrics endpoint are introduced.
- **ADDED for this feature:** (1) structured logging with
  **correlation IDs** on the `UserDashboardLayoutController` →
  `UserDashboardLayoutService` path (log lines prefixed
  `[UserDashboardLayoutService] [<correlationId>]`, mirroring the
  established `[RebalancingService] [<correlationId>]` convention),
  including `DEBUG`-level read/write **span-boundary** lines
  (`... read start` / `... read end outcome=<outcome> elapsedMs=<n>`)
  that bracket the Prisma operation — **present in the implementation
  today**; (2) **distributed correlation/tracing** across the
  client → controller → service → Prisma boundary: the controller
  **adopts an inbound `X-Correlation-ID` request header** when the
  client supplies one (and otherwise mints a `randomUUID()`), returns
  it as the `X-Correlation-ID` response header (on both the success and
  the 404 paths) and threads it into the service call, which in turn
  tags its span-boundary log lines with the same id — **present
  today**; (3) the **layout-endpoint metrics**
  (`user_dashboard_layout_requests_total`,
  `user_dashboard_layout_latency_seconds`) registered against and
  emitted through the reused `MetricsService` from
  `UserDashboardLayoutService` — **wired and verified** (see the
  implementation-status note above; covered by
  `user-dashboard-layout.service.spec.ts` which asserts the counter and
  histogram fire with the correct `operation`/`outcome` labels for the
  success, not-found, and error paths); and (4) this **Grafana
  dashboard template + runbook** — **delivered by this document**. All
  four items, together with the reused `GET /api/v1/metrics` endpoint,
  are verified to work in the local development environment per the
  runbook below; the layout-specific metric series in (3) populate the
  panels as soon as the endpoints receive traffic.

## Audience

- **Site Reliability Engineering / Platform Operations** — primary
  dashboard owners; on-call rotation watches the write success rate,
  read/write latency, and the overall error rate during incidents.
- **Frontend / Dashboard Feature Engineering** — secondary owners;
  review the `not_found` read share (the first-visit / blank-canvas
  signal per Rule 10) and the debounced-`PATCH` write volume to
  understand canvas composition behaviour.

## Cross-references

- **AAP §0.1.1 / §0.6.1 Group 5** — feature definition: the per-user
  layout endpoints (`GET`/`PATCH /api/v1/user/layout`) and their
  controller/service.
- **AAP §0.8.1 (Rule 8)** — the layout endpoints MUST be protected by
  the existing `AuthGuard('jwt')` and `HasPermissionGuard`;
  unauthenticated requests receive `401`.
- **AAP §0.8.2 (Observability rule)** — mandates this dashboard
  template alongside structured logging, correlation IDs, the metrics
  endpoint, and the health/readiness probes.
- **Source of truth — service**:
  `apps/api/src/app/user/user-dashboard-layout.service.ts` (the
  authoritative read/upsert path; injects `MetricsService`, registers
  the metrics, assigns the `operation`/`outcome` labels, and emits the
  counter and histogram from a `finally` block on both the read and
  upsert paths, alongside correlation-ID structured span logs).
- **Source of truth — controller**:
  `apps/api/src/app/user/user-dashboard-layout.controller.ts`
  (`@Controller('user/layout')`; `GET()` + `PATCH()` guarded by
  `AuthGuard('jwt')` + `HasPermissionGuard`; current user via
  `@Inject(REQUEST)`; adopts an inbound `X-Correlation-ID` header or
  mints one, propagates the `correlationId` into the service call, and
  echoes the `X-Correlation-ID` response header).
- **Source of truth — module wiring**:
  `apps/api/src/app/user/user.module.ts` (registers the controller in
  `controllers[]` and the service in `providers[]`; imports
  `MetricsModule` so `MetricsService` is injectable, and `PrismaModule`
  for `PrismaService`).
- **Source of truth — metrics registry**:
  `apps/api/src/app/metrics/metrics.service.ts`. Default histogram
  buckets (in seconds) are
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
- **Metrics endpoint**:
  `apps/api/src/app/metrics/metrics.controller.ts`
  (`@Controller('metrics')` → `GET /api/v1/metrics`; `Content-Type:
text/plain; version=0.0.4; charset=utf-8`).
- **Health/readiness**: the existing `HealthModule`
  (`apps/api/src/app/health/`) registered in
  `apps/api/src/app/app.module.ts`.
- **Spec coverage**:
  `apps/api/src/app/user/user-dashboard-layout.controller.spec.ts` and
  `apps/api/src/app/user/user-dashboard-layout.service.spec.ts`
  exercise the read/write outcomes including the unauthenticated → 401
  case.

## Emitted Metrics — Authoritative Reference

| Metric                                  | Type      | Labels                                                                         | HELP text                                                                                                                                                     |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_dashboard_layout_requests_total`  | counter   | `operation` ∈ {`read`, `write`}; `outcome` ∈ {`success`, `not_found`, `error`} | Total user dashboard layout requests handled by UserDashboardLayoutService, labeled by operation (read \| write) and outcome (success \| not_found \| error). |
| `user_dashboard_layout_latency_seconds` | histogram | `operation` ∈ {`read`, `write`}                                                | End-to-end wall-clock latency of UserDashboardLayoutService read/upsert operations in seconds.                                                                |

The histogram exposes the canonical Prometheus suffixes
`_bucket{le="..."}`, `_sum`, and `_count`; the
`MetricsService.getRegistryAsText()` renderer pre-populates every
default bucket so that PromQL `histogram_quantile()` calls work from
the first observation onwards.

### Outcome semantics

| Outcome                                   | Meaning                                                                                                                                                                                                                                                                           | Source                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `operation="read"`, `outcome="success"`   | `GET /api/v1/user/layout` returned a persisted layout row — a returning user whose layout is rendered on canvas initialisation.                                                                                                                                                   | `user-dashboard-layout.service.ts` (read path)  |
| `operation="read"`, `outcome="not_found"` | `GET` found no row — a new user. This is the canonical blank-canvas / auto-open-catalog signal per **Rule 10**; the client `DashboardLayoutService` translates the 404 to `null`. A healthy baseline of `not_found` is expected from first-time visitors and is **NOT** an error. | `user-dashboard-layout.service.ts` (read path)  |
| `operation="read"`, `outcome="error"`     | Unexpected failure while reading the layout (DB / Prisma error).                                                                                                                                                                                                                  | `user-dashboard-layout.service.ts` (read path)  |
| `operation="write"`, `outcome="success"`  | `PATCH /api/v1/user/layout` upserted the layout (the debounced 500 ms save from the canvas).                                                                                                                                                                                      | `user-dashboard-layout.service.ts` (write path) |
| `operation="write"`, `outcome="error"`    | Write failed — DTO validation rejection or DB / Prisma error.                                                                                                                                                                                                                     | `user-dashboard-layout.service.ts` (write path) |

## Recommended Panels

The dashboard ships with six panels grouped into three rows. The top
row covers wall-clock latency, the middle row covers terminal request
outcomes and the two headline reliability signals, and the bottom row
covers request volume.

| #   | Panel                                         | Type                  | Primary Metric                                                               | Example PromQL                                                                                                                                                                       |
| --- | --------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Layout Latency (p50 / p95 / p99) by Operation | Time series           | `user_dashboard_layout_latency_seconds`                                      | `histogram_quantile(0.95, sum by (le, operation) (rate(user_dashboard_layout_latency_seconds_bucket[5m])))`                                                                          |
| 2   | Layout Latency Distribution                   | Heatmap               | `user_dashboard_layout_latency_seconds_bucket`                               | `sum by (le) (rate(user_dashboard_layout_latency_seconds_bucket[5m]))`                                                                                                               |
| 3   | Request Outcome Distribution by Operation     | Time series (stacked) | `user_dashboard_layout_requests_total`                                       | `sum by (operation, outcome) (rate(user_dashboard_layout_requests_total[5m]))`                                                                                                       |
| 4   | Write Success Rate                            | Stat (single-value)   | `user_dashboard_layout_requests_total{operation="write"}`                    | `sum(rate(user_dashboard_layout_requests_total{operation="write",outcome="success"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation="write"}[5m])), 1e-9)` |
| 5   | First-Visit (not_found) Read Share            | Stat / Time series    | `user_dashboard_layout_requests_total{operation="read",outcome="not_found"}` | `sum(rate(user_dashboard_layout_requests_total{operation="read",outcome="not_found"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation="read"}[5m])), 1e-9)` |
| 6   | Request Volume by Operation                   | Time series           | `user_dashboard_layout_requests_total`                                       | `sum by (operation) (rate(user_dashboard_layout_requests_total[5m]))`                                                                                                                |

### Panel 1 — Layout Latency (p50 / p95 / p99) by Operation

The headline operator SLI for the layout endpoints. The panel renders
p50/p95/p99 series per `operation` (read, write) over a five-minute
rolling window, computed via `histogram_quantile()` against the bucket
counter. A layout read/upsert is a simple single-row Prisma operation,
so expected latency is low (sub-100 ms typical). Recommended visual
threshold: green ≤ 0.1 s, amber 0.1 s–0.5 s, red > 0.5 s on the p95
series. A breach of red on p95 typically indicates Postgres slowness
or connection-pool saturation rather than anything layout-specific.

### Panel 2 — Layout Latency Distribution (Heatmap)

A heatmap of `user_dashboard_layout_latency_seconds_bucket` over time
provides a richer view than the quantile lines alone — shifts in the
bucket distribution flag emerging DB slowness before SLO breaches. The
heatmap reuses the default buckets
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.
For a healthy single-row upsert, observations cluster in the lower
buckets (≤ 0.1 s); a drift toward the upper buckets is the early
warning signal.

### Panel 3 — Request Outcome Distribution by Operation

Stacked time series of `user_dashboard_layout_requests_total`
partitioned by both the `operation` and `outcome` labels (up to five
populated series: read/success, read/not_found, read/error,
write/success, write/error). Operators can see at a glance the
composition of terminal outcomes. `success` (for both operations) and a
baseline of read/`not_found` should dominate during steady state.
Sustained increases in either `error` series are the principal incident
signals for the feature:

- `operation="read"`, `outcome="error"` → inspect
  `[UserDashboardLayoutService]` log lines by `correlationId`; the most
  likely cause is a Prisma/Postgres read failure or schema drift.
- `operation="write"`, `outcome="error"` → most often a DTO-validation
  rejection (malformed layout payload) or a Prisma/Postgres write
  failure.

### Panel 4 — Write Success Rate

`operation="write"`, `outcome="success"` rate divided by total write
rate — a single-value percentage that maps directly to the layout
persistence reliability SLO. The expression uses
`clamp_min(..., 1e-9)` in the denominator to avoid division-by-zero
when no writes are in flight. Recommended thresholds: green ≥ 0.99,
amber 0.95–0.99, red < 0.95. A sustained dip is most often a
DTO-validation regression or a DB write failure.

### Panel 5 — First-Visit (not_found) Read Share

The share of reads that terminate `outcome="not_found"` —
`operation="read"`, `outcome="not_found"` rate divided by total read
rate. This is the **Rule 10** blank-canvas signal: every `not_found`
read is a user with no saved layout, whom the client renders a blank
canvas with the module catalog auto-opened. A healthy, non-zero
baseline is expected and is **not** an error. However, a sudden spike
toward ~100 % is a red flag — it more likely indicates a read
regression (saved layouts not loading, e.g. a schema/serialization bug)
than a genuine surge of brand-new users. Pair this panel with Panel 3
and the structured logs when investigating.

### Panel 6 — Request Volume by Operation

`sum by (operation) (rate(user_dashboard_layout_requests_total[5m]))`
time series. Establishes the traffic baseline for the read and write
paths and complements the rate-based panels — without volume context,
percentage-based panels can hide low-traffic anomalies (e.g. a 50 %
write-failure rate over two requests is far less informative than 50 %
over two thousand). Write volume also reflects the 500 ms debounce: the
canvas coalesces rapid drag/resize bursts into a single `PATCH`.

## Alert Rules

Recommended Prometheus alerting rules. Adjust thresholds and `for`
windows for the operating environment.

```yaml
groups:
  - name: user-dashboard-layout
    rules:
      - alert: UserDashboardLayoutWriteSuccessRateLow
        expr: |
          sum(rate(user_dashboard_layout_requests_total{operation="write",outcome="success"}[15m]))
            /
          clamp_min(
            sum(rate(user_dashboard_layout_requests_total{operation="write"}[15m])),
            1e-9
          )
            < 0.95
        for: 15m
        labels:
          severity: page
          feature: user-dashboard-layout
        annotations:
          summary: 'User dashboard layout write success rate below 95%'
          description: |
            Fewer than 95 % of layout PATCH writes have succeeded over
            the last 15 minutes. The most likely root causes are a
            DTO-validation regression (malformed layout payload) or a
            Postgres/Prisma write failure. Inspect the
            [UserDashboardLayoutService] log lines for the affected
            correlationId and verify the readiness probe.

      - alert: UserDashboardLayoutErrorBurst
        expr: |
          sum(rate(user_dashboard_layout_requests_total{outcome="error"}[5m]))
            /
          clamp_min(sum(rate(user_dashboard_layout_requests_total[5m])), 1e-9)
            > 0.1
        for: 5m
        labels:
          severity: page
          feature: user-dashboard-layout
        annotations:
          summary: 'User dashboard layout error outcome rate above 10%'
          description: |
            More than 10 % of layout requests (read or write) have
            terminated with outcome=error over the last 5 minutes. This
            typically signals Prisma/Postgres connectivity loss or
            schema drift affecting the UserDashboardLayout table.
            Cross-check the readiness probe and the structured logs.

      - alert: UserDashboardLayoutLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(user_dashboard_layout_latency_seconds_bucket[5m]))
          ) > 0.5
        for: 10m
        labels:
          severity: warning
          feature: user-dashboard-layout
        annotations:
          summary: 'User dashboard layout latency p95 above 0.5 s'
          description: |
            user_dashboard_layout_latency_seconds p95 has exceeded
            0.5 s for 10 minutes. A single-row layout read/upsert
            exceeding 500 ms p95 is anomalous and usually points to
            Postgres slowness or connection-pool saturation. Inspect
            DB load and the [UserDashboardLayoutService] logs.

      - alert: UserDashboardLayoutNoActivity
        expr: |
          sum(rate(user_dashboard_layout_requests_total[15m])) == 0
        for: 1h
        labels:
          severity: warning
          feature: user-dashboard-layout
        annotations:
          summary: 'User dashboard layout endpoint has no traffic for 1 hour'
          description: |
            user_dashboard_layout_requests_total has not incremented
            for the last hour. During expected traffic windows this is
            consistent with the endpoint being unreachable (reverse-proxy
            or auth regression). Verify GET /api/v1/user/layout with a
            known-good JWT and inspect the application access log.
```

## Local Development Verification

The following procedure exercises every metric in the local
development environment, satisfying the AAP §0.8.2 Observability
mandate that all observability MUST be verified in the local
development environment.

> **Precondition (metrics wiring).** The commands below assume the
> layout endpoints have been wired to emit the two contract metrics —
> `registerHelp(...)` in the `UserDashboardLayoutService` constructor
> plus `incrementCounter(...)` / `observeHistogram(...)` in a
> `finally` block, per the `RebalancingService` convention. Until that
> wiring lands (see the implementation-status note in the Overview),
> the steps that `grep` for `user_dashboard_layout_` return **no
> output**; every other step (authentication, the 404 / 200 / 401
> status codes, the `X-Correlation-ID` response header, and the
> `[UserDashboardLayoutService] [<correlationId>]` structured logs)
> exercises behaviour that is present in the implementation today.

1. **Bring up the API.** From the repository root, start Postgres and
   Redis (`docker compose -f docker/docker-compose.dev.yml up -d`),
   apply migrations (`npx prisma migrate dev`), then start the API in
   development mode (`npx nx serve api`). Wait for the bootstrap log
   line `Nest application successfully started`.
2. **Mint a development JWT.** Create a user via
   `POST /api/v1/user`, capture the returned `authToken`, and export
   it as `JWT=...` in the shell.
3. **Confirm the registry is populated with the expected HELP/TYPE
   lines.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^# (HELP|TYPE) user_dashboard_layout_'
   ```

   Expected output (order may vary):

   ```text
   # HELP user_dashboard_layout_latency_seconds End-to-end wall-clock latency of UserDashboardLayoutService read/upsert operations in seconds.
   # TYPE user_dashboard_layout_latency_seconds histogram
   # HELP user_dashboard_layout_requests_total Total user dashboard layout requests handled by UserDashboardLayoutService, labeled by operation (read | write) and outcome (success | not_found | error).
   # TYPE user_dashboard_layout_requests_total counter
   ```

4. **Exercise the read / not_found path (new user, no saved layout).**

   ```bash
   curl -s -H "Authorization: Bearer $JWT" \
        http://localhost:3333/api/v1/user/layout -i
   ```

   Expect HTTP 404 (or the documented empty/null body per the actual
   controller). Then confirm the counter:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^user_dashboard_layout_requests_total\{'
   ```

   Expected (sample):

   ```text
   user_dashboard_layout_requests_total{operation="read",outcome="not_found"} 1
   ```

5. **Exercise the write / success path.**

   ```bash
   curl -s -H "Authorization: Bearer $JWT" \
        -H "Content-Type: application/json" \
        -X PATCH http://localhost:3333/api/v1/user/layout \
        -d '{"layout":[{"x":0,"y":0,"cols":4,"rows":4,"moduleKey":"holdings"}]}'
   ```

   Expect HTTP 200. Then confirm
   `user_dashboard_layout_requests_total{operation="write",outcome="success"}`
   incremented and the latency histogram populated for
   `operation="write"`:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^user_dashboard_layout_latency_seconds(_bucket|_sum|_count).*operation="write"'
   ```

   Expected to show every default bucket (`le="0.005"` through
   `le="10"` and `le="+Inf"`) plus non-zero `_sum` and `_count`, all
   carrying `operation="write"`.

6. **Exercise the read / success path.** Repeat the GET from step 4 —
   now expect HTTP 200 with the saved layout, and confirm
   `user_dashboard_layout_requests_total{operation="read",outcome="success"}`
   increments.

7. **Exercise the unauthenticated → 401 path (Rule 8).** Repeat the
   GET and PATCH **without** the `Authorization` header:

   ```bash
   curl -s http://localhost:3333/api/v1/user/layout -i
   curl -s -X PATCH http://localhost:3333/api/v1/user/layout \
        -H "Content-Type: application/json" -d '{"layout":[]}' -i
   ```

   Expect HTTP 401 in both cases. No metric increment is expected —
   the guard stack (`AuthGuard('jwt')` + `HasPermissionGuard`) rejects
   the request before the handler runs.

8. **(Optional) Exercise the write / error path.** Send a malformed
   PATCH body to trigger DTO validation rejection (e.g. a non-array
   `layout`, or an item missing `moduleKey`):

   ```bash
   curl -s -H "Authorization: Bearer $JWT" \
        -H "Content-Type: application/json" \
        -X PATCH http://localhost:3333/api/v1/user/layout \
        -d '{"layout":[{"x":0,"y":0,"cols":4}]}' -i
   ```

   Confirm the documented error outcome label
   (`user_dashboard_layout_requests_total{operation="write",outcome="error"}`)
   increments, aligning to the actual service behaviour.

If any of the steps above does not produce the expected line, the
dashboard cannot render correctly. Inspect the structured logs (each
line is prefixed with `[UserDashboardLayoutService] [<correlationId>]`)
and the service source
(`apps/api/src/app/user/user-dashboard-layout.service.ts`) before
declaring the dashboard broken.

## JSON Dashboard Definition

A self-contained Grafana 9+ dashboard ready for import. Datasource UID
is parameterised via `${DS_PROMETHEUS}` — replace with the local
datasource UID before import.

```json
{
  "title": "User Dashboard Layout",
  "tags": ["ghostfolio", "user-dashboard-layout", "dashboard", "blitzy"],
  "schemaVersion": 38,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-6h", "to": "now" },
  "templating": {
    "list": [
      {
        "name": "DS_PROMETHEUS",
        "label": "Prometheus",
        "type": "datasource",
        "query": "prometheus",
        "current": {}
      },
      {
        "name": "operation",
        "label": "Operation",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
        "query": "label_values(user_dashboard_layout_requests_total, operation)",
        "includeAll": true,
        "multi": true,
        "current": { "text": "All", "value": "$__all" }
      }
    ]
  },
  "panels": [
    {
      "id": 1,
      "type": "timeseries",
      "title": "Layout Latency by Operation (p50 / p95 / p99)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.1 },
              { "color": "red", "value": 0.5 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.5, sum by (le, operation) (rate(user_dashboard_layout_latency_seconds_bucket{operation=~\"$operation\"}[5m])))",
          "legendFormat": "p50 {{operation}}"
        },
        {
          "refId": "B",
          "expr": "histogram_quantile(0.95, sum by (le, operation) (rate(user_dashboard_layout_latency_seconds_bucket{operation=~\"$operation\"}[5m])))",
          "legendFormat": "p95 {{operation}}"
        },
        {
          "refId": "C",
          "expr": "histogram_quantile(0.99, sum by (le, operation) (rate(user_dashboard_layout_latency_seconds_bucket{operation=~\"$operation\"}[5m])))",
          "legendFormat": "p99 {{operation}}"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    },
    {
      "id": 2,
      "type": "heatmap",
      "title": "Layout Latency Distribution",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "s" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (le) (rate(user_dashboard_layout_latency_seconds_bucket[5m]))",
          "format": "heatmap",
          "legendFormat": "{{le}}"
        }
      ],
      "options": {
        "calculate": false,
        "yAxis": { "unit": "s" }
      }
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Request Outcome Distribution by Operation (rate / 5m)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 8, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "ops",
          "custom": { "stacking": { "mode": "normal" } }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (operation, outcome) (rate(user_dashboard_layout_requests_total{operation=~\"$operation\"}[5m]))",
          "legendFormat": "{{operation}} / {{outcome}}"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    },
    {
      "id": 4,
      "type": "stat",
      "title": "Write Success Rate",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 8, "w": 6, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "min": 0,
          "max": 1,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "red", "value": null },
              { "color": "yellow", "value": 0.95 },
              { "color": "green", "value": 0.99 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(rate(user_dashboard_layout_requests_total{operation=\"write\",outcome=\"success\"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation=\"write\"}[5m])), 1e-9)",
          "legendFormat": "write success rate"
        }
      ],
      "options": {
        "reduceOptions": {
          "calcs": ["lastNotNull"],
          "fields": "",
          "values": false
        },
        "colorMode": "background",
        "graphMode": "area"
      }
    },
    {
      "id": 5,
      "type": "stat",
      "title": "First-Visit (not_found) Read Share",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 18, "y": 8, "w": 6, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "min": 0,
          "max": 1,
          "thresholds": {
            "mode": "absolute",
            "steps": [{ "color": "blue", "value": null }]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(rate(user_dashboard_layout_requests_total{operation=\"read\",outcome=\"not_found\"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation=\"read\"}[5m])), 1e-9)",
          "legendFormat": "not_found read share"
        }
      ],
      "options": {
        "reduceOptions": {
          "calcs": ["lastNotNull"],
          "fields": "",
          "values": false
        },
        "colorMode": "value",
        "graphMode": "area"
      }
    },
    {
      "id": 6,
      "type": "timeseries",
      "title": "Request Volume by Operation (per 5m)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 16, "w": 24, "h": 6 },
      "fieldConfig": {
        "defaults": { "unit": "ops" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (operation) (rate(user_dashboard_layout_requests_total{operation=~\"$operation\"}[5m]))",
          "legendFormat": "{{operation}}"
        }
      ],
      "options": {
        "tooltip": { "mode": "single" },
        "legend": { "displayMode": "list", "placement": "bottom" }
      }
    }
  ]
}
```

## References

- **Service** —
  `apps/api/src/app/user/user-dashboard-layout.service.ts`.
- **Controller** —
  `apps/api/src/app/user/user-dashboard-layout.controller.ts`.
- **Module** — `apps/api/src/app/user/user.module.ts`.
- **Metrics registry** —
  `apps/api/src/app/metrics/metrics.service.ts`,
  `apps/api/src/app/metrics/metrics.controller.ts`.
- **Health probe** — the existing `HealthModule`
  (`apps/api/src/app/health/`) registered in
  `apps/api/src/app/app.module.ts`.
- **Endpoints** — `GET /api/v1/user/layout` and
  `PATCH /api/v1/user/layout` (guarded by `AuthGuard('jwt')` +
  `HasPermissionGuard`; unauthenticated → 401).
- **Shared interface** —
  `libs/common/src/lib/interfaces/user-dashboard-layout.interface.ts`.
- **Request DTO** —
  `libs/common/src/lib/dtos/user/update-user-dashboard-layout.dto.ts`.
- **AAP** — §0.1.1 (feature definition), §0.6.1 Group 5 (layout
  endpoints) and Group 9 (Observability), §0.8.1 Rule 8 (guarded
  endpoints), §0.8.2 (Observability rule).

### Metric Names (Authoritative List)

The dashboard, alerting rules, and verification commands above
reference **only** the two metric names below. Any metric name not
appearing in this list is not emitted by the layout endpoints and will
yield empty Grafana panels if referenced.

- `user_dashboard_layout_requests_total` (counter; labels:
  `operation` ∈ {`read`, `write`}, `outcome` ∈ {`success`,
  `not_found`, `error`})
- `user_dashboard_layout_latency_seconds` (histogram; label:
  `operation` ∈ {`read`, `write`})
