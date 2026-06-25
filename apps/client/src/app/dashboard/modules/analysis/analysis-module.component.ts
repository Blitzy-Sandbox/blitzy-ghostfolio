import { GfAnalysisPageComponent } from '@ghostfolio/client/pages/portfolio/analysis/analysis-page.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAnalysisPageComponent],
  selector: 'gf-analysis-module',
  standalone: true,
  template: '<gf-analysis-page />'
})
export class GfAnalysisModuleComponent {}
