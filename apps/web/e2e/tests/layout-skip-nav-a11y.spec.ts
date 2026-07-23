import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';
import { MAIN_CONTENT_ID, SKIP_TO_MAIN_ID } from '../../src/app/routeFocus';

/**
 * Issue #591 — authenticated layout skip link + route-change focus/title.
 */

test.use({ storageState: stateFor('dm') });

async function openCampaign(page: Page) {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}`);
  await expect(page.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();
  return campaignId;
}

test.describe('Layout skip link and route focus (#591)', () => {
  test('skip link is first in tab order and activates main without scrolling', async ({ page }) => {
    const campaignId = await openCampaign(page);
    await page.setViewportSize({ width: 1280, height: 720 });

    const skip = page.locator(`#${SKIP_TO_MAIN_ID}`);
    await expect(skip).toBeAttached();

    const firstTabStopId = await page.evaluate(() => {
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
      return focusable[0]?.id ?? null;
    });
    expect(firstTabStopId).toBe(SKIP_TO_MAIN_ID);

    const scrollBefore = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    await skip.focus();
    await skip.click();
    const main = page.locator(`#${MAIN_CONTENT_ID}`);
    await expect(main).toBeFocused();
    const scrollAfter = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    expect(scrollAfter).toEqual(scrollBefore);
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}$`));
  });

  test('sidebar navigation moves focus to the page heading and updates the document title', async ({ page }) => {
    const campaignId = await openCampaign(page);
    await page.getByRole('link', { name: 'Party', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/party`));
    await expect(page.getByRole('heading', { level: 1, name: 'Party' })).toBeFocused();
    await expect(page).toHaveTitle(/Party · .*Cinderhaven · Campfire/);
  });

  test('mobile tab bar navigation moves focus to the destination page', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Keyboard timing is stable on Chromium');
    const campaignId = await openCampaign(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.locator('.cf-tabbar').getByRole('link', { name: 'Quests', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/quests`));
    await expect(page.locator(`#${MAIN_CONTENT_ID}`)).toBeFocused();
  });

  test('in-page session tab changes keep focus on the activated tab', async ({ page }) => {
    const campaignId = await openCampaign(page);
    await page.goto(`/c/${campaignId}/sessions`);

    const scheduleTab = page.locator('#sessions-tab-schedule');
    await scheduleTab.click();
    await expect(scheduleTab).toBeFocused();
    await expect(scheduleTab).toHaveAttribute('aria-selected', 'true');
  });

  test('browser back restores focus to the previous page destination', async ({ page }) => {
    const campaignId = await openCampaign(page);
    await page.getByRole('link', { name: 'Party', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Party' })).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}$`));
    await expect(page.locator(`#${MAIN_CONTENT_ID}`)).toBeFocused();
    await expect(page).toHaveTitle(/Dashboard · .*Cinderhaven · Campfire/);
  });

  test('unknown routes focus the not-found heading and set document title', async ({ page }) => {
    const campaignId = await openCampaign(page);
    await page.goto(`/c/${campaignId}/this-route-does-not-exist`);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeFocused();
    await expect(page).toHaveTitle(/Page not found · .*Cinderhaven · Campfire/);
  });
});
