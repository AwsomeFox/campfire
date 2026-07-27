import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

const SHARED_TOKEN = 'cf_share_11111111111111111111111111111111111111111111';

async function mockPublicRecap(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      setupRequired: false,
      localLoginEnabled: true,
      signupEnabled: false,
      oidcEnabled: false,
      version: 'test',
    }),
  }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401 }));
  await page.route(`**/api/v1/shared/recaps/${SHARED_TOKEN}`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      campaignName: 'Print test campaign',
      sessionNumber: 9,
      title: 'A printable shared recap',
      playedAt: '2026-07-26',
      recap: '# A quiet recap\n\nThe party returned safely.',
    }),
  }));
}

async function expectPrintSurface(page: Page): Promise<void> {
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'Print' })).toBeHidden();
  await expect(page.locator('aside')).toBeHidden();
  await expect(page.locator('.cf-tabbar')).toBeHidden();
  await expect(page.locator('.reading-surface')).toHaveCSS('color', 'rgb(0, 0, 0)');
}

test.describe('print layouts (#667)', () => {
  test('prints a character sheet without application chrome', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('viewer') });
    const page = await context.newPage();
    try {
      await page.goto(`/c/${seed().campaignId}/characters/${seed().navigation.characterId}`);
      await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
      await expectPrintSurface(page);
    } finally {
      await context.close();
    }
  });

  test('prints a session recap without its editing controls', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm') });
    const page = await context.newPage();
    try {
      const { campaignId, navigation } = seed();
      await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);
      await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit recap' })).toBeVisible();
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByRole('button', { name: 'Print' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Edit recap' })).toBeHidden();
      await expect(page.locator('.reading-surface')).toHaveCSS('color', 'rgb(0, 0, 0)');
    } finally {
      await context.close();
    }
  });

  test('prints a shared recap without dark-theme chrome', async ({ page }) => {
    await mockPublicRecap(page);
    await page.goto(`/share/${SHARED_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'A printable shared recap' })).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Print' })).toBeHidden();
    await expect(page.locator('main')).toHaveCSS('color', 'rgb(0, 0, 0)');
  });
});
