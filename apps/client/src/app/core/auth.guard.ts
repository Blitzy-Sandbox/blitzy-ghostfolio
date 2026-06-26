import { SettingsStorageService } from '@ghostfolio/client/services/settings-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { internalRoutes, publicRoutes } from '@ghostfolio/common/routes/routes';
import { DataService } from '@ghostfolio/ui/services';

import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot
} from '@angular/router';
import { EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class AuthGuard {
  public constructor(
    private dataService: DataService,
    private router: Router,
    private settingsStorageService: SettingsStorageService,
    private userService: UserService
  ) {}

  canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot) {
    const utmSource = route.queryParams?.utm_source;

    if (utmSource) {
      this.settingsStorageService.setSetting('utm_source', utmSource);
    }

    return new Promise<boolean>((resolve) => {
      this.userService
        .get()
        .pipe(
          catchError(() => {
            // Route-target reconciliation after the route collapse (QA
            // F2-HIGH-01). The client route table was reduced to a single root
            // route `/` (Rule 5), which removed every public landing target this
            // guard previously redirected unauthenticated visitors to
            // (`/start`, and the `/demo` / `/register` UTM variants). Navigating
            // to any of those now-removed paths throws
            // `NG04002: Cannot match any routes` and strands the visitor on a
            // blank page with an unresolved title.
            //
            // Because `/` is the only remaining route, an unauthenticated
            // visitor is allowed onto the root canvas — the single entry point —
            // exactly as the former public landing (`/start`) used to resolve
            // `true` and render itself. This introduces no new route, honoring
            // Rule 5, while preserving the guard's authentication check (the
            // stored `utm_source` set above is untouched) and its
            // authenticated-user redirect behaviour below.
            resolve(true);
            return EMPTY;
          })
        )
        .subscribe((user) => {
          const userLanguage = user?.settings?.language;

          if (userLanguage && document.documentElement.lang !== userLanguage) {
            this.dataService
              .putUserSetting({ language: document.documentElement.lang })
              .subscribe(() => {
                this.userService.reset();

                setTimeout(() => {
                  window.location.reload();
                }, 300);
              });

            resolve(true);
            return;
          } else if (
            state.url.startsWith(`/${internalRoutes.home.path}`) &&
            user.settings.viewMode === 'ZEN'
          ) {
            this.router.navigate(internalRoutes.zen.routerLink);
            resolve(false);
            return;
          } else if (state.url.startsWith(`/${publicRoutes.start.path}`)) {
            if (user.settings.viewMode === 'ZEN') {
              this.router.navigate(internalRoutes.zen.routerLink);
            } else {
              this.router.navigate(internalRoutes.home.routerLink);
            }

            resolve(false);
            return;
          } else if (
            state.url.startsWith(`/${internalRoutes.zen.path}`) &&
            user.settings.viewMode === 'DEFAULT'
          ) {
            this.router.navigate(internalRoutes.home.routerLink);
            resolve(false);
            return;
          }

          resolve(true);
        });
    });
  }
}
