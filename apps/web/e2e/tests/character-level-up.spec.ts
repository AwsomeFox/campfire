import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('character level up flow', () => {
  test.use({ storageState: stateFor('dm') });

  let characterId: number;

  test.beforeEach(async ({ request }) => {
    const { campaignId } = seed();
    const res = await request.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: `LevelUp PC ${Date.now()}`, className: 'Fighter', level: 1, hpMax: 10, hpCurrent: 10 },
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

  test('guided level up increases character level and HP max', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}?focus=xp`);

    const xpCard = page.getByTestId('character-xp');
    await expect(xpCard).toBeVisible();

    const levelUpBtn = xpCard.getByRole('button', { name: /Level up/i });
    await expect(levelUpBtn).toBeVisible();
    await levelUpBtn.click();

    await expect(xpCard.getByText('Level 1 → 2')).toBeVisible();

    const confirmBtn = xpCard.getByRole('button', { name: 'Confirm level 2' });
    await expect(confirmBtn).toBeVisible();

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(`/api/v1/characters/${characterId}/level-up`) && res.request().method() === 'POST',
      ),
      confirmBtn.click(),
    ]);
    expect(response.status()).toBe(201);

    await expect(xpCard.getByText('Level 2! You grow stronger.')).toBeVisible();
  });
});
