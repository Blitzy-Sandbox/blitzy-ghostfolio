import { GfHomeHoldingsComponent } from '@ghostfolio/client/components/home-holdings/home-holdings.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeHoldingsComponent],
  selector: 'gf-holdings-module',
  standalone: true,
  styleUrls: ['./holdings.component.scss'],
  templateUrl: './holdings.component.html'
})
export class GfHoldingsModuleComponent {}
