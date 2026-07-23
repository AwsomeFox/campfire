import { test, expect, request } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';

/**
 * Multi-client sheet → encounter card refresh (issue #421).
 *
 * Client A watches the run session; client B patches the sheet over REST.
 * The expanded card must show the new modifier and roll that updated value
 * without a hard reload.
 */
test.describe('inline character cards — live sheet refresh', () => {
  test.use({ storageState: stateFor('player') });

  test('sheet edit during a running encounter updates the card and rolls the new mod', async ({ page }) => {
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
            name: 'Sheet Sync PC',
            species: 'Human',
            className: 'Fighter',
            level: 5,
            ownerUserId: playerUserId,
            ac: 16,
            hpCurrent: 40,
            hpMax: 40,
            stats: { STR: 10, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
            saveProficiencies: ['STR'],
            actions: [{ name: 'Mace', kind: 'melee', toHit: '+2', damage: '1d6+0 bludgeoning', notes: '' }],
          },
        })
      ).json();
      characterId = character.id;

      const live = await (await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
      for (const e of live as { id: number }[]) {
        await dm.post(`/api/v1/encounters/${e.id}/end`);
      }
      const enc = await (
        await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Sheet sync drill', hidden: false } })
      ).json();
      encounterId = enc.id;
      await dm.post(`/api/v1/encounters/${enc.id}/start`);

      await page.goto(`/c/${campaignId}/encounters/${enc.id}`);
      await expect(page.getByText('Sheet Sync PC', { exact: false }).first()).toBeVisible();
      // Ability chips render as "STR" + "10 (+0)" inside a button (owned card auto-expands).
      const strChip = page.getByRole('button', { name: /STR\s*10\s*\(\+0\)/i });
      await expect(strChip).toBeVisible();

      // Client B: patch the sheet while the run-session tab stays open.
      const patched = await dm.patch(`/api/v1/characters/${characterId}`, {
        data: { stats: { STR: 18, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 } },
      });
      expect(patched.ok()).toBeTruthy();
      expect((await patched.json()).stats.STR).toBe(18);

      // SSE character.updated → invalidate → card shows STR 18 (+4) without reload.
      const updatedStr = page.getByRole('button', { name: /STR\s*18\s*\(\+4\)/i });
      await expect(updatedStr).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /STR\s*10\s*\(\+0\)/i })).toHaveCount(0);

      await updatedStr.click();
      // Roll banner should show the STR check; announcer also echoes it (avoid strict-mode dual match).
      await expect(page.getByText('Sheet Sync PC · STR check', { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/1d20\+4/i).first()).toBeVisible();
    } finally {
      // End before delete so a failed DELETE cannot leave a RUNNING fight that
      // blocks restoreSeedEncounter's /reopen (ENCOUNTER_ALREADY_RUNNING, #744).
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
