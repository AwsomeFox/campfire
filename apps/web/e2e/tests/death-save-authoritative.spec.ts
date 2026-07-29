import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #1462 — a player reaches both death-save controls through the same
 * server-authoritative endpoint. Server E2E covers the random d20 outcomes;
 * these browser cases pin the two resulting UI states so they are not flaky.
 */

type Outcome = 'stable' | 'dead';

interface Drill {
  characterId: number;
  encounterId: number;
  combatantId: number;
  name: string;
}

async function startDrill(dm: APIRequestContext, campaignId: number | string, playerUserId: string, outcome: Outcome): Promise<Drill> {
  const name = `Death save ${outcome}`;
  const character = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name, className: 'Fighter', level: 3, ownerUserId: playerUserId, hpCurrent: 12, hpMax: 12, stats: { DEX: 16 } },
    })
  ).json();
  const characterId = character.id as number;

  const live = await (await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
  for (const encounter of live as Array<{ id: number }>) await dm.post(`/api/v1/encounters/${encounter.id}/end`);

  const encounter = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name, hidden: false } })
  ).json();
  const encounterId = encounter.id as number;
  const combatantId = (encounter.combatants as Array<{ id: number; characterId: number | null }>).find(
    (combatant) => combatant.characterId === characterId,
  )?.id;
  if (combatantId == null) throw new Error('expected the player character to be auto-added');

  const roster = await (await dm.get(`/api/v1/encounters/${encounterId}`)).json() as { combatants: Array<{ id: number }> };
  for (const combatant of roster.combatants) {
    const res = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${combatant.id}`, {
      data: { initiative: combatant.id === combatantId ? 99 : 1 },
    });
    expect(res.ok(), `set initiative for ${combatant.id}: ${await res.text()}`).toBeTruthy();
  }
  const start = await dm.post(`/api/v1/encounters/${encounterId}/start`);
  expect(start.ok(), `start encounter: ${await start.text()}`).toBeTruthy();
  expect((await start.json()).currentCombatantId).toBe(combatantId);

  const dying = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`, {
    data: outcome === 'stable'
      ? { hpSet: 0, deathSaveSuccesses: 2 }
      : { hpSet: 0, deathSaveFailures: 2 },
  });
  expect(dying.ok(), `set dying state: ${await dying.text()}`).toBeTruthy();
  return { characterId, encounterId, combatantId, name };
}

async function stubAuthoritativeResult(page: Page, drill: Drill, outcome: Outcome): Promise<void> {
  let deathSaveRequested = false;
  await page.route(`**/api/v1/encounters/${drill.encounterId}/combatants/${drill.combatantId}/death-save`, async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({});
    deathSaveRequested = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        combatant: { id: drill.combatantId },
        roll: { id: 1, expr: '1d20', rolls: [outcome === 'stable' ? 10 : 1], total: outcome === 'stable' ? 10 : 1 },
      }),
    });
  });
  await page.route(`**/api/v1/encounters/${drill.encounterId}`, async (route) => {
    const response = await route.fetch();
    const encounter = await response.json() as { combatants: Array<Record<string, unknown>> };
    if (deathSaveRequested) {
      const combatant = encounter.combatants.find((item) => item.id === drill.combatantId)!;
      Object.assign(
        combatant,
        outcome === 'stable'
          ? { hpCurrent: 0, deathState: 'stable', deathSaveSuccesses: 3, deathSaveFailures: 0 }
          : { hpCurrent: 0, deathState: 'dead', deathSaveSuccesses: 0, deathSaveFailures: 3 },
      );
    }
    await route.fulfill({ response, json: encounter });
  });
}

async function cleanup(dm: APIRequestContext, drill: Drill | null): Promise<void> {
  if (drill != null) {
    await dm.post(`/api/v1/encounters/${drill.encounterId}/end`).catch(() => undefined);
    await dm.delete(`/api/v1/encounters/${drill.encounterId}`).catch(() => undefined);
    await dm.delete(`/api/v1/characters/${drill.characterId}`).catch(() => undefined);
  }
  await restoreSeedEncounter();
}

test.describe('authoritative player death saves (#1462)', () => {
  test.use({ storageState: stateFor('player') });

  for (const testCase of [
    { outcome: 'stable' as const, control: 'workspace' as const, expected: 'Stable' },
    { outcome: 'dead' as const, control: 'row' as const, expected: 'Dead' },
  ]) {
    test(`player ${testCase.outcome}s through the ${testCase.control} action without choosing a d20`, async ({ page }) => {
      const { baseURL, campaignId } = seed();
      const player = await request.newContext({ baseURL });
      const dm = await request.newContext({ baseURL });
      let drill: Drill | null = null;
      try {
        await player.post('/api/v1/auth/login', { data: CREDS.player });
        const playerUserId = String((await (await player.get('/api/v1/me')).json()).user.id);
        await dm.post('/api/v1/auth/login', { data: CREDS.dm });
        drill = await startDrill(dm, campaignId, playerUserId, testCase.outcome);
        await stubAuthoritativeResult(page, drill, testCase.outcome);

        await page.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
        await expect(page.getByText('Running', { exact: true })).toBeVisible();
        const row = page.getByTestId(`combatant-row-${drill.combatantId}`);
        await expect(row).toContainText(drill.name);

        if (testCase.control === 'workspace') {
          await page.getByTestId('turn-roll-death-save').click();
        } else {
          await row.getByRole('button', { name: 'Roll a death save' }).click();
        }

        await expect(row).toContainText(testCase.expected);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
        await cleanup(dm, drill);
        await player.dispose();
        await dm.dispose();
      }
    });
  }
});
