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
      // Issue #744: a campaign can have at most one live fight. The seeded "Ambush"
      // encounter is RUNNING and must stay running for the combat-tracker suite, so end
      // it before this drill starts and reopen it in the finally block below (/reopen
      // preserves round/turnIndex — the seed fight is still at Round 1 with its seeded
      // initiatives intact).
      const live = await (await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
      for (const e of live as { id: number }[]) {
        await dm.post(`/api/v1/encounters/${e.id}/end`);
      }
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
      // Issue #744: the seeded "Ambush" encounter was ended above so the drill could
      // start; reopen it so the combat-tracker suite finds it RUNNING again. Safe to
      // call unconditionally — /reopen 400s on a non-'ended' status, which we ignore.
      // Restoring the seed fight keeps the one-live-fight invariant intact for every
      // subsequent serial spec that assumes a single RUNNING encounter.
      const seedEncounterId = seed().encounterId;
      await dm.post(`/api/v1/encounters/${seedEncounterId}/reopen`).catch(() => undefined);
      // Dispose the API contexts so they don't leak across the worker.
      await playerCtx.dispose();
      await dm.dispose();
    }
  });
});
