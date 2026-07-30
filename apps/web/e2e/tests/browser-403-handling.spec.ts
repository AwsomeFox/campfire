import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('browser 403 handling (issue #1484)', () => {
  test.use({ storageState: stateFor('dm') });

  let characterId: number;

  test.beforeEach(async ({ request }) => {
    const { campaignId } = seed();
    const res = await request.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: `403 Test PC ${Date.now()}`, className: 'Fighter', level: 1, hpMax: 10, hpCurrent: 10 },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { id: number };
    characterId = body.id;
  });

  test.afterEach(async ({ request }) => {
    if (characterId) {
      await request.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
    }
  });

  test('surfaces 403 inline error without redirecting to login', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}?focus=xp`);

    const xpCard = page.getByTestId('character-xp');
    await expect(xpCard).toBeVisible();

    const levelUpBtn = xpCard.getByRole('button', { name: /Level up/i });
    await expect(levelUpBtn).toBeVisible();
    await levelUpBtn.click();

    // Intercept level-up POST with 403 Forbidden
    await page.route(`**/api/v1/characters/${characterId}/level-up`, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 403, message: 'Forbidden' }),
      });
    });

    const confirmBtn = xpCard.getByRole('button', { name: 'Confirm level 2' });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Page must remain on character page and NOT redirect to /login
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/characters/${characterId}\\?focus=xp$`));

    // Inline error surfaces
    await expect(page.getByRole('alert').filter({ hasText: /Forbidden|Couldn't level up/i })).toBeVisible();
  });
});
