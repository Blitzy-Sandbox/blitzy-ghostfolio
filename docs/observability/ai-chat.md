# AI Portfolio Chat Agent — Observability Dashboard Template

## Overview

This document is the canonical Grafana dashboard template for **Feature B — AI Portfolio Chat Agent (`AiChatModule`)**, the streaming `POST /api/v1/ai/chat` Server-Sent Events (SSE) endpoint introduced by the Agent Action Plan. It satisfies the project-level **Observability** rule recorded in AAP § 0.7.2 (every deliverable MUST include structured logging with correlation IDs, distributed tracing, a metrics endpoint, health/readiness checks, and a dashboard template — and that observability MUST be exercisable in the local development environment).

### Feature being observed

The dashboard observes the entire request lifecycle of `POST /api/v1/ai/chat`:

- The endpoint is implemented in `AiChatController` (`apps/api/src/app/ai-chat/ai-chat.controller.ts`) and `AiChatService` (`apps/api/src/app/ai-chat/ai-chat.service.ts`).
- The service constructs an Anthropic Claude client via the `@anthropic-ai/sdk` package and invokes `client.messages.stream({...})` so that response tokens are delivered to the browser as they are produced. This makes the endpoint **STREAMING** (SSE) — distinct from the non-streaming rebalancing endpoint documented in `ai-rebalancing.md`, which uses `messages.create({...})` and emits a single JSON payload.
- The chat agent dispatches **four** Claude tool calls (per AAP § 0.5.1.5): `get_current_positions` (delegates to `PortfolioService`), `get_performance_metrics` (delegates to `PortfolioService`), `query_history` (delegates to `SnowflakeSyncService.queryHistory(...)` with bind variables only — Rule 2), and `get_market_data` (delegates to `SymbolService`).
- The protocol is **stateless server-side**: the client transmits at most four prior turns plus the new user turn (5 entries total) on every request — there are no server-side conversation rows to count, and the dashboard intentionally omits a "session count" panel.
- Each request reads `UserFinancialProfileService.findByUserId(userId)` and `PortfolioService.getDetails(...)` to build the personalized system prompt; the latency of those two reads directly inflates the user-visible first-token latency budget.

### Data source

All panels query Prometheus-formatted counters and histograms exposed at the new `/api/v1/metrics` endpoint registered by `MetricsModule` (`apps/api/src/app/metrics/metrics.controller.ts` per AAP § 0.5.1.2). The dashboard assumes a Prometheus datasource scrapes that endpoint at a stable interval (typically every 15 s); the `datasource.uid` in the JSON definition below is a placeholder (`"Prometheus"`) that operators should reconcile with the UID of their actual provisioned Prometheus datasource.

### Audience

The intended audience is on-call SREs and platform engineers verifying:

1. **First-token latency** — the user-facing performance metric for streaming endpoints. The localhost gate is **≤ 3 s** (per AAP § 0.7.5.2 Chat agent gate); the dashboard surfaces p50/p95/p99 quantiles of this distribution.
2. **End-to-end stream duration** — total time from request receipt to stream close, which captures the full Claude generation including all tool round-trips. Unlike first-token latency, stream duration scales with the size of the model's response and is reported separately.
3. **Token throughput** — separate counters for input and output tokens consumed per request, sourced from the Anthropic SDK `usage.input_tokens` and `usage.output_tokens` fields emitted at stream end. Useful for cost and capacity tracking.
4. **Tool-call distribution** — counter of invocations of each of the four tools, useful for catching prompt drift, tool-schema regressions, or system-prompt edits that quietly stop triggering one of the tools.
5. **SSE error rate** — the server-side baseline counterpart of **Rule 6 — SSE Disconnection Handling** (AAP § 0.7.1.6). The browser-side requirement is that `ChatPanelComponent` MUST render a non-empty `errorMessage` and a visible reconnect button when the SSE stream terminates with an error; the corresponding server-side metric is `ai_chat_sse_error_total`. Watching this counter lets operators correlate user-visible reconnect events with backend faults.
6. **Anthropic API health** — readiness probe at `GET /api/v1/health/anthropic` (configuration probe only; does not consume API tokens), implemented in `apps/api/src/app/health/anthropic-health.indicator.ts` per AAP § 0.5.1.2. A complementary panel can pin this probe's status alongside the streaming metrics.
7. **Model-version distribution** — the `ANTHROPIC_MODEL` environment variable (per AAP § 0.7.3) overrides the default Claude model identifier; tracking the `model` label value lets operators verify canary rollouts and detect cache-poisoning or hot-deploy races where two model values appear simultaneously.

### Streaming vs. non-streaming distinction

This dashboard's primary user-facing latency metric is **first-token latency** (Panel 2), measured from request receipt to first SSE chunk emission. End-to-end stream duration is also tracked but it is **not** the leading indicator of perceived chat responsiveness — once tokens are streaming, the user sees forward progress.

By contrast, the rebalancing dashboard (`docs/observability/ai-rebalancing.md`) uses **total request latency** as its primary metric because that endpoint is non-streaming and returns a single JSON body sourced exclusively from a `tool_use` content block (Rule 4 — AAP § 0.7.1.4). When debugging, reach for the dashboard whose primary latency metric matches the endpoint's transport.

---

## Recommended Panels

The dashboard SHOULD include exactly the following seven panels, in the order documented here. The JSON definition in the [JSON Dashboard Definition](#json-dashboard-definition) section below provides a 1:1 importable mapping.

### Panel 1 — Chat-Token Throughput

| Field                   | Value                                                                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**          | `timeseries` (multi-series — one line per direction)                                                                                                                                                                                                                                                 |
| **Metric names**        | `ai_chat_input_tokens_total` (counter), `ai_chat_output_tokens_total` (counter)                                                                                                                                                                                                                      |
| **Example expressions** | `sum(rate(ai_chat_input_tokens_total[1m]))` and `sum(rate(ai_chat_output_tokens_total[1m]))`                                                                                                                                                                                                         |
| **Thresholds**          | Informational. Alert if `output_tokens_total` rate drops to `0` while `input_tokens_total` rate is non-zero — see `AiChatOutputTokenRateZero` below — because that pattern strongly suggests Anthropic-side throttling, an authentication fault, or an SDK error before any output token is emitted. |

**Description.** Separate counters for input tokens and output tokens consumed per request, aggregated per minute. Sourced from the Anthropic SDK `usage.input_tokens` / `usage.output_tokens` fields that are populated on the final streamed message event. The two counters together provide a cost and throughput signal: input tokens scale with system-prompt size (which grows with portfolio complexity per the personalization read path), while output tokens scale with the answer length the model decides to produce.

### Panel 2 — First-Token Latency

| Field                        | Value                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**               | `timeseries` with p50 / p95 / p99 lines                                                                                                                          |
| **Metric name**              | `ai_chat_first_token_latency_seconds` (histogram)                                                                                                                |
| **Example expression (p95)** | `histogram_quantile(0.95, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))`                                                                   |
| **Thresholds**               | p50 ≤ 1.5 s; **p95 ≤ 3 s on localhost** (per AAP § 0.7.5.2 Chat agent gate); p99 ≤ 8 s. Alert if p95 exceeds 5 s for 10 minutes (`AiChatFirstTokenLatencyHigh`). |

**Description.** Histogram of time elapsed from `POST /api/v1/ai/chat` request receipt to first SSE token emission. The 3 s p95 figure reflects the localhost gate documented in the AAP; production targets may differ based on the network distance to `api.anthropic.com` and the size of the personalization context. Slow personalization fetches (Panel 7) directly elongate this metric — whenever this panel regresses, inspect Panel 7 first.

### Panel 3 — Tool-Call Distribution by Tool Name

| Field                  | Value                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `barchart` (or `piechart`); use the `$tool` template variable to filter                                                                                                                                                                                                                                     |
| **Metric name**        | `ai_chat_tool_invocation_total` (counter, labeled by `tool=get_current_positions\|get_performance_metrics\|query_history\|get_market_data`)                                                                                                                                                                 |
| **Example expression** | `sum by (tool) (rate(ai_chat_tool_invocation_total[5m]))`                                                                                                                                                                                                                                                   |
| **Thresholds**         | Informational. Alert if any of the four tools has zero invocations over 24 h while overall chat traffic is non-zero (`AiChatToolDistributionAnomaly`) — that pattern indicates either a system-prompt regression that stopped triggering the tool, or a tool-schema change the model can no longer satisfy. |

**Description.** Counter of invocations of each of the four chat tools — `get_current_positions`, `get_performance_metrics`, `query_history`, and `get_market_data` — emitted from `AiChatService.dispatchTool(...)`. Useful for spotting prompt drift after a system-prompt edit, for verifying that newly-added tool schemas are reachable by the model, and for analyzing which tools dominate cost and latency over time.

### Panel 4 — SSE Error Rate

| Field                  | Value                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `timeseries` (stacked by `error_class`)                                                                                            |
| **Metric name**        | `ai_chat_sse_error_total` (counter, labeled by `error_class=client_disconnect\|anthropic_error\|tool_dispatch_error\|unknown`)     |
| **Example expression** | `sum by (error_class) (rate(ai_chat_sse_error_total[5m])) / ignoring(error_class) group_left sum(rate(ai_chat_request_total[5m]))` |
| **Thresholds**         | Alert if total SSE error rate exceeds 5% over a 15-minute window (`AiChatSseErrorRateHigh`).                                       |

**Description.** Counter for streams that terminate with an error. This is the server-side baseline metric for **Rule 6 — SSE Disconnection Handling** (AAP § 0.7.1.6): the client (`ChatPanelComponent`) MUST render a non-empty `errorMessage` and a visible reconnect button when the SSE stream terminates with an error, and this panel surfaces how often that user-visible flow is being triggered. The `client_disconnect` label captures cases where the browser closed the stream (often a tab close or navigation), `anthropic_error` captures upstream Anthropic API failures, `tool_dispatch_error` captures failures inside `AiChatService.dispatchTool(...)` while satisfying a Claude tool call, and `unknown` is the catch-all.

### Panel 5 — Model-Version Histogram

| Field                  | Value                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Panel type**         | `barchart` (or `piechart`)                                                                                                                                                                                                                         |
| **Metric name**        | `ai_chat_request_total` (counter, labeled by `model=<anthropic_model_id>`)                                                                                                                                                                         |
| **Example expression** | `sum by (model) (rate(ai_chat_request_total[5m]))`                                                                                                                                                                                                 |
| **Thresholds**         | Informational. Alert if multiple distinct `model` label values appear simultaneously when only one is configured — that pattern indicates a hot-deploy race or a stale-cache poisoning where two replicas disagree on the Claude model identifier. |

**Description.** Distribution of Anthropic model identifiers used by the streaming endpoint. The model is configurable via the `ANTHROPIC_MODEL` environment variable (per AAP § 0.7.3) and the service reads it exclusively through `ConfigService` — no `process.env.ANTHROPIC` access is permitted in new module files (Rule 3 — AAP § 0.7.1.3). Tracking the `model` label enables canary analysis (split traffic across two model versions during a rollout) and rollout verification (confirm a configuration change has propagated to all replicas).

### Panel 6 — End-to-End Stream Duration

| Field                        | Value                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Panel type**               | `timeseries` with p50 / p95 / p99 lines (a `heatmap` is also acceptable for fine-grained inspection)         |
| **Metric name**              | `ai_chat_stream_duration_seconds` (histogram)                                                                |
| **Example expression (p95)** | `histogram_quantile(0.95, sum by (le) (rate(ai_chat_stream_duration_seconds_bucket[5m])))`                   |
| **Thresholds**               | p50 ≤ 8 s; p95 ≤ 25 s; p99 ≤ 60 s. Alert if p95 exceeds 45 s for 10 minutes (`AiChatStreamDurationP95High`). |

**Description.** Histogram of total time from request receipt to stream close. Captures the full Claude generation including all tool round-trips (one round-trip per `tool_use`/`tool_result` pair). Unlike Panel 2 (first-token latency, the user-perceived responsiveness signal), this metric scales with answer length and tool-call depth. Watch this panel when the chat "feels fine" but is taking unusually long to finish — the model may be looping through tool calls or producing a much longer response than expected.

### Panel 7 — Personalization Data Fetch Latency

| Field                        | Value                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Panel type**               | `timeseries` (one line per `source`)                                                                               |
| **Metric name**              | `ai_chat_personalization_fetch_seconds` (histogram, labeled by `source=user_financial_profile\|portfolio_details`) |
| **Example expression (p95)** | `histogram_quantile(0.95, sum by (le, source) (rate(ai_chat_personalization_fetch_seconds_bucket[5m])))`           |
| **Thresholds**               | p95 ≤ 500 ms per source. Alert if p95 exceeds 1 s for 10 minutes (`AiChatPersonalizationLatencyHigh`).             |

**Description.** Histogram of `UserFinancialProfileService.findByUserId(userId)` and `PortfolioService.getDetails({...})` call duration in the system-prompt build path. Both reads execute on every chat request to personalize the system prompt with the caller's `FinancialProfile` (goals, risk tolerance, income, debt) and current portfolio state. Slow personalization fetches directly inflate first-token latency (Panel 2) one-for-one, so this is the first place to look when first-token p95 regresses without a corresponding upstream Anthropic latency change.

---

## Alert Rules

The following Prometheus alert rules are recommended. They map 1:1 to the panel thresholds documented above. Operators can drop the YAML block below into a Prometheus rules file (e.g., `prometheus/rules/ai-chat.yml`) and reload Prometheus.

```yaml
groups:
  - name: ghostfolio-ai-chat
    interval: 30s
    rules:
      - alert: AiChatFirstTokenLatencyHigh
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m]))
          ) > 5
        for: 10m
        labels:
          severity: warning
          team: platform
          feature: ai-chat
        annotations:
          summary: 'AI Chat first-token latency p95 above 5 s for 10 minutes'
          description: |
            The 95th percentile of ai_chat_first_token_latency_seconds is currently
            {{ $value | humanizeDuration }}, exceeding the 5 s alerting threshold
            for 10 minutes. Inspect Panel 7 (personalization fetch latency) and the
            Anthropic API health probe at /api/v1/health/anthropic. The localhost
            gate target documented in AAP § 0.7.5.2 is p95 ≤ 3 s.
          runbook_url: 'docs/observability/ai-chat.md#panel-2--first-token-latency'

      - alert: AiChatSseErrorRateHigh
        expr: |
          (
            sum(rate(ai_chat_sse_error_total[15m]))
            /
            sum(rate(ai_chat_request_total[15m]))
          ) > 0.05
        for: 15m
        labels:
          severity: warning
          team: platform
          feature: ai-chat
        annotations:
          summary: 'AI Chat SSE error rate above 5% for 15 minutes'
          description: |
            More than 5% of AI Chat streams are terminating with an error.
            Browser-side users are seeing the reconnect button (Rule 6 —
            AAP § 0.7.1.6). Group by error_class to identify the dominant
            cause: client_disconnect (browser closures), anthropic_error
            (upstream API failures), tool_dispatch_error (tool execution
            failures in AiChatService.dispatchTool), or unknown.
          runbook_url: 'docs/observability/ai-chat.md#panel-4--sse-error-rate'

      - alert: AiChatStreamDurationP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(ai_chat_stream_duration_seconds_bucket[5m]))
          ) > 45
        for: 10m
        labels:
          severity: warning
          team: platform
          feature: ai-chat
        annotations:
          summary: 'AI Chat stream duration p95 above 45 s for 10 minutes'
          description: |
            The 95th percentile of ai_chat_stream_duration_seconds is currently
            {{ $value | humanizeDuration }}, exceeding the 45 s alerting threshold
            for 10 minutes. Investigate whether the model is looping through tool
            calls (Panel 3) or producing unusually long responses (correlate with
            ai_chat_output_tokens_total trend in Panel 1).
          runbook_url: 'docs/observability/ai-chat.md#panel-6--end-to-end-stream-duration'

      - alert: AiChatPersonalizationLatencyHigh
        expr: |
          histogram_quantile(
            0.95,
            sum by (le, source) (rate(ai_chat_personalization_fetch_seconds_bucket[5m]))
          ) > 1
        for: 10m
        labels:
          severity: warning
          team: platform
          feature: ai-chat
        annotations:
          summary: 'AI Chat personalization fetch p95 above 1 s for 10 minutes'
          description: |
            UserFinancialProfileService.findByUserId or PortfolioService.getDetails
            is taking longer than 1 s at p95 to satisfy the per-request system-prompt
            build path. This directly inflates first-token latency (Panel 2). Check
            Postgres connection pool saturation and the portfolio cache hit rate.
          runbook_url: 'docs/observability/ai-chat.md#panel-7--personalization-data-fetch-latency'

      - alert: AiChatToolDistributionAnomaly
        expr: |
          (
            sum by (tool) (increase(ai_chat_tool_invocation_total[24h])) == 0
          )
          and on()
          (
            sum(increase(ai_chat_request_total[24h])) > 0
          )
        for: 30m
        labels:
          severity: warning
          team: platform
          feature: ai-chat
        annotations:
          summary: 'AI Chat tool {{ $labels.tool }} has zero invocations in 24 h'
          description: |
            Tool {{ $labels.tool }} has not been invoked in the last 24 hours
            despite chat traffic being non-zero. This typically indicates either
            a system-prompt regression that no longer triggers the tool or a
            tool-schema change the model can no longer satisfy. The four expected
            tools are get_current_positions, get_performance_metrics, query_history,
            and get_market_data (AAP § 0.5.1.5).
          runbook_url: 'docs/observability/ai-chat.md#panel-3--tool-call-distribution-by-tool-name'

      - alert: AiChatOutputTokenRateZero
        expr: |
          sum(rate(ai_chat_output_tokens_total[5m])) == 0
          and
          sum(rate(ai_chat_input_tokens_total[5m])) > 0
        for: 5m
        labels:
          severity: critical
          team: platform
          feature: ai-chat
        annotations:
          summary: 'AI Chat output token rate is zero while input is non-zero'
          description: |
            Input tokens are still being submitted to Anthropic but no output
            tokens are being returned. This pattern strongly suggests Anthropic-side
            throttling, an authentication fault (rotated or revoked API key), or
            an SDK error before any tokens are emitted. Verify
            /api/v1/health/anthropic and inspect ai_chat_sse_error_total
            for the anthropic_error class.
          runbook_url: 'docs/observability/ai-chat.md#panel-1--chat-token-throughput'

      - alert: AiChatAnthropicAuthError
        expr: |
          sum(increase(ai_chat_sse_error_total{error_class="anthropic_auth_error"}[1m])) > 0
        for: 0m
        labels:
          severity: critical
          team: platform
          feature: ai-chat
        annotations:
          summary: 'AI Chat received an Anthropic authentication error'
          description: |
            One or more requests to api.anthropic.com returned an authentication
            error. The ANTHROPIC_API_KEY referenced through ConfigService may have
            been rotated, revoked, or never propagated to this replica. New chats
            will fail until a valid key is restored. This alert fires immediately
            (no for: window) because the failure mode is binary and operator
            attention is required.
          runbook_url: 'docs/observability/ai-chat.md#panel-4--sse-error-rate'
```

Severity guidance:

- **`critical`** — paging severity. The endpoint is effectively non-functional from a user perspective (no output tokens, or auth is broken).
- **`warning`** — non-paging severity. The endpoint is degraded but still serving requests; investigate during business hours unless the trend continues.

---

## Local Development Verification

The AAP § 0.7.2 Observability rule mandates that observability MUST be exercised in the local development environment. The following eight-step checklist walks an operator through that verification end-to-end.

1. **Start the local Ghostfolio API.** A working Postgres + Redis stack is required (e.g., `docker compose -f docker/docker-compose.dev.yml up -d`). Then start the API process:

   ```sh
   npm run start:api
   ```

   The Nx process should report `🚀 Application is running on: http://localhost:3333/api`. The `/api/v1` URI version is configured globally in `apps/api/src/main.ts`.

2. **Confirm the metrics endpoint returns 200.** The metrics registry from `MetricsModule` (per AAP § 0.5.1.2) emits Prometheus-formatted counters and histograms:

   ```sh
   curl -i http://localhost:3333/api/v1/metrics
   ```

   Expect `HTTP/1.1 200 OK` and a body containing one `# HELP` / `# TYPE` line per metric followed by the metric samples. At first start (before any chat request), the AI Chat counters will all read zero — that is expected.

3. **Confirm the Anthropic health probe returns 200.** The probe is implemented in `apps/api/src/app/health/anthropic-health.indicator.ts` per AAP § 0.5.1.2 and is a configuration probe only — it does NOT call `api.anthropic.com` and therefore consumes no API tokens:

   ```sh
   curl -i http://localhost:3333/api/v1/health/anthropic
   ```

   Expect `HTTP/1.1 200 OK` with a body of the form `{"status":"up","details":{"anthropic":{"status":"up"}}}`. If the probe returns 503, verify that `ANTHROPIC_API_KEY` is set in `.env` (development) and resolved through `ConfigService` at boot.

4. **Issue a sample SSE request and observe the stream.** Use `curl -N` (no output buffering) so SSE chunks are flushed to the terminal as they arrive:

   ```sh
   curl -N -X POST http://localhost:3333/api/v1/ai/chat \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -H "Accept: text/event-stream" \
     -d '{"messages":[{"role":"user","content":"What are my current positions?"}]}'
   ```

   Verify the response begins with the headers:

   ```text
   HTTP/1.1 200 OK
   Content-Type: text/event-stream
   Cache-Control: no-cache
   Connection: keep-alive
   ```

   The `Content-Type: text/event-stream` header is the marker for streaming responses and is the expectation enforced by the Chat agent gate in AAP § 0.7.5.2. Substitute `<jwt>` with a JWT obtained from the Ghostfolio login flow (e.g., `POST /api/v1/auth/anonymous`).

5. **Verify the first SSE token arrives within 3 seconds.** The Chat agent gate in AAP § 0.7.5.2 requires the first SSE token to arrive within **3 seconds on localhost** with valid credentials. Time the wall-clock latency between the `curl` invocation and the first `data: {...}` line printed to the terminal — for example, with `time` and a small Node helper, or by redirecting the stream into a script that timestamps each chunk. Sustained values above 3 s are a regression and should be investigated against Panel 2 and the personalization fetch panel (Panel 7).

6. **Re-fetch `/api/v1/metrics` and confirm the AI Chat counters incremented.** Run the metrics curl again and confirm the following changes from step 2:

   ```sh
   curl -s http://localhost:3333/api/v1/metrics | grep -E '^ai_chat_'
   ```

   Expected:
   - `ai_chat_request_total{...}` has incremented by **1**.
   - `ai_chat_input_tokens_total` has a non-zero value (the system prompt was sent to Anthropic, consuming input tokens).
   - `ai_chat_output_tokens_total` has a non-zero value (Claude produced response tokens).
   - At least one `ai_chat_tool_invocation_total{tool="get_current_positions"}` sample has incremented (the user prompt explicitly asked about positions, so the agent should have called that tool).
   - `ai_chat_sse_error_total{...}` has **NOT** incremented (the stream completed successfully).
   - `ai_chat_first_token_latency_seconds_count` and `ai_chat_stream_duration_seconds_count` have both incremented by 1.

7. **Disconnect the client mid-stream to verify Rule 6 telemetry.** Re-run step 4 but interrupt the curl with `Ctrl+C` before the stream finishes. Then re-fetch `/api/v1/metrics` and confirm:

   ```sh
   curl -s http://localhost:3333/api/v1/metrics | grep '^ai_chat_sse_error_total'
   ```

   The series `ai_chat_sse_error_total{error_class="client_disconnect"}` MUST have incremented. This is the server-side baseline of Rule 6 (AAP § 0.7.1.6) — the browser-side `ChatPanelComponent` will set `errorMessage` to a non-empty string and render the reconnect button when the corresponding browser-side `EventSource` `error` handler fires.

8. **Import the JSON dashboard definition into a local Grafana.** Open Grafana at `http://localhost:3000`, navigate to **Dashboards → New → Import**, paste the JSON block from the [JSON Dashboard Definition](#json-dashboard-definition) section below, select the Prometheus datasource that scrapes `/api/v1/metrics`, and click **Import**. Confirm that all seven panels render data after a few minutes of scrape activity (the panels will appear empty until at least one scrape interval after step 6).

After completing all eight steps, the dashboard is verified end-to-end against the local development environment, satisfying the AAP § 0.7.2 mandate.

---

## JSON Dashboard Definition

The following JSON is a complete, self-contained Grafana dashboard definition mapping 1:1 to the seven Recommended Panels above. It can be imported into a stock Grafana 9+ instance via **Dashboards → New → Import → Paste JSON**. The `datasource.uid` placeholder of `"Prometheus"` should be reconciled with the UID of the Prometheus datasource provisioned in your Grafana instance (visible at **Connections → Data sources → Prometheus → uid**).

```json
{
  "title": "Ghostfolio — AI Portfolio Chat Agent",
  "uid": "gf-ai-chat",
  "schemaVersion": 38,
  "version": 1,
  "editable": true,
  "graphTooltip": 1,
  "tags": ["ghostfolio", "ai-chat", "observability", "claude", "sse"],
  "time": { "from": "now-6h", "to": "now" },
  "refresh": "30s",
  "annotations": { "list": [] },
  "templating": {
    "list": [
      {
        "name": "tool",
        "label": "Tool",
        "type": "query",
        "query": "label_values(ai_chat_tool_invocation_total, tool)",
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
      "title": "Chat-Token Throughput",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "description": "Input vs output token rate (tokens/sec). Sourced from Anthropic SDK usage.input_tokens / usage.output_tokens at stream end.",
      "fieldConfig": {
        "defaults": {
          "unit": "short",
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
          "expr": "sum(rate(ai_chat_input_tokens_total[1m]))",
          "legendFormat": "input tokens/s"
        },
        {
          "refId": "B",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum(rate(ai_chat_output_tokens_total[1m]))",
          "legendFormat": "output tokens/s"
        }
      ]
    },
    {
      "id": 2,
      "title": "First-Token Latency (p50 / p95 / p99)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "description": "Time from POST /api/v1/ai/chat receipt to first SSE token. Localhost gate: p95 ≤ 3 s (AAP § 0.7.5.2).",
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 3 },
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
          "expr": "histogram_quantile(0.50, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.95, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))",
          "legendFormat": "p95"
        },
        {
          "refId": "C",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.99, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))",
          "legendFormat": "p99"
        }
      ]
    },
    {
      "id": 3,
      "title": "Tool-Call Distribution by Tool Name",
      "type": "barchart",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "description": "Invocations of get_current_positions, get_performance_metrics, query_history, get_market_data (AAP § 0.5.1.5).",
      "fieldConfig": {
        "defaults": { "unit": "short" },
        "overrides": []
      },
      "options": {
        "orientation": "horizontal",
        "legend": { "displayMode": "list", "placement": "bottom" },
        "tooltip": { "mode": "single" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum by (tool) (rate(ai_chat_tool_invocation_total{tool=~\"$tool\"}[5m]))",
          "legendFormat": "{{tool}}"
        }
      ]
    },
    {
      "id": 4,
      "title": "SSE Error Rate (Rule 6 baseline)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "description": "Streams that terminate with an error, by error_class. Server-side baseline of Rule 6 (AAP § 0.7.1.6).",
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
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
              { "color": "yellow", "value": 0.02 },
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
          "expr": "sum by (error_class) (rate(ai_chat_sse_error_total[5m])) / ignoring(error_class) group_left sum(rate(ai_chat_request_total[5m]))",
          "legendFormat": "{{error_class}}"
        }
      ]
    },
    {
      "id": 5,
      "title": "Model-Version Histogram (ANTHROPIC_MODEL)",
      "type": "barchart",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
      "description": "Distribution of Anthropic model identifiers via the ANTHROPIC_MODEL env var (AAP § 0.7.3). Read exclusively through ConfigService (Rule 3).",
      "fieldConfig": {
        "defaults": { "unit": "short" },
        "overrides": []
      },
      "options": {
        "orientation": "horizontal",
        "legend": { "displayMode": "list", "placement": "bottom" },
        "tooltip": { "mode": "single" }
      },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "sum by (model) (rate(ai_chat_request_total[5m]))",
          "legendFormat": "{{model}}"
        }
      ]
    },
    {
      "id": 6,
      "title": "End-to-End Stream Duration (p50 / p95 / p99)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 16 },
      "description": "Total time from request receipt to stream close. Captures full Claude generation including all tool round-trips.",
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 25 },
              { "color": "red", "value": 45 }
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
          "expr": "histogram_quantile(0.50, sum by (le) (rate(ai_chat_stream_duration_seconds_bucket[5m])))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.95, sum by (le) (rate(ai_chat_stream_duration_seconds_bucket[5m])))",
          "legendFormat": "p95"
        },
        {
          "refId": "C",
          "datasource": { "type": "prometheus", "uid": "Prometheus" },
          "expr": "histogram_quantile(0.99, sum by (le) (rate(ai_chat_stream_duration_seconds_bucket[5m])))",
          "legendFormat": "p99"
        }
      ]
    },
    {
      "id": 7,
      "title": "Personalization Data Fetch Latency (p95)",
      "type": "timeseries",
      "datasource": { "type": "prometheus", "uid": "Prometheus" },
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 24 },
      "description": "p95 latency of UserFinancialProfileService.findByUserId and PortfolioService.getDetails in the system-prompt build path. Slow personalization directly inflates first-token latency (Panel 2).",
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "custom": { "drawStyle": "line", "lineWidth": 2, "fillOpacity": 10 },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.5 },
              { "color": "red", "value": 1 }
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
          "expr": "histogram_quantile(0.95, sum by (le, source) (rate(ai_chat_personalization_fetch_seconds_bucket[5m])))",
          "legendFormat": "p95 {{source}}"
        }
      ]
    }
  ]
}
```

---

## References

- **AAP § 0.7.2 — Observability rule.** The application is not complete until it is observable. Every deliverable MUST include structured logging with correlation IDs, distributed tracing, a metrics endpoint, health/readiness checks, a dashboard template, and local-environment exercise of all of the above.
- **AAP § 0.7.1.6 — Rule 6 — SSE Disconnection Handling.** `ChatPanelComponent` MUST render a non-empty `errorMessage` and a visible reconnect button when the SSE stream terminates with an error. Silent stream failures with no UI state change are PROHIBITED. Panel 4 of this dashboard is the server-side baseline metric for Rule 6.
- **AAP § 0.7.5.2 — Chat agent gate.** `POST /api/v1/ai/chat` response has `Content-Type: text/event-stream`; the first SSE token arrives within 3 seconds on localhost with valid credentials; all four tools are present in the `tools` array submitted to the Anthropic SDK. Panel 2 surfaces the first-token target.
- **AAP § 0.5.1.5 — Chat-Agent Tool Schemas.** The four tools dispatched by `AiChatService.dispatchTool(...)` are `get_current_positions`, `get_performance_metrics`, `query_history`, and `get_market_data`. Panel 3 surfaces their distribution.
- **AAP § 0.7.3 — `ANTHROPIC_MODEL` env var.** The Claude model identifier is configurable via the `ANTHROPIC_MODEL` environment variable, read exclusively through `ConfigService` (Rule 3). Panel 5 surfaces the resulting `model` label distribution.
- **`apps/api/src/app/ai-chat/ai-chat.service.ts` — metric emission sites.** The `AiChatService` is responsible for emitting `ai_chat_request_total`, `ai_chat_input_tokens_total`, `ai_chat_output_tokens_total`, `ai_chat_first_token_latency_seconds`, `ai_chat_stream_duration_seconds`, `ai_chat_tool_invocation_total`, `ai_chat_personalization_fetch_seconds`, and `ai_chat_sse_error_total` via the injected `MetricsService`.
- **`apps/api/src/app/metrics/metrics.controller.ts` — metrics endpoint.** Exposes the in-process metrics registry as Prometheus-format text at `GET /api/v1/metrics`. Created per AAP § 0.5.1.2 alongside `MetricsModule` and `MetricsService`.
- **`apps/api/src/app/health/anthropic-health.indicator.ts` — health probe.** Exposes a configuration-only readiness probe at `GET /api/v1/health/anthropic` registered additively in `HealthModule`. Created per AAP § 0.5.1.2.

### Sibling dashboard templates

- **`docs/observability/snowflake-sync.md`** — Feature A (`SnowflakeSyncModule`) cron + event-listener sync metrics: success rate, sync latency, MERGE row counts, idempotency verification (Rule 7).
- **`docs/observability/ai-rebalancing.md`** — Feature C (`RebalancingModule`) non-streaming `POST /api/v1/ai/rebalancing` metrics: total request latency (primary), recommendation count per response, warnings rate, structured-output validation failures (Rule 4).
