/* eslint-disable */
export default {
  displayName: 'client',

  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  globals: {},
  coverageDirectory: '../../coverage/apps/client',
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment'
  ],
  transform: {
    '^.+.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$'
      }
    ]
  },
  // Transform `.mjs` ES modules in node_modules, plus the Ionicons packages
  // (`@ionic/*` and `ionicons`). `@ionic/angular/standalone` re-exports
  // `@ionic/core`, which ships browser-targeted ESM `.js` (bare `export`
  // statements) that Jest cannot parse untransformed. The dashboard canvas and
  // catalog components render their chrome via `<ion-icon>` (Ghostfolio does
  // not load the Material icon font), so their specs transitively load this
  // bundle; allowlisting `@ionic`/`ionicons` here lets Jest transform it. The
  // negative lookahead still ignores all OTHER `node_modules`, so this does not
  // affect any spec that does not import Ionicons.
  transformIgnorePatterns: ['node_modules/(?!.*.mjs$|@ionic|ionicons)'],
  preset: '../../jest.preset.js'
};
