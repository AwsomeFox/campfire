import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #479 — player data rights: export-my-data and leave-campaign must be
 * discoverable from campaign nav (desktop sidebar + mobile More sheet), not only
 * by guessing /c/:id/members.
 */

async function openYourData(page: Page, campaignId: number) {
  await page.goto(`/c/${campaignId}`);
  await expect(page.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Your data', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/members`));
}

for (const role of ['player', 'viewer'] as const) {
  test.describe(`${role} data rights (issue #479)`, () => {
    test.use({ storageState: stateFor(role) });

    test('desktop nav reaches export and leave with accessible confirmation', async ({ page }) => {
      const { campaignId } = seed();
      await openYourData(page, campaignId);

      await expect(page.getByRole('heading', { level: 1, name: 'Your data' })).toBeVisible();
      const card = page.getByTestId('your-membership-card');
      await expect(card).toBeVisible();
      await expect(card.getByText(/Take a copy of what's yours/i)).toBeVisible();
      await expect(card.getByText(/Leaving closes your seat/i)).toBeVisible();

      const exportLink = card.getByRole('link', { name: /Export my data/i });
      await expect(exportLink).toHaveAttribute('href', new RegExp(`/api/v1/campaigns/${campaignId}/export/me`));

      await card.getByRole('button', { name: 'Leave campaign…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Leave this campaign?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/Export your data first if you want a copy/i);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
    });

    test('mobile More sheet lists Your data under Manage', async ({ page }) => {
      const { campaignId } = seed();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/c/${campaignId}`);
      await expect(page.locator('.cf-tabbar')).toBeVisible();

      // Role chip in the top bar opens the same More sheet and stays available when a
      // live encounter swaps the tab-bar More slot for Live (issue #637).
      const roleChip = page.getByRole('button', { name: new RegExp(`^${role === 'player' ? 'Player' : 'Viewer'}`, 'i') });
      await expect(roleChip).toBeVisible();
      await roleChip.click();
      const sheet = page.getByRole('dialog', { name: /More navigation/i });
      await expect(sheet).toBeVisible();
      const yourData = sheet.getByRole('link', { name: 'Your data', exact: true });
      await expect(yourData).toBeVisible();
      await yourData.click();
      await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/members`));
      await expect(page.getByTestId('your-membership-card')).toBeVisible();
    });
  });
}
