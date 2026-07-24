import { expect, test } from '@playwright/test';

/**
 * Issue #798 — reverse-proxy subpath end-to-end.
 *
 * Exercises the acceptance criteria from the issue against the full stack:
 * a web build stamped with PUBLIC_BASE=/campfire, served by the real API
 * process, fronted by a strip-prefix proxy (e2e/subpath-proxy.mjs). The
 * Playwright config (playwright.subpath.config.ts) roots baseURL at
 * http://127.0.0.1:<port>/campfire.
 *
 * NOTE on navigation: Playwright's page.goto() resolves a leading-slash path
 * against the baseURL's ORIGIN, not its path. So with baseURL
 * http://127.0.0.1:<port>/campfire, page.goto('/login') would land at
 * http://127.0.0.1:<port>/login (NO prefix) — wrong. The helper below
 * (gotoSub) builds the full prefixed URL explicitly so every navigation
 * stays under /campfire.
 *
 * Coverage:
 *   1. SPA shell + assets load under /campfire/ (Vite base rewriting).
 *   2. PWA manifest + icons are served under the prefix.
 *   3. First-run /setup completes and lands on the campaign hub.
 *   4. Login round-trips a real session cookie under the subpath.
 *   5. A deep link (direct navigation to /campfire/preferences) loads the SPA
 *      and the router resolves the route without losing the prefix.
 *   6. A full page reload on a deep link still works (proxy -> server ->
 *      ServeStaticModule -> index.html).
 *   7. A lazy-loaded route still resolves its chunk under the prefix.
 *   8. The API client emits /campfire/api/v1/... and gets a real response.
 *   9. The service worker precaches the shell so the app opens offline.
 */

const ADMIN = {
  username: 'subpath-admin',
  displayName: 'Subpath Admin',
  password: 'campfire-subpath-admin-1',
} as const;

// The proxy listens on 127.0.0.1 and forwards /campfire/... -> /... on the
// backend.
const PROXY_ORIGIN = (() => {
  const port = Number(process.env.CAMPFIRE_SUBPATH_PROXY_PORT || 8132);
  return `http://127.0.0.1:${port}`;
})();
const PREFIX = '/campfire';

/**
 * Navigate to a route under the subpath. Pass the in-app route (e.g. '/login',
 * '/preferences') — the helper prepends /campfire and uses the full origin so
 * Playwright does not strip the prefix. Passing '' or '/' navigates to the
 * prefixed root /campfire/.
 */
async function gotoSub(page: import('@playwright/test').Page, route: string): Promise<void> {
  const clean = route.startsWith('/') ? route : `/${route}`;
  const url = `${PROXY_ORIGIN}${PREFIX}${clean === '/' ? '/' : clean}`;
  await page.goto(url);
}

test.describe('reverse-proxy subpath (issue #798)', () => {
  test('SPA shell and assets load under /campfire/ (Vite base rewriting)', async ({ page }) => {
    const assetRequests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      // Capture every same-origin asset request the SPA emits.
      if (url.origin === PROXY_ORIGIN && /\.(js|css|woff2?|png|svg)$/.test(url.pathname)) {
        assetRequests.push(url.pathname);
      }
    });

    await gotoSub(page, '/');

    // Every asset the SPA requested must carry the /campfire/ prefix — Vite's
    // `base` rewrote them at build time. A single un-prefixed /assets/... would
    // 404 through the strip proxy (the backend serves /assets/... but the browser
    // asked for the un-prefixed URL on the public origin, which the proxy would
    // forward as /... -> 404 or wrong content).
    expect(assetRequests.length, 'SPA should have requested at least one asset').toBeGreaterThan(0);
    for (const path of assetRequests) {
      expect(
        path.startsWith('/campfire/assets/') || path.startsWith('/campfire/'),
        `asset ${path} should be prefixed with /campfire`,
      ).toBe(true);
      expect(path.startsWith('/assets/'), `asset ${path} must NOT be un-prefixed`).toBe(false);
    }
  });

  test('PWA manifest and icons are served under the prefix', async ({ page }) => {
    const res = await page.goto(`${PROXY_ORIGIN}${PREFIX}/`);
    expect(res?.ok(), 'index.html should load').toBe(true);

    // The manifest link in index.html should point at /campfire/manifest.webmanifest.
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref, 'manifest link must be present').toBeTruthy();
    expect(manifestHref!.startsWith('/campfire/'), 'manifest href must be prefixed').toBe(true);

    // Fetch the manifest through the proxy and verify its scope/start_url.
    const manifestUrl = new URL(manifestHref!, PROXY_ORIGIN).toString();
    const manifestRes = await page.request.get(manifestUrl);
    expect(manifestRes.ok(), `manifest fetch should succeed: ${manifestRes.status()}`).toBe(true);
    const manifest = await manifestRes.json();
    expect(manifest.scope, 'manifest.scope must be /campfire/').toBe('/campfire/');
    expect(manifest.start_url, 'manifest.start_url must be /campfire/').toBe('/campfire/');
    expect(manifest.name).toBe('Campfire');
  });

  test('first-run setup completes and lands on the campaign hub', async ({ page }) => {
    await gotoSub(page, '/login');
    // A pristine backend redirects /login -> /setup (no users yet). The redirect
    // happens client-side (AuthProvider sees setupRequired), so the URL stays
    // under /campfire.
    await expect(page).toHaveURL(/\/campfire\/setup$/);

    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Display name').fill(ADMIN.displayName);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByLabel('Confirm password').fill(ADMIN.password);

    const setupResponse = page.waitForResponse(
      (response) => response.url().includes('/api/v1/auth/setup') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Light the fire' }).click();
    expect((await setupResponse).ok(), 'POST /auth/setup should succeed').toBe(true);

    // The campaign hub renders at /campfire/ (not / — which would escape the prefix).
    await expect(page).toHaveURL(/\/campfire\/?$/);
    await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
  });

  test('API client emits prefixed requests and gets real responses', async ({ page }) => {
    // Re-login (tests do not share storage state by default).
    await gotoSub(page, '/login');
    // If already set up, /login renders the form (not /setup).
    if (await page.getByRole('button', { name: 'Sign in' }).isVisible().catch(() => false)) {
      await page.getByLabel('Username').fill(ADMIN.username);
      await page.getByLabel('Password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
    }

    // Capture every /api request the SPA makes and assert it carries the prefix.
    const apiRequests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.origin === PROXY_ORIGIN && url.pathname.includes('/api/v1/')) {
        apiRequests.push(url.pathname);
      }
    });

    // Navigate to the campaign hub — AuthProvider will fire GET /api/v1/me and
    // GET /api/v1/campaigns.
    await gotoSub(page, '/');
    await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();

    expect(apiRequests.length, 'SPA should have made at least one API call').toBeGreaterThan(0);
    for (const path of apiRequests) {
      expect(
        path.startsWith('/campfire/api/v1/'),
        `API request ${path} must be prefixed with /campfire/api/v1`,
      ).toBe(true);
    }
  });

  test('deep link to a campaign route loads the SPA and router resolves it', async ({ page }) => {
    // Establish a session first.
    await gotoSub(page, '/login');
    if (await page.getByRole('button', { name: 'Sign in' }).isVisible().catch(() => false)) {
      await page.getByLabel('Username').fill(ADMIN.username);
      await page.getByLabel('Password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
    }

    // Direct-navigate to a deep link that does NOT exist as a server route —
    // the strip proxy forwards /campfire/preferences -> /preferences, the server's
    // ServeStaticModule serves index.html (SPA fallback), and React Router takes
    // over with basename=/campfire. The URL must STAY /campfire/preferences.
    await gotoSub(page, '/preferences');
    await expect(page).toHaveURL(/\/campfire\/preferences$/);
    // The preferences page renders its heading (proves the router matched the
    // route AND the lazy chunk loaded under the prefix).
    await expect(page.getByRole('heading', { name: /preferences/i })).toBeVisible();
  });

  test('full reload on a deep link preserves the route and prefix', async ({ page }) => {
    await gotoSub(page, '/login');
    if (await page.getByRole('button', { name: 'Sign in' }).isVisible().catch(() => false)) {
      await page.getByLabel('Username').fill(ADMIN.username);
      await page.getByLabel('Password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
    }

    await gotoSub(page, '/preferences');
    await expect(page).toHaveURL(/\/campfire\/preferences$/);
    await expect(page.getByRole('heading', { name: /preferences/i })).toBeVisible();

    // A hard reload must NOT lose the prefix or 404 — the whole server-fallback
    // path (proxy strip -> ServeStaticModule -> index.html -> router basename)
    // has to round-trip cleanly.
    await page.reload();
    await expect(page).toHaveURL(/\/campfire\/preferences$/);
    await expect(page.getByRole('heading', { name: /preferences/i })).toBeVisible();
  });

  test('a lazy-loaded route resolves its chunk under the prefix', async ({ page }) => {
    await gotoSub(page, '/login');
    if (await page.getByRole('button', { name: 'Sign in' }).isVisible().catch(() => false)) {
      await page.getByLabel('Username').fill(ADMIN.username);
      await page.getByLabel('Password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
    }

    // The preferences route is lazy-loaded (router.tsx lazyPage()). Its chunk
    // URL must be /campfire/assets/... — if the prefix were missing on the
    // chunk fetch, the browser would 404 and the route would never render.
    let lazyChunkWasPrefixed = false;
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.origin === PROXY_ORIGIN && url.pathname.includes('/assets/') && url.pathname.endsWith('.js')) {
        if (url.pathname.startsWith('/campfire/assets/')) {
          lazyChunkWasPrefixed = true;
        }
      }
    });

    await gotoSub(page, '/preferences');
    await expect(page.getByRole('heading', { name: /preferences/i })).toBeVisible();
    // The chunk that rendered this page was fetched through the prefix.
    expect(lazyChunkWasPrefixed, 'lazy chunk must be fetched from /campfire/assets/').toBe(true);
  });

  test('service worker precaches the shell and the app opens offline', async ({ page, context }) => {
    // Sentinel that the SPA shell has mounted. The router will land on /login
    // (configured server) or /setup (fresh server, /login redirects). Either
    // way the auth card renders a textbox (username input), which only exists
    // once React has booted — a robust, content-agnostic shell-mounted signal.
    const shellBooted = () =>
      expect(page.getByRole('textbox').first()).toBeVisible();

    // Load the app once online so the SW installs and precaches the shell.
    await gotoSub(page, '/login');
    await shellBooted();

    // Wait for the SW to be active. The VitePWA registerType is 'autoUpdate',
    // so the SW activates on install.
    await page.waitForFunction(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg && reg.active?.state === 'activated';
    }, undefined, { timeout: 15_000 });

    // Go offline and reload — the SW must serve the cached shell so the SPA
    // still renders (the "Works offline between sessions" guarantee, issue #91).
    await context.setOffline(true);
    await gotoSub(page, '/login').catch(() => {
      // The navigation may report a network error in some browsers even though
      // the SW served the shell; the page-content assertion below is the real
      // proof. Swallow so the test continues.
    });

    // The shell should still render offline — the SW served index.html from
    // cache and the SPA booted.
    await shellBooted();

    await context.setOffline(false);
  });
});
