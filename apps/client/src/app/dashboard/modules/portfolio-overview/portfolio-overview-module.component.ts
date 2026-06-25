import { GfHomeOverviewComponent } from '@ghostfolio/client/components/home-overview/home-overview.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeOverviewComponent],
  selector: 'gf-portfolio-overview-module',
  standalone: true,
  template: '<gf-home-overview />'
})
export class GfPortfolioOverviewModuleComponent {}
