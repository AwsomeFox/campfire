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

      // Roll death save
      await rollBtn.click();

      // Card counter updates or turns end
      await expect(card).toBeVisible();

      // Case A: Monster turn -> death save card must be absent
      await dmCtx.post(`/api/v1/encounters/${encounterId}/next-turn`);
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

    try {
      await dmCtx.post('/api/v1/auth/login', { data: CREDS.dm });
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });

      const mePlayer = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = mePlayer.user.id;

      // Open Legend has no 5e-style death saves
      const campaign = await (
        await dmCtx.post('/api/v1/campaigns', { data: { name: 'E2E — Open Legend', ruleSystem: 'open-legend' } })
      ).json();
      campaignId = campaign.id;

      await dmCtx.post(`/api/v1/campaigns/${campaignId}/members`, {
        data: { userId: playerUserId, role: 'player' },
      });

      const encounter = await (
        await dmCtx.post(`/api/v1/campaigns/${campaignId}/encounters`, {
          data: { name: 'OL Fight', hidden: false },
        })
      ).json();
      encounterId = encounter.id;

      await dmCtx.post(`/api/v1/encounters/${encounterId}/combatants`, {
        data: { kind: 'monster', name: 'OL Monster', hpMax: 20 },
      });

      await dmCtx.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
      await dmCtx.post(`/api/v1/encounters/${encounterId}/start`);

      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();

      // Card must be absent
      await expect(page.getByTestId('turn-death-save-card')).toHaveCount(0);
    } finally {
      if (encounterId && campaignId) {
        await dmCtx.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
        await dmCtx.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
      }
      if (campaignId) await dmCtx.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);

      await dmCtx.dispose();
      await playerCtx.dispose();
    }
  });
});
