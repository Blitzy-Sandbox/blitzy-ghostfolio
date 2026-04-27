import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * AnthropicHealthIndicator
 *
 * Provider-aware configuration-only health probe for the AI provider
 * integration that backs the AI Portfolio Chat Agent (Feature B,
 * AAP § 0.1.1) and the Explainable Rebalancing Engine (Feature C,
 * AAP § 0.1.1).
 *
 * **Class name preservation (Refine PR Directive 4):** The class name
 * remains `AnthropicHealthIndicator` (no cascading rename) and the
 * route remains `GET /api/v1/health/anthropic`. The directive
 * explicitly requires this — a rename would force callers (operators,
 * dashboards, monitoring systems, k8s liveness/readiness probes) to
 * rewire endpoints. Internally, the probe is now multi-provider; the
 * historical name reflects only the first provider integration that
 * shipped.
 *
 * **Provider switch (Refine PR Directive 4 explicit cases):**
 *
 *   - `anthropic` → returns `true` iff `ANTHROPIC_API_KEY` is non-empty.
 *   - `openai`    → returns `true` iff `OPENAI_API_KEY` is non-empty.
 *   - `google`    → returns `true` iff `GOOGLE_API_KEY` is non-empty.
 *   - `ollama`    → ALWAYS returns `true`. Ollama is a locally-hosted
 *                  inference server reached via a base URL (default
 *                  `http://localhost:11434/v1`); no provider API key
 *                  is required, so the credential check is a no-op.
 *   - **unknown** → returns `false` (the directive's explicit "unknown
 *                  provider values return false" rule). Operators who
 *                  set `AI_PROVIDER` to an unsupported value (e.g.,
 *                  `mistral`, `cohere`, `bedrock`) get a fail-closed
 *                  health probe so misconfiguration surfaces in
 *                  monitoring instead of silently masquerading as OK.
 *
 * **Default (unset):** When `AI_PROVIDER` is unset, the indicator
 * resolves to `'anthropic'` — matching `AiProviderService`'s
 * `DEFAULT_PROVIDER`. This keeps the health probe consistent with the
 * model factory's actual runtime selection.
 *
 * **Hard rules enforced by this class** (see AAP § 0.7):
 *
 * - **Rule 3 (Credential Access — § 0.7.1.3):** All credential reads
 *   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) and the
 *   `AI_PROVIDER` selector are accessed EXCLUSIVELY through the
 *   injected `ConfigService`. Direct `process.env.<...>` access for
 *   any of these variables is PROHIBITED and absent from this file.
 *
 * - **Logging redaction (§ 0.7.3):** Credential values are NEVER
 *   substituted into log lines. Failure messages disclose only
 *   literal strings (e.g., "ANTHROPIC_API_KEY missing") and the
 *   provider name (a finite enum, never a credential). The
 *   `AI_PROVIDER` value is logged on the unknown-provider branch so
 *   operators can debug typos — this is intentional and
 *   credential-safe (`AI_PROVIDER` is not a secret).
 *
 * - **Configuration-only probe (§ 0.5.1.2):** The probe verifies
 *   credential PRESENCE only — it does NOT instantiate any provider
 *   SDK and does NOT issue any network request. This is critical for
 *   liveness/readiness probes that may run every few seconds; sending
 *   real provider requests would incur paid API usage on every health
 *   tick.
 *
 * - **Fail-closed contract:** Mirrors the
 *   `HealthService.isDatabaseHealthy()` and `isRedisCacheHealthy()`
 *   convention. Returns `Promise<boolean>` and never throws; every
 *   exceptional path funnels to `false`.
 *
 * **Module registration:** Registered as a provider in
 * `HealthModule.providers` and exposed via the
 * `GET /api/v1/health/anthropic` route on `HealthController`. The
 * module additively imports `ConfigModule` so this class's
 * `ConfigService` constructor dependency resolves at DI scope
 * construction time (Ghostfolio's root `ConfigModule.forRoot()` is
 * not declared global). This wiring operationalizes
 * AAP § 0.4.1.2 + § 0.5.1.2 ("Additive — registered alongside
 * existing health indicators") and the Observability project-level
 * rule (AAP § 0.7.2).
 */
@Injectable()
export class AnthropicHealthIndicator {
  /**
   * Default provider used when `AI_PROVIDER` is unset. Matches
   * `AiProviderService.DEFAULT_PROVIDER` so the probe is consistent
   * with the actual runtime model-factory selection.
   */
  private static readonly DEFAULT_PROVIDER = 'anthropic';

  /**
   * Set of recognized `AI_PROVIDER` values. Operators who set the
   * variable to anything outside this set get a fail-closed health
   * probe (per Refine PR Directive 4).
   */
  private static readonly KNOWN_PROVIDERS = [
    'anthropic',
    'openai',
    'google',
    'ollama'
  ] as const;

  private readonly logger = new Logger(AnthropicHealthIndicator.name);

  public constructor(private readonly configService: ConfigService) {}

  /**
   * Performs a provider-aware configuration-only readiness probe.
   *
   * Behavior (Refine PR Directive 4):
   *   1. Reads `AI_PROVIDER` through the injected `ConfigService`.
   *      If unset, defaults to `'anthropic'`.
   *   2. Switches on the resolved provider and reads the matching
   *      credential through the injected `ConfigService`.
   *   3. Returns `true` iff the credential is present (non-empty
   *      string), or — for `ollama` — unconditionally returns `true`.
   *   4. For unknown providers, returns `false` (fail-closed) and
   *      logs a warning naming the offending value.
   *
   * No network call is made by this method on any branch.
   *
   * @returns `true` when the configured provider has its required
   *          credential present (or is `ollama`); `false` when the
   *          credential is missing or the provider is unknown.
   */
  public async isHealthy(): Promise<boolean> {
    try {
      // Read the AI_PROVIDER selector first so we know which
      // credential to validate. Fall back to the default when unset
      // — matches `AiProviderService.DEFAULT_PROVIDER` so the probe
      // is consistent with actual runtime selection.
      const rawProvider = this.configService.get<string>('AI_PROVIDER');
      const provider = (
        rawProvider && rawProvider.length > 0
          ? rawProvider
          : AnthropicHealthIndicator.DEFAULT_PROVIDER
      ).toLowerCase();

      switch (provider) {
        case 'anthropic': {
          const apiKey =
            this.configService.get<string>('ANTHROPIC_API_KEY') ?? '';
          if (apiKey.length === 0) {
            this.logger.warn(
              'AI provider health probe failed: ANTHROPIC_API_KEY missing (provider=anthropic)'
            );
            return false;
          }
          return true;
        }

        case 'openai': {
          const apiKey = this.configService.get<string>('OPENAI_API_KEY') ?? '';
          if (apiKey.length === 0) {
            this.logger.warn(
              'AI provider health probe failed: OPENAI_API_KEY missing (provider=openai)'
            );
            return false;
          }
          return true;
        }

        case 'google': {
          const apiKey = this.configService.get<string>('GOOGLE_API_KEY') ?? '';
          if (apiKey.length === 0) {
            this.logger.warn(
              'AI provider health probe failed: GOOGLE_API_KEY missing (provider=google)'
            );
            return false;
          }
          return true;
        }

        case 'ollama': {
          // Local inference: no provider API key is required. The
          // probe unconditionally reports OK so health checks do
          // not flap on locally-hosted models.
          return true;
        }

        default: {
          // Unknown provider value (per Refine PR Directive 4:
          // "Unknown provider values return false"). Logging the
          // offending value (which is NOT a secret — `AI_PROVIDER`
          // is a configuration selector, not a credential) helps
          // operators debug typos like `AI_PROVIDER=Anthropic`
          // (case mismatch — already lowercased above) or
          // `AI_PROVIDER=bedrock` (unsupported provider).
          this.logger.warn(
            `AI provider health probe failed: unknown AI_PROVIDER='${provider}' ` +
              `(known providers: ${AnthropicHealthIndicator.KNOWN_PROVIDERS.join(
                ', '
              )})`
          );
          return false;
        }
      }
    } catch (error: unknown) {
      // Redaction: emit only the underlying `error.message` (or a
      // safe fallback for non-Error throwables). Credential values
      // are never substituted into log strings — the catch block
      // does not have access to the credential locals from the
      // `case` blocks (lexical scope), and even if it did, none
      // would be substituted here.
      let errorMessage: string;

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else {
        errorMessage = '<non-Error throwable>';
      }

      this.logger.warn(`AI provider health probe failed: ${errorMessage}`);

      return false;
    }
  }
}
