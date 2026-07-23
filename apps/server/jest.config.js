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
  // could land silently forever. Set a few points below the observed full-suite
  // levels (~89% stmts / ~68% branches / ~89% funcs / ~90.5% lines) so normal
  // variance across CI runs doesn't flake the job, but a real drop still fails
  // it. Branches run lowest (importer error paths, OAuth/OIDC edge cases, and
  // provider-specific branches are the main drag).
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 64,
      functions: 84,
      lines: 87,
    },
  },
};
