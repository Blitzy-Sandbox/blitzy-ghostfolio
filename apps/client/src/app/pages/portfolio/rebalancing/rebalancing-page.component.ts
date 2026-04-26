import { RebalancingService } from '@ghostfolio/client/services/rebalancing.service';
import {
  RebalancingRecommendation,
  RebalancingResponse
} from '@ghostfolio/common/interfaces';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatCardModule, MatProgressBarModule],
  selector: 'gf-rebalancing-page',
  standalone: true,
  styleUrls: ['./rebalancing-page.component.scss'],
  templateUrl: './rebalancing-page.component.html'
})
export class RebalancingPageComponent implements OnInit {
  public errorMessage = signal<string | null>(null);
  public isLoading = signal<boolean>(true);
  public response = signal<RebalancingResponse | null>(null);

  public constructor(
    private destroyRef: DestroyRef,
    private rebalancingService: RebalancingService
  ) {}

  public ngOnInit() {
    this.fetchRecommendations();
  }

  public onReload() {
    this.fetchRecommendations();
  }

  public trackByRecommendation(
    _index: number,
    item: RebalancingRecommendation
  ) {
    return `${item.action}-${item.ticker}`;
  }

  public trackByWarning(_index: number, item: string) {
    return item;
  }

  private fetchRecommendations() {
    this.errorMessage.set(null);
    this.isLoading.set(true);
    this.response.set(null);

    this.rebalancingService
      .getRecommendations()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error) => {
          this.errorMessage.set(
            error?.message ??
              $localize`Unable to load rebalancing recommendations.`
          );
          this.isLoading.set(false);
        },
        next: (response) => {
          this.response.set(response);
          this.isLoading.set(false);
        }
      });
  }
}
