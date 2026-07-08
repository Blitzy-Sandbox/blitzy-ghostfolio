import { GfBenchmarkComparatorComponent } from '@ghostfolio/client/components/benchmark-comparator/benchmark-comparator.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { LineChartItem, User } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SymbolProfile } from '@prisma/client';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfBenchmarkComparatorComponent],
  selector: 'gf-benchmark-module',
  standalone: true,
  styleUrls: ['./benchmark.component.scss'],
  templateUrl: './benchmark.component.html'
})
export class GfBenchmarkModuleComponent implements OnInit {
  public benchmark: Partial<SymbolProfile>;
  public benchmarkDataItems: LineChartItem[] = [];
  public benchmarks: Partial<SymbolProfile>[];
  public isLoading: boolean;
  public performanceDataItemsInPercentage: LineChartItem[] = [];
  public user: User;

  private firstOrderDate: Date;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private userService: UserService
  ) {
    const { benchmarks } = this.dataService.fetchInfo();
    this.benchmarks = benchmarks;
  }

  public ngOnInit() {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.benchmark = this.benchmarks.find(({ id }) => {
            return id === this.user.settings?.benchmark;
          });

          this.update();
        }
      });
  }

  public onChangeBenchmark(symbolProfileId: string) {
    this.dataService
      .putUserSetting({ benchmark: symbolProfileId })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((user) => {
            this.user = user;

            this.changeDetectorRef.markForCheck();
          });
      });
  }

  private update() {
    this.isLoading = true;

    this.dataService
      .fetchPortfolioPerformance({
        filters: this.userService.getFilters(),
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ chart, firstOrderDate }) => {
        this.firstOrderDate = firstOrderDate ?? new Date();
        this.performanceDataItemsInPercentage = [];

        for (const {
          date,
          netPerformanceInPercentageWithCurrencyEffect
        } of chart) {
          this.performanceDataItemsInPercentage.push({
            date,
            value: netPerformanceInPercentageWithCurrencyEffect
          });
        }

        this.updateBenchmarkDataItems();

        this.changeDetectorRef.markForCheck();
      });
  }

  private updateBenchmarkDataItems() {
    this.benchmarkDataItems = [];

    if (this.user.settings.benchmark) {
      const { dataSource, symbol } =
        this.benchmarks.find(({ id }) => {
          return id === this.user.settings.benchmark;
        }) ?? {};

      if (dataSource && symbol) {
        this.dataService
          .fetchBenchmarkForUser({
            dataSource,
            symbol,
            filters: this.userService.getFilters(),
            range: this.user?.settings?.dateRange,
            startDate: this.firstOrderDate
          })
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(({ marketData }) => {
            this.benchmarkDataItems = marketData.map(({ date, value }) => {
              return {
                date,
                value
              };
            });

            this.isLoading = false;

            this.changeDetectorRef.markForCheck();
          });
      } else {
        this.isLoading = false;
      }
    } else {
      this.isLoading = false;
    }
  }
}
