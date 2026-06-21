// Initializes the global `$localize` function used by Angular i18n at
// runtime. `module-registry.service.ts` calls `$localize\`...\`` tagged
// templates for every module's `displayName` inside its constructor.
// Without this side-effect import, instantiating the service via TestBed
// throws `ReferenceError: $localize is not defined` before any assertion
// runs. With no translations loaded, `$localize` returns the source
// message verbatim, so the asserted display strings below are exact.
import { TestBed } from '@angular/core/testing';
import '@angular/localize/init';

import { ModuleRegistryService } from './module-registry.service';

// Replace the twelve wrapper components with bare class symbols BEFORE the
// system-under-test is loaded. `ModuleRegistryService` statically imports
// all twelve wrappers; each wrapper transitively pulls in its feature
// component and — through the shared `UserService` chain — the `@ionic/core`
// ESM bundle that Jest cannot parse under the project's
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (apps/client/jest.config.ts, out of scope here). Stubbing the wrapper
// modules keeps this a fast, isolated unit test of the registry's own logic.
//
// `jest.mock(...)` calls are hoisted above all import statements by the
// jest-preset-angular TS transformer, so these stubs apply to the SUT's
// imports as well — mirroring the pattern in
// `financial-profile-form.component.spec.ts`.
jest.mock(
  '@ghostfolio/client/dashboard/modules/ai-chat/ai-chat.component',
  () => ({ GfAiChatModuleComponent: class GfAiChatModuleComponent {} })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/allocations/allocations.component',
  () => ({
    GfAllocationsModuleComponent: class GfAllocationsModuleComponent {}
  })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/analysis/analysis.component',
  () => ({ GfAnalysisModuleComponent: class GfAnalysisModuleComponent {} })
);
jest.mock('@ghostfolio/client/dashboard/modules/fire/fire.component', () => ({
  GfFireModuleComponent: class GfFireModuleComponent {}
}));
jest.mock(
  '@ghostfolio/client/dashboard/modules/holdings/holdings.component',
  () => ({ GfHoldingsModuleComponent: class GfHoldingsModuleComponent {} })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/markets/markets.component',
  () => ({ GfMarketsModuleComponent: class GfMarketsModuleComponent {} })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/portfolio-overview/portfolio-overview.component',
  () => ({
    GfPortfolioOverviewModuleComponent: class GfPortfolioOverviewModuleComponent {}
  })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/portfolio-summary/portfolio-summary.component',
  () => ({
    GfPortfolioSummaryModuleComponent: class GfPortfolioSummaryModuleComponent {}
  })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/summary/summary.component',
  () => ({ GfSummaryModuleComponent: class GfSummaryModuleComponent {} })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/transactions/transactions.component',
  () => ({
    GfTransactionsModuleComponent: class GfTransactionsModuleComponent {}
  })
);
jest.mock(
  '@ghostfolio/client/dashboard/modules/watchlist/watchlist.component',
  () => ({ GfWatchlistModuleComponent: class GfWatchlistModuleComponent {} })
);
jest.mock('@ghostfolio/client/dashboard/modules/x-ray/x-ray.component', () => ({
  GfXRayModuleComponent: class GfXRayModuleComponent {}
}));

/**
 * The canonical module contract (AAP § module-registry table). The registry's
 * `getAll()` MUST preserve this exact order and content.
 */
const EXPECTED_DEFINITIONS = [
  {
    displayName: 'Portfolio Overview',
    icon: 'grid-outline',
    key: 'portfolio-overview',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    displayName: 'Holdings',
    icon: 'wallet-outline',
    key: 'holdings',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    displayName: 'Summary',
    icon: 'reorder-four-outline',
    key: 'summary',
    minItemCols: 3,
    minItemRows: 4
  },
  {
    displayName: 'Markets',
    icon: 'trending-up-outline',
    key: 'markets',
    minItemCols: 4,
    minItemRows: 3
  },
  {
    displayName: 'Watchlist',
    icon: 'eye-outline',
    key: 'watchlist',
    minItemCols: 3,
    minItemRows: 4
  },
  {
    displayName: 'Portfolio Summary',
    icon: 'pie-chart-outline',
    key: 'portfolio-summary',
    minItemCols: 4,
    minItemRows: 4
  },
  {
    displayName: 'Transactions',
    icon: 'swap-horizontal-outline',
    key: 'transactions',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    displayName: 'Allocations',
    icon: 'aperture-outline',
    key: 'allocations',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    displayName: 'Analysis',
    icon: 'bar-chart-outline',
    key: 'analysis',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    displayName: 'FIRE',
    icon: 'flame-outline',
    key: 'fire',
    minItemCols: 4,
    minItemRows: 4
  },
  {
    displayName: 'X-ray',
    icon: 'scan-outline',
    key: 'x-ray',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    displayName: 'AI Chat',
    icon: 'chatbubbles-outline',
    key: 'ai-chat',
    minItemCols: 3,
    minItemRows: 4
  }
];

describe('ModuleRegistryService', () => {
  let service: ModuleRegistryService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ModuleRegistryService);
  });

  // Reset Jest mock state between specs. The twelve wrapper modules are
  // replaced with bare stub classes via top-level `jest.mock(...)` factories
  // (not call-tracking spies), so this is a defensive convention mirroring the
  // sibling `chat-panel.component.spec.ts` rather than a correctness
  // requirement — it guarantees no spy state leaks into a later suite.
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('registers exactly twelve modules', () => {
    expect(service.getAll()).toHaveLength(12);
  });

  it('registers the twelve canonical keys with no duplicates', () => {
    const keys = service.getAll().map((definition) => definition.key);

    expect(new Set(keys).size).toBe(12);

    for (const { key } of EXPECTED_DEFINITIONS) {
      expect(service.has(key)).toBe(true);
    }
  });

  it('preserves registration order in getAll()', () => {
    expect(service.getAll().map((definition) => definition.key)).toEqual(
      EXPECTED_DEFINITIONS.map((definition) => definition.key)
    );
  });

  it.each(EXPECTED_DEFINITIONS)(
    'exposes the canonical contract for the "$key" module',
    (expected) => {
      const definition = service.get(expected.key);

      expect(definition).toBeDefined();
      expect(definition.key).toBe(expected.key);
      expect(definition.displayName).toBe(expected.displayName);
      expect(definition.icon).toBe(expected.icon);
      expect(definition.minItemCols).toBe(expected.minItemCols);
      expect(definition.minItemRows).toBe(expected.minItemRows);
      // The registry stores the wrapper component `Type`, never the raw
      // feature component. A class reference is a function at runtime.
      expect(typeof definition.component).toBe('function');
    }
  );

  it.each(EXPECTED_DEFINITIONS)(
    'enforces the 2x2 minimum (and 12-column maximum) for the "$key" module',
    (expected) => {
      const definition = service.get(expected.key);

      expect(definition.minItemCols).toBeGreaterThanOrEqual(2);
      expect(definition.minItemRows).toBeGreaterThanOrEqual(2);
      expect(definition.minItemCols).toBeLessThanOrEqual(12);
    }
  );

  describe('get', () => {
    it('returns the definition registered under a known key', () => {
      expect(service.get('fire')?.displayName).toBe('FIRE');
    });

    it('returns undefined for an unknown key', () => {
      expect(service.get('does-not-exist')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true for a known key', () => {
      expect(service.has('ai-chat')).toBe(true);
    });

    it('returns false for an unknown key', () => {
      expect(service.has('not-a-module')).toBe(false);
    });
  });

  describe('register', () => {
    it('adds a brand-new definition keyed by its key', () => {
      class StubModuleComponent {}

      service.register({
        component: StubModuleComponent,
        displayName: 'Stub',
        icon: 'star',
        key: 'stub',
        minItemCols: 2,
        minItemRows: 2
      });

      expect(service.has('stub')).toBe(true);
      expect(service.get('stub')?.component).toBe(StubModuleComponent);
      expect(service.getAll()).toHaveLength(13);
    });

    it('overwrites an existing definition that shares the same key', () => {
      class ReplacementModuleComponent {}
      const sizeBefore = service.getAll().length;

      service.register({
        component: ReplacementModuleComponent,
        displayName: 'Replaced',
        icon: 'edit',
        key: 'fire',
        minItemCols: 2,
        minItemRows: 2
      });

      expect(service.get('fire')?.displayName).toBe('Replaced');
      expect(service.get('fire')?.component).toBe(ReplacementModuleComponent);
      // Replacing an existing key must not grow the registry.
      expect(service.getAll()).toHaveLength(sizeBefore);
    });
  });
});
