import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';

/**
 * The in-combat Spellbook, wired to real spells and slots (issue #1900).
 *
 * Uses its OWN freshly-created encounter (not the shared seed encounter the
 * combat-tracker suite asserts on), mirroring combat-dice.spec.ts's drill pattern —
 * so this spec can pin the player's own turn without perturbing other specs.
 */

const OWN_TURN = { caster: 20, dummy: 4 } as const;

interface Drill {
  encounterId: number;
  characterId: number;
}

async function startDrill(dm: APIRequestContext, campaignId: number | string, playerUserId: string): Promise<Drill> {
  // A player-owned caster with one real leveled spell (spec.uses.spellLevel = 1) and a
  // real persisted spellSlots pool — no fabricated data anywhere in this fixture.
  const character = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: {
        name: 'Wisp Cantor',
        species: 'Human',
        className: 'Cleric',
        level: 3,
        ownerUserId: playerUserId,
        ac: 14,
        hpCurrent: 20,
        hpMax: 20,
        stats: { STR: 10, DEX: 12, CON: 12, INT: 10, WIS: 16, CHA: 10 },
        spellSlots: { '1': { max: 2, used: 0 } },
        actions: [
          {
            name: 'Bless',
            kind: 'spell',
            notes: '',
            spec: { mode: 'none', uses: { spellLevel: 1, concentration: false }, cost: { slot: 'action' } },
          },
        ],
      },
    })
  ).json();
  expect(character.id).toBeTruthy();
  const characterId = character.id as number;

  // Issue #744: a campaign can have at most one live fight — end the seeded one first
  // (restored in teardownDrill via restoreSeedEncounter).
  const live = await (await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
  for (const e of live as { id: number }[]) {
    await dm.post(`/api/v1/encounters/${e.id}/end`);
  }
  const enc = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Spellbook drill', hidden: false } })
  ).json();
  const encounterId = enc.id as number;

  let casterCombatantId: number | null =
    (enc.combatants as Array<{ id: number; characterId: number | null }>).find((c) => c.characterId === characterId)?.id ?? null;
  if (casterCombatantId == null) {
    const addRes = await dm.post(`/api/v1/encounters/${encounterId}/combatants`, { data: { kind: 'character', characterId } });
    expect(addRes.ok(), `add caster combatant: ${await addRes.text()}`).toBeTruthy();
    casterCombatantId = ((await addRes.json()) as { id: number }).id;
  }

  const dummyRes = await dm.post(`/api/v1/encounters/${encounterId}/combatants`, {
    data: { kind: 'monster', name: 'Straw Dummy', hpMax: 30 },
  });
  expect(dummyRes.ok(), `add Straw Dummy: ${await dummyRes.text()}`).toBeTruthy();
  const dummyCombatantId = ((await dummyRes.json()) as { id: number }).id;

  // Pin the turn order (no d20) — every combatant on the roster (the whole active party
  // gets auto-added to a fresh encounter) must get an initiative before /start.
  const roster = (await (await dm.get(`/api/v1/encounters/${encounterId}`)).json()) as { combatants: Array<{ id: number }> };
  for (const c of roster.combatants) {
    const value = c.id === casterCombatantId ? OWN_TURN.caster : c.id === dummyCombatantId ? OWN_TURN.dummy : 1;
    const res = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${c.id}`, { data: { initiative: value } });
    expect(res.ok(), `set initiative ${value} on ${c.id}: ${await res.text()}`).toBeTruthy();
  }

  const startRes = await dm.post(`/api/v1/encounters/${encounterId}/start`);
  expect(startRes.ok(), `start encounter: ${await startRes.text()}`).toBeTruthy();
  const started = (await startRes.json()) as { currentCombatantId?: number | null };
  expect(started.currentCombatantId, 'the pinned initiative must decide the current turn').toBe(casterCombatantId);

  return { encounterId, characterId };
}

async function teardownDrill(dm: APIRequestContext, drill: Drill | null): Promise<void> {
  if (drill != null) {
    await dm.post(`/api/v1/encounters/${drill.encounterId}/end`).catch(() => undefined);
    await dm.delete(`/api/v1/encounters/${drill.encounterId}`).catch(() => undefined);
    await dm.delete(`/api/v1/characters/${drill.characterId}`).catch(() => undefined);
  }
  await restoreSeedEncounter();
}

test.describe('In-combat Spellbook — real slots, single /turn fetch, error revert (issue #1900)', () => {
  test.use({ storageState: stateFor('player') });

  test('slot pips are real, persist across reload, revert on a forced error, and /turn fetches once', async ({ page }: { page: Page }) => {
    const { baseURL, campaignId } = seed();

    const playerCtx = await request.newContext({ baseURL });
    const dm = await request.newContext({ baseURL });
    let drill: Drill | null = null;
    try {
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
      const me = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = String(me.user.id);

      await dm.post('/api/v1/auth/login', { data: CREDS.dm });
      drill = await startDrill(dm, campaignId, playerUserId);

      const turnRequests: string[] = [];
      page.on('request', (req) => {
        if (req.method() === 'GET' && req.url().includes(`/api/v1/encounters/${drill!.encounterId}/turn`)) {
          turnRequests.push(req.url());
        }
      });

      await page.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();

      const toggle = page.getByTestId('toggle-spellbook-btn');
      await expect(toggle).toBeVisible();
      await toggle.click();

      const panel = page.getByTestId('spellbook-panel');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('slot-pips-level-1')).toBeVisible();

      // Issue #1900: exactly one GET .../turn fired for the initial mount — the duplicate
      // child query (TurnWorkspace's own useQuery under a divergent cache key) is gone.
      expect(turnRequests.length).toBe(1);

      // Two available slot pips (max 2, used 0) — real persisted data, no fabricated
      // Evocation/60ft/1A defaults. Pips render purely off the remaining COUNT (the
      // first `remaining` pips read available, the rest used) — not per-pip identity —
      // so spending one flips pip 2 to used regardless of which pip triggered the spend.
      const pip1Available = page.getByRole('button', { name: 'Level 1 slot 1 available' });
      const pip2Available = page.getByRole('button', { name: 'Level 1 slot 2 available' });
      await expect(pip1Available).toBeVisible();
      await expect(pip2Available).toBeVisible();

      // Spend one slot — picking a level-1 slot's pip.
      await pip1Available.click();
      await expect(page.getByRole('button', { name: 'Level 1 slot 2 used' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Level 1 slot 1 available' })).toBeVisible();

      // Acceptance criterion: the spend persists across reload (server-side, not just
      // client cache) — reopen the panel after a fresh navigation.
      await page.reload();
      await expect(page.getByText('Running', { exact: true })).toBeVisible();
      await page.getByTestId('toggle-spellbook-btn').click();
      await expect(page.getByRole('button', { name: 'Level 1 slot 2 used' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Level 1 slot 1 available' })).toBeVisible();

      // Force the NEXT slot patch to fail — the pip must revert and a toast must appear,
      // rather than the UI silently keeping an optimistic spend the server never committed.
      await page.route('**/api/v1/characters/**/spell-slots', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) });
      });

      await page.getByRole('button', { name: 'Level 1 slot 1 available' }).click();
      // Reverts to exactly the pre-click state — the forced 500 must not leave a phantom spend.
      await expect(page.getByRole('button', { name: 'Level 1 slot 1 available' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Level 1 slot 2 used' })).toBeVisible();
      await expect(page.getByTestId('error-note')).toBeVisible();
    } finally {
      await teardownDrill(dm, drill);
      await playerCtx.dispose();
      await dm.dispose();
    }
  });
});
