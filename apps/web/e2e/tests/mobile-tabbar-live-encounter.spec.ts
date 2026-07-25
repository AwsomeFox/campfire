import { expect, test, request } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #637 — when a campaign has a running encounter, the mobile tab bar swaps
 * the More slot for a Live shortcut to the fight.
 */

test.describe('mobile tab bar live encounter (#637)', () => {
  test.use({ storageState: stateFor('dm') });

  test('shows Live tab linking to the running encounter at phone widths', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await restoreSeedEncounter();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/c/${campaignId}`);
    await expect(page.getByTestId('tabbar-live')).toBeVisible();
    await page.getByTestId('tabbar-live').click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/encounters/${encounterId}`));
  });

  test('shows More instead of Live when no encounter is running', async ({ page }) => {
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
      await expect(page.locator('.cf-tabbar').getByRole('button', { name: /More/ })).toBeVisible();
    } finally {
      await dm.dispose();
      await restoreSeedEncounter();
    }
  });
});
