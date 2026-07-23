/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  // Two test layers share this config:
  //  - `*.e2e-spec.ts` (test/)         — full-app HTTP suites, bootstrap a Nest app + SQLite
  //  - `*.spec.ts`     (test/unit/…)   — fast, isolated unit tests for pure logic, no bootstrap
  // `.spec.ts` deliberately does NOT match `.e2e-spec.ts` (the char before `spec`
  // is `-`, not `.`), so the two patterns never double-count a file.
  testRegex: ['.*\\.e2e-spec\\.ts$', '.*\\.spec\\.ts$'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testTimeout: 30000,
  maxWorkers: 1,
  // The integration-heavy suite creates a fresh Nest application and SQLite
  // database for many files. Recycle Jest's lone worker between files once it
  // grows past this bound instead of letting retained module state accumulate
  // until the GitHub runner's Node heap is exhausted.
  workerIdleMemoryLimit: '1024MB',
  // Floor for CI `test:cov` (#562) — previously unset, so a coverage regression
  // could land silently forever. Global floors sit a few points below the
  // observed full-suite CI levels (~88.6% stmts / ~70% branches / ~89.5% funcs /
  // ~90% lines). Issue #562 estimated ~75% branches; measured CI is ~70% because
  // auth/OIDC, rules importers, ai-dm providers, and mcp drag the average — those
  // known-low areas get per-path carve-outs below so they cannot freefall either.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 66,
      functions: 86,
      lines: 87,
    },
    // Per-module carve-outs (#562 acceptance): floors near current CI coverage
    // for the modules that keep global branches below the issue's ~75% estimate.
    './src/modules/auth/': {
      statements: 55,
      branches: 28,
      functions: 55,
      lines: 55,
    },
    './src/modules/rules/': {
      statements: 78,
      branches: 54,
      functions: 86,
      lines: 80,
    },
    './src/modules/ai-dm/': {
      statements: 78,
      branches: 60,
      functions: 70,
      lines: 80,
    },
    './src/modules/mcp/': {
      statements: 73,
      branches: 55,
      functions: 72,
      lines: 73,
    },
    './src/modules/scribe/': {
      statements: 78,
      branches: 48,
      // After #1207, scribe meters via AiDmService.meterTurn (coverage lands in
      // ai-dm/), so scribe/ function coverage sits ~54.5%. Floor tracks that.
      functions: 54,
      lines: 80,
    },
  },
};
