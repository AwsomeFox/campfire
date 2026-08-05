import { expect, request, test } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #1465 — Player death save E2E test.
 *
 * Verifies that a player controlling a 0-HP dying character sees the prominent
 * turn death save card, can roll a death save, and that monster turns and rulesets
 * without death saves suppress the card.
 */
test.describe('encounter death saves (#1465)', () => {
  test.use({ storageState: stateFor('player') });

  test('0-HP player character renders death save card, allows rolling, and card is absent for monsters/other rulesets', async ({
    page,
  }) => {
    const { baseURL } = seed();
    const dmCtx = await request.newContext({ baseURL });
    const playerCtx = await request.newContext({ baseURL });

    let campaignId: number | null = null;
    let encounterId: number | null = null;
    let characterId: number | null = null;

    try {
      await dmCtx.post('/api/v1/auth/login', { data: CREDS.dm });
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });

      const mePlayer = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = mePlayer.user.id;

      const campaign = await (
        await dmCtx.post('/api/v1/campaigns', { data: { name: 'E2E — Death Save Campaign', ruleSystem: 'e2e-open5e-actions' } })
      ).json();
      campaignId = campaign.id;

      await dmCtx.post(`/api/v1/campaigns/${campaignId}/members`, {
        data: { userId: playerUserId, role: 'player' },
      });

      const character = await (
        await dmCtx.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'Dying Hero',
            className: 'Paladin',
            level: 4,
            ownerUserId: String(playerUserId),
            hpCurrent: 0,
            hpMax: 30,
            stats: { CON: 14 },
          },
        })
      ).json();
      characterId = character.id;

      const encounter = await (
        await dmCtx.post(`/api/v1/campaigns/${campaignId}/encounters`, {
          data: { name: 'Dying Hero Fight', hidden: false },
        })
      ).json();
      encounterId = encounter.id;

      const pcCombatant = (
        encounter.combatants as Array<{ id: number; characterId: number | null }>
      ).find((c) => c.characterId === characterId);
      if (!pcCombatant) throw new Error('Expected auto-added PC combatant');

      const monster = await (
        await dmCtx.post(`/api/v1/encounters/${encounterId}/combatants`, {
          data: { kind: 'monster', name: 'Goblin Executioner', hpMax: 15 },
        })
      ).json();

      await dmCtx.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
      await dmCtx.patch(`/api/v1/encounters/${encounterId}/combatants/${pcCombatant.id}`, {
        data: { initiative: 50, hpSet: 0, deathSaveSuccesses: 0, deathSaveFailures: 0, deathState: 'dying' },
      });
      await dmCtx.patch(`/api/v1/encounters/${encounterId}/combatants/${monster.id}`, {
        data: { initiative: 10 },
      });
      await dmCtx.post(`/api/v1/encounters/${encounterId}/start`);

      // Open encounter page as Player
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();

      // PC has turn -> prominent death save card must be visible
      const card = page.getByTestId('turn-death-save-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(/Unconscious & Dying/i);

      const rollBtn = page.getByTestId('turn-roll-death-save');
      await expect(rollBtn).toBeVisible();
      await expect(rollBtn).toBeEnabled();

      // Roll death save — wait for the actual mutation response (not just the click) and
      // assert against its outcome. A natural 20 revives the combatant with 1 HP, which
      // flips `deathState` off 'dying' and removes the card (TurnWorkspace.tsx: `isDying =
      // deathState === 'dying'`); 3 accumulated failures resolves to 'dead' the same way.
      // Asserting an unconditional "card still visible" here is both vacuous (it passes
      // even if the roll silently no-oped) and a ~1-in-20 flake on a natural 20.
      const [rollResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/death-save') && res.request().method() === 'POST',
        ),
        rollBtn.click(),
      ]);
      expect(rollResponse.ok(), 'death-save roll request must succeed').toBe(true);
      const rollBody = (await rollResponse.json()) as {
        combatant: { deathState: string; deathSaveSuccesses: number; deathSaveFailures: number; hpCurrent: number | null };
      };

      if (rollBody.combatant.deathState === 'dying') {
        // Still dying: the card stays, and the roll must have moved a real counter.
        await expect(card).toBeVisible();
        expect(
          rollBody.combatant.deathSaveSuccesses + rollBody.combatant.deathSaveFailures,
          'a death-save roll that keeps deathState=dying must increment a success or failure counter',
        ).toBeGreaterThan(0);
      } else {
        // Resolved this roll (natural 20 revival, 3rd success -> stable, or 3rd failure ->
        // dead): the card must disappear because isDying is now false.
        expect(['stable', 'dead', 'none']).toContain(rollBody.combatant.deathState);
        await expect(page.getByTestId('turn-death-save-card')).toHaveCount(0);
      }

      // Case A: Monster turn -> death save card must be absent regardless of the roll
      // outcome above (the PC no longer holds the turn either way). If the roll above
      // already resolved the PC (natural 20, 3rd success/failure), the card is absent
      // regardless of whose turn it is, so a failed/no-op next-turn here would still let
      // this assertion pass without ever proving the turn actually moved — assert the
      // request succeeded AND that `currentCombatantId` genuinely advanced to the monster
      // (the card's own gate is `turn.current.deathState === 'dying'`, TurnWorkspace.tsx),
      // so this case exercises real monster-turn suppression even in the resolved branch.
      const nextTurnRes = await dmCtx.post(`/api/v1/encounters/${encounterId}/next-turn`);
      expect(nextTurnRes.ok(), 'next-turn request must succeed').toBe(true);
      const nextTurnBody = (await nextTurnRes.json()) as { currentCombatantId: number | null };
      expect(nextTurnBody.currentCombatantId, 'turn must have advanced to the monster').toBe(monster.id);
      await page.reload();
      await expect(page.getByTestId('turn-death-save-card')).toHaveCount(0);

    } finally {
      if (encounterId && campaignId) {
        await dmCtx.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
        await dmCtx.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
      }
      if (characterId) await dmCtx.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
      if (campaignId) await dmCtx.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);

      await dmCtx.dispose();
      await playerCtx.dispose();
    }
  });

  test('death save card is absent for rulesets without death saves (Open Legend)', async ({ page }) => {
    const { baseURL } = seed();
    const dmCtx = await request.newContext({ baseURL });
    const playerCtx = await request.newContext({ baseURL });

    let campaignId: number | null = null;
    let encounterId: number | null = null;
    let characterId: number | null = null;

    try {
      await dmCtx.post('/api/v1/auth/login', { data: CREDS.dm });
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });

      const mePlayer = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = mePlayer.user.id;

      // Open Legend has no 5e-style death saves
      const campRes = await dmCtx.post('/api/v1/campaigns', { data: { name: 'E2E — Open Legend', ruleSystem: 'open-legend' } });
      expect(campRes.ok()).toBe(true);
      const campaign = await campRes.json();
      campaignId = campaign.id;

      await dmCtx.post(`/api/v1/campaigns/${campaignId}/members`, {
        data: { userId: playerUserId, role: 'player' },
      });

      // Mirror the first test's fixture — a 0-HP, `dying` PC holding the turn — so the
      // only variable is the ruleset. Without a dying PC in the encounter, `isDying` is
      // false regardless of the ruleset gate, and the absence assertion below would pass
      // even if the Open Legend death-save suppression were completely broken.
      const character = await (
        await dmCtx.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'OL Dying Hero',
            className: 'Adept',
            level: 4,
            ownerUserId: String(playerUserId),
            hpCurrent: 0,
            hpMax: 20,
            stats: { CON: 14 },
          },
        })
      ).json();
      characterId = character.id;

      const encounter = await (
        await dmCtx.post(`/api/v1/campaigns/${campaignId}/encounters`, {
          data: { name: 'OL Fight', hidden: false },
        })
      ).json();
      encounterId = encounter.id;

      const pcCombatant = (
        encounter.combatants as Array<{ id: number; characterId: number | null }>
      ).find((c) => c.characterId === characterId);
      if (!pcCombatant) throw new Error('Expected auto-added PC combatant');

      const monster = await (
        await dmCtx.post(`/api/v1/encounters/${encounterId}/combatants`, {
          data: { kind: 'monster', name: 'OL Monster', hpMax: 20 },
        })
      ).json();

      await dmCtx.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
      const dyingPatchRes = await dmCtx.patch(`/api/v1/encounters/${encounterId}/combatants/${pcCombatant.id}`, {
        data: { initiative: 50, hpSet: 0, deathSaveSuccesses: 0, deathSaveFailures: 0, deathState: 'dying' },
      });
      // If this write 400s/no-ops, the PC silently stays a healthy `none` combatant, which
      // would ALSO suppress the card — for reasons unrelated to the ruleset gate this test
      // exists to cover. Assert success and the resulting state directly from the response
      // body, rather than trusting the request landed.
      expect(dyingPatchRes.ok(), 'setting deathState=dying on the Open Legend PC must succeed').toBe(true);
      const dyingPatchBody = (await dyingPatchRes.json()) as { deathState: string; hpCurrent: number | null };
      expect(dyingPatchBody.deathState).toBe('dying');
      expect(dyingPatchBody.hpCurrent).toBe(0);
      await dmCtx.patch(`/api/v1/encounters/${encounterId}/combatants/${monster.id}`, {
        data: { initiative: 10 },
      });
      await dmCtx.post(`/api/v1/encounters/${encounterId}/start`);

      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();

      // Card must be absent even though this combatant is 0-HP and `dying` — Open Legend
      // has no 5e-style death saves, so `hasDeathSavesForAdapter` must gate the card off.
      await expect(page.getByTestId('turn-death-save-card')).toHaveCount(0);
    } finally {
      if (encounterId && campaignId) {
        await dmCtx.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
        await dmCtx.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
      }
      if (characterId) await dmCtx.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
      if (campaignId) await dmCtx.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);

      await dmCtx.dispose();
      await playerCtx.dispose();
    }
  });
});
