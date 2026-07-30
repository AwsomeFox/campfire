import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('browser 403 handling (issue #1484)', () => {
  test.use({ storageState: stateFor('player') });

  test('surfaces 403 inline error without redirecting to login', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    // Intercept a write action with a 403 Forbidden response
    await page.route(`**/api/v1/campaigns/${campaignId}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: 403, message: 'Forbidden' }),
        });
        return;
      }
      await route.continue();
    });

    const descField = page.getByLabel('Campaign description');
    await expect(descField).toBeVisible();
    await descField.fill(`Updated description ${Date.now()}`);

    const saveBtn = page.getByRole('button', { name: 'Save changes' });
    await saveBtn.click();

    // Page must remain on /settings and NOT redirect to /login
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/settings$`));

    // Inline error surfaces
    await expect(page.getByRole('alert').filter({ hasText: /Forbidden|Couldn't update campaign/i })).toBeVisible();
  });
});
