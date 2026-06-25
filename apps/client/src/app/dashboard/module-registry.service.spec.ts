import { ModuleRegistryService } from './module-registry.service';

// `ModuleRegistryService` references the twelve module wrapper components only
// as values (the `component` field of each registered definition); it never
// instantiates them. Importing the real wrappers, however, transitively loads
// the entire feature-component graph and reaches `@ionic/angular/standalone`,
// whose `@ionic/core` entry point ships as untransformed ESM that Jest cannot
// parse under this project's `transformIgnorePatterns`. These specs exercise
// only the registry's own metadata (module count, unique keys, lookup by key
// and the 2x2 minimum-footprint clamp) and never render a component, so each
// wrapper is replaced with a lightweight stub class. The stubs remain valid
// `Type<unknown>` values, so the registry behaves identically to production for
// everything asserted below while staying fully isolated from heavy imports.
jest.mock('./modules/activities/activities-module.component', () => ({
  GfActivitiesModuleComponent: class GfActivitiesModuleComponent {}
}));
jest.mock('./modules/ai-chat/ai-chat-module.component', () => ({
  GfAiChatModuleComponent: class GfAiChatModuleComponent {}
}));
jest.mock('./modules/allocations/allocations-module.component', () => ({
  GfAllocationsModuleComponent: class GfAllocationsModuleComponent {}
}));
jest.mock('./modules/analysis/analysis-module.component', () => ({
  GfAnalysisModuleComponent: class GfAnalysisModuleComponent {}
}));
jest.mock('./modules/fire/fire-module.component', () => ({
  GfFireModuleComponent: class GfFireModuleComponent {}
}));
jest.mock('./modules/holdings/holdings-module.component', () => ({
  GfHoldingsModuleComponent: class GfHoldingsModuleComponent {}
}));
jest.mock('./modules/market/market-module.component', () => ({
  GfMarketModuleComponent: class GfMarketModuleComponent {}
}));
jest.mock(
  './modules/portfolio-overview/portfolio-overview-module.component',
  () => ({
    GfPortfolioOverviewModuleComponent: class GfPortfolioOverviewModuleComponent {}
  })
);
jest.mock('./modules/rebalancing/rebalancing-module.component', () => ({
  GfRebalancingModuleComponent: class GfRebalancingModuleComponent {}
}));
jest.mock('./modules/summary/summary-module.component', () => ({
  GfSummaryModuleComponent: class GfSummaryModuleComponent {}
}));
jest.mock('./modules/watchlist/watchlist-module.component', () => ({
  GfWatchlistModuleComponent: class GfWatchlistModuleComponent {}
}));
jest.mock('./modules/x-ray/x-ray-module.component', () => ({
  GfXRayModuleComponent: class GfXRayModuleComponent {}
}));

describe('ModuleRegistryService', () => {
  let service: ModuleRegistryService;

  beforeEach(() => {
    service = new ModuleRegistryService();
  });

  it('should register all 12 default modules', () => {
    expect(service.getAll().length).toBe(12);
  });

  it('should expose unique keys including the ai-chat module', () => {
    const keys = service.getAll().map((module) => module.key);

    expect(keys).toContain('ai-chat');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('should look up a registered module by key', () => {
    const holdings = service.get('holdings');

    expect(holdings).toBeDefined();
    expect(holdings?.key).toBe('holdings');
    expect(holdings?.name).toBe('Holdings');
    expect(holdings?.component).toBeDefined();
  });

  it('should return undefined for an unknown key', () => {
    expect(service.get('does-not-exist')).toBeUndefined();
  });

  it('should enforce a 2x2 minimum footprint on every default module', () => {
    for (const module of service.getAll()) {
      expect(module.minCols).toBeGreaterThanOrEqual(2);
      expect(module.minRows).toBeGreaterThanOrEqual(2);
    }
  });

  it('should clamp sub-minimum dimensions passed to register()', () => {
    class StubComponent {}

    service.register('stub', {
      component: StubComponent,
      minCols: 1,
      minRows: 0,
      name: 'Stub'
    });

    const stub = service.get('stub');

    expect(stub?.minCols).toBe(2);
    expect(stub?.minRows).toBe(2);
  });
});
