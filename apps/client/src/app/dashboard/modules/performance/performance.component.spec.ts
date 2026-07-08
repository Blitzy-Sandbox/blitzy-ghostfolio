import { DataService } from '@ghostfolio/ui/services';

// Initializes the global `$localize` function used by Angular i18n at runtime.
// This side-effect import MUST run before any module graph that evaluates
// `$localize` at module scope. The relative imports below (the SUT and the
// injected client services) transitively pull such graphs — the wrapped
// `GfPortfolioPerformanceComponent` uses i18n helpers, and `UserService` pulls
// `libs/common/.../routes.ts` which declares `$localize`-tagged titles at
// module scope. Those services are therefore imported via their relative paths
// (the `^[./]` group, emitted AFTER this init) rather than the
// `@ghostfolio/client/*` alias (the first group, before this init) — otherwise
// merely importing them throws `ReferenceError: $localize is not defined`
// before any test runs. Mirrors the verified pattern in
// `fear-and-greed.component.spec.ts` / `chat-panel.component.spec.ts`.
import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import '@angular/localize/init';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, of, Subject } from 'rxjs';

import { LayoutService } from '../../../core/layout.service';
import { ImpersonationStorageService } from '../../../services/impersonation-storage.service';
import { UserService } from '../../../services/user/user.service';
import { GfPerformanceModuleComponent } from './performance.component';

// Dependency-free stand-in for the wrapped feature component. The real
// `GfPortfolioPerformanceComponent` pulls in heavy i18n/chart helpers that are
// out of scope for this wrapper unit test; the stub keeps the same
// `gf-portfolio-performance` selector and the full set of `@Input()`s that the
// wrapper template (`performance.component.html`) binds against, so the
// template compiles. Injected via `overrideComponent` (mirrors the sibling
// dashboard wrapper specs).
@Component({
  selector: 'gf-portfolio-performance',
  standalone: true,
  template: ''
})
class StubPortfolioPerformanceComponent {
  @Input() public deviceType: string;
  @Input() public errors: any;
  @Input() public isAllTimeHigh: boolean;
  @Input() public isAllTimeLow: boolean;
  @Input() public isLoading: boolean;
  @Input() public locale: string;
  @Input() public performance: any;
  @Input() public precision: number;
  @Input() public showDetails: boolean;
  @Input() public unit: string;
}

// Regression coverage for QA-FINAL-1: a cold-load hydration race where the
// canvas mounts this wrapper via `NgComponentOutlet` BEFORE `GET /api/v1/user`
// populates the user store. `ngOnInit` used to dereference `this.user.settings`
// while `this.user` was still undefined, throwing an uncaught
// `TypeError: Cannot read properties of undefined (reading 'settings')`. The
// fix relocates the `showDetails`/`unit` derivation into the `stateChanged`
// callback (where `this.user` is guaranteed populated), so the module mounts
// cleanly on cold load and recovers once the delayed user fetch resolves.
describe('GfPerformanceModuleComponent (cold-load hydration race — QA-FINAL-1)', () => {
  let component: GfPerformanceModuleComponent;
  let fixture: ComponentFixture<GfPerformanceModuleComponent>;
  // Test doubles are typed `any` (standard for spec test doubles) so partial
  // shapes and jest-mock helpers (mockReturnValue) are ergonomic.
  let dataServiceMock: any;
  let deviceServiceMock: any;
  let impersonationStorageServiceMock: any;
  let layoutServiceMock: any;
  let stateChanged: BehaviorSubject<any>;
  let userServiceMock: any;

  const mockUser = {
    permissions: [],
    settings: {
      baseCurrency: 'USD',
      dateRange: '1y',
      isRestrictedView: false,
      viewMode: 'DEFAULT'
    }
  };

  function createComponent() {
    fixture = TestBed.createComponent(GfPerformanceModuleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges(); // triggers ngOnInit
  }

  beforeEach(async () => {
    dataServiceMock = {
      fetchPortfolioPerformance: jest
        .fn()
        .mockReturnValue(
          of({ errors: [], performance: { currentValueInBaseCurrency: 1000 } })
        )
    };
    deviceServiceMock = {
      getDeviceInfo: jest.fn().mockReturnValue({ deviceType: 'desktop' })
    };
    impersonationStorageServiceMock = {
      onChangeHasImpersonation: jest.fn().mockReturnValue(of(null))
    };
    // Faithful to the real `LayoutService`, whose `shouldReloadContent$` is a
    // plain `Subject` (exposed via `shouldReloadSubject.asObservable()`) that
    // stays silent until an explicit content-reload event fires. A `Subject`
    // (not `of(undefined)`, which emits on subscribe) keeps the `ngOnInit`
    // `shouldReloadContent$` subscription from triggering a spurious
    // `update()` / `fetchPortfolioPerformance`, so these assertions isolate the
    // user-driven fetch path exercised by the QA-FINAL-1 cold-load race.
    layoutServiceMock = { shouldReloadContent$: new Subject<void>() };
    // A `BehaviorSubject(null)` reproduces `@codewithdan/observable-store`'s
    // `stateChanged`, which replays its current value on subscribe. Starting at
    // `null` models the cold-load path where the user store is not yet
    // populated when the wrapper is constructed.
    stateChanged = new BehaviorSubject<any>(null);
    userServiceMock = { stateChanged };

    await TestBed.configureTestingModule({
      imports: [GfPerformanceModuleComponent],
      providers: [
        { provide: DataService, useValue: dataServiceMock },
        { provide: DeviceDetectorService, useValue: deviceServiceMock },
        {
          provide: ImpersonationStorageService,
          useValue: impersonationStorageServiceMock
        },
        { provide: LayoutService, useValue: layoutServiceMock },
        { provide: UserService, useValue: userServiceMock }
      ]
    })
      .overrideComponent(GfPerformanceModuleComponent, {
        set: { imports: [StubPortfolioPerformanceComponent] }
      })
      .compileComponents();
  });

  it('does NOT throw when the user store is empty on cold-load hydration (ngOnInit runs before the user arrives)', () => {
    // `stateChanged` replays `null` (cold load) → `this.user` stays undefined
    // through `ngOnInit`. Before the fix this threw a TypeError.
    expect(() => createComponent()).not.toThrow();

    expect(component.user).toBeUndefined();
    // Display flags remain at their safe initial values until the user arrives.
    expect(component.showDetails).toBe(false);
    expect(component.unit).toBeUndefined();
    // The wrapper must not attempt a data fetch without a user.
    expect(dataServiceMock.fetchPortfolioPerformance).not.toHaveBeenCalled();
  });

  it('computes showDetails/unit and fetches performance once the user arrives AFTER init (cold-load recovery)', () => {
    createComponent(); // cold: no user yet
    expect(component.showDetails).toBe(false);

    stateChanged.next({ user: mockUser }); // delayed GET /api/v1/user resolves
    fixture.detectChanges();

    expect(component.user).toBe(mockUser);
    expect(component.showDetails).toBe(true);
    expect(component.unit).toBe('USD');
    expect(dataServiceMock.fetchPortfolioPerformance).toHaveBeenCalledTimes(1);
  });

  it('computes showDetails/unit synchronously on the warm path (user already in the store at construction)', () => {
    // Seed the store BEFORE construction so the constructor subscription
    // replays the user synchronously — the pre-refactor route-mounted path.
    stateChanged.next({ user: mockUser });

    expect(() => createComponent()).not.toThrow();

    expect(component.user).toBe(mockUser);
    expect(component.showDetails).toBe(true);
    expect(component.unit).toBe('USD');
    expect(dataServiceMock.fetchPortfolioPerformance).toHaveBeenCalled();
  });

  it('sets unit to "%" when showDetails is false (restricted view)', () => {
    stateChanged.next({
      user: {
        permissions: [],
        settings: {
          baseCurrency: 'USD',
          dateRange: '1y',
          isRestrictedView: true,
          viewMode: 'DEFAULT'
        }
      }
    });

    createComponent();

    expect(component.showDetails).toBe(false);
    expect(component.unit).toBe('%');
  });
});
