import { defineConfig, devices } from '@playwright/test';

/**
 * First-run auth journey against its own pristine database (issue #416).
 *
 * The primary Playwright config seeds its backend in globalSetup, so it cannot
 * exercise the browser-owned /setup flow. This small, separate project starts
 * the same production-shaped server on another port without a global seed.
 */
const PORT = Number(process.env.CAMPFIRE_FIRST_RUN_E2E_PORT || 8124);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e/first-run',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
  },

  projects: [
    { name: 'first-run-chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'node e2e/server.mjs',
    url: `${BASE_URL}/healthz`,
    // Reusing an existing server would make the database non-pristine and turn
    // this regression test into a false pass, so this project always owns port.
    reuseExistingServer: false,
    timeout: 60_000,
    env: { CAMPFIRE_E2E_PORT: String(PORT) },
  },
});
