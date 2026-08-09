import { test, expect, request } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';
import { openCockpitTab } from '../lib/encounterCockpit';

/**
 * Issue #487 — a player whose character has the turn can end it from the combatant row
 * (and the turn workspace), without waiting for the DM's "Next turn →".
 */
test.describe('player end turn (issue #487)', () => {
  test.use({ storageState: stateFor('player') });

  test('player ends their turn from the workspace and advancing yields the next actor', async ({ page }) => {
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
      const character = await (
        await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'Turn Yielder',
            className: 'Fighter',
            level: 3,
            ownerUserId: playerUserId,
            hpCurrent: 30,
            hpMax: 30,
            stats: { DEX: 18 },
          },
        })
      ).json();
      characterId = character.id;

      const live = await (await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
      for (const e of live as { id: number }[]) {
        await dm.post(`/api/v1/encounters/${e.id}/end`);
      }

      const enc = await (
        await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'End-turn drill', hidden: false } })
      ).json();
      encounterId = enc.id;
      const heroCombatant = (enc.combatants as Array<{ id: number; characterId: number | null }>).find(
        (c) => c.characterId === characterId,
      );
      if (!heroCombatant) throw new Error('expected auto-added hero combatant');

      const dummy = await (
        await dm.post(`/api/v1/encounters/${enc.id}/combatants`, {
          data: { kind: 'monster', name: 'Straw Dummy', hpMax: 20 },
        })
      ).json();

      // Create auto-adds every active party PC; /start rejects any null initiative.
      // Pin turn order so End my turn yields the dummy next (not another PC).
      const rollInitRes = await dm.post(`/api/v1/encounters/${enc.id}/roll-initiative`);
      expect(rollInitRes.ok(), `roll initiative: ${await rollInitRes.text()}`).toBeTruthy();
      const roster = await (await dm.get(`/api/v1/encounters/${enc.id}`)).json() as {
        combatants: Array<{ id: number }>;
      };
      for (const c of roster.combatants) {
        let initiative = 0;
        if (c.id === heroCombatant.id) initiative = 99;
        else if (c.id === dummy.id) initiative = 50;
        const patchRes = await dm.patch(`/api/v1/encounters/${enc.id}/combatants/${c.id}`, {
          data: { initiative },
        });
        expect(patchRes.ok(), `set initiative for ${c.id}: ${await patchRes.text()}`).toBeTruthy();
      }
      const startRes = await dm.post(`/api/v1/encounters/${enc.id}/start`);
      expect(startRes.ok(), `start encounter: ${await startRes.text()}`).toBeTruthy();

      await page.goto(`/c/${campaignId}/encounters/${enc.id}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();

      // A player's own End turn lives in the cockpit's Turn tab.
      await openCockpitTab(page, 'turn');
      const endTurnBtn = page.getByTestId('workspace-end-turn');
      await expect(endTurnBtn).toBeVisible();
      await expect(endTurnBtn).toHaveText(/End (?:my )?turn/i);

      await endTurnBtn.click();
      await openCockpitTab(page, 'party');
      await expect(page.getByTestId(`combatant-row-${dummy.id}`)).toHaveAttribute('data-current-turn', 'true');
      await expect(endTurnBtn).toHaveCount(0);
    } finally {
      if (encounterId != null) {
        await dm.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
        await dm.delete(`/api/v1/encounters/${encounterId}`);
      }
      if (characterId != null) await dm.delete(`/api/v1/characters/${characterId}`);
      await restoreSeedEncounter();
      await playerCtx.dispose();
      await dm.dispose();
    }
  });
});
