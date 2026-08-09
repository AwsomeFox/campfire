import { test, expect, request } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';
import { cockpitPanel, openCockpitTab } from '../lib/encounterCockpit';

/**
 * Issue #414 — multi-client structured action resolver (real DB + encounter UI).
 *
 * Client A (player) drives the Use flow in the run session; client B (DM API) seeds
 * the fight and verifies HP / spell-slot / undo semantics. Covers save-for-half via a
 * deterministic DC-1 fireball, resource spend + undo refund, and that a page reload
 * (reconnect) still shows the committed state.
 */
const scorchingRay = {
  name: 'Scorching Ray',
  kind: 'spell',
  toHit: '',
  damage: '6 fire',
  notes: 'Three rays of fire.',
  spec: {
    mode: 'save',
    save: { ability: 'DEX', dc: { kind: 'fixed', dc: 21 } },
    cost: { slot: 'action', count: 1 },
    uses: { spellLevel: 1 },
    targets: { count: 1, allow: 'enemy' },
    outcomes: { failure: { damage: [{ flat: 6, type: 'fire' }] }, success: { halfDamage: true } },
  },
};

test.describe('structured action resolver — multi-client', () => {
  test.use({ storageState: stateFor('player') });

  test('player previews, applies against a monster, undoes, and survives reload', async ({ page }) => {
    const { baseURL, campaignId } = seed();
    const dm = await request.newContext({ baseURL });
    let characterId: number | null = null;
    let encounterId: number | null = null;
    let monsterId: number | null = null;
    let monsterHp: number;
    try {
      await dm.post('/api/v1/auth/login', { data: CREDS.dm });
      const playerCtx = await request.newContext({ baseURL });
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
      const me = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = String(me.user.id);

      const character = await (
        await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'Resolver PC',
            level: 5,
            ownerUserId: playerUserId,
            ac: 14,
            hpCurrent: 30,
            hpMax: 30,
            stats: { DEX: 10 },
            actions: [scorchingRay],
            spellSlots: { '1': { max: 2, used: 0 } },
          },
        })
      ).json();
      characterId = character.id;

      const live = await (await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
      for (const e of live as { id: number }[]) await dm.post(`/api/v1/encounters/${e.id}/end`);

      const enc = await (
        await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Resolver drill', hidden: false } })
      ).json();
      encounterId = enc.id;
      const actorId = enc.combatants.find((c: { characterId: number | null }) => c.characterId === characterId)?.id;
      expect(actorId).toBeTruthy();

      const monRes = await dm.post(`/api/v1/encounters/${encounterId}/combatants`, {
        data: { kind: 'monster', name: 'Target Dummy', hpMax: 40 },
      });
      expect(monRes.ok(), `add monster: ${await monRes.text()}`).toBeTruthy();
      const mon = await monRes.json();
      monsterId = mon.id;
      monsterHp = mon.hpCurrent;
      const roster = (await (await dm.get(`/api/v1/encounters/${encounterId}`)).json()) as {
        combatants: Array<{ id: number }>;
      };
      for (const combatant of roster.combatants) {
        const initiative = combatant.id === actorId ? 99 : combatant.id === monsterId ? 50 : 1;
        const initiativeRes = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${combatant.id}`, {
          data: { initiative },
        });
        expect(initiativeRes.ok(), `set initiative for ${combatant.id}: ${await initiativeRes.text()}`).toBeTruthy();
      }
      const startRes = await dm.post(`/api/v1/encounters/${encounterId}/start`);
      expect(startRes.ok(), `start: ${await startRes.text()}`).toBeTruthy();
      expect((await startRes.json()).currentCombatantId).toBe(actorId);

      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      // The action's descriptive notes are on the roster's character card (Party); the
      // suggested-action list that starts the Use flow is the actor's turn workspace
      // (Turn). Both panels stay mounted, so each locator says which one it means.
      await openCockpitTab(page, 'party');
      await expect(cockpitPanel(page, 'party').getByText('Resolver PC', { exact: false }).first()).toBeVisible();
      await expect(cockpitPanel(page, 'party').getByTestId('action-notes')).toHaveText('Three rays of fire.');

      await openCockpitTab(page, 'turn');
      await cockpitPanel(page, 'turn').getByTestId('suggested-action-use').click();
      await expect(page.getByTestId('action-use-panel')).toBeVisible();
      await expect(page.getByTestId('action-use-targets').getByRole('button', { name: 'Target Dummy' })).toBeVisible();
      await page.getByTestId('action-use-targets').getByRole('button', { name: 'Target Dummy' }).click();
      await page.getByTestId('action-use-preview').click();
      await expect(page.getByTestId('action-use-preview-text')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('action-use-apply').click();
      await expect(page.getByTestId('undo-snackbar')).toBeVisible({ timeout: 10_000 });

      const afterApply = await dm.get(`/api/v1/encounters/${encounterId}`);
      const monsterAfter = (await afterApply.json()).combatants.find((c: { id: number }) => c.id === monsterId);
      expect(monsterAfter.hpCurrent).toBe(monsterHp - 6);
      const charAfter = await dm.get(`/api/v1/characters/${characterId}`);
      expect((await charAfter.json()).spellSlots['1'].used).toBe(1);

      await page.getByTestId('undo-snackbar').getByRole('button', { name: /undo/i }).click();
      const afterUndo = await dm.get(`/api/v1/encounters/${encounterId}`);
      expect(
        (await afterUndo.json()).combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent,
      ).toBe(monsterHp);
      expect((await (await dm.get(`/api/v1/characters/${characterId}`)).json()).spellSlots['1'].used).toBe(0);

      // Re-apply via API, then reload — committed state survives reconnect.
      await playerCtx.post(`/api/v1/encounters/${encounterId}/actions/resolve`, {
        data: { actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: true },
      });
      await page.reload();
      await openCockpitTab(page, 'party');
      await expect(cockpitPanel(page, 'party').getByText('Resolver PC', { exact: false }).first()).toBeVisible();
      const afterReload = await dm.get(`/api/v1/encounters/${encounterId}`);
      expect(
        (await afterReload.json()).combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent,
      ).toBe(monsterHp - 6);

      await playerCtx.dispose();
    } finally {
      if (encounterId != null) {
        await dm.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
        await dm.delete(`/api/v1/encounters/${encounterId}`);
      }
      if (characterId != null) await dm.delete(`/api/v1/characters/${characterId}`);
      await restoreSeedEncounter();
      await dm.dispose();
    }
  });
});
