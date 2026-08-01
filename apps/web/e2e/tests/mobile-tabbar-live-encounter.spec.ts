import { expect, test, request } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issues #637, #1472 — mobile tab bar contract:
 * Encounters is a standing tab (or Live when an encounter is running),
 * and More remains reachable mid-fight across phone viewports (320px, 375px, 430px).
 */

test.describe('mobile tab bar live encounter (#637, #1472)', () => {
  test.use({ storageState: stateFor('dm') });

  test('shows Live tab linking to running encounter while keeping More accessible', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await restoreSeedEncounter();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/c/${campaignId}`);

    // Both Live and More must be visible on the tab bar
    const liveTab = page.getByTestId('tabbar-live');
    const moreBtn = page.locator('.cf-tabbar').getByRole('button', { name: /More/ });
    await expect(liveTab).toBeVisible();
    await expect(moreBtn).toBeVisible();

    // Verify More sheet opens while combat is live
    await moreBtn.click();
    await expect(page.getByRole('dialog', { name: /More navigation/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /More navigation/i })).toBeHidden();

    // Verify Live tab routes directly to active encounter
    await liveTab.click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/encounters/${encounterId}`));
  });

  test('shows standing Encounters tab and More when no encounter is running', async ({ page }) => {
    const { baseURL, campaignId } = seed();
    const dm = await request.newContext({ baseURL, storageState: stateFor('dm') });
    try {
      await dm.post('/api/v1/auth/login', { data: CREDS.dm });
      const liveRes = await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`);
      expect(liveRes.ok()).toBeTruthy();
      for (const enc of (await liveRes.json()) as { id: number }[]) {
        const ended = await dm.post(`/api/v1/encounters/${enc.id}/end`);
        expect(ended.ok()).toBeTruthy();
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/c/${campaignId}`);
      await expect(page.getByTestId('tabbar-live')).toHaveCount(0);

      const encountersTab = page.getByTestId('tabbar-encounters');
      const moreBtn = page.locator('.cf-tabbar').getByRole('button', { name: /More/ });
      await expect(encountersTab).toBeVisible();
      await expect(moreBtn).toBeVisible();

      await encountersTab.click();
      await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/encounters`));
    } finally {
      await dm.dispose();
      await restoreSeedEncounter();
    }
  });

  test('renders tab bar without overflow at 320px, 375px, and 430px viewports', async ({ page }) => {
    const { campaignId } = seed();
    await restoreSeedEncounter();

    const viewports = [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 430, height: 932 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.goto(`/c/${campaignId}`);

      const tabbar = page.locator('.cf-tabbar');
      await expect(tabbar).toBeVisible();

      // Check tabbar container bounds and horizontal scroll
      const isOverflowing = await tabbar.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(isOverflowing).toBe(false);

      // Verify all 6 tabs fit within viewport horizontal range
      const tabItems = tabbar.locator('a, button');
      expect(await tabItems.count()).toBe(6);

      for (let i = 0; i < 6; i++) {
        const item = tabItems.nth(i);
        await expect(item).toBeVisible();
        const box = await item.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(-1);
          expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
        }
      }
    }
  });
});
