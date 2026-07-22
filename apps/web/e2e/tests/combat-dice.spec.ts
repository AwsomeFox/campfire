import { test, expect, request } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Encounter click-to-roll + one-tap apply-damage (the interactive character card).
 *
 * Uses its OWN freshly-created encounter (not the shared seed encounter the
 * combat-tracker spec asserts on) so adding a character/monster here can't perturb
 * that spec's exact-combatant assertions.
 */
test.describe('encounter dice — apply rolled damage', () => {
  test.use({ storageState: stateFor('player') });

  test('a player rolls damage from their card and one-taps it onto an editable target', async ({ page }) => {
    const { baseURL, campaignId } = seed();

    const playerCtx = await request.newContext({ baseURL });
    const dm = await request.newContext({ baseURL });
    let characterId: number | null = null;
    let encounterId: number | null = null;
    try {
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
      const me = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = String(me.user.id);

      await dm.post('/api/v1/auth/login', { data: CREDS.dm });
      // A player-owned character with a 2d6+4 attack — always rolls >= 6, so a damage
      // total is always positive and the apply bar always appears.
      const character = await (
        await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'Brixi Applybar',
            species: 'Human',
            className: 'Fighter',
            level: 5,
            ownerUserId: playerUserId,
            ac: 18,
            hpCurrent: 45,
            hpMax: 45,
            stats: { STR: 18, DEX: 14, CON: 16, INT: 10, WIS: 12, CHA: 8 },
            saveProficiencies: ['STR'],
            actions: [{ name: 'Greatsword', kind: 'melee', toHit: '+7', damage: '2d6+4 slashing', notes: '' }],
          },
        })
      ).json();
      expect(character.id).toBeTruthy();
      characterId = character.id;
      // A fresh encounter auto-adds the active character; add a monster the player can't edit.
      const enc = await (await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Apply-bar drill' } })).json();
      encounterId = enc.id;
      await dm.post(`/api/v1/encounters/${enc.id}/combatants`, { data: { kind: 'monster', name: 'Straw Dummy', hpMax: 30 } });
      await dm.post(`/api/v1/encounters/${enc.id}/start`);

      await page.goto(`/c/${campaignId}/encounters/${enc.id}`);
      // The player's own card auto-expands, so the attack is visible without expanding.
      await expect(page.getByText('Brixi Applybar', { exact: false }).first()).toBeVisible();

      // Roll the Greatsword damage from the owned (interactive) card.
      await page.getByRole('button', { name: '2d6+4 slashing' }).click();
      const applyBar = page.getByRole('group', { name: /rolled/i });
      await expect(applyBar).toBeVisible();

      // A player may only apply to combatants they control — their own character, not the monster.
      await expect(applyBar.getByRole('button', { name: 'Straw Dummy' })).toHaveCount(0);
      await expect(applyBar.getByRole('button', { name: 'Brixi Applybar' })).toBeVisible();

      // Apply → HP drops, the combat log records the damage, and the bar dismisses.
      await applyBar.getByRole('button', { name: 'Brixi Applybar' }).click();
      await expect(applyBar).toHaveCount(0);
      await expect(page.getByText(/Brixi Applybar took \d+ damage/i)).toBeVisible();
    } finally {
      if (encounterId != null) await dm.delete(`/api/v1/encounters/${encounterId}`);
      if (characterId != null) await dm.delete(`/api/v1/characters/${characterId}`);
      // Dispose the API contexts so they don't leak across the worker.
      await playerCtx.dispose();
      await dm.dispose();
    }
  });
});
