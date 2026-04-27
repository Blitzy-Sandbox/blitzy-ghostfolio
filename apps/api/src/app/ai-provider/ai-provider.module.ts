import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AiProviderService } from './ai-provider.service';

/**
 * `AiProviderModule` is the NestJS feature module that exposes
 * {@link AiProviderService} as a shared, injectable LLM factory across
 * the AI Portfolio Intelligence Layer (Refine PR Directive 1).
 *
 * Composition:
 *
 *   - **Providers:** `AiProviderService` — the factory class that reads
 *     `AI_PROVIDER` and `AI_MODEL` from `ConfigService` and produces a
 *     Vercel AI SDK `LanguageModel` instance via `getModel()`.
 *
 *   - **Exports:** `AiProviderService` — explicitly exported so that
 *     consuming feature modules (`AiChatModule`, `RebalancingModule`)
 *     can inject the factory through their own `imports: [AiProviderModule]`
 *     declarations. This is the canonical Rule 1 (Module Isolation)
 *     pattern (AAP § 0.7.1.1) — cross-module access ALWAYS goes through
 *     the source module's `exports` array.
 *
 *   - **Imports:** `ConfigModule` — required so `ConfigService` is in
 *     scope when `AiProviderService`'s constructor is resolved.
 *     Ghostfolio's root `app.module.ts` calls `ConfigModule.forRoot()`
 *     WITHOUT `isGlobal: true`, so child modules consuming
 *     `ConfigService` MUST explicitly re-import `ConfigModule` (per
 *     `@nestjs/config` documentation).
 *
 * Wiring (Refine PR Directive 1):
 *   - `AiProviderModule` is imported by `AiChatModule` (Refine PR
 *     Directive 2) so `AiChatService` can inject `AiProviderService`
 *     and call `getModel()` for `streamText(...)`.
 *   - `AiProviderModule` is imported by `RebalancingModule` (Refine PR
 *     Directive 3) so `RebalancingService` can inject
 *     `AiProviderService` and call `getModel()` for `generateText(...)`.
 *   - `AiProviderModule` is registered in `AppModule.imports` so the
 *     `OnModuleInit` startup log line ("AI provider: <name>, model:
 *     <name>") fires at application boot.
 */
@Module({
  exports: [AiProviderService],
  imports: [ConfigModule],
  providers: [AiProviderService]
})
export class AiProviderModule {}
