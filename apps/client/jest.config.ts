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
  // Transform ESM-only packages that ship untranspiled `export` syntax.
  // In addition to any `.mjs` file, the Ionic/Ionicons/Stencil packages
  // publish ESM `.js` entry points (e.g. `@ionic/core/components/index.js`),
  // which are reached transitively via `libs/ui` `premium-indicator`
  // (`@ionic/angular/standalone`). Without allow-listing them here, Jest
  // throws `SyntaxError: Unexpected token 'export'` when a spec imports any
  // component whose graph includes Ionic (e.g. the dashboard module registry).
  transformIgnorePatterns: [
    'node_modules/(?!(?:.*.mjs$|@ionic|ionicons|@stencil))'
  ],
  preset: '../../jest.preset.js'
};
