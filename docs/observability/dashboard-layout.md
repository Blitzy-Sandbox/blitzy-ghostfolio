# Dashboard Layout — Observability Dashboard

## Overview

Operator dashboard for the **Modular Dashboard Layout** persistence
layer introduced by the dashboard refactor (AAP § 0.1.1). The dashboard
tracks the four Prometheus metrics emitted by
`UserDashboardLayoutService` and exposed at `GET /api/v1/metrics`,
plus the structured log lines emitted on every request to the two
new endpoints `GET /api/v1/user/layout` and
`PATCH /api/v1/user/layout`:

1. `dashboard_layout_get_total` — counter; terminal-outcome counter
   for every `GET /api/v1/user/layout` invocation. Labelled by
   `outcome` (`found`, `not_found`, `error`).
2. `dashboard_layout_patch_total` — counter; terminal-outcome counter
   for every `PATCH /api/v1/user/layout` invocation. Labelled by
   `outcome` (`success`, `error`).
3. `dashboard_layout_save_failures_total` — counter; per-reason
   breakdown of layout save failures. Labelled by `reason`
   (`db_error` — single value emitted on Prisma upsert failure).
4. `dashboard_layout_request_duration_seconds` — histogram; end-to-end
   wall-clock latency of layout endpoint requests, partitioned by
   `method` (`GET` or `PATCH`).

The dashboard is intentionally scoped to **only** the metrics actually
emitted by `UserDashboardLayoutService`. The following signals are
**out of scope** for this dashboard:

- Per-module rendering performance (each module's content service
  has its own observability surface — for example, AI chat is
  covered by `docs/observability/ai-chat.md`).
- Gridster-internal frame timings (drag/resize math runs inside
  `NgZone.runOutsideAngular` and is not exposed to operators).
- Individual module data fetches (`PortfolioService`,
  `SymbolService`, `AiChatService`, `RebalancingService`,
  `FinancialProfileService` retain their existing observability and
  are not mirrored here).
- Client-side bundle-load timings (covered by the existing service
  worker telemetry; not part of this runbook).

Frontend telemetry — specifically the drag/resize visual completion
latency that backs the `< 100 ms` SLO target — is emitted by
`apps/client/src/app/dashboard/services/dashboard-telemetry.service.ts`
to the browser console in development mode and is documented in the
"Frontend Telemetry" subsection of § Correlation-ID Propagation
below. Server-side metrics ARE the operational contract for SRE;
frontend telemetry is dev-time validation only and is not currently
exported to Prometheus (a future server-side beacon endpoint may
capture it; out of scope per AAP § 0.7.3).

The four metrics support the SLO targets enumerated in
AAP § 0.6.3.3: GET p95 ≤ 300 ms, PATCH p95 ≤ 500 ms, drag/resize
visual completion < 100 ms (frontend telemetry only), and layout
save debounce ≥ 500 ms (implementation guarantee inside
`LayoutPersistenceService`).

## Audience

- **Site Reliability Engineering / Platform Operations** — primary
  dashboard owners; on-call rotation watches GET/PATCH p95 latency,
  error rate, and authentication failure rates during incidents.
  The Alert Rules section below pages on sustained breach of the
  AAP-level acceptance gates.
- **Frontend Engineering** — secondary owners; consume the
  dashboard-telemetry-service measurements (drag/resize visual
  completion latency) to validate the < 100 ms SLO; use the
  operator dashboard's GET/PATCH error-rate panels to surface API
  regressions that manifest as silent save failures (the
  `LayoutPersistenceService` debounces save calls, so a regression
  in the PATCH endpoint typically appears to the user as a
  layout that "did not stick" rather than an in-flight error).

## Cross-references

- **AAP § 0.1.1** — feature definition (Modular Dashboard Refactor)
  and the chat-as-co-equal-module mandate that places the existing
  `ChatPanelComponent` on equal footing with the other grid
  modules.
- **AAP § 0.6.1.10** — observability wiring details (counters,
  histograms, correlationId propagation, `X-Correlation-ID`
  response header).
- **AAP § 0.6.3.3** — SLO targets table reproduced verbatim in
  the § SLO Summary section below.
- **AAP § 0.8.2.1** — project-level Observability rule mandating
  structured logging with correlation IDs, distributed tracing
  across service boundaries, a metrics endpoint, health/readiness
  checks, a dashboard template (this file), and a local
  verification procedure (the § Local Development Verification
  section below).
- **AAP § 0.8.5** — testing requirements that verify metrics
  emission. The required scenarios (`new user → blank canvas`,
  `returning user → saved layout renders`,
  `unauthenticated GET and PATCH return 401`, etc.) each map to a
  specific outcome label on the four counters.
- **Source of truth — service**:
  `apps/api/src/app/user/user-dashboard-layout.service.ts`.
  Specifically, the constructor's four
  `MetricsService.registerHelp(...)` calls register the help text
  for the four metrics; the per-method try/catch/finally pattern
  emits counter increments and histogram observations on every
  code path, so the histogram `_count` always equals the sum of
  the corresponding per-outcome counter increments.
- **Source of truth — controller**:
  `apps/api/src/app/user/user-dashboard-layout.controller.ts`.
  Generates `correlationId` via `randomUUID()` from `node:crypto`,
  sets the `X-Correlation-ID` response header BEFORE the service
  call, and propagates `correlationId` to the service.
- **Source of truth — metrics registry**:
  `apps/api/src/app/metrics/metrics.service.ts`. Default histogram
  buckets (in seconds) at line 36:
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`. The
  buckets cover the GET p95 ≤ 300 ms (lands in the
  `le="0.25"` / `le="0.5"` boundary) and PATCH p95 ≤ 500 ms (lands
  in the `le="0.5"` / `le="1"` boundary) SLO targets directly — no
  custom bucket configuration is required.
- **Spec coverage**:
  `apps/api/src/app/user/user-dashboard-layout.service.spec.ts`
  and
  `apps/api/src/app/user/user-dashboard-layout.controller.spec.ts`
  exercise every metric and every outcome path. The controller
  spec asserts the `X-Correlation-ID` header propagation pattern
  on both the success and the error paths.
- **Sibling decision log**:
  `../decisions/agent-action-plan-decisions.md` — decisions
  D-024 through D-033 (chat-panel deviation, gridster engine
  selection, single-route reduction, `UserDashboardLayout` Prisma
  model, debounce window, 12-column choice, blank-canvas
  first-visit semantics, MatDialog overlay, idempotent upsert,
  JSON layoutData shape).
- **Sibling traceability matrix**:
  `../migrations/dashboard-traceability-matrix.md` — bidirectional
  matrix mapping every removed/preserved/added construct to its
  target with 100 % coverage.

## Emitted Metrics — Authoritative Reference

The following four metrics are emitted by
`UserDashboardLayoutService` and are the sole metric surface of the
modular dashboard's persistence layer. Operators authoring panels
or alert rules must reference these names exactly; any other name
will yield empty results.

| Metric                                      | Type      | Labels                                      | HELP text                                                          |
| ------------------------------------------- | --------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `dashboard_layout_get_total`                | counter   | `outcome` ∈ {`found`, `not_found`, `error`} | Total GET /api/v1/user/layout invocations partitioned by outcome   |
| `dashboard_layout_patch_total`              | counter   | `outcome` ∈ {`success`, `error`}            | Total PATCH /api/v1/user/layout invocations partitioned by outcome |
| `dashboard_layout_save_failures_total`      | counter   | `reason` ∈ {`db_error`}                     | Total layout save failures partitioned by reason                   |
| `dashboard_layout_request_duration_seconds` | histogram | `method` ∈ {`GET`, `PATCH`}                 | Layout endpoint request duration in seconds                        |

The histogram exposes the canonical Prometheus suffixes
`_bucket{le="..."}`, `_sum`, and `_count`. Default buckets (in
seconds): `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`
— directly suitable for the GET p95 ≤ 300 ms (lands in the
`le="0.25"` / `le="0.5"` boundary) and PATCH p95 ≤ 500 ms (lands in
the `le="0.5"` / `le="1"` boundary) SLO targets. The
`MetricsService.getRegistryAsText()` renderer pre-populates every
default bucket so PromQL `histogram_quantile()` calls work from the
first observation onwards — no warm-up traffic is required to make
the dashboard panels render.

### Outcome and Reason Semantics

The label values on the four counters map one-to-one to the
service's terminal code paths. The following table is the
authoritative reference; downstream alert rules and Grafana panel
queries must use these label values verbatim.

| Counter / Label                                           | Triggering condition                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard_layout_get_total{outcome="found"}`             | `findByUserId` returned a row. Controller responds 200 OK with the persisted `LayoutData` body. This is the steady-state returning-user path.                                                                                                             |
| `dashboard_layout_get_total{outcome="not_found"}`         | `findByUserId` returned `null`. Controller raises `NotFoundException` (HTTP 404). This is the first-visit case (Rule 10: catalog auto-opens on the client) and is not an error condition.                                                                 |
| `dashboard_layout_get_total{outcome="error"}`             | Prisma threw during `findUnique` (rare; usually a database connectivity issue or a transient `PrismaClientKnownRequestError`). Controller propagates the exception to the global filter, which renders HTTP 500.                                          |
| `dashboard_layout_patch_total{outcome="success"}`         | `upsertForUser` returned the persisted row. Controller responds 200 OK with the upserted `LayoutData`. This is the steady-state save path triggered every ≥ 500 ms by the client `LayoutPersistenceService`.                                              |
| `dashboard_layout_patch_total{outcome="error"}`           | Prisma threw during `upsert` (rare; constraint violation, connection loss, JSON column rejection, etc.). The `dashboard_layout_save_failures_total{reason="db_error"}` counter increments alongside this counter so operators can disambiguate the cause. |
| `dashboard_layout_save_failures_total{reason="db_error"}` | Prisma `upsert` threw a `PrismaClientKnownRequestError` (or any other Prisma error). The single emitted reason value. Increments alongside `dashboard_layout_patch_total{outcome="error"}` so operators can rate-alert on the failure counter directly.   |

The single histogram
`dashboard_layout_request_duration_seconds{method}` is observed
exactly once per service-method invocation in a `try/finally`
block in `UserDashboardLayoutService`, which guarantees the
histogram is recorded for every outcome that reaches the service
layer — namely `found`, `not_found`, and `error` for GET, and
`success` and `error` for PATCH. The histogram is NOT incremented
on the upstream HTTP 401 / 403 / 400 short-circuit paths because
those requests never reach the service-layer emission site —
`AuthGuard('jwt')`, `HasPermissionGuard`, and the global
`ValidationPipe` reject the request before any service method is
invoked. The histogram `_count` therefore equals the sum of the
corresponding per-outcome counter increments — the
`dashboard_layout_get_total{outcome=...}` series for GET, and the
`dashboard_layout_patch_total{outcome=...}` series for PATCH —
and operators can use this consistency property as an internal
audit. The `method` label is one of `GET` or `PATCH`. There is no
`route` label; the metric scopes to the layout endpoints
implicitly via its name and the `UserDashboardLayoutService`
emission site. PromQL queries that filter only by `method` are
sufficient to disambiguate the two endpoints.

## Structured-Log Fields

Every request that reaches `UserDashboardLayoutController` emits
exactly ONE structured request-completion log line at the END of
the handler body — runs in a `finally` block so the line is
emitted on EVERY code path (HTTP 200 success, HTTP 404 first-visit,
HTTP 5xx uncaught error). The line is a single JSON-encoded string
serialized via `JSON.stringify(...)` and passed to
`Logger.log(...)` (INFO) or `Logger.error(...)` (ERROR) along with
the context tag `'UserDashboardLayoutController'`. NestJS's
framework formatter wraps the line with the context tag in
brackets — for example:

```
[Nest] 12345  - 05/04/2026, 8:00:00 AM     LOG [UserDashboardLayoutController] {"correlationId":"...","userId":"...","route":"/user/layout","method":"GET","statusCode":200,"durationMs":3,"level":"INFO","timestamp":"2026-05-04T08:00:00.123Z"}
```

The service layer (`UserDashboardLayoutService`) ADDITIONALLY
emits diagnostic log lines on the not_found path (`Logger.log`)
and the error path (`Logger.error`) with the message format
`[<correlationId>] <human-readable message>` — these provide
operator-friendly free-text annotations alongside the
machine-parseable structured request-completion line.

### Required fields (present on every controller request-completion log line)

The fields below MUST appear in the JSON payload of EVERY log
line emitted by `UserDashboardLayoutController` for both INFO
(success / first-visit) and ERROR (uncaught exception) paths:

- `correlationId` — UUID v4 (RFC 4122) propagated from the Express
  middleware in `apps/api/src/main.ts` (lines 199–213) for
  `/api/v1/user/layout*` routes. Falls back to a fresh
  `randomUUID()` only in unit tests where the synthetic request
  does not traverse the middleware. The `correlationId` value in
  the log line MATCHES the `X-Correlation-ID` response header
  byte-for-byte — proving the same canonical id is used end-to-
  end (header → log → service).
- `userId` — JWT-derived user identifier (`request.user.id`).
  Present on ALL controller log lines (INFO and ERROR) for
  support diagnostics. The userId is an OPAQUE INTERNAL UUID
  (e.g., `5f71e4f0-a2c3-4f6e-89ab-1234567890ab`) — it is NOT
  external PII. The Ghostfolio data model does NOT permit a
  user's email, name, or other identifying attributes to be
  derived from the userId without a privileged database lookup,
  so emission at INFO level is acceptable per the project's
  privacy policy. The userId is REQUIRED for support engineers
  to correlate a customer-reported issue ("my dashboard layout
  did not save") to specific server-side requests via metrics
  scoping and log filtering.
- `route` — `/user/layout` (the controller's `@Controller(...)`
  prefix; the global `/api/v1` URI version is omitted from the
  log field for stability across version bumps).
- `method` — `GET` or `PATCH`.
- `statusCode` — HTTP status as a number (200 success, 404
  first-visit, 500 uncaught error). The 401 / 403 / 400
  short-circuit paths do NOT emit a controller-level log line
  because the request never reaches the handler body — see the
  "Upstream short-circuits" sub-section below.
- `durationMs` — Wall-clock duration of the handler body in
  milliseconds (number, computed as `Date.now() - startTime`).
  Approximates the
  `dashboard_layout_request_duration_seconds{method=...}`
  histogram observation but is computed independently in the
  controller so a metrics misconfiguration would not silently
  drop the duration field from logs.
- `level` — Symbolic severity (`INFO` for HTTP 2xx and 4xx,
  `ERROR` for HTTP 5xx). Used by log aggregators (Loki, Datadog,
  CloudWatch) to route entries to the correct alerting tier.
- `timestamp` — ISO 8601 UTC timestamp (e.g.,
  `2026-05-04T08:00:00.123Z`).

### Optional fields (present only on the ERROR-level controller log line)

- `errorMessage` — Sanitized human-readable error message
  (`error.message` only — NO stack trace, NO request body, NO
  layoutData fields). The full stack trace appears on a SEPARATE
  log line emitted by NestJS's default exception filter at ERROR
  level; operators correlate the two via the matching timestamp
  and the immediately-preceding controller log line.

### Service-layer log lines (additive, not replacement)

`UserDashboardLayoutService` emits its own log lines for the
not_found and error paths via the
`formatLogMessage(message, correlationId)` helper (lines 306–311
of `user-dashboard-layout.service.ts`). These are operator-
friendly free-text annotations:

- `not_found` path (`Logger.log` at INFO level):
  `[<correlationId>] No dashboard layout found for user <userId>`.
  The userId is included for support diagnostics — same rationale
  as the controller log line above (opaque internal UUID, not
  external PII; required to scope a reported "blank canvas on
  return visit" issue to specific server-side requests).
- `error` path (`Logger.error` at ERROR level):
  `[<correlationId>] Failed to read UserDashboardLayout for user <userId>: <error.message>`
  (or `Failed to upsert ...` for the PATCH endpoint).

Service-layer log lines are NOT JSON-serialized — they are
plain-text annotations with the canonical `[<correlationId>]`
prefix. This keeps the high-frequency successful-request hot path
free of additional JSON serialization (the controller emits the
structured JSON line; the service only adds free-text annotations
when something noteworthy happened).

### Sensitive data exclusion

The structured request-completion log line and the service-layer
annotations NEVER include:

- The `Authorization` request header value (Bearer JWT).
- Any field of `dto.layoutData` (module identifiers, positions —
  while not high-sensitivity, they constitute personally-
  identifiable behavioral data; excluded for defense-in-depth).
- Database passwords, JWT secrets, or any environment variable
  starting with `_PASSWORD`, `_SECRET`, `_KEY`, or `_TOKEN`.
- User email addresses, names, or any external PII.

The exclusion is enforced STRUCTURALLY: the log payload schema
above lists the ONLY fields that ever appear in the JSON, and a
test in `user-dashboard-layout.controller.spec.ts`
("structured log payload excludes layoutData body content")
asserts the log payload does not contain a distinctive marker
injected into the request body.

### Upstream short-circuits (HTTP 401 / 403 / 400)

Requests rejected BEFORE the controller handler body runs do NOT
emit a controller-level structured log line — by definition, the
log emitter lives inside the handler's `finally` block, which
never executes when an upstream guard or pipe short-circuits the
request. This is correct behavior:

- HTTP 401 (Unauthorized) — `AuthGuard('jwt')` rejects the
  request before any application code runs. NestJS's framework
  emits an `[ExceptionsHandler]` log line; operators correlate
  the missing Bearer token to the access log via the
  `X-Correlation-ID` response header (which IS still emitted by
  the Express middleware — see § Correlation-ID Propagation).
- HTTP 403 (Forbidden) — `HasPermissionGuard` rejects the request
  after `AuthGuard('jwt')` succeeds but before the handler body.
  Same propagation pattern as 401.
- HTTP 400 (Bad Request) — NestJS's global `ValidationPipe`
  rejects a malformed request body before the handler body. Same
  propagation pattern as 401.

Operators investigating a 401 / 403 / 400 incident MUST use the
`X-Correlation-ID` response header value (which the Express
middleware sets on EVERY response, including the upstream
short-circuits) to correlate the missing controller log entry to
the corresponding access-log entry.

### Canonical log filters

The two canonical log filters for incident response are:

- "All log lines for a specific correlation id" —
  `grep -F '"correlationId":"<UUID>"' api.log` (matches the
  controller's structured JSON line) OR
  `grep -F '[<UUID>]' api.log` (matches both the controller
  line and the service-layer annotations).
- "All controller-level structured request-completion lines" —
  `grep -F '[UserDashboardLayoutController]' api.log` (matches
  the NestJS framework's context-tag bracket).

## Correlation-ID Propagation

Every request to the two layout endpoints carries a fresh
`correlationId` end-to-end. The propagation chain is:

1. **Express middleware** (`apps/api/src/main.ts` lines 199–213)
   mounted at the `/api/v1/user/layout` path prefix runs BEFORE
   NestJS's guards/pipes/handler. The middleware (a) reads any
   caller-supplied `X-Correlation-ID` request header (for
   distributed-tracing systems that propagate end-to-end ids
   across service boundaries), (b) falls back to a fresh
   `randomUUID()` from `node:crypto` when no incoming header is
   present, (c) sets `res.setHeader('X-Correlation-ID',
correlationId)` so the value is emitted on EVERY response —
   including the HTTP 401, 403, 400, 404, and 500 short-circuit
   paths that never reach the controller body, and (d) stashes
   the id on `request.correlationId` so the controller can
   reuse the same canonical value rather than minting a fresh
   id that would diverge from the header.
2. The controller
   (`apps/api/src/app/user/user-dashboard-layout.controller.ts`)
   reads `request.correlationId` (set by the middleware in step
   1. and idempotently re-asserts the same value on the response
      header via `response.setHeader('X-Correlation-ID', ...)`. The
      `??` fallback to a fresh `randomUUID()` preserves unit-test
      compatibility — synthetic request objects built directly in
      `*.spec.ts` files do not traverse the middleware pipeline.
3. The controller passes `correlationId` to
   `UserDashboardLayoutService.findByUserId(userId, correlationId)`
   and
   `UserDashboardLayoutService.upsertForUser(userId, layoutData, correlationId)`.
4. The service's `formatLogMessage(message, correlationId)` helper
   prefixes every structured log line with `[<correlationId>]` so
   all downstream logs (Prisma queries logged at the `query`
   level, error logs, retry logs) carry the same id end-to-end.
5. The controller emits its own structured request-completion
   log line with the same `correlationId` field — see
   § Structured-Log Fields above for the full payload contract.

**The `X-Correlation-ID` header is emitted on EVERY response
including HTTP 401 / 403 / 400 / 404 / 500.** This is by design —
the Express middleware mounted ahead of NestJS guards/pipes
ensures the header is always present, so operators investigating
ANY incident (including authentication failures) can correlate
the response to access-log entries and any controller-level log
lines via the canonical id. (Earlier versions of this runbook
claimed the header was absent on 401 responses; that was
outdated documentation, corrected as part of QA Checkpoint 9
finding AAP-Compliance #11 and QA Checkpoint 12 finding Issue 4.)

Note: the controller's structured request-completion log line is
NOT emitted on the upstream 401 / 403 / 400 short-circuit paths
(the handler body never runs), but the response header IS
emitted by the middleware on those paths — see § Structured-Log
Fields → "Upstream short-circuits" for the operator-correlation
procedure.

### Frontend Telemetry

The client-side companion service
`apps/client/src/app/dashboard/services/dashboard-telemetry.service.ts`
emits matching structured logs to the browser console in
development mode. Each console line includes the same
`correlationId` value (read from the `X-Correlation-ID` response
header on the most recent layout HTTP exchange) so a UI failure
can be correlated with the corresponding server-side log entry.
Production builds suppress these console logs to avoid leaking
correlation IDs to end users; the value remains available in the
network panel of the browser dev tools.

The dashboard-telemetry service also measures the drag/resize
visual completion latency that backs the `< 100 ms` SLO target.
This measurement is performed in the browser using
`performance.now()` brackets around the gridster
`itemChangeCallback` and `itemResizeCallback` boundaries; the
result is logged but is NOT currently shipped to the server, so
it is invisible to operators. A future server-side beacon
endpoint could capture this signal in operational metrics, but
that work is OUT OF SCOPE per AAP § 0.7.3.

Operator workflow for a user-reported layout-save failure:

1. The user reports the failure with a screenshot, a description,
   or the contents of the browser console.
2. The operator extracts the `correlationId` from the response
   headers (network panel → response headers tab → `X-Correlation-ID`)
   or from the structured console log emitted by
   `dashboard-telemetry.service.ts`.
3. The operator greps the API logs for the literal substring
   `[<correlationId>]` to retrieve the full server-side trace
   (controller entry, service invocation, Prisma query, response
   completion, plus any error-level frames).
4. If the trace shows
   `dashboard_layout_save_failures_total{reason="db_error"}` incremented,
   the operator inspects PrismaService health and the
   `/api/v1/health` probe before declaring the incident closed.

## Distributed Tracing

`correlationId` propagates from controller → service →
PrismaService query log via Nest's request-scoped logger. No new
APM or tracing dependencies are introduced; the propagation is
entirely logging-based, per the existing repo convention used by
`SnowflakeSyncService`, `AiChatService`, and `RebalancingService`.
A future migration to OpenTelemetry tracing could replace the
correlationId-based propagation with W3C trace contexts, but that
work is independent of this dashboard refactor.

The project-level Observability rule (AAP § 0.8.2.1) requires
exactly this propagation contract. Any new feature module added
to the codebase that participates in the layout endpoints (for
example, a future caching layer in front of `PrismaService`) MUST
honour the same `[<correlationId>]` log-line prefix so the
operator's grep workflow continues to function end-to-end.

## Health/Readiness

The new module relies on the existing `/api/v1/health` endpoints;
no separate `/api/v1/health/dashboard-layout` probe is added. The
new module depends only on already-health-checked surfaces:

- **PrismaService** — Prisma connection health is exercised by the
  global `/api/v1/health` probe (`SELECT 1` against the operational
  Postgres). A Prisma outage simultaneously trips the existing
  health check and causes
  `dashboard_layout_get_total{outcome="error"}` /
  `dashboard_layout_patch_total{outcome="error"}` to spike, so the
  global probe is sufficient.
- **JWT identity** — covered by the existing `AuthGuard('jwt')`
  infrastructure; a JWT-strategy outage manifests as 401
  responses on all authenticated endpoints, and is observable via
  the existing access-log error rate.

A "no-traffic" condition (silent endpoint) is monitored via the
`DashboardLayoutEndpointDown` alert rule in § Alert Rules below
rather than via a dedicated probe. The alert fires when the error
rate on either endpoint is sustained at 100 %, which captures the
"endpoint is reachable but always errors" failure mode that a
liveness probe would miss.

## Recommended Panels

The dashboard ships with five panels grouped into two rows. The
top row covers latency (one panel per HTTP method), and the
bottom row covers outcome composition, failure breakdown, and
the PATCH success ratio.

| #   | Panel                           | Type                  | Primary Metric                                                | Example PromQL                                                                                                                |
| --- | ------------------------------- | --------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | GET p95 Latency                 | Time series           | `dashboard_layout_request_duration_seconds_bucket`            | `histogram_quantile(0.95, sum(rate(dashboard_layout_request_duration_seconds_bucket{method="GET"}[5m])) by (le))`             |
| 2   | PATCH p95 Latency               | Time series           | `dashboard_layout_request_duration_seconds_bucket`            | `histogram_quantile(0.95, sum(rate(dashboard_layout_request_duration_seconds_bucket{method="PATCH"}[5m])) by (le))`           |
| 3   | Error Rate by Outcome (Stacked) | Time series (stacked) | `dashboard_layout_get_total` + `dashboard_layout_patch_total` | `sum by (outcome) (rate(dashboard_layout_get_total[5m]) + rate(dashboard_layout_patch_total[5m]))`                            |
| 4   | Save Failures by Reason         | Time series           | `dashboard_layout_save_failures_total`                        | `sum by (reason) (rate(dashboard_layout_save_failures_total[5m]))`                                                            |
| 5   | PATCH Error Rate Ratio          | Stat (single-value)   | `dashboard_layout_patch_total`                                | `sum(rate(dashboard_layout_patch_total{outcome="error"}[5m])) / clamp_min(sum(rate(dashboard_layout_patch_total[5m])), 1e-9)` |

### Panel 1 — GET p95 Latency

The headline GET SLI for the layout endpoint.
`dashboard_layout_request_duration_seconds` is observed exactly
once per request in the controller's `try/finally` block, which
guarantees the histogram is recorded for every outcome including
404 and 500 responses. The panel renders the p95 series over a
five-minute rolling window, computed via `histogram_quantile()`
against the bucket counter filtered by `method="GET"`. Recommended
visual thresholds: green ≤ 100 ms, amber 100 ms–300 ms, red > 300 ms.
The 300 ms threshold is the AAP-level acceptance gate from
AAP § 0.6.3.3; sustained breach should trigger paging via the
`DashboardLayoutGetLatencyP95High` warning rule in the § Alert
Rules section below.

### Panel 2 — PATCH p95 Latency

The headline PATCH SLI for the layout endpoint. Same
single-observation-per-request emission contract as Panel 1, with
the histogram filtered by `method="PATCH"`. Recommended visual
thresholds: green ≤ 250 ms, amber 250 ms–500 ms, red > 500 ms.
The 500 ms threshold is the AAP-level acceptance gate from
AAP § 0.6.3.3; sustained breach should trigger paging via the
`DashboardLayoutPatchLatencyP95High` warning rule. Note that the
PATCH p95 target is intentionally larger than the GET target
because the PATCH path performs an `upsert` rather than a
`findUnique` — the additional write round-trip and the JSON column
serialization add a few tens of milliseconds at the median.

### Panel 3 — Error Rate by Outcome (Stacked)

Stacked time series showing outcome composition across both
endpoints — five possible series in total (`found`, `not_found`,
`error` for GET; `success`, `error` for PATCH). The two
"healthy" outcomes (`found` for GET and `success` for PATCH)
should dominate during steady state; `outcome="not_found"` is
expected on first-visit GET requests (it is not an error) and
will appear as a small but persistent band in the stack. A
sustained increase in `outcome="error"` for either endpoint is
the principal incident signal for the layout persistence layer;
the operator should immediately open Panel 4 to disambiguate the
failure cause.

### Panel 4 — Save Failures by Reason

PATCH-specific failure breakdown. The service emits a single
reason value `reason="db_error"` covering every Prisma upsert
failure (connection loss, constraint violations, JSON column
rejections, transient `PrismaClientKnownRequestError` instances,
etc.). The panel renders as a single time series — kept as a
"by reason" panel rather than collapsing to a flat counter so
that future reasons added to the service can appear without
panel changes. A sustained spike in `reason="db_error"`
typically correlates with a Postgres incident and should be
cross-referenced with the global `/api/v1/health` probe and the
operational Postgres metrics.

### Panel 5 — PATCH Error Rate Ratio

PATCH-specific success ratio computed as `1 - error_rate`. The
expression uses `clamp_min(..., 1e-9)` in the denominator to
avoid division-by-zero when no recent PATCH traffic. Recommended
thresholds: green ≥ 99 %, amber 95 %–99 %, red < 95 %. A
sustained breach of the red threshold should trigger paging via
the `DashboardLayoutSaveFailureRateHigh` rule in the § Alert
Rules section below. This panel exists to surface silent
save-regression incidents, where the user's drag/resize gestures
appear to succeed in the UI but the server has rejected every
PATCH and the layout fails to persist across page reloads.

## Alert Rules

Recommended Prometheus alerting rules. Adjust thresholds and `for`
windows for the operating environment. Each rule references only
the four metric names emitted by `UserDashboardLayoutService` and
the label values enumerated in § Outcome and Reason Semantics.

```yaml
groups:
  - name: dashboard-layout
    rules:
      - alert: DashboardLayoutGetLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (
              rate(dashboard_layout_request_duration_seconds_bucket{method="GET"}[5m])
            )
          ) > 0.3
        for: 5m
        labels:
          severity: warning
          feature: dashboard-layout
        annotations:
          summary: 'Dashboard layout GET p95 latency above 300 ms'
          description: |
            dashboard_layout_request_duration_seconds p95 for
            method=GET has exceeded 300 ms for 5 minutes. The
            300 ms threshold is the AAP-level acceptance gate from
            AAP § 0.6.3.3. Inspect the structured logs for the
            affected correlationIds (filter by
            [UserDashboardLayoutService] and the relevant
            correlationId), verify the /api/v1/health probe, and
            check operational Postgres health — the GET path is a
            single primary-key lookup so persistent slowness is
            almost always Postgres-side.

      - alert: DashboardLayoutPatchLatencyP95High
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (
              rate(dashboard_layout_request_duration_seconds_bucket{method="PATCH"}[5m])
            )
          ) > 0.5
        for: 5m
        labels:
          severity: warning
          feature: dashboard-layout
        annotations:
          summary: 'Dashboard layout PATCH p95 latency above 500 ms'
          description: |
            dashboard_layout_request_duration_seconds p95 for
            method=PATCH has exceeded 500 ms for 5 minutes. The
            500 ms threshold is the AAP-level acceptance gate from
            AAP § 0.6.3.3. The PATCH path performs an upsert, so
            inspect the structured logs for slow-query log lines
            from PrismaService, verify the JSON column size on the
            UserDashboardLayout.layoutData column is within
            expected bounds (defensive cap of 50 items per
            AAP § 0.6.3.3), and check operational Postgres health.

      - alert: DashboardLayoutSaveFailureRateHigh
        expr: |
          sum(rate(dashboard_layout_patch_total{outcome="error"}[10m]))
            /
          clamp_min(
            sum(rate(dashboard_layout_patch_total[10m])),
            1e-9
          )
            > 0.05
        for: 10m
        labels:
          severity: page
          feature: dashboard-layout
        annotations:
          summary: 'Dashboard layout save failure rate above 5%'
          description: |
            More than 5 % of PATCH /api/v1/user/layout requests
            have terminated in the error outcome over the last
            10 minutes. User layout changes are silently failing
            to persist. Inspect dashboard_layout_save_failures_total
            (the service emits the single reason value
            reason="db_error" covering every Prisma upsert failure
            mode). Cross-reference correlationId values against
            the structured logs and the /api/v1/health probe to
            disambiguate the underlying cause (connection loss,
            constraint violation, JSON column rejection, etc.).

      - alert: DashboardLayoutEndpointDown
        expr: |
          (
            sum(rate(dashboard_layout_get_total{outcome="error"}[2m]))
              /
            clamp_min(
              sum(rate(dashboard_layout_get_total[2m])),
              1e-9
            )
              >= 0.99
          )
          or
          (
            sum(rate(dashboard_layout_patch_total{outcome="error"}[2m]))
              /
            clamp_min(
              sum(rate(dashboard_layout_patch_total[2m])),
              1e-9
            )
              >= 0.99
          )
        for: 2m
        labels:
          severity: page
          feature: dashboard-layout
        annotations:
          summary: 'Dashboard layout endpoint failing 100% of requests'
          description: |
            Either GET /api/v1/user/layout or PATCH /api/v1/user/layout
            is returning the error outcome on essentially 100 % of
            requests over the last 2 minutes. This captures the
            "endpoint is reachable but always errors" failure mode
            that the global /api/v1/health probe may miss. Likely
            root causes: PrismaService startup failure, JWT
            strategy regression resolving identities to invalid
            user IDs, or an exception in the service that fires
            before the metric increment. Inspect the most recent
            stack traces in [UserDashboardLayoutService] log lines
            and verify the API process is healthy.
```

The four rules cover the complete operational signal surface for
the layout endpoints: two latency rules (one per HTTP method) at
WARN severity matched to the AAP § 0.6.3.3 SLO targets, and two
error-rate rules (one per failure-mode characterisation) at PAGE
severity matched to the user-impact failure modes. No additional
rules are required for steady-state monitoring; operators may add
environment-specific rules as needed (for example, a low-volume
WARN that fires when the PATCH counter does not increment for an
extended period during expected traffic windows).

## Local Development Verification

The following procedure exercises every metric and every outcome
path in the local development environment, satisfying the AAP
§ 0.8.2.1 mandate that "all observability MUST be exercised in
the local development environment." Run all ten steps in order;
abort and inspect the structured logs if any step does not
produce the expected output.

1. **Bring up the API.** From the repository root, start the
   database services per `docker/docker-compose.dev.yml` and the
   `.env.example` configuration, then start the API:

   ```bash
   docker compose -f docker/docker-compose.dev.yml up -d
   npx nx serve api
   ```

   Wait for the bootstrap log line
   `Nest application successfully started`.

2. **Confirm the metrics endpoint is reachable** and the four
   layout metrics are registered:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^# (HELP|TYPE) dashboard_layout_'
   ```

   Expected output (order may vary):

   ```text
   # HELP dashboard_layout_get_total Total GET /api/v1/user/layout invocations partitioned by outcome
   # TYPE dashboard_layout_get_total counter
   # HELP dashboard_layout_patch_total Total PATCH /api/v1/user/layout invocations partitioned by outcome
   # TYPE dashboard_layout_patch_total counter
   # HELP dashboard_layout_request_duration_seconds Layout endpoint request duration in seconds
   # TYPE dashboard_layout_request_duration_seconds histogram
   # HELP dashboard_layout_save_failures_total Total layout save failures partitioned by reason
   # TYPE dashboard_layout_save_failures_total counter
   ```

3. **Test the 401 path** with no JWT:

   ```bash
   curl -i http://localhost:3333/api/v1/user/layout
   ```

   Expected `HTTP/1.1 401 Unauthorized`. Verify the response
   **DOES** include an `X-Correlation-ID` header carrying a
   fresh UUID v4. The Express middleware in
   `apps/api/src/main.ts` (lines 199–213) is mounted ahead of
   NestJS's guards/pipes for the `/api/v1/user/layout` path,
   so the header is emitted on EVERY response — including the
   HTTP 401, 403, 400, 404, and 500 paths. This is correct
   behavior (the previous version of this runbook claimed the
   header was absent on 401; that was outdated documentation
   left over from a prior implementation that minted the
   correlationId inside the controller body — QA Checkpoint 9
   resolved the gap by promoting the generation to middleware,
   and QA Checkpoint 12 corrected this paragraph).

   Verify the metric counters DO NOT increment on this path —
   counter emission lives inside the service downstream of the
   guard, so the 401 short-circuit prevents the counter
   increment:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^dashboard_layout_get_total\{'
   ```

   The counter values should be IDENTICAL before and after the
   401 request.

4. **Mint a JWT** for a user with the `readUserDashboardLayout`
   and `updateUserDashboardLayout` permissions (a USER- or
   ADMIN-role user; DEMO and INACTIVE are explicitly excluded
   per Decision D-005). Export it as `JWT=...` in the shell.

5. **Test the 404 path** (new user, no saved layout):

   ```bash
   curl -i -H "Authorization: Bearer $JWT" \
     http://localhost:3333/api/v1/user/layout
   ```

   Expected `HTTP/1.1 404 Not Found` with the `X-Correlation-ID`
   header populated. Re-scrape `/api/v1/metrics` and verify the
   `not_found` counter incremented:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^dashboard_layout_get_total\{'
   ```

   Expected (sample):

   ```text
   dashboard_layout_get_total{outcome="not_found"} 1
   ```

6. **Test the 200 PATCH path** (initial save):

   ```bash
   curl -i -X PATCH http://localhost:3333/api/v1/user/layout \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{ "layoutData": { "version": 1, "items": [] } }'
   ```

   Expected `HTTP/1.1 200 OK` with the persisted record echoed in
   the response body. Verify the PATCH counter and the histogram
   populated:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^dashboard_layout_patch_total\{'
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^dashboard_layout_request_duration_seconds(_bucket|_sum|_count)\{.*method="PATCH"'
   ```

   Expected (sample):

   ```text
   dashboard_layout_patch_total{outcome="success"} 1
   ```

   The histogram should show every default bucket (`le="0.005"`
   through `le="10"` and `le="+Inf"`) plus non-zero `_sum` and
   `_count`, all carrying `method="PATCH"`.

7. **Test the 200 GET path** (returning user, after save).
   Re-issue the request from step 5:

   ```bash
   curl -i -H "Authorization: Bearer $JWT" \
     http://localhost:3333/api/v1/user/layout
   ```

   Expected `HTTP/1.1 200 OK` with the empty-items layout in the
   response body. Verify the `found` outcome counter incremented:

   ```bash
   curl -s http://localhost:3333/api/v1/metrics \
     | grep -E '^dashboard_layout_get_total\{outcome="found"'
   ```

8. **Test the 400 validation failure** with a malformed body:

   ```bash
   curl -i -X PATCH http://localhost:3333/api/v1/user/layout \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{"foo":"bar"}'
   ```

   Expected `HTTP/1.1 400 Bad Request` (NestJS global
   `ValidationPipe` rejection). Note that
   `dashboard_layout_save_failures_total` does **not** increment
   on this path in the current implementation — the global
   `ValidationPipe` rejects the request before the service runs,
   and the service emits the failures counter only on Prisma
   upsert failure (`reason="db_error"`). The 400 response itself
   is the verifiable signal for this step.

9. **Verify `X-Correlation-ID` propagation.** EVERY response
   from `/api/v1/user/layout` (including the 401 path tested in
   step 3, the 404 path in step 5, the 200 paths in steps 6 and
   7, and the 400 path in step 8) MUST include the
   `X-Correlation-ID` response header — the Express middleware
   in `apps/api/src/main.ts` (lines 199–213) sets the header on
   ALL responses, including the upstream short-circuits. The
   `-i` flag on curl exposes response headers; compare the
   returned id against the structured log lines emitted by the
   API. Two canonical filters apply:
   - For requests that REACHED the controller body (steps 5, 6,
     7, but NOT the upstream short-circuits in steps 3 and 8),
     a structured request-completion JSON log line is emitted
     by `UserDashboardLayoutController`. Filter by the literal
     correlationId substring:

     ```bash
     grep -F '"correlationId":"ab8d3e1f-2c43-4f9a-8e5b-9f4c6d8a1b2c"' api.log
     ```

     should show one structured JSON log line carrying the
     full set of required fields (`correlationId`, `userId`,
     `route`, `method`, `statusCode`, `durationMs`, `level`,
     `timestamp`).

   - For requests that reached the service layer (regardless of
     outcome — `found`, `not_found`, or `error`), additional
     free-text annotation lines are prefixed with the
     `[<correlationId>]` substring. The broader filter

     ```bash
     grep -F '[ab8d3e1f-2c43-4f9a-8e5b-9f4c6d8a1b2c]' api.log
     ```

     matches both the controller's structured JSON line AND any
     service-layer annotations sharing the same correlationId.

   For the upstream 401 / 403 / 400 short-circuits (steps 3 and
   8), the controller-level structured JSON line is NOT emitted
   (the handler body never runs), but the response header IS
   emitted by the middleware — operators investigating those
   incidents must use the response header value to correlate
   the request with NestJS's framework-level
   `[ExceptionsHandler]` log line via timestamp.

10. **Verify all four metrics are populated** after the 401
    (step 3), 404 (step 5), 200 PATCH (step 6), 200 GET (step 7),
    and 400 (step 8) test sequence:

    ```bash
    curl -s http://localhost:3333/api/v1/metrics \
      | grep -E '^dashboard_layout_'
    ```

    The output should show all four metric series with non-zero
    values (the `dashboard_layout_save_failures_total` counter
    will be zero unless step 6 induced a Prisma error — it is
    expected to be zero on the happy path). The histogram
    `_bucket`, `_sum`, and `_count` must ALL appear for both
    `method="GET"` and `method="PATCH"`.

If any step does not produce the expected output, the dashboard
cannot render correctly. Inspect the structured logs (each line
is prefixed with `[UserDashboardLayoutService] [<correlationId>]`)
and the service source (`user-dashboard-layout.service.ts`) before
declaring the dashboard broken.

## SLO Summary

The four operational SLO targets for the modular dashboard layout
feature, reproduced verbatim from AAP § 0.6.3.3:

| Metric                        | Target   | Mechanism                                                                        |
| ----------------------------- | -------- | -------------------------------------------------------------------------------- |
| Drag/resize visual completion | < 100 ms | Gridster math runs `NgZone.runOutsideAngular`; OnPush change detection on canvas |
| Layout save debounce          | ≥ 500 ms | rxjs `debounceTime(500)` in `LayoutPersistenceService`                           |
| GET p95 latency               | ≤ 300 ms | Single primary-key lookup on indexed `userId`                                    |
| PATCH p95 latency             | ≤ 500 ms | Single Prisma `upsert` on indexed primary key                                    |

Two of the four SLOs are server-side measurable and feed the
panels and alerts above:

- **GET p95 latency** — observable via
  `dashboard_layout_request_duration_seconds{method="GET"}` and
  enforced by `DashboardLayoutGetLatencyP95High`.
- **PATCH p95 latency** — observable via
  `dashboard_layout_request_duration_seconds{method="PATCH"}` and
  enforced by `DashboardLayoutPatchLatencyP95High`.

The remaining two SLOs are NOT directly observable in operational
metrics:

- **Drag/resize visual completion (< 100 ms)** — measured
  client-side by
  `apps/client/src/app/dashboard/services/dashboard-telemetry.service.ts`.
  Validated in development via console inspection and in CI via
  the canvas component spec; not exposed to Prometheus.
- **Layout save debounce (≥ 500 ms)** — implementation guarantee
  via `debounceTime(500)` in `LayoutPersistenceService`. Not
  directly measurable in production but verifiable via the
  `LayoutPersistenceService` unit tests
  (`apps/client/src/app/dashboard/services/layout-persistence.service.spec.ts`)
  using the rxjs `TestScheduler` and virtual time.

Future work could add a server-side beacon endpoint to capture
the client-side signals in operational metrics, but that work is
OUT OF SCOPE per AAP § 0.7.3.

## JSON Dashboard Definition

A self-contained Grafana 9+ dashboard definition ready for
import. The datasource UID is parameterised via
`${DS_PROMETHEUS}` — substitute the local Prometheus datasource
UID before import. The definition assumes the four metrics from
§ Emitted Metrics are scraped at the standard 15-second interval;
the panels' rolling-window expressions assume this interval and
will continue to render correctly at 30-second or 60-second
scrape intervals.

```json
{
  "title": "Dashboard Layout",
  "tags": ["ghostfolio", "dashboard-layout", "blitzy"],
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
        "name": "method",
        "label": "Method",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
        "query": "label_values(dashboard_layout_request_duration_seconds_count, method)",
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
      "title": "GET p95 Latency",
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
              { "color": "red", "value": 0.3 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.95, sum by (le) (rate(dashboard_layout_request_duration_seconds_bucket{method=\"GET\"}[5m])))",
          "legendFormat": "p95 GET"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    },
    {
      "id": 2,
      "type": "timeseries",
      "title": "PATCH p95 Latency",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.25 },
              { "color": "red", "value": 0.5 }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.95, sum by (le) (rate(dashboard_layout_request_duration_seconds_bucket{method=\"PATCH\"}[5m])))",
          "legendFormat": "p95 PATCH"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Error Rate by Outcome (Stacked)",
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
          "expr": "sum by (outcome) (rate(dashboard_layout_get_total[5m]) + rate(dashboard_layout_patch_total[5m]))",
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
      "type": "timeseries",
      "title": "Save Failures by Reason",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 12, "y": 8, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": { "unit": "ops" },
        "overrides": [
          {
            "matcher": { "id": "byName", "options": "db_error" },
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
          "expr": "sum by (reason) (rate(dashboard_layout_save_failures_total[5m]))",
          "legendFormat": "{{reason}}"
        }
      ],
      "options": {
        "tooltip": { "mode": "multi" },
        "legend": { "displayMode": "table", "placement": "bottom" }
      }
    },
    {
      "id": 5,
      "type": "stat",
      "title": "PATCH Error Rate Ratio",
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "x": 0, "y": 16, "w": 8, "h": 8 },
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
          "expr": "1 - (sum(rate(dashboard_layout_patch_total{outcome=\"error\"}[5m])) / clamp_min(sum(rate(dashboard_layout_patch_total[5m])), 1e-9))",
          "legendFormat": "PATCH success ratio"
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
    }
  ]
}
```

## References

- **Service** —
  `apps/api/src/app/user/user-dashboard-layout.service.ts`.
- **Controller** —
  `apps/api/src/app/user/user-dashboard-layout.controller.ts`.
- **Module** —
  `apps/api/src/app/user/user-dashboard-layout.module.ts`.
- **Request DTO** —
  `apps/api/src/app/user/dtos/update-dashboard-layout.dto.ts`.
- **Response DTO** —
  `apps/api/src/app/user/dtos/dashboard-layout.dto.ts`.
- **Metrics registry** —
  `apps/api/src/app/metrics/metrics.service.ts` and
  `apps/api/src/app/metrics/metrics.controller.ts`.
- **Endpoints** — `GET /api/v1/user/layout` (read) and
  `PATCH /api/v1/user/layout` (idempotent upsert), both protected
  by `AuthGuard('jwt')` + `HasPermissionGuard` + per-method
  `@HasPermission(...)` decorators.
- **Permissions registry** —
  `libs/common/src/lib/permissions.ts` (constants
  `readUserDashboardLayout`, `updateUserDashboardLayout`).
- **Frontend telemetry** —
  `apps/client/src/app/dashboard/services/dashboard-telemetry.service.ts`.
- **AAP** — § 0.1.1 (feature definition), § 0.6.1.10
  (observability wiring), § 0.6.3.3 (SLO targets), § 0.8.2.1
  (Observability project rule), § 0.8.5 (testing requirements).
- **Decision log** —
  `../decisions/agent-action-plan-decisions.md` (D-024 through
  D-033).
- **Traceability matrix** —
  `../migrations/dashboard-traceability-matrix.md`.

### Metric Names (Authoritative List)

The dashboard, alerting rules, and verification commands above
reference **only** the four metric names below. Any metric name
not appearing in this list is not emitted by
`UserDashboardLayoutService` and will yield empty Grafana panels
if referenced.

- `dashboard_layout_get_total` (counter; labels: `outcome`)
- `dashboard_layout_patch_total` (counter; labels: `outcome`)
- `dashboard_layout_save_failures_total` (counter; labels: `reason`)
- `dashboard_layout_request_duration_seconds` (histogram; labels: `method`)
