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
  // Floor for CI `test:cov` (#562). Set slightly below observed suite levels
  // (~88% stmts / ~70% branches / ~89% funcs / ~90% lines) so regressions fail
  // the coverage job without flaking on normal variance. Branches sit just under
  // 70% today (auth/OIDC + gemini provider drag the average).
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 68,
      functions: 80,
      lines: 85,
    },
  },
};
