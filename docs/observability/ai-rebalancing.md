# AI Rebalancing Engine — Observability Dashboard

## Overview

Operator dashboard for the **Explainable Rebalancing Engine** exposed at
`POST /api/v1/ai/rebalancing`. The dashboard tracks the two Prometheus
metrics emitted by `RebalancingService` and exposed at
`GET /api/v1/metrics`:

1. `rebalancing_requests_total` — terminal-outcome counter for every
   call to `RebalancingService.recommend()`. Labelled by the four
   outcomes assigned in the service (`success`, `no_tool_use`,
   `shape_invalid`, `error`).
2. `rebalancing_latency_seconds` — histogram of end-to-end wall-clock
   latency from method entry through structured-output validation.

The dashboard is intentionally scoped to **only** the metrics actually
emitted by `RebalancingService`. Additional signals — per-recommendation
counts, warnings counts, goal-reference completeness, finer-grained
Anthropic API error classes — are **not** exposed as separate metrics
by this version of the service. The four outcomes nevertheless cover
all distinct failure modes that AAP Rule 4 cares about: `no_tool_use`
(Anthropic returned a text-only response with no `tool_use` block;
direct Rule 4 violation), `shape_invalid` (the `tool_use.input` payload
failed structural validation against `RebalancingResponse`), and
`error` (any other unexpected failure, including upstream Anthropic
authentication errors). Operators who require finer dimensions must
either extend `RebalancingService` to register additional metrics or
inspect the structured logs (every line is prefixed with
`[RebalancingService] [<correlationId>]`).

## Audience

- **Site Reliability Engineering / Platform Operations** — primary
  dashboard owners; on-call rotation watches latency, success rate,
  and tool-use validation failures during incidents.
- **AI Feature Engineering** — secondary owners; review the relative
  share of `no_tool_use` and `shape_invalid` outcomes, which together
  measure how often Claude fails to honour the forced-tool prompt
  contract or returns an off-schema payload.

## Cross-references

- **AAP §0.1.1 / §0.5.1.1** — feature definition (Feature C —
  Explainable Rebalancing Engine) and emitted-metrics scope.
- **AAP §0.7.1.4 (Rule 4)** — `RebalancingService` MUST populate
  `RebalancingResponse` exclusively from a `tool_use` content block.
  The `no_tool_use` and `shape_invalid` outcomes on
  `rebalancing_requests_total` are the runtime telemetry that
  enforces this rule.
- **AAP §0.7.2 (Observability rule)** — mandates this dashboard
  template alongside structured logging, correlation IDs, the metrics
  endpoint, and the readiness probes.
- **Source of truth — service**:
  `apps/api/src/app/rebalancing/rebalancing.service.ts`. Specifically,
  metric registrations are at lines 222 and 227; outcome variable
  assignments are at lines 322 (`no_tool_use`), 344 and 370
  (`shape_invalid`), 382 (`success`), 406 (`error`); both metrics
  emit from a single `finally` block at lines 431 and 436.
- **Source of truth — metrics registry**:
  `apps/api/src/app/metrics/metrics.service.ts`. Default histogram
  buckets (in seconds) are
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
- **Spec coverage**:
  `apps/api/src/app/rebalancing/rebalancing.service.spec.ts`
  exercises every outcome path and asserts that the corresponding
  counter increment fires.

## Emitted Metrics — Authoritative Reference

| Metric                        | Type      | Labels                                                           | HELP text                                                                                                                                       |
| ----------------------------- | --------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `rebalancing_requests_total`  | counter   | `outcome` ∈ {`success`, `no_tool_use`, `shape_invalid`, `error`} | Total rebalancing recommendation requests handled by RebalancingService, labeled by outcome (success \| no_tool_use \| shape_invalid \| error). |
| `rebalancing_latency_seconds` | histogram | (none — single end-to-end signal)                                | End-to-end wall-clock latency of RebalancingService.recommend() in seconds, measured from method entry through structured-output validation.    |

The histogram exposes the canonical Prometheus suffixes
`_bucket{le="..."}`, `_sum`, and `_count`; the
`MetricsService.getRegistryAsText()` renderer pre-populates every
default bucket so that PromQL `histogram_quantile()` calls work from
the first observation onwards.

### Outcome semantics

| Outcome         | Meaning                                                                                                                                                                                                                            | Source line                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `success`       | The Anthropic response contained a `tool_use` block whose `input` validated against the `RebalancingResponse` shape. The structured payload is returned to the caller.                                                             | `rebalancing.service.ts:382`      |
| `no_tool_use`   | The Anthropic response contained **no** `tool_use` content block — Claude declined to invoke the forced tool and returned text only. Direct AAP Rule 4 violation; the controller raises `BadGatewayException`.                     | `rebalancing.service.ts:322`      |
| `shape_invalid` | The `tool_use.input` payload was present but failed structural validation (top-level fields missing or an individual recommendation missing required fields such as `goalReference`). The controller raises `BadGatewayException`. | `rebalancing.service.ts:344, 370` |
| `error`         | Any other failure during `recommend()` — upstream Anthropic authentication errors, network failures, or unexpected exceptions. The controller raises `BadGatewayException`.                                                        | `rebalancing.service.ts:406`      |

## Recommended Panels

The dashboard ships with six panels grouped into three rows. The top
row covers wall-clock latency, the middle row covers terminal request
outcomes, and the bottom row provides AAP Rule 4 compliance signals.

| #   | Panel                                     | Type                  | Primary Metric                                                      | Example PromQL                                                                                                                                  |
| --- | ----------------------------------------- | --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rebalancing Latency (p50 / p95 / p99)     | Time series           | `rebalancing_latency_seconds`                                       | `histogram_quantile(0.95, sum by (le) (rate(rebalancing_latency_seconds_bucket[5m])))`                                                          |
| 2   | Rebalancing Latency Distribution          | Heatmap               | `rebalancing_latency_seconds_bucket`                                | `sum by (le) (rate(rebalancing_latency_seconds_bucket[5m]))`                                                                                    |
| 3   | Request Outcome Distribution              | Time series (stacked) | `rebalancing_requests_total`                                        | `sum by (outcome) (rate(rebalancing_requests_total[5m]))`                                                                                       |
| 4   | Success Rate                              | Stat (single-value)   | `rebalancing_requests_total{outcome="success"}`                     | `sum(rate(rebalancing_requests_total{outcome="success"}[5m])) / clamp_min(sum(rate(rebalancing_requests_total[5m])), 1e-9)`                     |
| 5   | Tool-Use Validation Failure Rate (Rule 4) | Stat (single-value)   | `rebalancing_requests_total{outcome=~"no_tool_use\|shape_invalid"}` | `sum(rate(rebalancing_requests_total{outcome=~"no_tool_use\|shape_invalid"}[5m])) / clamp_min(sum(rate(rebalancing_requests_total[5m])), 1e-9)` |
| 6   | Request Volume                            | Time series           | `rebalancing_requests_total`                                        | `sum(rate(rebalancing_requests_total[5m]))`                                                                                                     |

### Panel 1 — Rebalancing Latency (p50 / p95 / p99)

The headline operator SLI for the rebalancing endpoint.
`rebalancing_latency_seconds` is observed exactly once per request, in
the `finally` block of `recommend()` (`rebalancing.service.ts:436`),
which guarantees the histogram is recorded for every outcome
including failures. The panel renders three series — p50, p95,
p99 — over a five-minute rolling window, computed via
`histogram_quantile()` against the bucket counter. Recommended visual
threshold: green ≤ 5 s, amber 5 s–15 s, red > 15 s on the p95 series.
A breach of red on p95 typically indicates Anthropic-side slowness
or a token-count regression in the system prompt.

### Panel 2 — Rebalancing Latency Distribution (Heatmap)

A heatmap of `rebalancing_latency_seconds_bucket` over time provides
operators with a richer view than the quantile lines alone — shifts
in the bucket distribution flag emerging upstream slowness before
SLO breaches. The heatmap reuses the default buckets
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.
Note that rebalancing observations almost always cluster near the
upper end of the ladder; the `+Inf` bucket count equals the total
observation count and must not be misread as an anomaly.

### Panel 3 — Request Outcome Distribution

Stacked time series of `rebalancing_requests_total` partitioned by
the `outcome` label. Operators can see at a glance the composition
of terminal outcomes — `success` should dominate during steady state.
Sustained increases in any of the three failure outcomes are the
principal incident signals for the rebalancing feature, and each has
a different remediation path:

- `no_tool_use` → check the system prompt and the `tool_choice`
  parameter; consider whether a recent Claude model rotation
  changed the forced-tool semantics.
- `shape_invalid` → check the `tool` schema and the runtime
  validator; an `input_schema` regression or an Anthropic-side
  schema interpretation change is the most likely cause.
- `error` → inspect `[RebalancingService]` log lines correlated by
  `correlationId`; common causes are missing/invalid
  `ANTHROPIC_API_KEY` or transient Anthropic outages.

### Panel 4 — Success Rate

`success` outcome rate divided by total request rate — a
single-value percentage that maps directly to the rebalancing
feature's reliability SLO. The expression uses `clamp_min(..., 1e-9)`
in the denominator to avoid division-by-zero when no requests are
in flight. Recommended thresholds: green ≥ 95 %, amber 90 %–95 %,
red < 90 %.

### Panel 5 — Tool-Use Validation Failure Rate (Rule 4 baseline)

The combined rate of `no_tool_use` and `shape_invalid` outcomes
divided by total request rate. This panel exists to surface AAP
**Rule 4** violations: every increment of either outcome means
Claude either refused the forced tool or returned a payload that
did not match the `RebalancingResponse` schema. A non-zero baseline
is expected (Claude occasionally emits malformed JSON), but a
sustained breach should trigger the
`RebalancingToolUseValidationFailureHigh` alert below.

### Panel 6 — Request Volume

`sum(rate(rebalancing_requests_total[5m]))` time series.
Establishes the traffic baseline for the endpoint and complements
the rate-based panels — without volume context, percentage-based
panels can hide low-traffic anomalies (e.g., a 50 % error rate over
two requests is far less informative than 50 % over two thousand).

## Alert Rules

Recommended Prometheus alerting rules. Adjust thresholds and `for`
windows for the operating environment.

```yaml
groups:
  - name: ai-rebalancing
    rules:
      - alert: RebalancingLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(rebalancing_latency_seconds_bucket[5m]))
          ) > 15
        for: 10m
        labels:
          severity: page
          feature: ai-rebalancing
        annotations:
          summary: 'Rebalancing latency p95 above 15 s'
          description: |
            rebalancing_latency_seconds p95 has exceeded 15 s for
            10 minutes. Check Anthropic API status, the
            /api/v1/health/anthropic probe, and the application logs
            (filter by [RebalancingService] and the affected
            correlationId).

      - alert: RebalancingSuccessRateLow
        expr: |
          sum(rate(rebalancing_requests_total{outcome="success"}[10m]))
            /
          clamp_min(sum(rate(rebalancing_requests_total[10m])), 1e-9)
            < 0.9
        for: 15m
        labels:
          severity: page
          feature: ai-rebalancing
        annotations:
          summary: 'Rebalancing success rate below 90%'
          description: |
            Fewer than 90 % of rebalancing requests have succeeded
            over the last 15 minutes. Inspect the per-outcome series
            on the Request Outcome Distribution panel to determine
            whether the failures are concentrated in no_tool_use,
            shape_invalid, or error.

      - alert: RebalancingToolUseValidationFailureHigh
        expr: |
          sum(rate(rebalancing_requests_total{outcome=~"no_tool_use|shape_invalid"}[15m]))
            /
          clamp_min(sum(rate(rebalancing_requests_total[15m])), 1e-9)
            > 0.05
        for: 15m
        labels:
          severity: page
          feature: ai-rebalancing
          rule: aap-rule-4
        annotations:
          summary: 'Rebalancing tool-use validation failure rate above 5%'
          description: |
            More than 5 % of rebalancing requests have terminated with
            outcome no_tool_use or shape_invalid over the last
            15 minutes — a direct signal of AAP Rule 4 breaches.
            Likely root causes: Anthropic model rotation altered the
            forced-tool semantics, the rebalancing tool input_schema
            drifted from the RebalancingResponse contract, or the
            structural validator logic changed.

      - alert: RebalancingErrorOutcomeBurst
        expr: |
          sum(rate(rebalancing_requests_total{outcome="error"}[5m]))
            /
          clamp_min(sum(rate(rebalancing_requests_total[5m])), 1e-9)
            > 0.1
        for: 5m
        labels:
          severity: page
          feature: ai-rebalancing
        annotations:
          summary: 'Rebalancing error outcome rate above 10%'
          description: |
            More than 10 % of rebalancing requests have terminated in
            outcome=error over the last 5 minutes. The error outcome
            captures all failure modes other than Rule-4 validation —
            typical causes are an invalid ANTHROPIC_API_KEY, a network
            partition, or an Anthropic API incident. Cross-reference
            the Anthropic status page and the structured logs.

      - alert: RebalancingNoActivity
        expr: |
          sum(rate(rebalancing_requests_total[15m])) == 0
        for: 1h
        labels:
          severity: warning
          feature: ai-rebalancing
        annotations:
          summary: 'Rebalancing endpoint has no traffic for 1 hour'
          description: |
            rebalancing_requests_total has not incremented for the last
            hour. During expected traffic windows this is consistent
            with the endpoint being unreachable (reverse-proxy or auth
            regression). Verify POST /api/v1/ai/rebalancing with a
            known-good JWT and inspect the application access log.
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
   `POST /api/v1/user`, capture the returned `authToken`, and export
   it as `JWT=...` in the shell.
3. **Confirm the registry is populated with the expected HELP lines.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^# (HELP|TYPE) rebalancing_'
   ```

   Expected output (order may vary):

   ```text
   # HELP rebalancing_latency_seconds End-to-end wall-clock latency of RebalancingService.recommend() in seconds, measured from method entry through structured-output validation.
   # TYPE rebalancing_latency_seconds histogram
   # HELP rebalancing_requests_total Total rebalancing recommendation requests handled by RebalancingService, labeled by outcome (success | no_tool_use | shape_invalid | error).
   # TYPE rebalancing_requests_total counter
   ```

4. **Issue a rebalancing request (success path).** With a valid
   `ANTHROPIC_API_KEY` exported and a populated portfolio:

   ```bash
   curl -s -H "Authorization: Bearer $JWT" \
        -H "Content-Type: application/json" \
        -X POST http://localhost:3333/api/v1/ai/rebalancing \
        -d '{}' \
     | python3 -m json.tool
   ```

   Expected: HTTP 200 with a `RebalancingResponse` JSON object
   containing a non-empty `recommendations` array.

5. **Observe `rebalancing_requests_total` increment.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^rebalancing_requests_total\{'
   ```

   Expected (sample):

   ```text
   rebalancing_requests_total{outcome="success"} 1
   ```

6. **Observe `rebalancing_latency_seconds` populate.**

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^rebalancing_latency_seconds(_bucket|_sum|_count)'
   ```

   Expected to show every default bucket
   (`le="0.005"` through `le="10"` and `le="+Inf"`) plus
   non-zero `_sum` and `_count` after one observation.

7. **Trigger the `error` outcome path.** Restart the API with
   `ANTHROPIC_API_KEY=invalid` (or any value that causes Anthropic
   to return 401), repeat step 4, and confirm the controller
   responds with HTTP 502 and that
   `rebalancing_requests_total{outcome="error"}` increments.

8. **(Optional) Trigger the `no_tool_use` and `shape_invalid` paths
   in a unit-test harness.** These outcomes require Anthropic to
   return a payload that violates the forced-tool contract. The
   spec suite at
   `apps/api/src/app/rebalancing/rebalancing.service.spec.ts`
   uses a mocked SDK to deterministically exercise both paths;
   reproducing them at runtime requires either a synthetic
   `Anthropic` client stub injected via the DI container or a test
   mode that returns canned responses.

If any of the steps above does not produce the expected line, the
dashboard cannot render correctly. Inspect the structured logs (each
line is prefixed with `[RebalancingService] [<correlationId>]`) and
the service source (`rebalancing.service.ts`) before declaring the
dashboard broken.

## JSON Dashboard Definition

A self-contained Grafana 9+ dashboard ready for import. Datasource
UID is parameterised via `${DS_PROMETHEUS}` — replace with the
local datasource UID before import.

```json
{
  "title": "AI Rebalancing Engine",
  "tags": ["ghostfolio", "ai-rebalancing", "ai", "blitzy"],
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
        "name": "outcome",
        "label": "Outcome",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
        "query": "label_values(rebalancing_requests_total, outcome)",
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
      "title": "Rebalancing Latency (p50 / p95 / p99)",
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
              { "color": "red", "value": 15 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.5, sum by (le) (rate(rebalancing_latency_seconds_bucket[5m])))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "expr": "histogram_quantile(0.95, sum by (le) (rate(rebalancing_latency_seconds_bucket[5m])))",
          "legendFormat": "p95"
        },
        {
          "refId": "C",
          "expr": "histogram_quantile(0.99, sum by (le) (rate(rebalancing_latency_seconds_bucket[5m])))",
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
      "title": "Rebalancing Latency Distribution",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "s" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (le) (rate(rebalancing_latency_seconds_bucket[5m]))",
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
      "title": "Request Outcome Distribution (rate / 5m)",
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
            "matcher": { "id": "byName", "options": "no_tool_use" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "orange" }
              }
            ]
          },
          {
            "matcher": { "id": "byName", "options": "shape_invalid" },
            "properties": [
              {
                "id": "color",
                "value": { "mode": "fixed", "fixedColor": "yellow" }
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
          }
        ]
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (outcome) (rate(rebalancing_requests_total{outcome=~\"$outcome\"}[5m]))",
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
      "title": "Success Rate",
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
              { "color": "yellow", "value": 0.9 },
              { "color": "green", "value": 0.95 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(rate(rebalancing_requests_total{outcome=\"success\"}[5m])) / clamp_min(sum(rate(rebalancing_requests_total[5m])), 1e-9)",
          "legendFormat": "success rate"
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
      "title": "Tool-Use Validation Failure Rate (Rule 4)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 18, "y": 8, "w": 6, "h": 8 },
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
          "expr": "sum(rate(rebalancing_requests_total{outcome=~\"no_tool_use|shape_invalid\"}[5m])) / clamp_min(sum(rate(rebalancing_requests_total[5m])), 1e-9)",
          "legendFormat": "rule-4 failure rate"
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
      "title": "Request Volume (per 5m)",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 16, "w": 24, "h": 6 },
      "fieldConfig": {
        "defaults": { "unit": "ops" },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(rate(rebalancing_requests_total[5m]))",
          "legendFormat": "requests / s"
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

- **Service** — `apps/api/src/app/rebalancing/rebalancing.service.ts`.
- **Controller** —
  `apps/api/src/app/rebalancing/rebalancing.controller.ts`.
- **Module** — `apps/api/src/app/rebalancing/rebalancing.module.ts`.
- **Metrics registry** — `apps/api/src/app/metrics/metrics.service.ts`,
  `apps/api/src/app/metrics/metrics.controller.ts`.
- **Health probe** — `/api/v1/health/anthropic` (config-only probe;
  does not exercise outbound Anthropic calls).
- **Endpoint** — `POST /api/v1/ai/rebalancing` (returns
  `RebalancingResponse` JSON; non-streaming per AAP §0.7.3).
- **Shared interface** —
  `libs/common/src/lib/interfaces/rebalancing-response.interface.ts`.
- **AAP** — §0.1.1 (feature definition), §0.5.1.1 (emitted-metrics
  scope), §0.7.1.4 (Rule 4: structured tool-use only),
  §0.7.2 (Observability rule).

### Metric Names (Authoritative List)

The dashboard, alerting rules, and verification commands above
reference **only** the two metric names below. Any metric name not
appearing in this list is not emitted by `RebalancingService` and
will yield empty Grafana panels if referenced.

- `rebalancing_requests_total` (counter; labels: `outcome` ∈
  {`success`, `no_tool_use`, `shape_invalid`, `error`})
- `rebalancing_latency_seconds` (histogram; no labels)
