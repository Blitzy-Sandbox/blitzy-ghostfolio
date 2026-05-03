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
            if (utmSource === 'ios') {
              this.router.navigate(publicRoutes.demo.routerLink);
              resolve(false);
            } else if (utmSource === 'trusted-web-activity') {
              this.router.navigate(publicRoutes.register.routerLink);
              resolve(false);
            } else if (
              Object.values(publicRoutes)
                .map(({ path }) => {
                  return `/${path}`;
                })
                .some((publicPageRoute) => {
                  const [, url] = decodeURIComponent(state.url).split('/');
                  return `/${url}` === publicPageRoute;
                })
            ) {
              resolve(true);
              return EMPTY;
            }

            // The dashboard refactor (AAP § 0.6.1.5) collapsed the
            // application route table to a single root route plus a `**`
            // wildcard redirect. As a side effect, the legacy `/start`
            // landing page no longer exists as a routable path: the
            // wildcard re-resolves any `/start` navigation back to `/`,
            // which re-runs this guard. Redirecting to
            // `publicRoutes.start.routerLink` here would therefore create
            // an infinite redirect cascade and leave the user on a blank,
            // unrecoverable page (QA Checkpoint 3 Issue #1).
            //
            // Instead, allow the route to activate and let the
            // `GfDashboardCanvasComponent` handle the unauthenticated
            // state internally. The canvas's `ngOnInit` translates the
            // 401 response from `GET /api/v1/user/layout` into a
            // "Could not load your dashboard layout" snack-bar (see
            // `dashboard-canvas.component.ts` `ngOnInit`/`catchError`),
            // and the global `HttpResponseInterceptor` calls
            // `userService.signOut()` on any 401, clearing stale
            // credentials. The guard's success-path branches at lines
            // ~80–103 (which redirect for ZEN-mode users and for users
            // already on `/start`) remain intact and continue to govern
            // authenticated traffic.
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
