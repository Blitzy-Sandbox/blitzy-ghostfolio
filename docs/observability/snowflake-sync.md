# Snowflake Sync Layer — Observability Dashboard

## Overview

Operator dashboard for the **Snowflake Sync Layer** that mirrors
Ghostfolio's operational data — portfolio snapshots, trade history,
and performance metrics — into Snowflake as an append-only
analytical backend. The dashboard tracks the two Prometheus metrics
emitted by `SnowflakeSyncService` and exposed at
`GET /api/v1/metrics`:

1. `snowflake_sync_runs_total` — terminal-outcome counter for every
   Snowflake sync invocation. Labelled by `outcome`
   (`success`, `failure`) and `trigger`
   (`cron`, `manual`, `event`).
2. `snowflake_sync_latency_seconds` — histogram of end-to-end
   wall-clock latency for a sync invocation. Labelled by `trigger`.

The three trigger paths and their emission sites in
`apps/api/src/app/snowflake-sync/snowflake-sync.service.ts`:

- **`trigger="cron"`** — `runDailySync()` decorated with
  `@Cron('0 2 * * *', { name: 'snowflake-daily-sync', timeZone: 'UTC' })`
  (line 223). Counter increments at lines 251 (success) and 257
  (failure); histogram observation at line 283.
- **`trigger="manual"`** — `triggerManualSync()` called by the
  admin endpoint `POST /api/v1/snowflake-sync/trigger`. Counter
  increments at lines 474 (success) and 491 (failure); histogram
  observation at line 535.
- **`trigger="event"`** — `processDebouncedEventSync()` driven by
  the `@OnEvent(PortfolioChangedEvent.getName())` listener with a
  per-user 5 s debounce window. Counter increments at lines 1065
  (success) and 1075 (failure); histogram observation at line 1086.

The dashboard is intentionally scoped to **only** the metrics actually
emitted by `SnowflakeSyncService`. Additional signals — per-table MERGE
row counts, distinct connection-failure classes, bind-validation
failure counts, cron last-run timestamps as a separate gauge — are
**not** exposed by this version of the service. Operators who require
those signals must either extend `SnowflakeSyncService` to register
the corresponding metrics or surface them through Snowflake's own
query history (`INFORMATION_SCHEMA.QUERY_HISTORY`) and the
application's structured logs (every line is prefixed with
`[SnowflakeSyncService] [<correlationId>]`).

## Audience

- **Site Reliability Engineering / Platform Operations** — primary
  dashboard owners; on-call rotation watches sync success rate, sync
  latency, and the 24-hour cron heartbeat during incidents.
- **Data Engineering** — secondary owners; review trigger-specific
  failure rates to determine whether incidents originate in the
  cron path (typically Snowflake credential or warehouse issues),
  the manual path (typically operator error in the request body),
  or the event path (typically Postgres-to-Snowflake data shape
  mismatches).

## Cross-references

- **AAP §0.1.1 / §0.5.1.1** — feature definition (Feature A —
  Snowflake Sync Layer) and emitted-metrics scope.
- **AAP §0.7.1.7 (Rule 7)** — all Snowflake write operations MUST
  use MERGE (upsert) statements keyed on the unique constraints
  documented in AAP §0.5.1.1. Idempotency on re-run is covered by
  `snowflake-sync.service.spec.ts`.
- **AAP §0.7.2 (Observability rule)** — mandates this dashboard
  template alongside structured logging, correlation IDs, the
  metrics endpoint, and the readiness probes.
- **AAP §0.7.3** — cron literal is `@Cron('0 2 * * *', { timeZone: 'UTC' })`.
  The dashboard's cron-heartbeat panel and alert rule rely on this
  schedule.
- **Source of truth — service**:
  `apps/api/src/app/snowflake-sync/snowflake-sync.service.ts`.
  Specifically, metric registrations are at lines 188 and 192;
  emission sites are listed in the Overview above.
- **Source of truth — bootstrap DDL**:
  `apps/api/src/app/snowflake-sync/sql/bootstrap.sql`. The three
  Snowflake tables and their unique constraints are created here
  (executed by `SnowflakeSyncService.bootstrap()` on startup).
- **Source of truth — metrics registry**:
  `apps/api/src/app/metrics/metrics.service.ts`. Default histogram
  buckets (in seconds) are
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`. Note
  that Snowflake sync invocations frequently exceed 10 s, so most
  observations land in the `+Inf` bucket — the dashboard heatmap and
  quantile panels visualise the distribution from `_sum` and
  `_count` regardless.
- **Health probe** — `/api/v1/health/snowflake` exercises a live
  `SELECT 1` against Snowflake with a 5 s timeout. The dashboard's
  manual-trigger failure panel correlates with this probe.
- **Spec coverage**:
  `apps/api/src/app/snowflake-sync/snowflake-sync.service.spec.ts`
  exercises both outcomes for every trigger, asserting the counter
  and histogram increments (including idempotency on re-run per
  Rule 7).

## Emitted Metrics — Authoritative Reference

| Metric                           | Type      | Labels                                                                      | HELP text                                                           |
| -------------------------------- | --------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `snowflake_sync_runs_total`      | counter   | `outcome` ∈ {`success`, `failure`}; `trigger` ∈ {`cron`, `manual`, `event`} | Total Snowflake sync invocations partitioned by trigger and outcome |
| `snowflake_sync_latency_seconds` | histogram | `trigger` ∈ {`cron`, `manual`, `event`}                                     | Latency of a Snowflake sync invocation in seconds                   |

The histogram exposes the canonical Prometheus suffixes
`_bucket{le="..."}`, `_sum`, and `_count`; the
`MetricsService.getRegistryAsText()` renderer pre-populates every
default bucket so that PromQL `histogram_quantile()` calls work from
the first observation onwards.

## Recommended Panels

The dashboard ships with seven panels grouped into three rows. The
top row covers latency, the middle row covers per-trigger run
volume and success rate, and the bottom row covers cron heartbeat
and event-listener volume.

| #   | Panel                                     | Type                  | Primary Metric                                 | Example PromQL                                                                                                                                          |
| --- | ----------------------------------------- | --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sync Latency (p50 / p95 / p99) by Trigger | Time series           | `snowflake_sync_latency_seconds`               | `histogram_quantile(0.95, sum by (le, trigger) (rate(snowflake_sync_latency_seconds_bucket[15m])))`                                                     |
| 2   | Sync Latency Distribution                 | Heatmap               | `snowflake_sync_latency_seconds_bucket`        | `sum by (le) (rate(snowflake_sync_latency_seconds_bucket[15m]))`                                                                                        |
| 3   | Sync Outcome Distribution by Trigger      | Time series (stacked) | `snowflake_sync_runs_total`                    | `sum by (outcome, trigger) (rate(snowflake_sync_runs_total[15m]))`                                                                                      |
| 4   | Sync Success Rate by Trigger              | Time series           | `snowflake_sync_runs_total{outcome="success"}` | `sum by (trigger) (rate(snowflake_sync_runs_total{outcome="success"}[15m])) / clamp_min(sum by (trigger) (rate(snowflake_sync_runs_total[15m])), 1e-9)` |
| 5   | Sync Failure Count (last 24 h)            | Bar chart             | `snowflake_sync_runs_total{outcome="failure"}` | `sum by (trigger) (increase(snowflake_sync_runs_total{outcome="failure"}[24h]))`                                                                        |
| 6   | Cron Heartbeat (last 24 h)                | Stat                  | `snowflake_sync_runs_total{trigger="cron"}`    | `sum(increase(snowflake_sync_runs_total{trigger="cron"}[26h]))`                                                                                         |
| 7   | Event-Listener Volume                     | Time series           | `snowflake_sync_runs_total{trigger="event"}`   | `sum by (outcome) (rate(snowflake_sync_runs_total{trigger="event"}[5m]))`                                                                               |

### Panel 1 — Sync Latency (p50 / p95 / p99) by Trigger

Three series per trigger (cron, manual, event), each rendered as
p50, p95, and p99 over a fifteen-minute rolling window via
`histogram_quantile()` against the bucket counter. The fifteen-minute
window is chosen deliberately: cron runs only once per day, and a
shorter window typically yields no data points for the cron trigger
between firings. Recommended visual thresholds: green ≤ 5 s, amber
5 s–30 s, red > 30 s on the p95 series for the **manual** and
**event** triggers; the **cron** trigger frequently exceeds 30 s (it
processes every user) and should be evaluated against its own
historical baseline rather than a fixed threshold.

### Panel 2 — Sync Latency Distribution (Heatmap)

A heatmap of `snowflake_sync_latency_seconds_bucket` over time
provides operators with a richer view than the quantile lines alone.
The heatmap reuses the default buckets
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.
Most snowflake sync observations cluster near or beyond the upper
end of the ladder; the `+Inf` bucket count equals the total
observation count by definition.

### Panel 3 — Sync Outcome Distribution by Trigger

Stacked time series of `snowflake_sync_runs_total` partitioned by
both the `outcome` and `trigger` labels (six possible series).
Operators can see at a glance the composition of terminal outcomes
across triggers — `outcome="success"` should dominate during steady
state, and a sustained increase in `outcome="failure"` for any
trigger is the principal incident signal for the sync layer.

### Panel 4 — Sync Success Rate by Trigger

Per-trigger success-rate series — `outcome="success"` rate divided
by total rate, computed `by (trigger)`. The expression uses
`clamp_min(..., 1e-9)` in the denominator to avoid division-by-zero
when a particular trigger has no recent invocations. Recommended
thresholds:

- **`trigger="cron"`** — should be 1.0 at the daily sample. Anything
  less than 1.0 means at least one user's sync failed inside the
  daily run.
- **`trigger="manual"`** and **`trigger="event"`** — green ≥ 99 %,
  amber 95 %–99 %, red < 95 %.

### Panel 5 — Sync Failure Count (last 24 h)

Aggregate failure count per trigger over the last 24 hours.
Complements the rate-based panels by surfacing the absolute number
of failed sync invocations — a useful "incident impact" lens during
post-incident reviews. The bars are independent per trigger so
operators can spot whether a manual-path failure spike masks an
underlying event-path regression.

### Panel 6 — Cron Heartbeat (last 24 h)

Counts the total number of cron-triggered sync runs over the last
26 hours (a slightly larger window than 24 h to tolerate scheduler
jitter at the hour boundary). The cron is configured to fire once
per day at 02:00 UTC, so the expected value is **1** outside of
unusual circumstances. A value of **0** for more than 26 hours is a
cron-heartbeat failure and is paged by the
`SnowflakeCronHeartbeatStale` alert below.

This panel replaces a traditional "last-cron-run timestamp" gauge —
the in-process metrics registry implemented at
`apps/api/src/app/metrics/metrics.service.ts` supports counters and
histograms only and does not expose gauges. The "did the cron fire
within the expected window?" question is therefore answered via
`increase(snowflake_sync_runs_total{trigger="cron"}[26h])` rather
than a timestamp gauge.

### Panel 7 — Event-Listener Volume

`sum by (outcome) (rate(snowflake_sync_runs_total{trigger="event"}[5m]))`
time series. The event listener is debounced per user for 5 s and
fires whenever an authenticated user creates, updates, or deletes
an order (via `PortfolioChangedEvent`). A sustained zero on this
panel during expected user activity is consistent with an
event-bus regression (e.g., the listener never registered with
`EventEmitter2`). A sudden spike in `outcome="failure"` on this
panel is consistent with a Snowflake-side issue affecting the
real-time path.

## Alert Rules

Recommended Prometheus alerting rules. Adjust thresholds and `for`
windows for the operating environment.

```yaml
groups:
  - name: snowflake-sync
    rules:
      - alert: SnowflakeSyncSuccessRateLowManual
        expr: |
          sum(rate(snowflake_sync_runs_total{outcome="success",trigger="manual"}[15m]))
            /
          clamp_min(
            sum(rate(snowflake_sync_runs_total{trigger="manual"}[15m])),
            1e-9
          )
            < 0.95
        for: 15m
        labels:
          severity: page
          feature: snowflake-sync
        annotations:
          summary: 'Manual Snowflake sync success rate below 95%'
          description: |
            Fewer than 95 % of manual-trigger Snowflake syncs have
            succeeded over the last 15 minutes. Inspect
            [SnowflakeSyncService] log lines for the affected
            correlationIds, and verify the /api/v1/health/snowflake
            probe.

      - alert: SnowflakeSyncSuccessRateLowEvent
        expr: |
          sum(rate(snowflake_sync_runs_total{outcome="success",trigger="event"}[15m]))
            /
          clamp_min(
            sum(rate(snowflake_sync_runs_total{trigger="event"}[15m])),
            1e-9
          )
            < 0.95
        for: 30m
        labels:
          severity: page
          feature: snowflake-sync
        annotations:
          summary: 'Event-driven Snowflake sync success rate below 95%'
          description: |
            Fewer than 95 % of event-driven Snowflake syncs (Order
            CRUD path) have succeeded over the last 30 minutes.
            Recent user portfolio changes are not being mirrored
            into Snowflake reliably. The /api/v1/health/snowflake
            probe and the structured logs are the first
            investigation surfaces.

      - alert: SnowflakeSyncLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le, trigger) (
              rate(snowflake_sync_latency_seconds_bucket{trigger=~"manual|event"}[15m])
            )
          ) > 30
        for: 15m
        labels:
          severity: warning
          feature: snowflake-sync
        annotations:
          summary: 'Snowflake sync latency p95 above 30 s for {{ $labels.trigger }}'
          description: |
            snowflake_sync_latency_seconds p95 has exceeded 30 s for
            15 minutes for trigger={{ $labels.trigger }}. The cron
            trigger is excluded from this rule because daily
            full-corpus syncs are expected to exceed 30 s. Inspect
            Snowflake warehouse load and recent table-size growth.

      - alert: SnowflakeCronHeartbeatStale
        expr: |
          sum(increase(snowflake_sync_runs_total{trigger="cron"}[26h])) == 0
        for: 30m
        labels:
          severity: page
          feature: snowflake-sync
        annotations:
          summary: 'Snowflake cron sync did not fire in the last 26 hours'
          description: |
            The daily Snowflake sync cron is configured at
            @Cron('0 2 * * *', { timeZone: 'UTC' }) but no
            cron-triggered runs have been recorded for 26 hours.
            Likely root causes: the API process restarted after
            02:00 UTC and is now waiting for the next firing,
            ScheduleModule failed to register the job, or the
            cron job is throwing before the first metric increment.

      - alert: SnowflakeCronFailureBurst
        expr: |
          sum(increase(snowflake_sync_runs_total{trigger="cron",outcome="failure"}[2h]))
            > 0
        for: 5m
        labels:
          severity: page
          feature: snowflake-sync
        annotations:
          summary: 'Snowflake cron sync recorded at least one failure'
          description: |
            The daily Snowflake sync cron processes every user; this
            alert fires when at least one user-level failure was
            recorded inside the cron run. Inspect
            [SnowflakeSyncService] log lines for the affected
            correlationId and user_id, and verify the
            /api/v1/health/snowflake probe.

      - alert: SnowflakeEventListenerSilent
        expr: |
          sum(rate(snowflake_sync_runs_total{trigger="event"}[1h])) == 0
        for: 4h
        labels:
          severity: warning
          feature: snowflake-sync
        annotations:
          summary: 'Snowflake event-listener has been silent for 4 hours'
          description: |
            No event-driven Snowflake syncs have fired for the past
            4 hours. During expected traffic windows this is
            consistent with an EventEmitter2 listener regression —
            verify @OnEvent(PortfolioChangedEvent.getName()) is
            registered on SnowflakeSyncService at startup, and that
            ActivitiesService still emits PortfolioChangedEvent on
            order CRUD operations.
```

## Local Development Verification

The following procedure exercises every metric in the local
development environment, satisfying the AAP §0.7.2 Observability
mandate that "all observability MUST be exercised in the local
development environment."

1. **Bring up the API.** From the repository root, start Postgres and
   Redis (`docker compose -f docker/docker-compose.dev.yml up -d`)
   and ensure the six `SNOWFLAKE_*` environment variables resolve to
   a development Snowflake account (see `.env.example`). Start the
   API (`npx nx serve api`) and wait for the bootstrap log line
   `Nest application successfully started`.
2. **Confirm Snowflake bootstrap completes.** Inspect the API stdout
   for the line
   `[SnowflakeSyncService] Snowflake bootstrap DDL completed`
   (logged after `bootstrap.sql` is executed against the configured
   `SNOWFLAKE_DATABASE.SNOWFLAKE_SCHEMA`).
3. **Confirm the registry is populated with the expected HELP lines.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^# (HELP|TYPE) snowflake_sync_'
   ```

   Expected output (order may vary):

   ```text
   # HELP snowflake_sync_latency_seconds Latency of a Snowflake sync invocation in seconds
   # TYPE snowflake_sync_latency_seconds histogram
   # HELP snowflake_sync_runs_total Total Snowflake sync invocations partitioned by trigger and outcome
   # TYPE snowflake_sync_runs_total counter
   ```

4. **Trigger the manual path.** Mint a JWT for a user with the
   `triggerSnowflakeSync` permission, then:

   ```bash
   curl -s -X POST http://localhost:3333/api/v1/snowflake-sync/trigger \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

5. **Observe `snowflake_sync_runs_total{trigger="manual"}` increment.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^snowflake_sync_runs_total\{'
   ```

   Expected (sample after a successful manual run):

   ```text
   snowflake_sync_runs_total{outcome="success",trigger="manual"} 1
   ```

6. **Observe `snowflake_sync_latency_seconds{trigger="manual"}`
   populate.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^snowflake_sync_latency_seconds(_bucket|_sum|_count)\{'
   ```

   Expected to show every default bucket
   (`le="0.005"` through `le="10"` and `le="+Inf"`) plus
   non-zero `_sum` and `_count`, all carrying
   `trigger="manual"`.

7. **Trigger the event path.** Create or update an order via
   `POST /api/v1/order` for the same user. The
   `@OnEvent(PortfolioChangedEvent.getName())` listener will
   schedule a sync after the 5 s debounce. Wait at least 6 s, then
   re-scrape `/api/v1/metrics` and confirm
   `snowflake_sync_runs_total{trigger="event"}` has incremented.

8. **(Optional) Verify idempotency per Rule 7.** Re-run the manual
   trigger from step 4 with the same `userId`/date. Confirm the
   row counts in the three Snowflake tables (`portfolio_snapshots`,
   `orders_history`, `performance_metrics`) are unchanged from
   the first run — the MERGE statements in
   `snowflake-sync.service.ts` use `?` bind variables on the
   unique constraints from AAP §0.5.1.1, so duplicate input rows
   are upserted in place.

9. **(Optional) Verify the cron heartbeat.** The cron fires daily
   at 02:00 UTC. To exercise it without waiting, an operator may
   temporarily decorate `runDailySync()` with
   `@Cron(CronExpression.EVERY_30_SECONDS)` in a local-only
   scratch branch. **Do not** commit this change — the
   production-correct schedule is `'0 2 * * *'` per AAP §0.7.3.

10. **Trigger the failure path.** Stop Snowflake connectivity (e.g.,
    set `SNOWFLAKE_ACCOUNT=invalid.example.com` and restart the API),
    then repeat step 4. The controller responds with HTTP 502
    (`BadGatewayException`) and the metric scrape now shows
    `snowflake_sync_runs_total{outcome="failure",trigger="manual"}`
    incremented.

If any of the steps above does not produce the expected line, the
dashboard cannot render correctly. Inspect the structured logs (each
line is prefixed with `[SnowflakeSyncService] [<correlationId>]`)
and the service source (`snowflake-sync.service.ts`) before
declaring the dashboard broken.

## JSON Dashboard Definition

A self-contained Grafana 9+ dashboard ready for import. Datasource
UID is parameterised via `${DS_PROMETHEUS}` — replace with the
local datasource UID before import.

```json
{
  "title": "Snowflake Sync Layer",
  "tags": ["ghostfolio", "snowflake-sync", "snowflake", "blitzy"],
  "schemaVersion": 38,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-24h", "to": "now" },
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
        "name": "trigger",
        "label": "Trigger",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
        "query": "label_values(snowflake_sync_runs_total, trigger)",
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
      "title": "Sync Latency by Trigger (p50 / p95 / p99)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 5 },
              { "color": "red", "value": 30 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.5, sum by (le, trigger) (rate(snowflake_sync_latency_seconds_bucket{trigger=~\"$trigger\"}[15m])))",
          "legendFormat": "p50 {{trigger}}"
        },
        {
          "refId": "B",
          "expr": "histogram_quantile(0.95, sum by (le, trigger) (rate(snowflake_sync_latency_seconds_bucket{trigger=~\"$trigger\"}[15m])))",
          "legendFormat": "p95 {{trigger}}"
        },
        {
          "refId": "C",
          "expr": "histogram_quantile(0.99, sum by (le, trigger) (rate(snowflake_sync_latency_seconds_bucket{trigger=~\"$trigger\"}[15m])))",
          "legendFormat": "p99 {{trigger}}"
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
      "title": "Sync Latency Distribution",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "s" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (le) (rate(snowflake_sync_latency_seconds_bucket{trigger=~\"$trigger\"}[15m]))",
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
      "title": "Sync Outcome Distribution by Trigger (rate / 15m)",
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
          "expr": "sum by (outcome, trigger) (rate(snowflake_sync_runs_total{trigger=~\"$trigger\"}[15m]))",
          "legendFormat": "{{outcome}} {{trigger}}"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Sync Success Rate by Trigger",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 8, "w": 12, "h": 8 },
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
          "expr": "sum by (trigger) (rate(snowflake_sync_runs_total{outcome=\"success\",trigger=~\"$trigger\"}[15m])) / clamp_min(sum by (trigger) (rate(snowflake_sync_runs_total{trigger=~\"$trigger\"}[15m])), 1e-9)",
          "legendFormat": "{{trigger}}"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    },
    {
      "id": 5,
      "type": "barchart",
      "title": "Sync Failure Count (last 24h)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 16, "w": 8, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "short" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (trigger) (increase(snowflake_sync_runs_total{outcome=\"failure\",trigger=~\"$trigger\"}[24h]))",
          "legendFormat": "{{trigger}}",
          "instant": true
        }
      ],
      "options": {
        "orientation": "horizontal",
        "showValue": "always",
        "legend": { "displayMode": "list", "placement": "bottom" }
      }
    },
    {
      "id": 6,
      "type": "stat",
      "title": "Cron Heartbeat (last 26h)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 8, "y": 16, "w": 8, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "min": 0,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "red", "value": null },
              { "color": "green", "value": 1 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(increase(snowflake_sync_runs_total{trigger=\"cron\"}[26h]))",
          "legendFormat": "cron runs"
        }
      ],
      "options": {
        "reduceOptions": {
          "calcs": ["lastNotNull"],
          "fields": "",
          "values": false
        },
        "colorMode": "background",
        "graphMode": "none"
      }
    },
    {
      "id": 7,
      "type": "timeseries",
      "title": "Event-Listener Volume",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 16, "y": 16, "w": 8, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "ops" },
        "overrides": [
          {
            "matcher": { "id": "byName", "options": "success" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "green" }
              }
            ]
          },
          {
            "matcher": { "id": "byName", "options": "failure" },
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
          "expr": "sum by (outcome) (rate(snowflake_sync_runs_total{trigger=\"event\"}[5m]))",
          "legendFormat": "{{outcome}}"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    }
  ]
}
```

## References

- **Service** —
  `apps/api/src/app/snowflake-sync/snowflake-sync.service.ts`.
- **Controller** —
  `apps/api/src/app/snowflake-sync/snowflake-sync.controller.ts`.
- **Module** —
  `apps/api/src/app/snowflake-sync/snowflake-sync.module.ts`.
- **Client factory** —
  `apps/api/src/app/snowflake-sync/snowflake-client.factory.ts`.
- **Bootstrap DDL** —
  `apps/api/src/app/snowflake-sync/sql/bootstrap.sql`.
- **Metrics registry** — `apps/api/src/app/metrics/metrics.service.ts`,
  `apps/api/src/app/metrics/metrics.controller.ts`.
- **Health probe** — `/api/v1/health/snowflake` (live `SELECT 1`
  against Snowflake with a 5 s `Promise.race` timeout).
- **Endpoints** —
  `POST /api/v1/snowflake-sync/trigger` (admin manual trigger;
  guarded by `triggerSnowflakeSync` permission).
- **Event source** — `PortfolioChangedEvent` emitted by
  `apps/api/src/app/activities/activities.service.ts` on every
  order CRUD operation; consumed by
  `@OnEvent(PortfolioChangedEvent.getName())` on
  `SnowflakeSyncService` with a per-user 5 s debounce window.
- **AAP** — §0.1.1 (feature definition), §0.5.1.1 (emitted-metrics
  scope), §0.7.1.7 (Rule 7: MERGE idempotency),
  §0.7.2 (Observability rule), §0.7.3 (cron literal).

### Metric Names (Authoritative List)

The dashboard, alerting rules, and verification commands above
reference **only** the two metric names below. Any metric name not
appearing in this list is not emitted by `SnowflakeSyncService`
and will yield empty Grafana panels if referenced.

- `snowflake_sync_runs_total` (counter; labels: `outcome`, `trigger`)
- `snowflake_sync_latency_seconds` (histogram; labels: `trigger`)
