import { Routes } from '@angular/router';

import { GfDashboardCanvasComponent } from './dashboard/dashboard-canvas/dashboard-canvas.component';

export const routes: Routes = [
  {
    component: GfDashboardCanvasComponent,
    path: ''
  },
  {
    path: '**',
    redirectTo: ''
  }
];
