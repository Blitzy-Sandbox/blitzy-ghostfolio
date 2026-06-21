import { ModuleDefinition } from '@ghostfolio/client/dashboard/dashboard.types';
import { GfAiChatModuleComponent } from '@ghostfolio/client/dashboard/modules/ai-chat/ai-chat.component';
import { GfAllocationsModuleComponent } from '@ghostfolio/client/dashboard/modules/allocations/allocations.component';
import { GfAnalysisModuleComponent } from '@ghostfolio/client/dashboard/modules/analysis/analysis.component';
import { GfFireModuleComponent } from '@ghostfolio/client/dashboard/modules/fire/fire.component';
import { GfHoldingsModuleComponent } from '@ghostfolio/client/dashboard/modules/holdings/holdings.component';
import { GfMarketsModuleComponent } from '@ghostfolio/client/dashboard/modules/markets/markets.component';
import { GfPortfolioOverviewModuleComponent } from '@ghostfolio/client/dashboard/modules/portfolio-overview/portfolio-overview.component';
import { GfPortfolioSummaryModuleComponent } from '@ghostfolio/client/dashboard/modules/portfolio-summary/portfolio-summary.component';
import { GfSummaryModuleComponent } from '@ghostfolio/client/dashboard/modules/summary/summary.component';
import { GfTransactionsModuleComponent } from '@ghostfolio/client/dashboard/modules/transactions/transactions.component';
import { GfWatchlistModuleComponent } from '@ghostfolio/client/dashboard/modules/watchlist/watchlist.component';
import { GfXRayModuleComponent } from '@ghostfolio/client/dashboard/modules/x-ray/x-ray.component';

import { Injectable } from '@angular/core';
import { addIcons } from 'ionicons';
import {
  apertureOutline,
  barChartOutline,
  chatbubblesOutline,
  eyeOutline,
  flameOutline,
  gridOutline,
  pieChartOutline,
  reorderFourOutline,
  scanOutline,
  swapHorizontalOutline,
  trendingUpOutline,
  walletOutline
} from 'ionicons/icons';

/**
 * Centralized registry of every dashboard module type.
 *
 * This `root`-provided service is the SINGLE, authoritative mechanism by
 * which module types are introduced to the dashboard canvas: each module is
 * keyed by a stable string and resolved to a thin wrapper component (the
 * wrapper embeds the underlying feature component and adds the MatCard grid
 * chrome). The canvas and catalog consume the registry exclusively — no
 * other code path may insert a module type.
 *
 * All twelve feature modules are registered once at construction time via
 * {@link ModuleRegistryService#register}. Insertion order is preserved by the
 * backing `Map`, so {@link ModuleRegistryService#getAll} returns definitions
 * in the order they were registered (which drives the catalog ordering).
 *
 * Every registered definition declares its minimum cell dimensions
 * (`minItemCols`/`minItemRows`, each ≥ 2 — the global 2×2 minimum); the grid
 * engine enforces these to reject below-minimum resize attempts.
 *
 * Display names are localized at definition time with `$localize` tagged
 * templates because they are rendered downstream via interpolation, where a
 * template `i18n` attribute cannot localize an interpolated value.
 */
@Injectable({
  providedIn: 'root'
})
export class ModuleRegistryService {
  private registry = new Map<string, ModuleDefinition>();

  public constructor() {
    // Register every module icon with Ionicons so the catalog can render them
    // via `<ion-icon [name]="module.icon">`. Registration is co-located with
    // the `icon:` name declarations below: this is the SINGLE place the icon
    // set is defined, so adding a module here can never desync from its icon
    // (Ghostfolio renders icons through `<ion-icon>` — the Material icon font
    // is not loaded — mirroring the header component's `addIcons` usage).
    addIcons({
      apertureOutline,
      barChartOutline,
      chatbubblesOutline,
      eyeOutline,
      flameOutline,
      gridOutline,
      pieChartOutline,
      reorderFourOutline,
      scanOutline,
      swapHorizontalOutline,
      trendingUpOutline,
      walletOutline
    });

    this.register({
      component: GfPortfolioOverviewModuleComponent,
      displayName: $localize`Portfolio Overview`,
      icon: 'grid-outline',
      key: 'portfolio-overview',
      minItemCols: 6,
      minItemRows: 4
    });

    this.register({
      component: GfHoldingsModuleComponent,
      displayName: $localize`Holdings`,
      icon: 'wallet-outline',
      key: 'holdings',
      minItemCols: 6,
      minItemRows: 4
    });

    this.register({
      component: GfSummaryModuleComponent,
      displayName: $localize`Summary`,
      icon: 'reorder-four-outline',
      key: 'summary',
      minItemCols: 3,
      minItemRows: 4
    });

    this.register({
      component: GfMarketsModuleComponent,
      displayName: $localize`Markets`,
      icon: 'trending-up-outline',
      key: 'markets',
      minItemCols: 4,
      minItemRows: 3
    });

    this.register({
      component: GfWatchlistModuleComponent,
      displayName: $localize`Watchlist`,
      icon: 'eye-outline',
      key: 'watchlist',
      minItemCols: 3,
      minItemRows: 4
    });

    this.register({
      component: GfPortfolioSummaryModuleComponent,
      displayName: $localize`Portfolio Summary`,
      icon: 'pie-chart-outline',
      key: 'portfolio-summary',
      minItemCols: 4,
      minItemRows: 4
    });

    this.register({
      component: GfTransactionsModuleComponent,
      displayName: $localize`Transactions`,
      icon: 'swap-horizontal-outline',
      key: 'transactions',
      minItemCols: 6,
      minItemRows: 4
    });

    this.register({
      component: GfAllocationsModuleComponent,
      displayName: $localize`Allocations`,
      icon: 'aperture-outline',
      key: 'allocations',
      minItemCols: 6,
      minItemRows: 4
    });

    this.register({
      component: GfAnalysisModuleComponent,
      displayName: $localize`Analysis`,
      icon: 'bar-chart-outline',
      key: 'analysis',
      minItemCols: 6,
      minItemRows: 4
    });

    this.register({
      component: GfFireModuleComponent,
      displayName: $localize`FIRE`,
      icon: 'flame-outline',
      key: 'fire',
      minItemCols: 4,
      minItemRows: 4
    });

    this.register({
      component: GfXRayModuleComponent,
      displayName: $localize`X-ray`,
      icon: 'scan-outline',
      key: 'x-ray',
      minItemCols: 6,
      minItemRows: 4
    });

    this.register({
      component: GfAiChatModuleComponent,
      displayName: $localize`AI Chat`,
      icon: 'chatbubbles-outline',
      key: 'ai-chat',
      minItemCols: 3,
      minItemRows: 4
    });
  }

  /**
   * Returns the module definition registered under `key`, or `undefined`
   * when no module type is registered for that key.
   */
  public get(key: string): ModuleDefinition | undefined {
    return this.registry.get(key);
  }

  /**
   * Returns every registered module definition in registration order.
   * Used by the catalog to list all available module types.
   */
  public getAll(): ModuleDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * Returns `true` when a module type is registered under `key`.
   */
  public has(key: string): boolean {
    return this.registry.has(key);
  }

  /**
   * Registers (or replaces) a module definition, keyed by `definition.key`.
   * This is the sole introduction mechanism for dashboard module types.
   */
  public register(definition: ModuleDefinition): void {
    this.registry.set(definition.key, definition);
  }
}
