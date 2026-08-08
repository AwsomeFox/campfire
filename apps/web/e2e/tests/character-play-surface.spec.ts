import { expect, request, test } from '@playwright/test';
import { CREDS } from '../global-setup';
import { seed, stateFor } from './seed';

/**
 * The character sheet's play surface, from the Claude Design template
 * `templates/character-sheet/CharacterSheet.dc.html`.
 *
 * Three claims that only a real browser can settle:
 *  - the vitals rail (HP, temp HP, conditions, rests) is OUTSIDE both tabpanels, so it
 *    survives a switch to Build — the whole reason the template pulls it into a rail;
 *  - an ability score rolls a server-resolved catalog check, like Skills and Saves,
 *    rather than a modifier the sheet computed for itself;
 *  - temp HP is its own pool, PATCHed on the character, not folded into POST /hp.
 */
test.describe('character sheet play surface', () => {
  test.use({ storageState: stateFor('dm') });

  test('the vitals rail stays put across a tab switch', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const rail = page.getByTestId('character-vitals-rail');
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Hit points & Defenses' })).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Conditions' })).toBeVisible();
    await expect(page.getByTestId('character-vitals')).toBeVisible();

    await page.getByRole('tab', { name: /Build & profile/ }).click();
    await expect(page.getByTestId('character-sheet-panel-build')).toBeVisible();
    // The Play panel is hidden, the rail is not.
    await expect(page.getByTestId('character-sheet-panel-play')).toBeHidden();
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Hit points & Defenses' })).toBeVisible();
  });

  test('an ability score rolls a catalog check server-side', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const dex = page.getByRole('button', { name: /^Roll DEX check/ });
    await expect(dex).toBeVisible();

    // The sheet must not roll this itself: the modifier and the die both come from
    // POST /characters/:id/checks/roll, the same endpoint Skills and Saves use.
    const rolled = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/v1/characters/${navigation.characterId}/checks/roll`) &&
        res.request().method() === 'POST',
    );
    await dex.click();
    const response = await rolled;
    expect(response.ok()).toBeTruthy();
    expect(JSON.parse(response.request().postData() ?? '{}')).toMatchObject({ checkId: 'ability:DEX' });
  });

  test('temp HP is a separate pool, patched on the character', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const value = page.getByTestId('character-temp-hp-value');
    await expect(value).toHaveText('0');

    const patched = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/v1/characters/${navigation.characterId}`) &&
        res.request().method() === 'PATCH',
    );
    await page.getByTestId('character-temp-hp').getByRole('button', { name: /Add 1 temporary hit point/ }).click();
    const response = await patched;
    expect(JSON.parse(response.request().postData() ?? '{}')).toEqual({ hpTemp: 1 });
    await expect(value).toHaveText('1');

    // Restore, so the shared seeded character is left as it was found.
    const ctx = await request.newContext({ baseURL: new URL(page.url()).origin });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    await ctx.patch(`/api/v1/characters/${navigation.characterId}`, { data: { hpTemp: 0 } });
    await ctx.dispose();
  });

  /**
   * An equipped item's `equippedAction` is already usable in an encounter. Before this,
   * the sheet listed only `character.actions`, so a geared character's options were
   * invisible outside combat — the gap the template's 🎒 chips close.
   */
  test('an equipped item\'s action appears in Actions, and is locked while stowed', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });

    const characterRes = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Play Surface Gear Test', className: 'Fighter', level: 3 },
    });
    expect(characterRes.ok()).toBeTruthy();
    const characterId = (await characterRes.json()).id as number;

    try {
      const itemRes = await ctx.post(`/api/v1/campaigns/${campaignId}/inventory`, {
        data: { name: 'Flame Tongue Shortsword', qty: 1, ownerType: 'character', characterId },
      });
      expect(itemRes.ok()).toBeTruthy();
      const itemId = (await itemRes.json()).id as number;
      const equipped = await ctx.patch(`/api/v1/inventory/${itemId}`, {
        data: {
          equipped: true,
          equipSlot: 'main hand',
          equippedAction: { name: 'Flame Tongue Strike', kind: 'melee', toHit: '+6', damage: '1d6+2', notes: '', targetAc: '' },
        },
      });
      expect(equipped.ok()).toBeTruthy();

      await page.goto(`/c/${campaignId}/characters/${characterId}`);
      const gear = page.getByTestId('character-granted-actions');
      await expect(gear.getByText('Flame Tongue Strike')).toBeVisible();
      await expect(gear.getByRole('button', { name: /Flame Tongue Shortsword/ })).toBeVisible();
      // Equipped: the action is rollable from the sheet.
      await expect(gear.getByRole('button', { name: /to hit \+6/ })).toBeVisible();

      // The 🎒 chip is the template's cross-navigation into the pack it came from.
      await gear.getByRole('button', { name: /Flame Tongue Shortsword/ }).click();
      await expect(page).toHaveURL(/tab=build/);
      await expect(page.getByTestId('character-inventory')).toBeVisible();

      // Stowed: still listed (so "why can't I use this?" is answerable), but not rollable.
      const unequipped = await ctx.patch(`/api/v1/inventory/${itemId}`, { data: { equipped: false } });
      expect(unequipped.ok()).toBeTruthy();
      // ?tab=play explicitly: the 🎒 chip above persisted Build as this sheet's last tab.
      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      await expect(gear.getByText('Flame Tongue Strike')).toBeVisible();
      await expect(gear.getByText('Equip Flame Tongue Shortsword to use this action.')).toBeVisible();
      await expect(gear.getByRole('button', { name: /to hit \+6/ })).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });
});
