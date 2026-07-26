/**
 * PWA install + offline shell, exercised in a REAL browser (issue #569).
 *
 * What was missing: every PWA guarantee we ship was checked either statically
 * or in isolation. `scripts/check-pwa-dist.mjs` (run in CI as `test:pwa:dist`)
 * reads the built `dist/` off disk and asserts the manifest, `sw.js` and the
 * icon files exist with the right contents — a FILE contract. The
 * `pwa-*.unit.spec.ts` siblings pin the pure state models (`pwaUpdate`,
 * `pwaCachePolicy`, `installHintState`) with no browser at all. Between the two
 * there was no test that a browser actually REGISTERS the worker we ship,
 * actually precaches the shell, actually renders that shell with the network
 * pulled, or actually offers the install CTA — which is exactly the journey a
 * tablet user installing Campfire walks.
 *
 * Why this is an e2e spec and not a unit spec: service workers only exist in a
 * secure context with a real HTTP origin, and precaching + navigation fallback
 * are behaviours of Chromium's SW runtime, not of our source. The primary
 * Playwright project already serves the REAL built SPA (`apps/web/dist`) from
 * the REAL server on one origin (see `e2e/server.mjs`), and `127.0.0.1` is a
 * secure context, so registration behaves exactly as it does for a self-hosted
 * deployment. Nothing smaller reproduces that.
 *
 * What each case guards:
 *  - registration — `src/main.tsx` calls `initPwaRegistration()`, which
 *    dynamically imports `virtual:pwa-register` and calls `registerSW` (see
 *    `src/lib/pwaUpdate.ts`). That indirection has silent failure modes: the
 *    import is wrapped in a catch that swallows "module missing" errors, and
 *    `onRegisterError` deliberately returns early on localhost. A build that
 *    stopped emitting the virtual module, or a `vite.config.ts` change that
 *    broke `sw.js`, would leave every user permanently un-installable and every
 *    existing test green.
 *  - manifest installability — the static check reads the file; this reads what
 *    the SERVER hands the browser, following the `<link rel="manifest">` the
 *    document actually ships and fetching every declared icon. It catches
 *    serving-layer regressions the file check cannot see (a bad content type, a
 *    `PUBLIC_BASE`/`scope` mismatch, an icon present in the manifest but 404ing
 *    through ServeStatic).
 *  - offline shell — the whole point of the "Works offline between sessions"
 *    install promise. Asserts the precache really satisfies a cold navigation
 *    with the network cut, and that we land on the authed shell plus the #579
 *    "Offline — showing last-known data" banner rather than Chromium's network
 *    error page.
 *  - install banner — the #799 chain (`main.tsx` capture →
 *    `deferredInstallPrompt` module scope → `InstallHintBanner` CTA) only ever
 *    ran against a fake window. This drives it with a real dispatched
 *    `beforeinstallprompt` event in a real narrow viewport.
 *
 * Suite hygiene: the primary project runs `workers: 1` / `fullyParallel: false`
 * against ONE shared seeded backend, so these tests only ever READ seeded data
 * (they navigate the campaign hub and dashboard; they create/modify nothing).
 * Each case owns an explicit BrowserContext so the service worker registration,
 * its Cache Storage and the `setOffline` flag are all scoped to that context and
 * die with it — `setOffline` is a per-context switch, so it can never leak into
 * a neighbouring spec. Offline is additionally restored in `finally` so a failing
 * assertion cannot strand the context offline before teardown.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * `navigator.serviceWorker.ready` has no built-in timeout — if registration
 * never happens it hangs until the whole test times out with no useful message.
 * Race it against an explicit deadline so a registration regression reports as
 * "the worker never activated" instead of a bare test timeout.
 */
const SW_ACTIVATION_TIMEOUT_MS = 20_000;

interface ActiveWorkerInfo {
  scope: string;
  scriptURL: string | null;
  state: string | null;
  /** Cache Storage keys present once the worker has activated. */
  cacheKeys: string[];
}

/**
 * Waits (in-page) for the registration the app itself created to reach an
 * ACTIVATED worker. Activation only happens after the install event resolves,
 * and Workbox populates the precache inside install — so this resolving is also
 * the signal that the shell is precached.
 *
 * `navigator.serviceWorker.ready` resolves as soon as a registration has an
 * `active` worker, which can still be in the `activating` state; waiting for
 * `statechange` past that is what makes the offline assertions deterministic
 * instead of racing the very first run's activation.
 */
async function waitForActiveWorker(page: Page): Promise<ActiveWorkerInfo> {
  return await page.evaluate(async (timeoutMs: number) => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('navigator.serviceWorker is unavailable — not a secure context?');
    }
    let timer = 0;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`no active service worker after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const activated = (async () => {
      const registration = await navigator.serviceWorker.ready;
      const worker = registration.active;
      if (worker && worker.state !== 'activated') {
        await new Promise<void>((resolve) => {
          const onChange = () => {
            if (worker.state === 'activated' || worker.state === 'redundant') {
              worker.removeEventListener('statechange', onChange);
              resolve();
            }
          };
          worker.addEventListener('statechange', onChange);
          onChange();
        });
      }
      return registration;
    })();
    try {
      const registration = await Promise.race([activated, deadline]);
      return {
        scope: registration.scope,
        scriptURL: registration.active?.scriptURL ?? null,
        state: registration.active?.state ?? null,
        cacheKeys: await caches.keys(),
      };
    } finally {
      window.clearTimeout(timer);
    }
  }, SW_ACTIVATION_TIMEOUT_MS);
}

/**
 * Cuts the context off from the network for real.
 *
 * `context.setOffline(true)` alone is NOT enough here and silently produces a
 * false pass: it only emulates offline for page-originated requests, so once a
 * service worker controls the page every request it makes on the page's behalf
 * still reaches the server (verified: `/api/v1/me` kept returning 200 with
 * `response.fromServiceWorker() === true`, the identity never went stale, and
 * the "offline" shell was really being served live). Aborting at the context
 * route level reaches worker-originated requests too, which is what makes the
 * precache the only thing left that can answer. `setOffline` is kept as well so
 * `navigator.onLine` matches what the app would see on a real disconnected
 * device.
 */
async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
  await context.route(OFFLINE_ROUTE, abortOffline);
}

async function goOnline(context: BrowserContext): Promise<void> {
  await context.unroute(OFFLINE_ROUTE, abortOffline);
  await context.setOffline(false);
}

const OFFLINE_ROUTE = '**/*';
const abortOffline = (route: import('@playwright/test').Route) => route.abort('internetdisconnected');

/**
 * Opens a signed-in context; the caller owns closing it. The viewer is the
 * least-privileged seeded role and this spec never writes, so the shared seeded
 * backend cannot be disturbed.
 */
async function viewerContext(
  browser: Browser,
  extra: { viewport?: { width: number; height: number } } = {},
): Promise<BrowserContext> {
  return await browser.newContext({ storageState: stateFor('viewer'), ...extra });
}

test.describe('PWA install + offline shell (#569)', () => {
  test('the app registers the built service worker and precaches the shell', async ({ browser, baseURL }) => {
    const context = await viewerContext(browser);
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();

      const worker = await waitForActiveWorker(page);

      // Registration comes from initPwaRegistration() -> registerSW(); it must
      // point at the Workbox-generated worker at the origin root, not at some
      // stale/dev script, and it must control the whole app scope.
      expect(worker.state).toBe('activated');
      expect(worker.scriptURL).toBe(`${baseURL}/sw.js`);
      expect(worker.scope).toBe(`${baseURL}/`);

      // Activation implies the install event (and therefore Workbox precaching)
      // completed. Prove the precache bucket really exists rather than trusting
      // activation alone.
      expect(worker.cacheKeys.some((key) => key.includes('workbox-precache'))).toBe(true);

      // The shell document itself must be in the precache — that entry is what
      // navigateFallback serves when the network is gone.
      const shellPrecached = await page.evaluate(async () => {
        for (const key of await caches.keys()) {
          if (!key.includes('workbox-precache')) continue;
          const cache = await caches.open(key);
          const requests = await cache.keys();
          if (requests.some((request) => new URL(request.url).pathname === '/index.html')) return true;
        }
        return false;
      });
      expect(shellPrecached).toBe(true);

      // A second navigation must be handled BY the worker — otherwise the
      // registration exists but never intercepts, and offline would still fail.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
        .toBe(`${baseURL}/sw.js`);
    } finally {
      await context.close();
    }
  });

  test('the served manifest carries everything a browser needs to offer install', async ({ browser }) => {
    const context = await viewerContext(browser);
    try {
      const page = await context.newPage();
      await page.goto('/');

      // Follow the link the document actually ships rather than hard-coding the
      // path, so a PUBLIC_BASE/base regression surfaces here too.
      const manifestHref = await page.locator('link[rel="manifest"]').first().getAttribute('href');
      expect(manifestHref, 'index.html must link a web app manifest').toBeTruthy();

      const manifestUrl = new URL(manifestHref!, page.url()).toString();
      const manifestResponse = await context.request.get(manifestUrl);
      expect(manifestResponse.status()).toBe(200);
      // Chromium refuses to parse a manifest served as text/html.
      expect(manifestResponse.headers()['content-type'] ?? '').toMatch(/json/);

      const manifest = JSON.parse(await manifestResponse.text()) as {
        name?: string;
        short_name?: string;
        start_url?: string;
        scope?: string;
        display?: string;
        icons?: { src?: string; sizes?: string; type?: string; purpose?: string }[];
      };

      // The fields Chromium requires before it will fire beforeinstallprompt.
      expect(manifest.name).toBe('Campfire');
      expect(manifest.short_name).toBeTruthy();
      expect(manifest.display).toBe('standalone');
      expect(manifest.icons?.length ?? 0).toBeGreaterThanOrEqual(2);

      // start_url and scope must resolve inside the origin AND under the scope
      // the worker actually claimed, or the install would control the wrong
      // routes (or fail outright).
      const scopeUrl = new URL(manifest.scope ?? './', manifestUrl);
      const startUrl = new URL(manifest.start_url ?? './', manifestUrl);
      expect(startUrl.origin).toBe(new URL(page.url()).origin);
      expect(startUrl.pathname.startsWith(scopeUrl.pathname)).toBe(true);
      expect(scopeUrl.toString()).toBe((await waitForActiveWorker(page)).scope);

      // Chromium needs a >=192px icon to offer install and a >=512px icon for
      // the splash screen; a maskable entry keeps the Android launcher icon
      // from being letterboxed.
      const sizesOf = (icon: { sizes?: string }) => (icon.sizes ?? '').split(/\s+/);
      expect(manifest.icons?.some((icon) => sizesOf(icon).includes('192x192'))).toBe(true);
      expect(manifest.icons?.some((icon) => sizesOf(icon).includes('512x512'))).toBe(true);
      expect(manifest.icons?.some((icon) => (icon.purpose ?? '').split(/\s+/).includes('maskable'))).toBe(
        true,
      );

      // Every declared icon must actually be served as an image — the static
      // dist check only proves the files exist next to the manifest.
      for (const icon of manifest.icons ?? []) {
        expect(icon.src, 'every manifest icon needs a src').toBeTruthy();
        const iconUrl = new URL(icon.src!, manifestUrl).toString();
        const iconResponse = await context.request.get(iconUrl);
        expect(iconResponse.status(), `icon ${icon.src} should be served`).toBe(200);
        expect(iconResponse.headers()['content-type'] ?? '', `icon ${icon.src} content type`).toMatch(
          /^image\//,
        );
      }
    } finally {
      await context.close();
    }
  });

  test('the app shell still renders after the network is cut', async ({ browser }) => {
    const context = await viewerContext(browser);
    try {
      const page = await context.newPage();
      await page.goto('/');
      // A live /me is what persists the offline identity snapshot (#579); the
      // authed hub being visible proves it landed before we go offline.
      await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
      await waitForActiveWorker(page);

      try {
        // Per-context switches only: neither the offline flag nor the abort
        // route can leak into the other specs sharing the seeded server.
        await goOffline(context);
        const reloaded = await page.reload();
        // The document itself came out of the worker, not the wire — without
        // this the assertions below could pass on a live network.
        expect(reloaded?.fromServiceWorker()).toBe(true);

        // Served entirely from the precache: the shell renders and the SPA
        // boots far enough to run the router and the auth provider.
        await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
        // #579's honest-staleness banner: /me failed against the network (it is
        // deliberately NOT runtime-cached), so we show the last-known identity
        // and say so, rather than bouncing to /login or wiping the cache.
        await expect(page.getByText('Offline — showing last-known data.')).toBeVisible();
        // Chromium's own error page has no app markup at all — assert the
        // document really is ours.
        await expect(page.locator('#root')).not.toBeEmpty();

        // A cold navigation to a DIFFERENT path must also survive: only the SW
        // navigation fallback (never the server) can answer it now, and the
        // route's lazy chunk has to come out of the precache too.
        await page.goto('/preferences');
        await expect(page.locator('#root')).not.toBeEmpty();
        await expect(page.getByText('Offline — showing last-known data.')).toBeVisible();
      } finally {
        await goOnline(context);
      }
    } finally {
      await context.close();
    }
  });

  test('the install hint offers manual guidance on an install-relevant viewport', async ({ browser }) => {
    // The banner is mobile-first (`installHintState.MOBILE_QUERY`,
    // max-width: 768px) — the tablet/phone install journey from the issue.
    const context = await viewerContext(browser, { viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto(`/c/${seed().campaignId}`);

      // Chromium never fires beforeinstallprompt for an automation profile, so a
      // plain load is the manual-guidance path: guidance copy, no native CTA.
      const banner = page.getByRole('region', { name: 'Install Campfire on this device' });
      await expect(banner).toHaveAttribute('data-has-native-prompt', 'false');
      await expect(banner.getByText('Works offline between sessions.', { exact: false })).toBeVisible();
      await expect(banner.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);

      // Dismissal is the user's escape hatch — it must actually remove the hint
      // rather than merely styling it away. (Persistence across reloads is
      // pinned by installHintState's unit spec; this owns the rendered wiring.)
      await banner.getByRole('button', { name: 'Dismiss' }).click();
      await expect(banner).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a beforeinstallprompt fired before the dashboard mounts still surfaces the install CTA', async ({
    browser,
  }) => {
    const context = await viewerContext(browser, { viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();

      // Chromium fires beforeinstallprompt at most once per document load, and
      // it can land long before InstallHintBanner mounts — which is exactly why
      // main.tsx calls ensureDeferredInstallPromptCapture() at boot (#799).
      // Firing on `load` reproduces that ordering: the app's entry module has
      // evaluated, React has not necessarily rendered the dashboard yet. If the
      // capture regresses to being banner-mount-only, the event is dropped and
      // the CTA below never appears.
      await page.addInitScript(() => {
        const win = window as unknown as { __installPromptCalls?: number };
        win.__installPromptCalls = 0;
        window.addEventListener('load', () => {
          window.dispatchEvent(
            Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
              prompt: () => {
                win.__installPromptCalls = (win.__installPromptCalls ?? 0) + 1;
                return Promise.resolve();
              },
              userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
            }),
          );
        });
      });
      await page.goto(`/c/${seed().campaignId}`);

      const banner = page.getByRole('region', { name: 'Install Campfire on this device' });
      const installButton = banner.getByRole('button', { name: 'Install', exact: true });
      // The native path, not the "Browser menu → Add to Home Screen" fallback
      // (which renders the same region with data-has-native-prompt="false").
      await expect(banner).toHaveAttribute('data-has-native-prompt', 'true');
      await expect(banner.getByText('Install for offline access between sessions.')).toBeVisible();

      // The CTA must invoke the deferred prompt the browser handed us, and the
      // consumed one-shot event must not be offered a second time.
      await installButton.click();
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { __installPromptCalls?: number }).__installPromptCalls ?? 0),
        )
        .toBe(1);
      await expect(installButton).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
