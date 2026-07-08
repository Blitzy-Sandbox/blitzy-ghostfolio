import { GfInvestmentChartComponent } from '@ghostfolio/client/components/investment-chart/investment-chart.component';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  HistoricalDataItem,
  InvestmentItem,
  User
} from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { isNumber } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfInvestmentChartComponent],
  selector: 'gf-investment-chart-module',
  standalone: true,
  styleUrls: ['./investment-chart.component.scss'],
  templateUrl: './investment-chart.component.html'
})
export class GfInvestmentChartModuleComponent implements OnInit {
  public deviceType: string;
  public hasImpersonationId: boolean;
  public investments: InvestmentItem[] = [];
  public isLoadingInvestmentChart: boolean;
  public performanceDataItems: HistoricalDataItem[] = [];
  public portfolioEvolutionDataLabel = $localize`Investment`;
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private impersonationStorageService: ImpersonationStorageService,
    private userService: UserService
  ) {}

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;
      });

    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.update();
        }
      });
  }

  private update() {
    this.isLoadingInvestmentChart = true;

    this.dataService
      .fetchPortfolioPerformance({
        filters: this.userService.getFilters(),
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ chart }) => {
        this.investments = [];
        this.performanceDataItems = [];

        for (const [
          index,
          {
            date,
            totalInvestmentValueWithCurrencyEffect,
            valueInPercentage,
            valueWithCurrencyEffect
          }
        ] of (chart ?? []).entries()) {
          if (index > 0 || this.user?.settings?.dateRange === 'max') {
            // Ignore first item where value is 0
            this.investments.push({
              date,
              investment: totalInvestmentValueWithCurrencyEffect
            });
            this.performanceDataItems.push({
              date,
              value: isNumber(valueWithCurrencyEffect)
                ? valueWithCurrencyEffect
                : valueInPercentage
            });
          }
        }

        this.isLoadingInvestmentChart = false;

        this.changeDetectorRef.markForCheck();
      });
  }
}
