import { ModuleDefinition } from '@ghostfolio/client/dashboard/dashboard.types';

import { TestBed } from '@angular/core/testing';
// Initializes the global `$localize` function used by Angular i18n at runtime.
// `ModuleRegistryService` populates each `ModuleDefinition.displayName` with
// `$localize\`...\`` tagged templates in its constructor. Without this
// side-effect import, instantiating the service throws
// `ReferenceError: $localize is not defined`. With no translations loaded (the
// source locale), `$localize` returns the cooked template string verbatim, so
// each `displayName` equals its English source text.
import '@angular/localize/init';

import { ModuleRegistryService } from './module-registry.service';

// Mock each of the twelve wrapper component modules that the system-under-test
// imports. This short-circuits the transitive ESM import chain — e.g.
//   GfAllocationsModuleComponent
//     -> GfAllocationsPageComponent (the real feature component)
//       -> ... -> UserService -> GfSubscriptionInterstitialDialogComponent
//         -> @ghostfolio/ui/membership-card (GfMembershipCardComponent)
//           -> @ionic/angular/standalone
//             -> @ionic/core (publishes plain ESM `.js` files)
// which Jest cannot parse under the project's existing
// `transformIgnorePatterns: ['node_modules/(?!.*.mjs$)']` rule
// (`apps/client/jest.config.ts`, out of scope for this additive PR per
// AAP § 0.6). This mirrors the established mocking approach in
// `financial-profile-form.component.spec.ts`.
//
// Each replacement exports a bare, correctly-named class so the registry can
// store it and the contract assertions can verify the key -> wrapper mapping
// by class name. The registry never instantiates these classes, so empty
// stand-ins are sufficient. `jest.mock` factories are hoisted above the
// imports above, so the SUT resolves to these mocks rather than the real
// (ESM-heavy) wrapper modules.
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
 * The expected metadata for a single registered module. `componentName`
 * mirrors the wrapper component's class name; the contract assertions verify
 * the key -> wrapper mapping by name, which matches the correctly-named mock
 * stand-ins above (and, in a production build, the real wrapper classes).
 */
interface ExpectedModule {
  componentName: string;
  displayName: string;
  icon: string;
  key: string;
  minItemCols: number;
  minItemRows: number;
}

/**
 * The canonical contract shared verbatim with the `modules/` folder agent:
 * every registered module's key, wrapper component class name, localized
 * display name, Material icon ligature, and minimum cell dimensions. The
 * registry is the sole introduction mechanism, so this table is the
 * authoritative source of truth the constructor must reproduce exactly. The
 * array order is also the expected catalog display order (registration order).
 */
const EXPECTED_MODULES: ExpectedModule[] = [
  {
    componentName: 'GfPortfolioOverviewModuleComponent',
    displayName: 'Portfolio Overview',
    icon: 'dashboard',
    key: 'portfolio-overview',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    componentName: 'GfHoldingsModuleComponent',
    displayName: 'Holdings',
    icon: 'account_balance_wallet',
    key: 'holdings',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    componentName: 'GfSummaryModuleComponent',
    displayName: 'Summary',
    icon: 'reorder',
    key: 'summary',
    minItemCols: 3,
    minItemRows: 4
  },
  {
    componentName: 'GfMarketsModuleComponent',
    displayName: 'Markets',
    icon: 'trending_up',
    key: 'markets',
    minItemCols: 4,
    minItemRows: 3
  },
  {
    componentName: 'GfWatchlistModuleComponent',
    displayName: 'Watchlist',
    icon: 'visibility',
    key: 'watchlist',
    minItemCols: 3,
    minItemRows: 4
  },
  {
    componentName: 'GfPortfolioSummaryModuleComponent',
    displayName: 'Portfolio Summary',
    icon: 'pie_chart',
    key: 'portfolio-summary',
    minItemCols: 4,
    minItemRows: 4
  },
  {
    componentName: 'GfTransactionsModuleComponent',
    displayName: 'Transactions',
    icon: 'swap_horiz',
    key: 'transactions',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    componentName: 'GfAllocationsModuleComponent',
    displayName: 'Allocations',
    icon: 'donut_large',
    key: 'allocations',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    componentName: 'GfAnalysisModuleComponent',
    displayName: 'Analysis',
    icon: 'bar_chart',
    key: 'analysis',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    componentName: 'GfFireModuleComponent',
    displayName: 'FIRE',
    icon: 'local_fire_department',
    key: 'fire',
    minItemCols: 4,
    minItemRows: 4
  },
  {
    componentName: 'GfXRayModuleComponent',
    displayName: 'X-ray',
    icon: 'biotech',
    key: 'x-ray',
    minItemCols: 6,
    minItemRows: 4
  },
  {
    componentName: 'GfAiChatModuleComponent',
    displayName: 'AI Chat',
    icon: 'chat',
    key: 'ai-chat',
    minItemCols: 3,
    minItemRows: 4
  }
];

const EXPECTED_KEYS = EXPECTED_MODULES.map(({ key }) => {
  return key;
});

/** Minimal stand-in component used to exercise the `register` mutation path. */
class FakeModuleComponent {}

describe('ModuleRegistryService', () => {
  let service: ModuleRegistryService;

  beforeEach(() => {
    TestBed.configureTestingModule({});

    // `providedIn: 'root'` yields a fresh instance per TestBed reset, so the
    // registry starts with exactly the twelve constructor-registered modules
    // in every test and `register` mutations never leak across tests.
    service = TestBed.inject(ModuleRegistryService);
  });

  // Reset Jest mock state between tests so any captured call/instance history
  // never leaks across test cases. The twelve wrapper modules are replaced via
  // `jest.mock` module factories (not `jest.fn` spies), so this is primarily a
  // defensive guard that keeps the suite hermetic; it also mirrors the
  // established `chat-panel.component.spec.ts` convention.
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('constructor registration', () => {
    it('should register exactly twelve modules', () => {
      expect(service.getAll()).toHaveLength(12);
    });

    it('should expose all twelve modules in registration order', () => {
      const keys = service.getAll().map(({ key }) => {
        return key;
      });

      expect(keys).toEqual(EXPECTED_KEYS);
    });

    it('should register twelve unique keys', () => {
      const keys = service.getAll().map(({ key }) => {
        return key;
      });

      expect(new Set(keys).size).toBe(12);
    });

    it.each(EXPECTED_MODULES)(
      'should register the "$key" module with the exact contract metadata',
      (expected) => {
        const definition = service.get(expected.key);

        expect(definition).toBeDefined();
        expect(definition?.key).toBe(expected.key);
        expect(definition?.displayName).toBe(expected.displayName);
        expect(definition?.icon).toBe(expected.icon);
        expect(definition?.minItemCols).toBe(expected.minItemCols);
        expect(definition?.minItemRows).toBe(expected.minItemRows);
        expect(definition?.component?.name).toBe(expected.componentName);
      }
    );

    it('should enforce a valid minimum size for every module', () => {
      for (const definition of service.getAll()) {
        // Global 2×2 minimum, bounded above by the 12-column grid.
        expect(definition.minItemCols).toBeGreaterThanOrEqual(2);
        expect(definition.minItemCols).toBeLessThanOrEqual(12);
        expect(definition.minItemRows).toBeGreaterThanOrEqual(2);
      }
    });

    it('should provide a non-empty display name, icon and component for every module', () => {
      for (const definition of service.getAll()) {
        expect(typeof definition.displayName).toBe('string');
        expect(definition.displayName.length).toBeGreaterThan(0);
        expect(typeof definition.icon).toBe('string');
        expect((definition.icon ?? '').length).toBeGreaterThan(0);
        expect(typeof definition.component).toBe('function');
      }
    });
  });

  describe('get', () => {
    it('should return the matching definition for a known key', () => {
      const definition = service.get('ai-chat');

      expect(definition?.key).toBe('ai-chat');
      expect(definition?.component?.name).toBe('GfAiChatModuleComponent');
    });

    it('should return undefined for an unknown key', () => {
      expect(service.get('does-not-exist')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for every registered key', () => {
      for (const key of EXPECTED_KEYS) {
        expect(service.has(key)).toBe(true);
      }
    });

    it('should return false for an unknown key', () => {
      expect(service.has('does-not-exist')).toBe(false);
    });
  });

  describe('register', () => {
    it('should add a new module definition', () => {
      const definition: ModuleDefinition = {
        component: FakeModuleComponent,
        displayName: 'Fake',
        icon: 'extension',
        key: 'fake',
        minItemCols: 2,
        minItemRows: 2
      };

      service.register(definition);

      expect(service.has('fake')).toBe(true);
      expect(service.get('fake')).toEqual(definition);
      expect(service.getAll()).toHaveLength(13);
    });

    it('should overwrite an existing definition without duplicating its key', () => {
      const replacement: ModuleDefinition = {
        component: FakeModuleComponent,
        displayName: 'Replaced AI Chat',
        icon: 'extension',
        key: 'ai-chat',
        minItemCols: 2,
        minItemRows: 2
      };

      service.register(replacement);

      expect(service.getAll()).toHaveLength(12);
      expect(service.get('ai-chat')).toEqual(replacement);
    });
  });
});
