import { defineConfig, devices } from '@playwright/test';

/**
 * Issue #798 — reverse-proxy subpath E2E.
 *
 * A dedicated project that builds the SPA with PUBLIC_BASE=/campfire, boots the
 * API+SPA behind a strip-prefix proxy (e2e/subpath-server.mjs ->
 * e2e/subpath-proxy.mjs), and exercises the acceptance criteria:
 *
 *   - PWA install assets are served under /campfire/
 *   - first-run /setup + login work under the subpath
 *   - a deep link (direct navigation to /campfire/<route>) loads the SPA and
 *     the router handles it without losing the prefix
 *   - a full reload on a deep link works (the strip proxy -> server ->
 *     ServeStaticModule -> index.html path)
 *   - a lazy-loaded route still chunks and resolves under the prefix
 *   - the API client emits /campfire/api/v1/... and gets a real response
 *   - the service worker precaches the shell and the app opens offline
 *
 * Separate from the main suite because it needs its OWN web build (stamped with
 * the prefix) and its own backend (serving that build) — it cannot share the
 * root-deployment server the rest of the suite runs against.
 *
 * Run with: npx playwright test --config playwright.subpath.config.ts
 */
const PROXY_PORT = Number(process.env.CAMPFIRE_SUBPATH_PROXY_PORT || 8132);
const BASE_URL = `http://127.0.0.1:${PROXY_PORT}/campfire`;

export default defineConfig({
  testDir: './e2e/subpath',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    // Every navigation is rooted at /campfire — the baseURL itself carries the
    // prefix so page.goto('/') resolves to http://127.0.0.1:<port>/campfire/.
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
  },

  projects: [
    { name: 'subpath-chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    // Boots the prefixed build + backend + strip-prefix proxy.
    command: 'node e2e/subpath-server.mjs',
    // The proxy forwards /campfire/healthz -> /healthz on the backend.
    url: `http://127.0.0.1:${PROXY_PORT}/campfire/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      CAMPFIRE_SUBPATH_PROXY_PORT: String(PROXY_PORT),
    },
  },
});
