import { defineConfig } from '@playwright/test';

/**
 * Pure unit specs (no browser, no seeded backend). Used for map/coord helpers
 * and other Node-importable modules under e2e/tests/*.unit.spec.ts.
 */
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /.*\.unit\.spec\.(js|ts|mjs|mts)/,
  // Pure-data unit snapshots carry no OS-dependent font or rasterization rendering.
  // Using an explicit template without `{platform}` keeps snapshot files platform-agnostic.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  fullyParallel: true,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
});
