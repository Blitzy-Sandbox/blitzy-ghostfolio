import { getCssVariable } from '@ghostfolio/common/helper';
import { User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { ColorScheme } from '@ghostfolio/common/types';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  DOCUMENT,
  inject,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import { DataSource } from '@prisma/client';
import { addIcons } from 'ionicons';
import { openOutline } from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';

import { GfHoldingDetailDialogComponent } from './components/holding-detail-dialog/holding-detail-dialog.component';
import { GfAppQueryParams } from './interfaces/interfaces';
import { ImpersonationStorageService } from './services/impersonation-storage.service';
import { UserService } from './services/user/user.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  selector: 'gf-root',
  styleUrls: ['./app.component.scss'],
  templateUrl: './app.component.html'
})
export class GfAppComponent implements OnInit {
  public deviceType: string;
  public hasImpersonationId: boolean;
  public user: User | undefined;

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly deviceService = inject(DeviceDetectorService);
  private readonly dialog = inject(MatDialog);
  private readonly document = inject(DOCUMENT);
  private readonly impersonationStorageService = inject(
    ImpersonationStorageService
  );
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly userService = inject(UserService);

  public constructor() {
    this.initializeTheme();

    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        ({ dataSource, holdingDetailDialog, symbol }: GfAppQueryParams) => {
          if (dataSource && holdingDetailDialog && symbol) {
            this.openHoldingDetailDialog({ dataSource, symbol });
          }
        }
      );

    addIcons({ openOutline });
  }

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
        this.user = state.user;

        this.initializeTheme(this.user?.settings.colorScheme);

        this.changeDetectorRef.markForCheck();
      });
  }

  private initializeTheme(userPreferredColorScheme?: ColorScheme) {
    const isDarkTheme = userPreferredColorScheme
      ? userPreferredColorScheme === 'DARK'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;

    this.toggleTheme(isDarkTheme);

    window.matchMedia('(prefers-color-scheme: dark)').addListener((event) => {
      if (!this.user?.settings.colorScheme) {
        this.toggleTheme(event.matches);
      }
    });
  }

  private openHoldingDetailDialog({
    dataSource,
    symbol
  }: {
    dataSource: DataSource;
    symbol: string;
  }) {
    this.userService
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        this.user = user;

        const dialogRef = this.dialog.open(GfHoldingDetailDialogComponent, {
          autoFocus: false,
          data: {
            baseCurrency: this.user?.settings?.baseCurrency,
            colorScheme: this.user?.settings?.colorScheme,
            dataSource,
            deviceType: this.deviceType,
            hasImpersonationId: this.hasImpersonationId,
            hasPermissionToAccessAdminControl: hasPermission(
              this.user?.permissions,
              permissions.accessAdminControl
            ),
            hasPermissionToCreateActivity:
              !this.hasImpersonationId &&
              hasPermission(
                this.user?.permissions,
                permissions.createActivity
              ) &&
              !this.user?.settings?.isRestrictedView,
            hasPermissionToReportDataGlitch: hasPermission(
              this.user?.permissions,
              permissions.reportDataGlitch
            ),
            hasPermissionToUpdateActivity:
              !this.hasImpersonationId &&
              hasPermission(
                this.user?.permissions,
                permissions.updateActivity
              ) &&
              !this.user?.settings?.isRestrictedView,
            locale: this.user?.settings?.locale,
            symbol
          },
          height: this.deviceType === 'mobile' ? '98vh' : '80vh',
          width: this.deviceType === 'mobile' ? '100vw' : '50rem'
        });

        dialogRef
          .afterClosed()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => {
            void this.router.navigate([], {
              queryParams: {
                dataSource: null,
                holdingDetailDialog: null,
                symbol: null
              },
              queryParamsHandling: 'merge',
              relativeTo: this.route
            });
          });
      });
  }

  private toggleTheme(isDarkTheme: boolean) {
    const themeColor = getCssVariable(
      isDarkTheme ? '--dark-background' : '--light-background'
    );

    if (isDarkTheme) {
      this.document.body.classList.add('theme-dark');
      this.document.body.classList.remove('theme-light');
    } else {
      this.document.body.classList.add('theme-light');
      this.document.body.classList.remove('theme-dark');
    }

    this.document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', themeColor);
  }
}
