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

/**
 * Centralized registry of every dashboard module type.
 *
 * The single mechanism by which module types are introduced to the dashboard
 * canvas. Each module is described by a {@link ModuleDefinition} that pairs a
 * stable `key` with the thin **wrapper** component (`Gf*ModuleComponent`) that
 * embeds the underlying feature component and supplies the MatCard grid chrome.
 * Only wrappers are registered here — never the raw feature components — so
 * module isolation is preserved.
 *
 * The registry is `providedIn: 'root'`, so a single shared instance is reused
 * across the {@link DashboardCanvasComponent} (which resolves a `key` to a
 * component `Type` for `NgComponentOutlet`) and the module catalog (which
 * enumerates {@link getAll} to render the searchable list). All twelve module
 * definitions are populated eagerly in the constructor so the catalog is fully
 * available the moment the service is injected.
 *
 * @remarks
 * `displayName` values are localized with `$localize` tagged templates at
 * definition time. Because the catalog renders the name through interpolation
 * (where a template `i18n` attribute cannot apply), localization must happen
 * here in TypeScript — mirroring the module-scope `$localize` usage in
 * `chat-panel.component.ts`.
 */
@Injectable({
  providedIn: 'root'
})
export class ModuleRegistryService {
  /**
   * Backing store keyed by the module's stable `key`. A `Map` preserves
   * insertion order, so {@link getAll} returns definitions in the order they
   * were registered in the constructor (the catalog's natural display order).
   */
  private registry = new Map<string, ModuleDefinition>();

  /**
   * Eagerly registers all twelve dashboard modules. The registration order
   * mirrors the feature ordering of the legacy navigation shell and therefore
   * the order in which modules appear in the catalog. Object-literal keys are
   * ordered alphabetically (`component`, `displayName`, `icon`, `key`,
   * `minItemCols`, `minItemRows`) for consistency. Every module declares its
   * minimum cell dimensions (≥ the global 2×2 minimum, with `minItemCols` ≤ 12
   * grid columns); the grid engine enforces these and rejects below-minimum
   * resize attempts.
   */
  public constructor() {
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
      icon: 'reader-outline',
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
      icon: 'analytics-outline',
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
      icon: 'flask-outline',
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
   * Resolves a registered module definition by its stable `key`.
   *
   * @param key - The module's stable identifier (e.g. `'ai-chat'`).
   * @returns The matching {@link ModuleDefinition}, or `undefined` when no
   * module is registered under the given `key`.
   */
  public get(key: string): ModuleDefinition | undefined {
    return this.registry.get(key);
  }

  /**
   * Returns every registered module definition, in registration order.
   *
   * Consumed by the module catalog to render the searchable list of all
   * available modules.
   *
   * @returns A new array snapshot of the registered {@link ModuleDefinition}s;
   * mutating it does not affect the registry.
   */
  public getAll(): ModuleDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * Indicates whether a module is registered under the given `key`.
   *
   * @param key - The module's stable identifier.
   * @returns `true` when a definition exists for `key`; otherwise `false`.
   */
  public has(key: string): boolean {
    return this.registry.has(key);
  }

  /**
   * Registers (or replaces) a module definition, indexed by its `key`.
   *
   * This is the sole insertion path into the registry; the dashboard exposes
   * no other mechanism for introducing module types. Registering a definition
   * whose `key` already exists overwrites the previous entry.
   *
   * @param definition - The {@link ModuleDefinition} to register.
   */
  public register(definition: ModuleDefinition): void {
    this.registry.set(definition.key, definition);
  }
}
