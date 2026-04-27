import { AuthGuard } from '@ghostfolio/client/core/auth.guard';
import { internalRoutes } from '@ghostfolio/common/routes/routes';

import { Routes } from '@angular/router';

import { RebalancingPageComponent } from './rebalancing-page.component';

/**
 * Lazy-loaded child routes mounted at
 * `internalRoutes.portfolio.subRoutes.rebalancing.path` (i.e., `'rebalancing'`)
 * inside the portfolio page's router-outlet, so that the rebalancing UI
 * renders within the existing portfolio tab layout (header tabs remain
 * visible).
 *
 * This file is intentionally minimal: per the established pattern (see
 * `fire/fire-page.routes.ts`, `x-ray/x-ray-page.routes.ts`, etc.), the route
 * tree exposes a single empty-path entry that maps directly to the standalone
 * `RebalancingPageComponent`. The `AuthGuard` redundantly enforces JWT
 * presence at the leaf even though the parent portfolio route already guards
 * the entire subtree — this matches the codebase's defense-in-depth
 * convention used by every sibling sub-route file.
 *
 * The localized title is sourced from the shared `internalRoutes` registry so
 * that a single source of truth governs both the route title and the tab
 * label rendered by `PortfolioPageComponent`.
 */
export const routes: Routes = [
  {
    canActivate: [AuthGuard],
    component: RebalancingPageComponent,
    path: '',
    title: internalRoutes.portfolio.subRoutes.rebalancing.title
  }
];
