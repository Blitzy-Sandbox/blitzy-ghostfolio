import { DASHBOARD_MODULE_TYPES } from '@ghostfolio/common/interfaces';

// Initializes the global `$localize` function used by Angular i18n at runtime.
// `ModuleRegistryService` statically imports all 12 `modules/*` wrappers, whose
// transitive feature components (e.g. `chat-panel.component.ts`) declare
// `$localize`-tagged templates at module scope. Without this side-effect import
// — which MUST run before the SUT module graph is evaluated — merely importing
// `ModuleRegistryService` throws `ReferenceError: $localize is not defined`
// before any test executes. Mirrors the existing `chat-panel.component.spec.ts`.
import { TestBed } from '@angular/core/testing';
import '@angular/localize/init';

import { ModuleRegistryService } from './module-registry.service';

/**
 * Minimal stand-in component `Type` used to exercise `register()` and the
 * Rule 6 floor-coercion logic without coupling the test to any real feature
 * module or the Angular rendering pipeline.
 */
class StubModuleComponent {}

describe('ModuleRegistryService', () => {
  let service: ModuleRegistryService;

  // The canonical module-type keys the registry MUST expose. This is the
  // LOCKED 12-module contract shared with the `modules/` folder and the
  // persisted `DashboardLayoutItem.type` keys (Rule 3).
  const EXPECTED_IDS = [
    'portfolio-overview',
    'holdings',
    'performance',
    'summary',
    'investment-chart',
    'market-overview',
    'watchlist',
    'fear-and-greed',
    'benchmark',
    'rebalancing',
    'financial-profile',
    'ai-chat'
  ];

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [ModuleRegistryService] });

    service = TestBed.inject(ModuleRegistryService);
  });

  it('should be created and self-register its module catalog in the constructor', () => {
    expect(service).toBeTruthy();
    expect(service.list().length).toBeGreaterThan(0);
  });

  describe('list()', () => {
    it('should register exactly the 12 locked module definitions', () => {
      expect(service.list()).toHaveLength(12);
    });

    it('should expose every canonical module-type id and no others', () => {
      const ids = service.list().map((definition) => definition.id);

      EXPECTED_IDS.forEach((id) => {
        expect(ids).toContain(id);
      });
      expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    });

    it('should exactly match the shared DASHBOARD_MODULE_TYPES whitelist consumed by the server DTO (CWE-20 drift guard)', () => {
      const ids = service.list().map((definition) => definition.id);

      // The server DTO validates each PATCH /api/v1/user/layout item `type`
      // with `@IsIn([...DASHBOARD_MODULE_TYPES])`. If the client registry and
      // that shared whitelist ever drift, a module addable on the client would
      // be rejected with HTTP 400 on save, or an unknown persisted `type` would
      // render a blank grid cell. Pinning both to the same set prevents that.
      expect([...ids].sort()).toEqual([...DASHBOARD_MODULE_TYPES].sort());
    });

    it('should provide a component Type and a display name for every definition (NgComponentOutlet contract)', () => {
      for (const definition of service.list()) {
        // A component `Type` is a constructor function; the canvas mounts it
        // via `NgComponentOutlet`.
        expect(typeof definition.component).toBe('function');
        expect(typeof definition.name).toBe('string');
        expect(definition.name.length).toBeGreaterThan(0);
      }
    });

    it('should satisfy the 2x2 minimum floor on every registered definition (Rule 6)', () => {
      for (const definition of service.list()) {
        expect(definition.minCols).toBeGreaterThanOrEqual(2);
        expect(definition.minRows).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('resolve()', () => {
    it('should resolve a known module-type key to its definition', () => {
      const definition = service.resolve('ai-chat');

      expect(definition).toBeDefined();
      expect(definition?.id).toBe('ai-chat');
      expect(definition?.name).toBe('AI Chat');
      expect(definition?.icon).toBe('chatbubbles-outline');
    });

    it('should resolve the portfolio-overview default geometry', () => {
      const definition = service.resolve('portfolio-overview');

      expect(definition?.defaultCols).toBe(6);
      expect(definition?.defaultRows).toBe(4);
    });

    it('should return undefined for an unknown module-type key', () => {
      expect(service.resolve('does-not-exist')).toBeUndefined();
    });
  });

  describe('getMinDimensions()', () => {
    it('should return the per-module minimum for a known key', () => {
      expect(service.getMinDimensions('portfolio-overview')).toEqual({
        minCols: 2,
        minRows: 2
      });
    });

    it('should fall back to the 2x2 default for an unknown key (Rule 6)', () => {
      expect(service.getMinDimensions('unknown-module')).toEqual({
        minCols: 2,
        minRows: 2
      });
    });
  });

  describe('register()', () => {
    it('should be the sanctioned mechanism to introduce a new module type (Rule 3)', () => {
      const countBefore = service.list().length;

      service.register({
        component: StubModuleComponent,
        defaultCols: 3,
        defaultRows: 4,
        icon: 'extension-puzzle-outline',
        id: 'custom-module',
        minCols: 3,
        minRows: 4,
        name: 'Custom Module'
      });

      expect(service.list().length).toBe(countBefore + 1);
      expect(service.resolve('custom-module')?.name).toBe('Custom Module');
      expect(service.getMinDimensions('custom-module')).toEqual({
        minCols: 3,
        minRows: 4
      });
    });

    it('should coerce sub-minimum declared dimensions up to the 2x2 floor (Rule 6)', () => {
      service.register({
        component: StubModuleComponent,
        id: 'too-small',
        minCols: 1,
        minRows: 1,
        name: 'Too Small'
      });

      expect(service.getMinDimensions('too-small')).toEqual({
        minCols: 2,
        minRows: 2
      });
      expect(service.resolve('too-small')?.minCols).toBe(2);
      expect(service.resolve('too-small')?.minRows).toBe(2);
    });

    it('should overwrite an existing definition registered under the same id without growing the catalog', () => {
      service.register({
        component: StubModuleComponent,
        id: 'ai-chat',
        minCols: 2,
        minRows: 2,
        name: 'Overridden Chat'
      });

      expect(service.resolve('ai-chat')?.name).toBe('Overridden Chat');
      expect(service.list()).toHaveLength(12);
    });
  });
});
