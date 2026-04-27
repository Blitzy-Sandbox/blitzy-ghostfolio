/* eslint-disable */
export default {
  displayName: 'api',

  globals: {},
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json'
      }
    ]
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/api',
  // Loaded before each test file is evaluated. Sets fallback values for the
  // env vars required by `ConfigurationService` (which is directly
  // instantiated by `portfolio-calculator-*` specs) when those vars are not
  // already present on `process.env`. See `src/test-setup.ts` for rationale.
  setupFiles: ['<rootDir>/src/test-setup.ts'],
  testEnvironment: 'node',
  preset: '../../jest.preset.js'
};
