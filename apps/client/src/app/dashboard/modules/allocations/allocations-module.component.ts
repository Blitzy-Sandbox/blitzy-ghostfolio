import { GfAllocationsPageComponent } from '@ghostfolio/client/pages/portfolio/allocations/allocations-page.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAllocationsPageComponent],
  selector: 'gf-allocations-module',
  standalone: true,
  template: '<gf-allocations-page />'
})
export class GfAllocationsModuleComponent {}
