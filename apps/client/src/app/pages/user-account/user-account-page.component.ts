import { GfFinancialProfileFormComponent } from '@ghostfolio/client/components/financial-profile-form/financial-profile-form.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { TabConfiguration, User } from '@ghostfolio/common/interfaces';
import { internalRoutes } from '@ghostfolio/common/routes/routes';

import {
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  diamondOutline,
  keyOutline,
  settingsOutline,
  walletOutline
} from 'ionicons/icons';
import { DeviceDetectorService } from 'ngx-device-detector';

@Component({
  host: { class: 'page has-tabs' },
  imports: [IonIcon, MatButtonModule, MatTabsModule, RouterModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-user-account-page',
  styleUrls: ['./user-account-page.scss'],
  templateUrl: './user-account-page.html'
})
export class GfUserAccountPageComponent implements OnInit {
  public deviceType: string;
  public tabs: TabConfiguration[] = [];
  public user: User;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private destroyRef: DestroyRef,
    private deviceService: DeviceDetectorService,
    private matDialog: MatDialog,
    private userService: UserService
  ) {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.tabs = [
            {
              iconName: 'settings-outline',
              label: internalRoutes.account.title,
              routerLink: internalRoutes.account.routerLink
            },
            {
              iconName: 'diamond-outline',
              label: internalRoutes.account.subRoutes.membership.title,
              routerLink:
                internalRoutes.account.subRoutes.membership.routerLink,
              showCondition: !!this.user?.subscription
            },
            {
              iconName: 'key-outline',
              label: internalRoutes.account.subRoutes.access.title,
              routerLink: internalRoutes.account.subRoutes.access.routerLink
            }
          ];

          this.changeDetectorRef.markForCheck();
        }
      });

    addIcons({ diamondOutline, keyOutline, settingsOutline, walletOutline });
  }

  public ngOnInit() {
    this.deviceType = this.deviceService.getDeviceInfo().deviceType;
  }

  public openFinancialProfileDialog(): void {
    this.matDialog.open(GfFinancialProfileFormComponent, {
      autoFocus: true,
      width: '600px'
    });
  }
}
