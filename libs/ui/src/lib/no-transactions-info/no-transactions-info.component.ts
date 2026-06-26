import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  HostBinding,
  Input
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterModule } from '@angular/router';

import { GfLogoComponent } from '../logo';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfLogoComponent, MatButtonModule, RouterModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-no-transactions-info-indicator',
  styleUrls: ['./no-transactions-info.component.scss'],
  templateUrl: './no-transactions-info.component.html'
})
export class GfNoTransactionsInfoComponent {
  // Route-target reconciliation after the route collapse (QA F2-MEDIUM-01).
  // This preserved empty-state CTA previously bound an absolute
  // `internalRoutes.portfolio.subRoutes.activities.routerLink`
  // (`['/portfolio', 'activities']`) that no longer matches any route after the
  // route table was collapsed to a single `/` route (Rule 5), throwing
  // `NG04002: Cannot match any routes` and silently failing the user action.
  // The CTA now navigates relatively (`[routerLink]="[]"`) with the
  // `createDialog` query param, opening the Add-activity dialog on the current
  // route — the same relative-navigation pattern the activities page uses
  // internally — so it works wherever the activities module is composed.
  @HostBinding('class.has-border') @Input() hasBorder = true;
}
