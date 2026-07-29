import { defineConfig, devices } from '@playwright/test';

/**
 * Campfire web E2E (issue #81).
 *
 * Runs a small, high-signal suite of cross-role browser checks against the REAL
 * server serving the REAL built SPA on one origin (see e2e/server.mjs). Auth is
 * real cookie sessions with real campaign memberships; global-setup.ts seeds the
 * backend once and captures a storageState per role (admin/dm/player/viewer).
 *
 * Determinism over breadth: a single shared seeded backend means the suite runs
 * serially (workers: 1, no fullyParallel) so seeded state never races between
 * tests. Selectors are stable text/role/aria — no brittle CSS-class matching.
 */
const PORT = Number(process.env.CAMPFIRE_E2E_PORT || 8123);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e/tests',
  // Include `.mts` so ESM-only unit specs (import.meta.url) are discovered.
  testMatch: /.*(test|spec)\.(js|ts|mjs|mts)/,
  // Unit-only specs run via playwright.unit.config.ts — `npm run test:unit -w apps/web`,
  // CI job `unit-web` — so keep them out of the browser suite. Issue #1453: a second,
  // near-identical config (`pw-unit.config.ts`) sat alongside this one, referenced by
  // no script and no workflow, while ~185 `.unit.spec.ts` files accumulated behind it
  // without ever being executed. It has been deleted; `scripts/check-e2e-spec-coverage.mjs`
  // (wired into `npm run test:all`) now fails CI if a spec file is ever picked up by zero
  // or by more than one config under e2e/tests, so that trap cannot reopen unnoticed.
  testIgnore: /.*\.unit\.spec\.m?ts/,
  // One seeded backend shared by every spec — keep it serial and deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  // Print visual baselines are shared across host OSes; assertions carry a
  // small font-rasterization tolerance just like the first-run visual suite.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  timeout: 30_000,
  expect: { timeout: 10_000 },

  // Seeds the backend and writes e2e/.auth/*.json storage states + seed.json.
  globalSetup: './e2e/global-setup.ts',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // Plain http on localhost; the server drops HSTS/upgrade-insecure-requests
    // via ALLOW_INSECURE_HTTP so assets and cookies work over http.
    ignoreHTTPSErrors: true,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'node e2e/server.mjs',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { CAMPFIRE_E2E_PORT: String(PORT) },
  },
});
