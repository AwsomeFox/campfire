import { defineConfig } from '@playwright/test';
// Minimal config for pure unit specs (.unit.spec.ts) that import from src/ —
// no server, no browser, no globalSetup. Used to exercise the pure state models
// (savedRollsState, undoSnackbarState, imageUploadState, …) in isolation.
export default defineConfig({
  testDir: './e2e/tests',
  // `.mts` allows native `import.meta.url` (Playwright's CJS transform does not).
  testMatch: /.*\.unit\.spec\.m?ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
});
