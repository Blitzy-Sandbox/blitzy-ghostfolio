import { internalRoutes, publicRoutes } from '@ghostfolio/common/routes/routes';

import { Routes } from '@angular/router';

import { AuthGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    // The root dashboard canvas replaces the previously guarded `home` and
    // `portfolio` authenticated feature surfaces and immediately calls the
    // protected per-user layout API (`GET /api/v1/user/layout`). It must
    // therefore be guarded by `AuthGuard` so unauthenticated users follow the
    // established auth redirect flow (→ `/start`) instead of instantiating the
    // canvas and hitting an unhandled 401 (CWE-862). All public/auth/bootstrap
    // routes and the wildcard redirect below remain unchanged.
    canActivate: [AuthGuard],
    loadComponent: () =>
      import('./dashboard/dashboard-canvas/dashboard-canvas.component').then(
        (m) => m.GfDashboardCanvasComponent
      ),
    path: ''
  },
  {
    path: publicRoutes.about.path,
    loadChildren: () =>
      import('./pages/about/about-page.routes').then((m) => m.routes)
  },
  {
    path: internalRoutes.account.path,
    loadChildren: () =>
      import('./pages/user-account/user-account-page.routes').then(
        (m) => m.routes
      )
  },
  {
    path: internalRoutes.accounts.path,
    loadChildren: () =>
      import('./pages/accounts/accounts-page.routes').then((m) => m.routes)
  },
  {
    path: internalRoutes.adminControl.path,
    loadChildren: () =>
      import('./pages/admin/admin-page.routes').then((m) => m.routes)
  },
  {
    canActivate: [AuthGuard],
    loadComponent: () =>
      import('./pages/api/api-page.component').then(
        (c) => c.GfApiPageComponent
      ),
    path: internalRoutes.api.path,
    title: internalRoutes.api.title
  },
  {
    path: internalRoutes.auth.path,
    loadChildren: () =>
      import('./pages/auth/auth-page.routes').then((m) => m.routes),
    title: internalRoutes.auth.title
  },
  {
    path: publicRoutes.blog.path,
    loadChildren: () =>
      import('./pages/blog/blog-page.routes').then((m) => m.routes)
  },
  {
    canActivate: [AuthGuard],
    loadComponent: () =>
      import('./pages/demo/demo-page.component').then(
        (c) => c.GfDemoPageComponent
      ),
    path: publicRoutes.demo.path
  },
  {
    path: publicRoutes.faq.path,
    loadChildren: () =>
      import('./pages/faq/faq-page.routes').then((m) => m.routes)
  },
  {
    canActivate: [AuthGuard],
    loadComponent: () =>
      import('./pages/features/features-page.component').then(
        (c) => c.GfFeaturesPageComponent
      ),
    path: publicRoutes.features.path,
    title: publicRoutes.features.title
  },
  {
    canActivate: [AuthGuard],
    loadComponent: () =>
      import('./pages/i18n/i18n-page.component').then(
        (c) => c.GfI18nPageComponent
      ),
    path: internalRoutes.i18n.path,
    title: internalRoutes.i18n.title
  },
  {
    path: publicRoutes.markets.path,
    loadChildren: () =>
      import('./pages/markets/markets-page.routes').then((m) => m.routes)
  },
  {
    path: publicRoutes.openStartup.path,
    loadChildren: () =>
      import('./pages/open/open-page.routes').then((m) => m.routes)
  },
  {
    path: publicRoutes.pricing.path,
    loadChildren: () =>
      import('./pages/pricing/pricing-page.routes').then((m) => m.routes)
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
    path: publicRoutes.start.path,
    loadChildren: () =>
      import('./pages/landing/landing-page.routes').then((m) => m.routes)
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
    redirectTo: '',
    pathMatch: 'full'
  }
];
