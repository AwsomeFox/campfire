import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #454 — Character sheet inventory embeds the real campaign inventory UI.
 *
 * Verifies the stale "soon" placeholder is gone, character-owned items render with
 * qty controls, and changes sync to the campaign Inventory page.
 */

const CREDS = {
  dm: { username: 'dm', password: 'campfire-dm-pw-1' },
} as const;

async function login(ctx: APIRequestContext, baseURL: string) {
  await ctx.post(`${baseURL}/api/v1/auth/login`, { data: CREDS.dm });
}

async function createCharacter(baseURL: string, name: string): Promise<number> {
  const { campaignId } = seed();
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL);
  const res = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
    data: { name, className: 'Rogue', level: 3 },
  });
  if (!res.ok()) throw new Error(`create character -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  await ctx.dispose();
  return body.id as number;
}

async function addCharacterItem(
  baseURL: string,
  characterId: number,
  name: string,
  qty = 1,
): Promise<number> {
  const { campaignId } = seed();
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL);
  const res = await ctx.post(`/api/v1/campaigns/${campaignId}/inventory`, {
    data: { name, qty, ownerType: 'character', characterId },
  });
  if (!res.ok()) throw new Error(`add inventory item -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  await ctx.dispose();
  return body.id as number;
}

async function restoreCharacter(baseURL: string, characterId: number) {
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL);
  await ctx.delete(`/api/v1/characters/${characterId}`);
  await ctx.dispose();
}

test.describe('Character sheet inventory (#454)', () => {
  test.use({ storageState: stateFor('dm') });

  test('shows real inventory and syncs qty changes with the campaign page', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const name = `INV454 ${Date.now()}`;
    const itemName = `INV454 Torch ${Date.now()}`;
    let characterId = 0;
    let itemId: number;

    try {
      characterId = await createCharacter(baseURL!, name);
      itemId = await addCharacterItem(baseURL!, characterId, itemName, 2);

      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=build&focus=inventory`);

      const section = page.getByTestId('character-inventory');
      await expect(section).toBeVisible();
      await expect(section.getByText('soon')).toHaveCount(0);
      await expect(section.getByText(itemName)).toBeVisible();
      await expect(section.getByText('×2')).toBeVisible();
      await expect(section.getByRole('link', { name: 'View party stash' })).toHaveAttribute(
        'href',
        `/c/${campaignId}/inventory`,
      );

      await section.getByRole('button', { name: `Increase ${itemName} quantity` }).click();
      await expect(section.getByText('×3')).toBeVisible();

      await page.goto(`/c/${campaignId}/inventory`);
      const row = page.locator(`#entity-item-${itemId}`);
      await expect(row).toBeVisible();
      await expect(row.getByText(itemName)).toBeVisible();
      await expect(row.getByText('×3')).toBeVisible();

      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=build&focus=inventory`);
      const moveSelect = section.getByRole('combobox', { name: `Move ${itemName}` });
      await moveSelect.selectOption('party');
      await expect(section.getByText(itemName)).toHaveCount(0);

      await page.goto(`/c/${campaignId}/inventory`);
      await expect(page.getByText(itemName)).toBeVisible();
      const partyRow = page.locator(`#entity-item-${itemId}`);
      await expect(partyRow.getByText('×3')).toBeVisible();
    } finally {
      if (characterId) await restoreCharacter(baseURL!, characterId);
    }
  });
});
