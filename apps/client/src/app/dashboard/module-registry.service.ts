import { Injectable } from '@angular/core';

import { DashboardModuleDescriptor } from './interfaces/dashboard-module.interface';

/**
 * Dashboard module registry — the single source of allowed grid-item
 * component types in the modular dashboard (Rule 3, AAP § 0.8.1.3).
 *
 * Module wrappers register themselves once at app bootstrap (typically
 * inside an `APP_INITIALIZER` factory or a side-effect imported in the
 * dashboard canvas's `imports` chain). The canvas
 * (`GfDashboardCanvasComponent`) resolves a {@link DashboardModuleDescriptor}
 * by name when hydrating a saved layout or processing a catalog
 * `addModule` event; it then instantiates the descriptor's `component`
 * via `viewContainerRef.createComponent(...)` — never via a hard-coded
 * import or switch statement. This is the runtime mechanism that
 * enforces Rule 3 (AAP § 0.8.1.3): the module registry MUST be the only
 * mechanism for introducing new module types into the canvas; ad-hoc
 * component insertion is prohibited.
 *
 * **Validation rules enforced at registration time** (Rule 6,
 * AAP § 0.8.1.6):
 *
 * - `name` MUST be a non-empty string (post-`trim()` length > 0).
 * - The same `name` MUST NOT be registered twice (duplicate-name
 *   rejection — protects the single-source-of-truth contract from
 *   subtle mis-registrations such as two wrappers fighting over the
 *   `'chat'` name).
 * - `minCols` and `minRows` MUST each be ≥ 2 — the global 2 × 2 minimum
 *   module size from the prompt's grid spec (AAP § 0.6.1, § 0.8.1.6).
 * - `defaultCols` MUST be ≥ `minCols`; `defaultRows` MUST be ≥ `minRows`
 *   (the catalog's default placement size cannot be smaller than the
 *   engine-enforced minimum because the gridster engine would
 *   immediately re-bound the freshly-added item, producing a
 *   visually surprising "snap" on add).
 *
 * Validation failures throw a synchronous `Error`; callers are expected
 * to register descriptors statically at bootstrap, where any error is a
 * deterministic developer-time failure rather than a runtime user-facing
 * fault. This is the canonical "fail fast at boot" posture for an
 * invariant-checked registry — silent `console.warn` or no-op behavior
 * would mask configuration bugs until a user opened the catalog and
 * attempted to add the broken module.
 *
 * **DI scope**: declared with `@Injectable({ providedIn: 'root' })` so
 * the registry is a singleton across the entire client app. This is
 * structurally required by Rule 3 — a multi-instance registry would
 * fragment the source of authority.
 *
 * **Anti-pattern guard**: the service intentionally exposes NO
 * `unregister`, `clear`, or `replace` API. Module types are registered
 * once at bootstrap and never removed during a runtime session; this
 * is part of the single-source-of-truth contract (Rule 3) and prevents
 * a class of bugs where a runtime caller could invalidate persisted
 * `LayoutItem.moduleId` references by removing the descriptor those
 * references point to.
 *
 * @see ./interfaces/dashboard-module.interface.ts —
 *   {@link DashboardModuleDescriptor} structural contract.
 * @see AAP § 0.6.1.4 — Group 4 file contract (the
 *   `register / getAll / getByName` triple is the exact public surface
 *   promised in the AAP).
 * @see AAP § 0.8.1.3 — Rule 3 (registry is the sole mechanism for
 *   introducing module types).
 * @see AAP § 0.8.1.6 — Rule 6 (modules declare minimum cell dimensions;
 *   the grid engine enforces them).
 */
@Injectable({
  providedIn: 'root'
})
export class ModuleRegistryService {
  /**
   * In-memory map of registered module descriptors keyed by
   * {@link DashboardModuleDescriptor.name}. The choice of `Map` (not a
   * plain object) is deliberate:
   *
   * - O(1) `has` / `get` / `set` lookups — the canvas calls
   *   {@link getByName} on every layout-hydration step, so constant-time
   *   resolution matters as the catalog grows.
   * - Deterministic insertion-order iteration via `values()` — keeps
   *   {@link getAll} stable across calls within a session, which makes
   *   the catalog's row order predictable for users.
   * - No string-key collision with `Object.prototype` keys (e.g.,
   *   `'constructor'`, `'__proto__'`) — a `Map` cannot accidentally
   *   collide with prototype slots.
   *
   * The registry is typically small (≈ 5 entries — the five required
   * modules per AAP § 0.6.1.4: portfolio-overview, holdings,
   * transactions, analysis, chat), so memory overhead of `Map` is
   * negligible.
   */
  private readonly registry = new Map<string, DashboardModuleDescriptor>();

  /**
   * Registers a module type with the registry. Validates the descriptor
   * (Rule 6, AAP § 0.8.1.6) and rejects duplicate registrations.
   *
   * **Failure modes** (all synchronous `throw new Error(...)`):
   *
   * - `name` is empty / whitespace-only.
   * - `minCols` is below the 2-col global floor.
   * - `minRows` is below the 2-row global floor.
   * - `defaultCols` is below the descriptor's own `minCols`.
   * - `defaultRows` is below the descriptor's own `minRows`.
   * - A descriptor with the same `name` is already registered.
   *
   * Each error message includes the module name (when available) for
   * traceability and explicitly cites Rule 6 / AAP § 0.8.1.6 for the
   * dimension-floor failures so reviewers can quickly map the error
   * back to the canonical specification.
   *
   * **Bootstrap-time-only**: the recommended call pattern is for each
   * module wrapper file (e.g., `chat-module.component.ts`) to register
   * itself once via a side-effect import or via an
   * `APP_INITIALIZER` factory that injects the registry. The registry
   * does NOT auto-register modules from its constructor — registration
   * is a deliberate bootstrap-time act performed by each module
   * wrapper. The dashboard-canvas agent owns the orchestration of this
   * registration sequence at app-init time.
   *
   * @param metadata The {@link DashboardModuleDescriptor} to register.
   *   Must satisfy all validation rules listed above.
   * @throws {Error} When the descriptor fails validation or duplicates
   *   an already-registered name.
   */
  public register(metadata: DashboardModuleDescriptor): void {
    this.validate(metadata);

    if (this.registry.has(metadata.name)) {
      // Duplicate registrations are a deterministic developer error —
      // throwing at bootstrap surfaces the conflict immediately rather
      // than letting two wrappers silently overwrite each other (which
      // would produce a hard-to-debug "wrong component renders" symptom
      // long after registration).
      throw new Error(
        `ModuleRegistryService: duplicate registration for module name "${metadata.name}".`
      );
    }

    this.registry.set(metadata.name, metadata);
  }

  /**
   * Returns a snapshot of all registered module descriptors.
   *
   * The returned array is a fresh copy of the internal `Map`'s values
   * — mutations to the array (e.g., `result.push(...)`,
   * `result.splice(...)`) do NOT affect the registry's internal state.
   * This defensive-copy posture protects the single-source-of-truth
   * contract (Rule 3): callers cannot smuggle a new module into the
   * registry by mutating the array `getAll()` returns.
   *
   * The iteration order is the insertion order of registrations
   * (per the `Map.prototype.values()` specification). Tests treat the
   * result as a set rather than a sequence, but consumers that rely on
   * deterministic ordering (e.g., the catalog's row order) can depend
   * on insertion order being stable within a session.
   *
   * Typical caller: `GfModuleCatalogComponent` populates its
   * `MatList` rows by mapping over the descriptors returned here.
   *
   * @returns A new array containing each registered
   *   {@link DashboardModuleDescriptor}. Empty if no modules have been
   *   registered yet (e.g., during very early app-init before the
   *   bootstrap registration phase has run).
   */
  public getAll(): DashboardModuleDescriptor[] {
    // Defensive copy: `Array.from(map.values())` allocates a new array
    // each call. Mutations to the returned array do not affect the
    // internal registry — protects Rule 3 from mutations-via-getter.
    return Array.from(this.registry.values());
  }

  /**
   * Looks up a module descriptor by its stable {@link
   * DashboardModuleDescriptor.name} key. Lookups are case-sensitive
   * and O(1) (Map-backed).
   *
   * Typical caller: `GfDashboardCanvasComponent` invokes this method
   * once per persisted `LayoutItem.moduleId` while hydrating a saved
   * layout. A `undefined` return value means the persisted layout
   * references a module type that is no longer registered (e.g., a
   * module was renamed or deprecated since the layout was saved).
   * The canvas is responsible for handling the `undefined` case
   * gracefully — typically by skipping the orphaned item rather than
   * crashing the page.
   *
   * @param name The stable module name (e.g., `'chat'`,
   *   `'holdings'`, `'portfolio-overview'`). Lookup is case-sensitive.
   * @returns The matching {@link DashboardModuleDescriptor}, or
   *   `undefined` if no module with that name is registered.
   */
  public getByName(name: string): DashboardModuleDescriptor | undefined {
    return this.registry.get(name);
  }

  /**
   * Validates a descriptor against the runtime invariants documented
   * on {@link DashboardModuleDescriptor} and Rule 6 (AAP § 0.8.1.6).
   *
   * This method is intentionally separate from {@link register} so
   * that the validation rules (and their error messages) live in one
   * place and so that future entry points (e.g., a hypothetical bulk
   * `registerAll(...)` API — currently out of scope) could share the
   * exact same validation surface without code duplication.
   *
   * The validation rules are:
   *
   * 1. `name` must be a non-empty string after `trim()` — guards
   *    against the common bug of accidentally registering with `''` or
   *    `'   '`, both of which would corrupt the `Map`'s key space.
   * 2. `minCols >= 2` — Rule 6 floor (AAP § 0.8.1.6).
   * 3. `minRows >= 2` — Rule 6 floor (AAP § 0.8.1.6).
   * 4. `defaultCols >= minCols` — the catalog's default placement
   *    size cannot be smaller than the descriptor's own minimum.
   * 5. `defaultRows >= minRows` — same as above for rows.
   *
   * Order of checks: the `name` check runs first because subsequent
   * error messages reference `metadata.name`; running them on an
   * undefined / empty name would produce confusing diagnostic text.
   *
   * @param metadata The descriptor to validate.
   * @throws {Error} On any validation failure, with a message that
   *   identifies the failing module by name (when available) and
   *   cites Rule 6 / AAP § 0.8.1.6 for the dimension-floor failures.
   */
  private validate(metadata: DashboardModuleDescriptor): void {
    if (!metadata.name || metadata.name.trim().length === 0) {
      // Run this guard first so subsequent error messages can safely
      // interpolate `metadata.name` for traceability.
      throw new Error(
        'ModuleRegistryService: descriptor.name must be a non-empty string.'
      );
    }

    if (metadata.minCols < 2) {
      throw new Error(
        `ModuleRegistryService: descriptor "${metadata.name}" minCols (${metadata.minCols}) must be at least 2 (Rule 6, AAP § 0.8.1.6).`
      );
    }

    if (metadata.minRows < 2) {
      throw new Error(
        `ModuleRegistryService: descriptor "${metadata.name}" minRows (${metadata.minRows}) must be at least 2 (Rule 6, AAP § 0.8.1.6).`
      );
    }

    if (metadata.defaultCols < metadata.minCols) {
      throw new Error(
        `ModuleRegistryService: descriptor "${metadata.name}" defaultCols (${metadata.defaultCols}) must be ≥ minCols (${metadata.minCols}).`
      );
    }

    if (metadata.defaultRows < metadata.minRows) {
      throw new Error(
        `ModuleRegistryService: descriptor "${metadata.name}" defaultRows (${metadata.defaultRows}) must be ≥ minRows (${metadata.minRows}).`
      );
    }
  }
}
