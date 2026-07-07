import { GfHomeMarketComponent } from '@ghostfolio/client/components/home-market/home-market.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeMarketComponent],
  selector: 'gf-market-overview-module',
  standalone: true,
  styleUrls: ['./market-overview.component.scss'],
  templateUrl: './market-overview.component.html'
})
export class GfMarketOverviewModuleComponent {}
