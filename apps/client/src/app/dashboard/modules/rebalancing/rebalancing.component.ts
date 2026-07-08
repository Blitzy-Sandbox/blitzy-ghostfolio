import { RebalancingPageComponent } from '@ghostfolio/client/pages/portfolio/rebalancing/rebalancing-page.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RebalancingPageComponent],
  selector: 'gf-rebalancing-module',
  standalone: true,
  styleUrls: ['./rebalancing.component.scss'],
  templateUrl: './rebalancing.component.html'
})
export class GfRebalancingModuleComponent {}
