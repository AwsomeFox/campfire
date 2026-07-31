import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { SessionZero } from '@campfire/schema';
import { seed, stateFor } from './seed';

test.describe('shared-editor stale-write recovery — #881', () => {
  test.use({ storageState: stateFor('dm') });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('two DM clients preserve a resumed mobile draft and resolve the conflict accessibly', async ({ browser }) => {
    const { campaignId } = seed();
    const desktop = await browser.newContext({ storageState: stateFor('dm') });
    const mobile = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 375, height: 812 },
    });

    try {
      const currentResponse = await desktop.request.get(`/api/v1/campaigns/${campaignId}/session-zero`);
      expect(currentResponse.ok()).toBeTruthy();
      const current = await currentResponse.json() as SessionZero;
      const reset = await desktop.request.put(`/api/v1/campaigns/${campaignId}/session-zero`, {
        data: {
          lines: ['No body horror'],
          veils: [],
          safetyTools: ['Open Door'],
          houseRules: 'Shared starting rule',
          toneAndExpectations: 'Heroic fantasy',
          expectedUpdatedAt: current.updatedAt,
        },
      });
      expect(reset.ok()).toBeTruthy();

      const desktopPage = await desktop.newPage();
      const mobilePage = await mobile.newPage();
      await Promise.all([
        desktopPage.goto(`/c/${campaignId}/session-zero`),
        mobilePage.goto(`/c/${campaignId}/session-zero`),
      ]);
      await Promise.all([
        desktopPage.getByRole('button', { name: 'Edit charter' }).click(),
        mobilePage.getByRole('button', { name: 'Edit charter' }).click(),
      ]);

      await desktopPage.getByRole('textbox', { name: 'House rules' }).fill('Desktop DM rule');
      await mobilePage.getByRole('textbox', { name: 'House rules' }).fill('Mobile DM draft');

      await desktopPage.bringToFront();
      await desktopPage.getByRole('button', { name: 'Save charter' }).click();
      await expect(desktopPage.getByText('Desktop DM rule')).toBeVisible();

      await mobilePage.bringToFront();
      // Exercise the same refresh path used when an installed/backgrounded app resumes.
      await mobilePage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(mobilePage.getByRole('textbox', { name: 'House rules' })).toHaveValue('Mobile DM draft');
      await mobilePage.getByRole('button', { name: 'Save charter' }).click();

      const conflict = mobilePage.getByRole('alert', { name: 'Conflicting edits' });
      await expect(conflict).toBeVisible();
      await expect(mobilePage.getByRole('textbox', { name: 'House rules' })).toHaveValue('Mobile DM draft');
      await expect(conflict.getByRole('button', { name: 'House rules: Reload latest' })).toBeVisible();
      await expect(conflict.getByRole('button', { name: 'House rules: Keep mine' })).toBeVisible();
      await expect(conflict.getByRole('button', { name: 'House rules: Merge edits' })).toBeVisible();

      const field = conflict.getByRole('group', { name: 'House rules' });
      const latestBox = await field.getByText('Latest', { exact: true }).boundingBox();
      const draftBox = await field.getByText('Your draft', { exact: true }).boundingBox();
      expect(latestBox).not.toBeNull();
      expect(draftBox).not.toBeNull();
      expect(draftBox!.y).toBeGreaterThan(latestBox!.y);

      const accessibility = await new AxeBuilder({ page: mobilePage }).include('[aria-label="Conflicting edits"]').analyze();
      expect(accessibility.violations).toEqual([]);

      await conflict.getByRole('button', { name: 'House rules: Merge edits' }).click();
      await expect(mobilePage.getByRole('textbox', { name: 'House rules' })).toHaveValue(/Desktop DM rule[\s\S]*Mobile DM draft/);
      await mobilePage.getByRole('button', { name: 'Save resolution' }).click();
      await expect(conflict).toBeHidden();
      await expect(mobilePage.locator('main').getByText('Desktop DM rule', { exact: true })).toBeVisible();
      await expect(mobilePage.locator('main').getByText('Mobile DM draft', { exact: true })).toBeVisible();
    } finally {
      await Promise.all([desktop.close(), mobile.close()]);
    }
  });

  test('a delayed older background refresh cannot replace the newest response', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/session-zero`);
    await expect(page.getByRole('button', { name: 'Edit charter' })).toBeVisible();

    let sequence = 0;
    await page.route(`**/api/v1/campaigns/${campaignId}/session-zero`, async (route) => {
      const requestSequence = ++sequence;
      const response = await route.fetch().catch(() => null);
      if (!response) return route.continue().catch(() => undefined);
      const body = (await response.json().catch(() => null)) as SessionZero | null;
      if (!body) return route.continue().catch(() => undefined);
      if (requestSequence === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await route.fulfill({
        response,
        json: {
          ...body,
          houseRules: requestSequence === 1 ? 'Delayed older response' : 'Newest response',
        },
      });
    });

    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByText('Newest response')).toBeVisible();
    await page.waitForTimeout(350);
    await expect(page.getByText('Newest response')).toBeVisible();
    await expect(page.getByText('Delayed older response')).toHaveCount(0);
  });
});
