import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

/**
 * Allowed values for the `AI_PROVIDER` environment variable.
 *
 * Per Refine PR Directive 1, this service is the SOLE LLM factory across the
 * AI Portfolio Intelligence Layer (Features B and C). The four supported
 * provider keys are:
 *
 *   - `anthropic` — Anthropic Claude family (e.g., claude-3-5-sonnet)
 *   - `openai`    — OpenAI GPT family (e.g., gpt-4o)
 *   - `google`    — Google Gemini family (e.g., gemini-1.5-pro)
 *   - `ollama`    — Locally-hosted Ollama server (uses the OpenAI-compatible
 *                   `/v1` REST API by routing through `createOpenAI` with a
 *                   custom `baseURL` from `OLLAMA_BASE_URL`)
 *
 * The enum is exported so that {@link AiProviderService.spec.ts} and any
 * downstream tests can iterate exhaustively without hard-coding the four
 * literal strings.
 */
export type AiProvider = 'anthropic' | 'openai' | 'google' | 'ollama';

/**
 * `AiProviderService` is the **sole LLM factory** for all AI features in
 * the Ghostfolio AI Portfolio Intelligence Layer (Refine PR Directive 1).
 *
 * Responsibilities:
 *
 *   1. Read `AI_PROVIDER` and `AI_MODEL` from the injected NestJS
 *      `ConfigService` — NEVER from `process.env` directly. Direct
 *      `process.env` access for these variables is PROHIBITED by the
 *      directive (matches AAP § 0.7.1.3 Rule 3 in spirit even though
 *      `AI_PROVIDER` is a new variable that did not exist when Rule 3
 *      was written).
 *
 *   2. Resolve the requested provider to a Vercel AI SDK `LanguageModel`
 *      instance via the canonical provider-specific factory:
 *      `createAnthropic`, `createOpenAI`, or `createGoogleGenerativeAI`.
 *      Ollama is supported by passing a custom `baseURL` (default
 *      `http://localhost:11434/v1`) to `createOpenAI` — Ollama implements
 *      the OpenAI-compatible REST API at the `/v1` path, so the OpenAI
 *      provider can drive it transparently with no API key required.
 *
 *   3. Compute the model id from the resolved provider's default OR the
 *      operator-supplied `AI_MODEL` override. The directive specifies the
 *      `||` (OR) operator (NOT the `??` nullish-coalescing operator) for
 *      the fallback so that an explicitly-empty `AI_MODEL=` env var
 *      resolves to the provider default — empty string is treated as
 *      "use the default" rather than "use the literal empty string".
 *
 *   4. Emit a single startup log line on `OnModuleInit` reading
 *      `AI provider: <name>, model: <name>` so the deployed configuration
 *      is observable from the application logs (operationalizes the AAP
 *      § 0.7.2 Observability rule for this new module).
 *
 * Hard rules enforced by this class:
 *
 *   - **Rule 3 (Credential Access via ConfigService):** All env vars this
 *     service reads (`AI_PROVIDER`, `AI_MODEL`, `OPENAI_API_KEY`,
 *     `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL`) are read
 *     EXCLUSIVELY through the injected `ConfigService`. `process.env` is
 *     not accessed anywhere in this file. The Anthropic, OpenAI, and
 *     Google provider factories ALSO honor environment variables
 *     internally; we still pass the explicit `apiKey` to keep the
 *     credential path observable and auditable through ConfigService.
 *
 *   - **Default-on-empty fallback (Refine PR Directive 1):** Model
 *     resolution uses `||` so that `AI_MODEL=` (empty string) resolves
 *     to the per-provider default. The directive explicitly forbids
 *     `??` here.
 *
 *   - **Logging redaction:** The startup log line emits ONLY the
 *     provider name and the resolved model id. API keys are NEVER
 *     substituted into any log line.
 */
@Injectable()
export class AiProviderService implements OnModuleInit {
  /**
   * Default Claude model id used when the operator has not set
   * `AI_MODEL` AND `AI_PROVIDER=anthropic`. Stable dated alias rather
   * than the floating `claude-3-5-sonnet-latest` so deployed behavior
   * does not silently change on Anthropic minor revisions.
   */
  public static readonly DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';

  /**
   * Default OpenAI model id used when the operator has not set
   * `AI_MODEL` AND `AI_PROVIDER=openai`. `gpt-4o` is OpenAI's
   * production-grade multimodal model and matches the Refine PR
   * directive 1 default.
   */
  public static readonly DEFAULT_OPENAI_MODEL = 'gpt-4o';

  /**
   * Default Google Gemini model id used when the operator has not set
   * `AI_MODEL` AND `AI_PROVIDER=google`. `gemini-1.5-pro` is Google's
   * production-grade multimodal model and matches the Refine PR
   * directive 1 default.
   */
  public static readonly DEFAULT_GOOGLE_MODEL = 'gemini-1.5-pro';

  /**
   * Default Ollama model id used when the operator has not set
   * `AI_MODEL` AND `AI_PROVIDER=ollama`. `llama3.1` is the standard
   * Llama model name on Ollama and matches the Refine PR directive 1
   * default. Operators self-hosting other models (e.g., `qwen2.5:7b`,
   * `mistral`) override via `AI_MODEL=<their-model-tag>`.
   */
  public static readonly DEFAULT_OLLAMA_MODEL = 'llama3.1';

  /**
   * Default base URL for Ollama's OpenAI-compatible REST endpoint.
   * Ollama exposes the OpenAI v1 API at `/v1` on localhost port 11434
   * by default. Operators running Ollama on a non-default host or port
   * can override via `OLLAMA_BASE_URL=http://other-host:11434/v1`.
   */
  public static readonly DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

  /**
   * Default provider when `AI_PROVIDER` is unset. Anthropic is chosen as
   * the default because it preserves the original AAP § 0.1.1 design
   * (Claude as the canonical chat agent provider) and minimizes config
   * drift for existing deployments that were configured before this
   * multi-provider extension landed.
   */
  public static readonly DEFAULT_PROVIDER: AiProvider = 'anthropic';

  /**
   * Set of valid `AI_PROVIDER` values. Used to validate the operator-
   * supplied env var at construction time. Mismatches are logged and
   * the provider falls through to {@link DEFAULT_PROVIDER}.
   */
  private static readonly VALID_PROVIDERS: ReadonlySet<AiProvider> =
    new Set<AiProvider>(['anthropic', 'openai', 'google', 'ollama']);

  /**
   * Resolved provider name (after env var validation). Available after
   * the constructor runs.
   */
  private readonly resolvedProvider: AiProvider;

  /**
   * Resolved model id (after default-on-empty fallback). Available after
   * the constructor runs.
   */
  private readonly resolvedModel: string;

  public constructor(private readonly configService: ConfigService) {
    this.resolvedProvider = this.resolveProvider();
    this.resolvedModel = this.resolveModel(this.resolvedProvider);
  }

  /**
   * Emits the canonical startup log line on application boot:
   *
   *     AI provider: <name>, model: <name>
   *
   * Per Refine PR Directive 1 verification criteria, this exact format
   * MUST appear in server logs at startup for all four `AI_PROVIDER`
   * values. Using `OnModuleInit` (rather than the constructor) ensures
   * the log fires when NestJS is fully initialized and the global
   * Logger transports are wired up — constructor-time logging can race
   * the logger configuration and be lost in production.
   */
  public onModuleInit(): void {
    Logger.log(
      `AI provider: ${this.resolvedProvider}, model: ${this.resolvedModel}`,
      'AiProviderService'
    );
  }

  /**
   * Returns the resolved provider name (read-only accessor).
   *
   * Useful for observability code paths (e.g., the
   * `AnthropicHealthIndicator` switch on provider, the
   * `RebalancingService.no_tool_use` log line) that need to surface
   * which provider is currently configured.
   */
  public getProvider(): AiProvider {
    return this.resolvedProvider;
  }

  /**
   * Returns the resolved model id (read-only accessor).
   *
   * Available for log lines and metric labels that need to record
   * which model handled a given request.
   */
  public getModelId(): string {
    return this.resolvedModel;
  }

  /**
   * Returns a Vercel AI SDK `LanguageModel` instance for the configured
   * provider and model.
   *
   * The returned instance is the input expected by `streamText(...)` and
   * `generateText(...)` from the `ai` package — the two SDK primitives
   * consumed by `AiChatService` (Refine PR Directive 2) and
   * `RebalancingService` (Refine PR Directive 3).
   *
   * Implementation:
   *
   *   - `anthropic`: `createAnthropic({ apiKey })` →
   *                  `provider(modelId)`
   *   - `openai`:    `createOpenAI({ apiKey })` →
   *                  `provider(modelId)`
   *   - `google`:    `createGoogleGenerativeAI({ apiKey })` →
   *                  `provider(modelId)`
   *   - `ollama`:    `createOpenAI({ apiKey: 'ollama', baseURL })` →
   *                  `provider(modelId)` — Ollama implements OpenAI's
   *                  `/v1` REST API and accepts ANY non-empty string
   *                  as `apiKey` (it is ignored on the server side).
   *
   * Failure mode: if a provider's factory rejects the supplied apiKey
   * format synchronously (rare; most providers defer auth to the first
   * actual API call), the underlying error propagates to the caller.
   * Callers in the chat / rebalancing services translate the failure
   * to HTTP 502 BadGatewayException at request time.
   *
   * @returns A non-null `LanguageModel` instance bound to the configured
   *          provider+model combination.
   */
  public getModel(): LanguageModel {
    const modelId = this.resolvedModel;

    switch (this.resolvedProvider) {
      case 'anthropic': {
        const apiKey =
          this.configService.get<string>('ANTHROPIC_API_KEY') ?? '';
        const provider = createAnthropic({ apiKey });
        return provider(modelId);
      }

      case 'openai': {
        const apiKey = this.configService.get<string>('OPENAI_API_KEY') ?? '';
        const provider = createOpenAI({ apiKey });
        return provider(modelId);
      }

      case 'google': {
        const apiKey = this.configService.get<string>('GOOGLE_API_KEY') ?? '';
        const provider = createGoogleGenerativeAI({ apiKey });
        return provider(modelId);
      }

      case 'ollama': {
        // Ollama implements the OpenAI v1 REST API. Per Refine PR
        // Directive 1 we route through `createOpenAI` with a custom
        // `baseURL`. The apiKey is required by the OpenAI SDK plumbing
        // but ignored by Ollama's server — passing the literal string
        // "ollama" is the documented convention.
        const baseURL =
          this.configService.get<string>('OLLAMA_BASE_URL') ||
          AiProviderService.DEFAULT_OLLAMA_BASE_URL;
        const provider = createOpenAI({
          apiKey: 'ollama',
          baseURL
        });
        return provider(modelId);
      }

      default: {
        // Defense in depth: `resolveProvider()` validates against
        // VALID_PROVIDERS, so reaching this branch indicates a bug
        // upstream. Fall back to anthropic so the application keeps
        // running rather than crashing.
        const apiKey =
          this.configService.get<string>('ANTHROPIC_API_KEY') ?? '';
        const provider = createAnthropic({ apiKey });
        return provider(modelId);
      }
    }
  }

  /**
   * Resolves the `AI_PROVIDER` env var to a validated {@link AiProvider}
   * value. Empty / unset / unknown values fall through to
   * {@link DEFAULT_PROVIDER} with a warn-level log line so misconfig is
   * observable but does not crash the application.
   */
  private resolveProvider(): AiProvider {
    const raw = this.configService.get<string>('AI_PROVIDER');

    if (!raw) {
      // No AI_PROVIDER set — silently fall through to the default. This
      // is the expected path for deployments that have not yet adopted
      // the multi-provider configuration; their behavior is unchanged.
      return AiProviderService.DEFAULT_PROVIDER;
    }

    const trimmed = raw.trim().toLowerCase() as AiProvider;

    if (AiProviderService.VALID_PROVIDERS.has(trimmed)) {
      return trimmed;
    }

    // Unknown value — log a redacted warning and use the default. The
    // value itself IS logged (it's an env-var configuration string,
    // not a credential) so the operator can identify the typo.
    Logger.warn(
      `Unknown AI_PROVIDER='${raw}' — falling back to ${AiProviderService.DEFAULT_PROVIDER}`,
      'AiProviderService'
    );

    return AiProviderService.DEFAULT_PROVIDER;
  }

  /**
   * Resolves the model id for the given provider. Uses `||` for the
   * default fallback per Refine PR Directive 1 (NOT `??`) so that an
   * explicitly-empty `AI_MODEL=` env var resolves to the provider
   * default rather than the literal empty string.
   *
   * @param provider Resolved provider name (already validated).
   * @returns        Non-empty model id string.
   */
  private resolveModel(provider: AiProvider): string {
    // The configured override may legitimately be an empty string
    // (e.g., the operator unset it via `AI_MODEL=` in a docker compose
    // file). The directive REQUIRES `||` here — empty string falls
    // through to the per-provider default.
    const override = this.configService.get<string>('AI_MODEL');

    switch (provider) {
      case 'anthropic':
        return override || AiProviderService.DEFAULT_ANTHROPIC_MODEL;
      case 'openai':
        return override || AiProviderService.DEFAULT_OPENAI_MODEL;
      case 'google':
        return override || AiProviderService.DEFAULT_GOOGLE_MODEL;
      case 'ollama':
        return override || AiProviderService.DEFAULT_OLLAMA_MODEL;
      default:
        return override || AiProviderService.DEFAULT_ANTHROPIC_MODEL;
    }
  }
}
