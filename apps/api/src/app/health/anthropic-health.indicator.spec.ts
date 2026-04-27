import { ConfigService } from '@nestjs/config';

import { AnthropicHealthIndicator } from './anthropic-health.indicator';

/**
 * Unit tests for `AnthropicHealthIndicator` — the provider-aware
 * configuration-only health probe for the AI provider integration
 * backing the AI Portfolio Chat Agent (Feature B) and the
 * Explainable Rebalancing Engine (Feature C).
 *
 * Source-of-truth references:
 *   - **Refine PR Directive 4** — explicit pass/fail criteria:
 *     * `anthropic` → `ANTHROPIC_API_KEY` non-empty
 *     * `openai` → `OPENAI_API_KEY` non-empty
 *     * `google` → `GOOGLE_API_KEY` non-empty
 *     * `ollama` → always `true` (local, no key required)
 *     * Unknown provider values return `false`
 *     * Class name remains `AnthropicHealthIndicator` (no cascading
 *       rename).
 *
 *   - **AAP § 0.7.1.3 (Rule 3 — Credential Access via ConfigService)**
 *     — credential reads MUST go through the injected
 *     `ConfigService`, never `process.env`. Verified by Test 9 via
 *     source-text grep.
 *
 *   - **AAP § 0.5.1.2 (Configuration-only probe)** — the indicator
 *     MUST NOT make any network call. Verified by the absence of
 *     any provider-SDK import in the production source.
 */
describe('AnthropicHealthIndicator', () => {
  /**
   * Strongly-typed shape of the `ConfigService` mock. The production
   * `isHealthy()` reads up to 4 keys per call: `AI_PROVIDER` plus
   * one provider-specific credential.
   */
  interface ConfigServiceMock {
    get: jest.Mock<string | undefined, [string]>;
  }

  /**
   * Helper to build a `ConfigService` mock from a static
   * key→value map. Keys not present in the map resolve to
   * `undefined` — matching `ConfigService.get`'s actual semantics
   * for unset env vars.
   */
  function buildConfigMock(
    map: Record<string, string | undefined>
  ): ConfigServiceMock {
    return {
      get: jest.fn((key: string): string | undefined => map[key])
    };
  }

  /**
   * Helper to build a fresh indicator for each test. Direct service
   * instantiation per the canonical Ghostfolio service-spec
   * convention.
   */
  function buildIndicator(configMap: Record<string, string | undefined>): {
    configService: ConfigServiceMock;
    indicator: AnthropicHealthIndicator;
  } {
    const configService = buildConfigMock(configMap);
    const indicator = new AnthropicHealthIndicator(
      configService as unknown as ConfigService
    );
    return { configService, indicator };
  }

  // -------------------------------------------------------------------------
  // Test 1 — anthropic provider with present ANTHROPIC_API_KEY
  // -------------------------------------------------------------------------

  it('returns true when AI_PROVIDER=anthropic and ANTHROPIC_API_KEY is non-empty', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-key'
    });

    await expect(indicator.isHealthy()).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2 — anthropic provider with missing ANTHROPIC_API_KEY
  // -------------------------------------------------------------------------

  it('returns false when AI_PROVIDER=anthropic and ANTHROPIC_API_KEY is missing', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'anthropic'
      // ANTHROPIC_API_KEY deliberately absent
    });

    await expect(indicator.isHealthy()).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — anthropic provider with empty-string ANTHROPIC_API_KEY
  // -------------------------------------------------------------------------

  it('returns false when AI_PROVIDER=anthropic and ANTHROPIC_API_KEY is an empty string', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: ''
    });

    await expect(indicator.isHealthy()).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4 — openai provider with present OPENAI_API_KEY
  // -------------------------------------------------------------------------

  it('returns true when AI_PROVIDER=openai and OPENAI_API_KEY is non-empty', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-openai-key'
    });

    await expect(indicator.isHealthy()).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5 — openai provider with missing OPENAI_API_KEY
  // -------------------------------------------------------------------------

  it('returns false when AI_PROVIDER=openai and OPENAI_API_KEY is missing', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'openai'
      // OPENAI_API_KEY deliberately absent
    });

    await expect(indicator.isHealthy()).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6 — google provider with present GOOGLE_API_KEY
  // -------------------------------------------------------------------------

  it('returns true when AI_PROVIDER=google and GOOGLE_API_KEY is non-empty', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'google',
      GOOGLE_API_KEY: 'goog-test-key'
    });

    await expect(indicator.isHealthy()).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7 — google provider with missing GOOGLE_API_KEY
  // -------------------------------------------------------------------------

  it('returns false when AI_PROVIDER=google and GOOGLE_API_KEY is missing', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'google'
      // GOOGLE_API_KEY deliberately absent
    });

    await expect(indicator.isHealthy()).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 8 — ollama provider always returns true (no key required)
  // -------------------------------------------------------------------------

  it('returns true when AI_PROVIDER=ollama regardless of any credential presence (local inference)', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'ollama'
      // No credentials set — ollama is local, none required.
    });

    await expect(indicator.isHealthy()).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9 — ollama provider with all credentials missing returns true
  //          (extra defensive check that no credential validation
  //           leaked into the ollama branch)
  // -------------------------------------------------------------------------

  it('returns true when AI_PROVIDER=ollama and ALL provider credentials are absent', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'ollama'
    });

    await expect(indicator.isHealthy()).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 10 — unknown provider returns false (fail-closed)
  // -------------------------------------------------------------------------

  it('returns false when AI_PROVIDER is set to an unknown value (fail-closed)', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'mistral'
    });

    await expect(indicator.isHealthy()).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 11 — unset AI_PROVIDER falls back to anthropic (matching
  //           AiProviderService.DEFAULT_PROVIDER)
  // -------------------------------------------------------------------------

  it('falls back to anthropic when AI_PROVIDER is unset and uses ANTHROPIC_API_KEY', async () => {
    const { indicator } = buildIndicator({
      // AI_PROVIDER deliberately absent — should default to
      // 'anthropic' per AiProviderService.DEFAULT_PROVIDER.
      ANTHROPIC_API_KEY: 'sk-ant-test-key'
    });

    await expect(indicator.isHealthy()).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 12 — unset AI_PROVIDER + missing ANTHROPIC_API_KEY returns
  //           false
  // -------------------------------------------------------------------------

  it('falls back to anthropic when AI_PROVIDER is unset; returns false when ANTHROPIC_API_KEY is also missing', async () => {
    const { indicator } = buildIndicator({});

    await expect(indicator.isHealthy()).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 13 — case-insensitive provider value (e.g., 'Anthropic') is
  //           normalized to lowercase
  // -------------------------------------------------------------------------

  it('normalizes the AI_PROVIDER value to lowercase before switching', async () => {
    const { indicator } = buildIndicator({
      AI_PROVIDER: 'Anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-key'
    });

    await expect(indicator.isHealthy()).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 14 — class name preservation (Refine PR Directive 4 explicit
  //           "no cascading rename" requirement)
  // -------------------------------------------------------------------------

  it('class is named AnthropicHealthIndicator (no cascading rename per Refine PR Directive 4)', () => {
    const { indicator } = buildIndicator({});
    expect(indicator.constructor.name).toBe('AnthropicHealthIndicator');
  });

  // -------------------------------------------------------------------------
  // Test 15 — does not import the raw @anthropic-ai/sdk package and
  //           does not access process.env directly
  // -------------------------------------------------------------------------

  it('source code does NOT contain process.env.ANTHROPIC / process.env.OPENAI / process.env.GOOGLE references and does NOT import @anthropic-ai/sdk', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require('node:fs');
    const path = require('node:path');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const sourceText = fs.readFileSync(
      path.join(__dirname, 'anthropic-health.indicator.ts'),
      'utf8'
    );

    expect(sourceText).not.toMatch(/process\.env\.ANTHROPIC/);
    expect(sourceText).not.toMatch(/process\.env\.OPENAI/);
    expect(sourceText).not.toMatch(/process\.env\.GOOGLE/);
    expect(sourceText).not.toMatch(/from '@anthropic-ai\/sdk'/);
    expect(sourceText).not.toMatch(/from "@anthropic-ai\/sdk"/);
  });
});
