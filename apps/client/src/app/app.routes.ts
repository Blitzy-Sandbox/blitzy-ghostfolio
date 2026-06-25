import { internalRoutes, publicRoutes } from '@ghostfolio/common/routes/routes';

import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: internalRoutes.account.path,
    loadChildren: () =>
      import('./pages/user-account/user-account-page.routes').then(
        (m) => m.routes
      )
  },
  {
    path: internalRoutes.portfolio.path,
    loadChildren: () =>
      import('./pages/portfolio/portfolio-page.routes').then((m) => m.routes)
  },
  {
    path: publicRoutes.public.path,
    loadChildren: () =>
      import('./pages/public/public-page.routes').then((m) => m.routes)
  },
  {
    path: publicRoutes.register.path,
    loadChildren: () =>
      import('./pages/register/register-page.routes').then((m) => m.routes)
  },
  {
    path: publicRoutes.resources.path,
    loadChildren: () =>
      import('./pages/resources/resources-page.routes').then((m) => m.routes)
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
    path: internalRoutes.zen.path,
    loadChildren: () =>
      import('./pages/zen/zen-page.routes').then((m) => m.routes)
  },
  {
    // wildcard, if requested url doesn't match any paths for routes defined
    // earlier
    path: '**',
    redirectTo: 'portfolio',
    pathMatch: 'full'
  }
];
