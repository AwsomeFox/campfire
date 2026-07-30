import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('Campaign Trash page and entity restoration', () => {
  test.use({ storageState: stateFor('dm') });

  let trashedCharacterId: number;
  const name = `Trash Test PC ${Date.now()}`;

  test.beforeEach(async ({ request }) => {
    const { campaignId } = seed();
    const createRes = await request.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name, className: 'Rogue', level: 1 },
    });
    expect(createRes.ok()).toBe(true);
    const char = (await createRes.json()) as { id: number };
    trashedCharacterId = char.id;

    const trashRes = await request.delete(`/api/v1/characters/${trashedCharacterId}`);
    expect(trashRes.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    if (trashedCharacterId) {
      await request.delete(`/api/v1/characters/${trashedCharacterId}`).catch(() => undefined);
    }
  });

  test('displays trashed items and restores via the Trash page Restore button', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/trash`);

    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row).toBeVisible();

    const restoreBtn = row.getByRole('button', { name: `Restore ${name}` });
    await expect(restoreBtn).toBeVisible();

    const [restoreRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(`/api/v1/characters/${trashedCharacterId}/restore`) && res.request().method() === 'POST',
      ),
      restoreBtn.click(),
    ]);
    expect(restoreRes.status()).toBe(201);

    await expect(row).toBeHidden();
  });
});
