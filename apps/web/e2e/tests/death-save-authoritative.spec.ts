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

  const dying = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`, { data: { hpSet: 0 } });
  expect(dying.ok(), `set dying state: ${await dying.text()}`).toBeTruthy();
  return { characterId, encounterId, combatantId, name };
}

async function stubAuthoritativeResult(page: Page, drill: Drill, outcome: Outcome): Promise<{ requestCount: () => number }> {
  let requestCount = 0;
  const face = outcome === 'stable' ? 10 : 2;
  await page.route(`**/api/v1/encounters/${drill.encounterId}/combatants/${drill.combatantId}/death-save`, async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({});
    requestCount += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        combatant: { id: drill.combatantId },
        roll: { id: requestCount, expr: '1d20', rolls: [face], total: face },
      }),
    });
  });
  await page.route(`**/api/v1/encounters/${drill.encounterId}`, async (route) => {
    const response = await route.fetch();
    const encounter = await response.json() as { combatants: Array<Record<string, unknown>> };
    if (requestCount > 0) {
      const combatant = encounter.combatants.find((item) => item.id === drill.combatantId)!;
      const terminal = requestCount === 3;
      Object.assign(
        combatant,
        outcome === 'stable'
          ? { hpCurrent: 0, deathState: terminal ? 'stable' : 'dying', deathSaveSuccesses: requestCount, deathSaveFailures: 0 }
          : { hpCurrent: 0, deathState: terminal ? 'dead' : 'dying', deathSaveSuccesses: 0, deathSaveFailures: requestCount },
      );
    }
    await route.fulfill({ response, json: encounter });
  });
  return { requestCount: () => requestCount };
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
    { outcome: 'stable' as const, controls: ['workspace', 'row', 'workspace'] as const, expected: 'Stable' },
    { outcome: 'dead' as const, controls: ['row', 'workspace', 'row'] as const, expected: 'Dead' },
  ]) {
    test(`player reaches ${testCase.outcome} through the complete three-roll sequence without choosing a d20`, async ({ page }) => {
      const { baseURL, campaignId } = seed();
      const player = await request.newContext({ baseURL });
      const dm = await request.newContext({ baseURL });
      let drill: Drill | null = null;
      try {
        await player.post('/api/v1/auth/login', { data: CREDS.player });
        const playerUserId = String((await (await player.get('/api/v1/me')).json()).user.id);
        await dm.post('/api/v1/auth/login', { data: CREDS.dm });
        drill = await startDrill(dm, campaignId, playerUserId, testCase.outcome);
        const stub = await stubAuthoritativeResult(page, drill, testCase.outcome);

        await page.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
        await expect(page.getByText('Running', { exact: true })).toBeVisible();
        const row = page.getByTestId(`combatant-row-${drill.combatantId}`);
        await expect(row).toContainText(drill.name);

        for (const [index, control] of testCase.controls.entries()) {
          if (control === 'workspace') {
            await page.getByTestId('turn-roll-death-save').click();
          } else {
            await row.getByRole('button', { name: 'Roll a death save' }).click();
          }
          const kind = testCase.outcome === 'stable' ? 'success' : 'failure';
          const label = `${testCase.outcome === 'stable' ? 'Success' : 'Failure'} ${index + 1} of 3 (marked)`;
          await expect(row.getByTestId(`death-save-${kind}-pips`).getByRole('button', { name: label })).toBeVisible();
        }

        expect(stub.requestCount()).toBe(3);
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
