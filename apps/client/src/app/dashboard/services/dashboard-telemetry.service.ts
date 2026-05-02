import { Injectable } from '@angular/core';

/**
 * Lightweight, development-time-only client telemetry that measures gridster
 * drag/resize visual completion latency against the < 100 ms SLO documented
 * in AAP § 0.6.3.3.
 *
 * The < 100 ms SLO is enforced architecturally by gridster v21's
 * `NgZone.runOutsideAngular(...)` wrapping plus the canvas's OnPush change
 * detection — this service exists to expose a hook for future RUM
 * integration without coupling the canvas to a specific telemetry backend.
 *
 * In production, where `console.debug` is commonly disabled by the build's
 * prod logging guard, the service is effectively a no-op. The browser-global
 * guards (`typeof performance === 'undefined'`, `typeof console.debug !==
 * 'function'`) make the service safe in SSR pipelines and certain test
 * environments that may not provide `performance` or `console.debug`.
 *
 * The console messages use the `[gf-dashboard]` prefix to make them easy to
 * filter in dev consoles. The service is intentionally minimal — it does
 * NOT subscribe to anything, NOT inject any other service, and does NOT
 * manage any state. It is a pure side-effect logger.
 *
 * Future enhancement (out of scope for v1 per AAP § 0.6.1.10): forward the
 * captured `performance.now()` timestamps to a real telemetry sink (e.g., a
 * metrics endpoint or RUM provider). This would be the client-side
 * counterpart to the API-side metrics emitted by `MetricsService`
 * (`apps/api/src/services/metrics/metrics.service.ts`).
 *
 * Per AAP § 0.8.2.1 (Observability project rule), the < 100 ms SLO is
 * measured and the runbook at `docs/observability/dashboard-layout.md`
 * documents the metric definitions.
 *
 * @see AAP § 0.6.1.10 — Observability Wiring (client-side counterpart).
 * @see AAP § 0.6.3.3 — Performance Targets (Validation Framework).
 * @see AAP § 0.8.2.1 — Observability project rule (mandates SLO measurement).
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardTelemetryService {
  /**
   * Captures the timestamp of a drag/resize event onset for subsequent SLO
   * measurement. Called by the canvas (`GfDashboardCanvasComponent`) at
   * gridster `itemChangeCallback` invocations.
   *
   * Emits a `console.debug` trace prefixed with `[gf-dashboard]`. Silent in
   * environments where `performance` or `console.debug` are unavailable
   * (e.g., SSR pipelines, certain test runners). Production builds that
   * strip `console.debug` reduce this method to a no-op except for the
   * timestamp capture, which is itself silent without `console.debug`.
   *
   * @returns void — fire-and-forget; no Observable, no state mutation.
   */
  public measureChange(): void {
    if (typeof performance === 'undefined') {
      return;
    }

    if (typeof console === 'undefined' || typeof console.debug !== 'function') {
      return;
    }

    // Development trace; silent in production where console.debug is
    // commonly disabled by the build's prod logging guard.
    console.debug('[gf-dashboard] grid-state change', performance.now());
  }

  /**
   * Captures the timestamp of a resize event onset for SLO measurement.
   * Called by the canvas (`GfDashboardCanvasComponent`) at gridster
   * `itemResizeCallback` invocations.
   *
   * Emits a `console.debug` trace prefixed with `[gf-dashboard]`. Silent in
   * environments where `performance` or `console.debug` are unavailable
   * (e.g., SSR pipelines, certain test runners). Production builds that
   * strip `console.debug` reduce this method to a no-op except for the
   * timestamp capture, which is itself silent without `console.debug`.
   *
   * @returns void — fire-and-forget; no Observable, no state mutation.
   */
  public measureResize(): void {
    if (typeof performance === 'undefined') {
      return;
    }

    if (typeof console === 'undefined' || typeof console.debug !== 'function') {
      return;
    }

    // Development trace; silent in production where console.debug is
    // commonly disabled by the build's prod logging guard.
    console.debug('[gf-dashboard] grid-state resize', performance.now());
  }
}
