import '@angular/localize/init';

import { routes } from './app.routes';
import { AuthGuard } from './core/auth.guard';
import { GfDashboardCanvasComponent } from './dashboard/dashboard-canvas/dashboard-canvas.component';

/**
 * Route-table contract tests for the single-canvas dashboard
 * (F2 — CWE-306 Missing Authorization / Rule 5). These assert the STRUCTURE of
 * the exported `routes` array without bootstrapping the router, so no lazy
 * chunk is actually loaded.
 *
 * Onboarding paths are asserted as their source-locale literals ('start',
 * 'register', 'auth', 'webauthn'). Jest runs in the source locale (no
 * translations are loaded), so the `$localize`-tagged `publicRoutes.start.path`
 * / `publicRoutes.register.path` resolve to 'start' / 'register', while
 * `internalRoutes.auth.path` / `.webauthn.path` are plain string literals. The
 * paths are intentionally NOT imported from `@ghostfolio/common/routes/routes`:
 * the sort-imports Prettier plugin would hoist that `@ghostfolio` import above
 * the `@angular/localize/init` side-effect import, and the routes module reads
 * `$localize` at evaluation time — importing it first throws a
 * `ReferenceError`. Importing `./app.routes` (relative group) instead keeps the
 * `$localize` polyfill first.
 */
describe('app routes', () => {
  it('protects the single-canvas root route with the AuthGuard (CWE-306, Rule 5)', () => {
    const rootRoute = routes.find((route) => {
      return route.path === '';
    });

    expect(rootRoute).toBeDefined();
    expect(rootRoute?.component).toBe(GfDashboardCanvasComponent);
    // The guard MUST be present so an unauthenticated request cannot
    // instantiate the dashboard canvas; the guard redirects it to '/start'.
    expect(rootRoute?.canActivate).toContain(AuthGuard);
  });

  it('keeps the onboarding routes reachable WITHOUT a guard so /start resolves (no redirect loop)', () => {
    const onboardingPaths = ['start', 'register', 'auth', 'webauthn'];

    for (const path of onboardingPaths) {
      const route = routes.find((candidate) => {
        return candidate.path === path;
      });

      expect(route).toBeDefined();
      // Ungated: the AuthGuard redirects unauthenticated users to '/start', so
      // guarding these would produce an infinite '' -> /start -> '' loop.
      expect(route?.canActivate).toBeUndefined();
      // Lazily loaded exactly as in the pre-refactor route table.
      const loader = route?.loadChildren ?? route?.loadComponent;
      expect(typeof loader).toBe('function');
    }
  });

  it('redirects every unknown deep-link to the canvas via a trailing wildcard (Rule 5)', () => {
    const wildcardRoute = routes.find((route) => {
      return route.path === '**';
    });

    expect(wildcardRoute).toBeDefined();
    expect(wildcardRoute?.redirectTo).toBe('');
    // The wildcard itself is ungated; authentication is enforced by the guard
    // on the '' target it redirects to.
    expect(wildcardRoute?.canActivate).toBeUndefined();
    // Declared LAST so the onboarding routes above are matched first.
    expect(routes[routes.length - 1]).toBe(wildcardRoute);
  });
});
