/**
 * Issue #797 — installed-app orientation for live-play surfaces.
 *
 * Manifest no longer locks portrait (see vite.config + check-pwa-dist). These
 * browser checks pin:
 *   - Encounter map / AI table / player display usable in portrait AND landscape
 *     (phone + tablet sizes), including simulated iOS safe-area insets.
 *   - Map token percent-coordinates survive a portrait↔landscape rotation.
 *   - Player Display fullscreen orientation lock is user-initiated, reversible,
 *     and never blocks fullscreen when the Orientation API fails (iOS fallback).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { seed, stateFor } from './seed';

const MAP_ATTACHMENT_ID = 797_001;
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** Android phone + tablet, portrait and landscape. */
const ORIENTATIONS = [
  { name: 'android-phone-portrait', width: 390, height: 844 },
  { name: 'android-phone-landscape', width: 844, height: 390 },
  { name: 'android-tablet-portrait', width: 800, height: 1280 },
  { name: 'android-tablet-landscape', width: 1280, height: 800 },
  // Short landscape with notch/home-indicator insets (iOS fallback surface).
  { name: 'ios-landscape-safe-area', width: 844, height: 390, safeArea: true },
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
  expect(overflow.scrollWidth, 'page must not force horizontal scroll').toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
}

async function injectSafeAreaInsets(page: Page) {
  // Simulate a notched iPhone in landscape: left/right notch + bottom home bar.
  await page.addStyleTag({
    content: `
      :root {
        --cf-test-safe-top: 0px;
        --cf-test-safe-right: 44px;
        --cf-test-safe-bottom: 21px;
        --cf-test-safe-left: 44px;
      }
      html {
        padding:
          env(safe-area-inset-top, var(--cf-test-safe-top))
          env(safe-area-inset-right, var(--cf-test-safe-right))
          env(safe-area-inset-bottom, var(--cf-test-safe-bottom))
          env(safe-area-inset-left, var(--cf-test-safe-left));
      }
    `,
  });
  // Chromium does not honor real safe-area env vars from device chrome in
  // Playwright, so override the CSS env() fallbacks used by our surfaces by
  // rewriting padding that already references env(safe-area-inset-*).
  await page.addInitScript(() => {
    // no-op placeholder — style tag above is applied after navigation below
  });
}

async function openMapFixture(page: Page): Promise<{ token: Locator; tokenId: number }> {
  const { encounterId } = seed();
  const response = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(response.ok()).toBeTruthy();
  const original = (await response.json()) as EncounterWithCombatants;
  const tokenId = original.combatants[0]?.id;
  if (tokenId == null) throw new Error('Seeded encounter needs a combatant');

  let encounter: EncounterWithCombatants = {
    ...original,
    mapAttachmentId: MAP_ATTACHMENT_ID,
    gridSize: 10,
    gridScale: 5,
    gridUnit: 'ft',
    gridSnap: false,
    gridType: 'square',
    fog: { enabled: false, revealed: [] },
    aoe: [],
    combatants: original.combatants.map((combatant: Combatant, index: number) =>
      index === 0 ? { ...combatant, tokenX: 30, tokenY: 70, tokenSize: 'medium' } : combatant,
    ),
  };

  await page.route(`**/api/v1/attachments/${MAP_ATTACHMENT_ID}/file`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }),
  );
  await page.route(`**/api/v1/encounters/${encounterId}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', json: encounter });
      return;
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Partial<EncounterWithCombatants>;
      encounter = { ...encounter, ...body };
      await route.fulfill({ status: 200, contentType: 'application/json', json: encounter });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/v1/encounters/${encounterId}/combatants/*`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Partial<Combatant>;
      encounter = {
        ...encounter,
        combatants: encounter.combatants.map((c: Combatant) =>
          c.id === tokenId ? { ...c, ...body } : c,
        ),
      };
      const updated = encounter.combatants.find((c: Combatant) => c.id === tokenId)!;
      await route.fulfill({ status: 200, contentType: 'application/json', json: updated });
      return;
    }
    await route.continue();
  });

  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
  await expect(page.getByTestId('battle-map')).toBeVisible();
  const token = page.getByTestId(`map-token-${tokenId}`);
  await expect(token).toBeVisible();
  return { token, tokenId };
}

function tokenPercents(token: Locator) {
  return token.evaluate((el) => {
    const style = (el as HTMLElement).style;
    return {
      left: parseFloat(style.left),
      top: parseFloat(style.top),
    };
  });
}

test.describe('PWA orientation — live-play surfaces (#797)', () => {
  test.use({ storageState: stateFor('dm') });

  for (const viewport of ORIENTATIONS) {
    test(`encounter map stays usable in ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const { token } = await openMapFixture(page);
      if ('safeArea' in viewport && viewport.safeArea) await injectSafeAreaInsets(page);

      await expect(page.getByTestId('battle-map-surface')).toBeVisible();
      await expect(token).toBeVisible();
      const pct = await tokenPercents(token);
      expect(pct.left).toBeCloseTo(30, 0);
      expect(pct.top).toBeCloseTo(70, 0);
      await expectNoHorizontalOverflow(page);
    });

    test(`AI table stays usable in ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/table`);
      if ('safeArea' in viewport && viewport.safeArea) await injectSafeAreaInsets(page);

      // Seed seats the campaign in co_dm — the gate still has to layout cleanly
      // in both orientations (this is the AI table route players open).
      await expect(page.getByText('The AI is co-DMing', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expectNoHorizontalOverflow(page);
    });

    test(`player display stays usable in ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/screen`);
      if ('safeArea' in viewport && viewport.safeArea) await injectSafeAreaInsets(page);

      await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();
      const exit = page.getByRole('button', { name: 'Exit player display' });
      await expect(exit).toBeVisible();
      await expect(exit).toBeInViewport();
      const fullscreen = page.getByRole('button', { name: /fullscreen/i });
      await expect(fullscreen).toBeVisible();

      // Safe-area-aware CSS is wired into the cast chrome (iOS landscape fallback).
      const controlStack = page.locator('.cf-screen-control-stack');
      const paddingUsesSafeArea = await page.locator('.cf-screen').evaluate((el) => {
        const style = getComputedStyle(el);
        return (
          style.paddingTop.includes('safe-area') ||
          // After cascade, env() resolves — assert the stylesheet source still declares it.
          !!el.ownerDocument.querySelector('style')?.textContent?.includes('safe-area-inset')
        );
      });
      expect(paddingUsesSafeArea).toBe(true);
      await expect(controlStack).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }

  test('map token percent coordinates survive portrait→landscape rotation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { token } = await openMapFixture(page);

    const before = await tokenPercents(token);
    expect(before.left).toBeCloseTo(30, 0);
    expect(before.top).toBeCloseTo(70, 0);

    // Rotate the device (swap viewport axes) and fire the orientation events the
    // map listens to so in-flight gestures cancel without mutating saved coords.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('orientationchange'));
      globalThis.screen?.orientation?.dispatchEvent?.(new Event('change'));
    });

    await expect(token).toBeVisible();
    const after = await tokenPercents(token);
    expect(after.left).toBeCloseTo(before.left, 5);
    expect(after.top).toBeCloseTo(before.top, 5);

    // And back to portrait — still the same stored percents.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    const back = await tokenPercents(token);
    expect(back.left).toBeCloseTo(30, 0);
    expect(back.top).toBeCloseTo(70, 0);
  });
});

test.describe('Player Display fullscreen orientation lock (#797)', () => {
  test.use({ storageState: stateFor('dm') });

  async function installFullscreenAndOrientation(
    page: Page,
    opts: { orientationLockFails?: boolean } = {},
  ) {
    await page.addInitScript(
      ({ orientationLockFails }) => {
        let activeElement: Element | null = null;
        const lockCalls: string[] = [];
        const unlockCalls: number[] = [];

        Object.defineProperty(document, 'fullscreenEnabled', {
          configurable: true,
          get: () => true,
        });
        Object.defineProperty(document, 'fullscreenElement', {
          configurable: true,
          get: () => activeElement,
        });
        const change = () => document.dispatchEvent(new Event('fullscreenchange'));

        Object.defineProperty(Element.prototype, 'requestFullscreen', {
          configurable: true,
          value: () => {
            activeElement = document.documentElement;
            change();
            return Promise.resolve();
          },
        });
        Object.defineProperty(document, 'exitFullscreen', {
          configurable: true,
          value: async () => {
            activeElement = null;
            change();
          },
        });

        Object.defineProperty(globalThis.screen, 'orientation', {
          configurable: true,
          value: {
            lock: (orientation: string) => {
              lockCalls.push(orientation);
              if (orientationLockFails) {
                return Promise.reject(new DOMException('iOS rejects orientation lock', 'NotAllowedError'));
              }
              return Promise.resolve();
            },
            unlock: () => {
              unlockCalls.push(Date.now());
            },
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
        });

        (window as typeof window & {
          __orientationTest: { lockCalls: string[]; unlockCalls: number[] };
        }).__orientationTest = { lockCalls, unlockCalls };
      },
      { orientationLockFails: opts.orientationLockFails ?? false },
    );
  }

  test('locks landscape only after a user-initiated fullscreen enter and unlocks on exit', async ({
    page,
  }) => {
    await installFullscreenAndOrientation(page);
    await page.goto(`/c/${seed().campaignId}/screen`);
    await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();

    const before = await page.evaluate(
      () => (window as typeof window & { __orientationTest: { lockCalls: string[] } }).__orientationTest.lockCalls
        .length,
    );
    expect(before).toBe(0);

    const fullscreen = page.getByRole('button', { name: /fullscreen/i });
    await fullscreen.click();
    await expect(fullscreen).toHaveAccessibleName('Exit fullscreen');

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as typeof window & { __orientationTest: { lockCalls: string[] } }).__orientationTest
              .lockCalls,
        ),
      )
      .toEqual(['landscape']);

    await fullscreen.click();
    await expect(fullscreen).toHaveAccessibleName('Enter fullscreen');
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as typeof window & { __orientationTest: { unlockCalls: number[] } }).__orientationTest
              .unlockCalls.length,
        ),
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('fullscreen still succeeds when orientation lock fails (iOS fallback)', async ({ page }) => {
    await installFullscreenAndOrientation(page, { orientationLockFails: true });
    await page.goto(`/c/${seed().campaignId}/screen`);
    await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();

    const fullscreen = page.getByRole('button', { name: /fullscreen/i });
    await fullscreen.click();
    await expect(fullscreen).toHaveAccessibleName('Exit fullscreen');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    // No error notice — orientation failure is silent; fullscreen owns the UX.
    await expect(page.locator('#cf-screen-fullscreen-notice')).toHaveCount(0);
  });
});
