import { Component, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { DashboardModuleDescriptor } from './interfaces/dashboard-module.interface';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Unit-test spec for {@link ModuleRegistryService} — the canonical
 * dashboard module registry that is the single source of allowed
 * grid-item component types per Rule 3 (AAP § 0.8.1.3).
 *
 * **Coverage objectives** (AAP § 0.8.5 — ≥ 80 % line coverage of the
 * SUT):
 *
 *   - Construction & default state — empty registry on first inject.
 *   - {@link ModuleRegistryService.register} happy path (single and
 *     multiple distinct descriptors).
 *   - {@link ModuleRegistryService.register} duplicate-name rejection
 *     (Rule 3, AAP § 0.8.1.3) — protects the single-source-of-truth
 *     contract from silent overwrites.
 *   - {@link ModuleRegistryService.register} dimension-floor
 *     validation (Rule 6, AAP § 0.8.1.6) — `minCols < 2`,
 *     `minRows < 2`, `defaultCols < minCols`, `defaultRows < minRows`,
 *     and empty `name` all throw at registration time.
 *   - {@link ModuleRegistryService.getAll} defensive-copy semantics —
 *     callers cannot mutate the registry through the returned array.
 *   - {@link ModuleRegistryService.getByName} lookup semantics —
 *     `undefined` for unregistered names; identity-equal descriptor
 *     for registered names.
 *
 * **Testing pattern**: the SUT is `providedIn: 'root'`, so
 * `TestBed.inject(ModuleRegistryService)` returns a fresh instance per
 * `beforeEach` (Angular's testing module re-creates the root injector
 * tree before every test). No mocks are required — the registry has
 * zero dependencies. We exercise the real implementation as a black box
 * via its public `register` / `getAll` / `getByName` API.
 *
 * **Type strictness**: every test fixture is statically typed as
 * {@link DashboardModuleDescriptor}; the only narrowing cast is
 * `... as Type<unknown>` on the `component` field, which mirrors how
 * Angular's framework `Type<T>` constraint is typically narrowed when
 * passing standalone test stub components into a descriptor literal
 * (see also `apps/client/src/app/dashboard/module-wrapper/module-wrapper.component.spec.ts`
 * for the sibling pattern of declaring local standalone test stubs).
 *
 * **Validation-failure assertions** are intentionally narrow
 * `expect(() => ...).toThrow()` predicates — the SUT may use plain
 * `Error`, custom error subclasses, or a typed exception; any thrown
 * value satisfies the contract. This decoupling keeps the spec robust
 * to future refactors of the SUT's error-message wording without
 * sacrificing the structural invariant that registration MUST fail
 * synchronously.
 */

/**
 * Standalone test stub component used as the {@link
 * DashboardModuleDescriptor.component} field in valid-fixture
 * descriptors. Declared as a local class (not exported) so the spec
 * file is fully self-contained — no real feature wrapper (e.g.,
 * `GfChatModuleComponent`, `GfHoldingsModuleComponent`) is loaded
 * into the registry by these tests, which keeps the test surface
 * independent of feature-module evolution.
 *
 * The selector `gf-test-module-a` is unique within the spec file to
 * satisfy Angular's standalone-component selector-uniqueness rule;
 * the empty `template` ensures no rendering work occurs (these
 * components never enter a `ComponentFixture`'s render path — they
 * exist purely as `Type<unknown>` references).
 */
@Component({
  selector: 'gf-test-module-a',
  standalone: true,
  template: ''
})
class TestModuleAComponent {}

/**
 * Second standalone test stub component, distinct from
 * {@link TestModuleAComponent}, used in tests that exercise multiple
 * registrations (see "should register multiple distinct descriptors
 * independently") and in the duplicate-name rejection test (where
 * the duplicate descriptor MUST point at a different `component`
 * class so the test can assert that the first-registered descriptor
 * — not the second — survives the rejection).
 */
@Component({
  selector: 'gf-test-module-b',
  standalone: true,
  template: ''
})
class TestModuleBComponent {}

describe('ModuleRegistryService', () => {
  let service: ModuleRegistryService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ModuleRegistryService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should expose an empty list when no modules have been registered', () => {
    expect(service.getAll()).toEqual([]);
  });

  it('should return undefined for unregistered module names', () => {
    expect(service.getByName('non-existent')).toBeUndefined();
  });

  it('should register a valid descriptor and expose it via getByName', () => {
    const descriptor: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 6,
      defaultRows: 4,
      displayLabel: 'Test Module A',
      iconName: 'analytics-outline',
      minCols: 4,
      minRows: 2,
      name: 'test-module-a'
    };

    service.register(descriptor);

    expect(service.getByName('test-module-a')).toBe(descriptor);
    expect(service.getAll()).toHaveLength(1);
    expect(service.getAll()[0]).toBe(descriptor);
  });

  it('should register multiple distinct descriptors independently', () => {
    const a: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 6,
      defaultRows: 4,
      displayLabel: 'Test Module A',
      iconName: 'analytics-outline',
      minCols: 4,
      minRows: 2,
      name: 'test-module-a'
    };
    const b: DashboardModuleDescriptor = {
      component: TestModuleBComponent as Type<unknown>,
      defaultCols: 8,
      defaultRows: 6,
      displayLabel: 'Test Module B',
      iconName: 'pie-chart-outline',
      minCols: 4,
      minRows: 4,
      name: 'test-module-b'
    };

    service.register(a);
    service.register(b);

    expect(service.getAll()).toHaveLength(2);
    expect(service.getByName('test-module-a')).toBe(a);
    expect(service.getByName('test-module-b')).toBe(b);
  });

  it('should reject duplicate module-name registration', () => {
    const original: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 6,
      defaultRows: 4,
      displayLabel: 'Test Module A',
      iconName: 'analytics-outline',
      minCols: 4,
      minRows: 2,
      name: 'duplicate-name'
    };
    const duplicate: DashboardModuleDescriptor = {
      component: TestModuleBComponent as Type<unknown>,
      defaultCols: 4,
      defaultRows: 4,
      displayLabel: 'Test Module B',
      iconName: 'pie-chart-outline',
      minCols: 2,
      minRows: 2,
      name: 'duplicate-name'
    };

    service.register(original);

    expect(() => service.register(duplicate)).toThrow();
    // Original entry is preserved — duplicate registration MUST NOT
    // overwrite an existing descriptor (Rule 3, AAP § 0.8.1.3). This
    // assertion guards against a regression where the SUT throws but
    // also mutates internal state, which would silently break the
    // single-source-of-truth contract for any code path that catches
    // the thrown error.
    expect(service.getByName('duplicate-name')).toBe(original);
    expect(service.getAll()).toHaveLength(1);
  });

  it('should reject descriptors with minCols below 2', () => {
    const invalid: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 4,
      defaultRows: 4,
      displayLabel: 'Invalid',
      iconName: 'alert-circle-outline',
      minCols: 1,
      minRows: 2,
      name: 'invalid-min-cols'
    };

    expect(() => service.register(invalid)).toThrow();
    expect(service.getAll()).toEqual([]);
  });

  it('should reject descriptors with minRows below 2', () => {
    const invalid: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 4,
      defaultRows: 4,
      displayLabel: 'Invalid',
      iconName: 'alert-circle-outline',
      minCols: 2,
      minRows: 1,
      name: 'invalid-min-rows'
    };

    expect(() => service.register(invalid)).toThrow();
    expect(service.getAll()).toEqual([]);
  });

  it('should reject descriptors whose defaultCols is below minCols', () => {
    const invalid: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 2,
      defaultRows: 4,
      displayLabel: 'Invalid Default',
      iconName: 'alert-circle-outline',
      minCols: 4,
      minRows: 2,
      name: 'invalid-default-cols'
    };

    expect(() => service.register(invalid)).toThrow();
  });

  it('should reject descriptors whose defaultRows is below minRows', () => {
    const invalid: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 4,
      defaultRows: 2,
      displayLabel: 'Invalid Default',
      iconName: 'alert-circle-outline',
      minCols: 2,
      minRows: 4,
      name: 'invalid-default-rows'
    };

    expect(() => service.register(invalid)).toThrow();
  });

  it('should reject descriptors with empty name', () => {
    const invalid: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 4,
      defaultRows: 4,
      displayLabel: 'Empty Name',
      iconName: 'alert-circle-outline',
      minCols: 2,
      minRows: 2,
      name: ''
    };

    expect(() => service.register(invalid)).toThrow();
  });

  it('should return a defensive copy from getAll() that does not mutate internal state', () => {
    const a: DashboardModuleDescriptor = {
      component: TestModuleAComponent as Type<unknown>,
      defaultCols: 6,
      defaultRows: 4,
      displayLabel: 'Test Module A',
      iconName: 'analytics-outline',
      minCols: 4,
      minRows: 2,
      name: 'mutation-test'
    };

    service.register(a);

    const externalCopy = service.getAll();
    // Attempt to mutate the returned array. A non-defensive
    // implementation that returned the underlying storage by reference
    // would propagate this mutation into the registry, allowing a
    // caller to silently delete every registered descriptor by
    // truncating the array — a direct violation of the
    // single-source-of-truth contract (Rule 3, AAP § 0.8.1.3).
    externalCopy.length = 0;

    expect(service.getAll()).toHaveLength(1);
    expect(service.getByName('mutation-test')).toBe(a);
  });
});
