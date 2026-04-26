import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * AnthropicHealthIndicator
 *
 * Configuration-only health probe for the Anthropic API integration that
 * supports the AI Portfolio Chat Agent (Feature B, AAP § 0.1.1) and the
 * Explainable Rebalancing Engine (Feature C, AAP § 0.1.1). The indicator
 * verifies that the Anthropic TypeScript SDK can be instantiated with the
 * configured `ANTHROPIC_API_KEY` and exposes the two primitives those
 * features depend on (`messages.create`, `messages.stream`) — without
 * making any paid network call to the Anthropic API.
 *
 * Hard rules enforced by this class (see AAP § 0.7):
 *
 * - Rule 3 (Credential Access — § 0.7.1.3): `ANTHROPIC_API_KEY` is read
 *   EXCLUSIVELY through the injected `ConfigService`. Direct access via
 *   the Node.js environment-variable global for any `ANTHROPIC_*` name
 *   is prohibited and absent from this file.
 *
 * - Logging redaction (§ 0.7.3): The actual `apiKey` value is NEVER
 *   substituted into a log line. Failure messages disclose only literal
 *   strings ("missing") or the SDK's own `error.message`.
 *
 * - Configuration-only probe (§ 0.5.1.2): The probe verifies SDK
 *   instantiation and shape only — it MUST NOT invoke any of the
 *   `messages` SDK methods, nor any other Anthropic endpoint. Sending
 *   real requests would incur paid usage on every health check.
 *
 * - Fail-closed contract: Mirrors the existing
 *   `HealthService.isDatabaseHealthy()` and `isRedisCacheHealthy()`
 *   convention (`apps/api/src/app/health/health.service.ts`). Returns
 *   `Promise<boolean>` and never throws — every exceptional path is
 *   funneled through the catch block to `false`.
 *
 * Module registration: This class is delivered as a stand-alone
 * injectable provider. Wiring it into `HealthModule.providers` and
 * exposing a `/api/v1/health/anthropic` route from `HealthController`
 * are deferred to a later checkpoint (the final wiring checkpoint of
 * the AI feature delivery). The probe is listed in AAP § 0.5.1.2 as
 * an additive health indicator intended for `HealthModule`
 * registration; it is NOT permanently out of scope. No further changes
 * to this file are required at registration time — only the host
 * `HealthModule` and `HealthController` will gain new entries.
 */
@Injectable()
export class AnthropicHealthIndicator {
  private readonly logger = new Logger(AnthropicHealthIndicator.name);

  public constructor(private readonly configService: ConfigService) {}

  /**
   * Performs a configuration-only readiness probe of the Anthropic SDK.
   *
   * Behavior:
   *   1. Reads `ANTHROPIC_API_KEY` through the injected `ConfigService`
   *      (Rule 3). If the value is falsy, logs a redacted "missing"
   *      warning and returns `false`.
   *   2. Instantiates a fresh `Anthropic` client via `new Anthropic({ apiKey })`.
   *      If the SDK constructor throws (e.g., because the key has an
   *      invalid format), the exception is caught and the probe reports
   *      `false`.
   *   3. Inspects the constructed client to verify that the two SDK
   *      primitives consumed by `AiChatService` and `RebalancingService`
   *      (per AAP § 0.5.1) — `messages.create` and `messages.stream` —
   *      are present as callable functions. Optional chaining (`?.`)
   *      defends against unexpected SDK API drift.
   *   4. Returns `true` if and only if all of the above hold; otherwise
   *      returns `false` (fail-closed).
   *
   * Logging redaction:
   *   - On the missing-key branch, only the literal string
   *     "ANTHROPIC_API_KEY missing" is emitted; the (absent) value is
   *     never substituted.
   *   - On the catch branch, only `error.message` is emitted; the
   *     `apiKey` local is never substituted into a log string.
   *
   * No network call is made by this method on any branch.
   *
   * @returns `true` when the API key is present, the SDK instantiates,
   *          and both `messages.create` / `messages.stream` are
   *          functions on the constructed client. `false` otherwise.
   */
  public async isHealthy(): Promise<boolean> {
    try {
      const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');

      if (!apiKey) {
        this.logger.warn(
          'Anthropic health probe failed: ANTHROPIC_API_KEY missing'
        );

        return false;
      }

      const client = new Anthropic({ apiKey });

      // Configuration-only probe — verify SDK shape without making any
      // paid Anthropic API call. See AAP § 0.5.1.2.
      const isConfigured =
        typeof client?.messages?.create === 'function' &&
        typeof client?.messages?.stream === 'function';

      if (!isConfigured) {
        this.logger.warn(
          'Anthropic health probe failed: SDK client does not expose messages.create / messages.stream'
        );
      }

      return isConfigured;
    } catch (error: unknown) {
      // Redaction: emit only the SDK's own `error.message` (or a safe
      // fallback for non-Error throwables). The `apiKey` local from the
      // try-block is not in scope here, but even if it were, it would
      // never be appended to a log string.
      let errorMessage: string;

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else {
        errorMessage = '<non-Error throwable>';
      }

      this.logger.warn(`Anthropic health probe failed: ${errorMessage}`);

      return false;
    }
  }
}
