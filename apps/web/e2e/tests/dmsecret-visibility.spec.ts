import { test, expect } from '@playwright/test';
import { NPC_NAME, NPC_SECRET } from '../global-setup';
import { seed, stateFor } from './seed';

// Default identity for this file's `page` fixture is the DM.
test.use({ storageState: stateFor('dm') });

/**
 * dmSecret visibility — the leak the audit flagged (issue #81): a DM must see an
 * NPC's dmSecret panel; a player and a viewer must NOT. This is defended on both
 * sides (server strips dmSecret for non-DM reads AND the client gates the panel
 * on `isDm`), so the secret string must never reach a non-DM DOM at all.
 */
test.describe('NPC dmSecret visibility across roles', () => {
  test('DM sees the dmSecret panel', async ({ page }) => {
    const { campaignId, npcId } = seed();
    await test.step('open the NPC as DM', async () => {
      await page.goto(`/c/${campaignId}/npcs/${npcId}`);
      await expect(page.getByRole('heading', { name: NPC_NAME })).toBeVisible();
    });
    await expect(page.getByText('🔒 DM only')).toBeVisible();
    await expect(page.getByText(NPC_SECRET)).toBeVisible();
  });

  for (const role of ['player', 'viewer'] as const) {
    test(`${role} never sees the dmSecret`, async ({ browser }) => {
      const { campaignId, npcId } = seed();
      const ctx = await browser.newContext({ storageState: stateFor(role) });
      const page = await ctx.newPage();
      await page.goto(`/c/${campaignId}/npcs/${npcId}`);
      await expect(page.getByRole('heading', { name: NPC_NAME })).toBeVisible();

      // The secret string is absent from the DOM, and no "DM only" panel renders.
      await expect(page.getByText(NPC_SECRET)).toHaveCount(0);
      await expect(page.getByText('🔒 DM only')).toHaveCount(0);
      await ctx.close();
    });
  }
});
