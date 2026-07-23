import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

type FullscreenMockMode = 'supported' | 'unsupported' | 'denied' | 'request-error' | 'exit-error' | 'deferred';

async function installFullscreenMock(page: Page, mode: FullscreenMockMode = 'supported') {
  await page.addInitScript(
    ({ mockMode }) => {
      let activeElement: Element | null = null;
      const supported = mockMode !== 'unsupported';
      let resolveRequest: () => void = () => undefined;
      const deferredRequest = new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });

      Object.defineProperty(document, 'fullscreenEnabled', {
        configurable: true,
        get: () => supported,
      });
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => activeElement,
      });

      const change = () => document.dispatchEvent(new Event('fullscreenchange'));
      const fail = () => document.dispatchEvent(new Event('fullscreenerror'));

      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: supported
          ? () => {
              if (mockMode === 'denied') {
                fail();
                return Promise.reject(new DOMException('Permission denied by test browser', 'NotAllowedError'));
              }
              if (mockMode === 'request-error') {
                fail();
                return Promise.reject(new Error('Display hardware failure'));
              }
              activeElement = document.documentElement;
              change();
              return mockMode === 'deferred' ? deferredRequest : Promise.resolve();
            }
          : undefined,
      });
      Object.defineProperty(document, 'exitFullscreen', {
        configurable: true,
        value: supported
          ? async () => {
              if (mockMode === 'exit-error') {
                fail();
                throw new Error('Browser exit failure');
              }
              activeElement = null;
              change();
            }
          : undefined,
      });

      const exitExternally = () => {
        activeElement = null;
        change();
      };

      (window as typeof window & {
        __fullscreenTest: { exitExternally: () => void; dispatchError: () => void; resolveRequest: () => void };
      }).__fullscreenTest = {
        exitExternally,
        dispatchError: fail,
        resolveRequest,
      };
    },
    { mockMode: mode },
  );
}

async function openPlayerDisplay(page: Page, mode: FullscreenMockMode = 'supported') {
  await installFullscreenMock(page, mode);
  await page.goto(`/c/${seed().campaignId}/screen`);
  await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();
  return page.getByRole('button', { name: /fullscreen/i });
}

function fullscreenNotice(page: Page) {
  return page.locator('#cf-screen-fullscreen-notice');
}

function playerDisplayControls(page: Page) {
  return page.locator('.cf-screen-control-stack');
}

test.describe('Player Display fullscreen', () => {
  test.use({ storageState: stateFor('dm') });

  test('disables an unsupported action and gives an accessible fallback', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page, 'unsupported');

    await expect(fullscreen).toBeDisabled();
    await expect(fullscreen).toHaveAccessibleName('Enter fullscreen');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    await expect(fullscreen).toHaveAttribute('aria-busy', 'false');
    await expect(fullscreenNotice(page)).toHaveAttribute('role', 'status');
    await expect(fullscreenNotice(page)).toContainText(/isn't available.*cast controls.*share this window/i);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('handles a denied request and a fullscreenerror with recovery guidance', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page, 'denied');
    await fullscreen.click();

    await expect(fullscreen).toBeEnabled();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    await expect(fullscreenNotice(page)).toHaveAttribute('role', 'alert');
    await expect(fullscreenNotice(page)).toContainText(/blocked.*allow fullscreen.*tab active.*try again/i);

    await page.evaluate(() => {
      (window as typeof window & { __fullscreenTest: { dispatchError: () => void } }).__fullscreenTest.dispatchError();
    });
    // A late generic fullscreenerror event must not replace the more specific
    // permission-denied recovery guidance produced by the rejected request.
    await expect(fullscreenNotice(page)).toContainText(/blocked.*allow fullscreen.*tab active.*try again/i);
  });

  test('awaits entry and exit, supports keyboard activation, and reflects successful state', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page);

    await fullscreen.focus();
    await page.keyboard.press('Enter');
    await expect(fullscreen).toHaveAccessibleName('Exit fullscreen');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await expect(fullscreen).toHaveAttribute('aria-busy', 'false');

    await fullscreen.focus();
    await page.keyboard.press('Enter');
    await expect(fullscreen).toHaveAccessibleName('Enter fullscreen');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    await expect(fullscreenNotice(page)).toHaveAttribute('role', 'status');
    await expect(fullscreenNotice(page)).toContainText(/fullscreen ended.*enter fullscreen/i);
  });

  test('stays busy after fullscreenchange until the request promise settles', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page, 'deferred');

    // Dispatch synchronously so the test can observe the interval after the
    // fullscreenchange event but before the deliberately unresolved promise.
    await fullscreen.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await expect(fullscreen).toHaveAttribute('aria-busy', 'true');
    await expect(fullscreen).toBeDisabled();

    await page.evaluate(() => {
      (window as typeof window & { __fullscreenTest: { resolveRequest: () => void } }).__fullscreenTest.resolveRequest();
    });
    await expect(fullscreen).toHaveAttribute('aria-busy', 'false');
    await expect(fullscreen).toBeEnabled();
  });

  test('Escape exits browser fullscreen first, then exits the display route', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page);
    const { campaignId } = seed();

    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(`/c/${campaignId}/screen`);
    await expect(fullscreen).toHaveAccessibleName('Enter fullscreen');
    await expect(fullscreenNotice(page)).toContainText(/fullscreen ended/i);

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(`/c/${campaignId}`);
  });

  test('tracks external exits reported by fullscreenchange', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page);

    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => {
      (window as typeof window & { __fullscreenTest: { exitExternally: () => void } }).__fullscreenTest.exitExternally();
    });
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    await expect(fullscreen).toHaveAccessibleName('Enter fullscreen');
  });

  test('handles a request API error without lying about state', async ({ page }) => {
    const request = await openPlayerDisplay(page, 'request-error');
    await request.click();
    await expect(request).toHaveAttribute('aria-pressed', 'false');
    await expect(fullscreenNotice(page)).toContainText(/couldn't start.*display hardware failure.*try again/i);
  });

  test('keeps fullscreen active when the exit promise rejects', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page, 'exit-error');
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');

    await fullscreen.click();
    await expect(fullscreen).toHaveAccessibleName('Exit fullscreen');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await expect(fullscreenNotice(page)).toContainText(/couldn't exit.*press escape.*try the control again/i);
  });

  test('works from a touch-sized mobile viewport and remains axe-clean when active', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const fullscreen = await openPlayerDisplay(page);

    await fullscreen.tap();
    await expect(fullscreen).toHaveAccessibleName('Exit fullscreen');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await expect(fullscreen).toBeInViewport();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    await context.close();
  });
});

test.describe('Player Display controls', () => {
  test.use({ storageState: stateFor('dm') });

  test('renders an accessible exit while the display data is still loading', async ({ page }) => {
    const { campaignId } = seed();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });

    await installFullscreenMock(page);
    await page.route(`**/api/v1/campaigns/${campaignId}/summary`, async (route) => {
      await summaryGate;
      await route.continue();
    });
    await page.goto(`/c/${campaignId}/screen`);

    await expect(page.getByText('Loading display…')).toBeVisible();
    const exit = page.getByRole('button', { name: 'Exit player display' });
    await expect(exit).toBeVisible();
    await expect(exit).toBeInViewport();

    releaseSummary();
    await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();
  });

  test('auto-hides after inactivity and resets the timer for pointer and keyboard activity', async ({ page }) => {
    await page.clock.install();
    await openPlayerDisplay(page);
    const controls = playerDisplayControls(page);

    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await page.clock.fastForward(3_501);
    await expect(controls).toHaveCSS('pointer-events', 'none');

    await page.locator('main').dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
    });
    await expect(controls).toHaveCSS('pointer-events', 'auto');

    await page.clock.fastForward(3_000);
    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await page.locator('main').dispatchEvent('pointermove', {
      pointerId: 2,
      pointerType: 'pen',
      isPrimary: true,
    });
    // Move beyond the pointerdown timer's original deadline while leaving a
    // comfortable margin before the pointermove-reset deadline.
    await page.clock.fastForward(1_000);
    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await page.clock.fastForward(2_501);
    await expect(controls).toHaveCSS('pointer-events', 'none');

    await page.keyboard.press('Shift');
    await expect(controls).toHaveCSS('pointer-events', 'auto');

    await page.clock.fastForward(3_501);
    await expect(controls).toHaveCSS('pointer-events', 'none');
    await page.mouse.move(100, 100);
    await expect(controls).toHaveCSS('pointer-events', 'auto');
  });

  test('auto-hidden controls are inert until Tab reveals them; activation persists while focused', async ({
    page,
  }) => {
    // Issue #595 — opacity-only hide left Exit/Fullscreen tabbable while invisible.
    await page.clock.install();
    await openPlayerDisplay(page);
    const controls = playerDisplayControls(page);
    const exit = page.getByRole('button', { name: 'Exit player display' });
    const fullscreen = page.getByRole('button', { name: /fullscreen/i });
    const exitDom = controls.locator('button').first();

    await page.clock.fastForward(3_501);
    await expect(controls).toHaveCSS('pointer-events', 'none');
    await expect(controls).toHaveAttribute('inert', '');
    // Programmatic focus must not stick while the stack is inert.
    await exitDom.evaluate((button) => (button as HTMLButtonElement).focus());
    await expect(exitDom).not.toBeFocused();

    // Tab is the accessible keyboard reveal for the same keystroke.
    await page.keyboard.press('Tab');
    await expect(controls).not.toHaveAttribute('inert');
    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await expect(exit).toBeFocused();
    await expect(exit).toHaveCSS('outline-width', '3px');

    // Persistence: never auto-hide while focus remains inside the stack.
    await page.clock.fastForward(10_000);
    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await expect(controls).not.toHaveAttribute('inert');
    await expect(exit).toBeFocused();

    // Activate Fullscreen via keyboard, then return focus and confirm we stay usable.
    await fullscreen.focus();
    await expect(fullscreen).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await fullscreen.focus();
    await page.clock.fastForward(10_000);
    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await expect(controls).not.toHaveAttribute('inert');

    await fullscreen.evaluate((button) => (button as HTMLButtonElement).blur());
    await page.clock.fastForward(3_501);
    await expect(controls).toHaveCSS('pointer-events', 'none');
    await expect(controls).toHaveAttribute('inert', '');
  });

  test('keeps fullscreen recovery notice usable (never inert) while guidance is shown', async ({ page }) => {
    const fullscreen = await openPlayerDisplay(page, 'unsupported');
    const controls = playerDisplayControls(page);

    await expect(fullscreen).toBeDisabled();
    await expect(fullscreenNotice(page)).toBeVisible();
    await expect(controls).not.toHaveAttribute('inert');
    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await expect(page.getByRole('button', { name: 'Exit player display' })).toBeVisible();
  });

  test('touch input restores controls in a reduced-motion mobile viewport and stays axe-clean', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      hasTouch: true,
      isMobile: true,
      reducedMotion: 'reduce',
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.clock.install();
    await openPlayerDisplay(page);
    const controls = playerDisplayControls(page);

    await expect(controls).toHaveCSS('transition-duration', '0s');
    await page.clock.fastForward(3_501);
    await expect(controls).toHaveCSS('pointer-events', 'none');

    await page.touchscreen.tap(24, 420);
    await expect(controls).toHaveCSS('pointer-events', 'auto');
    await expect(page.getByRole('button', { name: 'Exit player display' })).toBeInViewport();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toBeInViewport();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    await context.close();
  });
});
