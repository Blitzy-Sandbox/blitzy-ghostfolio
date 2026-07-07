import { GfHomeOverviewComponent } from '@ghostfolio/client/components/home-overview/home-overview.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeOverviewComponent],
  selector: 'gf-portfolio-overview-module',
  standalone: true,
  styleUrls: ['./portfolio-overview.component.scss'],
  templateUrl: './portfolio-overview.component.html'
})
export class GfPortfolioOverviewModuleComponent {}
