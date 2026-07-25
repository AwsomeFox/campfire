import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const INVALID_TOKEN = 'cf_share_00000000000000000000000000000000000000000000';

async function mockSignedOut(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        setupRequired: false,
        localLoginEnabled: true,
        signupEnabled: false,
        oidcEnabled: false,
        version: 'test',
      }),
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
  });
}

async function mockSignedIn(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        setupRequired: false,
        localLoginEnabled: true,
        signupEnabled: false,
        oidcEnabled: false,
        version: 'test',
      }),
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 1,
          username: 'signed-in',
          displayName: 'Signed In',
          serverRole: 'user',
          disabled: false,
          accentColor: null,
          textSize: 'default',
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z',
        },
        memberships: [],
      }),
    });
  });
}

async function mockShareNotFound(page: Page): Promise<void> {
  await page.route(`**/api/v1/shared/recaps/${INVALID_TOKEN}`, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Not found' }),
    });
  });
}

test.describe('shared recap invalid link (#482)', () => {
  test('renders semantic unavailable state with recovery navigation', async ({ page }) => {
    await mockSignedOut(page);
    await mockShareNotFound(page);
    await page.goto(`/share/${INVALID_TOKEN}`);

    const heading = page.getByRole('heading', { level: 1, name: "This recap link isn't available" });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.getByTestId('shared-recap-unavailable')).toHaveAttribute('role', 'alert');

    await expect(page.getByText(INVALID_TOKEN)).toHaveCount(0);
    await expect(page.getByText(/revoked|Not found/i)).toHaveCount(0);

    await expect(page.getByRole('link', { name: 'Go to Campfire' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/login?redirect=%2Fshare%2F${INVALID_TOKEN}`,
    );
  });

  test('is keyboard-complete, axe-clean, and mobile-safe', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await mockSignedOut(page);
    await mockShareNotFound(page);
    await page.goto(`/share/${INVALID_TOKEN}`);

    const heading = page.getByRole('heading', { level: 1, name: "This recap link isn't available" });
    const home = page.getByRole('link', { name: 'Go to Campfire' });
    const signIn = page.getByRole('link', { name: 'Sign in' });
    await expect(heading).toBeFocused();
    await expect(signIn).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(home).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(signIn).toBeFocused();

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    for (const action of [home, signIn]) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('hides sign-in when the visitor already has a session', async ({ page }) => {
    await mockSignedIn(page);
    await mockShareNotFound(page);
    await page.goto(`/share/${INVALID_TOKEN}`);

    await expect(page.getByRole('heading', { level: 1, name: "This recap link isn't available" })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Campfire' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  });
});
