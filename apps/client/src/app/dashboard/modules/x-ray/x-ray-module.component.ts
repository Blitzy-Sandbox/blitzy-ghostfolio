import { GfXRayPageComponent } from '@ghostfolio/client/pages/portfolio/x-ray/x-ray-page.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfXRayPageComponent],
  selector: 'gf-x-ray-module',
  standalone: true,
  template: '<gf-x-ray-page />'
})
export class GfXRayModuleComponent {}
