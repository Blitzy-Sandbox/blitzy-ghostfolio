# AI Portfolio Chat — Observability Dashboard

## Overview

Operator dashboard for the **AI Portfolio Chat** feature exposed at
`POST /api/v1/ai/chat`. The dashboard tracks the three Prometheus metrics
emitted by `AiChatService` and exposed at `GET /api/v1/metrics`:

1. `ai_chat_streams_total` — terminal-outcome counter for every chat stream
   (success, error, cancelled).
2. `ai_chat_first_token_latency_seconds` — histogram of the wall-clock time
   between request entry into the controller and the first text token
   emitted by Claude. This is the primary user-perceived performance signal.
3. `ai_chat_tool_invocations_total` — counter of chat-tool dispatches,
   labelled by the four registered tool names
   (`get_current_positions`, `get_performance_metrics`, `query_history`,
   `get_market_data`).

The dashboard is intentionally scoped to **only** the metrics actually
emitted by `AiChatService`. Additional signals — Claude prompt and
completion token throughput, model-version distribution, server-side
personalisation latency, end-to-end stream duration — are **not** exposed
by this version of the service. Operators who require those signals must
either extend `AiChatService` to register and emit the corresponding
metrics or surface them through an upstream telemetry layer
(e.g., the Anthropic SDK's own observability hooks).

## Audience

- **Site Reliability Engineering / Platform Operations** — primary
  dashboard owners; on-call rotation watches first-token latency, error
  rate, and tool-invocation rate during incidents.
- **AI Feature Engineering** — secondary owners; review tool-call
  distribution shifts (an unexpected drop in `query_history` invocations
  may indicate a regression in the Snowflake history tool).

## Cross-references

- **AAP §0.1.1.1 / §0.5.1.1** — feature definition and emitted-metrics
  scope.
- **AAP §0.7.2 (Observability rule)** — mandates this dashboard template
  alongside structured logging, correlation IDs, the metrics endpoint,
  and the readiness probes.
- **Source of truth — service**:
  `apps/api/src/app/ai-chat/ai-chat.service.ts`. Specifically, metric
  registrations are at lines 207, 211, 215; emission sites are at lines
  330 (first-token latency), 389 (tool invocations), 460 (success
  outcome), 474 (cancelled outcome), 496 (error outcome).
- **Source of truth — metrics registry**:
  `apps/api/src/app/metrics/metrics.service.ts`. Default histogram
  buckets (in seconds) are
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
- **Spec coverage**: `apps/api/src/app/ai-chat/ai-chat.service.spec.ts`
  asserts that all three metrics are registered with the expected
  `registerHelp` strings and that label values are restricted to the
  enumerations above.

## Emitted Metrics — Authoritative Reference

| Metric                                | Type      | Labels                                                                                            | HELP text                                                                            |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ai_chat_streams_total`               | counter   | `outcome` ∈ {`success`, `error`, `cancelled`}                                                     | Total chat streams completed by terminal outcome (success, error, cancelled).        |
| `ai_chat_first_token_latency_seconds` | histogram | (none — single user-experience signal)                                                            | Latency in seconds between request start and the first text token emitted by Claude. |
| `ai_chat_tool_invocations_total`      | counter   | `tool` ∈ {`get_current_positions`, `get_performance_metrics`, `query_history`, `get_market_data`} | Total chat-tool invocations dispatched, labelled by tool name.                       |

The histogram exposes the canonical Prometheus suffixes
`_bucket{le="..."}`, `_sum`, and `_count`; the
`MetricsService.getRegistryAsText()` renderer pre-populates every default
bucket so that PromQL `histogram_quantile()` calls work from the first
observation onwards.

## Recommended Panels

The dashboard ships with six panels grouped into three rows. The top
row covers user-perceived latency (the headline SLI), the middle row
covers terminal stream outcomes (success / error / cancellation), and
the bottom row covers tool dispatch volume.

| #   | Panel                                 | Type                  | Primary Metric                               | Example PromQL                                                                                                  |
| --- | ------------------------------------- | --------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | First-Token Latency (p50 / p95 / p99) | Time series           | `ai_chat_first_token_latency_seconds`        | `histogram_quantile(0.95, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))`                  |
| 2   | First-Token Latency Distribution      | Heatmap               | `ai_chat_first_token_latency_seconds_bucket` | `sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m]))`                                            |
| 3   | Stream Outcome Distribution           | Time series (stacked) | `ai_chat_streams_total`                      | `sum by (outcome) (rate(ai_chat_streams_total[5m]))`                                                            |
| 4   | Stream Error Rate                     | Stat (single-value)   | `ai_chat_streams_total{outcome="error"}`     | `sum(rate(ai_chat_streams_total{outcome="error"}[5m])) / clamp_min(sum(rate(ai_chat_streams_total[5m])), 1e-9)` |
| 5   | Tool-Call Distribution                | Bar chart             | `ai_chat_tool_invocations_total`             | `sum by (tool) (increase(ai_chat_tool_invocations_total[1h]))`                                                  |
| 6   | Tool Invocation Rate                  | Time series           | `ai_chat_tool_invocations_total`             | `sum by (tool) (rate(ai_chat_tool_invocations_total[5m]))`                                                      |

### Panel 1 — First-Token Latency (p50 / p95 / p99)

The headline SLI for the chat experience. `ai_chat_first_token_latency_seconds`
is observed exactly once per stream, when the first text token from Claude
is forwarded to the Server-Sent Events response (`ai-chat.service.ts:330`).
The panel renders three series — p50, p95, p99 — over a five-minute
rolling window, computed via `histogram_quantile()` against the
bucket counter. Recommended visual threshold: green ≤ 1 s, amber
1 s–3 s, red > 3 s on the p95 series. The 3 s threshold matches the
acceptance gate in AAP §0.7.5.2 ("the first SSE token arrives within
3 seconds on localhost with valid credentials").

### Panel 2 — First-Token Latency Distribution (Heatmap)

A heatmap of `ai_chat_first_token_latency_seconds_bucket` over time
provides operators with a richer view than the quantile lines alone —
shifts in the bucket distribution (e.g., a cluster of observations
moving from the `le="0.5"` bucket to the `le="2.5"` bucket without
breaching p95) flag emerging upstream slowness before SLO breaches.
The heatmap reuses the same default buckets:
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.

### Panel 3 — Stream Outcome Distribution

Stacked time series of `ai_chat_streams_total` partitioned by the
`outcome` label. Operators can see at a glance the composition of
terminal stream outcomes — `success` should dominate during steady
state, `cancelled` may rise during routine UI navigation (subscriber
unsubscribes), and a sustained increase in `error` is the principal
incident signal for the chat feature.

### Panel 4 — Stream Error Rate

`error` outcome rate divided by total stream rate — a single-value
percentage that maps directly to the chat feature's reliability SLO.
The expression uses `clamp_min(..., 1e-9)` in the denominator to avoid
division-by-zero when no streams are in flight. Recommended thresholds:
green ≤ 1 %, amber 1 %–5 %, red > 5 %. A sustained breach of the red
threshold should trigger paging via the `AiChatStreamErrorRateHigh`
rule below.

### Panel 5 — Tool-Call Distribution

`sum by (tool) (increase(ai_chat_tool_invocations_total[1h]))` bar
chart showing the relative volume of each of the four registered
chat tools over the previous hour. Useful to spot regressions in the
agent's tool selection — for example, an extended period in which
`query_history` is never invoked despite user questions about
historical performance suggests the Snowflake history tool is being
silently bypassed.

### Panel 6 — Tool Invocation Rate

`sum by (tool) (rate(ai_chat_tool_invocations_total[5m]))` time
series. Complements the bar chart by showing trend rather than
aggregate volume. Sudden spikes in any single tool (especially
`query_history`) may correlate with Snowflake load events.

## Alert Rules

Recommended Prometheus alerting rules. Adjust thresholds and `for`
windows for the operating environment.

```yaml
groups:
  - name: ai-chat
    rules:
      - alert: AiChatFirstTokenLatencyHigh
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m]))
          ) > 3
        for: 10m
        labels:
          severity: page
          feature: ai-chat
        annotations:
          summary: 'AI Chat first-token latency p95 above 3 s'
          description: |
            ai_chat_first_token_latency_seconds p95 has exceeded 3 s for
            10 minutes. The 3 s threshold is the acceptance gate from
            AAP §0.7.5.2. Check Anthropic API status, the
            /api/v1/health/anthropic probe, and the application logs
            (filter by [AiChatService] and the affected correlationId).

      - alert: AiChatStreamErrorRateHigh
        expr: |
          sum(rate(ai_chat_streams_total{outcome="error"}[5m]))
            /
          clamp_min(sum(rate(ai_chat_streams_total[5m])), 1e-9)
            > 0.05
        for: 10m
        labels:
          severity: page
          feature: ai-chat
        annotations:
          summary: 'AI Chat stream error rate above 5%'
          description: |
            More than 5 % of chat streams have terminated in the
            error outcome over the last 10 minutes. Inspect the
            structured logs ([AiChatService] chat stream error) and
            cross-reference correlationId values with Anthropic-side
            telemetry. Likely root causes: invalid ANTHROPIC_API_KEY,
            Anthropic outage, or a regression in tool dispatch.

      - alert: AiChatStreamCancellationSpike
        expr: |
          sum(rate(ai_chat_streams_total{outcome="cancelled"}[5m]))
            /
          clamp_min(sum(rate(ai_chat_streams_total[5m])), 1e-9)
            > 0.5
        for: 5m
        labels:
          severity: warning
          feature: ai-chat
        annotations:
          summary: 'AI Chat cancellation rate above 50%'
          description: |
            Over half of recent chat streams ended in the cancelled
            outcome. Cancellation is normal when users navigate away
            mid-stream, but a sustained majority is consistent with
            a client-side defect (e.g., the chat panel re-mounting
            and tearing down EventSource on every render). Inspect
            ChatPanelComponent and recent client deploys.

      - alert: AiChatNoActivity
        expr: |
          sum(rate(ai_chat_streams_total[5m])) == 0
        for: 30m
        labels:
          severity: warning
          feature: ai-chat
        annotations:
          summary: 'AI Chat has no traffic for 30 minutes'
          description: |
            ai_chat_streams_total has not incremented for the last
            30 minutes. During expected traffic windows this is
            consistent with the SSE endpoint being unreachable
            (e.g., reverse-proxy or auth regression). Verify
            POST /api/v1/ai/chat with a known-good JWT and inspect
            the application access log.

      - alert: AiChatToolDistributionAnomaly
        expr: |
          sum by (tool) (rate(ai_chat_tool_invocations_total[1h]))
            == 0
            and on(tool)
          sum by (tool) (rate(ai_chat_tool_invocations_total[24h] offset 1h))
            > 0
        for: 30m
        labels:
          severity: warning
          feature: ai-chat
        annotations:
          summary: 'Chat tool {{ $labels.tool }} not invoked for an hour'
          description: |
            Tool {{ $labels.tool }} has been invoked at least once
            over the past 24 hours but has had zero invocations for
            the most recent hour. Consistent with a regression in the
            agent prompt, the tool schema, or the underlying service
            (e.g., SnowflakeSyncService for query_history).
```

## Local Development Verification

The following procedure exercises every metric in the local
development environment, satisfying the AAP §0.7.2 Observability
mandate that "all observability MUST be exercised in the local
development environment."

1. **Bring up the API.** From the repository root, start Postgres and
   Redis (`docker compose -f docker/docker-compose.dev.yml up -d`),
   then start the API in development mode
   (`npx nx serve api`). Wait for the bootstrap log line
   `Nest application successfully started`.
2. **Mint a development JWT.** Create a user via
   `POST /api/v1/user` (no body required), capture the returned
   `authToken`, and export it as `JWT=...` in the shell.
3. **Confirm the registry is populated with the expected HELP lines.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^# (HELP|TYPE) ai_chat_'
   ```

   Expected output (order may vary):

   ```text
   # HELP ai_chat_first_token_latency_seconds Latency in seconds between request start and the first text token emitted by Claude.
   # TYPE ai_chat_first_token_latency_seconds histogram
   # HELP ai_chat_streams_total Total chat streams completed by terminal outcome (success, error, cancelled).
   # TYPE ai_chat_streams_total counter
   # HELP ai_chat_tool_invocations_total Total chat-tool invocations dispatched, labelled by tool name.
   # TYPE ai_chat_tool_invocations_total counter
   ```

4. **Issue a chat request.** With a valid `ANTHROPIC_API_KEY` exported,
   open an SSE stream:

   ```bash
   curl -N -H "Authorization: Bearer $JWT" \
        -H "Content-Type: application/json" \
        -X POST http://localhost:3333/api/v1/ai/chat \
        -d '{"messages":[{"role":"user","content":"Show my current positions"}]}'
   ```

   Allow the stream to complete (Ctrl-C after the final
   `data: [DONE]` event). The chat agent will likely dispatch
   `get_current_positions` at least once, exercising the tool-call
   counter.

5. **Observe `ai_chat_streams_total` increment.** Re-scrape the
   metrics endpoint and confirm an entry for
   `outcome="success"` (or `"error"` if the request failed):

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^ai_chat_streams_total\{'
   ```

   Expected (sample):

   ```text
   ai_chat_streams_total{outcome="success"} 1
   ```

6. **Observe `ai_chat_first_token_latency_seconds` populate.** The
   histogram exposes its full bucket ladder plus `_sum` and
   `_count`:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^ai_chat_first_token_latency_seconds(_bucket|_sum|_count)'
   ```

   Expected to show every default bucket
   (`le="0.005"` through `le="10"` and `le="+Inf"`) plus
   non-zero `_sum` and `_count` after one observation.

7. **Observe `ai_chat_tool_invocations_total` increment.** If the
   chat agent dispatched any tool during the request:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^ai_chat_tool_invocations_total\{'
   ```

   Expected (one line per tool actually dispatched):

   ```text
   ai_chat_tool_invocations_total{tool="get_current_positions"} 1
   ```

8. **Trigger the cancellation path.** Issue another chat request and
   abort the SSE stream client-side before completion (`Ctrl-C`
   immediately after the first event). Re-scrape the metrics and
   confirm an entry for `outcome="cancelled"`.

9. **Trigger the error path.** Restart the API with
   `ANTHROPIC_API_KEY=invalid` (or any value that triggers an
   Anthropic 401), issue another chat request, and confirm
   `outcome="error"` increments. The HTTP 502 / SSE error frame
   contract is also exercised by the `ChatPanelComponent` Rule 6
   reconnect button.

If any of the steps above does not produce the expected line, the
dashboard cannot render correctly. Inspect the structured logs (each
line is prefixed with `[AiChatService] [<correlationId>]`) and the
service source (`ai-chat.service.ts`) before declaring the dashboard
broken.

## JSON Dashboard Definition

A self-contained Grafana 9+ dashboard ready for import. Datasource
UID is parameterised via `${DS_PROMETHEUS}` — replace with the
local datasource UID before import.

```json
{
  "title": "AI Portfolio Chat",
  "tags": ["ghostfolio", "ai-chat", "ai", "blitzy"],
  "schemaVersion": 38,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-1h", "to": "now" },
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
        "name": "tool",
        "label": "Tool",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
        "query": "label_values(ai_chat_tool_invocations_total, tool)",
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
      "title": "First-Token Latency (p50 / p95 / p99)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 1 },
              { "color": "red", "value": 3 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.5, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "expr": "histogram_quantile(0.95, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))",
          "legendFormat": "p95"
        },
        {
          "refId": "C",
          "expr": "histogram_quantile(0.99, sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m])))",
          "legendFormat": "p99"
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
      "title": "First-Token Latency Distribution",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "s" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (le) (rate(ai_chat_first_token_latency_seconds_bucket[5m]))",
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
      "title": "Stream Outcome Distribution (rate / 5m)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 8, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "ops",
          "custom": { "stacking": { "mode": "normal" } }
        },
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
            "matcher": { "id": "byName", "options": "error" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "red" }
              }
            ]
          },
          {
            "matcher": { "id": "byName", "options": "cancelled" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "yellow" }
              }
            ]
          }
        ]
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (outcome) (rate(ai_chat_streams_total[5m]))",
          "legendFormat": "{{outcome}}"
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
      "title": "Stream Error Rate",
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
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.01 },
              { "color": "red", "value": 0.05 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(rate(ai_chat_streams_total{outcome=\"error\"}[5m])) / clamp_min(sum(rate(ai_chat_streams_total[5m])), 1e-9)",
          "legendFormat": "error rate"
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
      "type": "barchart",
      "title": "Tool-Call Distribution (last 1h)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 16, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "short" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (tool) (increase(ai_chat_tool_invocations_total{tool=~\"$tool\"}[1h]))",
          "legendFormat": "{{tool}}",
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
      "type": "timeseries",
      "title": "Tool Invocation Rate (per 5m)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 16, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "ops" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (tool) (rate(ai_chat_tool_invocations_total{tool=~\"$tool\"}[5m]))",
          "legendFormat": "{{tool}}"
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

- **Service** — `apps/api/src/app/ai-chat/ai-chat.service.ts`.
- **Controller** — `apps/api/src/app/ai-chat/ai-chat.controller.ts`.
- **Module** — `apps/api/src/app/ai-chat/ai-chat.module.ts`.
- **Metrics registry** — `apps/api/src/app/metrics/metrics.service.ts`,
  `apps/api/src/app/metrics/metrics.controller.ts`.
- **Health probe** — `/api/v1/health/anthropic` (config-only probe;
  does not exercise outbound Anthropic calls).
- **Endpoint** — `POST /api/v1/ai/chat` (Server-Sent Events; max 5
  messages per request per `ChatRequestDto`).
- **AAP** — §0.1.1 (feature definition), §0.5.1.1 (emitted-metrics
  scope), §0.7.2 (Observability rule), §0.7.5.2 (3 s first-token
  acceptance gate).

### Metric Names (Authoritative List)

The dashboard, alerting rules, and verification commands above
reference **only** the three metric names below. Any metric name not
appearing in this list is not emitted by `AiChatService` and will
yield empty Grafana panels if referenced.

- `ai_chat_streams_total` (counter; labels: `outcome`)
- `ai_chat_first_token_latency_seconds` (histogram; no labels)
- `ai_chat_tool_invocations_total` (counter; labels: `tool`)
