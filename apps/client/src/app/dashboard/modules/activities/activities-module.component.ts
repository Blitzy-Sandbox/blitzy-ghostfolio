import { GfActivitiesPageComponent } from '@ghostfolio/client/pages/portfolio/activities/activities-page.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfActivitiesPageComponent],
  selector: 'gf-activities-module',
  standalone: true,
  template: '<gf-activities-page />'
})
export class GfActivitiesModuleComponent {}
