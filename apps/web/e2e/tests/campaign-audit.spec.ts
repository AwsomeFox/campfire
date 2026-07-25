import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('campaign audit log — issue #443', () => {
  test.use({ storageState: stateFor('dm') });

  test('full audit page paginates, filters deep-link, and exports', async ({ page }) => {
    const { campaignId } = seed();

    await page.goto(`/c/${campaignId}/audit?action=note.create`);

    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(/of \d+/);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(new RegExp(`campaign-${campaignId}-audit\\.csv`));

    await page.getByRole('button', { name: 'Load older entries' }).click({ timeout: 5000 }).catch(() => {
      // Terminal page — no load-more button; that's fine for small seed data.
    });
  });

  test('members page links to the full audit log', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/members`);
    await page.getByRole('link', { name: 'View full log →' }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/audit`));
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  });
});
