import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('campaign search results', () => {
  test.use({ storageState: stateFor('dm') });

  test('groups encounters and schedules and supports result keyboard navigation', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/search?q=DLRNAV`);

    const results = page.getByRole('region', { name: 'Search results' });
    const encounterGroup = page.getByRole('heading', { name: /Encounters \(1\)/ });
    const scheduleGroup = page.getByRole('heading', { name: /Scheduled sessions \(1\)/ });
    await expect(encounterGroup).toBeVisible();
    await expect(scheduleGroup).toBeVisible();
    await expect(encounterGroup.locator('svg')).toHaveCount(1);
    await expect(scheduleGroup.locator('svg')).toHaveCount(1);
    await expect(results.getByRole('link', { name: /DLRNAV Bridge Ambush/ })).toBeVisible();
    await expect(results.getByRole('link', { name: /DLRNAV Saturday Game/ })).toBeVisible();

    const links = results.getByRole('link');
    const search = page.getByRole('textbox', { name: 'Search this campaign' });
    await search.focus();
    await page.keyboard.press('ArrowDown');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(links.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(links.first()).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[data-search-results]').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('is usable on mobile and gives encounter/schedule-aware empty guidance', async ({ browser }) => {
    const { campaignId } = seed();
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();
    await page.goto(`/c/${campaignId}/search?q=DLRNAV`);
    await expect(page.getByRole('link', { name: /DLRNAV Bridge Ambush/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /DLRNAV Saturday Game/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const accessibilityScan = await new AxeBuilder({ page }).include('[data-search-results]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.goto(`/c/${campaignId}/search?q=NO-SUCH-CAMPAIGN-RESULT`);
    await expect(page.getByText(/Try an encounter name, scheduled-session date or time/)).toBeVisible();
    await context.close();
  });
});
