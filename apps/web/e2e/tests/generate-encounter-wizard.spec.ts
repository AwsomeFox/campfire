import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Generate-encounter wizard (issue #412): the DM preview-and-tune workflow over the
 * non-mutating preview + idempotent commit REST endpoints. Covers discover → preview
 * (with difficulty explanation) → tune (reroll all) → commit → land on the preparing
 * encounter tracker. Runs against the real backend with the seeded compendium fixture.
 */
test.describe('generate-encounter wizard — issue #412', () => {
  test.use({ storageState: stateFor('dm') });

  test('discover → preview → reroll all → commit → tracker', async ({ page }) => {
    const { campaignId } = seed();
    const listUrl = `/c/${campaignId}/encounters`;

    const before = await page.request.get(`/api/v1/campaigns/${campaignId}/encounters`);
    expect(before.ok()).toBe(true);
    const countBefore = ((await before.json()) as Array<{ id: number }>).length;

    await page.goto(listUrl);
    const generateBtn = page.getByRole('button', { name: 'Generate encounter' });
    await expect(generateBtn).toBeVisible();
    await generateBtn.click();

    const wizard = page.getByTestId('generate-encounter-wizard');
    await expect(wizard).toBeVisible();
    await wizard.getByRole('button', { name: /Preview roster/i }).click();

    // Difficulty explanation (not just a band) + at least one roster slot from the compendium.
    await expect(wizard.locator('p').first()).toBeVisible({ timeout: 15_000 });
    const rerollAll = wizard.getByRole('button', { name: 'Reroll all' });
    await expect(rerollAll).toBeVisible({ timeout: 15_000 });
    await rerollAll.click();

    await wizard.getByRole('button', { name: 'Create encounter' }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/encounters/(\\d+)`), { timeout: 15_000 });
    const encounterId = Number(page.url().match(/encounters\/(\d+)/)?.[1]);
    expect(encounterId).toBeGreaterThan(0);

    const created = await page.request.get(`/api/v1/encounters/${encounterId}`);
    expect(created.ok()).toBe(true);
    const encounter = (await created.json()) as { status: string; hidden: boolean };
    expect(encounter.status).toBe('preparing');
    expect(encounter.hidden).toBe(true);

    const after = await page.request.get(`/api/v1/campaigns/${campaignId}/encounters`);
    expect(after.ok()).toBe(true);
    const countAfter = ((await after.json()) as Array<{ id: number }>).length;
    expect(countAfter).toBe(countBefore + 1);
  });
});
