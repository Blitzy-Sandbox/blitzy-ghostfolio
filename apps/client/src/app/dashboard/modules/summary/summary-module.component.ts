import { GfHomeSummaryComponent } from '@ghostfolio/client/components/home-summary/home-summary.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeSummaryComponent],
  selector: 'gf-summary-module',
  standalone: true,
  template: '<gf-home-summary />'
})
export class GfSummaryModuleComponent {}
