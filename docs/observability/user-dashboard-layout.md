# User Dashboard Layout — Observability Dashboard

## Overview

Operator dashboard for the **User Dashboard Layout** feature, the
per-user persistence layer behind the Modular Dashboard's single-canvas
grid. It is exposed through two authenticated endpoints:

- `GET /api/v1/user/layout` — returns the authenticated user's saved
  grid arrangement, or **404** on the first visit (no saved layout).
- `PATCH /api/v1/user/layout` — upserts the authenticated user's grid
  arrangement (debounced ~500 ms client-side before each call).

The dashboard tracks the two Prometheus metrics emitted by the new
`UserDashboardLayoutService` and exposed at `GET /api/v1/metrics`:

1. `user_dashboard_layout_requests_total` — outcome counter for every
   layout read/upsert handled by the service. Labelled by `operation`
   (`get`, `patch`) and `outcome` (`success`, `not_found`, `error`).
2. `user_dashboard_layout_latency_seconds` — histogram of end-to-end
   wall-clock latency for a layout read/upsert. Labelled by `operation`
   (`get`, `patch`).

This is the first CRUD-endpoint feature in the codebase to emit
metrics — the precedent `user-financial-profile` feature does not — so
the two signals above are intentionally minimal and follow the
established `<feature_prefix>_<noun>_total` / `_seconds` convention.

The dashboard is intentionally scoped to **only** the metrics actually
emitted by `UserDashboardLayoutService`. Additional signals —
per-module add/remove counts, the number of modules per layout, the
JSONB `layoutData` byte size, and any per-user time series — are
**not** exposed by this version of the service, and they must not be:
a per-user (or per-layout) label would breach the metrics registry's
low-cardinality contract (`MAX_LABEL_CARDINALITY_PER_METRIC = 100`)
and is explicitly prohibited. Operators who need those dimensions must
either extend `UserDashboardLayoutService` to register additional
low-cardinality metrics or inspect the structured logs (every line is
prefixed with `[UserDashboardLayoutService] [<correlationId>]`).

## Audience

- **Site Reliability Engineering / Platform Operations** — primary
  dashboard owners; on-call rotation watches GET latency against the
  ≤ 300 ms SLO, the error-outcome rate, and request volume during
  incidents.
- **Frontend / Feature Engineering** — secondary owners; review the
  relative share of the `not_found` outcome on `operation="get"`,
  which is the first-visit onboarding signal that drives the client's
  module-catalog auto-open. A shifting `not_found` share is an
  onboarding metric, not a reliability regression.

## Cross-references

- **AAP §0.1.1** — feature definition (Modular Dashboard system and
  the per-user layout persistence endpoints).
- **AAP §0.6** — technical implementation of the layout
  controller/service and the metrics emission seam.
- **AAP §0.7.1** — places `apps/api/src/app/metrics/*` additive layout
  metrics in scope for this feature.
- **AAP §0.8.2 (Observability rule)** — mandates this dashboard
  template alongside structured logging, correlation IDs, the metrics
  endpoint, and the health/readiness checks.
- **AAP §0.8.3 (Acceptance)** — `GET /api/v1/user/layout` must return
  within **≤ 300 ms p95**; `PATCH` persists and returns 200. These
  bounds set the latency-panel thresholds and the latency alert below.
- **Source of truth — service**:
  `apps/api/src/app/user/user-dashboard-layout.service.ts`. The two
  metrics are registered (via `MetricsService.registerHelp`) and
  emitted from this service. Both the counter increment and the
  histogram observation fire from a single `finally` block per
  operation (mirroring the `RebalancingService` `finally`-block
  pattern), so the histogram is recorded for every outcome including
  `not_found` and `error`.
- **Source of truth — controller**:
  `apps/api/src/app/user/user-dashboard-layout.controller.ts`. Thin
  controller for `GET`/`PATCH /api/v1/user/layout`; sets the
  `X-Correlation-ID` response header and sources `userId` exclusively
  from `request.user.id`. Guards run before the handler, so 401s are
  never counted by these handler-level metrics.
- **Source of truth — metrics registry**:
  `apps/api/src/app/metrics/metrics.service.ts`. Default histogram
  buckets (in seconds) are
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`, and the
  low-cardinality contract caps each metric at
  `MAX_LABEL_CARDINALITY_PER_METRIC = 100` distinct label sets.
- **Spec coverage**:
  `apps/api/src/app/user/*dashboard-layout*.spec.ts` exercises the
  `get`/`patch` success, `not_found`, and `error` paths and asserts
  that the corresponding counter increment and histogram observation
  fire.
- **Health / readiness**: reuses the existing `/api/v1/health`
  endpoint — no new probe is added for this feature.

## Emitted Metrics — Authoritative Reference

| Metric                                  | Type      | Labels                                                                        | HELP text                                                                                                                                                             |
| --------------------------------------- | --------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_dashboard_layout_requests_total`  | counter   | `operation` ∈ {`get`, `patch`}; `outcome` ∈ {`success`, `not_found`, `error`} | Total user dashboard layout endpoint requests handled by UserDashboardLayoutService, labeled by operation (get \| patch) and outcome (success \| not_found \| error). |
| `user_dashboard_layout_latency_seconds` | histogram | `operation` ∈ {`get`, `patch`}                                                | End-to-end wall-clock latency of UserDashboardLayoutService get/upsert operations in seconds, labeled by operation (get \| patch).                                    |

The histogram exposes the canonical Prometheus suffixes
`_bucket{le="..."}`, `_sum`, and `_count`; the
`MetricsService.getRegistryAsText()` renderer pre-populates every
default bucket so that PromQL `histogram_quantile()` calls work from
the first observation onwards. Because the histogram carries the
`operation` label, each rendered bucket line includes both `le` and
`operation` (label names are emitted in alphabetical order, e.g.
`{le="0.005",operation="get"}`).

### Outcome semantics

| Outcome     | Meaning                                                                                                                                                        | Notes                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`   | `GET` returned a saved layout (HTTP 200), or `PATCH` persisted the upsert (HTTP 200).                                                                          | Steady-state happy path for returning users and for every save.                                                                                                  |
| `not_found` | `GET` for a user who has no `UserDashboardLayout` row — first visit. The service returns `null`; the controller maps that to a `NotFoundException` → HTTP 404. | **Normal first-visit signal, not a failure.** It drives the client's catalog auto-open. Excluded from the error-rate alert and the GET success-rate denominator. |
| `error`     | Any other failure of the read/upsert — Prisma/DB error, request-body validation failure, or an unexpected exception.                                           | The only genuine failure outcome; backs the error-rate alert.                                                                                                    |

`401 Unauthenticated` requests are rejected by `AuthGuard('jwt')` and
`HasPermissionGuard` **before** the handler runs, so they never reach
`UserDashboardLayoutService` and are therefore **not** counted by
these handler-level metrics.

## Recommended Panels

The dashboard ships with six panels grouped into three rows. The top
row covers wall-clock latency, the middle row covers request outcomes
and the GET reliability/onboarding signals, and the bottom row covers
request volume.

| #   | Panel                                         | Type                  | Primary Metric                                              | Example PromQL                                                                                                                                                                                             |
| --- | --------------------------------------------- | --------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Layout Latency (p50 / p95 / p99) by operation | Time series           | `user_dashboard_layout_latency_seconds`                     | `histogram_quantile(0.95, sum by (le, operation) (rate(user_dashboard_layout_latency_seconds_bucket[5m])))`                                                                                                |
| 2   | Layout Latency Distribution                   | Heatmap               | `user_dashboard_layout_latency_seconds_bucket`              | `sum by (le) (rate(user_dashboard_layout_latency_seconds_bucket[5m]))`                                                                                                                                     |
| 3   | Request Outcome Distribution by operation     | Time series (stacked) | `user_dashboard_layout_requests_total`                      | `sum by (operation, outcome) (rate(user_dashboard_layout_requests_total[5m]))`                                                                                                                             |
| 4   | GET Success Rate                              | Stat (single-value)   | `user_dashboard_layout_requests_total{operation="get"}`     | `sum(rate(user_dashboard_layout_requests_total{operation="get",outcome="success"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation="get",outcome=~"success\|error"}[5m])), 1e-9)` |
| 5   | First-Visit (not_found) Rate                  | Stat (single-value)   | `user_dashboard_layout_requests_total{outcome="not_found"}` | `sum(rate(user_dashboard_layout_requests_total{operation="get",outcome="not_found"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation="get"}[5m])), 1e-9)`                         |
| 6   | Request Volume by operation                   | Time series           | `user_dashboard_layout_requests_total`                      | `sum by (operation) (rate(user_dashboard_layout_requests_total[5m]))`                                                                                                                                      |

### Panel 1 — Layout Latency (p50 / p95 / p99) by operation

The headline operator SLI for the layout endpoints.
`user_dashboard_layout_latency_seconds` is observed exactly once per
request, in the `finally` block of the service method, which
guarantees the histogram is recorded for every outcome including
`not_found` and `error`. The panel renders p50, p95, and p99 split by
`operation` over a five-minute rolling window via
`histogram_quantile()` against the bucket counter. Recommended visual
threshold on the p95 series, anchored to the AAP §0.8.3 SLO:
green ≤ 0.3 s, amber 0.3 s–1 s, red > 1 s. GET is a single Prisma read
and should sit well under 0.3 s; a red breach typically indicates
database-latency or connection-pool pressure rather than feature
load. `PATCH` may run slightly slower (read-modify-write upsert) but
should remain well under the amber band.

### Panel 2 — Layout Latency Distribution (Heatmap)

A heatmap of `user_dashboard_layout_latency_seconds_bucket` over time
gives operators a richer view than the quantile lines alone — shifts
in the bucket distribution flag emerging database slowness before the
SLO is breached. The heatmap reuses the default buckets
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.
Healthy layout traffic clusters in the low buckets (well under
0.25 s); a drift toward the upper buckets is the earliest warning of
a latency regression.

### Panel 3 — Request Outcome Distribution by operation

Stacked time series of `user_dashboard_layout_requests_total`
partitioned by `operation` and `outcome`. Operators see the
composition of terminal outcomes at a glance. Colour discipline is
important here: `success` is green, `error` is red, and `not_found`
is **blue/neutral — never red**, because it is the expected
first-visit signal. A sustained rise in `error` for either operation
is the principal incident signal and warrants inspecting the
`[UserDashboardLayoutService]` logs by `correlationId`. A rise in
`not_found` is an onboarding trend (more first-time users), not a
fault.

### Panel 4 — GET Success Rate

`operation="get"` `success` rate divided by the GET request rate
**excluding `not_found`** (denominator is `success` + `error` only) —
a single-value percentage that maps to the read-path reliability SLO.
Excluding `not_found` is deliberate: a first-visit 404 is a normal
outcome and must not depress the reliability number. The expression
uses `clamp_min(..., 1e-9)` in the denominator to avoid
division-by-zero when no requests are in flight. Recommended
thresholds: green ≥ 0.99, amber 0.95–0.99, red < 0.95.

### Panel 5 — First-Visit (not_found) Rate

The share of GET requests that return `not_found`, framed as an
**onboarding signal** rather than an error. A high value means many
authenticated users are hitting the canvas for the first time (the
catalog auto-opens for them); a value trending to zero is the steady
state of a mature user base. The panel is coloured neutral/blue with
no red threshold — this metric is informational and must never page.
Expression:
`sum(rate(user_dashboard_layout_requests_total{operation="get",outcome="not_found"}[5m]))`
over
`clamp_min(sum(rate(user_dashboard_layout_requests_total{operation="get"}[5m])), 1e-9)`.

### Panel 6 — Request Volume by operation

`sum by (operation) (rate(user_dashboard_layout_requests_total[5m]))`
time series. Establishes the traffic baseline for both endpoints and
complements the rate-based panels — without volume context,
percentage panels can hide low-traffic anomalies (a 50 % error rate
over two requests is far less informative than 50 % over two
thousand). Because the root route `/` calls `GET` on init, the GET
series doubles as a coarse app-load signal.

## Alert Rules

Recommended Prometheus alerting rules. Adjust thresholds and `for`
windows for the operating environment. The three alert classes below
are required: the GET latency SLO, the genuine error rate (which
deliberately excludes the normal `not_found`), and a no-traffic
guard.

```yaml
groups:
  - name: user-dashboard-layout
    rules:
      - alert: UserDashboardLayoutGetLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(user_dashboard_layout_latency_seconds_bucket{operation="get"}[5m]))
          ) > 0.3
        for: 10m
        labels:
          severity: page
          feature: user-dashboard-layout
        annotations:
          summary: 'User dashboard layout GET p95 latency above 300 ms'
          description: |
            user_dashboard_layout_latency_seconds p95 for
            operation="get" has exceeded the AAP §0.8.3 SLO of 300 ms
            (0.3 s) for 10 minutes. GET is a single Prisma read and
            should stay well under target — investigate database
            latency, connection-pool saturation, and the
            [UserDashboardLayoutService] logs (filter by correlationId).
      - alert: UserDashboardLayoutErrorRateHigh
        expr: |
          sum(rate(user_dashboard_layout_requests_total{outcome="error"}[5m]))
            /
          clamp_min(sum(rate(user_dashboard_layout_requests_total[5m])), 1e-9)
            > 0.05
        for: 10m
        labels:
          severity: page
          feature: user-dashboard-layout
        annotations:
          summary: 'User dashboard layout error rate above 5%'
          description: |
            More than 5 % of layout requests have terminated with
            outcome=error over the last 5 minutes. The error outcome
            EXCLUDES not_found (the normal first-visit signal), so this
            reflects genuine Prisma/DB, validation, or unexpected
            failures. Inspect the [UserDashboardLayoutService] logs by
            correlationId and check database health. Do NOT alert on
            not_found — it is expected onboarding traffic.
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
            user_dashboard_layout_requests_total has not incremented for
            the last hour. The root route / renders the dashboard
            canvas, which calls GET /api/v1/user/layout on init, so zero
            traffic during expected windows is consistent with the
            endpoint or route being unreachable (reverse-proxy, auth, or
            client-bootstrap regression). Verify GET /api/v1/user/layout
            with a known-good JWT and inspect the application access log.
```

## Local Development Verification

The following procedure exercises every metric in the local
development environment, satisfying the AAP §0.8.2 Observability
mandate that observability be verified locally.

1. **Bring up the API.** From the repository root, start Postgres and
   Redis (`docker compose -f docker/docker-compose.dev.yml up -d`),
   then start the API in development mode (`npx nx serve api`). Wait
   for the bootstrap log line `Nest application successfully started`.
2. **Mint a development JWT.** Create a user via `POST /api/v1/user`,
   capture the returned `authToken`, and export it as `JWT=...` in the
   shell.
3. **Confirm the registry is populated with the expected HELP lines.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^# (HELP|TYPE) user_dashboard_layout_'
   ```

   Expected output (order may vary):

   ```text
   # HELP user_dashboard_layout_latency_seconds End-to-end wall-clock latency of UserDashboardLayoutService get/upsert operations in seconds, labeled by operation (get | patch).
   # TYPE user_dashboard_layout_latency_seconds histogram
   # HELP user_dashboard_layout_requests_total Total user dashboard layout endpoint requests handled by UserDashboardLayoutService, labeled by operation (get | patch) and outcome (success | not_found | error).
   # TYPE user_dashboard_layout_requests_total counter
   ```

   Note: the metrics only appear after the service has handled at least
   one request, because the counter/histogram series are created on
   first emission.

4. **Exercise the first-visit path (`get` → `not_found`).** For a user
   with no saved layout:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
        -H "Authorization: Bearer $JWT" \
        http://localhost:3333/api/v1/user/layout
   ```

   Expected: HTTP `404`. Then confirm the counter:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^user_dashboard_layout_requests_total\{'
   ```

   Expected (sample):

   ```text
   user_dashboard_layout_requests_total{operation="get",outcome="not_found"} 1
   ```

5. **Exercise the save path (`patch` → `success`).**

   ```bash
   curl -s -H "Authorization: Bearer $JWT" \
        -H "Content-Type: application/json" \
        -X PATCH http://localhost:3333/api/v1/user/layout \
        -d '{"layoutData":{"schemaVersion":1,"items":[{"moduleKey":"portfolio-overview","x":0,"y":0,"cols":6,"rows":4}]}}' \
     | python3 -m json.tool
   ```

   Expected: HTTP 200 with the persisted `UserDashboardLayout` JSON.
   The counter now shows `operation="patch",outcome="success"`.

6. **Exercise the returning-user path (`get` → `success`).** Repeat
   the GET from step 4; it now returns HTTP 200 with the saved layout,
   and `user_dashboard_layout_requests_total{operation="get",outcome="success"}`
   increments. Confirm the latency histogram has populated:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^user_dashboard_layout_latency_seconds(_bucket|_sum|_count)'
   ```

   Expected to show every default bucket (`le="0.005"` through
   `le="10"` and `le="+Inf"`) per `operation`, plus non-zero `_sum`
   and `_count`, e.g.:

   ```text
   user_dashboard_layout_latency_seconds_bucket{le="+Inf",operation="get"} 2
   user_dashboard_layout_latency_seconds_sum{operation="get"} 0.0123
   user_dashboard_layout_latency_seconds_count{operation="get"} 2
   ```

7. **Confirm the `error` outcome path.** The `error` outcome captures
   Prisma/DB, validation, and unexpected failures and is hard to force
   safely at runtime; it is covered deterministically by the spec
   suite (`apps/api/src/app/user/*dashboard-layout*.spec.ts`), which
   mocks `PrismaService` to throw and asserts that
   `user_dashboard_layout_requests_total{outcome="error"}` increments.
   To reproduce manually, stop Postgres and repeat step 4 — the GET
   fails and the `error` counter increments.

8. **Confirm 401s are NOT counted.** Repeat step 4 **without** the
   `Authorization` header:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
        http://localhost:3333/api/v1/user/layout
   ```

   Expected: HTTP `401`, and **no** change to
   `user_dashboard_layout_requests_total` — the guards reject the
   request before the handler, so it is never counted.

If any step above does not produce the expected line, the dashboard
cannot render correctly. Inspect the structured logs (each line is
prefixed with `[UserDashboardLayoutService] [<correlationId>]`) and
the service source before declaring the dashboard broken.

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
      },
      {
        "name": "outcome",
        "label": "Outcome",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
        "query": "label_values(user_dashboard_layout_requests_total, outcome)",
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
      "title": "Layout Latency (p50 / p95 / p99) by operation",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.3 },
              { "color": "red", "value": 1 }
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
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (le) (rate(user_dashboard_layout_latency_seconds_bucket[5m]))",
          "format": "heatmap",
          "legendFormat": "{{le}}"
        }
      ],
      "options": { "calculate": false, "yAxis": { "unit": "s" } }
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Request Outcome Distribution by operation (rate / 5m)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 8, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "ops",
          "custom": { "stacking": { "mode": "normal" } }
        },
        "overrides": [
          {
            "matcher": { "id": "byRegexp", "options": "/.*success/" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "green" }
              }
            ]
          },
          {
            "matcher": { "id": "byRegexp", "options": "/.*not_found/" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "blue" }
              }
            ]
          },
          {
            "matcher": { "id": "byRegexp", "options": "/.*error/" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "red" }
              }
            ]
          }
        ]
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (operation, outcome) (rate(user_dashboard_layout_requests_total{operation=~\"$operation\",outcome=~\"$outcome\"}[5m]))",
          "legendFormat": "{{operation}} {{outcome}}"
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
      "title": "GET Success Rate",
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
          "expr": "sum(rate(user_dashboard_layout_requests_total{operation=\"get\",outcome=\"success\"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation=\"get\",outcome=~\"success|error\"}[5m])), 1e-9)",
          "legendFormat": "get success rate"
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
      "title": "First-Visit (not_found) Rate",
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
          "expr": "sum(rate(user_dashboard_layout_requests_total{operation=\"get\",outcome=\"not_found\"}[5m])) / clamp_min(sum(rate(user_dashboard_layout_requests_total{operation=\"get\"}[5m])), 1e-9)",
          "legendFormat": "first-visit rate"
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
      "id": 6,
      "type": "timeseries",
      "title": "Request Volume by operation (per 5m)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 16, "w": 24, "h": 6 },
      "fieldConfig": { "defaults": { "unit": "ops" }, "overrides": [] },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (operation) (rate(user_dashboard_layout_requests_total[5m]))",
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
  `apps/api/src/app/user/user-dashboard-layout.service.ts` (metric
  registration + emission from the per-operation `finally` block).
- **Controller** —
  `apps/api/src/app/user/user-dashboard-layout.controller.ts`.
- **Module** — `apps/api/src/app/user/user.module.ts` (registers the
  layout controller and service).
- **Metrics registry** — `apps/api/src/app/metrics/metrics.service.ts`,
  `apps/api/src/app/metrics/metrics.controller.ts`.
- **Endpoints** — `GET /api/v1/user/layout` (returns
  `UserDashboardLayout` JSON; 404 on first visit) and
  `PATCH /api/v1/user/layout` (upserts; returns 200).
- **Shared interface** —
  `libs/common/src/lib/interfaces/user-dashboard-layout.interface.ts`
  (`UserDashboardLayout`, `LayoutData`, `DashboardLayoutItem`,
  `UserDashboardLayoutPatchPayload`).
- **Health probe** — `/api/v1/health` (existing; reused, no new
  probe).
- **Decision log** —
  `docs/decisions/user-dashboard-layout-decisions.md`.
- **AAP** — §0.1.1 (feature definition), §0.6 (technical
  implementation), §0.7.1 (metrics in scope), §0.8.2 (Observability
  rule), §0.8.3 (≤ 300 ms p95 GET SLO and endpoint contracts).

### Metric Names (Authoritative List)

The dashboard, alerting rules, and verification commands above
reference **only** the two metric names below. Any metric name not
appearing in this list is not emitted by `UserDashboardLayoutService`
and will yield empty Grafana panels if referenced.

- `user_dashboard_layout_requests_total` (counter; labels:
  `operation` ∈ {`get`, `patch`}, `outcome` ∈ {`success`,
  `not_found`, `error`})
- `user_dashboard_layout_latency_seconds` (histogram; label:
  `operation` ∈ {`get`, `patch`})

These names are **authoritative as emitted by `apps/api`** (the
`UserDashboardLayoutService` metric registrations and the
`MetricsService` registry). If the `apps/api` implementation diverges
— a renamed metric, an added/removed label, or a changed label value
— **this document must be updated to match the code**, which is the
single source of truth for the emitted series.
