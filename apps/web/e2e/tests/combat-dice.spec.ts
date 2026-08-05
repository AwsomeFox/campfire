import { test, expect, request, type APIRequestContext, type Request } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';

/**
 * Encounter click-to-roll + one-tap apply-damage (the interactive character card).
 *
 * Uses its OWN freshly-created encounter (not the shared seed encounter the
 * combat-tracker spec asserts on) so adding a character/monster here can't perturb
 * that spec's exact-combatant assertions.
 *
 * Issue #1478 — this spec no longer ROLLS initiative. It used to call
 * /roll-initiative and then accept EITHER combat-log phrasing, because a d20 decided
 * who acted first. That made the test a fair coin, and the coin is precisely what hid
 * a real bug for as long as it lived: the client attached the DM-only `actorId` field
 * to the HP patch whenever the current-turn combatant differed from the target, and
 * the server 403s any non-DM patch carrying that field. A player applying damage to
 * their OWN character therefore failed outright whenever a monster held the turn —
 * about half of all runs, which got written off as flakiness.
 *
 * The player-owned turn is pinned explicitly so this spec exercises the allowed action.
 */

const OWN_TURN = { brixi: 20, dummy: 4 } as const;

interface Drill {
  encounterId: number;
  brixiCombatantId: number;
  characterId: number;
  otherCharacterId: number | null;
}

/**
 * Create the player-owned character, a monster, and a RUNNING encounter whose turn
 * order is pinned by explicit initiative values (never rolled).
 */
async function startDrill(
  dm: APIRequestContext,
  campaignId: number | string,
  playerUserId: string,
  initiative: { brixi: number; dummy: number },
  options: { otherCharacterOwnerUserId?: string } = {},
): Promise<Drill> {
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
  const characterId = character.id as number;
  let otherCharacterId: number | null = null;
  if (options.otherCharacterOwnerUserId) {
    const otherCharacter = await (
      await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
        data: {
          name: 'Rival Sheet',
          className: 'Rogue',
          level: 5,
          ownerUserId: options.otherCharacterOwnerUserId,
          ac: 15,
          hpCurrent: 32,
          hpMax: 32,
          stats: { DEX: 18 },
          actions: [{ name: 'Rival Rapier', kind: 'melee', toHit: '+7', damage: '1d8+4 piercing', notes: '' }],
        },
      })
    ).json();
    otherCharacterId = otherCharacter.id as number;
  }

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
  const enc = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Apply-bar drill', hidden: false } })
  ).json();
  const encounterId = enc.id as number;

  let brixiCombatantId: number | null =
    (enc.combatants as Array<{ id: number; characterId: number | null }>).find((c) => c.characterId === characterId)?.id ?? null;
  if (brixiCombatantId == null) {
    const addRes = await dm.post(`/api/v1/encounters/${encounterId}/combatants`, {
      data: { kind: 'character', characterId },
    });
    expect(addRes.ok(), `add Brixi combatant: ${await addRes.text()}`).toBeTruthy();
    brixiCombatantId = ((await addRes.json()) as { id: number }).id;
  }

  const dummyRes = await dm.post(`/api/v1/encounters/${encounterId}/combatants`, {
    data: { kind: 'monster', name: 'Straw Dummy', hpMax: 30 },
  });
  expect(dummyRes.ok(), `add Straw Dummy: ${await dummyRes.text()}`).toBeTruthy();
  const dummyCombatantId = ((await dummyRes.json()) as { id: number }).id;

  // Issue #1478: PIN the turn order. `initiative` is a DM-only field and /start orders by
  // it descending, so these writes fully determine who holds the turn — no d20, no coin
  // flip, no "whichever the roll produced" assertions downstream.
  //
  // Every combatant must be covered: creating an encounter auto-adds the whole active
  // party, so the roster also holds seeded characters this drill does not care about, and
  // /start rejects the encounter unless all of them have an initiative. They get 1, below
  // both pinned values, so they can never take the turn away from the intended holder.
  const roster = (await (await dm.get(`/api/v1/encounters/${encounterId}`)).json()) as {
    combatants: Array<{ id: number }>;
  };
  for (const c of roster.combatants) {
    const value =
      c.id === brixiCombatantId ? initiative.brixi : c.id === dummyCombatantId ? initiative.dummy : 1;
    const res = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${c.id}`, {
      data: { initiative: value },
    });
    expect(res.ok(), `set initiative ${value} on ${c.id}: ${await res.text()}`).toBeTruthy();
  }

  const startRes = await dm.post(`/api/v1/encounters/${encounterId}/start`);
  expect(startRes.ok(), `start encounter: ${await startRes.text()}`).toBeTruthy();

  // Guard the premise of the whole test: assert the intended combatant actually holds
  // the turn. If initiative ordering ever changes, this fails loudly here rather than
  // silently turning the two cases below back into one.
  const started = (await startRes.json()) as { currentCombatantId?: number | null };
  const expectedCurrent = initiative.brixi > initiative.dummy ? brixiCombatantId : dummyCombatantId;
  expect(started.currentCombatantId, 'the pinned initiative must decide the current turn').toBe(expectedCurrent);

  return { encounterId, brixiCombatantId, characterId, otherCharacterId };
}

async function teardownDrill(dm: APIRequestContext, drill: Drill | null): Promise<void> {
  // End before delete so a failed DELETE cannot leave a RUNNING fight that
  // blocks restoreSeedEncounter's /reopen (ENCOUNTER_ALREADY_RUNNING, #744).
  if (drill != null) {
    await dm.post(`/api/v1/encounters/${drill.encounterId}/end`).catch(() => undefined);
    await dm.delete(`/api/v1/encounters/${drill.encounterId}`).catch(() => undefined);
    await dm.delete(`/api/v1/characters/${drill.characterId}`).catch(() => undefined);
    if (drill.otherCharacterId != null) await dm.delete(`/api/v1/characters/${drill.otherCharacterId}`).catch(() => undefined);
  }
  // Issue #744: the seeded "Ambush" encounter was ended above so the drill could
  // start; restore it so the combat-tracker suite finds it RUNNING again.
  await restoreSeedEncounter();
}

test.describe('encounter dice — apply rolled damage', () => {
  test.use({ storageState: stateFor('player') });

  test('a player rolls damage from their card and one-taps it onto an editable target on their turn', async ({ page }) => {
      const { baseURL, campaignId } = seed();

      const playerCtx = await request.newContext({ baseURL });
      const dm = await request.newContext({ baseURL });
      let drill: Drill | null = null;
      try {
        await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
        const me = await (await playerCtx.get('/api/v1/me')).json();
        const playerUserId = String(me.user.id);

        await dm.post('/api/v1/auth/login', { data: CREDS.dm });
        drill = await startDrill(dm, campaignId, playerUserId, OWN_TURN);

        await page.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
        await expect(page.getByText('Running', { exact: true })).toBeVisible();
        // Owned card auto-expands; scope the damage control to Brixi's sheet.
        const brixiCard = page.getByRole('region', { name: /Brixi Applybar character sheet/i });
        await expect(brixiCard).toBeVisible();

        // Roll the Greatsword damage from the owned (interactive) card.
        await brixiCard.getByRole('button', { name: '2d6+4 slashing' }).click();
        const rollToast = page.getByTestId('roll-result-toast');
        await expect(rollToast).toBeVisible();
        await expect(rollToast.getByTestId('roll-result-apply')).toBeVisible();
        await rollToast.getByTestId('roll-result-apply').click();

        const applyBar = page.getByTestId('apply-damage-bar');
        await expect(applyBar).toBeVisible();

        // A player may only apply to combatants they control — their own character, not the monster.
        await expect(applyBar.getByRole('button', { name: 'Straw Dummy' })).toHaveCount(0);
        const brixiTarget = applyBar.getByTestId(`apply-damage-target-${drill.brixiCombatantId}`);
        await expect(brixiTarget).toBeVisible();

        // Apply → HP drops, the combat log records the damage, and the bar dismisses.
        await brixiTarget.click();
        await expect(applyBar).toHaveCount(0);

        // The write must SUCCEED. Assert no error banner as well as the log entry, so a
        // regression shows up as a failure with a readable cause instead of a timeout.
        // Target the error banner specifically. `getByRole('alert')` would also match the
        // app's other live regions — the empty announcement region on every page, and the
        // "Your turn — round 1, …" notice that appears precisely in the own-turn case.
        await expect(page.getByTestId('error-note')).toHaveCount(0);

        // Read the whole log textContent so chained/expandable rows still match.
        const combatLog = page.getByRole('log', { name: 'Combat log' });
        await expect(combatLog).toBeVisible();
        await expect
          .poll(async () => /Brixi Applybar took \d+ damage/i.test((await combatLog.textContent()) ?? ''), {
            message: 'combat log should contain Brixi damage',
          })
          .toBe(true);
      } finally {
        await teardownDrill(dm, drill);
        // Dispose the API contexts so they don't leak across the worker.
        await playerCtx.dispose();
        await dm.dispose();
      }
  });

  test('the dice tray labels presets, clears that label after an edit, and posts a mixed pool once', async ({ page }) => {
    const { baseURL, campaignId } = seed();
    const playerCtx = await request.newContext({ baseURL });
    const dm = await request.newContext({ baseURL });
    let drill: Drill | null = null;
    try {
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
      const me = await (await playerCtx.get('/api/v1/me')).json();
      await dm.post('/api/v1/auth/login', { data: CREDS.dm });
      drill = await startDrill(dm, campaignId, String(me.user.id), OWN_TURN);

      await page.addInitScript((key) => {
        localStorage.setItem(key, JSON.stringify([
          { label: 'Sneak attack', pool: { 8: 1 }, modifier: 2, advMode: 'flat', persisted: true },
          { label: 'Mega pool', pool: { 4: 20, 6: 20, 8: 20, 10: 20, 12: 20, 20: 20, 100: 20 }, modifier: 99, advMode: 'flat', persisted: true },
        ]));
      }, `campfire.dicePresets.${campaignId}`);
      await page.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();

      const rollResponse = () => page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().endsWith(`/campaigns/${campaignId}/roll`),
      );
      const rollButton = (name: string) => page.getByRole('button', { name, exact: true });

      await page.getByRole('button', { name: 'Initiative', exact: true }).click();
      const initiativeResponse = rollResponse();
      await rollButton('Roll 1d20').click();
      await expect(initiativeResponse.then((response) => response.request().postDataJSON())).resolves.toEqual({ expr: '1d20', label: 'Initiative' });
      await expect(page.getByTestId('shared-dice-log').getByText('Initiative: 1d20', { exact: false })).toBeVisible();

      await page.getByRole('button', { name: 'Sneak attack', exact: true }).click();
      await expect(rollButton('Roll 1d8 +2')).toBeEnabled();
      const savedResponse = rollResponse();
      await rollButton('Roll 1d8 +2').click();
      await expect(savedResponse.then((response) => response.request().postDataJSON())).resolves.toEqual({ expr: '1d8+2', label: 'Sneak attack' });
      await expect(page.getByTestId('shared-dice-log').getByText('Sneak attack: 1d8+2', { exact: false })).toBeVisible();

      await page.getByRole('button', { name: 'Mega pool', exact: true }).click();
      const fallbackPayloads: unknown[] = [];
      const recordFallbackPayload = (request: Request) => {
        if (request.method() === 'POST' && request.url().endsWith(`/campaigns/${campaignId}/roll`)) {
          fallbackPayloads.push(request.postDataJSON());
        }
      };
      page.on('request', recordFallbackPayload);
      await rollButton('Roll 20d4 + 20d6 + 20d8 + 20d10 + 20d12 + 20d20 + 20d100 +99').click();
      await expect.poll(() => fallbackPayloads).toEqual([
        { expr: '20d4+99', label: 'Mega pool' },
        { expr: '20d6' },
        { expr: '20d8' },
        { expr: '20d10' },
        { expr: '20d12' },
        { expr: '20d20' },
        { expr: '20d100' },
      ]);
      page.off('request', recordFallbackPayload);

      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByRole('button', { name: 'Initiative', exact: true }).click();
      await page.getByRole('button', { name: 'Increase modifier', exact: true }).click();
      await expect(rollButton('Roll 1d20 +1')).toBeEnabled();
      const editedResponse = rollResponse();
      await rollButton('Roll 1d20 +1').click();
      await expect(editedResponse.then((response) => response.request().postDataJSON())).resolves.toEqual({ expr: '1d20+1' });

      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByRole('button', { name: 'Add a d6', exact: true }).click();
      await page.getByRole('button', { name: 'Add a d6', exact: true }).click();
      await page.getByRole('button', { name: 'Add a d8', exact: true }).click();
      for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Increase modifier', exact: true }).click();

      let mixedRequests = 0;
      const countMixedRequest = (request: Request) => {
        if (request.method() === 'POST' && request.url().endsWith(`/campaigns/${campaignId}/roll`)) mixedRequests += 1;
      };
      page.on('request', countMixedRequest);
      const mixedResponse = rollResponse();
      await rollButton('Roll 2d6 + 1d8 +3').click();
      const mixed = await mixedResponse;
      page.off('request', countMixedRequest);

      expect(mixedRequests).toBe(1);
      expect(mixed.request().postDataJSON()).toEqual({ expr: '2d6+1d8+3' });
      const result = await mixed.json() as { total: number; terms?: Array<{ value: number }> };
      expect(result.terms).toHaveLength(3);
      expect(result.terms?.reduce((total, term) => total + term.value, 0)).toBe(result.total);
      await expect(page.getByTestId('shared-dice-log').getByText('2d6+1d8+3', { exact: false })).toBeVisible();
      const overlay = page.getByTestId('dice-roll-overlay');
      await expect(overlay).toBeVisible();
      await expect(overlay.locator('[data-sides="6"]')).toHaveCount(2);
      await expect(overlay.locator('[data-sides="8"]')).toHaveCount(1);
    } finally {
      await teardownDrill(dm, drill);
      await playerCtx.dispose();
      await dm.dispose();
    }
  });

  test('players see only their own sheet and cannot roll before their turn, while the DM can', async ({ page, browser }) => {
    const { baseURL, campaignId } = seed();
    const playerCtx = await request.newContext({ baseURL });
    const dm = await request.newContext({ baseURL });
    const dmBrowserContext = await browser.newContext({ storageState: stateFor('dm') });
    const dmPage = await dmBrowserContext.newPage();
    let drill: Drill | null = null;
    try {
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
      const playerMe = await (await playerCtx.get('/api/v1/me')).json();
      await dm.post('/api/v1/auth/login', { data: CREDS.dm });
      const dmMe = await (await dm.get('/api/v1/me')).json();
      drill = await startDrill(
        dm,
        campaignId,
        String(playerMe.user.id),
        { brixi: 4, dummy: 20 },
        { otherCharacterOwnerUserId: String(dmMe.user.id) },
      );

      await page.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: "Expand Rival Sheet's character sheet" })).toHaveCount(0);

      await page.getByRole('button', { name: "Expand Brixi Applybar's character sheet" }).click();
      const playerBrixiCard = page.getByRole('region', { name: /Brixi Applybar character sheet/i });
      await expect(playerBrixiCard).toBeVisible();
      await expect(playerBrixiCard.getByTestId('check-roll-ability:STR')).toHaveCount(0);
      await expect(playerBrixiCard.getByTestId('attack-roll-control')).toHaveCount(0);

      await dmPage.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
      await expect(dmPage.getByRole('button', { name: "Expand Brixi Applybar's character sheet" })).toBeVisible();
      await expect(dmPage.getByRole('button', { name: "Expand Rival Sheet's character sheet" })).toBeVisible();
      await dmPage.getByRole('button', { name: "Expand Brixi Applybar's character sheet" }).click();
      const dmBrixiCard = dmPage.getByRole('region', { name: /Brixi Applybar character sheet/i });
      await expect(dmBrixiCard.getByTestId('attack-roll-control')).toBeVisible();
      await dmBrixiCard.getByTestId('attack-roll-control').click();
      await expect(dmPage.getByTestId('roll-result-toast')).toBeVisible();

      await page.getByRole('button', { name: "Collapse Brixi Applybar's character sheet" }).click();
      await expect(playerBrixiCard).toHaveCount(0);

      const advanceRes = await dm.post(`/api/v1/encounters/${drill.encounterId}/next-turn`);
      expect(advanceRes.ok(), `advance to Brixi: ${await advanceRes.text()}`).toBeTruthy();
      await expect(page.getByTestId(`combatant-row-${drill.brixiCombatantId}`)).toHaveAttribute('data-current-turn', 'true');
      await expect(playerBrixiCard.getByTestId('check-roll-ability:STR')).toBeVisible();
      await expect(playerBrixiCard.getByTestId('attack-roll-control')).toBeVisible();
    } finally {
      await teardownDrill(dm, drill);
      await dmBrowserContext.close();
      await playerCtx.dispose();
      await dm.dispose();
    }
  });

  /**
   * Issue #1478: a failed apply must be VISIBLE. The apply bar dismisses on click
   * regardless of the response, so before this test nothing distinguished a rejected
   * apply from a successful one except a combat-log line that never showed up — which
   * is exactly how the 403 hid behind "flaky test" for as long as it did.
   *
   * The rejection is injected at the network layer rather than provoked for real,
   * because the client no longer sends the field that used to trigger it. Using the
   * real COMBAT_LOG_ACTOR_DM_ONLY code also proves the server's new error code is
   * wired through translateApiError to human-readable copy.
   */
  test('a rejected apply-damage surfaces a visible error instead of looking like success', async ({ page }) => {
    const { baseURL, campaignId } = seed();

    const playerCtx = await request.newContext({ baseURL });
    const dm = await request.newContext({ baseURL });
    let drill: Drill | null = null;
    try {
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
      const me = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = String(me.user.id);

      await dm.post('/api/v1/auth/login', { data: CREDS.dm });
      drill = await startDrill(dm, campaignId, playerUserId, OWN_TURN);

      await page.goto(`/c/${campaignId}/encounters/${drill.encounterId}`);
      await expect(page.getByText('Running', { exact: true })).toBeVisible();

      // Reject only the HP patch for Brixi's combatant; every other request is untouched.
      await page.route(`**/api/v1/encounters/${drill.encounterId}/combatants/${drill.brixiCombatantId}`, async (route) => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            code: 'COMBAT_LOG_ACTOR_DM_ONLY',
            message: 'Only a DM may set the combat-log actor.',
          }),
        });
      });

      const brixiCard = page.getByRole('region', { name: /Brixi Applybar character sheet/i });
      await expect(brixiCard).toBeVisible();
      await brixiCard.getByRole('button', { name: '2d6+4 slashing' }).click();
      const rollToast = page.getByTestId('roll-result-toast');
      await expect(rollToast.getByTestId('roll-result-apply')).toBeVisible();
      await rollToast.getByTestId('roll-result-apply').click();

      const applyBar = page.getByTestId('apply-damage-bar');
      await expect(applyBar).toBeVisible();
      await applyBar.getByTestId(`apply-damage-target-${drill.brixiCombatantId}`).click();

      // The bar dismisses either way — that is the trap. The error banner is what makes
      // the failure legible, and it must carry the translated cause, not a bare "403".
      await expect(applyBar).toHaveCount(0);
      const errorNote = page.getByTestId('error-note');
      await expect(errorNote).toBeVisible();
      await expect(errorNote).toContainText(/Only the DM can set who dealt that damage/i);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
      await teardownDrill(dm, drill);
      await playerCtx.dispose();
      await dm.dispose();
    }
  });
});
