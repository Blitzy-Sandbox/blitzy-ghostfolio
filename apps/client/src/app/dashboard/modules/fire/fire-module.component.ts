import { GfFirePageComponent } from '@ghostfolio/client/pages/portfolio/fire/fire-page.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfFirePageComponent],
  selector: 'gf-fire-module',
  standalone: true,
  template: '<gf-fire-page />'
})
export class GfFireModuleComponent {}
