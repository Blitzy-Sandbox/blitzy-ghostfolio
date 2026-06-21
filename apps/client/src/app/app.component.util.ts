import { internalRoutes } from '@ghostfolio/common/routes/routes';
import type { ViewMode } from '@ghostfolio/common/types';

/**
 * Route-permission predicates for the application shell header controls.
 *
 * These pure functions encapsulate the rules that decide whether the global
 * header exposes its date-range selector and its assets/account filters for a
 * given route. They are extracted from `GfAppComponent` so the logic can be
 * unit-tested in isolation (the component itself pulls in heavy standalone
 * children — `GfHeaderComponent` and friends — whose transitive ESM imports
 * make a focused predicate test through a full `TestBed` impractical).
 *
 * Navigation-collapse context (decision D-010): the authenticated home and
 * portfolio screen trees were folded into the single dashboard canvas served
 * at the root route. The router therefore resolves the dashboard surface to an
 * empty first URL segment (`GfAppComponent` computes
 * `currentRoute = urlSegments[0]?.path ?? ''`). Because the dashboard replaces
 * the former home/portfolio overview screens, it inherits the same header
 * controls those screens exposed. The historical `home`/`portfolio`/`zen`
 * predicates are retained verbatim so the helpers stay correct for every route
 * that survived the collapse.
 */

/** Identifies the dashboard canvas served at the application root route. */
function isDashboardRoot(currentRoute: string): boolean {
  return currentRoute === '';
}

/**
 * Determines whether the header's global date-range selector should be enabled
 * for the supplied route.
 *
 * Enabled for the dashboard root and the surviving overview-style routes
 * (`home`, `home/holdings`, `portfolio`), and—mirroring the pre-collapse
 * behaviour—suppressed entirely while the user's view mode is `ZEN`.
 */
export function hasPermissionToChangeDateRangeForRoute({
  currentRoute,
  currentSubRoute,
  viewMode
}: {
  currentRoute: string;
  currentSubRoute?: string;
  viewMode?: ViewMode;
}): boolean {
  return (
    (isDashboardRoot(currentRoute) ||
      (currentRoute === internalRoutes.home.path && !currentSubRoute) ||
      (currentRoute === internalRoutes.home.path &&
        currentSubRoute === internalRoutes.home.subRoutes?.holdings.path) ||
      (currentRoute === internalRoutes.portfolio.path && !currentSubRoute)) &&
    viewMode !== 'ZEN'
  );
}

/**
 * Determines whether the header's assets/account filters should be enabled for
 * the supplied route.
 *
 * Enabled for the dashboard root and the surviving routes that previously
 * carried filterable content (`home/holdings`, `portfolio`,
 * `portfolio/activities`, `portfolio/allocations`, `zen/holdings`).
 */
export function hasPermissionToChangeFiltersForRoute({
  currentRoute,
  currentSubRoute
}: {
  currentRoute: string;
  currentSubRoute?: string;
}): boolean {
  return (
    isDashboardRoot(currentRoute) ||
    (currentRoute === internalRoutes.home.path &&
      currentSubRoute === internalRoutes.home.subRoutes?.holdings.path) ||
    (currentRoute === internalRoutes.portfolio.path && !currentSubRoute) ||
    (currentRoute === internalRoutes.portfolio.path &&
      currentSubRoute ===
        internalRoutes.portfolio.subRoutes?.activities.path) ||
    (currentRoute === internalRoutes.portfolio.path &&
      currentSubRoute ===
        internalRoutes.portfolio.subRoutes?.allocations.path) ||
    (currentRoute === internalRoutes.zen.path &&
      currentSubRoute === internalRoutes.home.subRoutes?.holdings.path)
  );
}
