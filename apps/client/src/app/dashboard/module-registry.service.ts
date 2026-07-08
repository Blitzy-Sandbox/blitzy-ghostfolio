import { Injectable } from '@angular/core';
import { addIcons } from 'ionicons';
import {
  analyticsOutline,
  chatbubblesOutline,
  documentTextOutline,
  eyeOutline,
  gitCompareOutline,
  globeOutline,
  gridOutline,
  personCircleOutline,
  scaleOutline,
  speedometerOutline,
  trendingUpOutline,
  walletOutline
} from 'ionicons/icons';

import { DashboardModuleDefinition } from './dashboard-module.interface';
import { GfAiChatModuleComponent } from './modules/ai-chat/ai-chat.component';
import { GfBenchmarkModuleComponent } from './modules/benchmark/benchmark.component';
import { GfFearAndGreedModuleComponent } from './modules/fear-and-greed/fear-and-greed.component';
import { GfFinancialProfileModuleComponent } from './modules/financial-profile/financial-profile.component';
import { GfHoldingsModuleComponent } from './modules/holdings/holdings.component';
import { GfInvestmentChartModuleComponent } from './modules/investment-chart/investment-chart.component';
import { GfMarketOverviewModuleComponent } from './modules/market-overview/market-overview.component';
import { GfPerformanceModuleComponent } from './modules/performance/performance.component';
import { GfPortfolioOverviewModuleComponent } from './modules/portfolio-overview/portfolio-overview.component';
import { GfRebalancingModuleComponent } from './modules/rebalancing/rebalancing.component';
import { GfSummaryModuleComponent } from './modules/summary/summary.component';
import { GfWatchlistModuleComponent } from './modules/watchlist/watchlist.component';

/** Default minimum cell dimensions enforced when a module omits its own (Rule 6). */
const DEFAULT_MIN_COLS = 2;
const DEFAULT_MIN_ROWS = 2;

/**
 * Canonical list of every dashboard module type. This array is the SINGLE
 * place new module types are introduced (Rule 3) and the declaration source
 * for per-module minimum cell dimensions (Rule 6, floor 2x2).
 */
const MODULE_DEFINITIONS: DashboardModuleDefinition[] = [
  {
    component: GfPortfolioOverviewModuleComponent,
    defaultCols: 6,
    defaultRows: 6,
    icon: 'grid-outline',
    id: 'portfolio-overview',
    minCols: 2,
    minRows: 2,
    name: 'Portfolio Overview'
  },
  {
    component: GfHoldingsModuleComponent,
    defaultCols: 6,
    defaultRows: 6,
    icon: 'wallet-outline',
    id: 'holdings',
    minCols: 2,
    minRows: 2,
    name: 'Holdings'
  },
  {
    component: GfPerformanceModuleComponent,
    defaultCols: 6,
    defaultRows: 4,
    icon: 'trending-up-outline',
    id: 'performance',
    minCols: 2,
    minRows: 2,
    name: 'Performance'
  },
  {
    component: GfSummaryModuleComponent,
    defaultCols: 4,
    defaultRows: 8,
    icon: 'document-text-outline',
    id: 'summary',
    minCols: 2,
    minRows: 2,
    name: 'Summary'
  },
  {
    component: GfInvestmentChartModuleComponent,
    defaultCols: 8,
    defaultRows: 4,
    icon: 'analytics-outline',
    id: 'investment-chart',
    minCols: 2,
    minRows: 2,
    name: 'Investment Chart'
  },
  {
    component: GfMarketOverviewModuleComponent,
    defaultCols: 6,
    defaultRows: 4,
    icon: 'globe-outline',
    id: 'market-overview',
    minCols: 2,
    minRows: 2,
    name: 'Market Overview'
  },
  {
    component: GfWatchlistModuleComponent,
    defaultCols: 6,
    defaultRows: 5,
    icon: 'eye-outline',
    id: 'watchlist',
    minCols: 2,
    minRows: 2,
    name: 'Watchlist'
  },
  {
    component: GfFearAndGreedModuleComponent,
    defaultCols: 3,
    defaultRows: 3,
    icon: 'speedometer-outline',
    id: 'fear-and-greed',
    minCols: 2,
    minRows: 2,
    name: 'Fear & Greed Index'
  },
  {
    component: GfBenchmarkModuleComponent,
    defaultCols: 6,
    defaultRows: 5,
    icon: 'git-compare-outline',
    id: 'benchmark',
    minCols: 2,
    minRows: 2,
    name: 'Benchmark'
  },
  {
    component: GfRebalancingModuleComponent,
    defaultCols: 6,
    defaultRows: 6,
    icon: 'scale-outline',
    id: 'rebalancing',
    minCols: 2,
    minRows: 2,
    name: 'Rebalancing'
  },
  {
    component: GfFinancialProfileModuleComponent,
    defaultCols: 6,
    defaultRows: 8,
    icon: 'person-circle-outline',
    id: 'financial-profile',
    minCols: 2,
    minRows: 2,
    name: 'Financial Profile'
  },
  {
    component: GfAiChatModuleComponent,
    defaultCols: 5,
    defaultRows: 8,
    icon: 'chatbubbles-outline',
    id: 'ai-chat',
    minCols: 2,
    minRows: 2,
    name: 'AI Chat'
  }
];

@Injectable({
  providedIn: 'root'
})
export class ModuleRegistryService {
  private readonly registry = new Map<string, DashboardModuleDefinition>();

  public constructor() {
    // Register the ionicons glyphs referenced by every module definition's
    // `icon` field. Ghostfolio standardized on ionicons (`<ion-icon>` +
    // `addIcons`); the new dashboard chrome renders these names via
    // `<ion-icon [name]="definition.icon">` in the module shell header and the
    // module catalog. Registering them here — in the single source of truth for
    // module types (Rule 3) — guarantees every catalog row and module header
    // resolves to a bundled SVG glyph (no icon-font/CDN dependency), matching
    // the app's existing icon system. Component-specific chrome icons (drag
    // handle, remove, search, add) are registered in their own components.
    addIcons({
      analyticsOutline,
      chatbubblesOutline,
      documentTextOutline,
      eyeOutline,
      gitCompareOutline,
      globeOutline,
      gridOutline,
      personCircleOutline,
      scaleOutline,
      speedometerOutline,
      trendingUpOutline,
      walletOutline
    });

    MODULE_DEFINITIONS.forEach((definition) => this.register(definition));
  }

  /** Per-module minimum cell dimensions (Rule 6); falls back to 2x2. */
  public getMinDimensions(id: string): { minCols: number; minRows: number } {
    const definition = this.registry.get(id);

    return {
      minCols: definition?.minCols ?? DEFAULT_MIN_COLS,
      minRows: definition?.minRows ?? DEFAULT_MIN_ROWS
    };
  }

  /** All registered module definitions (for the module catalog). */
  public list(): DashboardModuleDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * Register a module type. The ONLY sanctioned way to introduce a module
   * (Rule 3). Coerces the declared minimums up to the 2x2 floor (Rule 6).
   */
  public register(definition: DashboardModuleDefinition): void {
    this.registry.set(definition.id, {
      ...definition,
      minCols: Math.max(
        definition.minCols ?? DEFAULT_MIN_COLS,
        DEFAULT_MIN_COLS
      ),
      minRows: Math.max(
        definition.minRows ?? DEFAULT_MIN_ROWS,
        DEFAULT_MIN_ROWS
      )
    });
  }

  /** Resolve a definition by module-type key; `undefined` when unknown. */
  public resolve(id: string): DashboardModuleDefinition | undefined {
    return this.registry.get(id);
  }
}
