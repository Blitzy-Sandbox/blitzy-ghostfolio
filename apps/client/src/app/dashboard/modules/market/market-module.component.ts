import { GfHomeMarketComponent } from '@ghostfolio/client/components/home-market/home-market.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeMarketComponent],
  selector: 'gf-market-module',
  standalone: true,
  template: '<gf-home-market />'
})
export class GfMarketModuleComponent {}
