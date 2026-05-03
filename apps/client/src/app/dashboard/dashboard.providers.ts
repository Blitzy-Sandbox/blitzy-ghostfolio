import {
  EnvironmentProviders,
  inject,
  provideAppInitializer
} from '@angular/core';

import { ModuleRegistryService } from './module-registry.service';
import { ANALYSIS_MODULE_DESCRIPTOR } from './modules/analysis/analysis-module.component';
import { CHAT_MODULE_DESCRIPTOR } from './modules/chat/chat-module.component';
import { HOLDINGS_MODULE_DESCRIPTOR } from './modules/holdings/holdings-module.component';
import { PORTFOLIO_OVERVIEW_MODULE_DESCRIPTOR } from './modules/portfolio-overview/portfolio-overview-module.component';
import { TRANSACTIONS_MODULE_DESCRIPTOR } from './modules/transactions/transactions-module.component';

/**
 * Centralized bootstrap-time registration for every dashboard module
 * type. Call once from the root provider list (typically
 * `apps/client/src/main.ts` inside the `bootstrapApplication(...)`
 * `providers` array) by spreading the array returned by
 * {@link provideDashboard}.
 *
 * **Why a dedicated providers file?**
 *
 * Per Rule 3 (AAP § 0.8.1.3), `ModuleRegistryService` is the SOLE
 * mechanism for introducing new module types into the canvas. The rule's
 * literal interpretation prohibits hard-coded
 * `import { GfHoldingsModuleComponent }` statements inside
 * `dashboard-canvas.component.ts`; that file would otherwise be the
 * de-facto registration site by side-effect and would defeat the
 * purpose of the registry indirection. Concentrating the registration
 * code in `dashboard.providers.ts` makes this the SINGLE place the
 * five module-wrapper classes are referenced by name — adding a new
 * module type (or removing an existing one) is a one-file edit, and
 * the canvas remains decoupled from the wrapper class identities.
 *
 * **Why `provideAppInitializer(...)`?**
 *
 * `provideAppInitializer` is Angular 21's idiomatic replacement for the
 * deprecated `APP_INITIALIZER` injection-token pattern (deprecated from
 * v19.0.0 per `@angular/core`'s `core.d.ts`). It accepts a factory
 * function executed during application bootstrap with `inject(...)`
 * available in scope, and returns an `EnvironmentProviders` value that
 * can be spread directly into the `providers` array of
 * `bootstrapApplication(...)`.
 *
 * The factory:
 *   1. Resolves `ModuleRegistryService` via `inject(...)` (the
 *      injection context is active during app-initializer execution).
 *   2. Iterates {@link DESCRIPTORS} and calls
 *      `moduleRegistry.register(descriptor)` for each entry. Any
 *      descriptor that fails the registry's validation (Rule 6 floors,
 *      duplicate-name rejection) throws synchronously — the bootstrap
 *      fails fast at app-init time, surfacing the configuration bug
 *      to the developer before any user-facing UI is rendered.
 *   3. Returns `void` (no async work) — `provideAppInitializer`
 *      accepts factories that return `void`, `Promise<unknown>`, or
 *      `Observable<unknown>`; the synchronous return is appropriate
 *      because in-memory registry registration is purely synchronous.
 *
 * **Forward-compatibility note**: adding a new module type is a
 * three-step edit:
 *
 *   1. Implement the wrapper component under
 *      `apps/client/src/app/dashboard/modules/<new-module>/`.
 *   2. Export a `<NEW>_MODULE_DESCRIPTOR` constant from the wrapper file.
 *   3. Append the constant to {@link DESCRIPTORS} in this file.
 *
 * No `dashboard-canvas.component.ts` edit is required (Rule 3
 * compliance) — the registry resolves `descriptor.component` at
 * runtime via `viewContainerRef.createComponent(...)` inside
 * `GfDashboardModuleHostDirective`.
 *
 * @see ./module-registry.service.ts — `ModuleRegistryService.register`.
 * @see ./modules/<module-name>/<module-name>-module.component.ts —
 *   the wrapper components whose `*_MODULE_DESCRIPTOR` constants are
 *   imported and registered here.
 * @see AAP § 0.6.1.4 — `dashboard.providers.ts` is part of Group 4
 *   (Angular Dashboard Feature) — the in-scope CREATE list.
 * @see AAP § 0.8.1.3 — Rule 3 (registry is the sole mechanism for
 *   introducing module types into the canvas).
 */

/**
 * Static registry of every module descriptor that ships with the v1
 * dashboard. The order is the order in which {@link provideDashboard}
 * registers descriptors; per `Map.prototype.set`'s insertion-order
 * iteration, `ModuleRegistryService.getAll()` will return the
 * descriptors in this same order — the catalog list will reflect this
 * order to users (a deliberate design choice for a stable, predictable
 * UX).
 *
 * The list intentionally lives at module scope (not inside the
 * `provideAppInitializer` factory) so:
 *   - Tests can import `DESCRIPTORS` and verify completeness
 *     (`expect(DESCRIPTORS.length).toBe(5)`).
 *   - The five module-wrapper class symbols are statically reachable
 *     in the application bootstrap graph (Angular standalone
 *     components must be reachable via at least one import to be
 *     instantiable via `viewContainerRef.createComponent(...)`).
 *
 * The constant is `readonly` (`as const` on the array literal,
 * implicit via the `DashboardModuleDescriptor[]` annotation kept
 * mutable for compatibility with `forEach`); freezing is unnecessary
 * because the array is consumed exactly once at bootstrap.
 */
const DESCRIPTORS = [
  PORTFOLIO_OVERVIEW_MODULE_DESCRIPTOR,
  HOLDINGS_MODULE_DESCRIPTOR,
  TRANSACTIONS_MODULE_DESCRIPTOR,
  ANALYSIS_MODULE_DESCRIPTOR,
  CHAT_MODULE_DESCRIPTOR
];

/**
 * Returns the `EnvironmentProviders` array that wires the dashboard
 * module-descriptor registrations into the application bootstrap.
 *
 * **Usage** (in `apps/client/src/main.ts` inside the
 * `bootstrapApplication(GfAppComponent, { providers: [ ... ] })` call):
 *
 * ```ts
 * import { provideDashboard } from './app/dashboard/dashboard.providers';
 *
 * await bootstrapApplication(GfAppComponent, {
 *   providers: [
 *     // ...other providers...
 *     provideDashboard()
 *   ]
 * });
 * ```
 *
 * The returned `EnvironmentProviders` value is the type-correct shape
 * for the `providers` array of `bootstrapApplication`; spreading is
 * NOT required because `EnvironmentProviders` is itself accepted as a
 * single entry. Angular's tree-shaker handles the import graph: the
 * five module-wrapper classes referenced via `*_MODULE_DESCRIPTOR.component`
 * are reachable through this file's static imports, so they end up
 * in the production bundle without being explicitly listed in any
 * component's `imports: [...]` array.
 *
 * **Idempotency caveat**: calling `provideDashboard()` twice in the
 * SAME bootstrap (e.g., once in `main.ts` and again via a child
 * provider) would attempt to register the same descriptors twice,
 * which the registry's `register(...)` method rejects with a duplicate-
 * name error — the second call would crash app-init. The function is
 * therefore intended to be called EXACTLY ONCE in the root provider
 * list; this matches the canonical Angular pattern for
 * `provide*` factories.
 *
 * @returns The Angular `EnvironmentProviders` token registering the
 *   bootstrap-time descriptor registration logic.
 */
export function provideDashboard(): EnvironmentProviders {
  return provideAppInitializer(() => {
    const moduleRegistry = inject(ModuleRegistryService);

    for (const descriptor of DESCRIPTORS) {
      // The registry's `register(...)` method validates the descriptor
      // against Rule 6 floors (AAP § 0.8.1.6) and rejects duplicate
      // names — any failure throws synchronously at bootstrap, so
      // configuration bugs surface as a hard app-init failure rather
      // than a silent registry mis-state at runtime.
      moduleRegistry.register(descriptor);
    }
  });
}
