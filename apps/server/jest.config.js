/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // GitHub Actions overrides this per shard so transform work survives between
  // runs without concurrent matrix jobs racing to save the same cache.
  cacheDirectory: process.env.JEST_CACHE_DIR || '<rootDir>/.cache/jest/server',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  // Two test layers share this config:
  //  - `*.e2e-spec.ts` (test/)         — full-app HTTP suites, bootstrap a Nest app + SQLite
  //  - `*.spec.ts`     (test/unit/…)   — fast, isolated unit tests for pure logic, no bootstrap
  // `.spec.ts` deliberately does NOT match `.e2e-spec.ts` (the char before `spec`
  // is `-`, not `.`), so the two patterns never double-count a file.
  testRegex: ['.*\\.e2e-spec\\.ts$', '.*\\.spec\\.ts$'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@campfire/schema$': '<rootDir>/../../packages/schema/src/index.ts',
  },
  testTimeout: 30000,
  // `scripts/with-test-lock.sh` lowers this for local runs, where several agent
  // sessions share one machine and 50% of the cores each is not 50% of the
  // machine. Unset (CI, a plain `npx jest`) keeps the original sizing.
  maxWorkers: process.env.JEST_MAX_WORKERS || '50%',
  // The integration-heavy suite creates a fresh Nest application and SQLite
  // database for many files. Recycle Jest workers between files once memory
  // grows past this bound instead of letting retained module state accumulate
  // until the runner's Node heap is exhausted.
  workerIdleMemoryLimit: '1024MB',
};
