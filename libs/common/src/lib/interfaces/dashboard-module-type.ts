/**
 * Canonical whitelist of dashboard module-type keys — the single source of
 * truth shared across the client module registry
 * (`apps/client/src/app/dashboard/module-registry.service.ts`), the persisted
 * `DashboardLayoutItem.type` values, and the server-side payload validation in
 * `apps/api/src/app/user/dtos/dashboard-layout.dto.ts`.
 *
 * Security (CWE-20 — Improper Input Validation): `PATCH /api/v1/user/layout`
 * accepts a caller-supplied `type` for every grid item. Constraining that
 * field to this fixed set with `@IsIn([...DASHBOARD_MODULE_TYPES])` rejects
 * unknown or adversarial keys with HTTP 400 at the `ValidationPipe` boundary,
 * so a persisted layout can never contain a `type` the client registry cannot
 * resolve (which would otherwise render as a blank, effectively unremovable
 * grid cell).
 *
 * Rule 3 / Rule 6: the registry remains the ONLY mechanism for introducing
 * module types and the declaration source for per-module minimum cell
 * dimensions; this list is the flat key contract those definitions must match.
 * `module-registry.service.spec.ts` asserts the registry's ids are exactly this
 * set, so the two cannot silently drift.
 *
 * Order mirrors the `MODULE_DEFINITIONS` declaration order in the client
 * registry. Adding or removing a module MUST update this list, the registry
 * definitions, and the drift-guard spec in lockstep.
 */
export const DASHBOARD_MODULE_TYPES = [
  'portfolio-overview',
  'holdings',
  'performance',
  'summary',
  'investment-chart',
  'market-overview',
  'watchlist',
  'fear-and-greed',
  'benchmark',
  'rebalancing',
  'financial-profile',
  'ai-chat'
] as const;

/**
 * Union of the canonical dashboard module-type keys, derived from
 * {@link DASHBOARD_MODULE_TYPES} so the compile-time type and the runtime
 * whitelist can never diverge.
 */
export type DashboardModuleType = (typeof DASHBOARD_MODULE_TYPES)[number];
