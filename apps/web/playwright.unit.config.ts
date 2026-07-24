import { defineConfig } from '@playwright/test';

/**
 * Pure unit specs (no browser, no seeded backend). Used for map/coord helpers
 * and other Node-importable modules under e2e/tests/*.unit.spec.ts.
 */
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /.*\.unit\.spec\.(js|ts|mjs|mts)/,
  fullyParallel: true,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
});
