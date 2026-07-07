import { GfPortfolioPerformanceComponent } from '@ghostfolio/client/components/portfolio-performance/portfolio-performance.component';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { NUMERICAL_PRECISION_THRESHOLD_6_FIGURES } from '@ghostfolio/common/config';
import {
  AssetProfileIdentifier,
  PortfolioPerformance,
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
import { DeviceDetectorService } from 'ngx-device-detector';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfPortfolioPerformanceComponent],
  selector: 'gf-performance-module',
  standalone: true,
  styleUrls: ['./performance.component.scss'],
  templateUrl: './performance.component.html'
})
export class GfPerformanceModuleComponent implements OnInit {
  public deviceType: string;
  public errors: AssetProfileIdentifier[];
  public hasImpersonationId: boolean;
  public isAllTimeHigh: boolean;
  public isAllTimeLow: boolean;
  public isLoading = true;
  public performance: PortfolioPerformance;
  public precision = 2;
  public showDetails = false;
  public unit: string;
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private impersonationStorageService: ImpersonationStorageService,
    private layoutService: LayoutService,
    private userService: UserService
  ) {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.update();
        }
      });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;

    this.showDetails =
      !this.user.settings.isRestrictedView &&
      this.user.settings.viewMode !== 'ZEN';

    this.unit = this.showDetails ? this.user.settings.baseCurrency : '%';

    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((impersonationId) => {
        this.hasImpersonationId = !!impersonationId;

        this.changeDetectorRef.markForCheck();
      });

    this.layoutService.shouldReloadContent$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.update();
      });
  }

  private update() {
    this.isLoading = true;

    this.dataService
      .fetchPortfolioPerformance({
        range: this.user?.settings?.dateRange
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ errors, performance }) => {
        this.errors = errors;
        this.performance = performance;

        if (
          this.deviceType === 'mobile' &&
          this.performance.currentValueInBaseCurrency >=
            NUMERICAL_PRECISION_THRESHOLD_6_FIGURES
        ) {
          this.precision = 0;
        }

        this.isLoading = false;

        this.changeDetectorRef.markForCheck();
      });

    this.changeDetectorRef.markForCheck();
  }
}
