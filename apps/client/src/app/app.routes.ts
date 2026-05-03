import { Routes } from '@angular/router';

import { AuthGuard } from './core/auth.guard';
import { GfDashboardCanvasComponent } from './dashboard/dashboard-canvas/dashboard-canvas.component';

export const routes: Routes = [
  {
    path: '',
    component: GfDashboardCanvasComponent,
    canActivate: [AuthGuard],
    title: 'Dashboard'
  },
  {
    // wildcard, if requested url doesn't match any paths for routes defined
    // earlier
    path: '**',
    redirectTo: '',
    pathMatch: 'full'
  }
];
