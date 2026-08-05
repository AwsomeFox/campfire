import { test, expect, request } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';

test.describe('turn-change beat (issue #1906)', () => {
  test('shows the owner takeover and the other client ticker from one turn frame', async ({ browser }) => {
    const { baseURL, campaignId } = seed();
    const dmApi = await request.newContext({ baseURL });
    const playerApi = await request.newContext({ baseURL });
    const playerContext = await browser.newContext({ storageState: stateFor('player') });
    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const playerPage = await playerContext.newPage();
    const dmPage = await dmContext.newPage();
    let characterId: number | null = null;
    let encounterId: number | null = null;

    try {
      await playerApi.post('/api/v1/auth/login', { data: CREDS.player });
      const playerUserId = String((await (await playerApi.get('/api/v1/me')).json()).user.id);
      await dmApi.post('/api/v1/auth/login', { data: CREDS.dm });

      const character = await (await dmApi.post(`/api/v1/campaigns/${campaignId}/characters`, {
        data: {
          name: 'Turn Beat Hero', className: 'Fighter', level: 3, ownerUserId: playerUserId,
          hpCurrent: 30, hpMax: 30, stats: { DEX: 18 },
        },
      })).json();
      characterId = character.id;

      const live = await (await dmApi.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
      for (const encounter of live as Array<{ id: number }>) await dmApi.post(`/api/v1/encounters/${encounter.id}/end`);

      const encounter = await (await dmApi.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'Turn beat drill', hidden: false },
      })).json();
      encounterId = encounter.id;
      const hero = (encounter.combatants as Array<{ id: number; characterId: number | null }>).find(
        (combatant) => combatant.characterId === characterId,
      );
      if (!hero) throw new Error('expected the player character in the encounter');
      const dummy = await (await dmApi.post(`/api/v1/encounters/${encounterId}/combatants`, {
        data: { kind: 'monster', name: 'Ticker Dummy', hpMax: 20 },
      })).json();

      // Keep the turn order deterministic: the second advance must be the
      // monster frame that clears the player's takeover.
      const preRollRoster = await (await dmApi.get(`/api/v1/encounters/${encounterId}`)).json() as { combatants: Array<{ id: number }> };
      for (const combatant of preRollRoster.combatants) {
        if (combatant.id !== hero.id && combatant.id !== dummy.id) {
          await dmApi.delete(`/api/v1/encounters/${encounterId}/combatants/${combatant.id}`);
        }
      }
      await dmApi.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
      const roster = await (await dmApi.get(`/api/v1/encounters/${encounterId}`)).json() as { combatants: Array<{ id: number }> };
      for (const combatant of roster.combatants) {
        const initiative = combatant.id === dummy.id ? 99 : combatant.id === hero.id ? 50 : 0;
        await dmApi.patch(`/api/v1/encounters/${encounterId}/combatants/${combatant.id}`, { data: { initiative } });
      }
      await dmApi.post(`/api/v1/encounters/${encounterId}/start`);

      await Promise.all([
        playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`),
        dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`),
      ]);
      await expect(playerPage.getByText('Running', { exact: true })).toBeVisible();
      await expect(dmPage.getByTestId('encounter-header-next-turn')).toBeVisible();

      await dmPage.getByTestId('encounter-header-next-turn').click();
      await expect(playerPage.getByTestId('turn-takeover')).toContainText("YOU'RE UP — Turn Beat Hero");
      await expect(dmPage.getByTestId('turn-ticker')).toContainText("Turn Beat Hero's turn");

      await playerPage.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(playerPage).toHaveTitle(/^● Your turn — /);
      await playerPage.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(playerPage).not.toHaveTitle(/^● Your turn — /);
      await dmPage.getByTestId('encounter-header-next-turn').click();
      await expect(playerPage.getByTestId('turn-ticker')).toContainText('Round 2');
      await expect(playerPage.getByTestId('turn-takeover')).toHaveCount(0);
      await expect(playerPage.getByTestId('turn-takeover')).toHaveCount(0, { timeout: 4_000 });

      // Re-enter an owned turn, then end the fight over SSE. An ended encounter
      // must clear the hidden-tab ownership state even though it has no turn edge.
      await dmPage.getByTestId('encounter-header-next-turn').click();
      await expect(playerPage.getByTestId('turn-takeover')).toContainText("YOU'RE UP — Turn Beat Hero");
      await playerPage.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(playerPage).toHaveTitle(/^● Your turn — /);
      await dmApi.post(`/api/v1/encounters/${encounterId}/end`);
      await expect(playerPage).not.toHaveTitle(/^● Your turn — /);
    } finally {
      if (encounterId != null) {
        await dmApi.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
        await dmApi.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
      }
      if (characterId != null) await dmApi.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
      await restoreSeedEncounter();
      await dmApi.dispose();
      await playerApi.dispose();
      await dmContext.close();
      await playerContext.close();
    }
  });
});
