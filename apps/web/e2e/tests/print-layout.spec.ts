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
  await expect.poll(() => page.locator('.cf-print-chrome').evaluateAll(
    (elements) => elements.every((element) => getComputedStyle(element).display === 'none'),
  )).toBe(true);
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
      await expect(page.getByTestId('character-sheet-tabs')).toBeHidden();
      await expect(page.getByTestId('character-sheet-panel-play')).toBeVisible();
      await expect(page.getByTestId('character-sheet-panel-build')).toBeVisible();
      await expect(page.getByTestId('character-sheet-panel-build').getByText('Background', { exact: true }).first()).toBeVisible();
      await expect(page.locator('.reading-surface')).toHaveScreenshot('character-sheet-print.png', {
        animations: 'disabled',
        maxDiffPixelRatio: 0.05,
      });

      // Print chrome must not hide document/feature asides by element name.
      await page.evaluate(() => {
        const aside = document.createElement('aside');
        aside.id = 'print-semantic-aside';
        aside.textContent = 'Printable supplementary notes';
        document.querySelector('main')?.append(aside);
      });
      await expect(page.locator('#print-semantic-aside')).toBeVisible();
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
      await expect(page.locator('[data-entity-type="session"]')).toHaveCSS('color', 'rgb(0, 0, 0)');
      await expect(page.locator('[data-entity-type="session"]').getByText('The party crossed the moon gate.')).toBeVisible();
      await expect(page.getByText('Attendance not recorded.')).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Linked encounters' })).toBeHidden();
      await expect(page.locator('[data-entity-type="session"]')).toHaveScreenshot('session-recap-print.png', {
        animations: 'disabled',
        maxDiffPixelRatio: 0.05,
      });

      await page.emulateMedia({ media: 'screen' });
      await page.getByRole('button', { name: 'Edit recap' }).click();
      await expect(page.getByRole('button', { name: 'Print' })).toHaveCount(0);
      await page.emulateMedia({ media: 'print' });
      await expect(page.locator('.cf-print-editor')).toBeHidden();
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
