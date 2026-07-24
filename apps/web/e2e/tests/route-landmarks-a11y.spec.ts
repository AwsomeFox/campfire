import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MAIN_CONTENT_ID } from '../../src/app/routeFocus';
import { seed, stateFor } from './seed';

/**
 * Issue #456 — authenticated shell views expose exactly one document-level main
 * landmark; creation flows use labelled sections inside it.
 */

test.use({ storageState: stateFor('dm') });

async function expectSingleShellMainLandmark(page: Page) {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator(`#${MAIN_CONTENT_ID}`)).toBeVisible();
}

test.describe('Route main landmarks (#456)', () => {
  test('campaign creation wizard keeps a single shell main landmark', async ({ page }) => {
    await page.goto('/?newCampaign=1');

    await expectSingleShellMainLandmark(page);
    await expect(page.locator('section[aria-labelledby="new-campaign-title"]')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => v.id === 'landmark-one-main')).toEqual([]);
  });

  test('quest creation keeps a single shell main landmark', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/quests/new`);

    await expect(page.getByTestId('quest-create-form')).toBeVisible();
    await expectSingleShellMainLandmark(page);
    await expect(page.locator('section[aria-labelledby="quest-create-heading"]')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => v.id === 'landmark-one-main')).toEqual([]);
  });

  test('representative campaign routes keep one main landmark', async ({ page }) => {
    const { campaignId } = seed();
    const routes = [
      '/',
      '/preferences',
      `/c/${campaignId}`,
      `/c/${campaignId}/quests`,
      `/c/${campaignId}/compendium`,
      `/c/${campaignId}/sessions`,
    ];

    for (const path of routes) {
      await page.goto(path);
      await expectSingleShellMainLandmark(page);
    }
  });
});
