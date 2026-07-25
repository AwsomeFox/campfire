import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('entity reveal safety (issue #710)', () => {
  test.use({ storageState: stateFor('dm') });

  test('hidden NPC reveal requires confirmation, shows preview, and supports Undo', async ({ page, browser }) => {
    const { campaignId } = seed();
    const hiddenName = `E2E Hidden Reveal ${Date.now()}`;

    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/npcs`, {
      data: {
        name: hiddenName,
        role: 'Secret contact',
        body: 'Only the DM should see this until revealed.',
        hidden: true,
      },
    });
    expect(created.ok()).toBeTruthy();
    const npc = (await created.json()) as { id: number; hidden: boolean };
    if (!npc.hidden) {
      const patched = await page.request.patch(`/api/v1/npcs/${npc.id}`, { data: { hidden: true } });
      expect(patched.ok()).toBeTruthy();
    }

    await page.goto(`/c/${campaignId}/npcs/${npc.id}`);
    await expect(page.getByRole('heading', { name: hiddenName })).toBeVisible();
    const reveal = page.getByRole('button', { name: 'Reveal to players' });
    await expect(reveal).toBeVisible();
    await reveal.click();
    const dialog = page.getByRole('dialog', { name: /Reveal NPC to players/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Audience: all campaign members/i)).toBeVisible();
    await expect(dialog.getByTestId('entity-reveal-preview')).toContainText(hiddenName);
    await expect(dialog.getByTestId('entity-reveal-preview')).toContainText('Secret contact');
    await expect(dialog.getByText(/cannot retract what players already observed/i)).toBeVisible();

    await dialog.getByRole('button', { name: 'Reveal to players' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('visible-to-players-bar')).toBeVisible();

    const playerCtx = await browser.newContext({ storageState: stateFor('player') });
    const playerPage = await playerCtx.newPage();
    await playerPage.goto(`/c/${campaignId}/npcs/${npc.id}`);
    await expect(playerPage.getByRole('heading', { name: hiddenName })).toBeVisible();
    await playerCtx.close();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Reveal to players' })).toBeVisible();
    await expect(page.getByTestId('visible-to-players-bar')).toHaveCount(0);
  });

  test('reveal dialog is keyboard reachable and cancellable', async ({ page }) => {
    const { campaignId } = seed();
    const hiddenName = `E2E Reveal Keyboard ${Date.now()}`;

    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/npcs`, {
      data: { name: hiddenName, body: 'Keyboard path', hidden: true },
    });
    expect(created.ok()).toBeTruthy();
    const npc = (await created.json()) as { id: number; hidden: boolean };
    if (!npc.hidden) {
      await page.request.patch(`/api/v1/npcs/${npc.id}`, { data: { hidden: true } });
    }

    await page.goto(`/c/${campaignId}/npcs/${npc.id}`);
    const reveal = page.getByRole('button', { name: 'Reveal to players' });
    await expect(reveal).toBeVisible();
    await reveal.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: /Reveal NPC to players/i });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reveal to players' })).toBeVisible();
  });
});
