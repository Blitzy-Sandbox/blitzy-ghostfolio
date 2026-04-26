# Explainable Rebalancing Engine — Observability Dashboard Template

## Overview

This document is the canonical Grafana dashboard template for **Feature C — Explainable Rebalancing Engine (`RebalancingModule`)**, the non-streaming `POST /api/v1/ai/rebalancing` endpoint introduced by the Agent Action Plan. It satisfies the project-level **Observability** rule recorded in AAP § 0.7.2 (every deliverable MUST include structured logging with correlation IDs, distributed tracing, a metrics endpoint, health/readiness checks, and a dashboard template — and that observability MUST be exercisable in the local development environment).

### Feature being observed

The dashboard observes the entire request lifecycle of `POST /api/v1/ai/rebalancing`:

- The endpoint is implemented in `RebalancingController` (`apps/api/src/app/rebalancing/rebalancing.controller.ts`) and `RebalancingService` (`apps/api/src/app/rebalancing/rebalancing.service.ts`).
- The service constructs an Anthropic Claude client via the `@anthropic-ai/sdk` package and invokes `client.messages.create({...})` — **NOT** `messages.stream({...})` — so that the response is delivered as a single JSON payload after the model has finished producing the structured output. This makes the endpoint **NON-STREAMING** — distinct from the streaming chat endpoint documented in `ai-chat.md`, which uses `messages.stream({...})` and emits Server-Sent Events.
- The service supplies a single-element `tools` array describing the `rebalancing_recommendations` tool whose `input_schema` matches the `RebalancingResponse` interface verbatim (per AAP § 0.1.2.4), and forces invocation via `tool_choice: { type: 'tool', name: 'rebalancing_recommendations' }`.
- Per **Rule 4 — Structured Rebalancing via Tool Use** (AAP § 0.7.1.4), `RebalancingService` populates `RebalancingResponse` **exclusively** from a `tool_use` content block returned by the Anthropic SDK. Parsing Claude's `text` message content to extract structured fields is **PROHIBITED**. When the SDK returns a response without a `tool_use` block, the service throws `BadGatewayException` and emits the `ai_rebalancing_tool_use_validation_failure_total` counter — there is **no** text-parsing fallback.
- Each recommendation in the response array MUST include a non-empty `rationale` and a non-empty `goalReference` mapping to a `FinancialProfile` field name or to a label inside the JSON `investmentGoals` array (per AAP § 0.7.5.2 Rebalancing engine gate). Empty `goalReference` values indicate prompt drift or model regression and are surfaced as a quality metric in Panel 5.
- The service injects `PortfolioService` (for the current allocation snapshot) and `UserFinancialProfileService` (for goal data referenced in each `goalReference`); their read latency contributes to total request latency.

### Data source

All panels query Prometheus-formatted counters and histograms exposed at the new `/api/v1/metrics` endpoint registered by `MetricsModule` (`apps/api/src/app/metrics/metrics.controller.ts` per AAP § 0.5.1.2). The dashboard assumes a Prometheus datasource scrapes that endpoint at a stable interval (typically every 15 s); the `datasource.uid` in the JSON definition below is a placeholder (`"Prometheus"`) that operators should reconcile with the UID of their actual provisioned Prometheus datasource.

### Audience

The intended audience is on-call SREs and product reviewers verifying:

1. **Total request latency** — the user-facing performance metric for non-streaming endpoints. Because the rebalancing endpoint does not stream tokens, the user perceives the entire wait between submitting the request and seeing the recommendation list. Panel 1 surfaces p50/p95/p99 quantiles of this distribution.
2. **Correctness (Rule 4 compliance)** — Panel 4 surfaces the `ai_rebalancing_tool_use_validation_failure_total` counter, which MUST remain at zero in healthy operation. Any non-zero value is a Rule 4 violation and is alerted immediately.
3. **Quality (`goalReference` non-empty rate)** — Panel 5 surfaces the percentage of returned recommendations whose `goalReference` field is non-empty, targeted at 100% (per AAP § 0.7.5.2). A drop below 100% signals the model has stopped honoring the explainability requirement.
4. **Recommendation count distribution** — Panel 2 surfaces the histogram of how many recommendations Claude produces per call, useful for catching prompt regressions where the model returns empty or excessive arrays.
5. **Warnings rate** — Panel 3 surfaces the average number of warnings emitted per response, alerted when the ratio exceeds 0.5 warnings per recommendation.
6. **Anthropic API health** — Panel 6 surfaces post-retry Anthropic SDK errors by class (`rate_limit`, `auth`, `timeout`, `5xx`, `4xx`, `unknown`); the readiness probe at `GET /api/v1/health/anthropic` (implemented in `apps/api/src/app/health/anthropic-health.indicator.ts` per AAP § 0.5.1.2) is a configuration probe that does not consume API tokens and can be referenced alongside this panel.

### Streaming vs. non-streaming distinction

This dashboard's primary user-facing latency metric is **total request latency** (Panel 1), measured from request receipt to JSON response emission. The endpoint is non-streaming because a structured `tool_use` content block is only emitted by Claude after the model has completed its reasoning; there is no intermediate output to surface.

By contrast, the chat dashboard (`docs/observability/ai-chat.md`) uses **first-token latency** as its primary metric because that endpoint streams Server-Sent Events token-by-token. When debugging, reach for the dashboard whose primary latency metric matches the endpoint's transport. Cross-references: AAP § 0.7.2 (Observability rule), AAP § 0.7.5.2 (Rebalancing engine gate), AAP § 0.7.1.4 (Rule 4 — Structured Rebalancing via Tool Use), AAP § 0.7.3 (Rate-limiting and back-off — the Anthropic SDK has built-in retries; this dashboard counts the post-retry failure surface).

---

## Recommended Panels

The dashboard SHOULD include exactly the following six panels, in the order documented here. The JSON definition in the [JSON Dashboard Definition](#json-dashboard-definition) section below provides a 1:1 importable mapping.

### Panel 1 — Rebalancing Latency

| Field                        | Value                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Panel type**               | `timeseries` with p50 / p95 / p99 lines                                                                    |
| **Metric name**              | `ai_rebalancing_request_duration_seconds` (histogram)                                                      |
| **Example expression (p95)** | `histogram_quantile(0.95, sum by (le) (rate(ai_rebalancing_request_duration_seconds_bucket[5m])))`         |
| **Thresholds**               | p50 ≤ 6 s; p95 ≤ 15 s; p99 ≤ 30 s. Alert if p95 exceeds 20 s for 10 minutes (`RebalancingLatencyP95High`). |

**Description.** Histogram of total `POST /api/v1/ai/rebalancing` response time, measured from request receipt to JSON response emission. Includes the Anthropic API roundtrip latency (the dominant component, since `messages.create` blocks until the full structured output is produced), plus the `PortfolioService` allocation read and the `UserFinancialProfileService` goal read that build the system prompt. Because this endpoint is non-streaming, this metric is the primary user-facing latency signal — there is no intermediate first-token signal to surface.

### Panel 2 — Recommendation Count Distribution

| Field                           | Value                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**                  | `histogram` (or `barchart` over the histogram buckets)                                                                                                                                                                    |
| **Metric name**                 | `ai_rebalancing_recommendations_count` (histogram, with buckets at 0, 1, 2, 5, 10, 20)                                                                                                                                    |
| **Example expression (median)** | `histogram_quantile(0.5, sum by (le) (rate(ai_rebalancing_recommendations_count_bucket[1h])))`                                                                                                                            |
| **Thresholds**                  | Informational. Alert if the median is consistently 0 over a 1-hour window (`RebalancingEmptyRecommendations`) — the model returning empty arrays suggests a prompt regression or that `tool_choice` is not being honored. |

**Description.** Histogram of how many recommendations Claude returns per call (the length of the `recommendations` array in `RebalancingResponse`). Useful for spotting prompt regressions where Claude returns empty arrays (a sign that `tool_choice` is being silently ignored or the model has decided every position is already balanced) or excessive arrays (a sign that the system prompt is no longer constraining the recommendation count). The bucket boundaries (0, 1, 2, 5, 10, 20) are calibrated for portfolios of up to a few dozen positions; revise upward if your typical user holds significantly more.

### Panel 3 — Warnings Rate

| Field                  | Value                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `timeseries` (single-line ratio)                                                                                                                                                                                 |
| **Metric names**       | `ai_rebalancing_warnings_total` (counter), `ai_rebalancing_recommendations_total` (counter)                                                                                                                      |
| **Example expression** | `sum(rate(ai_rebalancing_warnings_total[5m])) / sum(rate(ai_rebalancing_recommendations_total[5m]))`                                                                                                             |
| **Thresholds**         | Alert if average **warnings per recommendation > 0.5** over a 30-minute window (`RebalancingWarningsRateHigh`). The 0.5-per-recommendation threshold is the project-mandated alert threshold for this dashboard. |

**Description.** Average number of `warnings[]` array entries emitted per recommendation. The `warnings` field of `RebalancingResponse` carries plain-language caveats Claude attaches to its output (e.g., "current allocation deviates significantly from the user's stated risk tolerance" or "tax implications not modeled"). A high ratio indicates either constrained portfolios where the model has many caveats to surface, or prompt drift where the model has begun emitting warnings inappropriately. The **0.5 warnings/recommendation alert threshold** is enforced by the `RebalancingWarningsRateHigh` rule below.

### Panel 4 — Tool-Use Validation Failures

| Field                  | Value                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Panel type**         | `stat` (single big number with red threshold) plus a `timeseries` overlay for trend                                                                                      |
| **Metric name**        | `ai_rebalancing_tool_use_validation_failure_total` (counter)                                                                                                             |
| **Example expression** | `sum(increase(ai_rebalancing_tool_use_validation_failure_total[15m]))`                                                                                                   |
| **Thresholds**         | Target value: **0**. Alert immediately on any non-zero value over a 5-minute window (`RebalancingToolUseValidationFailure`) — Rule 4 baseline metric, MUST stay at zero. |

**Description.** Counter for `BadGatewayException` events thrown when the Anthropic SDK returns a response without a `tool_use` content block, in violation of **Rule 4 — Structured Rebalancing via Tool Use** (AAP § 0.7.1.4). The service does **not** fall back to text parsing — Rule 4 explicitly prohibits parsing Claude's text message content to extract structured fields. Non-zero values on this counter indicate one of three failure modes: (1) an upstream Anthropic regression where the model has begun returning text-only responses to tool-call requests; (2) a model that has stopped honoring the `tool_choice: { type: 'tool', name: 'rebalancing_recommendations' }` constraint; or (3) a service-side bug where the tool schema has drifted from the validation logic. Every non-zero increment is a Rule 4 violation that warrants immediate investigation.

### Panel 5 — `goalReference` Non-Empty Rate

| Field                  | Value                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `gauge` (with red < 99%, yellow < 100%, green = 100%) plus a `timeseries` overlay for trend                                                  |
| **Metric name**        | `ai_rebalancing_recommendations_total` (counter, with label `goal_reference_status="present"\|"empty"`)                                      |
| **Example expression** | `sum(rate(ai_rebalancing_recommendations_total{goal_reference_status="present"}[5m])) / sum(rate(ai_rebalancing_recommendations_total[5m]))` |
| **Thresholds**         | **Target: 100%** (per AAP § 0.7.5.2). Alert if the ratio drops below **99%** over a 1-hour window (`RebalancingGoalReferenceMissing`).       |

**Description.** Validation counter ensuring every recommendation includes a non-empty `goalReference` field — the explainability hook that maps each `BUY`/`SELL`/`HOLD` recommendation back to a `FinancialProfile` field name (e.g., `retirementTargetAge`, `monthlyIncome`) or to a label inside the JSON `investmentGoals` array. Per the AAP § 0.7.5.2 Rebalancing engine gate, **every item in `recommendations` MUST have a non-empty `rationale` and `goalReference`**; the **100% target** on this panel is the runtime expression of that gate. A drop below 100% indicates the model is omitting the field — a Rule violation that warrants prompt remediation. The `goal_reference_status` label is set by `RebalancingService` at metric-emission time, immediately after the structured response is read from the `tool_use` content block and before the response is returned to the controller.

### Panel 6 — Anthropic API Error Rate

| Field                  | Value                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `timeseries` (stacked by `error_class`)                                                                                                                                                                                                                           |
| **Metric name**        | `ai_rebalancing_anthropic_api_error_total` (counter, with label `error_class=rate_limit\|auth\|timeout\|5xx\|4xx\|unknown`)                                                                                                                                       |
| **Example expression** | `sum by (error_class) (rate(ai_rebalancing_anthropic_api_error_total[5m]))`                                                                                                                                                                                       |
| **Thresholds**         | Alert if any single class exceeds **1 error/min** averaged over 5 minutes; alert **immediately** on `auth` errors (`RebalancingAnthropicAuthError`) — `auth` errors imply the `ANTHROPIC_API_KEY` has been rotated, revoked, or never propagated to this replica. |

**Description.** Counter for upstream Anthropic API errors classified by error type. The Anthropic SDK has built-in retries with exponential backoff (per AAP § 0.7.3 — "Rate-limiting and back-off"); the new code **does not** add additional retry wrappers to avoid double-retry storms. This metric counts the **post-retry** failure surface visible to the application — i.e., the errors that the SDK was unable to recover from internally. The classes are: `rate_limit` (HTTP 429 after retries), `auth` (HTTP 401/403 — the `ANTHROPIC_API_KEY` is invalid), `timeout` (the SDK gave up waiting), `5xx` (Anthropic server-side errors after retries), `4xx` (other client-side errors), and `unknown` (catch-all for unexpected exceptions thrown by the SDK).

---

## Alert Rules

The following Prometheus alert rules are recommended. They map 1:1 to the panel thresholds documented above. Operators can drop the YAML block below into a Prometheus rules file (e.g., `prometheus/rules/ai-rebalancing.yml`) and reload Prometheus.

```yaml
groups:
  - name: ghostfolio-ai-rebalancing
    interval: 30s
    rules:
      - alert: RebalancingLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(ai_rebalancing_request_duration_seconds_bucket[5m]))
          ) > 20
        for: 10m
        labels:
          severity: warning
          team: platform
          feature: ai-rebalancing
        annotations:
          summary: 'AI Rebalancing total latency p95 above 20 s for 10 minutes'
          description: |
            The 95th percentile of ai_rebalancing_request_duration_seconds is
            currently {{ $value | humanizeDuration }}, exceeding the 20 s alerting
            threshold for 10 minutes. Because this endpoint is non-streaming
            (messages.create, single JSON response), this is the primary
            user-facing latency signal. Inspect the Anthropic API health probe at
            /api/v1/health/anthropic and Panel 6 (Anthropic API error rate) for
            upstream issues; correlate with PortfolioService and
            UserFinancialProfileService read latency for downstream issues.
          runbook_url: 'docs/observability/ai-rebalancing.md#panel-1--rebalancing-latency'

      - alert: RebalancingToolUseValidationFailure
        expr: |
          sum(increase(ai_rebalancing_tool_use_validation_failure_total[5m])) > 0
        for: 0m
        labels:
          severity: critical
          team: platform
          feature: ai-rebalancing
        annotations:
          summary: 'AI Rebalancing returned a response without a tool_use content block (Rule 4 violation)'
          description: |
            One or more requests to POST /api/v1/ai/rebalancing returned a
            response from the Anthropic SDK without the required tool_use
            content block. RebalancingService threw BadGatewayException as
            mandated by Rule 4 (AAP § 0.7.1.4) — the service does NOT fall
            back to text parsing. Investigate whether the model has stopped
            honoring tool_choice: { type: 'tool', name: 'rebalancing_recommendations' },
            whether the tool input_schema has drifted, or whether an upstream
            Anthropic regression is at play. This counter MUST stay at zero
            in healthy operation; this alert fires immediately (no for: window)
            because every increment is a Rule violation.
          runbook_url: 'docs/observability/ai-rebalancing.md#panel-4--tool-use-validation-failures'

      - alert: RebalancingGoalReferenceMissing
        expr: |
          (
            sum(rate(ai_rebalancing_recommendations_total{goal_reference_status="present"}[1h]))
            /
            sum(rate(ai_rebalancing_recommendations_total[1h]))
          ) < 0.99
        for: 1h
        labels:
          severity: warning
          team: platform
          feature: ai-rebalancing
        annotations:
          summary: 'AI Rebalancing goalReference non-empty rate below 99% for 1 hour'
          description: |
            Less than 99% of returned recommendations have a non-empty
            goalReference field over the last hour. Per AAP § 0.7.5.2
            Rebalancing engine gate, every recommendation MUST include a
            non-empty goalReference mapping to a FinancialProfile field
            name or to a label inside the JSON investmentGoals array.
            The target is 100%; values below 99% indicate the model is
            omitting the field, which is a Rule violation requiring prompt
            remediation. Inspect a sample failing response and verify the
            tool input_schema declares goalReference as required.
          runbook_url: 'docs/observability/ai-rebalancing.md#panel-5--goalreference-non-empty-rate'

      - alert: RebalancingWarningsRateHigh
        expr: |
          (
            sum(rate(ai_rebalancing_warnings_total[30m]))
            /
            sum(rate(ai_rebalancing_recommendations_total[30m]))
          ) > 0.5
        for: 30m
        labels:
          severity: warning
          team: platform
          feature: ai-rebalancing
        annotations:
          summary: 'AI Rebalancing warnings/recommendation ratio above 0.5 for 30 minutes'
          description: |
            The average number of warnings emitted per recommendation has
            exceeded 0.5 over the last 30 minutes. The 0.5 warnings/recommendation
            threshold is the project-mandated alert threshold for this
            dashboard. A high ratio indicates either constrained portfolios
            where the model has many caveats to surface, or prompt drift
            where the model has begun emitting warnings inappropriately.
            Inspect a sample of warnings to determine which class dominates,
            and consider revising the system prompt if the warnings are
            spurious or duplicative.
          runbook_url: 'docs/observability/ai-rebalancing.md#panel-3--warnings-rate'

      - alert: RebalancingAnthropicAuthError
        expr: |
          sum(increase(ai_rebalancing_anthropic_api_error_total{error_class="auth"}[1m])) > 0
        for: 0m
        labels:
          severity: critical
          team: platform
          feature: ai-rebalancing
        annotations:
          summary: 'AI Rebalancing received an Anthropic authentication error'
          description: |
            One or more requests to api.anthropic.com returned an
            authentication error (HTTP 401/403). The ANTHROPIC_API_KEY
            referenced through ConfigService may have been rotated,
            revoked, or never propagated to this replica. New rebalancing
            requests will fail until a valid key is restored. This alert
            fires immediately (no for: window) because the failure mode
            is binary and operator attention is required. Verify the
            ConfigService.get('ANTHROPIC_API_KEY') value and re-roll the
            secret if necessary.
          runbook_url: 'docs/observability/ai-rebalancing.md#panel-6--anthropic-api-error-rate'

      - alert: RebalancingEmptyRecommendations
        expr: |
          histogram_quantile(
            0.5,
            sum by (le) (rate(ai_rebalancing_recommendations_count_bucket[1h]))
          ) == 0
        for: 1h
        labels:
          severity: warning
          team: platform
          feature: ai-rebalancing
        annotations:
          summary: 'AI Rebalancing median recommendation count is 0 for 1 hour'
          description: |
            The median recommendation count returned by the rebalancing
            endpoint has been 0 for the last hour. This pattern strongly
            suggests one of three regressions: (1) Claude has stopped
            honoring the tool_choice constraint and is returning empty
            arrays; (2) the system prompt has drifted such that the model
            decides every position is already balanced; or (3) a portfolio
            data path is returning empty allocations and the model has
            nothing to recommend on. Inspect a sample request/response
            pair and verify PortfolioService.getDetails returns a non-empty
            holdings array.
          runbook_url: 'docs/observability/ai-rebalancing.md#panel-2--recommendation-count-distribution'
```

Severity guidance:

- **`critical`** — paging severity. The endpoint is effectively non-functional from a user perspective (Rule 4 violation, or auth is broken).
- **`warning`** — non-paging severity. The endpoint is degraded but still serving requests; investigate during business hours unless the trend continues.

---

## Local Development Verification

The AAP § 0.7.2 Observability rule mandates that observability MUST be exercised in the local development environment. The following seven-step checklist walks an operator through that verification end-to-end.

1. **Start the local Ghostfolio API.** A working Postgres + Redis stack is required (e.g., `docker compose -f docker/docker-compose.dev.yml up -d`). Then start the API process:

   ```sh
   npm run start:api
   ```

   The Nx process should report `🚀 Application is running on: http://localhost:3333/api`. The `/api/v1` URI version is configured globally in `apps/api/src/main.ts`.

2. **Confirm the metrics endpoint returns 200.** The metrics registry from `MetricsModule` (per AAP § 0.5.1.2) emits Prometheus-formatted counters and histograms:

   ```sh
   curl -i http://localhost:3333/api/v1/metrics
   ```

   Expect `HTTP/1.1 200 OK` and a body containing one `# HELP` / `# TYPE` line per metric followed by the metric samples. At first start (before any rebalancing request), the AI Rebalancing counters will all read zero — that is expected.

3. **Confirm the Anthropic health probe returns 200.** The probe is implemented in `apps/api/src/app/health/anthropic-health.indicator.ts` per AAP § 0.5.1.2 and is a configuration probe only — it does NOT call `api.anthropic.com` and therefore consumes no API tokens:

   ```sh
   curl -i http://localhost:3333/api/v1/health/anthropic
   ```

   Expect `HTTP/1.1 200 OK` with a body of the form `{"status":"up","details":{"anthropic":{"status":"up"}}}`. If the probe returns 503, verify that `ANTHROPIC_API_KEY` is set in `.env` (development) and resolved through `ConfigService` at boot. **Note:** never paste the actual key value into shell history or logs — only the env var name `ANTHROPIC_API_KEY` should appear in operator notes.

4. **Issue a sample rebalancing request.** Unlike the chat endpoint, the rebalancing endpoint is **non-streaming** — `messages.create` blocks until Claude has produced the full structured output, and the server returns a single JSON response. There is no `Accept: text/event-stream` header and no `curl -N` flag is necessary:

   ```sh
   curl -i -X POST http://localhost:3333/api/v1/ai/rebalancing \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

   Substitute `<jwt>` with a JWT obtained from the Ghostfolio login flow (e.g., `POST /api/v1/auth/anonymous`). The request body may be `{}` (empty object) for a default rebalancing call; optional override fields are accepted per the `RebalancingRequestDto`.

5. **Verify the response body matches the `RebalancingResponse` interface.** The response MUST be valid JSON conforming to the interface from AAP § 0.1.2.4 — `recommendations: Array<{ action, ticker, fromPct, toPct, rationale, goalReference }>`, `summary: string`, `warnings: string[]`. Per the AAP § 0.7.5.2 Rebalancing engine gate, **every item in `recommendations` MUST have a non-empty `rationale` and a non-empty `goalReference`**. The dashboard's Panel 5 surfaces the `goalReference` non-empty rate as a quality metric — a failure here is a Rule violation. Pipe the response through `jq` to inspect:

   ```sh
   curl -s -X POST http://localhost:3333/api/v1/ai/rebalancing \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -d '{}' | jq '.recommendations[] | { action, ticker, rationale, goalReference }'
   ```

   Confirm none of the printed `rationale` or `goalReference` values are empty strings.

6. **Re-fetch `/api/v1/metrics` and confirm the AI Rebalancing counters incremented.** Run the metrics curl again and confirm the following changes from step 2:

   ```sh
   curl -s http://localhost:3333/api/v1/metrics | grep -E '^ai_rebalancing_'
   ```

   Expected:
   - `ai_rebalancing_request_duration_seconds_count{...}` has incremented by **1** (the histogram count of total responses).
   - `ai_rebalancing_recommendations_total{goal_reference_status="present"}` has incremented by the number of recommendations Claude produced with non-empty `goalReference` values.
   - `ai_rebalancing_recommendations_total{goal_reference_status="empty"}` has **NOT** incremented — every recommendation must carry a non-empty `goalReference` (Rule violation otherwise).
   - `ai_rebalancing_tool_use_validation_failure_total` has **NOT** incremented (Rule 4 — `BadGatewayException` was not thrown; a `tool_use` content block was found in the Anthropic SDK response). This counter MUST stay at **zero** in healthy operation.
   - `ai_rebalancing_anthropic_api_error_total{...}` has **NOT** incremented for any `error_class`.
   - `ai_rebalancing_recommendations_count_bucket{...}` and `ai_rebalancing_recommendations_count_count` have advanced (the histogram of recommendation counts has a new sample).
   - `ai_rebalancing_warnings_total` may or may not have incremented depending on whether Claude emitted any `warnings[]` in the response.

7. **Import the JSON dashboard definition into a local Grafana.** Open Grafana at `http://localhost:3000`, navigate to **Dashboards → New → Import**, paste the JSON block from the [JSON Dashboard Definition](#json-dashboard-definition) section below, select the Prometheus datasource that scrapes `/api/v1/metrics`, and click **Import**. Confirm that all six panels render data after a few minutes of scrape activity (the panels will appear empty until at least one scrape interval after step 6).

After completing all seven steps, the dashboard is verified end-to-end against the local development environment, satisfying the AAP § 0.7.2 mandate.

---

## JSON Dashboard Definition

The following JSON is a complete, self-contained Grafana dashboard definition mapping 1:1 to the six Recommended Panels above. It can be imported into a stock Grafana 9+ instance via **Dashboards → New → Import → Paste JSON**. The `datasource.uid` placeholder of `"Prometheus"` should be reconciled with the UID of the Prometheus datasource provisioned in your Grafana instance (visible at **Connections → Data sources → Prometheus → uid**).

```json
{
  "title": "Ghostfolio — Explainable Rebalancing Engine",
  "uid": "gf-ai-rebalancing",
  "schemaVersion": 38,
  "version": 1,
  "editable": true,
  "graphTooltip": 1,
  "tags": ["ghostfolio", "ai-rebalancing", "observability", "claude"],
  "time": { "from": "now-6h", "to": "now" },
  "refresh": "30s",
  "annotations": { "list": [] },
  "templating": { "list": [] },
  "panels": [
    {
      "id": 1,
      "title": "Rebalancing Latency (p50 / p95 / p99)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "description": "Total POST /api/v1/ai/rebalancing response time. Non-streaming endpoint — primary user-facing latency signal. Targets: p50 ≤ 6 s, p95 ≤ 15 s, p99 ≤ 30 s. Alert: p95 > 20 s for 10 min.",
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 15 },
              { "color": "red", "value": 20 }
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
          "expr": "histogram_quantile(0.50, sum by (le) (rate(ai_rebalancing_request_duration_seconds_bucket[5m])))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.95, sum by (le) (rate(ai_rebalancing_request_duration_seconds_bucket[5m])))",
          "legendFormat": "p95"
        },
        {
          "refId": "C",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.99, sum by (le) (rate(ai_rebalancing_request_duration_seconds_bucket[5m])))",
          "legendFormat": "p99"
        }
      ]
    },
    {
      "id": 2,
      "title": "Recommendation Count Distribution (median per response)",
      "type": "barchart",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "description": "Histogram of how many recommendations Claude returns per call (buckets: 0, 1, 2, 5, 10, 20). Alert if median is consistently 0 (RebalancingEmptyRecommendations).",
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "custom": { "axisPlacement": "auto", "fillOpacity": 80 }
        },
        "overrides": []
      },
      "options": {
        "orientation": "vertical",
        "legend": { "displayMode": "list", "placement": "bottom" },
        "tooltip": { "mode": "single" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.5, sum by (le) (rate(ai_rebalancing_recommendations_count_bucket[1h])))",
          "legendFormat": "median recommendations/response"
        }
      ]
    },
    {
      "id": 3,
      "title": "Warnings Rate (warnings per recommendation)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "description": "Average warnings emitted per response. Alert: >0.5 warnings/recommendation over 30 min (RebalancingWarningsRateHigh) — project-mandated alert threshold.",
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.3 },
              { "color": "red", "value": 0.5 }
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
          "expr": "sum(rate(ai_rebalancing_warnings_total[5m])) / sum(rate(ai_rebalancing_recommendations_total[5m]))",
          "legendFormat": "warnings/recommendation"
        }
      ]
    },
    {
      "id": 4,
      "title": "Tool-Use Validation Failures (Rule 4 baseline — MUST be 0)",
      "type": "stat",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "description": "Counter for BadGatewayException events thrown when Anthropic returns a response without a tool_use content block (Rule 4 — AAP § 0.7.1.4). Service does NOT fall back to text parsing. Target: 0; alert immediately on any non-zero increment.",
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "red", "value": 1 }
            ]
          },
          "color": { "mode": "thresholds" }
        },
        "overrides": []
      },
      "options": {
        "graphMode": "area",
        "colorMode": "background",
        "justifyMode": "auto",
        "textMode": "value_and_name",
        "reduceOptions": {
          "values": false,
          "calcs": ["lastNotNull"],
          "fields": ""
        }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum(increase(ai_rebalancing_tool_use_validation_failure_total[15m]))",
          "legendFormat": "tool_use validation failures (15m)"
        }
      ]
    },
    {
      "id": 5,
      "title": "goalReference Non-Empty Rate (target: 100%)",
      "type": "gauge",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
      "description": "Percentage of recommendations whose goalReference field is non-empty. Per AAP § 0.7.5.2 every recommendation MUST include a non-empty goalReference. Target: 100%; alert if < 99% over 1 h (RebalancingGoalReferenceMissing).",
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "min": 0,
          "max": 1,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "red", "value": null },
              { "color": "yellow", "value": 0.99 },
              { "color": "green", "value": 1 }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "showThresholdLabels": false,
        "showThresholdMarkers": true,
        "reduceOptions": {
          "values": false,
          "calcs": ["lastNotNull"],
          "fields": ""
        }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum(rate(ai_rebalancing_recommendations_total{goal_reference_status=\"present\"}[5m])) / sum(rate(ai_rebalancing_recommendations_total[5m]))",
          "legendFormat": "non-empty goalReference rate"
        }
      ]
    },
    {
      "id": 6,
      "title": "Anthropic API Error Rate (post-retry, by error_class)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 16 },
      "description": "Counter for upstream Anthropic API errors after SDK retries (per AAP § 0.7.3 — Rate-limiting and back-off). Classes: rate_limit, auth, timeout, 5xx, 4xx, unknown. Alert immediately on auth (RebalancingAnthropicAuthError).",
      "fieldConfig": {
        "defaults": {
          "unit": "cps",
          "custom": {
            "drawStyle": "line",
            "lineWidth": 2,
            "fillOpacity": 20,
            "stacking": { "mode": "normal", "group": "A" }
          },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.0167 },
              { "color": "red", "value": 0.05 }
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
          "expr": "sum by (error_class) (rate(ai_rebalancing_anthropic_api_error_total[5m]))",
          "legendFormat": "{{error_class}}"
        }
      ]
    }
  ]
}
```

---

## References

- **AAP § 0.7.2 — Observability rule.** The application is not complete until it is observable. Every deliverable MUST include structured logging with correlation IDs, distributed tracing, a metrics endpoint, health/readiness checks, a dashboard template, and local-environment exercise of all of the above.
- **AAP § 0.7.1.4 — Rule 4 — Structured Rebalancing via Tool Use.** `RebalancingService` MUST populate `RebalancingResponse` exclusively from a `tool_use` content block returned by the Anthropic SDK. Parsing Claude's text message content to extract structured fields is PROHIBITED. Panel 4 of this dashboard surfaces violations of this rule via the `ai_rebalancing_tool_use_validation_failure_total` counter, which MUST stay at zero.
- **AAP § 0.7.5.2 — Rebalancing engine gate.** `POST /api/v1/ai/rebalancing` returns JSON matching the `RebalancingResponse` interface; every item in `recommendations` has a non-empty `rationale` and `goalReference`; the response is sourced from a `tool_use` content block (Rule 4). Panel 5 surfaces the `goalReference` non-empty rate as a runtime expression of this gate, targeted at 100%.
- **AAP § 0.1.2.4 — `RebalancingResponse` interface (verbatim).** The response shape is `recommendations: Array<{ action: 'BUY' | 'SELL' | 'HOLD'; ticker: string; fromPct: number; toPct: number; rationale: string; goalReference: string; }>; summary: string; warnings: string[];`. The non-empty `goalReference` requirement and the per-recommendation `rationale` are both enforced at the dashboard level via Panels 5 and 2 respectively.
- **`apps/api/src/app/rebalancing/rebalancing.service.ts` — metric emission sites.** The `RebalancingService` is responsible for emitting `ai_rebalancing_request_duration_seconds`, `ai_rebalancing_recommendations_count`, `ai_rebalancing_recommendations_total` (with the `goal_reference_status` label), `ai_rebalancing_warnings_total`, `ai_rebalancing_tool_use_validation_failure_total`, and `ai_rebalancing_anthropic_api_error_total` (with the `error_class` label) via the injected `MetricsService`. Per Rule 3 (AAP § 0.7.1.3), the `ANTHROPIC_API_KEY` is read exclusively through `ConfigService` — never via direct `process.env.ANTHROPIC` access.
- **`apps/api/src/app/metrics/metrics.controller.ts` — metrics endpoint.** Exposes the in-process metrics registry as Prometheus-format text at `GET /api/v1/metrics`. Created per AAP § 0.5.1.2 alongside `MetricsModule` and `MetricsService`.
- **`apps/api/src/app/health/anthropic-health.indicator.ts` — health probe.** Exposes a configuration-only readiness probe at `GET /api/v1/health/anthropic` registered additively in `HealthModule`. The probe verifies that `ConfigService.get('ANTHROPIC_API_KEY')` resolves to a non-empty value and that an `Anthropic` SDK client can be constructed; it does NOT call `api.anthropic.com` and consumes no API tokens. Created per AAP § 0.5.1.2.

### Sibling dashboard templates

- **`docs/observability/ai-chat.md`** — Feature B (`AiChatModule`) streaming `POST /api/v1/ai/chat` (Server-Sent Events) metrics: first-token latency (primary), end-to-end stream duration, token throughput, tool-call distribution, SSE error rate, model-version histogram, personalization fetch latency.
- **`docs/observability/snowflake-sync.md`** — Feature A (`SnowflakeSyncModule`) cron + event-listener sync metrics: success rate, sync latency, MERGE row counts, idempotency verification (Rule 7).
