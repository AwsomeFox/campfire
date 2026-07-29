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
  // Measured unit-only baseline on 2026-07-28:
  // 29.91% stmts / 23.46% branches / 27.65% funcs / 30.40% lines.
  // These floors leave ~2 points of normal instrumentation headroom while
  // preventing the new baseline from silently regressing.
  coverageThreshold: {
    global: {
      statements: 28,
      branches: 21,
      functions: 25,
      lines: 28,
    },
  },
};
