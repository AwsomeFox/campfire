import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('browser 403 handling (issue #1484)', () => {
  test.use({ storageState: stateFor('player') });

  test('surfaces 403 inline error without redirecting to login', async ({ page }) => {
    const { campaignId, activePcId } = seed();
    await page.goto(`/c/${campaignId}/characters/${activePcId}`);

    // Intercept character PATCH with a 403 Forbidden response
    await page.route(`**/api/v1/characters/${activePcId}`, async (route) => {
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

    const nameField = page.getByLabel('Character name');
    await expect(nameField).toBeVisible();
    await nameField.fill(`Updated Name ${Date.now()}`);

    const saveBtn = page.getByRole('button', { name: 'Save changes' });
    await saveBtn.click();

    // Page must remain on character page and NOT redirect to /login
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/characters/${activePcId}$`));

    // Inline error surfaces
    await expect(page.getByRole('alert').filter({ hasText: /Forbidden|Couldn't update/i })).toBeVisible();
  });
});
