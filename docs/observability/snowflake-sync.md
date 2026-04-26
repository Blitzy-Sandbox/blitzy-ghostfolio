# Snowflake Sync Layer — Observability Dashboard Template

## Overview

This document is the canonical Grafana dashboard template for **Feature A — Snowflake Sync Layer (`SnowflakeSyncModule`)**, the daily cron plus event-driven mirror that copies Ghostfolio operational data into Snowflake as an append-only analytical backend. It satisfies the project-level **Observability** rule recorded in AAP § 0.7.2 (every deliverable MUST include structured logging with correlation IDs, distributed tracing, a metrics endpoint, health/readiness checks, and a dashboard template — and that observability MUST be exercisable in the local development environment).

### Feature being observed

The dashboard observes the entire lifecycle of the Snowflake sync — both its scheduled and event-driven invocation paths, plus the bind-variable safety net mandated by Rule 2:

- The sync logic is implemented in `SnowflakeSyncService` (`apps/api/src/app/snowflake-sync/snowflake-sync.service.ts`) and the supporting connection layer in `SnowflakeClientFactory` (`apps/api/src/app/snowflake-sync/snowflake-client.factory.ts`). The HTTP entry point for an admin-triggered manual run is `SnowflakeSyncController` at `POST /api/v1/snowflake-sync/trigger` (`apps/api/src/app/snowflake-sync/snowflake-sync.controller.ts`).
- Two scheduling paths feed the same MERGE pipeline. (1) A daily cron at `0 2 * * *` with `timeZone: 'UTC'` (per AAP § 0.7.3 — "Cron schedule literal") re-mirrors the previous day's data for all users; this is the bulk load. (2) A `@OnEvent(PortfolioChangedEvent.getName())` listener subscribes to the existing `PortfolioChangedEvent` already emitted by `apps/api/src/app/activities/activities.service.ts` on every Order CRUD operation and mirrors the affected user's data within the same request lifecycle. The dashboard surfaces both paths with a `trigger=cron|event` label so operators can compare their independent failure modes.
- The sync writes into exactly three Snowflake tables, each with the unique-key constraints documented in AAP § 0.5.1: `portfolio_snapshots` (unique on `(snapshot_date, user_id, asset_class)`), `orders_history` (unique on `(order_id)`), and `performance_metrics` (unique on `(metric_date, user_id)`). All writes are MERGE (upsert) statements per **Rule 7 — Snowflake Sync Idempotency** (AAP § 0.7.1.7), so re-running the sync for an already-mirrored date range MUST leave row counts unchanged.
- All SQL execution uses `snowflake-sdk` bind-variable syntax (`?` placeholders + `binds: [...]`) per **Rule 2 — Parameterized Snowflake Queries** (AAP § 0.7.1.2). String template literals and concatenation operators adjacent to SQL strings are PROHIBITED. The dashboard surfaces a defense-in-depth counter (Panel 7) for any SQL parsing failure detected by `SnowflakeSyncService.queryHistory(...)` — the value MUST remain zero in healthy operation.
- The chat agent's `query_history` tool (per AAP § 0.5.1.5) reuses `SnowflakeSyncService.queryHistory(userId, sql, binds)` to read historical data on behalf of Claude. Failures inside that read path also flow into the bind-validation counter (Panel 7) and the connection-failure counter (Panel 6), so the same dashboard surfaces both background-sync health and chat-agent-driven query health.

### Data source

All panels query Prometheus-formatted counters, gauges, and histograms exposed at the new `/api/v1/metrics` endpoint registered by `MetricsModule` (`apps/api/src/app/metrics/metrics.controller.ts` per AAP § 0.5.1.2). The dashboard assumes a Prometheus datasource scrapes that endpoint at a stable interval (typically every 15 s); the `datasource.uid` in the JSON definition below is a placeholder (`"Prometheus"`) that operators should reconcile with the UID of their actual provisioned Prometheus datasource (visible in Grafana at **Connections → Data sources → Prometheus → uid**).

A complementary readiness signal is exposed by the new `/api/v1/health/snowflake` probe (implemented in `apps/api/src/app/health/snowflake-health.indicator.ts` per AAP § 0.5.1.2). The probe issues a lightweight `SELECT 1` round-trip against the configured Snowflake account and is suitable for inclusion as a Grafana **Stat** panel referencing a Blackbox-Exporter or HTTP-probe scrape of that route.

### Audience

The intended audience is on-call SREs and platform engineers verifying:

1. **Sync success rate** — the user-facing reliability metric for both cron and event-driven paths. The localhost gate is **≥ 99.5%** (target) with an alert below **99.0%** over a 1-hour window. The dashboard surfaces this ratio as Panel 1, split by the `trigger=cron|event` label so the two paths can fail independently and be diagnosed independently.
2. **Sync latency** — Panel 2 surfaces p50/p95/p99 of total sync duration per run, separately for cron and event-driven invocations. Cron runs (bulk daily mirror) have a higher latency budget (p95 ≤ 30 s) than event-driven runs (single-user, p95 ≤ 5 s) because they touch every user.
3. **Idempotency verification (Rule 7 compliance)** — Panel 3 surfaces MERGE row counts per Snowflake table; operators verify Rule 7 by re-running the sync against the same date range and confirming the counter does NOT increase by an amount that would violate the unique-key cardinality. Because every write is a MERGE keyed on a documented unique constraint, the database itself enforces the row-count invariant; the metric is a passive reporter, not a guarantor.
4. **Cron freshness** — Panel 4 surfaces the most recent cron run timestamp as a gauge. The companion alert `SnowflakeSyncCronStale` fires if the most recent run is older than 25 hours, allowing a 1-hour grace beyond the 24-hour cron interval.
5. **Event-listener volume** — Panel 5 surfaces the per-second rate of `PortfolioChangedEvent`-triggered sync invocations. The existing event listener pattern includes a 5-second debounce (per AAP § 0.4.3 sequence diagram); brief gaps in this counter during high-frequency Order CRUD bursts are expected behavior, not a missed-event alert.
6. **Connection health** — Panel 6 surfaces the count of Snowflake connection errors over a 15-minute window. The companion alert `SnowflakeConnectionFailureBurst` fires at **> 5 errors per 15 minutes** to catch credential rotation, network outages, or warehouse suspension events without false-positiving on the occasional transient error retried by the SDK.
7. **Defense-in-depth (Rule 2 compliance)** — Panel 7 surfaces the bind-variable validation failure counter, which MUST remain at zero in healthy operation. Any non-zero value is a Rule 2 signal — either an attempted SQL injection through the chat agent's `query_history` tool or a code regression that bypassed the bind-variable contract — and is alerted immediately.

### Sibling dashboard distinction

This dashboard observes a **background pipeline** and a **shared read-path utility** (`queryHistory`); the two sibling dashboards observe **synchronous user-facing endpoints**. The latency budgets and alert thresholds therefore differ:

- **`docs/observability/snowflake-sync.md`** (this document) — Background cron and event-driven pipeline. Latency budgets are measured in **seconds** (p95 ≤ 30 s for cron; ≤ 5 s for events). The sync owns the data freshness contract, not the user-facing first-token contract.
- **`docs/observability/ai-chat.md`** — Streaming SSE endpoint. Primary metric is **first-token latency** (p95 ≤ 3 s on localhost per AAP § 0.7.5.2 Chat agent gate).
- **`docs/observability/ai-rebalancing.md`** — Non-streaming JSON endpoint. Primary metric is **total request latency** (p95 ≤ 15 s per the rebalancing engine gate).

When debugging, reach for the dashboard whose primary mode-of-operation matches the issue under investigation. A user complaint about "stale data in the chat agent's `query_history` results" is most often diagnosed from this dashboard (sync freshness, Panel 4) before drilling into the chat dashboard. A user complaint about "the chat is slow" is most often diagnosed from `ai-chat.md` (first-token latency) before checking sync health here.

### Cross-references

- **AAP § 0.7.2 — Observability rule.** Mandates the dashboard template, structured logging with correlation IDs, the `/api/v1/metrics` endpoint, and end-to-end exercise in the local development environment.
- **AAP § 0.7.1.2 — Rule 2 — Parameterized Snowflake Queries.** All Snowflake SQL execution MUST use `snowflake-sdk` bind variables; surfaced in Panel 7.
- **AAP § 0.7.1.7 — Rule 7 — Snowflake Sync Idempotency.** All Snowflake writes are MERGE statements keyed on documented unique constraints; surfaced in Panel 3.
- **AAP § 0.7.5.2 — Snowflake sync gate.** Cron registration must appear in NestJS scheduler logs at startup; running the sync twice for the same date range must leave row counts unchanged across all three tables.

---

## Recommended Panels

The dashboard SHOULD include exactly the following seven panels, in the order documented here. The JSON definition in the [JSON Dashboard Definition](#json-dashboard-definition) section below provides a 1:1 importable mapping.

### Panel 1 — Sync Success Rate

| Field                  | Value                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `timeseries` (single-line ratio, optionally split by `trigger`)                                                                                      |
| **Metric names**       | `snowflake_sync_success_total` (counter) and `snowflake_sync_total` (counter)                                                                        |
| **Example expression** | `sum(rate(snowflake_sync_success_total[5m])) / sum(rate(snowflake_sync_total[5m]))`                                                                  |
| **Thresholds**         | **≥ 99.5% target.** Alert if the 1-hour ratio drops below **99.0%** (`SnowflakeSyncSuccessRateLow`). Yellow band `[0.99, 0.995)`; red band `< 0.99`. |

**Description.** Ratio of successful syncs to total sync attempts, aggregated across both the cron path and the `PortfolioChangedEvent`-driven path. The label `trigger=cron|event` allows operators to split the ratio by invocation source — a cron-path failure with a healthy event-path success rate typically indicates a warehouse suspension or a credential issue affecting the long-running daily run, while an event-path failure with a healthy cron-path indicates a per-request fault (e.g., a bad bind value originating from a specific Order). The 99.5% target tracks the project-level reliability target for the data-freshness contract.

### Panel 2 — Sync Latency (p50 / p95 / p99)

| Field                        | Value                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**               | `timeseries` with p50 / p95 / p99 lines, faceted by `trigger`                                                                                             |
| **Metric name**              | `snowflake_sync_duration_seconds` (histogram)                                                                                                             |
| **Example expression (p95)** | `histogram_quantile(0.95, sum by (le, trigger) (rate(snowflake_sync_duration_seconds_bucket[5m])))`                                                       |
| **Thresholds**               | Cron runs: **p95 ≤ 30 s.** Event-driven runs: **p95 ≤ 5 s.** Alert `SnowflakeSyncLatencyP95High` fires when cron p95 exceeds 30 s for a 15-minute window. |

**Description.** Histogram of total sync duration per run, separately for cron and event-driven invocations (label `trigger=cron|event`). Cron runs touch every user and therefore have a higher latency budget; event-driven runs touch a single user and should complete well within the 5-second user-perception window. Sustained regressions in the cron p95 typically point to warehouse-size mismatches (warehouse too small for the row volume) or to a `SELECT * FROM Order` query plan regression in PostgreSQL upstream of the MERGE; event-path regressions typically point to network latency between the Ghostfolio API process and `<account>.snowflakecomputing.com`.

### Panel 3 — MERGE Row Counts (per table)

| Field                  | Value                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `barchart` (or `timeseries`) labeled by `table`                                                                                                                                                   |
| **Metric name**        | `snowflake_sync_rows_merged_total` (counter, labeled by `table=portfolio_snapshots\|orders_history\|performance_metrics`)                                                                         |
| **Example expression** | `sum by (table) (rate(snowflake_sync_rows_merged_total[5m]))`                                                                                                                                     |
| **Thresholds**         | Informational. Alert if **zero rows merged for any table over 24 h** while the cron is firing — typically captured by combining this panel with Panel 4 (`SnowflakeMergeRowCountZero`, optional). |

**Description.** Per-table counter of rows merged per sync run, split across the three Snowflake tables (`portfolio_snapshots`, `orders_history`, `performance_metrics`). The metric is a passive reporter of MERGE activity — it does NOT distinguish between rows that were INSERTED (new) and rows that were UPDATED (existing). The unique-key constraints `(snapshot_date, user_id, asset_class)`, `(order_id)`, and `(metric_date, user_id)` prevent duplicate rows at the database level, which is what enforces **Rule 7 — Snowflake Sync Idempotency** (AAP § 0.7.1.7). Operators verify Rule 7 by running the sync twice for the same date range and confirming that the cumulative row count visible in Snowflake itself does NOT grow on the second run; this counter is a forensic trail, not the gate.

### Panel 4 — Cron Run Timestamps

| Field                  | Value                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Panel type**         | `stat` (most-recent value) with a sparkline, OR `timeseries` of the seconds-since-last-run derived metric                                        |
| **Metric name**        | `snowflake_sync_cron_last_run_timestamp` (gauge, Unix timestamp seconds)                                                                         |
| **Example expression** | `time() - snowflake_sync_cron_last_run_timestamp` (seconds since last cron run)                                                                  |
| **Thresholds**         | Alert at **> 25 hours** since last run (`SnowflakeSyncCronStale`). The 25-hour threshold leaves a 1-hour grace beyond the 24-hour cron interval. |

**Description.** Timeline of cron execution times confirming the `0 2 * * *` UTC schedule. The gauge is set at the start of every cron invocation by `SnowflakeSyncService` — i.e., the timestamp records when the run started, not when it succeeded. Pair this panel with Panel 1 to distinguish a stale-run problem (cron didn't fire) from a stale-data problem (cron fired but failed); both result in stale data in Snowflake but require different remediation. The cron expression `0 2 * * *` is the standard 5-field syntax used by `@nestjs/schedule` v6 (per AAP § 0.2.3) and is interpreted with `timeZone: 'UTC'`.

### Panel 5 — Event-Listener Invocation Count

| Field                  | Value                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Panel type**         | `timeseries` (single-line counter rate)                                                                                        |
| **Metric name**        | `snowflake_sync_event_invocations_total` (counter)                                                                             |
| **Example expression** | `sum(rate(snowflake_sync_event_invocations_total[5m]))`                                                                        |
| **Thresholds**         | Informational. No specific alert. Operators correlate sustained zeros against Order CRUD volume to detect broken event wiring. |

**Description.** Counter of `PortfolioChangedEvent`-triggered sync invocations emitted by the `@OnEvent` listener on `SnowflakeSyncService`. The existing event-listener pattern (per AAP § 0.4.3 sequence diagram) includes a **5-second debounce** consistent with the precedent in `apps/api/src/events/portfolio-changed.listener.ts` — brief gaps in this counter during high-frequency Order CRUD bursts are expected behavior and do NOT indicate missed events. Sustained zeros while Order CRUD volume (visible in the `activities_*` metrics or in the Postgres `Order` table itself) is non-zero indicate a broken event-emitter wiring, which is a regression in either the upstream `ActivitiesService` emission sites or the listener registration in `SnowflakeSyncModule`.

### Panel 6 — Snowflake Connection Failures

| Field                  | Value                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `timeseries` (single-line counter increase) or `stat` showing the 15-minute increase                                                                                  |
| **Metric name**        | `snowflake_connection_failure_total` (counter, optionally labeled by `error_class`)                                                                                   |
| **Example expression** | `sum(increase(snowflake_connection_failure_total[15m]))`                                                                                                              |
| **Thresholds**         | **Alert at > 5 errors per 15 minutes** (`SnowflakeConnectionFailureBurst`). The 5-per-15-minute threshold is the project-mandated alert threshold for this dashboard. |

**Description.** Counter for connection errors raised by the `snowflake-sdk` driver against the configured Snowflake account (the `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_WAREHOUSE`, and `SNOWFLAKE_SCHEMA` environment variables read exclusively through `ConfigService` per Rule 3 — AAP § 0.7.1.3). The `error_class` label, when populated, distinguishes auth failures (rotated credentials), network failures (DNS / TCP), warehouse-suspension failures (warehouse paused or quota exceeded), and unknown failures. Operators MUST NOT include credential values in any panel description, alert annotation, or runbook link; only the environment-variable names appear here, satisfying the redaction requirement in AAP § 0.7.3 ("Logging redaction").

### Panel 7 — Bind-Variable Validation Failures

| Field                  | Value                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `stat` (current value, RED on non-zero) or `timeseries` of the 1-hour increase                                                                                                                      |
| **Metric name**        | `snowflake_bind_validation_failure_total` (counter)                                                                                                                                                 |
| **Example expression** | `sum(increase(snowflake_bind_validation_failure_total[1h]))`                                                                                                                                        |
| **Thresholds**         | **Alert immediately on any non-zero value over 5 minutes** (`SnowflakeBindValidationFailureNonzero`). Defense-in-depth — the value should be 0 in healthy operation per **Rule 2** (AAP § 0.7.1.2). |

**Description.** Counter for SQL parsing failures detected by the defense-in-depth check in `SnowflakeSyncService.queryHistory(...)` that rejects any `sql` containing `;` outside string literals (per AAP § 0.5.1.5 — chat-agent `query_history` tool). The check is a belt-and-braces complement to the primary Rule 2 enforcement: all SQL execution sites in `SnowflakeSyncService` use bind-variable syntax (`?` placeholders + `binds: [...]`), so the only way for raw SQL to reach the database is through the chat-agent tool path, where Claude supplies a `sql` string at request time. The counter should be **0** in healthy operation; any non-zero value indicates either an attempted SQL injection through the chat agent or a code regression that bypassed the bind-variable contract. The corresponding alert (`SnowflakeBindValidationFailureNonzero`) fires immediately because the failure mode is binary and operator attention is required.

---

## Alert Rules

The following Prometheus alert rules are recommended. They map 1:1 to the panel thresholds documented above. Operators can drop the YAML block below into a Prometheus rules file (e.g., `prometheus/rules/snowflake-sync.yml`) and reload Prometheus.

```yaml
groups:
  - name: ghostfolio-snowflake-sync
    interval: 30s
    rules:
      - alert: SnowflakeSyncSuccessRateLow
        expr: |
          (
            sum(rate(snowflake_sync_success_total[1h]))
            /
            sum(rate(snowflake_sync_total[1h]))
          ) < 0.99
        for: 1h
        labels:
          severity: warning
          team: platform
          feature: snowflake-sync
        annotations:
          summary: 'Snowflake sync success rate below 99% over the last hour'
          description: |
            The 1-hour success ratio of snowflake_sync_success_total to
            snowflake_sync_total is currently {{ $value | humanizePercentage }},
            below the 99% alerting threshold. The project target is ≥ 99.5%
            (Panel 1). Inspect the trigger label to identify whether the cron
            path or the event-driven path is failing, then correlate with
            Panel 6 (connection failures) and the most recent cron run gauge
            (Panel 4). Cross-reference: AAP § 0.7.5.2 Snowflake sync gate.
          runbook_url: 'docs/observability/snowflake-sync.md#panel-1--sync-success-rate'

      - alert: SnowflakeSyncLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(snowflake_sync_duration_seconds_bucket{trigger="cron"}[15m]))
          ) > 30
        for: 15m
        labels:
          severity: warning
          team: platform
          feature: snowflake-sync
        annotations:
          summary: 'Snowflake cron sync p95 latency above 30 s for 15 minutes'
          description: |
            The 95th percentile of snowflake_sync_duration_seconds for
            trigger=cron is currently {{ $value | humanizeDuration }},
            exceeding the 30 s alerting threshold for 15 minutes. The
            event-driven path is alerted separately on its own 5 s budget.
            Investigate warehouse sizing in Snowflake, the row volume of the
            most recent run (Panel 3), and the upstream Postgres query plan
            for Order / portfolio reads.
          runbook_url: 'docs/observability/snowflake-sync.md#panel-2--sync-latency-p50--p95--p99'

      - alert: SnowflakeConnectionFailureBurst
        expr: |
          sum(increase(snowflake_connection_failure_total[15m])) > 5
        for: 5m
        labels:
          severity: warning
          team: platform
          feature: snowflake-sync
        annotations:
          summary: 'More than 5 Snowflake connection failures in 15 minutes'
          description: |
            snowflake_connection_failure_total has incremented by more than 5
            over the last 15 minutes. This typically indicates rotated or
            revoked credentials (verify SNOWFLAKE_USER / SNOWFLAKE_PASSWORD
            via ConfigService propagation), a paused or quota-exceeded
            warehouse (verify SNOWFLAKE_WAREHOUSE), or transient network
            issues against <account>.snowflakecomputing.com. Group by
            error_class to identify the dominant failure mode. Credentials
            are redacted from logs per AAP § 0.7.3.
          runbook_url: 'docs/observability/snowflake-sync.md#panel-6--snowflake-connection-failures'

      - alert: SnowflakeBindValidationFailureNonzero
        expr: |
          sum(increase(snowflake_bind_validation_failure_total[5m])) > 0
        for: 0m
        labels:
          severity: critical
          team: platform
          feature: snowflake-sync
        annotations:
          summary: 'Snowflake bind-variable validation failed (Rule 2 violation)'
          description: |
            snowflake_bind_validation_failure_total is non-zero. This is the
            defense-in-depth signal for Rule 2 — Parameterized Snowflake
            Queries (AAP § 0.7.1.2). Either an attempted SQL injection has
            been blocked at the chat agent's query_history tool boundary, or
            a code regression has bypassed the bind-variable contract.
            Inspect the most recent application logs for the rejected sql
            payload (the bind values are redacted; only the structural
            failure is logged) and review recent changes to
            SnowflakeSyncService.queryHistory or to AiChatService tool
            dispatch. This alert fires immediately (no for: window) because
            the failure mode is binary.
          runbook_url: 'docs/observability/snowflake-sync.md#panel-7--bind-variable-validation-failures'

      - alert: SnowflakeSyncCronStale
        expr: |
          (time() - snowflake_sync_cron_last_run_timestamp) > 90000
        for: 10m
        labels:
          severity: warning
          team: platform
          feature: snowflake-sync
        annotations:
          summary: 'Most recent Snowflake cron run is older than 25 hours'
          description: |
            The gauge snowflake_sync_cron_last_run_timestamp has not been
            updated in more than 25 hours (90000 seconds). The cron is
            scheduled at 0 2 * * * UTC (per AAP § 0.7.3) so the expected
            interval is 24 hours; the 25-hour threshold leaves a 1-hour
            grace. Inspect NestJS scheduler logs for cron registration at
            startup (per AAP § 0.7.5.2 Snowflake sync gate) and verify that
            ScheduleModule.forRoot() is still imported in AppModule.
          runbook_url: 'docs/observability/snowflake-sync.md#panel-4--cron-run-timestamps'
```

Severity guidance:

- **`critical`** — paging severity. Rule 2 has been violated (`SnowflakeBindValidationFailureNonzero`). The application has either blocked an injection attempt or shipped a regression; either way, immediate operator attention is required.
- **`warning`** — non-paging severity. The pipeline is degraded but still serving requests; investigate during business hours unless the trend continues or compounds with other alerts.

---

## Local Development Verification

The AAP § 0.7.2 Observability rule mandates that observability MUST be exercised in the local development environment. The following seven-step checklist walks an operator through that verification end-to-end.

1. **Start the local Ghostfolio API.** A working Postgres + Redis stack is required (e.g., `docker compose -f docker/docker-compose.dev.yml up -d`). Then start the API process:

   ```sh
   npm run start:api
   ```

   The Nx process should report `🚀 Application is running on: http://localhost:3333/api`. The `/api/v1` URI version is configured globally in `apps/api/src/main.ts`, so all routes documented below resolve under that prefix. NestJS scheduler logs should additionally report registration of the `snowflake-daily-sync` cron at the `0 2 * * *` UTC schedule (per AAP § 0.7.5.2 Snowflake sync gate).

2. **Confirm the metrics endpoint returns 200.** The metrics registry from `MetricsModule` (per AAP § 0.5.1.2) emits Prometheus-formatted counters and histograms:

   ```sh
   curl -i http://localhost:3333/api/v1/metrics
   ```

   Expect `HTTP/1.1 200 OK` and a body containing one `# HELP` / `# TYPE` line per metric followed by the metric samples. At first start (before any sync run), the Snowflake sync counters will all read zero — that is expected.

3. **Confirm the Snowflake health probe returns 200.** The probe is implemented in `apps/api/src/app/health/snowflake-health.indicator.ts` per AAP § 0.5.1.2 and issues a lightweight `SELECT 1` round-trip against the configured Snowflake account using bind-variable syntax (Rule 2):

   ```sh
   curl -i http://localhost:3333/api/v1/health/snowflake
   ```

   Expect `HTTP/1.1 200 OK` with a body of the form `{"status":"up","details":{"snowflake":{"status":"up"}}}`. If the probe returns 503, verify that all six `SNOWFLAKE_*` environment variables (`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_SCHEMA`) are set in `.env` (development) and resolved through `ConfigService` at boot (per Rule 3 — AAP § 0.7.1.3). Credentials MUST NOT be echoed to the terminal at any point during this step.

4. **Trigger a manual sync via the admin endpoint.** The admin-only `POST /api/v1/snowflake-sync/trigger` route invokes the same MERGE pipeline as the cron path. Substitute `<jwt>` with a JWT obtained from the Ghostfolio login flow as a user with the `triggerSnowflakeSync` permission (AAP § 0.4.1.1):

   ```sh
   curl -i -X POST http://localhost:3333/api/v1/snowflake-sync/trigger \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

   Expect `HTTP/1.1 200 OK`. Re-fetch `/api/v1/metrics` and confirm:
   - `snowflake_sync_total{trigger="cron"}` has incremented by 1 (the manual trigger uses the cron pipeline by convention).
   - `snowflake_sync_success_total{trigger="cron"}` has incremented by 1.
   - `snowflake_sync_rows_merged_total{table="..."}` has incremented for at least one of the three tables (depending on whether sample data exists locally).
   - `snowflake_sync_duration_seconds_count` has incremented by 1.

5. **Trigger an Order create event to exercise the `PortfolioChangedEvent` listener path.** Issue a `POST /api/v1/order` with a valid Order body (or use the existing Ghostfolio UI to add an activity) and confirm the listener path activates. The `PortfolioChangedEvent` is already emitted by `apps/api/src/app/activities/activities.service.ts` on every Order CRUD operation (lines 92, 235, 244, 270, 318, 900). After the 5-second debounce window (per AAP § 0.4.3), re-fetch `/api/v1/metrics` and confirm:

   ```sh
   curl -s http://localhost:3333/api/v1/metrics | grep -E '^snowflake_sync_(event_invocations|total|success_total)'
   ```

   - `snowflake_sync_event_invocations_total` has incremented by 1.
   - `snowflake_sync_total{trigger="event"}` has incremented by 1.
   - `snowflake_sync_success_total{trigger="event"}` has incremented by 1.

6. **Re-run the manual sync to verify Rule 7 idempotency.** Execute the curl from step 4 a second time without changing anything else. The `snowflake_sync_rows_merged_total` counter will increment again (because each MERGE statement reports its row activity), but the **cumulative row count visible in Snowflake itself MUST NOT increase**. The unique-key constraints `(snapshot_date, user_id, asset_class)` on `portfolio_snapshots`, `(order_id)` on `orders_history`, and `(metric_date, user_id)` on `performance_metrics` (per AAP § 0.5.1.1) prevent duplicate rows at the database level — this is the database-enforced backbone of **Rule 7 — Snowflake Sync Idempotency** (AAP § 0.7.1.7). Verify by issuing a `SELECT COUNT(*)` against each of the three tables in the Snowflake console before and after step 6 and confirming the counts are identical.

7. **Import the JSON dashboard definition into a local Grafana.** Open Grafana at `http://localhost:3000`, navigate to **Dashboards → New → Import**, paste the JSON block from the [JSON Dashboard Definition](#json-dashboard-definition) section below, select the Prometheus datasource that scrapes `/api/v1/metrics`, and click **Import**. Confirm that all seven panels render data after a few minutes of scrape activity (the panels will appear empty until at least one scrape interval after steps 4–6).

After completing all seven steps, the dashboard is verified end-to-end against the local development environment, satisfying the AAP § 0.7.2 mandate.

---

## JSON Dashboard Definition

The following JSON is a complete, self-contained Grafana dashboard definition mapping 1:1 to the seven Recommended Panels above. It can be imported into a stock Grafana 9+ instance via **Dashboards → New → Import → Paste JSON**. The `datasource.uid` placeholder of `"Prometheus"` should be reconciled with the UID of the Prometheus datasource provisioned in your Grafana instance (visible at **Connections → Data sources → Prometheus → uid**).

```json
{
  "title": "Ghostfolio — Snowflake Sync Layer",
  "uid": "gf-snowflake-sync",
  "schemaVersion": 38,
  "version": 1,
  "editable": true,
  "graphTooltip": 1,
  "tags": [
    "ghostfolio",
    "snowflake-sync",
    "observability",
    "snowflake",
    "cron"
  ],
  "time": { "from": "now-6h", "to": "now" },
  "refresh": "30s",
  "annotations": { "list": [] },
  "templating": {
    "list": [
      {
        "name": "trigger",
        "label": "Trigger Type",
        "type": "query",
        "query": "label_values(snowflake_sync_total, trigger)",
        "datasource": { "type": "prometheus", "uid": "Prometheus" },
        "refresh": 1,
        "multi": true,
        "includeAll": true,
        "current": { "selected": true, "text": "All", "value": "$__all" }
      }
    ]
  },
  "panels": [
    {
      "id": 1,
      "title": "Sync Success Rate",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "description": "Ratio of successful syncs to total sync attempts (cron + event-driven). Target ≥ 99.5%; alert below 99.0% over a 1-hour window. AAP § 0.7.5.2.",
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "min": 0,
          "max": 1,
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "red", "value": null },
              { "color": "yellow", "value": 0.99 },
              { "color": "green", "value": 0.995 }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "legend": { "displayMode": "table", "placement": "bottom" },
        "tooltip": { "mode": "multi" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum(rate(snowflake_sync_success_total[5m])) / sum(rate(snowflake_sync_total[5m]))",
          "legendFormat": "overall success rate"
        },
        {
          "refId": "B",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum by (trigger) (rate(snowflake_sync_success_total[5m])) / sum by (trigger) (rate(snowflake_sync_total[5m]))",
          "legendFormat": "{{trigger}} success rate"
        }
      ]
    },
    {
      "id": 2,
      "title": "Sync Latency (p50 / p95 / p99) by Trigger",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "description": "Histogram of total sync duration per run, faceted by trigger. Cron runs: p95 ≤ 30 s. Event-driven runs: p95 ≤ 5 s.",
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
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
      "options": {
        "legend": { "displayMode": "table", "placement": "bottom" },
        "tooltip": { "mode": "multi" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.50, sum by (le, trigger) (rate(snowflake_sync_duration_seconds_bucket[5m])))",
          "legendFormat": "p50 {{trigger}}"
        },
        {
          "refId": "B",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.95, sum by (le, trigger) (rate(snowflake_sync_duration_seconds_bucket[5m])))",
          "legendFormat": "p95 {{trigger}}"
        },
        {
          "refId": "C",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.99, sum by (le, trigger) (rate(snowflake_sync_duration_seconds_bucket[5m])))",
          "legendFormat": "p99 {{trigger}}"
        }
      ]
    },
    {
      "id": 3,
      "title": "MERGE Row Counts (per table)",
      "type": "barchart",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "description": "Per-table counter of rows merged per sync run across portfolio_snapshots, orders_history, performance_metrics. Idempotency (Rule 7) is enforced by the unique-key constraints in Snowflake, not by this counter.",
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "custom": { "lineWidth": 1, "fillOpacity": 80 }
        },
        "overrides": []
      },
      "options": {
        "orientation": "horizontal",
        "showValue": "auto",
        "legend": { "displayMode": "table", "placement": "bottom" },
        "tooltip": { "mode": "single" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum by (table) (rate(snowflake_sync_rows_merged_total[5m]))",
          "legendFormat": "{{table}}"
        }
      ]
    },
    {
      "id": 4,
      "title": "Cron Run Freshness (seconds since last run)",
      "type": "stat",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "description": "Time elapsed since the last cron run started. Cron schedule: 0 2 * * * UTC (AAP § 0.7.3). Alert at > 25 hours.",
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 86400 },
              { "color": "red", "value": 90000 }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "reduceOptions": {
          "calcs": ["lastNotNull"],
          "fields": "",
          "values": false
        },
        "orientation": "auto",
        "textMode": "auto",
        "colorMode": "value",
        "graphMode": "area",
        "justifyMode": "auto"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "time() - snowflake_sync_cron_last_run_timestamp",
          "legendFormat": "seconds since last cron run"
        }
      ]
    },
    {
      "id": 5,
      "title": "Event-Listener Invocations",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
      "description": "Counter of PortfolioChangedEvent-triggered sync invocations. Note: 5-second debounce per AAP § 0.4.3 — brief gaps during high-frequency Order CRUD bursts are expected.",
      "fieldConfig": {
        "defaults": {
          "unit": "ops",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 }
        },
        "overrides": []
      },
      "options": {
        "legend": { "displayMode": "table", "placement": "bottom" },
        "tooltip": { "mode": "multi" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum(rate(snowflake_sync_event_invocations_total[5m]))",
          "legendFormat": "event invocations/s"
        }
      ]
    },
    {
      "id": 6,
      "title": "Snowflake Connection Failures (15 m increase)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 16 },
      "description": "Counter for connection errors against the configured Snowflake account. Alert at > 5 errors per 15 minutes. Credentials are read exclusively through ConfigService (Rule 3).",
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 1 },
              { "color": "red", "value": 5 }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "legend": { "displayMode": "table", "placement": "bottom" },
        "tooltip": { "mode": "multi" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum(increase(snowflake_connection_failure_total[15m]))",
          "legendFormat": "total errors / 15 m"
        },
        {
          "refId": "B",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum by (error_class) (increase(snowflake_connection_failure_total[15m]))",
          "legendFormat": "{{error_class}} / 15 m"
        }
      ]
    },
    {
      "id": 7,
      "title": "Bind-Variable Validation Failures (Rule 2)",
      "type": "stat",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 24 },
      "description": "Defense-in-depth counter for SQL parsing failures detected by SnowflakeSyncService.queryHistory. MUST remain 0 in healthy operation per Rule 2 (AAP § 0.7.1.2). Alert immediately on any non-zero value.",
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "red", "value": 1 }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "reduceOptions": {
          "calcs": ["lastNotNull"],
          "fields": "",
          "values": false
        },
        "orientation": "auto",
        "textMode": "auto",
        "colorMode": "background",
        "graphMode": "area",
        "justifyMode": "auto"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum(increase(snowflake_bind_validation_failure_total[1h]))",
          "legendFormat": "validation failures / 1 h"
        }
      ]
    }
  ]
}
```

---

## References

- **AAP § 0.7.2 — Observability rule.** The application is not complete until it is observable. Every deliverable MUST include structured logging with correlation IDs, distributed tracing, a metrics endpoint, health/readiness checks, a dashboard template, and local-environment exercise of all of the above.
- **AAP § 0.7.1.7 — Rule 7 — Snowflake Sync Idempotency.** All Snowflake write operations in `SnowflakeSyncService` MUST use MERGE (upsert) statements keyed on the unique constraints documented in AAP § 0.5.1.1. Running the sync twice for the same date range MUST leave row counts unchanged. Panel 3 of this dashboard is the operational reporter for Rule 7.
- **AAP § 0.7.1.2 — Rule 2 — Parameterized Snowflake Queries.** All Snowflake SQL execution MUST use `snowflake-sdk` bind variable syntax (`?` placeholders + `binds: [...]`). String template literals and concatenation operators adjacent to SQL strings are PROHIBITED. Panel 7 of this dashboard is the defense-in-depth telemetry for Rule 2.
- **AAP § 0.7.5.2 — Snowflake sync gate.** Cron registration must appear in NestJS scheduler logs at startup; an Order create event must trigger the sync within the same request lifecycle (allowing for the listener debounce window); running the sync twice for the same date range must leave row counts unchanged across all three Snowflake tables. Panel 1 (success rate), Panel 4 (cron freshness), and Panel 5 (event invocations) collectively cover the gate.
- **`apps/api/src/app/snowflake-sync/snowflake-sync.service.ts` — metric emission sites.** The `SnowflakeSyncService` is responsible for emitting `snowflake_sync_total`, `snowflake_sync_success_total`, `snowflake_sync_duration_seconds`, `snowflake_sync_rows_merged_total`, `snowflake_sync_cron_last_run_timestamp`, `snowflake_sync_event_invocations_total`, `snowflake_connection_failure_total`, and `snowflake_bind_validation_failure_total` via the injected `MetricsService`.
- **`apps/api/src/app/metrics/metrics.controller.ts` — metrics endpoint.** Exposes the in-process metrics registry as Prometheus-format text at `GET /api/v1/metrics`. Created per AAP § 0.5.1.2 alongside `MetricsModule` and `MetricsService`.
- **`apps/api/src/app/health/snowflake-health.indicator.ts` — health probe.** Exposes a readiness probe at `GET /api/v1/health/snowflake` registered additively in `HealthModule`. Issues a lightweight `SELECT 1` round-trip using bind-variable syntax (Rule 2). Created per AAP § 0.5.1.2.

### Sibling dashboard templates

- **`docs/observability/ai-chat.md`** — Feature B (`AiChatModule`) streaming `POST /api/v1/ai/chat` SSE metrics: first-token latency (primary), input/output token throughput, tool-call distribution, SSE error rate, and the personalization fetch latency that feeds the per-request system prompt.
- **`docs/observability/ai-rebalancing.md`** — Feature C (`RebalancingModule`) non-streaming `POST /api/v1/ai/rebalancing` metrics: total request latency (primary), recommendation count per response, warnings rate, and structured-output validation failures (Rule 4).
