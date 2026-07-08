import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

// Initializes the global `$localize` function used by Angular i18n at runtime.
// This side-effect import MUST run before any module graph that evaluates
// `$localize` at module scope. The relative imports below (the SUT and
// `UserService`) transitively pull such graphs — the wrapped
// `GfFearAndGreedIndexComponent` uses `translate()`/`i18n`, and `UserService`
// pulls `libs/common/.../routes.ts` which declares `$localize`-tagged titles at
// module scope. `UserService` is therefore imported via its relative path
// (group 3, after this init) rather than the `@ghostfolio/client/*` alias
// (group 1, before this init) — otherwise merely importing it throws
// `ReferenceError: $localize is not defined` before any test runs. Mirrors the
// verified relative-service pattern in `chat-panel.component.spec.ts` and the
// side-effect placement in `dashboard-canvas.component.spec.ts` /
// `module-registry.service.spec.ts`.
import { Component, Input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import '@angular/localize/init';
import { of } from 'rxjs';

import { UserService } from '../../../services/user/user.service';
import { GfFearAndGreedModuleComponent } from './fear-and-greed.component';

// Dependency-free stand-in for the wrapped feature component. The real
// `GfFearAndGreedIndexComponent` pulls in `ngx-skeleton-loader` and i18n
// helpers that are out of scope for this wrapper unit test; the stub keeps the
// same `gf-fear-and-greed-index` selector and `fearAndGreedIndex` input so the
// wrapper template binds against it and we can assert the value handed to the
// gauge. Injected via `overrideComponent` (mirrors the canvas spec's approach).
@Component({
  selector: 'gf-fear-and-greed-index',
  standalone: true,
  template: '<div class="stub-gauge">{{ fearAndGreedIndex }}</div>'
})
class StubFearAndGreedIndexComponent {
  @Input() public fearAndGreedIndex: number;
}

describe('GfFearAndGreedModuleComponent', () => {
  let component: GfFearAndGreedModuleComponent;
  let fixture: ComponentFixture<GfFearAndGreedModuleComponent>;
  // Test doubles are typed `any` (standard for spec test doubles) so partial
  // shapes and jest-mock helpers (mockReturnValue) are ergonomic.
  let dataServiceMock: any;
  let userServiceMock: any;

  // `fetchInfo()` is read in the constructor and `ngOnInit`, so the mock return
  // value must be set BEFORE the component is created.
  function createComponent() {
    fixture = TestBed.createComponent(GfFearAndGreedModuleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(async () => {
    dataServiceMock = {
      fetchInfo: jest.fn(),
      fetchSymbolItem: jest.fn()
    };
    userServiceMock = {
      // The constructor subscribes to `stateChanged`; a completed stream with a
      // null state is enough (the `if (state?.user)` branch is skipped).
      stateChanged: of(null)
    };

    await TestBed.configureTestingModule({
      imports: [GfFearAndGreedModuleComponent],
      providers: [
        { provide: DataService, useValue: dataServiceMock },
        { provide: UserService, useValue: userServiceMock }
      ]
    })
      .overrideComponent(GfFearAndGreedModuleComponent, {
        set: { imports: [StubFearAndGreedIndexComponent] }
      })
      .compileComponents();
  });

  it('renders a VISIBLE "unavailable" message and does NOT mount the (hidden) gauge when no Fear & Greed data source is available (QA F4)', () => {
    // No `enableFearAndGreedIndex` in global permissions => the data source is
    // not configured, mirroring the sandbox where `fearAndGreedDataSource` is
    // null and the gauge would otherwise be stuck `visibility: hidden`.
    dataServiceMock.fetchInfo.mockReturnValue({ globalPermissions: [] });

    createComponent();

    const el: HTMLElement = fixture.nativeElement;

    // The stuck-invisible child must NOT be in the DOM at all.
    expect(el.querySelector('gf-fear-and-greed-index')).toBeNull();

    // A visible honest fallback message IS present (not `[hidden]`, non-empty).
    const unavailable = el.querySelector(
      '.gf-fear-and-greed-module__unavailable'
    ) as HTMLElement | null;
    expect(unavailable).not.toBeNull();
    expect(unavailable?.hasAttribute('hidden')).toBe(false);
    expect((unavailable?.textContent ?? '').trim().length).toBeGreaterThan(0);

    // Without permission the wrapper must not attempt a data fetch.
    expect(dataServiceMock.fetchSymbolItem).not.toHaveBeenCalled();
    expect(component.hasPermissionToAccessFearAndGreedIndex).toBe(false);
  });

  it('mounts the Fear & Greed gauge with the loaded value (and hides the unavailable message) when data is available (QA F4)', () => {
    dataServiceMock.fetchInfo.mockReturnValue({
      fearAndGreedDataSource: 'RAKUTEN',
      globalPermissions: [permissions.enableFearAndGreedIndex]
    });
    dataServiceMock.fetchSymbolItem.mockReturnValue(of({ marketPrice: 42 }));

    createComponent();

    const el: HTMLElement = fixture.nativeElement;

    // The gauge IS mounted and received the loaded value.
    const gauge = el.querySelector('gf-fear-and-greed-index');
    expect(gauge).not.toBeNull();
    expect(gauge?.textContent).toContain('42');
    expect(component.fearAndGreedIndex).toBe(42);

    // The unavailable fallback is NOT shown when data is available.
    expect(
      el.querySelector('.gf-fear-and-greed-module__unavailable')
    ).toBeNull();

    expect(dataServiceMock.fetchSymbolItem).toHaveBeenCalledTimes(1);
    expect(component.hasPermissionToAccessFearAndGreedIndex).toBe(true);
  });
});
