import { Routes } from '@angular/router';

import { AuthGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    canActivate: [AuthGuard],
    loadComponent: () =>
      import('./dashboard/dashboard-canvas/dashboard-canvas.component').then(
        (c) => c.GfDashboardCanvasComponent
      ),
    path: ''
  }
];
