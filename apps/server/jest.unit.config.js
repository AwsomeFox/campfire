/** @type {import('jest').Config} */
const config = { ...require('./jest.config.js') };

// The general server config also discovers integration and *.e2e-spec.ts files.
// Coverage is intentionally a unit-only signal; the remaining server suites run
// without instrumentation in the sharded `server-tests` CI job.
delete config.testRegex;

module.exports = {
  ...config,
  cacheDirectory: '<rootDir>/.cache/jest/unit',
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
  // Include every production source file, not only modules imported by unit
  // tests. This makes the baseline honest and gives the follow-up coverage work
  // a stable denominator.
  collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!<rootDir>/src/**/*.d.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '/test/'],
  coverageReporters: ['json', 'lcov', 'text-summary'],
  // Milestone 1 unit coverage floors:
  // 40% statements / 30% branches / 35% functions / 40% lines.
  coverageThreshold: {
    global: {
      statements: 40,
      branches: 30,
      functions: 35,
      lines: 40,
    },
  },
};
