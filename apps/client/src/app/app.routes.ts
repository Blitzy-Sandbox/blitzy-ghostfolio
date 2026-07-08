import { internalRoutes, publicRoutes } from '@ghostfolio/common/routes/routes';

import { Routes } from '@angular/router';

import { AuthGuard } from './core/auth.guard';
import { GfDashboardCanvasComponent } from './dashboard/dashboard-canvas/dashboard-canvas.component';

export const routes: Routes = [
  {
    // Single-canvas dashboard root (Rule 5 — the application reduces to one
    // root route). Protected by the existing Ghostfolio `AuthGuard` to close
    // CWE-306 (Missing Authorization): an unauthenticated request to `''` is
    // NOT allowed to instantiate the dashboard canvas — the guard redirects it
    // to the public `/start` onboarding route instead. Authenticated users
    // render the canvas here. The guard is reused unchanged (AAP § 0.2.2 keeps
    // the client auth stack intact).
    canActivate: [AuthGuard],
    component: GfDashboardCanvasComponent,
    path: ''
  },
  // Public / unauthenticated onboarding routes. These MUST remain reachable
  // WITHOUT the `AuthGuard` so the guard's redirect target (`/start`) resolves
  // to a real, ungated page. Removing them would create an infinite redirect
  // loop: an unauthenticated hit on `''` redirects to `/start`, the wildcard
  // below would send `/start` back to `''`, and the guard would redirect to
  // `/start` again. Keeping `start`/`register`/`auth`/`webauthn` as dedicated
  // ungated routes (matched before the wildcard) breaks that loop and
  // preserves the full login / registration flow.
  {
    path: publicRoutes.start.path,
    loadChildren: () =>
      import('./pages/landing/landing-page.routes').then((m) => m.routes)
  },
  {
    path: publicRoutes.register.path,
    loadChildren: () =>
      import('./pages/register/register-page.routes').then((m) => m.routes)
  },
  {
    path: internalRoutes.auth.path,
    loadChildren: () =>
      import('./pages/auth/auth-page.routes').then((m) => m.routes),
    title: internalRoutes.auth.title
  },
  {
    loadComponent: () =>
      import('./pages/webauthn/webauthn-page.component').then(
        (c) => c.GfWebauthnPageComponent
      ),
    path: internalRoutes.webauthn.path,
    title: internalRoutes.webauthn.title
  },
  {
    // Wildcard: every former feature deep-link (e.g. `/home`, `/portfolio`,
    // `/accounts`) collapses onto the single dashboard canvas at `''` (Rule 5).
    // The `AuthGuard` on `''` then enforces authentication. Declared LAST so it
    // only matches URLs not claimed by the onboarding routes above.
    path: '**',
    redirectTo: ''
  }
];
