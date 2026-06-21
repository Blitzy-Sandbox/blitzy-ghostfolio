// Initializes the global `$localize` function before the helper module under
// test is imported. `app.component.util.ts` imports
// `@ghostfolio/common/routes/routes`, whose module-level `publicRoutes`
// definition evaluates `$localize` tagged templates at import time; without
// this side-effect import that evaluation throws
// `ReferenceError: $localize is not defined`. The @trivago import-order plugin
// sorts this third-party side-effect import ahead of the relative
// `./app.component.util` import, so it is guaranteed to run first. The route
// segments below are asserted as plain string literals (not imported from
// `@ghostfolio/common/routes/routes`) precisely so this spec introduces no
// `@ghostfolio` import that would otherwise be ordered before this
// initializer.
import '@angular/localize/init';

import {
  hasPermissionToChangeDateRangeForRoute,
  hasPermissionToChangeFiltersForRoute
} from './app.component.util';

describe('app.component.util', () => {
  // The dashboard canvas is served at the application root route, which the
  // router resolves to an empty first URL segment (decision D-010).
  const DASHBOARD_ROOT = '';

  describe('hasPermissionToChangeDateRangeForRoute', () => {
    it('enables the date-range selector on the dashboard root (DEFAULT view mode)', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: DASHBOARD_ROOT,
          viewMode: 'DEFAULT'
        })
      ).toBe(true);
    });

    it('enables the date-range selector on the dashboard root when no view mode is set', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: DASHBOARD_ROOT
        })
      ).toBe(true);
    });

    it('suppresses the date-range selector on the dashboard root while in ZEN view mode', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: DASHBOARD_ROOT,
          viewMode: 'ZEN'
        })
      ).toBe(false);
    });

    it('keeps the legacy home overview route enabled (DEFAULT view mode)', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: 'home',
          viewMode: 'DEFAULT'
        })
      ).toBe(true);
    });

    it('keeps the legacy home/holdings route enabled (DEFAULT view mode)', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: 'home',
          currentSubRoute: 'holdings',
          viewMode: 'DEFAULT'
        })
      ).toBe(true);
    });

    it('keeps the legacy portfolio overview route enabled (DEFAULT view mode)', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: 'portfolio',
          viewMode: 'DEFAULT'
        })
      ).toBe(true);
    });

    it('suppresses the legacy home route while in ZEN view mode', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: 'home',
          viewMode: 'ZEN'
        })
      ).toBe(false);
    });

    it('disables the date-range selector on unrelated routes (e.g. account)', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: 'account',
          viewMode: 'DEFAULT'
        })
      ).toBe(false);
    });

    it('disables the date-range selector on portfolio sub-routes that never carried it (e.g. activities)', () => {
      expect(
        hasPermissionToChangeDateRangeForRoute({
          currentRoute: 'portfolio',
          currentSubRoute: 'activities',
          viewMode: 'DEFAULT'
        })
      ).toBe(false);
    });
  });

  describe('hasPermissionToChangeFiltersForRoute', () => {
    it('enables the filters on the dashboard root', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: DASHBOARD_ROOT
        })
      ).toBe(true);
    });

    it('enables the filters on the dashboard root regardless of any sub-route segment', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: DASHBOARD_ROOT,
          currentSubRoute: 'anything'
        })
      ).toBe(true);
    });

    it('keeps the legacy home/holdings route enabled', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'home',
          currentSubRoute: 'holdings'
        })
      ).toBe(true);
    });

    it('keeps the legacy portfolio overview route enabled', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'portfolio'
        })
      ).toBe(true);
    });

    it('keeps the legacy portfolio/activities route enabled', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'portfolio',
          currentSubRoute: 'activities'
        })
      ).toBe(true);
    });

    it('keeps the legacy portfolio/allocations route enabled', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'portfolio',
          currentSubRoute: 'allocations'
        })
      ).toBe(true);
    });

    it('keeps the legacy zen/holdings route enabled', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'zen',
          currentSubRoute: 'holdings'
        })
      ).toBe(true);
    });

    it('disables the filters on the legacy home overview route without the holdings sub-route', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'home'
        })
      ).toBe(false);
    });

    it('disables the filters on unrelated routes (e.g. account)', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'account'
        })
      ).toBe(false);
    });

    it('disables the filters on portfolio sub-routes that never carried them (e.g. fire)', () => {
      expect(
        hasPermissionToChangeFiltersForRoute({
          currentRoute: 'portfolio',
          currentSubRoute: 'fire'
        })
      ).toBe(false);
    });
  });
});
