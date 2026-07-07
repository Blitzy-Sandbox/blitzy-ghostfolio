import { GfHomeWatchlistComponent } from '@ghostfolio/client/components/home-watchlist/home-watchlist.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeWatchlistComponent],
  selector: 'gf-watchlist-module',
  standalone: true,
  styleUrls: ['./watchlist.component.scss'],
  templateUrl: './watchlist.component.html'
})
export class GfWatchlistModuleComponent {}
