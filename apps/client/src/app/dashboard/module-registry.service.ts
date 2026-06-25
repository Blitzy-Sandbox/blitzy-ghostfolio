import { Injectable, Type } from '@angular/core';

import { GfActivitiesModuleComponent } from './modules/activities/activities-module.component';
import { GfAiChatModuleComponent } from './modules/ai-chat/ai-chat-module.component';
import { GfAllocationsModuleComponent } from './modules/allocations/allocations-module.component';
import { GfAnalysisModuleComponent } from './modules/analysis/analysis-module.component';
import { GfFireModuleComponent } from './modules/fire/fire-module.component';
import { GfHoldingsModuleComponent } from './modules/holdings/holdings-module.component';
import { GfMarketModuleComponent } from './modules/market/market-module.component';
import { GfPortfolioOverviewModuleComponent } from './modules/portfolio-overview/portfolio-overview-module.component';
import { GfRebalancingModuleComponent } from './modules/rebalancing/rebalancing-module.component';
import { GfSummaryModuleComponent } from './modules/summary/summary-module.component';
import { GfWatchlistModuleComponent } from './modules/watchlist/watchlist-module.component';
import { GfXRayModuleComponent } from './modules/x-ray/x-ray-module.component';

/** Hard floor for every module's grid footprint (Rule 6: 2×2 minimum). */
const MIN_CELL_DIMENSION = 2;

/**
 * Metadata describing one registrable dashboard module type.
 * `component` is the thin wrapper rendered (via `ngComponentOutlet`) inside a
 * grid cell; `minCols`/`minRows` are the enforced minimum cell footprint.
 */
export interface ModuleDefinition {
  component: Type<unknown>;
  minCols: number;
  minRows: number;
  name: string;
}

/** A `ModuleDefinition` plus the `moduleKey` it is registered under. */
export interface RegisteredModule extends ModuleDefinition {
  key: string;
}

/**
 * The sole registration + lookup point for dashboard module types (Rule 3).
 * The catalog lists `getAll()`; the canvas resolves a persisted item's
 * `moduleKey` via `get(key)` to obtain the component to render.
 */
@Injectable({
  providedIn: 'root'
})
export class ModuleRegistryService {
  private readonly modules = new Map<string, RegisteredModule>();

  public constructor() {
    this.registerDefaultModules();
  }

  public get(key: string): RegisteredModule | undefined {
    return this.modules.get(key);
  }

  public getAll(): RegisteredModule[] {
    return Array.from(this.modules.values());
  }

  public register(key: string, definition: ModuleDefinition): void {
    this.modules.set(key, {
      component: definition.component,
      key,
      minCols: Math.max(definition.minCols, MIN_CELL_DIMENSION),
      minRows: Math.max(definition.minRows, MIN_CELL_DIMENSION),
      name: definition.name
    });
  }

  private registerDefaultModules(): void {
    this.register('portfolio-overview', {
      component: GfPortfolioOverviewModuleComponent,
      minCols: 4,
      minRows: 2,
      name: 'Portfolio Overview'
    });
    this.register('holdings', {
      component: GfHoldingsModuleComponent,
      minCols: 4,
      minRows: 4,
      name: 'Holdings'
    });
    this.register('summary', {
      component: GfSummaryModuleComponent,
      minCols: 3,
      minRows: 3,
      name: 'Summary'
    });
    this.register('watchlist', {
      component: GfWatchlistModuleComponent,
      minCols: 3,
      minRows: 3,
      name: 'Watchlist'
    });
    this.register('market', {
      component: GfMarketModuleComponent,
      minCols: 3,
      minRows: 3,
      name: 'Market'
    });
    this.register('ai-chat', {
      component: GfAiChatModuleComponent,
      minCols: 3,
      minRows: 4,
      name: 'AI Chat'
    });
    this.register('analysis', {
      component: GfAnalysisModuleComponent,
      minCols: 4,
      minRows: 4,
      name: 'Analysis'
    });
    this.register('activities', {
      component: GfActivitiesModuleComponent,
      minCols: 4,
      minRows: 3,
      name: 'Activities'
    });
    this.register('allocations', {
      component: GfAllocationsModuleComponent,
      minCols: 4,
      minRows: 4,
      name: 'Allocations'
    });
    this.register('fire', {
      component: GfFireModuleComponent,
      minCols: 3,
      minRows: 3,
      name: 'FIRE'
    });
    this.register('x-ray', {
      component: GfXRayModuleComponent,
      minCols: 4,
      minRows: 3,
      name: 'X-ray'
    });
    this.register('rebalancing', {
      component: GfRebalancingModuleComponent,
      minCols: 4,
      minRows: 4,
      name: 'Rebalancing'
    });
  }
}
